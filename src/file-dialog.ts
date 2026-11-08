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
    // An upload counts: AIR's FileReference runs ONE operation at a time, so
    // browsing or loading while an upload is in flight is the same #2037 an
    // upload submitted during a load gets.
    return as_async_kind_pending(obj, AS_JOB_READ_BYTES) || as_async_kind_pending(obj, AS_JOB_FILE_WRITE) ||
           as_async_kind_pending(obj, AS_JOB_FILE_UPLOAD);
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

bool FileReference_browse(void* self, as_array* filters) { return as_dialog_begin(self, 5, NULL, filters, NULL, NULL); }void FileReference_cancel(void* self) { as_dialog_cancel(self); }
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

// ---- FileReference.upload / File.upload: the measured multipart envelope -----
//
// AIR's upload is not a POST of the file: it is multipart/form-data with a fixed
// envelope. Everything below was captured byte for byte from adl 51.4.1
// (temp/uploadprobe/, requests req-1..req-5, plus the event log):
//
//   --<boundary>\r\n
//   Content-Disposition: form-data; name="Filename"\r\n\r\n<file NAME>\r\n
//   --<boundary>\r\n                                            (once per variable)
//   Content-Disposition: form-data; name="<key>"\r\n\r\n<value>\r\n
//   --<boundary>\r\n
//   Content-Disposition: form-data; name="<field>"; filename="<file NAME>"\r\n
//   Content-Type: application/octet-stream\r\n\r\n<file bytes>
//   \r\n--<boundary>\r\n
//   Content-Disposition: form-data; name="Upload"\r\n\r\nSubmit Query\r\n
//   --<boundary>--
//
// Details that are easy to get wrong, each one measured:
//
//  * the leading "Filename" part comes FIRST and carries the bare file name (no
//    directory) -- AIR's servers use it as the display name;
//  * variable keys AND values go out RAW. A value "a%20b" arrives as a%20b, "a b"
//    as a b, "a&b=c" unchanged and CJK as raw UTF-8: the multipart side does NOT
//    apply the percent-encoding URLVariables.toString() uses;
//  * variable ORDER follows AIR's property hash (measured: insertion order is not
//    the wire order). Our dynamic object is insertion-ordered, so the order differs
//    while the set does not -- the same documented divergence as
//    URLVariables.toString (docs/zh-cn/flash-net.md §3.1);
//  * the file part's Content-Type is ALWAYS application/octet-stream (a .txt and a
//    .pptx are indistinguishable on the wire) and the name inside filename="..."
//    is raw UTF-8, never RFC 2231/5987 encoded;
//  * the closing part is always present and is literally "Upload"/"Submit Query";
//  * no CRLF follows the final "--<boundary>--";
//  * the boundary is "----------" + 30 alphanumerics (40 characters, opaque to
//    servers, but the shape a WAF or a hand-rolled parser has been tuned to);
//  * uploadUnencoded() sends the file bytes as the WHOLE body, with no Content-Type
//    header at all and no variables part;
//  * a non-2xx response is NOT a transport failure: AIR still reports
//    httpResponseStatus, httpStatus, the body as uploadCompleteData, and only then
//    ioError #2038;
//  * a successful upload reports progress 1000/1000 for a 1000-byte file even
//    though the envelope is 1639 bytes: bytesTotal is the FILE length;
//  * testUpload=true is observably a no-op here (identical request, identical
//    events, measured).
//
// The envelope is built here on the AS3 thread (that is where the AS3 strings and
// the file name live) and handed to the job as two malloc'd halves. The FILE BYTES
// are never read here: the worker streams them from disk between the halves, so a
// 30 MB deck costs one open FILE* instead of a second copy.

typedef struct as_up_buf {
    unsigned char* buf;
    size_t len, cap;
    int oom;
} as_up_buf;

static void as_up_add(as_up_buf* b, const void* p, size_t n) {
    if (b->oom || n == 0) return;
    if (b->len + n > b->cap) {
        size_t cap = (b->cap != 0) ? b->cap : 256;
        while (cap < b->len + n) cap *= 2;
        unsigned char* grown = (unsigned char*)realloc(b->buf, cap);
        if (grown == NULL) { b->oom = 1; return; }
        b->buf = grown;
        b->cap = cap;
    }
    memcpy(b->buf + b->len, p, n);
    b->len += n;
}

static void as_up_str(as_up_buf* b, const char* s) {
    if (s != NULL) as_up_add(b, s, strlen(s));
}

// "----------" + 30 alphanumerics (40 characters total), the shape AIR uses --
// measured on all five captured requests. The token itself is opaque (a server
// must read it from Content-Type); matching the shape and the LENGTH keeps parsers
// and WAF rules that assume AIR's layout working.
static unsigned as_up_seed = 0;
static void as_up_boundary(char* out) {
    static const char alpha[] = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    if (as_up_seed == 0) as_up_seed = (unsigned)(as_now_ms() * 1000.0) ^ (unsigned)(uintptr_t)&as_up_seed;
    int i = 0;
    for (; i < 10; i++) out[i] = '-';
    for (; i < 40; i++) {
        as_up_seed = as_up_seed * 1103515245u + 12345u;
        out[i] = alpha[(as_up_seed >> 16) % 62];
    }
    out[40] = '\0';
}

