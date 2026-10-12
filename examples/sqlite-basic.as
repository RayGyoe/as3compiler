// Stage 139 — phase A of flash.data / SQLite (docs/zh-cn/flash-data.md): the
// minimum closed loop a local AIR database offers — open a database file, create
// a table, INSERT rows with bound parameters, SELECT them back as an Array of
// Objects, read the result metadata, and roll a transaction back.
//
// The engine is the official SQLite amalgamation, which is not an approximation:
// AIR's PLAINTEXT databases ARE standard SQLite files (host `sqlite3` reads them
// back and the header is "SQLite format 3\0" — the measurement behind that claim
// is docs/zh-cn/flash-data.md §3.4). So the semantics asserted here are SQLite's
// own, reached through AIR's API shape.
//
// Every assertion below is pinned to what `adl 51.4.1` actually does, measured in
// temp/sqladl and temp/sql2 (the oracle harnesses): `data` is NULL — not an empty
// Array — for a statement with no result rows, `parameters` is read-only and reset
// with clearParameters(), a DEFERRED begin() reports inTransaction == false until a
// statement touches the database, and getResult() is a FIFO queue that returns null
// once drained.
//
// The build links the engine automatically: src/index.ts::usesFlashData sees the
// flash.data references below and adds vendor/sqlite/sqlite3.c plus
// vendor/sqlite_glue.c and -DASC_HAVE_SQLITE. Without those references the
// preamble's stub keeps the build self-contained (and every open() fails loudly).
import flash.data.SQLConnection;
import flash.data.SQLStatement;
import flash.data.SQLResult;
import flash.data.SQLMode;
import flash.data.SQLTransactionLockType;
import flash.errors.SQLError;
import flash.events.SQLEvent;
import flash.filesystem.File;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// temp/ is the repo's scratch area: the example must not litter its source dir.
var dbFile:File = new File("temp/sqlite-basic.db");
if (dbFile.exists) dbFile.deleteFile();

var events:Array = [];
function onEvent(e:SQLEvent):void { events.push(e.type); }

var conn:SQLConnection = new SQLConnection();
for each (var t:String in [SQLEvent.OPEN, SQLEvent.CLOSE, SQLEvent.BEGIN, SQLEvent.COMMIT, SQLEvent.ROLLBACK]) {
  conn.addEventListener(t, onEvent);
}
check(SQLConnection.isSupported, "SQLConnection.isSupported is true");
check(conn.connected == false, "a fresh connection is not connected");
check(conn.inTransaction == false, "no transaction before open");
check(conn.columnNameStyle == "default", "columnNameStyle defaults to DEFAULT");
check(conn.pageSize == 0, "pageSize is 0 while closed, got " + conn.pageSize);
check(conn.cacheSize == 0, "cacheSize is 0 while closed, got " + conn.cacheSize);
check(conn.totalChanges == 0, "totalChanges is 0 while closed");
check(conn.autoCompact == false, "autoCompact is false while closed");

conn.open(dbFile, SQLMode.CREATE);
check(conn.connected, "open() connects");
check(dbFile.exists, "open() created the database file");
check(events.indexOf("open") >= 0, "open() dispatched SQLEvent.OPEN");
check(conn.pageSize == 1024, "pageSize is the 1024 default we passed to open(), got " + conn.pageSize);
check(conn.cacheSize == 2000, "cacheSize defaults to 2000 pages, got " + conn.cacheSize);

var st:SQLStatement = new SQLStatement();
st.sqlConnection = conn;
check(st.sqlConnection == conn, "sqlConnection round-trips");

// DDL: no result rows at all -- AIR reports data == null (not an empty Array) and
// complete == true. getResult() is a consuming queue, so one call per statement.
st.text = "CREATE TABLE people (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, age REAL)";
st.execute();
var ddl:SQLResult = st.getResult();
check(ddl.complete, "a DDL result is complete");
check(ddl.data == null, "a DDL result has data == null, got " + ddl.data);
check(ddl.rowsAffected == 0, "a DDL result affects 0 rows, got " + ddl.rowsAffected);
check(st.getResult() == null, "getResult() returns null once the queue is drained");

// `parameters` is READ-ONLY in AIR: mutate the object the getter hands back and
// reset it with clearParameters().
st.text = "INSERT INTO people (name, age) VALUES (:name, :age)";
st.parameters[":name"] = "Ada";
st.parameters[":age"] = 36;
st.execute();
var ins:SQLResult = st.getResult();
check(ins.rowsAffected == 1, "one row inserted, got " + ins.rowsAffected);
check(ins.lastInsertRowID == 1, "the INSERT result carries its rowid, got " + ins.lastInsertRowID);
check(conn.lastInsertRowID == 1, "lastInsertRowID is 1, got " + conn.lastInsertRowID);
check(conn.totalChanges == 1, "totalChanges is 1, got " + conn.totalChanges);

st.clearParameters();
st.parameters[":name"] = "Grace";
st.parameters[":age"] = 45;
st.execute();
check(st.getResult().rowsAffected == 1, "the second insert affected one row");
check(conn.lastInsertRowID == 2, "second insert advances lastInsertRowID");

