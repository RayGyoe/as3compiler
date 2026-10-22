# Filesystem (`flash.filesystem`) — measured semantics: trash and volume space

> This file records the **measured semantics** and the implementation choices for
> **`File.moveToTrash()` / `File.moveToTrashAsync()` / `File.spaceAvailable`**
> (stage two hundred and forty-three, v0.4.207). They are the prerequisite for the
> macOS cleaner demo (see [`projects/mac-cleaner-demo-plan.md`](projects/mac-cleaner-demo-plan.md),
> G1 / G2).
>
> **Source of truth**: `adl 51.4.1` (macOS 26), through the two-ended probe in
> `temp/trashprobe/` (one `Main.as`, compiled with `mxmlc` and run by `adl`; the
> log goes to a file because `adl`'s stdout is not usable). Every "AIR does X"
> claim below has a probe behind it — **none is a restatement of the reference**,
> and two of them contradict it (§2.1, §5.1).
>
> Bottom line: **`moveToTrash` is `void`, not `Boolean`; and `spaceAvailable` is
> the AIR property name (`getSpaceAvailable` does not exist at all)**. The trash
> directory is chosen per volume, and the name a colliding item gets is generated
> by macOS itself.

---

## 1. Coverage

| Member | Status | Note |
|---|---|---|
| `File.moveToTrash()` | ✅ implemented (macOS + freedesktop POSIX) | no Windows backend; reports itself loudly (§6) |
| `File.moveToTrashAsync()` | ✅ implemented | delivery convention in §3 |
| `File.spaceAvailable` (property) | ✅ existed (stage sixty-four); semantics **corrected** here | answers only for a regular file or a directory (§5) |
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
inline and dispatches from the same call — the convention every other async
member of `File` follows here (`getDirectoryListingAsync`, `deleteFileAsync`,
`deleteDirectoryAsync`). The only ordering a caller may rely on — "register the
listener first, then start" — holds at both ends.

---

## 4. Choosing the trash directory

| Platform | Directory | Basis |
|---|---|---|
| macOS | same volume as `$HOME`: `~/.Trash`; another volume: `<mount point>/.Trashes/<uid>` | measured: the item appears in `~/.Trash` (visible and restorable in Finder); `<volume>/.Trashes/<uid>` is the Finder / `NSFileManager` layout |
| Linux and other POSIX | `files/` + `info/` under `$XDG_DATA_HOME/Trash` (default `~/.local/share/Trash`), each payload paired with a `.trashinfo` (`Path=` percent-escaped + `DeletionDate=`) | the freedesktop.org Trash specification (**not verified on a real machine**; this host is macOS) |
| Windows | **not implemented** | needs `SHFileOperation`/`IFileOperation` to reach the Recycle Bin; this round does not add an unverifiable branch that also changes link libraries — it reports itself loudly (`as_shell_unsupported`) and throws `#2038`, and the gap is registered in `TODO.md` under `遗留待开发` |
| WASI / Emscripten | no trash concept | same (loud report + `#2038`) |

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

## 6. What is not done (on the record)

- **Windows Recycle Bin backend**: unimplemented; the call reports itself loudly
  and throws `#2038` (a row in `TODO.md` `遗留待开发`).
- **Finder "Put Back" metadata**: see the trade-off in §4.
- **Cross-volume moves**: the target directory is chosen per volume
  (`as_trash_dir`), so `rename` never crosses one; a genuine cross-volume case
  throws `#2038` rather than "copy + delete", which would appear to hang at demo
  scale and has more failure points.
- **Volume total / used** (plan G3): not done.
- **`#2037` for the whole empty-`File` family**: see §5.2.

---

## 7. Reproduce

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
`examples/move-to-trash.as` (runtime; `EXAMPLE_ENV` in `test/examples.ts` points
`HOME` at `temp/trash-home` so the suite never fills the developer's trash).