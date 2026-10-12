// Stage 139 — phase C of flash.data / SQLite (docs/zh-cn/flash-data.md): the
// SQLStatement surface — prefetch/next to page through a result, executing, cancel,
// itemClass to build typed rows, and the SQLUpdateEvent that AIR dispatches once per
// changed ROW from the CONNECTION.
//
// The prefetch contract below is the one adl 51.4.1 actually implements (measured in
// temp/sql2 round 4/5), which is NOT "the number of rows per call" as documented:
//   * prefetch == -1 (the default): every remaining row, complete = true.
//   * prefetch > 0: at most that many rows, complete = false, executing = true; the
//     call that runs the cursor out reports data == null and complete = true.
//   * prefetch == 0 or any other negative value: the statement runs to the end and
//     NO row is reported at all -- data == null, complete = true.
//   * next() on a complete result raises #3107, and a chunk with no rows reports
//     data == null (never an empty Array).
import flash.data.SQLConnection;
import flash.data.SQLStatement;
import flash.data.SQLResult;
import flash.data.SQLMode;
import flash.errors.SQLError;
import flash.events.SQLEvent;
import flash.events.SQLUpdateEvent;
import flash.filesystem.File;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// The class itemClass rows are built from: the row's columns are written into its
// properties instead of into a plain Object.
class Person {
  public var id:Number = 0;
  public var v:String = null;
}

var dbFile:File = new File("temp/sqlite-phase-c.db");
if (dbFile.exists) dbFile.deleteFile();

var conn:SQLConnection = new SQLConnection();
var st:SQLStatement = new SQLStatement();
var updates:Array = [];
conn.addEventListener(SQLUpdateEvent.INSERT, function(e:SQLUpdateEvent):void { updates.push("insert:" + e.rowID + ":" + e.table); });
conn.addEventListener(SQLUpdateEvent.UPDATE, function(e:SQLUpdateEvent):void { updates.push("update:" + e.rowID + ":" + e.table); });
conn.addEventListener(SQLUpdateEvent.DELETE, function(e:SQLUpdateEvent):void { updates.push("delete:" + e.rowID + ":" + e.table); });
// A statement-level listener must NOT see them: AIR dispatches SQLUpdateEvent from the
// SQLConnection (measured A/B/C in temp/sql2 round 4).
var stUpdates:Array = [];
st.addEventListener(SQLUpdateEvent.INSERT, function(e:SQLUpdateEvent):void { stUpdates.push(e.rowID); });

var lastError:Error = null;
var lastSqlError:SQLError = null;
function attempt(f:Function):Error {
  lastError = null; lastSqlError = null;
  try { f(); } catch (e:Error) { lastError = e; if (e is SQLError) lastSqlError = e as SQLError; }
  return lastError;
}

conn.open(dbFile, SQLMode.CREATE);
st.sqlConnection = conn;
check(st.sqlConnection == conn, "sqlConnection round-trips");
check(st.executing == false, "a fresh statement is not executing");
// Measured on adl 51.4.1: an unset text is the EMPTY STRING (not null), and an unset
// itemClass is the Object CLASS (not null), so plain rows are built as Objects.
check(st.text == "", "text starts as the empty string, got " + st.text);
check(st.parameters != null, "parameters is a live object before anything is set");
check(st.itemClass == Object, "itemClass starts as the Object class, got " + st.itemClass);

function run(sql:String):SQLResult { st.text = sql; st.execute(); return st.getResult(); }
// The prefetch argument lives on execute() (there is no prefetch property in AIR).
function run2(sql:String, prefetch:int):SQLResult { st.text = sql; st.execute(prefetch); return st.getResult(); }

run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
run("INSERT INTO t (v) VALUES ('a')");
run("INSERT INTO t (v) VALUES ('b')");
run("INSERT INTO t (v) VALUES ('c')");
run("INSERT INTO t (v) VALUES ('d')");

// ---- one SQLUpdateEvent per changed row, from the connection -------------------
check(updates.length == 4, "one insert event per row, got " + updates.length + " -> " + updates);
check(updates[0] == "insert:1:t" && updates[3] == "insert:4:t", "row ids and table name, got " + updates);
check(stUpdates.length == 0, "the statement does NOT dispatch update events, got " + stUpdates);
updates = [];
run("UPDATE t SET v = 'x'");
check(updates.length == 4 && updates[0] == "update:1:t", "an UPDATE reports every changed row, got " + updates);
updates = [];
run("DELETE FROM t WHERE id = 1");
check(updates.length == 1 && updates[0] == "delete:1:t", "a DELETE reports its row, got " + updates);

// ---- prefetch: several pages, then the terminating chunk ----------------------
var page1:SQLResult = run2("SELECT id, v FROM t ORDER BY id", 2);
check(page1.data.length == 2, "the first page has 2 rows, got " + (page1.data == null ? "null" : "" + page1.data.length));
check(page1.complete == false, "a limited page is not complete");
check(st.executing, "the statement is still executing while a cursor is open");
var page2:SQLResult = st.getResult();
check(page2 == null, "getResult() is drained by the first call");
st.next(2);
var page3:SQLResult = st.getResult();
check(page3.data.length == 1, "the second page holds the last row, got " + (page3.data == null ? "null" : "" + page3.data.length));
check(page3.complete == true, "the page that reached the end is complete");
check(st.executing == false, "the cursor closed at the end of the result");

