// builtin-class.as — 阶段一百二十七：内建类注册表 & Class 值 + in/delete/下标（批次1 + 批次3）。
//
// 全部期望值来自 `adl 51.4.1` 实测（证据台 temp/pkg1/oracle/*.txt、temp/pkg1d/oracle/
// adl-idi.txt），每一条断言都对应一处 adl 输出：
//   · adl-pkg1.txt : C1/C4/C6/C7、E2/E3/E8/E9、D2 的 #1065 文案
//   · adl-na.txt   : NA 内建类可作 Class 值
//   · adl-b3.txt   : Array/Vector 的 `in`、`delete`（无效 no-op 返回 true）、动态 is/as
//   · adl-b3b.txt  : 动态 `*` 接收者上的 `in`/`delete`
//   · adl-vd.txt   : Vector 的 in/delete 边界（length/越界/负数/字符串键）
//   · adl-idi.txt  : IDataInput/IDataOutput 的 is/as、ByteArray.writeDouble 字节序
//
// 仍未断言的一处（登记在 TODO.md 遗留表，非本示例的覆盖范围）：
//   `getQualifiedClassName(5)`（AIR 是 `int`，我们仍是 `Number`）。
//
// 阶段三百三十三（v0.4.294）起，第 10~14 节把「值位置上的类名」补齐：包装类
// （String/Number/int/uint/Boolean）、接口、`Vector.<T>`、`Function`/`Class` 都是
// 真正的 Class 值，`Vector.<T>` 也带自己的反射名；`extends` 内建类继承来的接口
// 同样参与 `is`/`as`（此前 Sprite 自己的 implements 为空，`new Sprite() is
// IEventDispatcher` 在我们这里是 false，adl 是 true —— 真 bug，已修）。
import flash.utils.getQualifiedClassName;
import flash.display.BitmapData;
import flash.geom.Point;
import flash.utils.getDefinitionByName;
import flash.utils.ByteArray;
import flash.utils.IDataInput;
import flash.utils.IDataOutput;
import flash.net.Socket;
import flash.net.URLStream;
import flash.utils.Endian;

function check(cond:Boolean, msg:String):void {
	if (!cond) throw new Error("FAIL: " + msg);
}

// ---- 1. 内建类可作 Class 值：字符串形式、is Class、相等性 -------------------
// adl: C1=[class BitmapData] C4=[class Object] C7=true E2=[class BitmapData]
check(String(BitmapData) == "[class BitmapData]", "BitmapData class value string");
check(String(Object) == "[class Object]", "Object class value string");
check((BitmapData is Class), "BitmapData is Class");
check((Object is Class), "Object is Class");
var c1:Class = BitmapData;
check(c1 == BitmapData, "class value identity");
check(String(c1) == "[class BitmapData]", "class value string through a Class variable");
// adl: E3=true —— 内建 Object 类作 Class 值时，任何原始值 `is` 都为 true。
var c2:Class = Object;
check((5 is c2), "5 is <Object class>");
// adl: E8=true —— 另一内建类（该探针用 Number）不认这个原始值。这里改用同族的
// int 包装类不可用（未注册），故用 BitmapData：两者语义都是「类不匹配 → false」。
check(!(5 is c1), "5 is <BitmapData class> is false");

// ---- 2. getDefinitionByName 命中内建注册表，未命中报 #1065 ------------------
check(getQualifiedClassName(getDefinitionByName("flash.display.BitmapData")) == "flash.display::BitmapData",
	"getDefinitionByName finds a builtin");
// adl-na.txt: NA=[class NativeApplication] —— AIR 里它确实存在（旧探针曾误当缺失）。
check(String(getDefinitionByName("flash.desktop::NativeApplication")) == "[class NativeApplication]",
	"getDefinitionByName finds NativeApplication");
// adl: D2=ERR#1065<Error #1065: Variable NoSuchClass is not defined.>
var caught:Boolean = false;
try {
	getDefinitionByName("com.example::NoSuchClass");
} catch (e:Error) {
	caught = true;
	check(e.errorID == 1065, "missing definition reports #1065 (got #" + e.errorID + ")");
	// 文案里只留最后一段（`.` 或 `::` 之后），与 AIR 一致。
	check(e.message.indexOf("NoSuchClass is not defined") >= 0, "missing definition message (" + e.message + ")");
}
check(caught, "getDefinitionByName on a missing name throws");

// ---- 3. Array 的 `in` 与下标键 ---------------------------------------------
// adl-b3.txt: a0=true a1=false aK=true aLen=true
var a:Array = ["x"];
check(0 in a, "array index 0 in");
check(!(1 in a), "array index beyond length not in");
check("0" in a, "array index as string key in");
check("length" in a, "array length in");

