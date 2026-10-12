// Stage 139 — phase B of flash.data / SQLite (docs/zh-cn/flash-data.md): the rest of
// the SQLConnection surface — savepoints, attach/detach, analyze / deanalyze /
// compact, cacheSize, columnNameStyle, and the contract-violation error ids.
//
// Every assertion is pinned to adl 51.4.1 (measured in temp/sql2 rounds 7 and 8), and
// the whole file is re-run against adl as an oracle (temp/sql3 — see
// docs/zh-cn/flash-data.md §5). The load-bearing measurements:
//   * setSavepoint() outside a transaction SUCCEEDS and starts one; AIR's unnamed
//     savepoint is the empty name (a releaseSavepoint(null) with none reports
//     "no such savepoint: ''").
//   * a nested begin() is NOT ignored: the engine reports "cannot start a
//     transaction within a transaction" as #3115.
//   * commit()/rollback() without a transaction is the PLAIN #3105, but after a
//     bare setSavepoint + releaseSavepoint AIR still issues the COMMIT and reports
//     the engine's #3115 instead.
//   * attach() CREATES a missing file (like open with CREATE) and reports every
//     refusal -- a name already in use included -- as #3125; an empty name is
//     ArgumentError #3102.
//   * columnNameStyle accepts an unrecognized value and simply reads "default";
//     null is TypeError #2007.
//   * close() resets columnNameStyle/autoCompact and dispatches CLOSE again when the
//     connection was already closed.
import flash.data.SQLConnection;
import flash.data.SQLStatement;
import flash.data.SQLResult;
import flash.data.SQLMode;
import flash.data.SQLColumnNameStyle;
import flash.data.SQLTableSchema;
import flash.data.SQLTransactionLockType;
import flash.errors.SQLError;
import flash.events.SQLEvent;
import flash.filesystem.File;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

var dbFile:File = new File("temp/sqlite-phase-b.db");
var attached:File = new File("temp/sqlite-phase-b-attached.db");
var missing:File = new File("temp/sqlite-phase-b-missing.db");
for each (var f:File in [dbFile, attached, missing]) { if (f.exists) f.deleteFile(); }

var events:Array = [];
var conn:SQLConnection = new SQLConnection();
for each (var t:String in [SQLEvent.OPEN, SQLEvent.CLOSE, SQLEvent.BEGIN, SQLEvent.COMMIT,
                           SQLEvent.ROLLBACK, SQLEvent.ANALYZE, SQLEvent.COMPACT,
                           SQLEvent.DEANALYZE, SQLEvent.ATTACH, SQLEvent.DETACH,
                           SQLEvent.SET_SAVEPOINT, SQLEvent.RELEASE_SAVEPOINT,
                           SQLEvent.ROLLBACK_TO_SAVEPOINT]) {
  conn.addEventListener(t, function(e:SQLEvent):void { events.push(e.type); });
}
// Every execute() queues exactly one SQLResult (the queue is FIFO), so run one
// statement and immediately take its result -- otherwise the next getResult() would
// pop the previous statement's result.
var st:SQLStatement = null;
function runSql(sql:String):SQLResult { st.text = sql; st.execute(); return st.getResult(); }

// Capture the error an operation reports, or null when it succeeds. Note that AIR
// mixes the two families: an engine failure is a SQLError, while the contract
// violations (#3104 not open, #3105 no transaction) are PLAIN Errors -- so the catch
// clause must be Error, and `lastSqlError` is set only when it really was a SQLError.
var lastError:Error = null;
var lastSqlError:SQLError = null;
function attempt(f:Function):Error {
  lastError = null;
  lastSqlError = null;
  try { f(); } catch (e:Error) { lastError = e; if (e is SQLError) lastSqlError = e as SQLError; }
  return lastError;
}
function lastDetails():String { return (lastSqlError == null) ? "" : lastSqlError.details; }

// AIR's DEFAULT page size is 1024 (not SQLite's 4096), so a default open() reports it.
conn.open(dbFile, SQLMode.CREATE);
check(conn.pageSize == 1024, "the default pageSize is 1024, got " + conn.pageSize);
check(conn.cacheSize == 2000, "cacheSize is 2000 pages by default, got " + conn.cacheSize);

