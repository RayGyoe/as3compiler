// describeType: AIR-aligned trait reflection.
//
// The reflection XML is what a generic model mapper runs on: its
// BaseModel.fromJSON walks describeType(this)..variable / ..accessor and assigns
// every declared field from a parsed JSON object. The runtime used to emit a
// CHILDLESS <type name="fqn"/> element, so that loop never ran, every model field
// stayed at its AS3 default, and a later null dereference of an unset nested
// model surfaced as an uncaught #1009 (which in turn killed the whole process).
//
// This pins the AIR shape, measured on adl 51.4.1 (temp/dtor):
//   * instance view: base + isDynamic/isFinal/isStatic, the full
//     extendsClass/implementsInterface chains, then the traits.
//   * only PUBLIC traits; `variable`/`constant` carry no declaredBy, while
//     `accessor`/`method` do; access is readonly/writeonly/readwrite.
//   * a method carries returnType and one <parameter index/type/optional> per
//     declared parameter -- a REST parameter is not listed.
//   * Object's own traits (toString, hasOwnProperty, ...) are never listed, not
//     even for a plain object.
//   * Class view: base="Class", the Class/Object extendsClass pair, the
//     Class.prototype accessor and the instance traits under <factory>.
import flash.utils.describeType;
import flash.utils.Dictionary;
import flash.utils.getDefinitionByName;
import flash.utils.getQualifiedClassName;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

class Cfg {
  public var is_live_edit:int;
  public var label:String;

  public function fromJSON(j:*):void {
    var o:Object = (j is String) ? JSON.parse(j) : j;
    for each (var p:XML in describeType(this)..variable) {
      var n:String = p.@name;
      if (o.hasOwnProperty(n)) this[n] = o[n];
    }
  }
}

class User {
  public var id:Number;
  public var nick:String;

  public function fromJSON(j:*):void {
    var o:Object = (j is String) ? JSON.parse(j) : j;
    for each (var p:XML in describeType(this)..variable) {
      var n:String = p.@name;
      if (o.hasOwnProperty(n)) this[n] = o[n];
    }
  }
}

interface Tagged {
  function tagName():String;
}

class Room implements Tagged {
  public var id:Number;
  public var title:String;
  public var cfg:Cfg;
  public var user:User;
  public var tags:Array;
  public var live:Boolean;
  public const KIND:int = 9;
  private var _hidden:int;

  public function get rw():String { return "x"; }
  public function set rw(v:String):void { }
  public function plain(a:int, b:String = "q", ...rest):Object { return null; }
  public function tagName():String { return "room"; }
  private function secret():void { }

  public function fromJSON(j:String):void {
    var o:Object = JSON.parse(j);
    for each (var p:XML in describeType(this)..variable) {
      var n:String = p.@name;
      var ty:String = p.@type;
      if (!o.hasOwnProperty(n)) continue;
      if (ty == "Cfg" || ty == "User") {
        var cl:Class = getDefinitionByName(ty) as Class;
        var sub:* = new cl();
        sub.fromJSON(o[n]);
        this[n] = sub;
      } else {
        this[n] = o[n];
      }
    }
  }
}

var r:Room = new Room();
var t:XML = describeType(r);

// --- instance view: the type element's own attributes ---------------------
check(t.@name == "Room", "instance name, got " + t.@name);
check(t.@base == "Object", "instance base, got " + t.@base);
check(t.@isDynamic == "false", "isDynamic, got " + t.@isDynamic);
check(t.@isFinal == "false", "isFinal, got " + t.@isFinal);
check(t.@isStatic == "false", "isStatic, got " + t.@isStatic);

// --- trait sets -----------------------------------------------------------
check((t..variable).length() == 6, "6 public vars, got " + (t..variable).length());
check((t..constant).length() == 1, "1 constant, got " + (t..constant).length());
check((t..accessor).length() == 1, "1 accessor, got " + (t..accessor).length());

