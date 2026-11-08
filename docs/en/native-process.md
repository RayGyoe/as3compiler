# `flash.desktop.NativeProcess`: measured contract and implementation

> This page answers one question: **what does the AIR child-process surface actually do in
> an AOT build** — spawn, read stdout/stderr, write stdin, wait for an exit code.
>
> The contract comes from `adl 51.4.1` measurements: class shapes confirmed with a
> `mxmlc 51.4.1` compile plus a `describeType` probe (`temp/npa/air/T.as`), runtime
> behavior and error texts confirmed with probes that really spawn children
> (`temp/npa/air/NP.as`, `NP2.as`, `Q.as`). The backend is `src/native-process.ts`
> (hand-written C: `CreateProcessW` + pipes on Windows, `fork`/`execv`/`pipe` on POSIX),
> pumped once per frame boundary on the same path as sockets, async IO and timers.
>
> In one sentence: **shapes, error ids and texts, and event order follow the measurements;
> the three places that cannot be aligned are listed honestly in §7**, and none of them is
> papered over with "it happens to work".

---

## 1. Class shapes (measured, not copied from SDK metadata)

Confirmed in both directions with `describeType` and `mxmlc`:

| Member | Measured shape | Notes |
|---|---|---|
| `NativeProcess.isSupported` | static read-only `Boolean` | `true` on desktop backends, `false` on WASI/web |
| `NativeProcess.running` | read-only `Boolean` | `true` on the **same line** as `start()` |
| `NativeProcess.standardInput` | `IDataOutput` | measured object is an anonymous `OutboundPipe` (§7.1) |
| `NativeProcess.standardOutput` / `standardError` | `IDataInput` | anonymous `InboundPipe` |
| `NativeProcess.start(info)` | `void` | a `null` argument throws `#1009` |
| `NativeProcess.exit(force = false)` | `void` | silent no-op before start |
| `NativeProcess.closeInput()` | `void` | silent no-op before start |
| `NativeProcessStartupInfo.executable` | read/write `File` | validated on assignment |
| `NativeProcessStartupInfo.workingDirectory` | read/write `File` | validated on assignment |
| `NativeProcessStartupInfo.arguments` | `Vector.<String>` | empty Vector by default |
| `NativeProcessExitEvent.EXIT` | constant `"exit"` | |
| `NativeProcessExitEvent.exitCode` | **`number`** (measured `typeof` is `"number"`) | not `uint` |

**Members that do not exist in the measurement, and therefore not in the implementation**
(an earlier draft invented them from memory; they are gone):

- `NativeProcess.pid` / `NativeProcess.processID` — `mxmlc` reports them as undefined;
- `NativeProcessStartupInfo.environment`;
- `NativeProcessStartupInfo.standardInput` / `standardOutput` / `standardError` (redirection fields);
- `NativeProcessExitEvent.process`.

> Rule: a member counts as AIR only when `mxmlc` accepts it AND `adl describeType` lists it.
> Fewer means our defect; more means an **illegal enhancement** (it invites code AIR cannot compile).

---

## 2. Error contract (id, text and throw site all measured)

| Situation | Error | Text |
|---|---|---|
| `start(null)` | `TypeError #1009` | `Cannot access a property or method of a null object reference.` |
| `executable` empty / missing / a directory (**on assignment**) | `ArgumentError #3214` | `NativeProcessStartupInfo.executable does not specify a valid executable file.` |
| `start()` while `executable` is still empty | `ArgumentError #3214` | same |
| `workingDirectory` missing / not a directory (**on assignment**) | `ArgumentError #3215` | `NativeProcessStartupInfo.workingDirectory does not specify a valid directory.` |
| `start()` on a running process | `Error #3213` | `Cannot perform operation on a NativeProcess that is already running.` |
| writing stdin after the child died | `IOError #3212` | see §7.1 (never happens in this backend, so it is never thrown) |

Two points that matter:

1. **Validation lives in the setter, not in `start()`.** `si.executable = new File("missing")`
   throws `#3214` right there; `start()` re-checks only because the field may never have been set.