st = new SQLStatement();
st.sqlConnection = conn;
runSql("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");

// ---- savepoints ---------------------------------------------------------------
// A savepoint outside a transaction is legal and opens one, but inTransaction still
// reads false: AIR follows the ENGINE's transaction state, and a savepoint-only
// transaction has not touched the database yet.
check(attempt(function():void { conn.setSavepoint("s0"); }) == null, "a savepoint outside a transaction is allowed");
check(conn.inTransaction == false, "a savepoint-only transaction still reads inTransaction == false");
check(attempt(function():void { conn.releaseSavepoint("s0"); }) == null, "the savepoint can be released");
// Releasing the outermost savepoint ends the transaction the engine made for it, but
// AIR still issues the COMMIT and reports the engine's own #3115 (measured).
lastError = attempt(function():void { conn.commit(); });
check(lastError != null && lastError.errorID == 3115, "commit after a savepoint is #3115, got " + (lastError == null ? "no error" : "" + lastError.errorID));
check(lastSqlError.details.indexOf("no transaction is active") >= 0, "details, got " + lastSqlError.details);

// With a transaction actually open, commit()/rollback() work and a nested begin() is
// the engine's "cannot start a transaction within a transaction", NOT a silent no-op.
conn.begin();
conn.setSavepoint("sp1");
lastError = attempt(function():void { conn.begin(); });
check(lastError != null && lastError.errorID == 3115, "a nested begin is #3115, got " + (lastError == null ? "no error" : "" + lastError.errorID));
check(lastSqlError.details.indexOf("within a transaction") >= 0, "details, got " + lastSqlError.details);
check(runSql("INSERT INTO t (v) VALUES ('kept')").rowsAffected == 1,
      "the insert inside the transaction affected one row");
check(conn.inTransaction, "a write makes inTransaction true");
conn.releaseSavepoint("sp1");
conn.commit();
check(conn.inTransaction == false, "commit() ends the transaction");

// commit()/rollback() with no transaction at all is the PLAIN #3105.
lastError = attempt(function():void { conn.commit(); });
check(lastError != null && lastError.errorID == 3105, "commit() with no transaction is #3105, got " + (lastError == null ? "no error" : "" + lastError.errorID));
check(lastError.message == "Error #3105: Operation is only allowed if a connection has an open transaction.",
      "the #3105 message, got " + lastError.message);
lastError = attempt(function():void { conn.rollback(); });
check(lastError != null && lastError.errorID == 3105, "rollback() with no transaction is #3105");

// The rollback trio: set, roll back to, release. rollbackToSavepoint undoes the work
// done after the savepoint and leaves the transaction open, and the events come from
// the CONNECTION (measured).
conn.begin();
conn.setSavepoint("sp2");
check(runSql("INSERT INTO t (v) VALUES ('undone')").rowsAffected == 1,
      "the doomed insert affected one row");
conn.rollbackToSavepoint("sp2");
conn.releaseSavepoint("sp2");
check(conn.inTransaction, "rollbackToSavepoint keeps the transaction open");
check(runSql("SELECT COUNT(*) AS n FROM t").data[0].n == 1, "rollbackToSavepoint undid the second insert");
conn.commit();
check(events.indexOf("setSavepoint") >= 0 && events.indexOf("rollbackToSavepoint") >= 0 &&
      events.indexOf("releaseSavepoint") >= 0, "savepoint events were dispatched: " + events);

// With no transaction open, the savepoint operations report the PLAIN #3105 -- the
// same contract violation commit()/rollback() make (measured, temp/sql2 round 9).
lastError = attempt(function():void { conn.rollbackToSavepoint("sp2"); });
check(lastError != null && lastError.errorID == 3105, "a savepoint op with no transaction is #3105, got " + (lastError == null ? "no error" : "" + lastError.errorID));
lastError = attempt(function():void { conn.releaseSavepoint(null); });
check(lastError != null && lastError.errorID == 3105, "releasing with no transaction is #3105");

