// Generated, platform-independent runtime for authored AIR file interactions.
// Native panels return owned UTF-8 paths; only this AS3-thread pump touches GC.
export const FILE_DIALOG_RUNTIME = String.raw`
#ifdef ASC_USE_FILE_DIALOG
extern int sk_file_dialog_begin(uint64_t, int, const char*, const char*, const char*, int, const char* const*, const char* const*);
extern void sk_file_dialog_cancel(uint64_t);
extern int sk_file_dialog_poll(uint64_t*, int*, int*);
extern const char* sk_file_dialog_path(int);
extern const char* sk_file_dialog_error(void);
extern void sk_file_dialog_release(void);
#else
static int sk_file_dialog_begin(uint64_t s, int m, const char* t, const char* p, const char* n, int c, const char* const* d, const char* const* e) { (void)s; (void)m; (void)t; (void)p; (void)n; (void)c; (void)d; (void)e; return 0; }
static void sk_file_dialog_cancel(uint64_t s) { (void)s; }
static int sk_file_dialog_poll(uint64_t* s, int* r, int* n) { (void)s; (void)r; (void)n; return 0; }
static const char* sk_file_dialog_path(int i) { (void)i; return NULL; }
static const char* sk_file_dialog_error(void) { return "Native file dialogs are unavailable in this build"; }
static void sk_file_dialog_release(void) {}
#endif

typedef struct as_dialog_request {
    struct as_dialog_request* next;
    uint64_t serial;
    void* obj;
    ByteArray* data;
    int mode;  // File: 1=open,2=multi,3=directory,4=save-path; 5=FR,6=FR-list,7=FR-save
    int cancelled;
} as_dialog_request;
static as_dialog_request* as_dialog_requests = NULL;
static as_dialog_request* as_dialog_active = NULL;
static uint64_t as_dialog_serial = 0;
static void as_file_dialog_mark_roots(void) {
    for (as_dialog_request* r = as_dialog_requests; r; r = r->next) {
        gc_mark_ptr(r->obj); gc_mark_ptr(r->data);
    }
}
static void as_dialog_remove(as_dialog_request* r) {
    as_dialog_request** link = &as_dialog_requests;
    while (*link && *link != r) link = &(*link)->next;
    if (*link) *link = r->next;
    if (as_dialog_active == r) as_dialog_active = NULL;
    free(r);
}
static void as_dialog_io_error(void* obj, const char* text) {
    IOErrorEvent* ev = IOErrorEvent_new((char*)"ioError", false, false, (char*)text);
    ev->errorID = 2038;
    EventDispatcher_dispatchEvent(obj, (Event*)ev);
}
static int as_dialog_busy(void* obj) {
    if (as_dialog_active && as_dialog_active->obj == obj) return 1;
    return as_async_kind_pending(obj, AS_JOB_READ_BYTES) || as_async_kind_pending(obj, AS_JOB_FILE_WRITE);
}
static void as_dialog_cancel(void* obj) {
    for (as_dialog_request* r = as_dialog_requests; r; r = r->next) {
        if (r->obj != obj) continue;
        // AIR cancel() does not dismiss a browse panel (51.4.1 probe).
        // During SELECT it can still cancel a deferred save before publication.
        if (r != as_dialog_active) r->cancelled = 1;
    }
    as_async_cancel(obj);
}
static void as_dialog_reference_path(FileReference* o, const char* path) {
    File* f = File_new((char*)path);
    o->_selectedPath = as_str_dup(path);
    o->_data = NULL;
    o->_name = File_get_name(f); o->_ext = File_get_extension(f);
    o->_type = File_get_type(f); o->_creator = NULL;
    o->_size = 0; o->_cdate = NULL; o->_mdate = NULL;
    if (File_get_exists(f)) {
        o->_size = File_get_size(f);
        o->_cdate = File_get_creationDate(f); o->_mdate = File_get_modificationDate(f);
    }
    gc_write_barrier(o->_selectedPath); gc_write_barrier(o->_name);
    gc_write_barrier(o->_ext); gc_write_barrier(o->_type);
    gc_write_barrier(o->_cdate); gc_write_barrier(o->_mdate);
}
static void FileReference__loadFinish(void* job) {
    FileReference* o = (FileReference*)as_job_obj(job);
    if (as_job_failed(job)) { as_dialog_io_error(o, "Error #2038: File I/O Error."); return; }
    unsigned n = as_job_len(job);
    if (n > INT_MAX) { as_dialog_io_error(o, "File exceeds ByteArray size limit"); return; }
    EventDispatcher_dispatchEvent(o, Event_new((char*)"open", false, false));
    if (((as_job*)job)->dead) return;
    EventDispatcher_dispatchEvent(o, (Event*)ProgressEvent_new((char*)"progress", false, false, n, n));
    if (((as_job*)job)->dead) return;
    ByteArray* bytes = ByteArray_new();
    as_ba_grow(bytes, (int)n);
    if (n) memcpy(bytes->data, as_job_bytes(job), n);
    bytes->length = (int)n; bytes->position = 0;
    o->_data = bytes; gc_write_barrier(bytes);
    EventDispatcher_dispatchEvent(o, Event_new((char*)"complete", false, false));
}
static void FileReference__saveFinish(void* job) {
    FileReference* o = (FileReference*)as_job_obj(job);
    if (as_job_failed(job)) { as_dialog_io_error(o, "Error #2038: File I/O Error."); return; }
    EventDispatcher_dispatchEvent(o, Event_new((char*)"open", false, false));
    if (((as_job*)job)->dead) return;
    unsigned n = as_job_len(job);
    EventDispatcher_dispatchEvent(o, (Event*)ProgressEvent_new((char*)"progress", false, false, n, n));
    if (((as_job*)job)->dead) return;
    // Refresh metadata after the file was created, retaining the selected path.
    as_dialog_reference_path(o, o->_selectedPath);
    EventDispatcher_dispatchEvent(o, Event_new((char*)"complete", false, false));
}
static bool as_dialog_begin(void* obj, int mode, char* title, as_array* filters, char* suggested, ByteArray* data) {
    if (as_dialog_active || as_dialog_busy(obj)) {
        as_throw(Error_new((char*)"Error #2041: A browse operation is already in progress.", 2041)); return false;
    }
    int n = filters ? filters->length : 0;
    // Validate before allocating native scratch, so a typed error cannot leak it.
    for (int i = 0; i < n; i++) {
        void* f = as_v_obj_val(filters->data[i]);
        if (!as_is(f, &FileFilter_vt)) as_throw(ArgumentError_new((char*)"Error #2097: typeFilter must contain FileFilter values.", 2097));
    }
    const char** descriptions = n ? (const char**)calloc((size_t)n, sizeof(char*)) : NULL;
    const char** extensions = n ? (const char**)calloc((size_t)n, sizeof(char*)) : NULL;
    if (n && (!descriptions || !extensions)) { free(descriptions); free(extensions); as_file_throw(2038); return false; }
    for (int i = 0; i < n; i++) {
        FileFilter* f = (FileFilter*)as_v_obj_val(filters->data[i]);
        descriptions[i] = f->description; extensions[i] = f->extension;
    }
    as_dialog_request* r = (as_dialog_request*)calloc(1, sizeof(*r));
    if (!r) { free(descriptions); free(extensions); as_file_throw(2038); return false; }
    r->serial = ++as_dialog_serial; r->obj = obj; r->mode = mode; r->data = data;
    gc_write_barrier(obj); gc_write_barrier(data);
    r->next = as_dialog_requests; as_dialog_requests = r; as_dialog_active = r;
    const char* initial = as_is(obj, &File_vt) ? ((File*)obj)->_nativePath : NULL;
    int nativeMode = mode == 5 ? 1 : mode == 6 ? 2 : mode == 7 ? 4 : mode;
    int started = sk_file_dialog_begin(r->serial, nativeMode, title, initial, suggested, n, descriptions, extensions);
    free(descriptions); free(extensions);
    if (!started) {
        as_dialog_remove(r);
        as_shell_unsupported((char*)"native file dialog (no platform backend or no UI thread)");
        return false;
    }
    return true;
}
static void as_dialog_deliver(as_dialog_request* r, int status, as_array* paths, char* error) {
    if (r->cancelled) return;
    if (status < 0) { as_dialog_io_error(r->obj, error); return; }
    if (status == 0) { EventDispatcher_dispatchEvent(r->obj, Event_new((char*)"cancel", false, false)); return; }
    if (!paths || paths->length == 0) { as_dialog_io_error(r->obj, "File panel returned no paths"); return; }
    char* path = as_v_str_val(paths->data[0]);
    if (r->mode == 2 || r->mode == 6) {
        as_array* files = as_array_new();
        for (int i = 0; i < paths->length; i++) {
            char* p = as_v_str_val(paths->data[i]);
            if (r->mode == 2) as_array_push(files, as_v_obj(File_new(p)));
            else { FileReference* f = FileReference_new(); as_dialog_reference_path(f, p); as_array_push(files, as_v_obj(f)); }
        }
        if (r->mode == 6) {
            ((FileReferenceList*)r->obj)->_fileList = files; gc_write_barrier(files);
            EventDispatcher_dispatchEvent(r->obj, Event_new((char*)"select", false, false));
        } else EventDispatcher_dispatchEvent(r->obj, (Event*)FileListEvent_new((char*)"selectMultiple", false, false, files));
        return;
    }
    if (r->mode <= 4) {
        File_set_nativePath(r->obj, path);
        EventDispatcher_dispatchEvent(r->obj, Event_new((char*)"select", false, false));
        return;
    }
    FileReference* o = (FileReference*)r->obj;
    as_dialog_reference_path(o, path);
    EventDispatcher_dispatchEvent(o, Event_new((char*)"select", false, false));
    if (r->mode == 7 && !r->cancelled) {
        ByteArray* b = r->data;
        if (!as_async_submit_file_write(o, FileReference__saveFinish, path, b->data, (size_t)b->length))
            as_dialog_io_error(o, "Could not start file save");
    }
}
static int as_file_dialog_tick(void) {
    uint64_t serial = 0; int status = 0, n = 0;
    if (!sk_file_dialog_poll(&serial, &status, &n)) return 0;
    as_dialog_request* r = as_dialog_active;
    if (!r || r->serial != serial) { sk_file_dialog_release(); return 1; }
    // Completion may start a fresh request. Keep this one rooted in the list,
    // but release the native panel BEFORE calling any AS3 listener.
    as_dialog_active = NULL;
    volatile int released = 0;
    jmp_buf env; int thrown = AS_SETJMP(env);
    if (!thrown) {
        as_jmp_push(&env);
        as_array* paths = as_array_new();
        for (int i = 0; i < n; i++) as_array_push(paths, as_v_str(as_str_dup(sk_file_dialog_path(i))));
        char* error = as_str_dup(sk_file_dialog_error());
        sk_file_dialog_release(); released = 1;
        as_dialog_deliver(r, status, paths, error);
    }
    as_jmp_pop();
    if (!released) sk_file_dialog_release();
    as_dialog_remove(r);
    if (thrown) { as_async_in_tick = 0; if (as_exception_boxed) as_throw_val(as_exception_v); else as_throw(as_exception); }
    return 1;
}

bool FileReference_browse(void* self, as_array* filters) { return as_dialog_begin(self, 5, NULL, filters, NULL, NULL); }
void FileReference_cancel(void* self) { as_dialog_cancel(self); }
bool FileReferenceList_browse(void* self, as_array* filters) { return as_dialog_begin(self, 6, NULL, filters, NULL, NULL); }
void FileReference_load(void* self) {
    FileReference* o = (FileReference*)self;
    const char* path = as_is(self, &File_vt) ? ((File*)self)->_nativePath : o->_selectedPath;
    if (!path || as_dialog_busy(self)) { as_file_throw(2037); return; }
    o->_data = NULL;
    if (!as_async_submit(AS_JOB_READ_BYTES, self, FileReference__loadFinish, path, NULL, 1)) as_file_throw(2038);
}
void FileReference_save(void* self, as_value data, char* name) {
    if (as_v_is_nullish(data)) { as_throw(TypeError_new((char*)"Error #2007: Parameter data must be non-null.", 2007)); return; }
    // Snapshot at invocation, before user interaction or caller mutation.
    ByteArray* bytes = ByteArray_new();
    void* object = data.tag == 4 ? as_v_obj_val(data) : NULL;
    if (as_is(object, &ByteArray_vt)) {
        ByteArray* from = (ByteArray*)object; as_ba_grow(bytes, from->length);
        if (from->length) memcpy(bytes->data, from->data, (size_t)from->length);
        bytes->length = from->length;
    } else {
        as_value v = data;
        char* text = as_is(object, &as_xml_vt) ? as_xml_to_string((as_xml_node*)object) :
            as_is(object, &as_xml_list_vt) ? as_xml_list_to_xml_string((as_xml_list*)object) : as_v_str_val(v);
        int n = (int)strlen(text); as_ba_grow(bytes, n);
        if (n) memcpy(bytes->data, text, (size_t)n); bytes->length = n;
    }
    as_dialog_begin(self, 7, NULL, NULL, name, bytes);
}
void File_browseForDirectory(void* self, char* title) { as_dialog_begin(self, 3, title, NULL, NULL, NULL); }
void File_browseForOpen(void* self, char* title, as_array* filters) { as_dialog_begin(self, 1, title, filters, NULL, NULL); }
void File_browseForOpenMultiple(void* self, char* title, as_array* filters) { as_dialog_begin(self, 2, title, filters, NULL, NULL); }
void File_browseForSave(void* self, char* title) { as_dialog_begin(self, 4, title, NULL, NULL, NULL); }
`;