// SELECT back: each row is an Object keyed by column name, SQLite's INTEGER column
// comes back as a Number and TEXT as a String.
st.clearParameters();
st.text = "SELECT id, name, age FROM people ORDER BY id";
st.execute();
var res:SQLResult = st.getResult();
check(res.complete, "a SELECT result is complete");
check(res.data.length == 2, "two rows, got " + res.data.length);
check(res.data[0].name == "Ada", "row 0 name, got " + res.data[0].name);
check(res.data[1].name == "Grace", "row 1 name, got " + res.data[1].name);
check(res.data[0].id == 1, "row 0 id is 1");
check(res.data[1].id == 2, "row 1 id is 2");
check(res.data[1].age == 45, "row 1 age is 45");
check(conn.totalChanges == 2, "totalChanges is 2 after two inserts, got " + conn.totalChanges);

// A SELECT that matches nothing reports data == null, not an empty Array.
st.text = "SELECT id FROM people WHERE name = 'nobody'";
st.execute();
check(st.getResult().data == null, "an empty SELECT reports data == null");

// An aggregate and a column alias.
st.text = "SELECT COUNT(*) AS n FROM people";
st.execute();
var agg:SQLResult = st.getResult();
check(agg.data[0].n == 2, "COUNT(*) is 2, got " + agg.data[0].n);

// AIR validates the parameter count BEFORE stepping: an unbound named parameter is
// reported, never silently bound to NULL. Measured shape: SQLError #3115 with
// detailID 1004 and detailArguments [1, 0, ":a"].
st.text = "SELECT * FROM people WHERE name = :who";
try {
  st.execute();
  check(false, "an unbound parameter must be reported");
} catch (e:SQLError) {
  check(e.errorID == 3115, "SQLError.errorID is 3115, got " + e.errorID);
  check(e.detailID == 1004, "SQLError.detailID is 1004, got " + e.detailID);
  check(e.operation == "execute", "SQLError.operation is 'execute', got " + e.operation);
  check(e.message == "Error #3115: SQL Error.", "SQLError.message, got " + e.message);
  check(e.detailArguments.length == 3 && e.detailArguments[2] == ":who", "detailArguments, got " + e.detailArguments);
}

// A failing statement raises a SQLError (not a plain Error): #3115 with SQLite's own
// message as `details`.
try {
  st.text = "SELECT * FROM nope";
  st.execute();
  check(false, "a missing table must be reported");
} catch (e2:SQLError) {
  check(e2.errorID == 3115, "a missing table is #3115, got " + e2.errorID);
  check(e2.operation == "execute", "the failing operation is 'execute'");
  check(e2.details.indexOf("nope") >= 0, "details names the table, got " + e2.details);
}

// A transaction that rolls back must undo its work. NOTE the measured inTransaction
// semantics: a DEFERRED begin() reports FALSE until a statement touches the
// database, so the assertion comes after the INSERT, not after begin().
st.text = "INSERT INTO people (name, age) VALUES ('Rolled', 1)";
conn.begin();
check(conn.inTransaction == false, "a deferred begin() alone does not open a transaction");
st.execute();
// Every execute() queues exactly one result, so the INSERT's must be drained before
// the next SELECT looks at getResult() (the queue is FIFO -- measured).
var inTxnInsert:SQLResult = st.getResult();
check(inTxnInsert.rowsAffected == 1, "the transactional insert affected one row");
check(conn.inTransaction, "after a write inside the transaction inTransaction is true");
conn.rollback();
check(conn.inTransaction == false, "rollback() closes the transaction");
st.text = "SELECT COUNT(*) AS n FROM people";
st.execute();
var afterRollback:SQLResult = st.getResult();
check(afterRollback.data[0].n == 2, "rollback undid the insert, got " + afterRollback.data[0].n);

// ...and one that commits must stick. begin(IMMEDIATE) reports true at once.
conn.begin(SQLTransactionLockType.IMMEDIATE);
check(conn.inTransaction, "begin(IMMEDIATE) opens a transaction immediately");
st.text = "INSERT INTO people (name, age) VALUES ('Kept', 2)";
st.execute();
check(st.getResult().rowsAffected == 1, "the committed insert affected one row");
conn.commit();
check(conn.inTransaction == false, "commit() closes the transaction");
st.text = "SELECT COUNT(*) AS n FROM people";
st.execute();
var afterCommit:SQLResult = st.getResult();
check(afterCommit.data[0].n == 3, "commit kept the insert, got " + afterCommit.data[0].n);
check(events.indexOf("begin") >= 0 && events.indexOf("commit") >= 0 && events.indexOf("rollback") >= 0,
      "begin/commit/rollback events were dispatched: " + events);

// Once closed, the reported state is again the "not connected" state.
conn.close();
check(conn.connected == false, "close() disconnects");
check(conn.pageSize == 0 && conn.cacheSize == 0, "pageSize/cacheSize return to 0");
check(events.indexOf("close") >= 0, "close() dispatched SQLEvent.CLOSE");

// isSupported is a STATIC property in AIR (SQLConnection.isSupported), which is what
// made this phase need Class-value static-getter dispatch.
check(SQLConnection.isSupported, "the static isSupported getter is reachable via the class");

trace("sqlite-basic: ok");