// File and FileReference are both uploadable (File extends FileReference in AIR);
// only a real File carries a nativePath, exactly as in FileReference_load.
static const char* as_up_path_of(void* self) {
    if (self == NULL) return NULL;
    if (as_is(self, &File_vt)) return ((File*)self)->_nativePath;
    return ((FileReference*)self)->_selectedPath;
}

static void FileReference__uploadFinish(void* job);
static void as_upload_pre_events(void* job);

// The response body as the DataEvent payload. AIR hands uploadCompleteData the
// body decoded as UTF-8 text (a JSON or HTML error page arrives readable), and an
// empty body is the empty String, never null.
static char* as_up_body_text(void* job) {
    unsigned n = as_job_len(job);
    char* s = as_str_alloc((size_t)n + 1);
    if (n > 0) memcpy(s, as_job_bytes(job), (size_t)n);
    s[n] = '\0';
    return s;
}

static void FileReference__uploadFinish(void* job) {
    void* obj = as_job_obj(job);
    if (obj == NULL) return;
    // Everything still owed from the in-flight sequence (open, the progress
    // watermarks, the response head) is raised here first, in AIR's order, so an
    // upload that finished inside a single frame still reports all of it.
    as_upload_pre_events(job);
    if (((as_job*)job)->dead) return;
    int status = as_job_status(job);
    // Both a transport failure and a non-2xx answer end in ioError #2038, but they
    // differ in what was reported before it: a request that never got a response
    // reports nothing but the error (measured: a file that no longer exists ->
    // no open, no progress, just ioError), while a 500 reports the full sequence
    // and the error body LAST.
    if (as_job_failed(job) || status >= 300) {
        if (status >= 300) {
            EventDispatcher_dispatchEvent(obj, (Event*)URLLoader__httpStatusEvent((char*)"httpStatus", status));
            if (((as_job*)job)->dead) return;
            EventDispatcher_dispatchEvent(obj, (Event*)DataEvent_new((char*)"uploadCompleteData", false, false, as_up_body_text(job)));
            if (((as_job*)job)->dead) return;
        }
        IOErrorEvent* ev = IOErrorEvent_new((char*)"ioError", false, false, as_ioerror_text(as_job_path(job), 2038, NULL));
        ev->errorID = 2038;
        EventDispatcher_dispatchEvent(obj, (Event*)ev);
        return;
    }
    // Success: COMPLETE comes BEFORE uploadCompleteData -- measured, and the
    // reverse of the download order (where complete is last).
    EventDispatcher_dispatchEvent(obj, Event_new((char*)"complete", false, false));
    if (((as_job*)job)->dead) return;
    EventDispatcher_dispatchEvent(obj, (Event*)DataEvent_new((char*)"uploadCompleteData", false, false, as_up_body_text(job)));
}

// The in-flight half of the upload sequence. Called from as_net_pre_events (the
// frame pre-pass) and again from the finish thunk; every step is flag-guarded, so
// the events are raised exactly once and in order.
static void as_upload_pre_events(void* job) {
    void* obj = as_job_obj(job);
    if (obj == NULL) return;
    if (!as_job_sent_open(job) && as_job_started(job)) {
        as_job_set_sent_open(job);
        EventDispatcher_dispatchEvent(obj, Event_new((char*)"open", false, false));
    }
    // PROGRESS precedes the response head (the body is on the wire before the
    // server can answer) -- measured: open;progress 1000/1000;httpResponseStatus.
    unsigned total = as_job_total(job);
    unsigned sent = as_job_marks_sent(job);
    unsigned mc = (unsigned)as_job_mark_count(job);
    while (sent < mc) {
        unsigned loaded = as_job_mark(job, (int)sent);
        sent++;
        as_job_set_marks_sent(job, sent);
        as_job_set_last_progress(job, loaded);
        EventDispatcher_dispatchEvent(obj, (Event*)ProgressEvent_new((char*)"progress", false, false, loaded, total));
    }
    if (!as_job_sent_status(job)) {
        int st = as_job_status(job);
        if (st > 0) {
            as_job_set_sent_status(job);
            as_array* hdrs = URLLoader__parseHeaders(as_job_headers(job));
            EventDispatcher_dispatchEvent(obj, (Event*)URLLoader__httpResponseEvent((char*)"httpResponseStatus", st, (char*)as_job_eff_url(job), hdrs, as_job_redirected(job) != 0));
        }
    }
}

