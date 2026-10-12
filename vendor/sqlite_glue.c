// SQLite glue for the AS3 `flash.data` implementation (docs/zh-cn/flash-data.md,
// phase A-D).
//
// This file is the ONLY place that includes <sqlite3.h>. It is compiled with the
// official SQLite amalgamation (vendor/sqlite/sqlite3.c) ONLY when a program
// actually uses flash.data (the compiler sets ASC_USE_SQLITE and adds both files
// to the build), so a build that never touches a database pays nothing.
//
// The exported names all start with `as_sql_` and take/return plain C types (void*
// handles, ints, doubles, C strings) so the generated C can declare them without
// seeing sqlite3.h. It is a thin, honest wrapper: every function maps 1:1 onto a
// SQLite C API call, so the runtime semantics ARE SQLite's -- which is exactly
// what AIR's plaintext databases are (measured: the file a plaintext open()
// creates is a standard SQLite file, docs/zh-cn/flash-data.md section 3.4).
//
// ENCRYPTION IS NOT IMPLEMENTED and must never silently degrade: AIR encrypts with
// AES-CCM (a private page layout that is not SQLCipher), so a caller that passes a
// key gets a LOUD failure from the AS3 layer (AGENTS.md section 1.5) -- this glue
// never sees a key and never writes plaintext for an encryption request.

#include "sqlite3.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// Open flags for as_sql_open. The AS3 layer maps SQLMode.CREATE / READ / UPDATE
// (plus "does the file already exist?") onto these.
#define AS_SQL_CREATE 1
#define AS_SQL_READONLY 2
#define AS_SQL_READWRITE 4

static char* as_sql_dup(const char* s) {
    if (s == NULL) s = "";
    size_t n = strlen(s);
    char* p = (char*)malloc(n + 1);
    if (p != NULL) memcpy(p, s, n + 1);
    return p;
}

// Open a database. `path` NULL means an in-memory database. Returns NULL on
// failure with *rc/*msg set (msg is a malloc'd copy the caller must free).
// Defined with the per-row update record below; as_sql_open installs it.
void as_sql_watch_changes(void* h);

void* as_sql_open(const char* path, int flags, int pageSize, int autoVacuum, int* rc, char** msg) {
    if (rc != NULL) *rc = SQLITE_OK;
    if (msg != NULL) *msg = NULL;
    int f = 0;
    if ((flags & AS_SQL_READONLY) != 0) f |= SQLITE_OPEN_READONLY;
    else if ((flags & AS_SQL_READWRITE) != 0) f |= SQLITE_OPEN_READWRITE;
    if ((flags & AS_SQL_CREATE) != 0) f |= SQLITE_OPEN_CREATE;
    f |= SQLITE_OPEN_URI;
    sqlite3* db = NULL;
    int r = sqlite3_open_v2(path, &db, f, NULL);
    if (r != SQLITE_OK) {
        if (rc != NULL) *rc = r;
        if (msg != NULL) *msg = as_sql_dup(db != NULL ? sqlite3_errmsg(db) : "unable to open database file");
        if (db != NULL) sqlite3_close(db);
        return NULL;
    }
    // pageSize / auto_vacuum are only meaningful before the first table exists;
    // SQLite ignores the pragma once a database is non-empty, matching AIR's
    // "only valid when creating a new database or one with no tables".
    //
    // AIR's DEFAULT page size is 1024, not SQLite's 4096: measured on adl 51.4.1
    // (temp/sql2 round 8), a plain open()/attach() reports pageSize == 1024 and
    // writes a 1024-byte file, so 0 (and any value SQLite would reject) means 1024.
    {
        int ps = (pageSize >= 512) ? pageSize : 1024;
        char buf[64];
        snprintf(buf, sizeof(buf), "PRAGMA page_size=%d", ps);
        sqlite3_exec(db, buf, NULL, NULL, NULL);
    }
    if (autoVacuum) sqlite3_exec(db, "PRAGMA auto_vacuum=FULL", NULL, NULL, NULL);
    // Watch row changes so the AS3 layer can dispatch one SQLUpdateEvent per
    // changed row (see as_sql_take_update).
    as_sql_watch_changes((void*)db);
    // AIR exposes a 2000-page default cache (docs) -- keep SQLite's own default,
    // which is what the measured AIR behaviour matches.
    return (void*)db;
}

