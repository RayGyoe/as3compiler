// Unit checks: flash.data / SQLite (阶段一百三十九).
// Moved here rather than into an example because these are SOURCE-level and
// BUILD-level invariants -- the error-family split, the offline stub, the build
// wiring -- which no AS3 program can observe (AGENTS.md 2.7: example runs cover
// behaviour, unit groups cover structure/diagnostics/wiring). The behavioural
// half lives in examples/sqlite-basic.as, sqlite-phase-b.as, sqlite-phase-c.as and
// sqlite-phase-d.as, each of which is also re-run under adl 51.4.1 as an oracle
// (temp/sql3/gen_oracle.py).
//
//   node --test --test-name-pattern='flash-data/' test/unit/*.ts

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { RUNTIME_PREAMBLE } from '../../src/runtime.ts';
import { registerGroup, root, dir, EXAMPLE_TIMEOUT_MS } from '../harness.ts';

// The C emitted for one script. Small programs, so this stays cheap; called once
// per group and shared between the assertions.
function emit(src: string): string {
  return generateC(parse(src)).c;
}

// ---- the offline stub and the build wiring ----
// Two halves of one rule (AGENTS.md 1.5): the SQLite engine is linked only when a
// program references flash.data, and when it is not linked the runtime says so out
// loud instead of pretending an open() worked. A false negative in the detection
// would otherwise show up as a silently empty database.
function checkOfflineStubs(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [sqldata] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [sqldata] ${label}`); }
  };

  // The preamble carries both branches: the real ABI behind the flag, the stubs
  // without it. Every build of a flash.data program compiles the AS3 layer; only
  // the engine differs, which is why the class bodies are emitted unconditionally.
  check('the runtime declares the engine ABI behind ASC_HAVE_SQLITE',
    RUNTIME_PREAMBLE.includes('#ifdef ASC_HAVE_SQLITE') && RUNTIME_PREAMBLE.includes('extern void* as_sql_open('));
  check('the runtime ships a loud stub without it',
    RUNTIME_PREAMBLE.includes('the SQLite backend was not linked into this build'));
  check('the stub fails rather than opening a database',
    /static inline void\* as_sql_open\([^)]*\)\s*\{[^}]*\*rc = 1;[^}]*return NULL;/.test(RUNTIME_PREAMBLE));
  check('the stub message names the fix', RUNTIME_PREAMBLE.includes('reference flash.data'));

  const c = emit('import flash.data.SQLConnection;\nvar c:SQLConnection = new SQLConnection();\ntrace(c.connected);\n');
  check('the AS3 layer is emitted for a flash.data program', c.includes('SQLConnection_open'));
  check('the emitted program keeps both engine branches',
    c.includes('#ifdef ASC_HAVE_SQLITE') && c.includes('the SQLite backend was not linked into this build'));
  check('opening without a connection is still the loud stub',
    c.includes('as_sql_open(') && c.includes('AS_SQL_F_CREATE'));
  if (ok > 0) console.log(`[sqldata] ${ok} offline-stub checks passed`);
  return bad;
}

// ---- the error family ----
// AIR splits flash.data failures in two (measured on adl 51.4.1 across rounds 1-11
// in temp/sql2): an ENGINE failure is a flash.errors.SQLError (details/detailID/
// detailArguments filled, errorID 3115/3125/3131/3138), while a CONTRACT violation
// is a plain Error/ArgumentError/TypeError (3101/3102/3103/3104/3105/3107/3108/
// 3109/3112/2007/2008). The distinction is observable -- `e is SQLError` -- and a
// catch clause written for SQLError silently misses the contract family, so it is
// pinned here as source structure.
function checkErrorFamilies(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [sqldata] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [sqldata] ${label}`); }
  };
  const c = emit('import flash.data.SQLConnection;\nimport flash.data.SQLStatement;\nvar c:SQLConnection = new SQLConnection();\nvar s:SQLStatement = new SQLStatement();\ns.sqlConnection = c;\ntrace(s.text);\n');
  const has = (s: string): boolean => c.includes(s);
  const contract = [
    ['#3101 already open', '3101', 'Database connection is already open.'],
    ['#3104 not open', '3104', 'A SQLConnection must be open to perform this operation.'],
    ['#3105 no transaction', '3105', 'Operation is only allowed if a connection has an open transaction.'],
    ['#3107 next() before the end', '3107', 'SQLStatement.next may not be called unless SQLResult.complete is false.'],
    ['#3108 text not set', '3108', 'Operation is not permitted when the SQLStatement.text property is not set.'],
    ['#3109 no connection', '3109', 'Operation is not permitted when the SQLStatement.sqlConnection property is not set.'],
    ['#3112 bad lock type', '3112', 'An invalid transaction lock type was specified.'],
  ] as const;
  for (const [label, id, text] of contract) {
    check(`the plain-Error ${label} text is present`, has(text) && has(id));
  }
  // The three contract errors AIR raises as ArgumentError/TypeError rather than Error.
  check('#3102 (attach/detach name) is an ArgumentError',
    contract.length > 0 && has('Name argument specified was invalid. It must not be null or empty.') && c.includes('ArgumentError_new'));
  check('#2007 (columnNameStyle null) is a TypeError', has('Parameter columnNameStyle must be non-null.'));
  check('#2008 (loadSchema type) is an ArgumentError',
    has('The type argument must be one of SQLTableSchema, SQLViewSchema, SQLIndexSchema or SQLTriggerSchema.'));
  // ... and the engine family, which must NOT be plain Errors.
  check('#3115 comes from the engine status map', has('"SQL Error."'));
  check('#3125 (cannot open) is reported through the engine path', has('Unable to open the database file.'));
  check('#3131 (constraint) is reported through the engine path', has('Abort due to constraint violation.'));
  // An encryption key is refused LOUDLY: no silent plaintext database (ADR gap).
  check('an encryption key is refused with #3138', has('3138') && has('Encryption'));
  if (ok > 0) console.log(`[sqldata] ${ok} error-family checks passed`);
  return bad;
}

