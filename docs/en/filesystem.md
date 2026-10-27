# Filesystem (`flash.filesystem`) — measured semantics: trash, volume space and the symlink predicate

> This file records the **measured semantics** and the implementation choices for
> **`File.moveToTrash()` / `File.moveToTrashAsync()` / `File.spaceAvailable` /
> `File.isSymbolicLink`**
> (stage two hundred and forty-three, v0.4.207; `isSymbolicLink` at stage two hundred and
> sixty-two). They are the prerequisite for the
> macOS cleaner demo (see the workspace-root [`prune/mac-cleaner-demo-plan.md`](../../../prune/mac-cleaner-demo-plan.md),
> G1 / G2).
>
> **That plan left this repository on 2026-10-23** (the former `docs/projects/` directory was
> removed); it now lives in the workspace-root `prune/` (a sibling of `asaotui/`). The relative
> link `../../../prune/...` above therefore **resolves only inside the local workspace**;
> a standalone `as3compiler` clone will see it break (expected, not a defect).
>
> **Source of truth**: `adl 51.4.1` (macOS 26), through the two-ended probe in
> `temp/trashprobe/` (one `Main.as`, compiled with `mxmlc` and run by `adl`; the
> log goes to a file because `adl`'s stdout is not usable). Every "AIR does X"
> claim below has a probe behind it — **none is a restatement of the reference**,
> and two of them contradict it (§2.1, §5.1).
>
> Bottom line: **`moveToTrash` is `void`, not `Boolean`; and `spaceAvailable` is
> the AIR property name (`getSpaceAvailable` does not exist at all); and
> `isSymbolicLink` is the one `File` predicate that goes through `lstat`** — it does
> not follow the link. The trash
> directory is chosen per volume, and the name a colliding item gets is generated
> by macOS itself.

---

## 1. Coverage

| Member | Status | Note |
|---|---|---|
| `File.moveToTrash()` | ✅ implemented (macOS + freedesktop POSIX + the Windows Recycle Bin) | three backends, see §4; WASI/Emscripten has no trash concept and reports itself loudly (§7) |
| `File.moveToTrashAsync()` | ✅ implemented | delivery convention in §3 |
| `File.spaceAvailable` (property) | ✅ existed (stage sixty-four); semantics **corrected** here | answers only for a regular file or a directory (§5) |
| `File.isSymbolicLink` (property) | ✅ implemented (stage two hundred and sixty-two) | `lstat` / `FILE_ATTRIBUTE_REPARSE_POINT`; the one predicate that **does not** follow the link (§6) |
| `File.getSpaceAvailable` | ❌ **AIR has no such member** | not provided either (`in` is `false`, as on `adl`) |
| volume total / used | ❌ not done | G3 in the plan (an enhancement, no AIR counterpart), unscheduled |

---

## 2. `moveToTrash()` — measured

| Case | `adl 51.4.1` | Ours |
|---|---|---|
| a normal file | moved to the trash; **returns `undefined`** | same |
| a directory (with children) | the whole subtree moves | same (one atomic `rename`) |
| path does not exist | throws `Error #3003: File or directory does not exist.` | same (same id, same text) |
| parent directory not writable (EPERM) | throws `Error #2038: File I/O Error.` | same |
| `new File()` (no `nativePath`) | throws `Error #2037: Functions called in incorrect sequence, …` | same |
| after success | `nativePath` is **unchanged**, `exists` becomes `false` (the receiver is **not** rewritten to the trash path) | same |
| an item already inside the trash directory | a successful **no-op** (it stays put) | same |
| name collision (an item of that name is already trashed) | renamed to `original <HH-MM-SS-mmm><extension>`: `x.txt` → `x.txt 18-34-09-271.txt`, directory `dupsub` → `dupsub 18-37-21-029` | same shape (§2.2) |

### 2.1 First contradiction with the reference: the return type

The AIR reference declares `moveToTrash():Boolean`, but 51.4.1 behaves as **`void`**
at both ends:

```as3
var s:String = x.moveToTrash().toString();
// mxmlc: error: Call to a possibly undefined method toString through a reference with static type void.
trace(x.moveToTrash());              // adl: undefined (not false)
```

⇒ our `File_moveToTrash` is declared `void`. Do **not** "improve" it to return
`true`: `if (f.moveToTrash())` would then be constantly false on `adl` and
constantly true here — a silent semantic fork.

### 2.2 Second contradiction: the collision name

The reference says nothing beyond "moved to the trash". Measurement shows macOS
keeps **the whole original name (extension included), then a space, the local
`HH-MM-SS-mmm` time, then the extension again**:

- file `asprobe-…-same.txt` → `asprobe-…-same.txt 18-34-09-271.txt`
- directory `dupsub` → `dupsub 18-37-21-029` (no extension, so none is repeated)

`as_trash_target` reproduces that shape. A second collision within the same
millisecond appends `-<n>`; that fallback has **no measured counterpart** (two
collisions in one millisecond are negligible) and is chosen to not fail rather
than to be exact.

---

## 3. `moveToTrashAsync()` — events, not exceptions

| Case | `adl 51.4.1` | Ours |
|---|---|---|
| a normal file | returns immediately, later dispatches `Event.COMPLETE` (`target` is that `File`) | dispatches `COMPLETE` (timing below) |
| path does not exist | **does not throw**; dispatches `IOErrorEvent` with `errorID=3003`, `text="Error #3003: …"`, `bubbles=false`, `cancelable=false` | same (including `errorID`) |
| `new File()` | **throws** `#2037` synchronously, like the sync form | same |

**Timing**: AIR completes on its own IO thread and dispatches asynchronously
(measured: `exists` is still `true` right after the call). This build completes
inline and dispatches from the same call — the convention the remaining async
members of `File` follow here (`deleteFileAsync`, `deleteDirectoryAsync`).
`getDirectoryListingAsync` is the exception: it is genuinely async since stage 264 (§7).
The only ordering a caller may rely on — "register the listener first, then start" — holds at
both ends, but "the event is not there yet when the call returns" holds ONLY for
`getDirectoryListingAsync`.

---

## 4. Choosing the trash directory

| Platform | Directory | Basis |
|---|---|---|
| macOS | same volume as `$HOME`: `~/.Trash`; another volume: `<mount point>/.Trashes/<uid>` | measured: the item appears in `~/.Trash` (visible and restorable in Finder); `<volume>/.Trashes/<uid>` is the Finder / `NSFileManager` layout |
| Linux and other POSIX | `files/` + `info/` under `$XDG_DATA_HOME/Trash` (default `~/.local/share/Trash`), each payload paired with a `.trashinfo` (`Path=` percent-escaped + `DeletionDate=`) | the freedesktop.org Trash specification (**not verified on a real machine**; this host is macOS) |
| Windows | **the Recycle Bin**: `SHFileOperationW` + `FOF_ALLOWUNDO` — the same path Explorer's Delete takes (into `C:\$Recycle.Bin\<SID>\`, restorable from the Recycle Bin) | measured against `adl 51.4.1` **on Windows** (the two-ended probe in `temp/trashwin/`): a regular file, a **directory with its children**, and the async form all land in the Recycle Bin; the `$I` sidecar records the **original path** (UTF-16LE) and the `$R` payload reads back identical; the failure ids are the same `#3003`/`#2037` as on macOS. Windows has **no trash directory to rename into** (the Recycle Bin is shell-owned storage), so `as_trash_dir`'s `_WIN32` arm stays a `NULL` stub and `as_trash_move` routes to `as_trash_move_shell` ahead of it (path converted with `CP_ACP`, list **double-NUL** terminated — the same convention as every other ANSI call in the runtime); the link layer therefore adds `shell32` for Windows builds |
| WASI / Emscripten | no trash concept | loud report (`as_shell_unsupported`) + `#2038` |

"Same volume" is decided by comparing `st_dev` (`as_trash_dir`); the **mount
point of another volume** is found by walking up until `st_dev` changes
(`as_volume_root`) — POSIX has no portable "which mount am I on" call, and this
walk gives the right answer both under APFS firmlinks (`/Users` and `/` share a
`st_dev`) and for a genuinely separate volume (`/Volumes/Ext` versus `/Volumes`).

> **Known trade-off**: Finder's "Put Back" relies on metadata stored on the
> volume; we only `rename`. So **the item appears in the trash and can be moved
> back anywhere, but there is no one-click "Put Back" record**. That is the
> boundary of a plain-C implementation, stated up front rather than discovered by
> a user.

---

## 5. `spaceAvailable` — the property name and its scope

### 5.1 AIR's property is `spaceAvailable`, not `getSpaceAvailable`

The plan recorded G2 as "`getSpaceAvailable` has zero implementation"; **that
record is wrong**. On AIR's `File`:

```as3
("getSpaceAvailable" in f)   // adl: false
f["getSpaceAvailable"]       // adl: ReferenceError #1069
```

while `f.spaceAvailable` has been implemented here since stage sixty-four (a real
`statvfs` / `GetDiskFreeSpaceExA` query). This stage therefore adds **no member**;
it corrects the semantics.

### 5.2 Measured values

| Path | `adl 51.4.1` | Ours |
|---|---|---|
| `File.userDirectory` / a directory | the volume's free bytes (measured `14487470080`; the same order as `df -k`, drifting second by second) | same (`statvfs.f_bavail × f_frsize`) |
| a regular file | **the same number** (its volume's) | same (added here: files answer too) |
| a path that does not exist | `0` | same (`statvfs` fails) |
| a character device (`/dev/null`) | `0` | same (`stat` first; only a **regular file or a directory** answers) |
| `/Volumes/Nope` (absent) | `0` | same |
| `new File()` (no path) | throws `#2037` | returns `0` — see the note |

> Note: `new File().spaceAvailable` throws `#2037` on `adl`, while our
> `File_get_spaceAvailable` returns `0` for `nativePath == NULL` (as it has since
> stage sixty-four). **This is not specific to `spaceAvailable`**: on 51.4.1 every
> member of an empty `File` throws `#2037` — including the `nativePath` getter
> itself, which here is a plain field. The family gap is wider than this member
> and needs `nativePath` to become an accessor, so it is registered in `TODO.md`
> (`遗留待开发`) instead of being half-fixed here. The two new members do throw
> `#2037` (measured, §2).

---

## 6. `isSymbolicLink` — the one `File` predicate that does not follow the link

**This one was not copied out of the reference; a real product forced it.** `prune`
(the macOS cache cleaner in the workspace root) sizes `~/Library/Caches` recursively with
`getDirectoryListing()` + `isDirectory` and put **124 GB** on the panel where `du` says
**7.6 GB** — a 16× error. The directory holds a WeChat Sparkle installer whose
`WeChatAppEx.app` carries a chain of `.framework/Versions/Current` and
`.framework/Resources` entries — **all symlinks into sibling directories**, so the same
bytes were counted again at every level. `du` does not follow symlinks by default; we
did, and `File` had no member that could even ask whether a path is a link.

The root cause is that `File`'s predicates come in two families, and mixing them
produces a wrong magnitude:

| Predicate | Follows the link? | Answers about |
|---|---|---|
| `exists` / `isDirectory` / `size` / `spaceAvailable` | yes (`stat()`) | the **target** |
| `isSymbolicLink` | **no (`lstat()`)** | the **link itself** |

So for a symlink to a directory, `isDirectory` and `isSymbolicLink` are **both true**;
for a dangling link `exists == false` while `isSymbolicLink == true`; and deleting it
removes the link, not the target (AIR says exactly that).

### 6.1 Measured on `adl 51.4.1` (probe `temp/symprobe/`)

One side `mxmlc` + `adl`, the other this project's AOT, from the same input (a `fx/`
tree holding a real directory, a real file, a link to a directory, a link to a file, a
dangling link and a cyclic link):

| Input | `exists` | `isDirectory` | `isSymbolicLink` |
|---|---|---|---|
| real directory | true | true | false |
| real file | true | false | false |
| link → directory | true | **true** | **true** |
| link → file | true | false | **true** |
| dangling link | **false** | false | **true** |
| non-existent path | false | false | false |
| `/` (volume root) | true | true | false |
| `new File()` (empty) | **throws `#2037`** | same | same |

**10/10 agree across the two runtimes** (except the empty-`File` row, §6.2).
Implementation: POSIX uses `lstat()` + `S_ISLNK`; Windows uses
`GetFileAttributesA()`'s `FILE_ATTRIBUTE_REPARSE_POINT` (AIR reports `true` for an NTFS
junction too, which that bit covers, whereas MSVC's `_stat` cannot see reparse points).

### 6.2 What else the probe turned up is an EXISTING gap, not a new one

The `#2037` of an empty `File` (`new File()`) holds for `isSymbolicLink` as well, so it
folds into the `遗留待开发` row that already exists — the whole empty-`File` family fails
to throw `#2037` — and **does not open a new one**: that family fix is to turn
`nativePath` from a field into an accessor, which is unrelated to this member.

### 6.3 How a recursive walk should use it

`isSymbolicLink` is a **traversal boundary condition**, not decoration. Without it the
same subtree is counted again at every level, the node budget is spent on one target,
and the report carries the **wrong magnitude** (on this machine `~/Library/Caches`
inflated from 7.6 GB to 124 GB, and no later target was reached at all). The product-side
rule is **ask first, then decide whether to descend**.

One honest detail: **the depth cannot grow without bound** — macOS's own ELOOP ceiling
(32 links) cuts a cyclic path off, so "a walk that follows links will hang" is false.
**Double counting is the real damage**: the fixture in `examples/file-symlink.as` is a
tree of **4 real nodes / 8 bytes** (plus 4 links, one of them pointing back at an
ancestor), and a walk that follows links was measured visiting **264 nodes** — cut off by
the kernel, not by any cap of ours. That is the nastier half: it finishes quickly and the
number is simply wrong.

---

## 7. Directory listings — two contracts, sync and async (stage 264)

`getDirectoryListing()` and `getDirectoryListingAsync()` are **not the same semantics written two
ways**: for the same input one throws and the other completes. Every row below was measured against
`adl 51.4.1` (probes in `temp/listingprobe/` and `temp/dirasync/`) and is reproduced here; the
example [`examples/file-listing-async.as`](../examples/file-listing-async.as) pins them as assertions.

### 7.1 The async member is genuinely async (it used to be a synchronous fake)

On `adl` it enumerates on its **own IO thread** and dispatches
`FileListEvent.DIRECTORY_LISTING` **later**:

| Observation | `adl 51.4.1` | This build |
|---|---|---|
| **Call duration** for a 20,000-entry directory | **0 ms** (the event lands ~**10.6 s** later) | same (enumeration runs in the `AS_JOB_DIR` job) |
| A listener registered **after** the call | still fires | same |
| Event shape | `type=directoryListing`, `files=File[]`, `bubbles=false`, `cancelable=false`, `target` is the `File` | same |
| Path does not exist | dispatches `IOErrorEvent`: `errorID=3003` + `"Error #3003: File or directory does not exist."` (**no throw**) | same |
| Path exists but is **not a directory** | **completes normally, empty `files`, no error** | same |
| Directory is **unreadable** (EACCES) | **completes normally, empty, no error** | same |
| `cancel()` | **really cancels**: no event ever | same |
| Second call while one is in flight | **throws `#2037`**, and the first one still completes | same |
| Empty `File` (`new File()`) | **throws `#2037` synchronously** | same |
| Arrival order | the **same order as the sync member** (raw directory order; **neither sorts**) | same |

> Before stage 264 this build was a **synchronous fake** — `getDirectoryListing()` plus a dispatch
> from the same call — so the calling thread paid for the whole walk and `File.cancel()` was
> permanently a no-op. That is §1.5's "`adl` gets it right and we cannot" ⇒ a **legacy defect**,
> fixed in stage 264 (`AS_JOB_DIR` job + finish thunk + a real `cancel`).

### 7.2 The sync member throws on three odd inputs, and deliberately does not share code

| Input | `getDirectoryListing()` | `getDirectoryListingAsync()` |
|---|---|---|
| Empty `File` | throws `#2037` | throws `#2037` (same id, same text) |
| Path does not exist | throws `#3003` | dispatches `ioError #3003`, **no throw** |
| Exists, not a directory | throws **`#3007: Not a directory.`** | **completes with an empty listing, no error** |
| Directory unreadable (EACCES) | **empty, no throw** | **completes with an empty listing, no error** |

The last row is the only odd shape where **neither throws**, and it is the one a cleaner meets most:
a permission denial is **not** a failure, it is an empty directory. Treating it as a failure inflates
the "skipped" count; treating it as success is what `adl` does.

### 7.3 The `FileListEvent` surface (measured along the way)

`describeType(INSTANCE)` says: `extends=flash.events::Event`, the only instance **var is `files`**;
there is **no `directory` and no `index`**. This build's shell over-declares a fourth parameter
(`directory`) — a registered divergence (the arity row in `遗留待开发`) — so the finish thunk still
passes the receiver there and keeps `files` in `adl`'s position.

---

## 8. What is not done (on the record)

- **The WASI / Emscripten trash**: no counterpart API, so the call reports itself
  loudly and throws `#2038`. A browser has no recycle-bin concept at all, which makes
  the loud report the end state there (no fake backend). The Windows Recycle Bin
  backend landed at stage 244 (§4).
- **Finder "Put Back" metadata**: see the trade-off in §4.
- **Cross-volume moves**: the target directory is chosen per volume
  (`as_trash_dir`), so `rename` never crosses one; a genuine cross-volume case
  throws `#2038` rather than "copy + delete", which would appear to hang at demo
  scale and has more failure points.
- **Volume total / used** (plan G3): not done.
- **`#2037` for the whole empty-`File` family**: see §5.2.
- **Delivery timing of the other three async members**: see §3 (still inline, on the record).

---

## 9. Reproduce

```sh
# the adl contract for directory listings (probes in temp/listingprobe/ and temp/dirasync/)
cd temp/dirasync && "$AIRSDK_HOME/bin/mxmlc" -load-config="$AIRSDK_HOME/frameworks/air-config.xml" \
  -output Probe4.swf Probe4.as && "$AIRSDK_HOME/bin/adl" app4.xml

# AOT side (test/examples.ts builds the fixture; noread/ is chmod 000)
node --test --test-name-pattern='file-listing-async' test/examples.ts
```

## 10. An earlier stage's adl reproduction (the trash)

```sh
# adl side (probe in temp/trashprobe/, log to adl_log*.txt; adl's stdout is unusable)
cd temp/trashprobe && "$AIRSDK_HOME/bin/mxmlc" -debug=true -output Main.swf Main.as
"$AIRSDK_HOME/bin/adl" app.xml

# AOT side (point HOME at a scratch dir; do not use the developer's own trash as a lab)
mkdir -p temp/trash-home && HOME=$PWD/temp/trash-home \
  node src/index.ts examples/move-to-trash.as -o temp/regress-out/mvtrash --run

# the pure-C helpers on their own (including the freedesktop branch: -U__APPLE__ takes the #else)
cd temp/trashprobe && cc -O1 -Wall -Wextra -o trash_impl trash_impl.c && HOME=/tmp/x ./trash_impl
```

Pins: `unit: emit/FileMoveToTrash` (17 source-level checks);
`unit: emit/FileIsSymbolicLink` (7 source-level checks);
`unit: emit/DirListingAsync` (17 source-level checks);
`examples/move-to-trash.as`, `examples/file-symlink.as` and `examples/file-listing-async.as`
(runtime; `EXAMPLE_ENV` in `test/examples.ts` points `HOME` at `temp/trash-home`,
`temp/sym-home` and `temp/listing-home` respectively so the suite never fills the developer's
trash — both fixture trees are built with `node:fs` by that same file, and `listing-home`'s
`noread/` directory has its `chmod 000` restored when the suite ends).
---

## 11. `File.url` is a URL, not a path (stage two hundred and eighty-four)

> Source of truth: `adl 51.4.1` (Windows 10 26200), dual-side probe in `temp/urlprobe/`.
> The same `UrlProbeTop.as` runs under `mxmlc`+`adl` and under our AOT; both write a log file
> (`adl`'s stdout is unusable). The AIR side lands in
> `%APPDATA%/probe.url/Local Store/urlprobe-result.txt`, ours in the same file inside the app
> storage directory. **Every row below is measured**, not transcribed from the reference.

### 11.1 The measured shapes

| Expression | `adl 51.4.1` | Ours (after the fix) |
|---|---|---|
| `File.applicationStorageDirectory.url` | `app-storage:/` | same |
| `File.applicationDirectory.url` | `app:/` | same |
| `.url` of `<storage>/urlprobe/plain.png` | `app-storage:/urlprobe/plain.png` | same |
| `.url` of `<storage>/a b/中文 name.png` | `app-storage:/a%20b/%E4%B8%AD%E6%96%87%20name.png` | same |
| `File.documentsDirectory.url` | `file:///C:/Users/<u>/Documents` | same |
| `new File(<that url>).nativePath` | the native path (backslashes) | same |
| `Loader.load(<that url>)` | `COMPLETE`, `content` is a `Bitmap` | same |
| `new File("relative.txt")` | throws `Error #2004` | **keeps the string** (§11.5) |

**Encoding rule** (measured per character): the path part uses `encodeURIComponent`'s safe set
plus exactly two characters — `/` (separators, kept) and `:` (the drive letter, kept). Measured
as encoded: space `%20`, `#` `?` `&` `%` `+` `[` `]` `@` `$` `,` `;` `=` `^` `{` `}`
`|` `<` `>` `"`, and the UTF-8 triplet of every non-ASCII byte. Measured as left alone:
letters, digits, `- _ . ! ~ * ' ( )`.

**The spelling of nativePath**: AIR uses the host OS's own form — all backslashes on Windows.
`as_path_join` used to emit `/` unconditionally, so an absolute path came out mixed
(`C:\Users\u\AppData\Roaming/as3aot/Local Store`) and "url → `new File(url).nativePath`" did
not equal the path it came from. It now goes through `as_path_norm()` (Windows turns `/` into
`\`; every other platform returns the string untouched) — one choke point, which also makes
the old in-place separator swap the `FindFirstFile` branch needed redundant.

### 11.2 The pre-fix shape was the bug

`File_get_url` returned `"file://" + nativePath`, i.e.

```
file://C:\Users\rayle\AppData\Roaming/cn.edoctor.windows.meeting.talkmed/Local Store/assets/cache//<hash>/x.png
```

(backslashes, no encoding, and a doubled `//`), and that string was then `fopen`'d **as a literal
path**:

- `Loader.load(that url)` → `IOError #2035 URL Not Found` even though the file existed;
- the same file loaded by `nativePath` reached the decoder (a pure-C build reports `#2124`, a
  Skia build produces the bitmap).

So the whole family of "download into `applicationStorageDirectory`, then display by
`File.url`" usages came out blank. On the real machine that is **TalkMED's gift list**: the JSON's
`small_img` is downloaded by `DownLoader` into the storage directory and
`cn.edoctor.controls.Image` calls `loader.load(download.targetFile['url'])` — every gift icon was
left as bare title text.

The fix is not "strip the scheme once more, in the Loader" but **one mapping, in one place**:

| Site | Before | Now |
|---|---|---|
| `File_get_url` | `"file://" + nativePath` | the two app roots become their own schemes (`app-storage:` / `app:`), everything else `file:///` + percent-encoded path |
| `File_ctor` | stored verbatim | accepts a URL: `file://` / `app-storage:` / `app:` are decoded back to a native path |
| `URLLoader_load` (shared with `Loader.load`) | `if (strncmp(path,"file://",7)==0) path += 7;` | `as_local_path_from_url(url)` |
| `Sound_load` | same | same |
| the image job (`as_async_submit_image`) | `fopen`'d the string as a path | http/https stays on the transport, everything else goes through `as_local_path_from_url` first |

`as_local_path_from_url()` is the single scheme→path conversion: `app-storage:/x` and `app:/x`
are joined back onto their root, the third slash of `file:///C:/x` belongs to the URL rather than
the path, and any other string (an absolute or relative native path) passes through unchanged. It
is defined on the `File` side (it needs both roots); the image job in `runtime.ts` uses it through
a forward declaration.

### 11.3 Why the roots are not cached

`as_app_storage_dir()` is asked again on every read instead of being cached in a `static`: it
returns a **GC string**, and a plain C static is not a GC root — a cached prefix could be freed by
the collector, leaving the next comparison reading dangling memory.

### 11.4 Reproduce

```sh
# adl side (the result lands in %APPDATA%/probe.url/Local Store/urlprobe-result.txt)
node temp/urlprobe/run-air.cjs

# AOT side (the Skia manifest, otherwise there is no decoder and it stops at #2124)
PATH="$PWD/temp/ccbin:$PATH" node src/index.ts temp/urlprobe/UrlProbeTop.as \
  -o temp/urlprobe/UrlProbeSkia.exe --manifest temp/urlprobe/win.build.json
temp/urlprobe/UrlProbeSkia.exe
```

Both sides must print `COMPLETE content=[object Bitmap] w=8` for all three `load(...)` lines.

**Pins**: `examples/file-url.as` (the shapes, the encoding, the round-trip, reading a real file
through the URL, and the deviation in §11.5); `unit: file-url/mapping` + `unit: file-url/preamble`
(16 source-level checks, of which "no `path += 7` survives" is the anti-drift one).

### 11.5 The one remaining deviation: a relative path

AIR rejects a relative path in the constructor (`#2004`). We keep the string (`stage64.as` has
pinned `new File("temp/x.txt").nativePath == "temp/x.txt"` since stage sixty-four), so such a
`File`'s `url` is `file://` + the path. AIR cannot construct that object at all, so this is the
"AIR has no counterpart" kind rather than a rewrite of defined AIR behaviour; it is asserted
explicitly in `examples/file-url.as` so it stays a decision rather than an accident.


---

## 12. Deletion / move / `size` / path normalisation — batch A (stage 298)

After stage 290 (the `ContextMenu` Windows round) the `File` family got a **member-by-member** gap
audit (`temp/fileaudit/matrix.sh`: one compile probe per member, measuring "does it exist";
`temp/fileaudit/adl/Fp.as` + `out.txt` and `Av.as`/`Av2.as`/`Av3.as` + `av*.txt`, measuring "is it
right"). The audit was split into batches A/B/C by cost; this section is **batch A** (low cost,
the divergences real code trips over). Batch B (`FileStream`'s full `IDataInput`/`IDataOutput`
surface) and batch C (new capability: `copyTo`/`canonicalize`/`getRelativePath`/`FileReference`/
`StorageVolume`) are **not done** and are registered one by one in `TODO.md` → `### 遗留待开发`.

### 12.1 The error table (synchronous members, measured on `adl 51.4.1` / macOS 26)

| Call | Measured result |
|---|---|
| `deleteFile()`, path missing | `Error #3003: File or directory does not exist.` |
| `deleteFile()`, target is a **real directory** | `Error #3006: Not a file.` (the directory stays) |
| `deleteFile()`, entry inside a refused parent | `Error #3001: File or directory access denied.` |
| `deleteDirectory()`, path missing | `#3003` |
| `deleteDirectory()`, target is a file | `Error #3007: Not a directory.` |
| `deleteDirectory(false)`, directory not empty | `Error #3010: Directory is not empty.` (it stays) |
| `deleteDirectory(true)`, target is a **file** | **succeeds** — `recursive` means "recurse", not "must be a directory" |
| `deleteDirectory(true)`, refused | `Error #2038: File I/O Error.` |
| `moveTo(dest)`, source missing | `#3003` |
| `moveTo(dest, false)`, `dest` exists | `Error #3012: Cannot delete file or directory.` (target untouched) |
| `moveTo(null)` | `TypeError #2007`, message **`Error #2007: Parameter destination must be non-null.`** |
| `moveTo`, parent of the destination missing | **created** (`mkdir -p` semantics) |
| `moveTo` after success | **`nativePath` unchanged** (still the old location, `exists` turns `false`) — measured twice |
| `moveTo` onto a directory | with `overwrite=true` the whole directory is replaced by the file |
| any of the above on an empty `File` (`new File(null)`) | `#2037` |
| `size`, path missing | `#3003` (**the old implementation returned 0 — that was wrong**, the comment claiming otherwise is gone) |
| `size`, directory | **`0`** (not `st_size`) |
| `size`, dangling symlink | `#3003` |

**Symlinks**: `deleteFile`/`deleteDirectory`/`moveTo` move only the **link**, the target survives;
a **dangling** link can be deleted; `deleteDirectory(link→dir, true)` deletes the link and does
**not** recurse into the target. So the existence probe for a delete must be **`lstat`**
(`as_path_exists_l`), never `stat` — otherwise "link to a directory" takes the recursive branch and
deletes the target tree. Windows uses `GetFileAttributesA` (which does not follow reparse points).

**Single implementation**: the three synchronous members share `as_file_delete_err(o, isDir,
recursive)` and the asynchronous ones reuse the same result through `File__deleteDispatch` — the
`errorID` is **identical** to the synchronous throw (`deleteFileAsync(dir)`=3006,
`deleteDirectoryAsync(false)` non-empty=3010, missing=3003); success dispatches `COMPLETE`, and
`#2037` still **throws synchronously**. That shared path is the bug batch A started from:
`deleteDirectoryAsync(true)` used to dispatch `COMPLETE` without deleting anything.

**Still missing**: a cross-volume `moveTo` fails in `rename` and then says so loudly
("a cross-volume move is not implemented") instead of silently doing nothing or quietly
substituting copy+delete.

### 12.2 Path normalisation is LEXICAL, on both platforms

Measured (`av.txt`, groups `E*`/`F*`/`G*`):

| Input | `nativePath` |
|---|---|
| `/tmp//a/../b` | `/tmp/b` |
| `/tmp/a/./b/` | `/tmp/a/b` (trailing separator dropped) |
| `/tmp/a/../../..` | `/` (**clamped at the root**, never `/..`) |
| `//tmp` | `/tmp` |
| `/tmp/a\b` (POSIX) | `/tmp/a\b` — a backslash is a legal filename **byte**, not a separator |

`resolvePath` uses the same rules plus two more: an **absolute argument replaces the base**
(`"/tmp/z.txt"`.resolvePath(`"/abs/./q"`) = `/abs/q`), `""`/`"."` return the base itself, and
`"~/x"` is **not** expanded (the base name `~` is copied verbatim). On Windows `as_path_norm` has
extra drive/UNC/device-path branches (`\\?\`, `\\.\`), and a **device path passes through
untouched** (its prefix is meaningful and must not be folded).

There is no `url` setter (AIR has none either), but `nativePath` gained a real **setter** in this
batch, with the measured rules: relative path / empty string / URL form ⇒ `#2004`, `null` ⇒
`#2007` (message with the same **double space** as `moveTo`: `Error #2007: Parameter  must be
non-null.` — the parameter name is the empty string). The **constructor still accepts a relative
path** (the pre-existing deviation in §11.5), so the rejection applies to the setter only.

### 12.3 Reproduce

```sh
# adl side (probes in temp/fileaudit/adl/, logs written to absolute-path av*.txt — adl prints nothing on stdout)
#   run Av.as / Av2.as / Av3.as / Aw.as through mxmlc + adl

# AOT side (the same cases in script form; the log goes to stdout)
node src/index.ts temp/fileaudit/aot/probe.as  -o temp/fileaudit/aot/probe  --run
node src/index.ts temp/fileaudit/aot/probe2.as -o temp/fileaudit/aot/probe2 --run
```

Both sides agree line for line (`probe.as` covers groups E/F/G/A/B/C/D, `probe2.as` covers the
symlink K/N groups and the permission L group; fixtures are built by the shell, the L group needs
`chmod 0555`). **Pins**: `examples/file-ops.as` (turns the tables above into assertions;
`test/examples.ts` gives it a `HOME` fixture with an `fx/` subtree containing both a `linkdir` and
a `dangle` link); `unit: file-ops/contract` (30 source-level structural checks: `moveTo` takes two
parameters, sync and async share `as_file_delete_err`, `COMPLETE` is dispatched only when
`err == 0`, `#3010` comes from `ENOTEMPTY`, `lstat` rather than `stat`, and `moveTo` does not
rewrite `nativePath`).
