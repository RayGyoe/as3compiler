// Stage 139 — phase D of flash.data / SQLite (docs/zh-cn/flash-data.md): the schema
// objects. loadSchema() reads sqlite_master into a SQLSchemaResult of SQLTableSchema /
// SQLViewSchema / SQLIndexSchema / SQLTriggerSchema (each a SQLSchema carrying the
// database, the name and the CREATE statement), dispatches a "schema" event on the
// connection and queues the result for getSchemaResult().
//
// Measured on adl 51.4.1 (temp/sql2 rounds 3/4/8 and temp/sql3):
//   * only USER-created objects are reported -- the indexes SQLite creates for
//     UNIQUE/PRIMARY KEY constraints have a NULL sql and are skipped, so a table
//     declared "UNIQUE" reports no index while an explicit CREATE INDEX does.
//   * a view IS a SQLTableSchema (`view is SQLTableSchema` holds), so its columns and
//     its sql are readable through the table API.
//   * a loadSchema that matches nothing is an ERROR (not an empty result): #3115 with
//     detailID 1007 (name given), 1009 (type only) or 1010 (neither), and
//     detailArguments carrying the name/type/database that were searched.
import flash.data.SQLConnection;
import flash.data.SQLStatement;
import flash.data.SQLResult;
import flash.data.SQLMode;
import flash.data.SQLSchema;
import flash.data.SQLSchemaResult;
import flash.data.SQLTableSchema;
import flash.data.SQLViewSchema;
import flash.data.SQLIndexSchema;
import flash.data.SQLTriggerSchema;
import flash.data.SQLColumnSchema;
import flash.errors.SQLError;
import flash.events.SQLEvent;
import flash.filesystem.File;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// AIR rejects a relative path in the File constructor (#2004): OS temp dir instead.
var scratch:File = File.createTempDirectory();
var dbFile:File = scratch.resolvePath("sqlite-phase-d.db");
if (dbFile.exists) dbFile.deleteFile();

var conn:SQLConnection = new SQLConnection();
var st:SQLStatement = new SQLStatement();
var schemaEvents:int = 0;
conn.addEventListener(SQLEvent.SCHEMA, function(e:SQLEvent):void { schemaEvents++; });

var lastError:Error = null;
var lastSqlError:SQLError = null;
function attempt(f:Function):Error {
  lastError = null; lastSqlError = null;
  try { f(); } catch (e:Error) { lastError = e; if (e is SQLError) lastSqlError = e as SQLError; }
  return lastError;
}

conn.open(dbFile, SQLMode.CREATE);
st.sqlConnection = conn;

function run(sql:String):SQLResult { st.text = sql; st.execute(); return st.getResult(); }

// AUTOINCREMENT makes SQLite create its own sqlite_sequence table, which AIR does NOT
// report (measured): the schema lists below hold only the objects created here.
run("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT NOT NULL, n INTEGER DEFAULT 3)");
run("CREATE TABLE empty_tbl (a TEXT)");
run("CREATE UNIQUE INDEX idx_v ON t (v)");
run("CREATE VIEW vw AS SELECT id, v FROM t");
run("CREATE TRIGGER trg AFTER INSERT ON t BEGIN UPDATE t SET n = n WHERE id = NEW.id; END");
run("INSERT INTO t (v) VALUES ('a')");

// ---- a table, with its columns -------------------------------------------------
conn.loadSchema(SQLTableSchema, "t");
var one:SQLSchemaResult = conn.getSchemaResult();
check(one != null, "loadSchema queued a result");
check(conn.getSchemaResult() == null, "getSchemaResult() is drained by the first call");
check(one.tables.length == 1, "one table named t, got " + one.tables.length);
check(one.views.length == 0 && one.indices.length == 0 && one.triggers.length == 0,
      "the other three lists stay empty when a type was given");
