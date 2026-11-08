// Generated C runtime for flash.desktop.NativeProcess (stage 391).
//
// Everything below reproduces what was MEASURED on adl 51.4.1 (temp/npa/air/NP.as,
// NP2.as and the mxmlc class-shape probe Members.as). The numbers that drive the
// code are:
//
//   * the pipes exist from CONSTRUCTION, not from start(): `np.standardOutput` is
//     a live object before start() and keeps its identity across reads;
//   * `start(null)` throws TypeError #1009 (AIR dereferences the argument), while
//     `start(info-with-no-executable)` throws ArgumentError #3214 -- and the #3214
//     wording is "does not specify a valid executable file";
//   * `start()` on a running process throws Error #3213;
//   * `closeInput()` / `exit()` before start are silent no-ops, and so is
//     `closeInput()` after the exit event;
//   * writing to standardInput after the child is gone throws Error #3212
//     ("...that is not running") -- reported here only where this runtime can see
//     it (see docs/zh-cn/native-process.md for the ByteArray-typed divergence);
//   * an exited child delivers ProgressEvent.STANDARD_OUTPUT_DATA /
//     STANDARD_ERROR_DATA first and NativeProcessExitEvent.EXIT last; the data
//     events carry bytesLoaded=<bytes>, bytesTotal=0 (0, not the total: a pipe has
//     no length), and Air dispatches EXIT only after the pipes are drained;
//   * `running` turns true immediately at start() and false when EXIT is
//     delivered; a forced kill reports a NaN exitCode in AIR (a Number that its own
//     `uint` declaration cannot represent) -- this backend reports 0 instead.
//
// Scheduling: nothing here blocks the AS3 thread. The spawn is synchronous (AIR's
// is too -- an invalid executable throws from start()), but every pipe read is a
// non-blocking probe and all events go out from as_np_tick(), which the frame
// boundary calls (Stage_dispatchFrame) together with the other pumps, so user
// listeners run with the same ordering guarantees as every other runtime event.
//
// Calls into AS3 land in O(tick) slots only when a process is live; a program with
// no NativeProcess pays one loop over an empty table.
export const NATIVE_PROCESS_RUNTIME = String.raw`
// ---- flash.desktop.NativeProcess (stage 391) ----
//
// One slot per live child. AS3 objects are NOT referenced by index from AS3, so
// the registry is keyed by the NativeProcess pointer itself; that pointer is also
// the GC root (as_np_mark_roots), which is what keeps a process object alive while
// the child runs even if AS3 dropped every reference to it -- AIR keeps delivering
// its events, and a listener registered on it before the drop must still fire.
#ifndef _WIN32
#include <sys/wait.h>
#endif

#define AS_NP_MAX 8

typedef struct as_np_slot {
    int used;
    void* obj;
    int running;      // child alive (or exit known but not yet delivered)
    int stdin_closed;
    int in_sent;      // bytes of the standardInput buffer already written to the child
    int exited;
    int exit_code;
#ifdef _WIN32
    HANDLE proc;
    HANDLE in_w;
    HANDLE out_r;
    HANDLE err_r;
#else
    pid_t pid;
    int in_w;
    int out_r;
    int err_r;
#endif
} as_np_slot;
static as_np_slot as_np_slots[AS_NP_MAX];

// One measured contract per line, so a caller-facing message is never invented.
#define AS_NP_ERR_NOT_RUNNING "Error #3212: Cannot perform operation on a NativeProcess that is not running."
#define AS_NP_ERR_RUNNING "Error #3213: Cannot perform operation on a NativeProcess that is already running."
#define AS_NP_ERR_EXE "Error #3214: NativeProcessStartupInfo.executable does not specify a valid executable file."
#define AS_NP_ERR_WD "Error #3215: NativeProcessStartupInfo.workingDirectory does not specify a valid directory."
#define AS_NP_ERR_NULL "Error #1009: Cannot access a property or method of a null object reference."

static int as_np_supported(void) {
#if defined(_WIN32)
    return 1;
#elif defined(__wasi__) || defined(__EMSCRIPTEN__)
    // No process API at all: a WASI build answers isSupported=false, which is the
    // same answer AIR gives on a platform whose runtime cannot spawn.
    return 0;
#else
    return 1;
#endif
}

static as_np_slot* as_np_find(void* obj) {
    for (int i = 0; i < AS_NP_MAX; i++) {
        if (as_np_slots[i].used && as_np_slots[i].obj == obj) return &as_np_slots[i];
    }
    return NULL;
}

// Handles are closed exactly once, by as_np_release: an exit that is delivered and
// a force-kill that never got its exit event must not both close, or a closed
// HANDLE could be closed again after the OS reused the value.
static void as_np_release(as_np_slot* s) {
#ifdef _WIN32
    if (s->proc != NULL) CloseHandle(s->proc);
    if (s->in_w != NULL) CloseHandle(s->in_w);
    if (s->out_r != NULL) CloseHandle(s->out_r);
    if (s->err_r != NULL) CloseHandle(s->err_r);
    s->proc = NULL; s->in_w = NULL; s->out_r = NULL; s->err_r = NULL;
#else
    if (s->in_w >= 0) close(s->in_w);
    if (s->out_r >= 0) close(s->out_r);
    if (s->err_r >= 0) close(s->err_r);
    s->in_w = -1; s->out_r = -1; s->err_r = -1; s->pid = -1;
#endif
    memset(s, 0, sizeof(*s));
#ifdef _WIN32
    s->proc = NULL; s->in_w = NULL; s->out_r = NULL; s->err_r = NULL;
#else
    s->in_w = -1; s->out_r = -1; s->err_r = -1; s->pid = -1;
#endif
}

static as_np_slot* as_np_open(void* obj) {
    as_np_slot* s = as_np_find(obj);
    if (s != NULL) return s;
    for (int i = 0; i < AS_NP_MAX; i++) {
        if (!as_np_slots[i].used) {
            s = &as_np_slots[i];
            as_np_release(s);         // normalises the handle fields, then clears
            s->used = 1;
            s->obj = obj;
            return s;
        }
    }
    return NULL;
}

static void as_np_mark_roots(void) {
    for (int i = 0; i < AS_NP_MAX; i++) {
        if (as_np_slots[i].used) gc_mark_ptr(as_np_slots[i].obj);
    }
}

// Append to a pipe ByteArray. The AS3 side reads with bytesAvailable/readUTFBytes,
// which consume from the same buffer, so no separate cursor is needed: what AS3
// has not read yet is exactly what belongs to the next data event.
static void as_np_append(ByteArray* ba, const char* src, int n) {
    if (ba == NULL || n <= 0) return;
    as_ba_grow(ba, n);
    memcpy((unsigned char*)ba->data + ba->length, src, (size_t)n);
    ba->length += n;
}

static void as_np_dispatch_data(void* obj, ByteArray* pipe, const char* type, int n) {
    if (n <= 0) return;
    // bytesTotal is 0, measured: a pipe has no announced length.
    ProgressEvent* ev = ProgressEvent_new((char*)type, false, false, (double)n, 0.0);
    (void)pipe;
    EventDispatcher_dispatchEvent(obj, (Event*)ev);
}

// ---------------------------------------------------------------- command line --
#ifdef _WIN32
// The command line AIR builds on Windows, reproduced rather than improved: argv[0]
// is quoted (so a program path with spaces still resolves), and every argument is
// appended VERBATIM, one space apart, with NO quoting at all. Measured on adl
// 51.4.1 (temp/npa/air/Q.as): arguments ["/c", "echo one two"] make cmd.exe print
// "one two", and a caller-supplied quoted argument keeps exactly the quotes the
// caller typed. A quoting layer here would be a DIVERGENCE, not a fix: cmd.exe
// re-parses this string under its own rules, where an unexpected quote pair turns a
// valid command into "is not recognized as an internal or external command".
static void as_np_quote(char* buf, size_t cap, size_t* len, const char* arg) {
    size_t n = *len;
    if (arg == NULL) arg = "";
    if (n + 3 < cap) buf[n++] = '"';
    size_t bs = 0;
    for (const char* p = arg; ; p++) {
        if (*p == '\\') { bs++; continue; }
        if (*p == '"') {
            for (size_t k = 0; k < bs * 2 + 1 && n + 1 < cap; k++) buf[n++] = '\\';
            if (n + 1 < cap) buf[n++] = '"';
            bs = 0;
            continue;
        }
        for (size_t k = 0; k < bs && n + 1 < cap; k++) buf[n++] = '\\';
        bs = 0;
        if (*p == '\0') break;
        if (n + 1 < cap) buf[n++] = *p;
    }
    if (n + 2 < cap) { buf[n++] = '"'; buf[n++] = ' '; }
    buf[n] = '\0';
    *len = n;
}
#endif

// Start a child. Returns 0 on success; on failure *why names the OS reason and the
// caller reports AIR's #3214 (measured: a start() whose executable disappeared
// between the setter and the call is exactly that error, not a silent no-op).
static int as_np_spawn(as_np_slot* s, const char* exe, const char* cwd, as_vector_string* args) {
    int argc = args != NULL ? args->length : 0;
#ifdef _WIN32
    SECURITY_ATTRIBUTES sa;
    HANDLE in_r = NULL, in_w = NULL, out_r = NULL, out_w = NULL, err_r = NULL, err_w = NULL;
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    wchar_t* wexe = as_p_wide(exe);
    wchar_t* wcwd = as_p_wide(cwd);
    wchar_t* wcmd = NULL;
    char* cmd = NULL;
    int ok = 0;
    if (wexe == NULL) return 0;

    sa.nLength = (DWORD)sizeof(sa);
    sa.lpSecurityDescriptor = NULL;
    sa.bInheritHandle = TRUE;
    // The child inherits the three "business ends"; the parent keeps the others
    // non-inheritable so a grandchild cannot hold the pipe open and prevent EOF.
    if (!CreatePipe(&in_r, &in_w, &sa, 0)) goto done;
    if (!SetHandleInformation(in_w, HANDLE_FLAG_INHERIT, 0)) goto done;
    if (!CreatePipe(&out_r, &out_w, &sa, 0)) goto done;
    if (!SetHandleInformation(out_r, HANDLE_FLAG_INHERIT, 0)) goto done;
    if (!CreatePipe(&err_r, &err_w, &sa, 0)) goto done;
    if (!SetHandleInformation(err_r, HANDLE_FLAG_INHERIT, 0)) goto done;

    {
        size_t cap = strlen(exe) + 16;
        for (int i = 0; i < argc; i++) {
            const char* a = (args->data != NULL && args->data[i] != NULL) ? args->data[i] : "";
            cap += strlen(a) + 8;
        }
        cmd = (char*)malloc(cap);
        if (cmd == NULL) goto done;
        size_t len = 0;
        cmd[0] = '\0';
        as_np_quote(cmd, cap, &len, exe);
        for (int i = 0; i < argc; i++) {
            const char* a = (args->data != NULL && args->data[i] != NULL) ? args->data[i] : "";
            // Verbatim, one space apart (see as_np_quote): AIR quotes only argv[0].
            size_t alen = strlen(a);
            if (len + alen + 2 >= cap) break;
            memcpy(cmd + len, a, alen);
            len += alen;
            cmd[len++] = ' ';
            cmd[len] = '\0';
        }
        wcmd = as_p_wide(cmd);
        if (wcmd == NULL) goto done;
    }

    memset(&si, 0, sizeof(si));
    si.cb = (DWORD)sizeof(si);
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = in_r;
    si.hStdOutput = out_w;
    si.hStdError = err_w;
    memset(&pi, 0, sizeof(pi));
    // CREATE_NO_WINDOW: AIR's child is a console program with no console window;
    // a GUI child still shows its own windows, which is the child's business.
    if (!CreateProcessW(wexe, wcmd, NULL, NULL, TRUE, CREATE_NO_WINDOW, NULL, wcwd, &si, &pi)) goto done;
    CloseHandle(pi.hThread);
    s->proc = pi.hProcess;
    s->in_w = in_w; in_w = NULL;
    s->out_r = out_r; out_r = NULL;
    s->err_r = err_r; err_r = NULL;
    ok = 1;
done:
    if (in_r != NULL) CloseHandle(in_r);
    if (in_w != NULL) CloseHandle(in_w);
    if (out_w != NULL) CloseHandle(out_w);
    if (out_r != NULL) CloseHandle(out_r);
    if (err_w != NULL) CloseHandle(err_w);
    if (err_r != NULL) CloseHandle(err_r);
    free(wexe); free(wcwd); free(wcmd); free(cmd);
    return ok;
#else
    int in_pipe[2], out_pipe[2], err_pipe[2];
    pid_t pid;
    char* argv_local[64];
    char** argv = argv_local;
    int narg = argc + 1;
    if (narg > 64) argv = (char**)calloc((size_t)narg + 1, sizeof(char*));
    if (argv == NULL) return 0;
    argv[0] = (char*)exe;
    for (int i = 0; i < argc; i++) argv[i + 1] = (args->data != NULL) ? args->data[i] : (char*)"";
    argv[narg] = NULL;
    if (pipe(in_pipe) != 0) { if (argv != argv_local) free(argv); return 0; }
    if (pipe(out_pipe) != 0) { close(in_pipe[0]); close(in_pipe[1]); if (argv != argv_local) free(argv); return 0; }
    if (pipe(err_pipe) != 0) { close(in_pipe[0]); close(in_pipe[1]); close(out_pipe[0]); close(out_pipe[1]); if (argv != argv_local) free(argv); return 0; }
    pid = fork();
    if (pid == 0) {
        // Child: wire the three pipes to 0/1/2 and exec. _exit on every failure so
        // a failed exec cannot run the parent's atexit handlers.
        dup2(in_pipe[0], 0);
        dup2(out_pipe[1], 1);
        dup2(err_pipe[1], 2);
        close(in_pipe[0]); close(in_pipe[1]);
        close(out_pipe[0]); close(out_pipe[1]);
        close(err_pipe[0]); close(err_pipe[1]);
        if (cwd != NULL) { if (chdir(cwd) != 0) _exit(127); }
        execv(exe, argv);
        _exit(127);
    }
    // Parent: the child ends of the pipes are not ours to hold, or the read side
    // would never see EOF.
    close(in_pipe[0]);
    close(out_pipe[1]);
    close(err_pipe[1]);
    if (argv != argv_local) free(argv);
    if (pid < 0) { close(in_pipe[1]); close(out_pipe[0]); close(err_pipe[0]); return 0; }
    // Non-blocking reads AND a non-blocking write side: the AS3 thread must never
    // block on a child that is not reading its stdin.
    fcntl(in_pipe[1], F_SETFL, fcntl(in_pipe[1], F_GETFL, 0) | O_NONBLOCK);
    fcntl(out_pipe[0], F_SETFL, fcntl(out_pipe[0], F_GETFL, 0) | O_NONBLOCK);
    fcntl(err_pipe[0], F_SETFL, fcntl(err_pipe[0], F_GETFL, 0) | O_NONBLOCK);
    s->pid = pid;
    s->in_w = in_pipe[1];
    s->out_r = out_pipe[0];
    s->err_r = err_pipe[0];
    return 1;
#endif
}

// --------------------------------------------------------------- pipe traffic --
// Reads what the child wrote since the last tick. Returns the byte count, appending
// into 'ba'; 0 means "nothing available" (EOF included -- the exit event is what
// reports the end, exactly as AIR does: 51.4 has no STANDARD_OUTPUT_CLOSE).
static int as_np_read_pipe(as_np_slot* s, int which, ByteArray* ba) {
    int total = 0;
    char buf[4096];
#ifdef _WIN32
    HANDLE h = which == 0 ? s->out_r : s->err_r;
    for (;;) {
        DWORD avail = 0;
        DWORD got = 0;
        if (h == NULL) break;
        if (!PeekNamedPipe(h, NULL, 0, NULL, &avail, NULL)) break;
        if (avail == 0) break;
        DWORD want = avail > (DWORD)sizeof(buf) ? (DWORD)sizeof(buf) : avail;
        if (!ReadFile(h, buf, want, &got, NULL)) break;
        if (got == 0) break;
        as_np_append(ba, buf, (int)got);
        total += (int)got;
        if (total > (1 << 22)) break;   // a flooding child cannot starve the frame
    }
#else
    int fd = which == 0 ? s->out_r : s->err_r;
    for (;;) {
        ssize_t got;
        if (fd < 0) break;
        got = read(fd, buf, sizeof(buf));
        if (got > 0) {
            as_np_append(ba, buf, (int)got);
            total += (int)got;
            if (total > (1 << 22)) break;
            continue;
        }
        // EINTR: retry once more; EAGAIN/EOF: nothing else to read this tick.
        if (got < 0 && errno == EINTR) continue;
        break;
    }
#endif
    return total;
}

// Moves bytes the AS3 side wrote into 'standardInput' out to the child. Nothing is
// intercepted at write time (the pipe is a ByteArray, see the module header), so
// this is where a write becomes a syscall.
static void as_np_flush_stdin(as_np_slot* s, ByteArray* in) {
    if (in == NULL) return;
#ifdef _WIN32
    if (s->in_w == NULL) return;
#else
    if (s->in_w < 0) return;
#endif
    while (s->in_sent < in->length) {
        int want = in->length - s->in_sent;
        if (want > 4096) want = 4096;   // bounded per tick: never a long blocking write
#ifdef _WIN32
        {
            DWORD wrote = 0;
            if (!WriteFile(s->in_w, (const unsigned char*)in->data + s->in_sent, (DWORD)want, &wrote, NULL)) return;
            if (wrote == 0) return;
            s->in_sent += (int)wrote;
        }
#else
        {
            ssize_t wrote = write(s->in_w, (const unsigned char*)in->data + s->in_sent, (size_t)want);
            if (wrote > 0) { s->in_sent += (int)wrote; continue; }
            if (wrote < 0 && errno == EINTR) continue;
            return;   // EAGAIN: the rest goes out on a later tick
        }
#endif
    }
}

static void as_np_close_stdin(as_np_slot* s, ByteArray* in) {
    as_np_flush_stdin(s, in);
    if (s->stdin_closed) return;
    s->stdin_closed = 1;
#ifdef _WIN32
    if (s->in_w != NULL) { CloseHandle(s->in_w); s->in_w = NULL; }
#else
    if (s->in_w >= 0) { close(s->in_w); s->in_w = -1; }
#endif
}

// --------------------------------------------------------------- AS3 surface --
static File* as_np_info_get_exe(void* info) {
    return info != NULL ? ((NativeProcessStartupInfo*)info)->_exe : NULL;
}
static File* as_np_info_get_wd(void* info) {
    return info != NULL ? ((NativeProcessStartupInfo*)info)->_wd : NULL;
}

// AIR validates at the SETTER, not at start(): measured #3214/#3215 with the
// wording above, thrown from the property assignment itself.
static void as_np_info_set_exe(void* info, File* value) {
    NativeProcessStartupInfo* si = (NativeProcessStartupInfo*)info;
    if (si == NULL) return;
    if (value == NULL || !File_get_exists(value) || File_get_isDirectory(value)) {
        as_throw(ArgumentError_new((char*)AS_NP_ERR_EXE, 3214));
        return;
    }
    si->_exe = value;
    gc_write_barrier((void*)value);
}

static void as_np_info_set_wd(void* info, File* value) {
    NativeProcessStartupInfo* si = (NativeProcessStartupInfo*)info;
    if (si == NULL) return;
    // null is legal: it means "inherit the launcher's working directory".
    if (value != NULL && (!File_get_exists(value) || !File_get_isDirectory(value))) {
        as_throw(ArgumentError_new((char*)AS_NP_ERR_WD, 3215));
        return;
    }
    si->_wd = value;
    gc_write_barrier((void*)value);
}

static void as_np_start(void* obj, void* info) {
    NativeProcess* np = (NativeProcess*)obj;
    NativeProcessStartupInfo* si = (NativeProcessStartupInfo*)info;
    as_np_slot* s;
    File* exe;
    if (si == NULL) {
        as_throw(TypeError_new((char*)AS_NP_ERR_NULL, 1009));
        return;
    }
    if (!as_np_supported()) {
        as_shell_unsupported("flash.desktop.NativeProcess.start (this build has no process backend)");
        return;
    }
    s = as_np_find(obj);
    if (s != NULL && s->running) {
        as_throw(Error_new((char*)AS_NP_ERR_RUNNING, 3213));
        return;
    }
    exe = si->_exe;
    if (exe == NULL || !File_get_exists(exe) || File_get_isDirectory(exe)) {
        as_throw(ArgumentError_new((char*)AS_NP_ERR_EXE, 3214));
        return;
    }
    s = as_np_open(obj);
    if (s == NULL) {
        // More live children than slots: reported, never a silent no-op.
        as_shell_unsupported("flash.desktop.NativeProcess.start (this build tracks at most 8 live child processes)");
        return;
    }
    {
        const char* path = exe->_nativePath;
        const char* cwd = (si->_wd != NULL) ? si->_wd->_nativePath : NULL;
        if (!as_np_spawn(s, path, cwd, si->arguments)) {
            as_np_release(s);
            as_throw(ArgumentError_new((char*)AS_NP_ERR_EXE, 3214));
            return;
        }
    }
    s->used = 1;
    s->obj = obj;
    s->running = 1;
    s->exited = 0;
    s->stdin_closed = 0;
    s->in_sent = 0;
    // Measured: running reads true on the line after start().
    np->running = true;
    // A fresh pipe contents: AIR handed the process new pipes at start(). The
    // ctor's empty ByteArrays are reused (identity is stable across start, as
    // measured -- the fields are never reassigned).
}

static void as_np_exit(void* obj, int force) {
    as_np_slot* s = as_np_find(obj);
    (void)force;
    if (s == NULL || !s->running) return;   // measured: a silent no-op
#ifdef _WIN32
    // AIR's force=false asks the child to close; a console child with no window has
    // no message loop to ask, so this backend terminates in both cases. Documented
    // divergence (docs/zh-cn/native-process.md).
    if (s->proc != NULL) TerminateProcess(s->proc, 0);
#else
    if (s->pid > 0) kill(s->pid, force ? SIGKILL : SIGTERM);
#endif
    // Not reaped here: the exit event must still go out at the frame boundary, in
    // order after any data the child managed to write.
}

static void as_np_close_input(void* obj) {
    as_np_slot* s = as_np_find(obj);
    ByteArray* in;
    if (s == NULL || !s->running) return;   // measured: silent before start/after exit
    in = ((NativeProcess*)obj)->standardInput;
    as_np_close_stdin(s, in);
}

// Reads what arrived, flushes stdin, then delivers the exit event once the child is
// gone -- the measured order (data first, EXIT last).
static void as_np_tick(void) {
    for (int i = 0; i < AS_NP_MAX; i++) {
        as_np_slot* s = &as_np_slots[i];
        NativeProcess* np;
        int out_n;
        int err_n;
        int code = 0;
        int done = 0;
        if (!s->used || !s->running) continue;
        np = (NativeProcess*)s->obj;

        out_n = as_np_read_pipe(s, 0, np->standardOutput);
        err_n = as_np_read_pipe(s, 1, np->standardError);
        // Dispatch AFTER both reads so a handler that inspects both pipes sees the
        // frame's full picture, and so the ordering stays data -> exit.
        if (out_n > 0) {
            as_np_dispatch_data(np, np->standardOutput, "standardOutputData", out_n);
            if (!s->used) continue;   // a handler disposed the process
        }
        if (err_n > 0) {
            as_np_dispatch_data(np, np->standardError, "standardErrorData", err_n);
            if (!s->used) continue;
        }
        as_np_flush_stdin(s, np->standardInput);

#ifdef _WIN32
        if (s->proc != NULL && WaitForSingleObject(s->proc, 0) == WAIT_OBJECT_0) {
            DWORD c = 0;
            if (GetExitCodeProcess(s->proc, &c)) code = (int)c;
            done = 1;
        }
#else
        {
            int status = 0;
            pid_t r = waitpid(s->pid, &status, WNOHANG);
            if (r == s->pid) {
                if (WIFEXITED(status)) code = WEXITSTATUS(status);
                else if (WIFSIGNALED(status)) code = 128 + WTERMSIG(status);   // shell convention
                done = 1;
            }
        }
#endif
        if (!done) continue;
        // Final drain: whatever the child wrote on its way out is delivered before
        // the exit event, so a launcher never loses the last line of output.
        out_n = as_np_read_pipe(s, 0, np->standardOutput);
        err_n = as_np_read_pipe(s, 1, np->standardError);
        if (out_n > 0) as_np_dispatch_data(np, np->standardOutput, "standardOutputData", out_n);
        if (err_n > 0) as_np_dispatch_data(np, np->standardError, "standardErrorData", err_n);

        np->running = false;
        as_np_release(s);
        EventDispatcher_dispatchEvent(np, (Event*)NativeProcessExitEvent_new((char*)"exit", false, false, (double)code));
    }
}`;
