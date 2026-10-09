// iface-builtin-accessor.as — 接口访问器由「内建访问器型属性」满足。
//
// AIR 把 DisplayObject 的 x/y/name/visible/alpha/rotation/scaleX/scaleY/blendMode/
// transform 与 InteractiveObject 的鼠标/焦点属性声明为**访问器对**（`get x`/`set x`），
// 因此一个继承 Sprite 的类**不写任何 getter** 也能满足
//     interface IPos { function get x():Number; function set x(v:Number):void; ... }
// 而用户的 `public var x` **不能**满足（AIR 的 mxmlc 会拒绝：未实现 interface 方法 x）。
// 本子集此前把内建属性建成**普通字段**，pass 4 的一致性检查只认 getters/setters，
// 于是这类接口实现被误判为「未实现」并 CodegenError——talkmed-meeting 闭包里
// com.vsdevelop.components.ItemRenderer 一系（`extends Component implements
// IItemRenderer`，靠继承拿到 x/y/width/height）正因此编译不过。
//
// 现按 AIR 口径放行：一致性检查接受「内建访问器型字段」，并为接口 vtable 生成
// 读写该（已扁平化的）字段槽的小 thunk。两个方向都以 `adl 51.4.1` 为裁判——
// 放行形态（extends Sprite）、拒绝形态（用户 var / extends Point / extends
// Rectangle / Event.bubbles）见 temp/accprobe*/，运行期值日志见 temp/ifacc/。
package { public interface IPos {
  function get x():Number; function set x(v:Number):void;
  function get y():Number; function set y(v:Number):void;
} }

package { import flash.display.Sprite; public class PosBox extends Sprite implements IPos {
  public function PosBox() { super(); }
} }

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

var box:PosBox = new PosBox();
var ipos:IPos = box;

// 经接口访问器写 —— 必须落到继承来的内建属性上。
ipos.x = 10;
ipos.y = 20.5;
check(box.x == 10 && box.y == 20.5, "write through the interface accessor reaches the inherited built-in property");
check(ipos.x == 10 && ipos.y == 20.5, "read through the interface accessor returns that same value");
check((ipos.x + ipos.y) == 30.5, "interface accessor values participate in arithmetic");

// 反向：直接写内建属性也须被接口读到（同一存储）。
box.x = 3;
check(ipos.x == 3, "a direct write to the built-in property is visible through the interface");

// 类型判定不受影响。
check(box is IPos, "the class is an instance of the interface it satisfies");

trace("iface-builtin-accessor: interface accessors satisfied by inherited built-in properties OK");