2. `workingDirectory = null` is **legal** (inherit the launcher's directory) and throws nothing.

---

## 3. Lifecycle and event order

```
new NativeProcess()          -> running=false, all three pipes exist and are empty
start(info)                  -> running is true on the very next line
     [frame boundary pump]   -> standardOutputData / standardErrorData (only when there is data)
                             -> exit (the child is really gone)
```

- **Data first, `exit` last**: the pump drains both pipes before checking liveness, so the last
  line a child writes on its way out is delivered before the exit event.
- `ProgressEvent.bytesLoaded` is the **byte count** read this frame; `bytesTotal` is **`0`** —
  a pipe announces no length. That is the measurement, not an omission.
- `running` is still `true` on the line after `exit(true)`; the exit event clears it. So `exit()`
  is not a synchronous stop, and nothing may assume it is.
- The same `NativeProcess` object **can start again** after an exit, and the new child's code
  is what gets reported.
- A throwing handler propagates through the usual `try/catch` and does not break the pump, as in
  the other async channels.

---

## 4. How the three pipes are pumped

- Pump points are `tickFrame()` / `tickTimers()` / `Stage_dispatchFrame()` — the **same boundary**
  as sockets, async IO and timers. Windowed builds get one per frame; headless builds let the
  script call `tickFrame()` itself.
- Reads are **non-blocking**: `PeekNamedPipe` + `ReadFile` on Windows, `O_NONBLOCK` `read` on
  POSIX, with `EAGAIN` / `ERROR_NO_DATA` treated as "nothing this frame".
- Writing stdin is non-blocking too and bounded to 4096 bytes per frame, so a child that never
  reads its stdin cannot stall the AS3 thread.
- `closeInput()` flushes what is still buffered, then closes the write end — which is the EOF that
  `more`/`cat` style children need in order to exit.
- `exit(force)` only signals/terminates; **reaping still happens at the frame boundary** so data
  already in the pipe is delivered first.

---

## 5. The Windows command line: AIR joins arguments verbatim, and so do we

This is the easiest place to be helpful and wrong. Measured (`temp/npa/air/Q.as`):

| `arguments` passed | what `cmd.exe` printed |
|---|---|
| `["/c", "echo one two"]` | `one two` |
| `["/c", "echo \"one two\""]` | `"one two"` (the quotes survive **exactly**) |

So on Windows **AIR quotes argv[0] only and appends every argument verbatim, one space apart**.
We therefore do **not** apply the CRT quoting rules (escape backslashes, wrap in quotes): that
would be a divergence rather than a fix, because `cmd.exe` re-parses the string under its own
rules, where an unexpected quote pair turns a valid command into
`'xxx' is not recognized as an internal or external command` (the first draft of this backend did
exactly that; see the early `temp/npa/aot/P3.as` log).

Consequence, identical to AIR: an argument containing a space must be quoted **by the caller** on
Windows. POSIX has no such issue — `execv` takes a real argv array.

---

## 6. Platform boundaries

| Platform | Behavior |
|---|---|
| Windows | `CreateProcessW` with `CREATE_NO_WINDOW` (no console window for the child; its own windows are its business), `PeekNamedPipe`, `TerminateProcess` |
| macOS / Linux | `pipe` + `fork` + `execv`; read ends non-blocking; `exit(force)` sends `SIGKILL`, otherwise `SIGTERM`; exit code from `WEXITSTATUS`, or `128 + signal` per shell convention |
| WASI / web | `isSupported = false`; `start()` **reports** that it is unsupported instead of faking success |

- **At most 8 live children** (`AS_NP_MAX`). A ninth `start()` goes through the "reported
  unsupported" channel rather than being silently dropped.
- Process objects are held by the GC root table: dropping the AS3 reference still delivers pipe
  data and the exit event, so a GC cannot turn a child into an event-less orphan.
- Exit codes follow the host width: Windows keeps the full 32-bit status; a POSIX wait status only
  carries the low eight bits, so the same `exit 300` is observed as `44` there. That is what the
  host reports to any child-process API (AIR included), not a choice of ours.

---

## 7. Divergences, stated plainly (three)

### 7.1 `standardInput` is a `ByteArray`, not AIR's `OutboundPipe`

AIR's write end is an `OutboundPipe` (`IDataOutput`) whose writes reach the pipe **immediately**.
Our `standardInput` is a `ByteArray`: bytes accumulate and are really written **at the frame
boundary**. Observable consequences:

1. writing after the child died does **not** throw `#3212` (AIR does), because the write site never
   consults pipe state. The id stays registered for shape comparison;
2. writes are **append semantics**: `in_sent` records how much has been handed to the pipe, so
   `position`/`clear()` do not change what was already sent;
3. `bytesAvailable`/`length` have no counterpart on AIR's write end (we expose a ByteArray's read face).

Why: `standardInput.writeUTFBytes(...)` is an ordinary ByteArray method. Intercepting writes there
would require a custom class — a type AIR does not have — and would be more error-prone than
buffering. The buffering model's cost is one frame of latency before bytes are sent, which is
unobservable for callers that write after `start()` and keep writing on later frames.

### 7.2 Exit code of a forcibly killed child

`adl 51.4.1` on Windows reports `exitCode = NaN` for a child killed by `exit(true)`. We report the
platform wait status (Windows `TerminateProcess(..., 0)` → `0`; POSIX → `128 + signal`). We do not
fabricate `NaN`: it carries no information, while the real termination code tells you whether the
child was killed or exited on its own. `examples/native-process.as` therefore asserts only that an
exit code is present, never a specific value.

### 7.3 `exit(false)` also terminates on Windows

AIR's `force=false` means "ask the child to close" (a GUI child runs a message loop). A console
child has no message loop to ask, so on Windows this backend ignores `force` and always calls
`TerminateProcess`; on POSIX `force=false` sends `SIGTERM` (catchable/ignorable) and `true` sends
`SIGKILL`.

---

## 8. Validation

| Item | Content |
|---|---|
| Example | `examples/native-process.as`: 16 assertion groups covering shapes, error ids/texts, event order, `bytesLoaded/bytesTotal`, stdin round trip + EOF, `#3213`, force stop, restart, `workingDirectory`. The script picks its child by host (`cmd.exe` on Windows, `/bin/sh` elsewhere), so one script covers both. Measured **on Windows only** in stage 391: the POSIX branch of the runtime (`fork`/`execv`, `O_NONBLOCK`, `waitpid`) was **not executed on this machine**, so until the macOS arm64 CI job (which compiles and runs this same example) reports it, POSIX support is written but unmeasured |
| Unit pins | `unit: desktop/NativeProcess`: module shape (slot count, frame-boundary pump, non-blocking reads, `CREATE_NO_WINDOW`, POSIX `O_NONBLOCK`, error text constants, the `standardInput` flush point) plus the example's presence |
| `adl` evidence | `temp/npa/air/T.as` (shape), `NP.as`/`NP2.as` (errors and events), `Q.as` (command-line joining) |
| Regression | see the full-run row in `TODO.md` stage 391 |