// next() past the end is #3107, and prefetch = -1 takes everything at once.
lastError = attempt(function():void { st.next(); });
check(lastError != null && lastError.errorID == 3107, "next() on a complete result is #3107, got " + (lastError == null ? "no error" : "" + lastError.errorID));
check(lastError.message == "Error #3107: SQLStatement.next may not be called unless SQLResult.complete is false.",
      "the #3107 message, got " + lastError.message);
var all:SQLResult = run2("SELECT id FROM t ORDER BY id", -1);
check(all.data.length == 3 && all.complete, "the default prefetch takes every row, got " + all.data.length);

// execute() while a cursor is open is LEGAL in AIR: it finalizes the old cursor and
// runs again (measured "double execute ok"), which is what lets a statement be reused.
check(st.executing == false, "a completed execute() leaves executing false");
st.execute();
check(st.getResult().data.length == 3, "the re-executed statement produced a fresh result");

// The corner cases of the prefetch argument, all measured: a chunk with no rows is
// data == null, and 0 or a negative value other than -1 silently drops every row.
var empty:SQLResult = run2("SELECT id FROM t WHERE id = 999", 1);
check(empty.data == null && empty.complete, "an empty SELECT reports data == null and complete");
var dropped:SQLResult = run2("SELECT id FROM t ORDER BY id", 0);
check(dropped.data == null && dropped.complete, "prefetch 0 reports no rows at all");
var neg:SQLResult = run2("SELECT id FROM t ORDER BY id", -5);
check(neg.data == null && neg.complete, "a negative prefetch other than -1 drops the rows too");
var dml:SQLResult = run2("INSERT INTO t (v) VALUES ('e')", 1);
check(dml.data == null && dml.rowsAffected == 1 && dml.complete, "a DML result has data == null, complete and rowsAffected");

// ---- cancel -------------------------------------------------------------------
// cancel() stops executing and dispatches NOTHING -- SQLEvent.CANCEL exists but adl
// fires no event for either the statement or the connection (measured).
var events:Array = [];
conn.addEventListener(SQLEvent.CANCEL, function(e:SQLEvent):void { events.push("cancel"); });
st.text = "SELECT id FROM t ORDER BY id";
st.execute(1);
check(st.executing, "a prefetched statement is executing");
st.cancel();
check(st.executing == false, "cancel() stops executing");
check(events.length == 0, "cancel() dispatches no event, got " + events);
var afterCancel:SQLResult = st.getResult();
check(afterCancel != null && afterCancel.data.length == 1, "the chunk queued before the cancel is still deliverable");

// ---- itemClass ----------------------------------------------------------------
// With itemClass set, each row is an instance of that class and the columns are
// written into its properties instead of into a plain Object.
st.itemClass = Person;
st.text = "SELECT id, v FROM t ORDER BY id";
st.execute();
var rows:SQLResult = st.getResult();
check(rows.data[0] is Person, "rows are instances of itemClass, got " + rows.data[0]);
check((rows.data[0] as Person).v != null, "the columns land on the instance, got " + (rows.data[0] as Person).v);
st.itemClass = Object;

// ---- the statement contract violations ---------------------------------------
// Assigning null to either property raises TypeError #1009 and leaves the value alone
// (measured): AIR's setters dereference what they are given.
lastError = attempt(function():void { st.text = null; });
check(lastError != null && lastError.errorID == 1009, "text = null is TypeError #1009, got " + (lastError == null ? "no error" : "" + lastError.errorID));
// itemClass, unlike text, ACCEPTS null and then reads back as the Object class
// (measured): AIR normalizes it, so plain rows keep working.
st.text = "SELECT 1";
lastError = attempt(function():void { st.itemClass = null; });
check(lastError == null, "itemClass = null is accepted, got " + (lastError == null ? "" : "Error #" + lastError.errorID));
check(st.itemClass == Object, "itemClass reads back as Object, got " + st.itemClass);
check(st.text != null, "the text property kept its value");
// An EMPTY text is what makes #3108 fire.
st.text = "";
lastError = attempt(function():void { st.execute(); });
check(lastError != null && lastError.errorID == 3108, "execute() with an empty text is #3108, got " + (lastError == null ? "no error" : "" + lastError.errorID));
check(lastError.message == "Error #3108: Operation is not permitted when the SQLStatement.text property is not set.",
      "the #3108 message, got " + lastError.message);
var orphan:SQLStatement = new SQLStatement();
orphan.text = "SELECT 1";
lastError = attempt(function():void { orphan.execute(); });
check(lastError != null && lastError.errorID == 3109, "execute() with no connection is #3109, got " + (lastError == null ? "no error" : "" + lastError.errorID));
check(lastError.message == "Error #3109: Operation is not permitted when the SQLStatement.sqlConnection property is not set.",
      "the #3109 message, got " + lastError.message);
lastError = attempt(function():void { orphan.next(); });
check(lastError != null && lastError.errorID == 3107, "next() before execute is #3107");
lastError = attempt(function():void { st.execute(); });
check(lastError != null && lastError.errorID == 3108, "the failed execute left the empty text in place, so still #3108");

// A constraint violation is its own status: #3131 "Abort due to constraint violation."
run("CREATE TABLE u (id INTEGER PRIMARY KEY, w TEXT NOT NULL UNIQUE)");
run("INSERT INTO u (w) VALUES ('dup')");
lastError = attempt(function():void { st.text = "INSERT INTO u (w) VALUES ('dup')"; st.execute(); });
check(lastError != null && lastError.errorID == 3131, "a UNIQUE violation is #3131, got " + (lastError == null ? "no error" : "" + lastError.errorID));
check(lastError.message == "Error #3131: Abort due to constraint violation.", "the #3131 message, got " + lastError.message);

conn.close();
trace("sqlite-phase-c: ok");