// ---- the statement contract (measured on adl 51.4.1) ----
// The two surprises of this round: an unset `text` is the EMPTY STRING (not null)
// and an unset `itemClass` is the Object CLASS (not null), while assigning null to
// `text` throws TypeError #1009 and assigning null to `itemClass` is accepted and
// reads back as Object.
function checkStatementContract(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [sqldata] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [sqldata] ${label}`); }
  };
  const c = emit('import flash.data.SQLConnection;\nvar c:SQLConnection = new SQLConnection();\nvar x:int = c.pageSize;\ntrace(x);\n');
  const has = (s: string): boolean => c.includes(s);

  check('a fresh statement\'s text is the empty string', has('o->_text = (char*)"";'));
  check('the getter of an unset itemClass answers the Object class',
    has('return (as_class*)as_v_class_by_name("Object").ptr;'));
  const bodyOf = (sig: string): string => {
    const at = c.lastIndexOf(sig);
    return at === -1 ? '' : c.slice(at, c.indexOf('\n}', at) + 2);
  };
  check('the text setter rejects null with TypeError #1009',
    /if \(value == NULL\) \{ as_throw\(TypeError_new\(\(char\*\)"Error #1009:[^"]*", 1009\)\); return; \}/.test(bodyOf('SQLStatement_set_text(void* _this, char* value) {')));
  // Comments are stripped first: the setter explains in prose that its sibling
  // rejects #1009, and pinning the CODE must not be confused by that.
  const icSetter = bodyOf('SQLStatement_set_itemClass(void* _this, as_class* value) {')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  check('the itemClass setter accepts null (it reads back as Object)',
    icSetter.includes('o->_itemClass = value;') && !icSetter.includes('as_throw'));
  check('#3108 tests the empty string, not a null pointer',
    has('if (o->_text == NULL || o->_text[0] == 0) as_sql_throw_err(3108,'));
  // The result queues are FIFO and hold exactly one entry per call (measured: the
  // second getResult()/getSchemaResult() of the same call returns null).
  check('getResult() shifts the FIFO result queue', has('as_array_shift(o->_queue).ptr'));
  check('getSchemaResult() shifts the FIFO schema queue', has('as_array_shift(o->_schemaQueue).ptr'));
  check('a failed loadSchema queues nothing',
    /if \(total == 0\) \{[\s\S]{0,1600}?as_throw\(\(void\*\)as_sql_mk_error\("schema"/.test(c));
  // execute() while a cursor is open is legal: it finalizes the old statement first.
  check('execute() finalizes a previous cursor instead of refusing',
    /void SQLStatement_execute\([\s\S]{0,900}?if \(o->_stmt != NULL\) \{ as_sql_finalize\(o->_stmt\); o->_stmt = NULL; \}/.test(c));
  // inTransaction follows SQLite's own state, which is also what guards #3103.
  check('inTransaction needs autocommit off AND a live statement',
    has('return (as_sql_get_autocommit(o->_db) == 0) && (as_sql_txn_state(o->_db) != 0);'));
  check('_sawTxn separates a plain #3105 from the engine\'s #3115', has('_sawTxn'));
  check('#3103 is the inTransaction test (not raw autocommit)',
    has('as_sql_need_no_txn') && has('SQLConnection_get_inTransaction(o)'));
  if (ok > 0) console.log(`[sqldata] ${ok} statement-contract checks passed`);
  return bad;
}

// ---- the prefetch model ----
// AIR does NOT treat prefetch as "rows per call": the default -1 takes everything,
// >0 takes at most that many (complete=false), and 0 or any OTHER negative value
// silently drops every row while still reporting complete=true. An empty chunk is
// data == null, never an empty Array (measured rounds 3/4).
function checkPrefetchModel(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [sqldata] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [sqldata] ${label}`); }
  };
  const c = emit('import flash.data.SQLConnection;\nvar c:SQLConnection = new SQLConnection();\ntrace(c.inTransaction);\n');
  const has = (s: string): boolean => c.includes(s);
  // as_sql_chunk() is the single place the three cases are decided.
  check('the chunk helper exists and is used by execute/next',
    has('as_sql_chunk(') && (c.match(/as_sql_chunk\(/g) ?? []).length >= 2);
  check('prefetch -1 means "everything"', has('unlimited') || has('prefetch < 0'));
  check('a limited chunk leaves complete=false', has('complete = false') || has('complete=false'));
  check('a zero-row chunk reports data = null', has('data = NULL') || has('row_data = NULL') || has('r->data = NULL'));
  check('next() on a complete result is #3107', has('3107, "SQLStatement.next may not be called'));
  check('an exhausted chunk reports complete and stops executing',
    has('complete = true') && has('executing = false'));
  if (ok > 0) console.log(`[sqldata] ${ok} prefetch checks passed`);
  return bad;
}