// ---- 4. Vector 的 `in` / `delete`（无效 no-op 返回 true） -------------------
// adl-vd.txt: inLen/in0=true, in5/inN1/inF/inX=false
var v:Vector.<int> = new Vector.<int>();
v[0] = 1;
check("length" in v, "vector length in");
check(0 in v, "vector index 0 in");
check(!(5 in v), "vector index 5 not in");
check(!(-1 in v), "vector index -1 not in");
check(!("lengthx" in v), "vector unknown key not in");
// adl-vd.txt: typed={del0:true,len:2,e0:7,del5:true,delS:true,deln1:true}
var w:Vector.<int> = new Vector.<int>();
w[0] = 7;
w[1] = 8;
check(delete w[0], "delete vector index returns true");
check(w.length == 2 && w[0] == 7, "delete on a Vector is a no-op");
check(delete w[5], "delete vector out-of-range returns true");
check(delete w[-1], "delete vector negative index returns true");
var named:Boolean = delete w["length"];
check(named && w.length == 2, "delete vector property returns true and is a no-op");

// ---- 5. 动态接收者上的 is/as Vector.<T>、in、delete ------------------------
// adl-b3.txt: v2is=true v2isN=false v2isA=false arrV=false
var v2:* = new Vector.<int>();
check((v2 is Vector.<int>), "dynamic is Vector.<int>");
check(!(v2 is Vector.<Number>), "dynamic is Vector.<Number> is false");
check(!(v2 is Array), "dynamic is Array is false");
check(!([] is Vector.<int>), "[] is Vector.<int> is false");
// adl-b3b.txt: vLen=true vK=true（向量里确实有下标 0）vS=false vDelS=true
var vd2:* = new Vector.<int>();
vd2[0] = 7;
check("length" in vd2, "dynamic vector length in");
check("0" in vd2, "dynamic vector index 0 in");
check(!("x" in vd2), "dynamic vector unknown key not in");
check(delete vd2["x"], "dynamic delete vector property is true");
// 空向量的下标 0 还不是「已定义」的成员（与 adl-vd.txt 的 in5=false 同口径）。
check(!(0 in v2), "empty dynamic vector index 0 not in");

// ---- 6. 动态键在普通对象与 Array 上 ---------------------------------------
// adl-b3b.txt: fooIn=true fooNot=false objK=true objN=false
var dyn:* = { foo: 1 };
check("foo" in dyn, "dynamic object key in");
check(!("bar" in dyn), "dynamic object missing key not in");
var arr2:* = [];
arr2["k"] = 5;
check("k" in arr2, "dynamic array named key in");
check(!("kk" in arr2), "dynamic array missing named key not in");

// ---- 7. IDataInput / IDataOutput 注册（批次1d） ----------------------------
// adl-idi.txt: I1..I6 = true,true / true,true / true,false（URLStream 只读）
var ba:ByteArray = new ByteArray();
var us:URLStream = new URLStream();
check((ba is IDataInput) && (ba is IDataOutput), "ByteArray is both byte interfaces");
check((us is IDataInput), "URLStream is IDataInput");
check(!(us is IDataOutput), "URLStream is not IDataOutput");
check(!((null as Object) is IDataInput), "null is not IDataInput");
check(!(({} as Object) is IDataInput), "plain object is not IDataInput");
var iface:IDataInput = ba;
check(iface.bytesAvailable == 0, "interface-typed bytesAvailable");
check(getQualifiedClassName(iface) == "flash.utils::ByteArray", "interface-typed class name");
// 继承而来的实现也满足接口（TLSSocket 那一类的写法）。
var back2:IDataOutput = ba as IDataOutput;
check(back2 != null, "as IDataOutput");

// ---- 8. ByteArray.writeDouble 的字节序（adl-idi.txt W1/W2、oracle/adl-dbl.txt） ----
// AIR 实测（temp/pkg1d/oracle/adl-dbl.txt）：little-endian 的 1.0 是
// 00 00 00 00 00 00 F0 3F（b7=63）、big-endian 是 3F F0 00 00 00 00 00 00（b0=63）；
// 不是「先写高 32 位再写低 32 位」。
ba.length = 0;
ba.endian = Endian.LITTLE_ENDIAN;
ba.writeDouble(1.0);
check(ba.length == 8, "writeDouble writes 8 bytes");
check((ba[0] & 255) == 0 && (ba[3] & 255) == 0 && (ba[4] & 255) == 0 && (ba[7] & 255) == 63, "writeDouble little-endian bytes");
ba.position = 0;
check(ba.readDouble() == 1, "readDouble round-trips writeDouble (little-endian)");
ba.length = 0;
ba.endian = Endian.BIG_ENDIAN;
ba.writeDouble(1.0);
check((ba[0] & 255) == 63 && (ba[3] & 255) == 0 && (ba[7] & 255) == 0, "writeDouble big-endian bytes");
ba.position = 0;
check(ba.readDouble() == 1, "readDouble round-trips writeDouble (big-endian)");
ba.length = 0;
ba.endian = Endian.LITTLE_ENDIAN;
ba.writeFloat(1.0);
check(ba.length == 4 && (ba[0] & 255) == 0 && (ba[3] & 255) == 63, "writeFloat stays 4 bytes");

