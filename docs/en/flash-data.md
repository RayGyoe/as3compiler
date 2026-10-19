# Local SQL Database (`flash.data` / SQLite) Support Roadmap Assessment

> This document answers one question: **to support AS3's `flash.data` local SQL database (SQLite), should we
> link an open-source SQLite framework, or self-build an engine?**
>
> **Conclusion up front:**
>
> 1. **The engine cannot be self-built — link the official SQLite source (amalgamation).** This is not a
>    preference; it is **locked down** by measurement: AIR's **plaintext** database *is* a **standard SQLite
>    file** (the host `sqlite3` CLI runs `PRAGMA integrity_check` returning `ok` and can `SELECT` rows back).
>    AIR's real semantics **are SQLite itself**; self-building means deliberately diverging in a domain that has
>    an authoritative reference.
> 2. **Encryption is the one real fork, and it is a dead end that is "pure self-build".** AIR's encrypted
>    database = a private layout of **AES-CCM + a 16-byte raw key + 32 reserved bytes per page**; **SQLCipher**
>    is AES-256-CBC + HMAC + PBKDF2 + a plaintext salt. The two are **incompatible on all three axes** — key
>    derivation / cipher algorithm / file layout — so switching to SQLCipher gets you **neither** AIR
>    compatibility **nor** the ability to read a database AIR wrote. Encryption therefore **does not switch
>    engines**; it is "not done / a standalone project".
> 3. **The AS3 API layer (`SQLConnection` / `SQLStatement` / …) has to be hand-written regardless**, orthogonal
>    to the engine choice. That is the bulk of the work, but it is **far smaller than it looks**: the target app
>    really uses only **4** entry points (§4.2).
> 4. **There are two prerequisites unrelated to SQLite before landing** (§4.3). One of them is **our own
>    semantic defect**: static **getter** dispatch through a `Class` value returns normally in `adl` but throws
>    a **bare `Error id=0`** for us — it makes `Application.NativeApplication` `null`, so the target app's
>    SQLite branch **is never even entered**. Without fixing this, any amount of SQLite code is unreachable.
> 5. **Per `AGENTS.md` §1.5, an encrypted database must "fail loudly" rather than silently degrade**: if the
>    caller passes a key, we report "this build does not support encrypted databases" — we **never** pretend to
>    encrypt and **never** silently fall back to writing a plaintext database.
>
> Every piece of AIR runtime ground truth in this document comes from **measured `adl 51.4.1` probes** (in this
> repo under `temp/adlprobe/`, including byte-level evidence of the SQLite lifecycle and file header); the API
> list is taken item by item from the AIR SDK official language reference; the project's current state is
> **verified item by item via grep**, not a paraphrase of documentation or speculation.

---

## 1. What this requirement is and why it was raised

`flash.data` is AS3/AIR's **local SQL database package** — the AIR runtime has a SQLite engine built in, and an
app can create/open `.db` files, execute SQL, and read result sets. It is the most common **persistence**
mechanism for AIR desktop apps.

It came up while migrating the real AIR app `acme-app-desktop`:

- The app does **not** use `flash.data` directly; it goes through a **home-grown wrapper**
  `com.example.air.data.{SQLConnect, SQLStartment}`
  (`/Users/<user>/Documents/AcmeLib/`).
- The wrapper uses **`getDefinitionByName` to resolve `flash.data` / `flash.events` dynamically**
  (`SQLConnect.as:73-76`, `SQLStartment.as:59-61`); there is **not a single `import flash.data` anywhere in the
  sources**.
- So "no `flash.data` support" shows up on our artifacts as a **silent degradation**: `getDefinitionByName`
  throws `ReferenceError #1065`, the wrapper's `try/catch` swallows it, and the database feature **quietly
  disappears** while the process does not crash — exactly the class of failure `AGENTS.md` most abhors.

> Verdict attribution (`AGENTS.md` §1.5): `adl` runs it correctly and we cannot ⇒ **a leftover defect** (goes
> into `TODO.md` `### 遗留待开发`), not an "enhancement". `flash.data` is such a case and has been registered as
> such (end of §6).

---

## 2. The official API in full