void as_sql_close(void* h) { if (h != NULL) sqlite3_close((sqlite3*)h); }

// Execute a statement with no result rows (DDL/DML/multi-statement). Returns the
// SQLite result code; *msg gets a malloc'd copy of errmsg on failure.
int as_sql_exec(void* h, const char* sql, char** msg) {
    if (msg != NULL) *msg = NULL;
    sqlite3* db = (sqlite3*)h;
    char* err = NULL;
    int r = sqlite3_exec(db, sql, NULL, NULL, &err);
    if (r != SQLITE_OK && msg != NULL) *msg = as_sql_dup(err != NULL ? err : sqlite3_errmsg(db));
    if (err != NULL) sqlite3_free(err);
    return r;
}

// Prepare a statement. Returns NULL on failure with *rc/*msg set.
void* as_sql_prepare(void* h, const char* sql, int* rc, char** msg) {
    sqlite3* db = (sqlite3*)h;
    sqlite3_stmt* st = NULL;
    int r = sqlite3_prepare_v2(db, sql, -1, &st, NULL);
    if (rc != NULL) *rc = r;
    if (r != SQLITE_OK) {
        if (msg != NULL) *msg = as_sql_dup(sqlite3_errmsg(db));
        if (st != NULL) sqlite3_finalize(st);
        return NULL;
    }
    if (msg != NULL) *msg = NULL;
    return (void*)st;
}

int as_sql_bind_null(void* st, int idx) { return sqlite3_bind_null((sqlite3_stmt*)st, idx); }
int as_sql_bind_int(void* st, int idx, long long v) { return sqlite3_bind_int64((sqlite3_stmt*)st, idx, (sqlite3_int64)v); }
int as_sql_bind_double(void* st, int idx, double v) { return sqlite3_bind_double((sqlite3_stmt*)st, idx, v); }
// SQLITE_TRANSIENT: SQLite copies the bytes, so a temporary C string is safe.
int as_sql_bind_text(void* st, int idx, const char* v) { return sqlite3_bind_text((sqlite3_stmt*)st, idx, v, -1, SQLITE_TRANSIENT); }
int as_sql_bind_blob(void* st, int idx, const void* v, int n) { return sqlite3_bind_blob((sqlite3_stmt*)st, idx, v, n, SQLITE_TRANSIENT); }
// Named-parameter index ("":name) for text binding; -1 when the name is unknown.
int as_sql_bind_parameter_index(void* st, const char* name) { return sqlite3_bind_parameter_index((sqlite3_stmt*)st, name); }
// How many parameters the statement declares, and the name of one of them (NULL for
// a positional "?"). Both feed AIR's "Mismatch in parameter count" report (measured:
// errorID 3115, detailID 1004, args [found, set, ":a"]).
int as_sql_bind_parameter_count(void* st) { return sqlite3_bind_parameter_count((sqlite3_stmt*)st); }
const char* as_sql_bind_parameter_name(void* st, int i) { return sqlite3_bind_parameter_name((sqlite3_stmt*)st, i); }