// ---- the schema objects ----
// The "nothing found" trio carries the searched name/type/database in BOTH the
// detail text and detailArguments (measured: AIR's detailID 1007/1009/1010 and its
// argument lists are reproduced exactly), and only user-created objects are listed.
function checkSchemaObjects(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [sqldata] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [sqldata] ${label}`); }
  };
  const c = emit('import flash.data.SQLConnection;\nimport flash.data.SQLTableSchema;\nvar c:SQLConnection = new SQLConnection();\nc.loadSchema(SQLTableSchema);\n');
  const has = (s: string): boolean => c.includes(s);

  check('a named miss is detailID 1007', has('detailID = 1007;'));
  check('1007\'s text names the searched name, type and database',
    has("The schema object with name '") && has("' of type '") && has("' in database '"));
  check('a type-only miss is detailID 1009', has('detailID = 1009;'));
  check('1009\'s text', has("No schema objects with type '") && has("' in database '"));
  check('an empty database is detailID 1010', has('detailID = 1010;'));
  check('1010\'s text', has("No schema objects in database '") && has("' were found."));
  // detailArguments mirrors the same three shapes: (name,type,db), (type,db), (db).
  check('1007 pushes the name, type and database as arguments',
    /detailID = 1007;[\s\S]{0,700}?as_array_push\(args, as_v_str\(as_sql_cstr\(dbname\)\)\);/.test(c));
  check('1009 pushes the type and database',
    /detailID = 1009;[\s\S]{0,500}?as_array_push\(args, as_v_str\(as_sql_cstr\(dbname\)\)\);/.test(c));
  check('1010 pushes the database only',
    /detailID = 1010;[\s\S]{0,300}?as_array_push\(args, as_v_str\(as_sql_cstr\(dbname\)\)\);/.test(c));
  // Only user-created objects: constraint indexes have a NULL sql, and SQLite's own
  // sqlite_sequence/sqlite_stat1 tables are skipped by name (measured).
  check('the sqlite_master query skips constraint indexes', has('AND sql IS NOT NULL'));
  check('SQLite\'s own sqlite_* objects are filtered by name', has('as_sql_ieq_n(nm, "sqlite_", 7)'));
  check('a lookup formats the searched name and kind the way AIR does',
    has('as_sql_sqlstr(dbname)') && has('as_sql_sqlstr(kind)'));
  // columns is an EMPTY Array (never null) when includeColumnSchema is false.
  check('includeColumnSchema=false yields an empty Array', has('withColumns ? as_sql_load_columns(db, nm, sq) : as_array_new()'));
  // A view IS a SQLTableSchema, whose struct layout is the table's.
  // A view's struct IS the table's: its accessors cast `this` to SQLTableSchema and
  // its ctor takes the table's parameters, so `view is SQLTableSchema` holds.
  check('a view reads its columns through the table layout',
    has('static as_array* SQLViewSchema_get_columns(void* _this) { return ((SQLTableSchema*)_this)->_columns; }'));
  // The user index/trigger rules are tables too, and both carry `table`.
  check('an index/trigger schema carries its table name', has('SQLIndexSchema_new(') && has('SQLTriggerSchema_new('));
  if (ok > 0) console.log(`[sqldata] ${ok} schema checks passed`);
  return bad;
}

// ---- the build wiring ----
// `usesFlashData` decides whether the SQLite amalgamation is compiled in, and it runs
// on the assembled source texts INCLUDING the generated app bootstrap -- so the check
// goes through the real CLI (an --air-app build with --dry) rather than around it. The
// wiring is compile-time only (it is not written back into the project manifest), so
// the dry-run command line is the thing to read. A false negative here is not silent
// (the stub throws), but it would floor an otherwise fine program at run time.
function checkBuildWiring(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [sqldata] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [sqldata] ${label}`); }
  };
  // NOT 'unit-sqlite': the dry-run output quotes its own paths, and the control
  // assertion below looks for the absence of the engine -- a directory name would
  // match it.
  const base = join(root, 'temp', 'unit-sqldata');
  const descriptor = (name: string): string =>
    `<?xml version="1.0" encoding="utf-8"?>\n<application xmlns="http://ns.adobe.com/air/application/51.0">\n` +
    `  <id>com.test.${name}</id>\n  <versionNumber>1.0</versionNumber>\n  <filename>${name}</filename>\n` +
    `  <initialWindow><content>Main.swf</content><visible>false</visible></initialWindow>\n</application>\n`;
  const apps: [string, string][] = [
    // The first app reaches flash.data through an IMPORT and a class reference; the
    // second is the control that must stay lean.
    ['db', 'import flash.data.SQLConnection;\n    import flash.display.Sprite;\n    public class Main extends Sprite { public function Main() { var c:SQLConnection = new SQLConnection(); trace(c.connected); } }'],
    ['plain', 'import flash.display.Sprite;\n    public class Main extends Sprite { public function Main() { trace("hi"); } }'],
  ];
  const dryRun = (name: string): string => {
    const d = join(base, name);
    mkdirSync(join(d, 'src'), { recursive: true });
    writeFileSync(join(d, `${name}-app.xml`), descriptor(name));
    writeFileSync(join(d, 'src', 'Main.as'), 'package {\n  ' + apps.find((a) => a[0] === name)![1] + '\n}\n');
    return execFileSync('node', ['src/index.ts', '--air-app', join(d, `${name}-app.xml`),
      '--main-class', 'Main', '--target', 'native', '--dry'],
      { cwd: root, stdio: 'pipe', timeout: EXAMPLE_TIMEOUT_MS }).toString();
  };

  const db = dryRun('db');
  check('a flash.data app announces the engine wiring', db.includes('+ flash.data: linking the SQLite engine'));
  check('a flash.data app compiles the SQLite amalgamation',
    db.includes('vendor/sqlite/sqlite3.c -o') || db.includes('vendor/sqlite/sqlite3.c\n'));
  check('... and the glue that is the only translation unit including sqlite3.h',
    db.includes('vendor/sqlite_glue.c -o'));
  check('... with the engine define', db.includes('-D ASC_HAVE_SQLITE'));
  check('... and the column-metadata option loadSchema needs', db.includes('-D SQLITE_ENABLE_COLUMN_METADATA'));
  check('... and sqlite\'s include dir', db.includes('-I ' + join(root, 'vendor', 'sqlite')));
  check('the compile line carries the generated C too', db.includes('unit-sqldata/db/db.c'));

  const plain = dryRun('plain');
  check('a plain app links no SQLite at all',
    !plain.includes('vendor/sqlite') && !plain.includes('ASC_HAVE_SQLITE'));
  if (ok > 0) console.log(`[sqldata] ${ok} build-wiring checks passed`);
  return bad;
}