var tbl:SQLTableSchema = one.tables[0];
check(tbl is SQLTableSchema, "a table IS a SQLTableSchema");
check(tbl.name == "t", "the table name, got " + tbl.name);
check(tbl.database == "main", "the default database is main, got " + tbl.database);
check(tbl.sql.indexOf("CREATE TABLE") == 0, "sql is the CREATE statement, got " + tbl.sql);
check(tbl.columns.length == 3, "three columns, got " + tbl.columns.length);
var c0:SQLColumnSchema = tbl.columns[0];
check(c0.name == "id", "column 0 is id, got " + c0.name);
check(c0.dataType == "INTEGER", "its declared type, got " + c0.dataType);
check(c0.primaryKey, "id is the primary key");
check(c0.autoIncrement, "AUTOINCREMENT is reported from the CREATE text");
check(c0.allowNull == false, "a primary key does not allow null");
check(c0.defaultCollationType == "binary", "the default collation, got " + c0.defaultCollationType);
var c1:SQLColumnSchema = tbl.columns[1];
check(c1.name == "v" && !c1.primaryKey && !c1.allowNull, "v is NOT NULL and not the key");
check(c1.dataType == "TEXT", "v is TEXT, got " + c1.dataType);
var c2:SQLColumnSchema = tbl.columns[2];
check(c2.name == "n" && c2.allowNull, "n allows null");
check(c2.autoIncrement == false, "n is not auto-increment");
check(schemaEvents == 1, "loadSchema dispatched one schema event, got " + schemaEvents);

// includeColumnSchema = false: the schema comes back without columns.
conn.loadSchema(SQLTableSchema, "empty_tbl", "main", false);
var noCols:SQLSchemaResult = conn.getSchemaResult();
check((noCols.tables[0] as SQLTableSchema).columns != null && (noCols.tables[0] as SQLTableSchema).columns.length == 0,
      "columns is an EMPTY Array when includeColumnSchema is false (measured), got " + (noCols.tables[0] as SQLTableSchema).columns);

// ---- every object in one call (type = null) -----------------------------------
conn.loadSchema(null);
// A type of null reports all four kinds at once.
var all:SQLSchemaResult = conn.getSchemaResult();
check(all.tables.length == 2, "both user tables and no sqlite_sequence, got " + all.tables.length);
check(all.views.length == 1, "the view, got " + all.views.length);
check(all.indices.length == 1, "ONLY the explicit index, got " + all.indices.length);
check(all.triggers.length == 1, "the trigger, got " + all.triggers.length);
var vw:SQLViewSchema = all.views[0];
check(vw is SQLTableSchema, "a view IS a SQLTableSchema too (measured)");
check(vw.name == "vw", "the view name, got " + vw.name);
check(vw.sql.indexOf("CREATE VIEW") == 0, "the view sql, got " + vw.sql);
check(all.indices[0].name == "idx_v", "the index name, got " + all.indices[0].name);
check((all.indices[0] as SQLIndexSchema).table == "t", "an index reports its table");
check(all.triggers[0].name == "trg", "the trigger name, got " + all.triggers[0].name);
check((all.triggers[0] as SQLTriggerSchema).table == "t", "a trigger reports its table");
check(all.tables[0] is SQLSchema && all.tables[1] is SQLSchema, "everything extends SQLSchema");

// ---- each kind on its own ------------------------------------------------------
conn.loadSchema(SQLViewSchema);
var views:SQLSchemaResult = conn.getSchemaResult();
check(views.views.length == 1 && views.tables.length == 0, "loadSchema(SQLViewSchema) reports views only");
conn.loadSchema(SQLIndexSchema);
var idx:SQLSchemaResult = conn.getSchemaResult();
check(idx.indices.length == 1 && idx.indices[0].sql.indexOf("CREATE UNIQUE INDEX") == 0,
      "the index's own sql, got " + idx.indices[0].sql);
conn.loadSchema(SQLTriggerSchema);
var trg:SQLSchemaResult = conn.getSchemaResult();
check(trg.triggers.length == 1, "the trigger list");