var names:String = "";
for each (var v:XML in t..variable) {
  names += v.@name + ",";
  check(v.@declaredBy == "", "a variable has no declaredBy (an absent attribute reads as empty, as in AIR)");
}
check(names.indexOf("id,") >= 0 && names.indexOf("tags,") >= 0, "public vars listed, got " + names);
check(names.indexOf("_hidden") < 0, "private var must not be listed");

check(t..accessor[0].@name == "rw", "accessor name");
check(t..accessor[0].@access == "readwrite", "accessor access, got " + t..accessor[0].@access);
check(t..accessor[0].@declaredBy == "Room", "accessor declaredBy");
check(t..constant[0].@name == "KIND", "constant name");

// --- methods: returnType, parameters, no rest, no Object traits -----------
var sawPlain:Boolean = false;
var plainParams:int = -1;
var nMethods:int = 0;
for each (var m:XML in t..method) {
  nMethods++;
  check(m.@declaredBy == "Room", "method declaredBy must be Room, got " + m.@declaredBy);
  check(m.@returnType != null && m.@returnType != "", "method has a returnType");
  if (m.@name == "plain") { sawPlain = true; plainParams = (m..parameter).length(); }
}
check(sawPlain, "public method plain listed");
check(plainParams == 2, "rest parameter must NOT be listed, got " + plainParams);
check(nMethods == 3, "plain/fromJSON/tagName, got " + nMethods);

// --- chains ---------------------------------------------------------------
check((t..extendsClass).length() == 1 && t..extendsClass[0].@type == "Object", "extendsClass chain");
check((t..implementsInterface).length() == 1 && t..implementsInterface[0].@type == "Tagged", "implementsInterface chain");

// --- Class view -----------------------------------------------------------
var c:XML = describeType(Room);
check(c.@name == "Room", "class-view name, got " + c.@name);
check(c.@base == "Class" && c.@isStatic == "true", "class-view base/isStatic");
check((c..extendsClass).length() == 2, "class view extendsClass = Class + Object");
check((c..factory).length() == 1 && c..factory[0].@type == "Room", "instance traits under <factory>");

// --- plain object and core containers ------------------------------------
var po:XML = describeType({});
check(po.@name == "Object" && po.@base == "", "a plain object has no base");
check((po..variable).length() == 0 && (po..method).length() == 0, "Object's own traits are not listed");

check(describeType([]).@name == "Array", "array name");
check(describeType([])..accessor[0].@name == "length", "array length accessor");
check(describeType(new Vector.<int>()).@name == "__AS3__.vec::Vector.<int>", "vector name");
check(describeType(new Vector.<int>()).@isFinal == "true", "a Vector is final");
check(describeType(new Dictionary()).@name == "flash.utils::Dictionary", "dictionary name");
check(describeType(1).@name == "int", "an integral value reflects as int (adl: describeType(1) is int)");
check(describeType(1.5).@name == "Number", "a fractional value reflects as Number");
check(describeType(268435456).@name == "Number", "a value above the 2^28 window reflects as Number");
check(String(describeType(null)) == "", "describeType(null) is empty");

// --- the model-mapper pattern the runtime change had to unblock ----------
r.fromJSON('{"id":62136,"title":"test2","cfg":{"is_live_edit":1,"label":"L"},"user":{"id":119,"nick":"n"},"tags":[1,2],"live":true}');
check(r.id == 62136, "numeric field, got " + r.id);
check(r.title == "test2", "string field, got " + r.title);
check(r.cfg != null && r.cfg.is_live_edit == 1, "nested model field (this is the #1009 that used to kill the app)");
check(r.cfg.label == "L", "nested model second field");
check(r.user != null && r.user.id == 119, "second nested model");
check(r.tags != null && r.tags.length == 2, "Array field");
check(r.live == true, "Boolean field");
// A dynamic read of an Array-typed field must box as an Array, not as an object
// whose first word is the array's data pointer (that read used to crash).
var dynTags:* = r["tags"];
check(dynTags is Array, "dynamic read of an Array field boxes as Array");
check(r["cfg"] is Cfg, "dynamic read of a nested model field");

trace("describe-type: all assertions passed");