// Inside a transaction a released savepoint is the engine's #3115 instead. AIR's
// unnamed savepoint is the EMPTY name -- measured from its own details, which read
// "no such savepoint: ''". We hand the name to SQLite unchanged, so our details carry
// the same sentence without AIR's added quotes (the recorded details-wording gap in
// docs/zh-cn/flash-data.md §6).
conn.begin();
lastError = attempt(function():void { conn.rollbackToSavepoint("sp2"); });
check(lastError != null && lastSqlError != null && lastSqlError.errorID == 3115,
      "rolling back a released savepoint is #3115, got " + lastDetails());
check(lastSqlError.details.indexOf("no such savepoint") >= 0, "details name the savepoint, got " + lastDetails());
lastError = attempt(function():void { conn.releaseSavepoint(null); });
check(lastError != null && lastSqlError != null && lastSqlError.errorID == 3115 &&
      lastSqlError.details.indexOf("no such savepoint") >= 0,
      "releasing an unnamed savepoint that does not exist is #3115, got " + lastDetails());
conn.commit();

// ---- analyze / deanalyze / compact -------------------------------------------
lastError = attempt(function():void { conn.deanalyze(); });
check(lastError != null && lastError.errorID == 3115, "deanalyze before analyze is #3115");
check(lastSqlError.details.indexOf("sqlite_stat1") >= 0, "deanalyze drops sqlite_stat1, got " + lastSqlError.details);
conn.analyze();
conn.deanalyze();
conn.compact();
check(events.indexOf("analyze") >= 0 && events.indexOf("compact") >= 0 && events.indexOf("deanalyze") >= 0,
      "analyze/compact/deanalyze events were dispatched: " + events);
lastError = attempt(function():void { conn.analyze("nosuch"); });
check(lastError != null && lastError.errorID == 3115, "analyze of a missing table is #3115");

// Inside a transaction, AIR uses two DIFFERENT tests (measured, temp/sql2 round 10):
// compact / deanalyze / cacheSize refuse with the plain #3103, while analyze has no
// guard at all and simply runs.
conn.begin();
runSql("INSERT INTO t (v) VALUES ('in txn')");
check(conn.inTransaction, "a write opened the transaction");
lastError = attempt(function():void { conn.compact(); });
check(lastError != null && lastError.errorID == 3103, "compact inside a transaction is #3103, got " + (lastError == null ? "no error" : "" + lastError.errorID));
lastError = attempt(function():void { conn.deanalyze(); });
check(lastError != null && lastError.errorID == 3103, "deanalyze inside a transaction is #3103");
lastError = attempt(function():void { conn.cacheSize = 4000; });
check(lastError != null && lastError.errorID == 3103, "cacheSize inside a transaction is #3103");
lastError = attempt(function():void { conn.analyze(); });
check(lastError == null, "analyze is allowed inside a transaction, got " + lastDetails());
conn.commit();
check(conn.inTransaction == false, "commit() ended the transaction");

// The sharper version: a DEFERRED transaction that has not touched the database
// leaves SQLite in autocommit mode, so BOTH guards let the operation through -- and
// the engine then refuses the VACUUM itself, which AIR reports as #3115.
conn.begin(SQLTransactionLockType.DEFERRED);
check(conn.inTransaction == false, "a deferred begin has not touched the database");
lastError = attempt(function():void { conn.compact(); });
check(lastError != null && lastError.errorID == 3115,
      "compact in a not-yet-started transaction is the engine's #3115, got " + (lastError == null ? "no error" : "" + lastError.errorID));
lastError = attempt(function():void { conn.cacheSize = 4000; });
check(lastError == null, "cacheSize is allowed until the transaction really starts, got " + lastDetails());
conn.commit();