Authoritative source: [the AS3 Language Reference `flash.data` package](https://airsdk.dev/reference/actionscript/3.0/flash/data/package-detail.html).
The package has **16 classes**:

| Class | Role |
|---|---|
| `SQLConnection` | Open/manage a connection to a local database file (transactions, compaction, schema operations) |
| `SQLStatement` | Execute one SQL statement on an already-open connection |
| `SQLResult` | The result of one statement execution (`data` / `rowsAffected` / `complete`) |
| `SQLMode` | `openMode` constants (`CREATE` / `READ` / `UPDATE`) |
| `SQLColumnNameStyle` | `columnNameStyle` constants (the naming style of result-row keys) |
| `SQLCollationType` | Collation constants |
| `SQLTransactionLockType` | Lock-type constants for `begin()` |
| `SQLSchema` | Base class for schema information |
| `SQLTableSchema` / `SQLViewSchema` / `SQLIndexSchema` / `SQLTriggerSchema` | The various schema objects |
| `SQLColumnSchema` | Column schema |
| `SQLSchemaResult` | The result of `loadSchema()` |
| `EncryptedLocalStore` | Encrypted local store (ELS) — a **separate mechanism**, see §3.3/§4.2 |

Plus two **event classes** and one **error class** (different packages):

| Class | Package |
|---|---|
| `SQLEvent` | `flash.events` (`OPEN` / `CLOSE` / `RESULT` / `BEGIN` / `COMMIT` / `ROLLBACK` / `ANALYZE` / `COMPACT` / `DEANALYZE` / `REENCRYPT`) |
| `SQLErrorEvent` | `flash.events` (`ERROR`, `.error` holds a `SQLError`) |
| `SQLError` | `flash.errors` (**already a built-in for us**, see §4.1) |

This repo's `TODO.md` long ago recorded `SQLConnection` / `SQLStatement` as "depends on SQLite linking,
deferred" — this document exists to fix the selection and scope of that "deferred".

---

## 3. Measured AIR runtime ground truth (oracle)

Probe: `temp/adlprobe/` (`Main.as` + `Holder.as` + `app.xml` + `run_adl.sh`, output archived in `adl.txt`).
Two kinds of evidence: **(a) reflection/lifecycle** (running inside `adl 51.4.1`), **(b) byte-level file
header** (host `xxd` + `sqlite3`).

> Probe project caveat: `adl` produces **no stdout** in this machine's shell context; the only reliable signal
> is a **result file** (`FileMode.APPEND` + an `END-OF-SCENE` sentinel + `<visible>false</visible>` + run in the
> background + bounded polling + a watchdog kill). Also, classes referenced by `getDefinitionByName` **by
> string** are not linked into the SWF by `mxmlc`, so you must write one line `private var keep:Class = Holder;`
> to **force linking**, otherwise `adl` throws `#1065` (that is how the first probe failed).

### 3.1 Class existence (`getDefinitionByName`, all hits)

```
flash.data.SQLConnection        -> flash.data::SQLConnection
flash.data.SQLStatement         -> flash.data::SQLStatement
flash.data.SQLMode              -> flash.data::SQLMode
flash.data.SQLResult            -> flash.data::SQLResult
flash.data.SQLColumnNameStyle   -> flash.data::SQLColumnNameStyle
flash.data.SQLColumnSchema      -> flash.data::SQLColumnSchema
flash.data.SQLSchemaResult      -> flash.data::SQLSchemaResult
flash.data.EncryptedLocalStore  -> flash.data::EncryptedLocalStore
flash.events.SQLEvent           -> flash.events::SQLEvent
flash.events.SQLErrorEvent      -> flash.events::SQLErrorEvent
flash.errors.SQLError           -> flash.errors::SQLError
```

### 3.2 API surface (`describeType`)

`SQLConnection` has exactly **10** accessors (note: there is **no `encrypted` property** — consistent with the
docs; the `#1069` in our early probe was **correct**, not a defect):

```
isSupported[r/o]  autoCompact[r/o]  cacheSize  pageSize[r/o]  columnNameStyle
inTransaction[r/o]  totalChanges[r/o]  lastInsertRowID[r/o]  connected[r/o]  prototype[r/o]
```

Methods include `open` / `openAsync` / `close` / `begin` / `commit` / `rollback` / `compact` / `analyze` /
`deanalyze` / `loadSchema` / `getSchemaResult` / `setSavepoint` / `releaseSavepoint` / `rollbackToSavepoint` /
`attach` / `detach` / `reencrypt` / `cancel`.

`SQLStatement` has **5** accessors: `parameters:Object`, `sqlConnection:SQLConnection`, `itemClass:Class`,
`text:String`, `executing:Boolean[r/o]` (plus `execute` / `next` / `cancel` …).

### 3.3 Encryption semantics (**the fork point**)

- Official docs ([`SQLConnection`](https://airsdk.dev/reference/actionscript/3.0/flash/data/SQLConnection.html)):
  encryption uses **AES + CCM**, and the key must be a **16-byte `ByteArray`**.
- Measured: with `writeUTFBytes("<redacted-16ch>")` (16 characters) as the key, `encryptionKey.length` is
  **exactly 16**.
- **`open(..., SQLMode.READ, ..., pageSize)` throws `ArgumentError #3139`**
  (`Error #3139: The page size specified was not valid for this operation.`) — matching the docs' "`pageSize` is
  only valid for CREATE"; **re-opening with a key also throws `#3139`**, i.e. reopening the same database
  requires a `close` first.
- `SQLConnection` **exposes no read-only "is the database encrypted" property** (see §3.2) — whether it is
  encrypted can only be known by the caller.

### 3.4 Plaintext DB = standard SQLite; encrypted DB = private format (**decisive evidence**)

Same run, same code, differing only by a key:

| | Plaintext (no key) | Encrypted (with key) |
|---|---|---|
| File size | `12288` B | `12288` B |
| First 16 bytes | `53 51 4c 69 74 65 20 66 6f 72 6d 61 74 20 33 00` = **`SQLite format 3\0`** | `8d 07 7d 29 18 4d 2e 21 9f 02 8c af ac 06 56 18` = **ciphertext** |
| Host `sqlite3` | `PRAGMA integrity_check` → **`ok`**; `SELECT * FROM t` → **`1\|MARKER_plain_123`** | `Error: in prepare, file is not a database (26)` (exit 26) |

⇒ **A plaintext database is a standard SQLite file** (third-party tools can read/write it directly), and **an
encrypted database is a private format** (third-party tools cannot recognize it).

**An extra structural clue** (bytes 16–23, i.e. the part right after the SQLite header magic):

```
plain : 10 00 01 01 00 40 20 20
encr  : 10 00 01 01 20 40 20 20
                    ^^ only this one byte differs
```

The two are nearly byte-identical over **bytes 16–23**, the only difference being **byte 20**: plaintext `0x00`
→ encrypted `0x20`. Per the SQLite file format, **byte 20 is the "reserved space per page"** — i.e. **AIR's
encrypted database reserves 32 bytes per page** (for each page's nonce/MAC), and only **encrypts the first 16
header bytes and the data from byte 24 on**, leaving the structural header bytes in plaintext.

This explains its **architecture** (isomorphic to SQLCipher: SQLite + a per-page reserved region + whole-page
encryption), but also pinpoints its **three incompatibilities** with SQLCipher:

| Axis | AIR (measured + docs) | SQLCipher (default) | Compatible? |
|---|---|---|---|
| Key derivation | **raw 16 bytes** used directly as the key (`writeUTFBytes(password)`) | PBKDF2-HMAC-SHA512 × 256000 iterations + a random salt | ✗ |
| Cipher | **AES-CCM** (an authenticated AEAD) | AES-256-**CBC** + a separate HMAC-SHA512 | ✗ |
| File layout | first 16 bytes = the **encrypted magic**; 32 B reserved per page | first 16 bytes = a **plaintext random salt**; 48 B reserved per page | ✗ |

⇒ "Cover it with SQLCipher" fails on all three axes **simultaneously**; it is **not** a replacement that "just
needs a bit of configuration to be compatible".

---

## 4. Current-state inventory

### 4.1 Us (the compiler)

| Item | State | Evidence |
|---|---|---|
| `flash.errors.SQLError` | **Already built-in** | `src/emit.ts:6765`, `src/symbols.ts:820-830` |
| `flash.data.SQLConnection` / `SQLStatement` | **Not registered** (deliberately deferred) | the "depends on SQLite linking, deferred" entry in `TODO.md` |
| `getDefinitionByName("flash.data.SQLConnection")` | throws **`ReferenceError #1065`**, **and it is catchable by `catch (e:Error)`** | `temp/sqlprobe.as` |
| Any "is the database available" probe | Completely **transparent to the app** | same as above (silent degradation, see §1) |

**Conclusion**: our gap is **two-layered** — **(i) the runtime registry is missing 5 classes** (`SQLConnection` /
`SQLStatement` / `SQLEvent` / `SQLErrorEvent`, plus result classes like `SQLResult`), and **(ii) the SQLite
engine that actually does the work underneath is missing**. But because the wrapper resolves **dynamically**,
as long as we register these names and `getDefinitionByName` no longer throws, the app's `try/catch` will walk
into the "we have a database" branch — so if **(i) is not filled in, or is filled with empty shells, it turns
"silent degradation" into "silently wrong data"**, which is worse than the status quo. This is exactly why the
engine must be made real **together** with the API surface.

### 4.2 The target app's actual usage (API surface narrows to **4 entry points**)

Measured: across all of `src/`, `flash.data`-related symbols appear **79** times, spread over **8 files**, but
**not one of them is `import flash.data`** — all go through the wrapper.

The wrapper's **dynamic dependency on `flash.data` is only 5 names** (`getDefinitionByName`):

```
flash.data.SQLConnection      flash.data.SQLStatement
flash.events.SQLEvent         flash.events.SQLErrorEvent
（+ flash.utils.getDefinitionByName itself）
```

The wrapper entry points the app **actually calls** are only **4**:

| Entry point | Semantics | Call sites |
|---|---|---|
| `SQLStartment.SQLStartmentSQLiteFile(path, password)` | Open/create the database | `ServerData.as:110` |
| `SQLStartment.cReate(sql)` | Execute DDL/DML | `ServerData.as:130,149` |
| `SQLStartment.Query(sql)` → `Array` | SELECT → array of objects | `TKMTrackerQueueLogs.as:46,122`, `ServerData.as:172,195` |
| `SQLStartment.addObjectDate(table, obj)` | INSERT one object | `TKMTrackerQueueLogs.as:160`, `AISubTitleSetupWindow.as:1298` |

SQL shape: **pure string concatenation**, **no parameter binding**, only two tables (`LOGS` / `AISUBTITLE`).
⇒ **The minimum usable surface = open + execute + SELECT-to-object-array + INSERT**; everything else
(transactions/schema/compaction/async/encryption) is "optional completeness".

Other facts (which determine the value of compatibility):

- Key: `Config.DEBUG=false` ⇒ password `"<redacted-16ch>"` (exactly 16 characters ⇒ a 16-byte key); and it is
  only used via `writeUTFBytes(password)` when `destoplocal=false`, so **the production path does not go through
  ELS**.
- Database path: `<appDir>/assets/database/acme-app.db`; **the app ships no database** — it is created on
  first run.
- `createSqLite`'s `catch` **deletes** the broken database file (self-healing) ⇒ **the value of cross-format
  compatibility is essentially zero**.
- `com.adobe.air.crypto.EncryptionKeyGenerator` **is not a gap** — it lives in the app's own
  `src/com/adobe/air/crypto/`, and the production path only uses the **pure-string
  `validateStrongPassword()`** (`getEncryptionKey()` goes through ELS, used only when `destoplocal=true`, which
  the app never calls). (On first check I judged it "unresolvable" from a standalone probe — that was a
  **misjudgment because the probe did not include that file**, and it has been ruled out.)

### 4.3 Blockers (**unrelated to SQLite**, but they get in the way first)

Two problems measured to take effect before SQLite does:

**(a) `Class`-value static getter dispatch is missing — our own semantic defect.**

```
                              AIR (adl 51.4.1)       us (v0.4.109)
direct getter:                THING                 THING
via class value, getter:      THING   ✅            ✗ bare Error id=0   ❌
via class value, var:         PLAIN   ✅            PLAIN   ✅
via class value, const:       KONST   ✅            KONST   ✅
via class value, method:      HI      ✅            HI      ✅
```

Evidence: AIR `temp/adlprobe/adl.txt` §1; ours `temp/sqlprobe3.as` (output `via class getter threw: Error id=0`).
That is, **only the path through a `Class` value to a static getter is broken**; var/const/method are all
correct.

**Why it is a hard blocker**: `Application.NativeApplication` is exactly a **static getter**, implemented as
`myClass.nativeApplication` (`Application.as:127`) — hitting the defect precisely:

```
Application.NativeApplication == NULL
=> if (Application.NativeApplication) branch is SKIPPED
unguarded deref: TypeError #1009 Error #1009: Cannot access a property or method of a null object reference.
```

(Our-side evidence `temp/narepro.as`.) There are two consequences: `SQLConnect.as`'s
`if (Application.NativeApplication) { … getDefinitionByName("flash.data.SQLConnection") … }` has its
**whole branch skipped** ⇒ the SQLite code path never executes; and there is a **reachable unguarded
dereference** right after it → a hard crash with `#1009`.

**(b) One build-time obstacle (not SQLite)**: the target app's `--dry` precheck **fails early** on this machine
at `[Embed] mimeType 'application/x-font' on 'com.bit101.components::Component.Ronda' is not supported` (plus 8
source files excluded for parse/E4X lexical errors). This is a font-embed support-surface issue, unrelated to
this document, but it blocks the "whole-package compile" acceptance step.

---

## 5. Selection conclusion

### 5.1 Engine: **link the official SQLite source (amalgamation)**, do not self-build

| Dimension | Self-built SQL engine | **Link the SQLite amalgamation (recommended)** |
|---|---|---|
| Semantic fidelity | must rebuild SQL parsing/execution/type affinity/collation/B-Tree… | **byte-for-byte identical by nature**: AIR's plaintext database *is* a standard SQLite file (§3.4) |
| Verifiability | no authoritative oracle, can only self-certify | the host `sqlite3` CLI is an oracle, enabling **two-way** read/write comparison |
| Effort | an order of magnitude larger and never converging | the engine is **zero** work; the work is all in the AS3 API layer |
| Build | — | `sqlite3.c` is a single file, goes straight into the manifest `sources` (§2.9), no package manager |
| License | — | SQLite is **public domain**, no licensing risk |

**Landing shape**: put the SQLite **amalgamation** (`sqlite3.c` + `sqlite3.h`) into the manifest `sources` as a
**source dependency** (aligned with `AGENTS.md` §2.9 "link third-party libraries, do not embed"; the
amalgamation happens to satisfy both "readable C" and "the RUNTIME preamble does not bloat"). At runtime a
**thin glue layer** exposes it to the AS3 API layer (open/execute/step/column/bind), consistent with the
existing `as_*` extern style of `runtime.ts`.

### 5.2 Encryption: **do not self-build page encryption, no SQLCipher compatibility, report loudly per §1.5**

Three reasons:

1. **Switching to SQLCipher gets you nothing**: the three axes are incompatible (§3.4), so it can neither read
   AIR's encrypted databases nor produce one AIR can read. Its only use would be "our own school of encryption",
   but our artifacts do not interoperate with AIR anyway.
2. **Self-building the AES-CCM page codec** is technically feasible (the architecture is already understood: 32 B
   reserved per page, the first 16 header bytes encrypted), but aligning it requires **reverse-engineering
   evidence** of the per-page nonce/MAC layout — an **independent heavy project** whose payoff is limited to
   "reading old encrypted databases".
3. **The payoff is very low**: the target app's database lives in the **app directory**, **ships no database**,
   and **self-deletes and rebuilds** on error (§4.2) ⇒ there is no existing encrypted database to migrate.

**Therefore**: the key parameter is accepted but encryption is **not implemented**, and it must be a **loud,
distinguishable failure** — at build time or runtime we clearly report "this build does not support encrypted
databases", rather than silently writing plaintext (which silently lowers the security level of user data, a
worse failure than crashing). If encryption is ever done, it is a **standalone project** (§6 stage E).

### 5.3 Rejected options

| Option | Why rejected |
|---|---|
| **Self-built SQL engine** | deliberately diverging in a domain with an authoritative oracle; an order of magnitude more work (§5.1) |
| **Link SQLCipher to impersonate AIR encryption** | incompatible on all three axes (§3.4); and it turns "looks like encryption is supported" into silent misdirection |
| **Register only the API names, leave the engine as an empty shell** | upgrades "silent degradation (feature disappears)" to "silently wrong data", which is **more dangerous** (§4.1) |
| **Treat `flash.data` as an "enhancement AIR does not support" and skip it** | wrong criterion: `adl` runs it correctly and we cannot ⇒ it is a **leftover defect** (`AGENTS.md` §1.5) and must be on the books |

---

## 6. Proposed phased roadmap (aligned with the existing "stage XX" convention)

| Stage | Content | Acceptance |
|---|---|---|
| **A** | Link the amalgamation + register the `flash.data`/`flash.events` class skeletons + a minimal loop: `open` / `execute` / `SELECT→SQLResult` / `close` | New example `examples/sqlite-basic.as` (create table/insert/query/read back), with the artifact file compared against the host `sqlite3` |
| **B** | Full result set: `SQLResult.data` / `rowsAffected` / `complete`; `SQLStatement.itemClass` mapping; `columnNameStyle` | a byte-for-byte two-way (`adl` vs us) comparison matrix |
| **C** | Event and error contracts: `SQLEvent` (OPEN/RESULT/…), `SQLErrorEvent.error`, the `SQLError` error-number matrix; both synchronous and asynchronous paths | a measured `adl` error-number matrix (as in `flash-net.md` §6.7.5) |
| **D** | Transactions and schema: `begin`/`commit`/`rollback`, `loadSchema`/`*Schema`, `compact`/`analyze` | schema objects compared field by field against `adl` |
| **E** (optional, standalone) | Encryption: AES-CCM per-page codec + key derivation, reverse-engineering the per-page nonce/MAC layout | use a database written by `adl` as the oracle, compare read/write both ways |

**Prerequisite (must be done first, before A)**: fix the `Class`-value static getter dispatch defect of §4.3(a)
(and add an end-to-end pin for `Application.NativeApplication`). Otherwise stage A's acceptance cannot run
inside the **target app** (though it can at the `examples/` layer).

---

## 7. Boundaries explicitly not done / reported

- **Not doing** SQLCipher compatibility (pointless, §5.2).
- **Not doing** "silently ignore the key": passing a key must **loudly report** non-support (`AGENTS.md` §1.5).
- **Not registering empty shells**: once an API name is registered, it must have either a real implementation or
  a **loud failure** — "the name is there but returns empty" is not allowed.
- **web / WASI targets**: **assessed and landed on 2026-10-12** (see §10.5) — `wasm32-wasip1` **needs no**
  self-written VFS or `-DSQLITE_OS_OTHER`: wasi-libc's POSIX file surface is enough for SQLite's default unix
  VFS, needing only `-DSQLITE_THREADSAFE=0` (wasi-ld has no pthread).
- **ANE-related**: `ANELame` / `ANECrypto` also touch symbols like `EncryptedLocalStore`, which belong to the
  existing "ANE host (`asaot` FRE runtime)" gap (see `TODO.md` stage 178) and are out of scope here.

---

## 8. Effort and conclusion

**In one sentence**: **link the official SQLite amalgamation; the only thing we self-build is the "thin AS3 API"
on top of it; encryption is not done (reported loudly), and the `Class` static getter dispatch is fixed first.**

Effort distribution (relative magnitude):

| Part | Magnitude | Notes |
|---|---|---|
| SQLite engine | **≈0** | the amalgamation goes into `sources`, no package management, no licensing issue |
| Glue layer (C) | medium | open/exec/step/column/bind/finalize + error-number mapping |
| AS3 API layer | **medium** (the bulk) | class skeletons + minimal loop → result set → events/errors → transactions/schema; **only 4 entry points measured** (§4.2) |
| **`Class` static getter prerequisite** | **small** | but it **blocks** the target app's acceptance |
| Encryption | **large** (deferrable) | if done, needs reverse-engineering evidence; low payoff |

**Evidence list for each conclusion**: `temp/adlprobe/` (AIR ground truth: class existence / API surface /
`#3139` / byte-level database file header / the two host-`sqlite3` proofs), `temp/sqlprobe.as` (our catchable
`#1065`), `temp/sqlprobe3.as` (the `Class` static getter defect), `temp/narepro.as`
(`Application.NativeApplication` being `NULL` + the reachable `#1009`), `temp/ekg2.as` (ruling out an
`EncryptionKeyGenerator` gap).

---

## 9. References

- [`flash.data` package](https://airsdk.dev/reference/actionscript/3.0/flash/data/package-detail.html)
- [`SQLConnection`](https://airsdk.dev/reference/actionscript/3.0/flash/data/SQLConnection.html) (encryption = AES-CCM, 16-byte key)
- [`SQLStatement`](https://airsdk.dev/reference/actionscript/3.0/flash/data/SQLStatement.html)
- [`SQLResult`](https://airsdk.dev/reference/actionscript/3.0/flash/data/SQLResult.html)
- [SQL support in local databases](https://airsdk.dev/reference/actionscript/3.0/localDatabaseSQLSupport.html)
- SQLite amalgamation: <https://sqlite.org/amalgamation.html>

---

## 10. Landing status (2026-10-12, stage one hundred thirty-nine, v0.4.109 → v0.4.110)

The A–D stages of §6 **have all landed and been accepted item by item against `adl 51.4.1`** (E, encryption, is
still **not done**, reported loudly per §5.2). This section records only **what became known after the
implementation was complete**: measured semantics that disagree with the official docs, the deviations we
deliberately retain, and the evidence files for each stage. **Every assertion-style example runs on three
targets at once**: native, WASI (`wasm32-wasip1`), and the **AIR oracle** that rewrites the same example into an
`adl` harness (`temp/sql3/gen_oracle.py`).

### 10.1 Deliverables

| File | Role |
|---|---|
| `vendor/sqlite/{sqlite3.c,sqlite3.h,sqlite3ext.h}` | the official amalgamation 3.54.0, **referenced only by the manifest `sources`** (`shell.c` — the amalgamation's own CLI, with its own `main()` — is never compiled by the build and is **deliberately not committed**) |
| `vendor/sqlite_glue.c` | the sole translation unit that `#include <sqlite3.h>`; exposes a narrow `as_sql_*` ABI to the generated C |
| `src/runtime.ts` | the `as_sql_*` declarations + **loud stubs when not linked** (two `#ifdef ASC_HAVE_SQLITE` branches) |
| `src/symbols.ts` | class skeletons and member tables for `flash.data` / `flash.errors.SQLError` / `flash.events.SQL*` |
| `src/emit.ts` | the `flash.data` AS3→C implementation (~1,600 lines of hand-written C blocks) + `SQLStatement`/`SQLError` integration |
| `src/index.ts` | `usesFlashData` detection → adds `sources`, `include-paths`, `ASC_HAVE_SQLITE`, `SQLITE_ENABLE_COLUMN_METADATA` (wasm additionally adds `SQLITE_THREADSAFE=0`) |
| `examples/sqlite-basic.as` | stage A: open/execute/SELECT→`SQLResult`/close + comparison against the host `sqlite3` |
| `examples/sqlite-phase-b.as` | stage B: transactions/savepoints/`attach`/`columnNameStyle`/`compact`/`analyze`/error contracts |
| `examples/sqlite-phase-c.as` | stage C: `prefetch`/`next`/`cancel`/`executing`/`itemClass`/per-row `SQLUpdateEvent` |
| `examples/sqlite-phase-d.as` | stage D: `loadSchema`/`getSchemaResult`/the four `*Schema`/`SQLColumnSchema` |
| `test/unit/flash-data.ts` | 7 source-level/build-level pin groups (error families, offline stubs, the prefetch model, schema objects, build wiring, oracle shape) |

### 10.2 Where the official docs and the measured `adl` **disagree** (we implement to measurement)

1. **`prefetch` is not "how many rows per fetch"**. The default `-1` = fetch all (`complete=true`); `>0` = at
   most that many (`complete=false`, `executing=true`); **`0` or any negative other than `-1` = not a single row,
   straight to `data=null, complete=true`**; `next()` after `complete` throws `#3107`. An empty block is always
   `data == null` (**not an empty array**); DDL/DML are likewise `data == null`.
2. **`SQLStatement.text`'s initial value is the empty string** (not `null`); **assigning `null` to `text` throws
   `TypeError #1009`** (AIR's setter dereferences), and the property **keeps its original value**.
3. **`SQLStatement.itemClass`'s initial value is the `Object` class** (not `null`); assigning `null` **is
   accepted** and reads back as `Object` (AIR normalizes). Both asymmetries with `text` are measured.
4. **`getResult()` / `getSchemaResult()` are FIFO queues**: each `execute()`/`loadSchema()` pushes exactly one,
   and once taken it is `null`. The examples therefore must use a "take immediately after executing" helper —
   this is the **easiest pitfall on the app side**.
5. **A missed `loadSchema` = an error**, not an empty result: `#3115` + `detailID` **1007** (a name was given) /
   **1009** (only a type) / **1010** (neither), with `detailArguments` being `(name,type,db)` / `(type,db)` /
   `(db)` respectively, and the `details` text copied byte for byte.
6. **Only user-created objects are listed**: the auto-indexes of UNIQUE/PRIMARY KEY have a NULL `sql` ⇒ not
   counted; the `sqlite_sequence` auto-created by `AUTOINCREMENT` and the `sqlite_stat1` created by `ANALYZE`
   **are not counted either** (filtered by the `sqlite_` prefix).
7. **`columns` is an empty array when `includeColumnSchema=false`** (not `null`).
8. **`SQLViewSchema extends SQLTableSchema`** (`view is SQLTableSchema` holds), with the same struct layout.
9. **AIR's default `pageSize` is 1024** (not SQLite's 4096): the glue passes 1024 when the parameter is 0.
10. **`inTransaction` = `autocommit==0 && sqlite3_txn_state!=0`**; this is also the `#3103` criterion for
    `compact`/`cacheSize`/`deanalyze` (**not** a bare autocommit: with a DEFERRED begin that has not written,
    they are let through and the engine reports `#3115` itself); `analyze` has **no transaction guard**.
11. **`_sawTxn`** (AIR's own "a transaction was opened" flag): set by `begin()`/`setSavepoint()`, cleared by
    `commit()`/`rollback()` — it separates the bare `#3105` of "no transaction" from the engine's `#3115` (a bare
    `setSavepoint` + `releaseSavepoint` followed by `commit` gives `#3115`).
12. **An unnamed savepoint is literally the empty name string** `""` (not some internal name).
13. **`SQLUpdateEvent` is dispatched by `SQLConnection`** (a listener attached to the `SQLStatement` **does not
    receive it**), one per affected row, and **before** the statement's `result` event.
14. **`cancel()` dispatches no event**; `execute()` while a cursor has not been fully walked is **legal** (it
    finalizes first, then re-runs).
15. **"a failed `loadSchema` neither pushes the queue nor dispatches a `schema` event"** (the event count grows
    only with successful calls).

### 10.3 Deliberately retained deviations (**loudly** reported, not silently degraded)

- **Encryption = a straight error**: any non-empty `encryptionKey` / `reencrypt()` / keyed `attach` is a
  `SQLError #3138`, and we **never silently write a plaintext database** (`AGENTS.md` §1.5).
- **`details` / `detailID` text**: we use SQLite's own `sqlite3_errmsg` and `sqlite3_extended_errcode`, whereas
  AIR **rewrites the text** (AIR: `no such table: 'sqlite_stat1'`, `no such savepoint: ''`,
  `unable to open database: '<path>'`, while we give `no such table: sqlite_stat1` etc., without the quotes),
  and AIR occasionally has `details="" detailID=-1`. **The error numbers and the "three modes" of `details`
  text are copied byte for byte** (1007/1009/1010, parameter mismatch 1004, `#3102`/`#3105`/`#3112`/`#2007`).
- **`attach(name, null)`**: AIR **silently accepts** it; we **report loudly** (without a `File` there is no
  path).
- **`openAsync()` is still synchronous internally**: a listener registered **after** the call receives no event
  (a known ADR gap).
- **`columnNameStyle = "default"` is still the short name**: AIR switches to the long name (`t_id`) for
  **table-qualified columns**, while we keep the short name (the `long` value itself is already implemented as
  `[table]_[column]`); unknown values are always normalized to `"default"`.
- **`SQLColumnSchema.defaultCollationType` is always `"binary"`**; `collate nocase` is not wired.
- **`FileStream`/`ByteArray.reference` are not supported** (only a real `File` can `open`/`attach`).
- **`#2008`** (`loadSchema`'s `type` is not one of the four schema classes) is supplemented by us following
  AIR's error-number family; its text was not measured byte for byte.

### 10.4 Acceptance (three targets)

| Target | Result |
|---|---|
| native (`-O2`) | all four examples green: `sqlite-basic: ok` / `sqlite-phase-b: ok` / `sqlite-phase-c: ok` / `sqlite-phase-d: ok` |
| **AIR oracle** (`adl 51.4.1`) | **the same assertions are all green on AIR** (`temp/sql3/`: `gen_oracle.py` rewrites the examples → `run_adl.sh`) — the reproduction path for every "measured" claim in this section |
| WASI (`wasm32-wasip1`) | all four examples green (run under Node 24's `node:wasi`, `temp/wasirun.mjs`); the produced database file is the same size as native/AIR (3072 B / page_size 1024) |
| Byte-level comparison | `temp/sqlite-basic.db` = 3072 B, first 16 bytes `SQLite format 3\0`, `pragma integrity_check` = `ok`, `page_size` = 1024 |

### 10.5 Two extra conclusions for the WASI target

- **No self-written VFS needed**: the POSIX file surface wasi-libc provides is enough for SQLite's unix VFS to
  run directly, with no `-DSQLITE_OS_OTHER`; only `-DSQLITE_THREADSAFE=0` is needed (`wasm-ld` has no pthread).
- **Fixed in passing** a defect unrelated to SQLite that **blocked every wasm build**: `as_rmdir_one` directly
  calls `rmdir()` on the non-Windows branch, but `rmdir` is declared in `<unistd.h>` — a header **deliberately
  skipped under WASI** (which has no `fork/exec`), so **every** wasm build died on `call to undeclared function
  'rmdir'` (ISO C99 no longer accepts implicit declarations). Changed to the POSIX `remove()` (`<stdio.h>` is
  always present, and wasi-libc treats a directory the same as rmdir; the Windows branch is still
  `RemoveDirectoryA`, semantics unchanged).
- **The `_sawTxn`-style "AIR's own bookkeeping" deserves extra care**: it is not in the docs and can only be
  forced out by a comparison matrix of "the same API reporting different error numbers under different prior
  states" (`temp/sql2/` rounds 7/9/10/11).

### 10.6 Stage-number note (reported honestly)

The 2026-10-12 scoping entry in `TODO.md` labeled this document "stage one hundred thirty-seven", but **`stage one
hundred thirty-seven` is already occupied in the code by a SWC named child** (`src/runtime.ts`), and **stage one
hundred thirty-eight** is this round's prerequisite fix (the `Class`-value static getter,
`examples/class-static-member.as` + `test/unit/reflection.ts`). Hence the **implementation round takes "the used
maximum + 1" = stage one hundred thirty-nine**.