// Shared entry for FileReference.upload / File.upload / uploadUnencoded.
// 'field' is the uploadDataFieldName (ignored by the unencoded form, whose whole
// body is the file).
static void as_upload_begin(void* self, URLRequest* request, char* field, int unencoded) {
    // AIR's parameter validation, in the order the measurements fix it: no
    // selected file first (#2037), then an empty field name (#2085).
    if (request == NULL) { as_throw(TypeError_new((char*)"Error #2007: Parameter request must be non-null.", 2007)); return; }
    const char* path = as_up_path_of(self);
    if (path == NULL) { as_file_throw(2037); return; }
    if (!unencoded && (field == NULL || field[0] == '\0')) {
        as_throw(Error_new((char*)"Error #2085: Parameter uploadDataFieldName must be non-empty string.", 2085));
        return;
    }
    if (as_dialog_busy(self) || as_async_kind_pending(self, AS_JOB_FILE_UPLOAD)) { as_file_throw(2037); return; }
    // The file as it is NOW: AIR reads it at upload time, not when the File was
    // constructed, and the name inside the envelope is the basename.
    if (!as_path_exists(path)) {
        // AIR does not throw here: the call returns and ioError #2038 arrives at a
        // frame boundary, with no open event.
        if (!as_async_submit_upload(self, FileReference__uploadFinish, request->url, request->userAgent, NULL, NULL, NULL, 0, path, 0, NULL, 0, request->idleTimeout * 1000.0, request->manageCookies ? 1 : 0)) as_file_throw(2038);
        return;
    }
    // Without a transport there is nothing to report that AIR would: an
    // ioError #2038 would blame the FILE, which is present and readable. Say so on
    // stderr once and dispatch nothing, rather than manufacture a failure AIR never
    // produces. (The missing-file case ABOVE still reports #2038: that one is true
    // with or without a backend.)
#if !defined(ASC_HTTP_BACKEND)
    as_shell_unsupported((char*)"File.upload (no HTTP upload backend in this build)");
    return;
#else
    File* fileObj = File_new((char*)path);
    const char* name = File_get_name(fileObj);
    double dsize = File_get_size(fileObj);
    size_t size = (dsize > 0.0) ? (size_t)dsize : 0;
    net_req nr;
    net__prepare_request(request, &nr);
    char boundary[64];
    as_up_boundary(boundary);
    as_up_buf head;
    as_up_buf tail;
    memset(&head, 0, sizeof(head));
    memset(&tail, 0, sizeof(tail));
    char ct[128];
    ct[0] = '\0';
    if (!unencoded) {
        // 1. the leading Filename part
        as_up_str(&head, "--"); as_up_str(&head, boundary);
        as_up_str(&head, "\r\nContent-Disposition: form-data; name=\"Filename\"\r\n\r\n");
        as_up_str(&head, (name != NULL) ? name : "");
        as_up_str(&head, "\r\n");
        // 2. one part per URLVariables entry, key and value RAW
        if (request->data.tag != 0 && request->data.tag != 5 && as_v_is_inst(request->data, &URLVariables_vt)) {
            URLVariables* vars = (URLVariables*)as_v_obj_val(request->data);
            as_object* d = (vars != NULL) ? vars->_dyn : NULL;
            for (int i = 0; d != NULL && i < d->length; i++) {
                as_up_str(&head, "--"); as_up_str(&head, boundary);
                as_up_str(&head, "\r\nContent-Disposition: form-data; name=\"");
                as_up_str(&head, (d->keys[i] != NULL) ? d->keys[i] : "");
                as_up_str(&head, "\"\r\n\r\n");
                as_up_str(&head, as_v_str_val(d->vals[i]));
                as_up_str(&head, "\r\n");
            }
        }
        // 3. the file part's headers; the bytes follow from disk
        as_up_str(&head, "--"); as_up_str(&head, boundary);
        as_up_str(&head, "\r\nContent-Disposition: form-data; name=\"");
        as_up_str(&head, field);
        as_up_str(&head, "\"; filename=\"");
        as_up_str(&head, (name != NULL) ? name : "");
        as_up_str(&head, "\"\r\nContent-Type: application/octet-stream\r\n\r\n");
        // 4. the closing "Upload"/"Submit Query" part, with no CRLF after the
        //    final delimiter.
        as_up_str(&tail, "\r\n--"); as_up_str(&tail, boundary);
        as_up_str(&tail, "\r\nContent-Disposition: form-data; name=\"Upload\"\r\n\r\nSubmit Query\r\n--");
        as_up_str(&tail, boundary);
        as_up_str(&tail, "--");
        snprintf(ct, sizeof(ct), "multipart/form-data; boundary=%s", boundary);
    }
    int ok = !head.oom && !tail.oom &&
        as_async_submit_upload(self, FileReference__uploadFinish, request->url, request->userAgent,
                               (ct[0] != '\0') ? ct : NULL, nr.headers,
                               head.buf, head.len, path, size, tail.buf, tail.len,
                               request->idleTimeout * 1000.0, request->manageCookies ? 1 : 0);
    free(head.buf);
    free(tail.buf);
    if (!ok) as_file_throw(2038);
#endif
}

void FileReference_upload(void* self, URLRequest* request, char* uploadDataFieldName, bool testUpload) {
    // testUpload asks AIR for a server-side connectivity check; measured on 51.4.1
    // it changes NOTHING observable (same request bytes, same events), so it is
    // accepted and ignored rather than faked.
    (void)testUpload;
    as_upload_begin(self, request, uploadDataFieldName, 0);
}
void FileReference_uploadUnencoded(void* self, URLRequest* request) {
    as_upload_begin(self, request, NULL, 1);
}
`;