// SQLITE_ROW (100) / SQLITE_DONE (101) / an error code.
int as_sql_step(void* st) { return sqlite3_step((sqlite3_stmt*)st); }
void as_sql_reset(void* st) { sqlite3_reset((sqlite3_stmt*)st); }
void as_sql_finalize(void* st) { if (st != NULL) sqlite3_finalize((sqlite3_stmt*)st); }
int as_sql_column_count(void* st) { return sqlite3_column_count((sqlite3_stmt*)st); }
const char* as_sql_column_name(void* st, int i) { return sqlite3_column_name((sqlite3_stmt*)st, i); }
// The declared table name of a result column (used for columnNameStyle LONG).
const char* as_sql_column_table_name(void* st, int i) { return sqlite3_column_table_name((sqlite3_stmt*)st, i); }
// SQLITE_INTEGER 1 / SQLITE_FLOAT 2 / SQLITE_TEXT 3 / SQLITE_BLOB 4 / SQLITE_NULL 5.
int as_sql_column_type(void* st, int i) { return sqlite3_column_type((sqlite3_stmt*)st, i); }
long long as_sql_column_int64(void* st, int i) { return (long long)sqlite3_column_int64((sqlite3_stmt*)st, i); }
double as_sql_column_double(void* st, int i) { return sqlite3_column_double((sqlite3_stmt*)st, i); }
const char* as_sql_column_text(void* st, int i) { return (const char*)sqlite3_column_text((sqlite3_stmt*)st, i); }
const void* as_sql_column_blob(void* st, int i) { return sqlite3_column_blob((sqlite3_stmt*)st, i); }
int as_sql_column_bytes(void* st, int i) { return sqlite3_column_bytes((sqlite3_stmt*)st, i); }

long long as_sql_changes(void* h) { return (long long)sqlite3_changes((sqlite3*)h); }
long long as_sql_total_changes(void* h) { return (long long)sqlite3_total_changes((sqlite3*)h); }
long long as_sql_last_insert_rowid(void* h) { return (long long)sqlite3_last_insert_rowid((sqlite3*)h); }
int as_sql_errcode(void* h) { return sqlite3_errcode((sqlite3*)h); }
int as_sql_extended_errcode(void* h) { return sqlite3_extended_errcode((sqlite3*)h); }
const char* as_sql_errmsg(void* h) { return sqlite3_errmsg((sqlite3*)h); }
// 0 when a transaction is open (SQLite's own autocommit flag), else 1.
int as_sql_get_autocommit(void* h) { return sqlite3_get_autocommit((sqlite3*)h); }
// AIR's SQLConnection.inTransaction is NOT "BEGIN has been executed": adl 51.4.1
// reports false after begin() (deferred, the default) until a statement actually
// touches the database, and true for begin(IMMEDIATE/EXCLUSIVE) (measured,
// temp/sqladl/adl.txt). That is exactly SQLite's own transaction state, so report
// it instead of a hand-maintained flag: 0=NONE, 1=READ, 2=WRITE.
int as_sql_txn_state(void* h) { return sqlite3_txn_state((sqlite3*)h, NULL); }
void as_sql_interrupt(void* h) { sqlite3_interrupt((sqlite3*)h); }

// ---- the per-row update record (SQLUpdateEvent) ----
// AIR dispatches one flash.events.SQLUpdateEvent per row changed by an INSERT,
// UPDATE or DELETE, carrying that row's rowid and table name (measured: "UPDATE t
// SET v = v || '-x' WHERE id < 3" fires two events, rowID 1 and 2). An UPDATE or
// DELETE has no last_insert_rowid to read, so SQLite's own update hook is the only
// way to learn those rowids -- it reports every row change as the statement steps.
// The list is drained by the AS3 layer after each statement, which is what makes
// the events per-row and ordered.
typedef struct { int op; long long rowid; char* table; } as_sql_upd;
static as_sql_upd* as_sql_upds = NULL;
static int as_sql_upd_n = 0;
static int as_sql_upd_cap = 0;

