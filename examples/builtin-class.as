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
// 本阶段刻意**不**断言的两处（登记在 TODO.md 遗留表，非本示例的覆盖范围）：
//   `getQualifiedClassName(5)`（AIR 是 `int`，我们仍是 `Number`）、
//   `String`/`Number` 等包装类作 Class 值（我们是响亮的 CodegenError）。
import flash.utils.getQualifiedClassName;
import flash.display.BitmapData;
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