// ---- the three "nothing found" reports ----------------------------------------
// A name that does not exist: #3115, detailID 1007, arguments (name, type, database).
lastError = attempt(function():void { conn.loadSchema(SQLTableSchema, "nosuch"); });
check(lastError != null && lastError.errorID == 3115, "nothing found is a SQLError #3115, got " + (lastError == null ? "no error" : "" + lastError.errorID));
check(lastSqlError != null && lastSqlError.detailID == 1007, "detailID 1007 for a name, got " + (lastSqlError == null ? "no SQLError" : "" + lastSqlError.detailID));
check(lastSqlError.details == "The schema object with name 'nosuch' of type 'table' in database 'main' was not found.",
      "the detail text, got " + lastSqlError.details);
check(lastSqlError.operation == "schema", "the operation, got " + lastSqlError.operation);
check(lastSqlError.detailArguments.length == 3 && lastSqlError.detailArguments[0] == "nosuch"
      && lastSqlError.detailArguments[1] == "table" && lastSqlError.detailArguments[2] == "main",
      "the arguments, got " + lastSqlError.detailArguments);
// A type with no objects at all: detailID 1009, arguments (type, database).
lastError = attempt(function():void { conn.loadSchema(SQLViewSchema, null, "main"); });
check(lastError == null, "an EMPTY view list still found the view, so no error");
var vw2:SQLSchemaResult = conn.getSchemaResult();
check(vw2 != null && vw2.views.length == 1, "the view is still found");
conn.loadSchema(SQLTableSchema, "empty_tbl");
check(conn.getSchemaResult().tables.length == 1, "empty_tbl is found while it exists");
run("DROP TABLE empty_tbl");
lastError = attempt(function():void { conn.loadSchema(SQLTableSchema, "empty_tbl"); });
check(lastSqlError != null && lastSqlError.detailID == 1007, "a dropped table is a 1007, got " + (lastSqlError == null ? "no SQLError" : "" + lastSqlError.detailID));

// A failed loadSchema queues NOTHING, so the next getSchemaResult() is null.
check(conn.getSchemaResult() == null, "a failed loadSchema does not queue a result");
check(schemaEvents == 8, "only successful loadSchema calls dispatch the event, got " + schemaEvents);

// ---- a type with no objects: detailID 1009, arguments (type, database) --------
run("DROP TRIGGER trg");
lastError = attempt(function():void { conn.loadSchema(SQLTriggerSchema); });
check(lastSqlError != null && lastSqlError.detailID == 1009, "an empty type is a 1009, got " + (lastSqlError == null ? "no SQLError" : "" + lastSqlError.detailID));
check(lastSqlError.details == "No schema objects with type 'trigger' in database 'main' were found.",
      "the 1009 text, got " + lastSqlError.details);
check(lastSqlError.detailArguments.length == 2 && lastSqlError.detailArguments[0] == "trigger"
      && lastSqlError.detailArguments[1] == "main", "the 1009 arguments, got " + lastSqlError.detailArguments);

// ---- an empty database: detailID 1010, arguments (database) -------------------
var blank:SQLConnection = new SQLConnection();
var blankFile:File = scratch.resolvePath("sqlite-phase-d-blank.db");
if (blankFile.exists) blankFile.deleteFile();
blank.open(blankFile, SQLMode.CREATE);
lastError = attempt(function():void { blank.loadSchema(null); });
check(lastSqlError != null && lastSqlError.detailID == 1010, "an empty database is a 1010, got " + (lastSqlError == null ? "no SQLError" : "" + lastSqlError.detailID));
check(lastSqlError.details == "No schema objects in database 'main' were found.",
      "the 1010 text, got " + lastSqlError.details);
check(lastSqlError.detailArguments.length == 1 && lastSqlError.detailArguments[0] == "main",
      "the 1010 arguments, got " + lastSqlError.detailArguments);
check(blank.getSchemaResult() == null, "the blank connection queued nothing");
blank.close();
blankFile.deleteFile();

conn.close();
trace("sqlite-phase-d: ok");