// ---- 9. 一个「自己声明 implements」的类（TLSSocket 形状） ------------------
// 关键不是运行，而是**通过 pass 4**：IDataInput/IDataOutput 的成员全部由
// Socket 提供，子类不得（也不必）重写。它若编译不过，本示例就编不过。
class TLSish extends Socket implements IDataInput, IDataOutput {
	public function TLSish() {
		super();
	}
}

check(true, "a class restating IDataInput/IDataOutput over Socket compiles");
// ---- 10. 包装类作 Class 值（阶段三百三十三） ------------------------------
// adl 51.4.1（temp/gprobe A 系列）：String/Number/int/uint/Boolean 与普通内建类
// 一样是 Class 值，`is Class`、`is <该 Class 值>`、getDefinitionByName 往返都对。
var cStr:Class = String;
var cNum:Class = Number;
var cInt:Class = int;
var cUint:Class = uint;
var cBool:Class = Boolean;
check(cStr is Class && cNum is Class && cInt is Class, "wrapper classes are Class values");
check(cUint is Class && cBool is Class, "uint/Boolean classes are Class values");
check(String(cStr) == "[class String]", "wrapper class string form");
check(getQualifiedClassName(cStr) == "String", "wrapper class name");
check(("x" is cStr), "a String is <String class>");
check(!(5 is cStr), "a Number is not <String class>");
check((5 is cNum), "a Number is <Number class>");
check((5 is cInt), "a Number 5 is <int class>");
check(!(5.5 is cInt), "5.5 is not <int class>");
check((true is cBool) && !(0 is cBool), "Boolean class coercion test");
check(getDefinitionByName("String") == cStr, "getDefinitionByName finds String");
check(getDefinitionByName("flash.utils.ByteArray") == ByteArray, "getDefinitionByName finds ByteArray");
// `new (cStr)("hi")` 走的是与 `String("hi")` 相同的转换（adl: [hi]）。
var sNew:Object = new cStr("hi");
check(sNew == "hi", "new <String class>(x) coerces like String(x)");
check(getQualifiedClassName(new cStr()) == "String", "new <String class>() is an empty String");

// ---- 11. Vector.<T> 作 Class 值 -------------------------------------------
// adl（temp/gprobe C 系列）：字符串是 `[class Vector.<int>]`，限定名带
// `__AS3__.vec::` 前缀，`new (cV)()` 是空的 Vector，不同元素类型互不相等。
var cV:Class = Vector.<int>;
check(String(cV) == "[class Vector.<int>]", "Vector.<int> class string");
check(getQualifiedClassName(cV) == "__AS3__.vec::Vector.<int>", "Vector.<int> qualified name");
check(String(Vector.<String>) == "[class Vector.<String>]", "Vector.<String> class string");
check(cV is Class, "Vector.<int> is Class");
check((new Vector.<int>() is cV), "a Vector.<int> is <Vector.<int> class>");
check(!(new Vector.<String>() is cV), "a Vector.<String> is not <Vector.<int> class>");
check(!([] is cV), "a plain Array is not <Vector.<int> class>");
check(getDefinitionByName("__AS3__.vec.Vector.<int>") == cV, "getDefinitionByName finds Vector.<int>");
check(Vector.<int> == Vector.<int>, "Vector.<int> class value identity");
check(!(Vector.<int> == Vector.<uint>), "different element types are different classes");
var vNew:* = new cV();
check(getQualifiedClassName(vNew) == "__AS3__.vec::Vector.<int>", "new <Vector.<int> class>() is a Vector");
check(vNew.length == 0, "new <Vector.<int> class>() is empty");