// ---- cacheSize / columnNameStyle ---------------------------------------------
conn.cacheSize = 4000;
check(conn.cacheSize == 4000, "cacheSize round-trips 4000, got " + conn.cacheSize);
lastError = attempt(function():void { conn.columnNameStyle = null; });
check(lastError != null && lastError.errorID == 2007, "columnNameStyle = null is TypeError #2007");
check(lastError.message == "Error #2007: Parameter columnNameStyle must be non-null.", "the #2007 message, got " + lastError.message);
conn.columnNameStyle = "bogus";
check(conn.columnNameStyle == "default", "an unrecognized style reads back as default, got " + conn.columnNameStyle);
conn.columnNameStyle = SQLColumnNameStyle.LONG;
check(conn.columnNameStyle == "long", "columnNameStyle = LONG, got " + conn.columnNameStyle);
conn.columnNameStyle = SQLColumnNameStyle.SHORT;
check(conn.columnNameStyle == "short", "columnNameStyle = SHORT, got " + conn.columnNameStyle);
check(conn.autoCompact == false, "autoCompact is false for a connection opened without it");

// ---- attach / detach ---------------------------------------------------------
conn.attach("o", missing);
check(missing.exists, "attach created the missing database file");
runSql("CREATE TABLE o.ot (x INTEGER)");
check(runSql("INSERT INTO o.ot VALUES (7)").rowsAffected == 1, "the insert into the attached database affected one row");
check(runSql("SELECT x FROM o.ot").data[0].x == 7, "the attached database is queryable through o.name");
lastError = attempt(function():void { conn.attach("o", attached); });
check(lastError != null && lastError.errorID == 3125, "attaching a name already in use is #3125");
check(lastSqlError.details.indexOf("already in use") >= 0, "details, got " + lastSqlError.details);
lastError = attempt(function():void { conn.attach("", attached); });
check(lastError != null && lastError.errorID == 3102, "an empty attach name is ArgumentError #3102");
check(lastError.message == "Error #3102: Name argument specified was invalid. It must not be null or empty.",
      "the #3102 message, got " + lastError.message);
conn.detach("o");
check(events.indexOf("attach") >= 0 && events.indexOf("detach") >= 0, "attach/detach events: " + events);
lastError = attempt(function():void { conn.detach("o"); });
check(lastError != null && lastError.errorID == 3115, "detaching twice is #3115");
check(lastSqlError.details.indexOf("no such database") >= 0, "details, got " + lastSqlError.details);
lastError = attempt(function():void { conn.detach(null); });
check(lastError != null && lastError.errorID == 3102, "detach(null) is ArgumentError #3102");
check(lastError.message == "Error #3102: Name argument specified was invalid. It must not be null or empty.",
      "the #3102 message, got " + lastError.message);
lastError = attempt(function():void { conn.begin("bogus"); });
check(lastError != null && lastError.errorID == 3112, "begin with a bad lock type is ArgumentError #3112");
check(lastError.message == "Error #3112: An invalid transaction lock type was specified.", "the #3112 message, got " + lastError.message);

// ---- close -------------------------------------------------------------------
conn.begin();
runSql("INSERT INTO t (v) VALUES ('in flight')");
check(conn.lastInsertRowID == 3, "lastInsertRowID tracks the third insert, got " + conn.lastInsertRowID);
conn.close();
check(conn.connected == false, "close() disconnects");
check(conn.inTransaction == false, "close() ends the transaction");
check(conn.lastInsertRowID == 0 && conn.totalChanges == 0, "row counters reset on close");
check(conn.columnNameStyle == "default", "columnNameStyle resets on close");
check(conn.pageSize == 0 && conn.cacheSize == 0, "pageSize/cacheSize are 0 while closed");
conn.close();
check(events.length >= 2 && events[events.length - 1] == "close", "a second close() still dispatches CLOSE: " + events);
lastError = attempt(function():void { st.execute(); });
check(lastError != null && lastError.errorID == 3104, "executing after close is the PLAIN #3104, got " + (lastError == null ? "no error" : "" + lastError.errorID));
check(lastError.message == "Error #3104: A SQLConnection must be open to perform this operation.", "the #3104 message, got " + lastError.message);
lastError = attempt(function():void { conn.loadSchema(SQLTableSchema); });
check(lastError != null && lastError.errorID == 3104, "loadSchema after close is #3104");

trace("sqlite-phase-b: ok");