// ---- the oracle harness documents itself ----
// Every flash.data example is also run under adl 51.4.1 through
// temp/sql3/gen_oracle.py, so a change to the example's shape must keep that
// generator able to consume it. The generator hoists a top-level `var` into a FIELD
// and leaves the initializer a statement -- an initializer that CALLED something
// (page1 = run2(...)) used to run at construction time and killed the harness
// before a single line was written (found the hard way). This guard keeps the four
// examples in the shape the generator expects.
function checkOracleHarness(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [sqldata] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [sqldata] ${label}`); }
  };
  const files = ['sqlite-basic.as', 'sqlite-phase-b.as', 'sqlite-phase-c.as', 'sqlite-phase-d.as'];
  for (const f of files) {
    const src = readFileSync(join(dir, f), 'utf8');
    check(`${f}: tops out with its ok trace`, /trace\("sqlite-(?:basic|phase-[bcd]): ok"\);/.test(src));
    check(`${f}: every top-level var is annotated, as gen_oracle.py requires`,
      src.split('\n').every((l) => !/^var \w+\s*=/.test(l)));
    check(`${f}: it deletes its database before creating it (a stale file would lie)`,
      src.includes('deleteFile()'));
    check(`${f}: assertions throw, they do not just print`, src.includes('function check(') && src.includes('throw new Error("FAIL: "'));
  }
  if (ok > 0) console.log(`[sqldata] ${ok} oracle-harness checks passed`);
  return bad;
}

registerGroup('unit: flash-data/OfflineStubs', checkOfflineStubs);
registerGroup('unit: flash-data/ErrorFamilies', checkErrorFamilies);
registerGroup('unit: flash-data/StatementContract', checkStatementContract);
registerGroup('unit: flash-data/PrefetchModel', checkPrefetchModel);
registerGroup('unit: flash-data/SchemaObjects', checkSchemaObjects);
registerGroup('unit: flash-data/BuildWiring', checkBuildWiring);
registerGroup('unit: flash-data/OracleHarness', checkOracleHarness);