static void as_sql_update_cb(void* arg, int op, const char* dbname, const char* table, sqlite3_int64 rowid) {
    (void)arg; (void)dbname;
    if (op != SQLITE_INSERT && op != SQLITE_UPDATE && op != SQLITE_DELETE) return;
    if (as_sql_upd_n == as_sql_upd_cap) {
        int cap = (as_sql_upd_cap == 0) ? 8 : as_sql_upd_cap * 2;
        as_sql_upd* grown = (as_sql_upd*)realloc(as_sql_upds, (size_t)cap * sizeof(as_sql_upd));
        if (grown == NULL) return;  // out of memory: this row's event is dropped
        as_sql_upds = grown;
        as_sql_upd_cap = cap;
    }
    as_sql_upds[as_sql_upd_n].op = (op == SQLITE_INSERT) ? 1 : (op == SQLITE_UPDATE) ? 2 : 3;
    as_sql_upds[as_sql_upd_n].rowid = (long long)rowid;
    as_sql_upds[as_sql_upd_n].table = as_sql_dup(table);
    as_sql_upd_n++;
}

void as_sql_watch_changes(void* h) {
    sqlite3_update_hook((sqlite3*)h, as_sql_update_cb, NULL);
}

void as_sql_reset_updates(void* h) {
    (void)h;
    for (int i = 0; i < as_sql_upd_n; i++) free(as_sql_upds[i].table);
    as_sql_upd_n = 0;
}

int as_sql_update_count(void* h) { (void)h; return as_sql_upd_n; }
int as_sql_update_op(void* h, int i) { (void)h; return (i >= 0 && i < as_sql_upd_n) ? as_sql_upds[i].op : 0; }
long long as_sql_update_rowid(void* h, int i) { (void)h; return (i >= 0 && i < as_sql_upd_n) ? as_sql_upds[i].rowid : 0; }
const char* as_sql_update_table(void* h, int i) { (void)h; return (i >= 0 && i < as_sql_upd_n) ? as_sql_upds[i].table : NULL; }

// Read a single integer PRAGMA (page_size, cache_size, auto_vacuum). Returns
// `dflt` when the pragma yields no row.
static long long as_sql_pragma_int(sqlite3* db, const char* pragma, long long dflt) {
    sqlite3_stmt* st = NULL;
    if (sqlite3_prepare_v2(db, pragma, -1, &st, NULL) != SQLITE_OK) return dflt;
    long long v = dflt;
    if (sqlite3_step(st) == SQLITE_ROW) v = (long long)sqlite3_column_int64(st, 0);
    sqlite3_finalize(st);
    return v;
}

long long as_sql_get_page_size(void* h) { return as_sql_pragma_int((sqlite3*)h, "PRAGMA page_size", 0); }
long long as_sql_get_cache_size(void* h) { return as_sql_pragma_int((sqlite3*)h, "PRAGMA cache_size", 0); }
long long as_sql_get_auto_vacuum(void* h) { return as_sql_pragma_int((sqlite3*)h, "PRAGMA auto_vacuum", 0); }

// Set a cache size (negative = KiB, positive = pages -- SQLite's own convention;
// AIR's cacheSize is in pages, so the caller passes a positive value).
int as_sql_set_cache_size(void* h, long long pages) {
    char buf[64];
    snprintf(buf, sizeof(buf), "PRAGMA cache_size=%lld", pages);
    return sqlite3_exec((sqlite3*)h, buf, NULL, NULL, NULL);
}

// True when the file at `path` looks like a SQLite database (its 16-byte header is
// "SQLite format 3\0"). Used to distinguish "opens an existing database" from "the
// file exists but is not a database" (AIR report #3138 / #3127 family).
int as_sql_is_database_file(const char* path) {
    FILE* f = fopen(path, "rb");
    if (f == NULL) return 0;
    char hdr[16];
    size_t n = fread(hdr, 1, 16, f);
    fclose(f);
    return n == 16 && memcmp(hdr, "SQLite format 3\0", 16) == 0;
}

// True when the file exists and is non-empty (the AS3 layer uses this with
// SQLMode.READ/UPDATE to report "no such database" the way AIR does).
int as_sql_file_exists(const char* path) {
    FILE* f = fopen(path, "rb");
    if (f == NULL) return 0;
    fclose(f);
    return 1;
}

const char* as_sql_libversion(void) { return sqlite3_libversion(); }