// ---- 12. 接口作 Class 值 ---------------------------------------------------
// adl（temp/gprobe B 系列）：接口本身是 Class 值，`is`/`as` 走实现关系，
// 继承来的实现同样算数（Sprite 自己没有写 implements IEventDispatcher）。
var cIE:Class = IEventDispatcher;
check(String(cIE) == "[class IEventDispatcher]", "interface class string");
check(getQualifiedClassName(cIE) == "flash.events::IEventDispatcher", "interface qualified name");
check(cIE is Class, "an interface is a Class value");
check(getDefinitionByName("flash.events.IEventDispatcher") == cIE, "getDefinitionByName finds the interface");
check((new Sprite() is cIE), "a Sprite is <IEventDispatcher class>");
check((new EventDispatcher() is cIE), "an EventDispatcher is <IEventDispatcher class>");
check(!(({} as Object) is cIE), "a plain object is not <IEventDispatcher class>");
check((new Sprite() as cIE) != null, "as <IEventDispatcher class>");
check((5 as cIE) == null, "a Number as <IEventDispatcher class> is null");
check(IEventDispatcher == cIE, "interface class value identity");
// 静态形式（右操作数是写死的接口名）与 Class 变量形式口径一致。
check((new Sprite() is IEventDispatcher), "static is IEventDispatcher on a built-in subclass");
check((new EventDispatcher() is IEventDispatcher), "static is IEventDispatcher on EventDispatcher");
var anyIE:* = new Sprite();
check((anyIE is IEventDispatcher), "dynamic is IEventDispatcher");

// ---- 13. Function / Class 作值 --------------------------------------------
// adl（temp/gprobe N1-N6）：两者都是 Class 值；`new (Function)()` 是空函数值，
// `new (Function)("a","return 7")` 是 AIR 自己也不支持的 #1066，
// `new (Class)()` 是 #1115。
check(Function is Class, "Function is Class");
check(Class is Class, "Class is Class");
check(String(Function) == "[class Function]", "Function class string");
check(String(Class) == "[class Class]", "Class class string");
check(getQualifiedClassName(Function) == "Function", "Function qualified name");
check(getDefinitionByName("Function") == Function, "getDefinitionByName finds Function");
check(getDefinitionByName("Class") == Class, "getDefinitionByName finds Class");
var cFn:Class = Function;
var emptyFn:* = new cFn();
check((emptyFn is Function), "new (Function)() is a Function");
check((emptyFn is cFn), "new (Function)() is <Function class>");
check(String(emptyFn) == "function Function() {}", "new (Function)() string form");
check((typeof emptyFn) == "function", "new (Function)() typeof");
var cCls:Class = Class;
var caught1115:Boolean = false;
try {
	new cCls();
} catch (e:Error) {
	caught1115 = true;
	check(e.errorID == 1115, "new (Class)() reports #1115 (got #" + e.errorID + ")");
}
check(caught1115, "new (Class)() throws");
var caught1066:Boolean = false;
try {
	new cFn("a", "return 7");
} catch (e:Error) {
	caught1066 = true;
	check(e.errorID == 1066, "new Function(body) reports #1066 (got #" + e.errorID + ")");
}
check(caught1066, "new Function('function body') throws");

// ---- 14. extends 内建类 ----------------------------------------------------
// mxmlc/adl 51.4.1 实测（temp/gprobe7）：Point / ByteArray / Error / Event /
// Sprite 一系的子类行为与普通类一致 —— 继承字段、super(args)、is、限定名。
// 数组/字典/日期三类的子类在 adl 里**自己**就跑不通（见 TODO.md 增强表：
// `extends Array`/`extends Dictionary` 动态写 #1056、`extends Date` 带参构造
// #1107，都是 AIR 侧限制），故这里不作运行期断言。
class MyPoint extends Point {
	public var tag:String = "mine";
	public function MyPoint(px:Number = 0, py:Number = 0) {
		super(px, py);
	}
	public function len2():Number {
		return x * x + y * y;
	}
}
class MyBytes extends ByteArray {
	public function MyBytes() {
		super();
	}
}

var mp:MyPoint = new MyPoint(3, 4);
// adl: point-len=25 point-tag=mine point-is="true true" point-qc=MyPoint
check(mp.len2() == 25, "a subclass method reads inherited fields");
check(mp.tag == "mine", "a subclass declares its own fields");
check((mp is Point) && (mp is Object), "a subclass is its built-in base");
check(getQualifiedClassName(mp) == "MyPoint", "a subclass reports its own name");
check(getDefinitionByName("MyPoint") == MyPoint, "getDefinitionByName finds a user class");
mp.x = 6;
check(mp.len2() == 52, "an inherited setter keeps working after a subclass write");
var mbc:MyBytes = new MyBytes();
mbc.writeByte(7);
mbc.position = 0;
// adl: bytes="7 true MyBytes"
check(mbc.readByte() == 7, "a ByteArray subclass is a real byte stream");
check(mbc is ByteArray, "a ByteArray subclass is a ByteArray");
check(getQualifiedClassName(mbc) == "MyBytes", "a ByteArray subclass reports its own name");
