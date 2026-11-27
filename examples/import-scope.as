// import-scope.as — import 的作用域是「块」，不是「文件」。
//
// AS3 里 `package p { import a.C; ... }` 的 import 只在这个包块内可见，写在包块
// 之外的 import 只对文件级声明可见；两个方向都不泄漏，且 import 对整个块生效
// （写在声明后面也算）。四条都以 mxmlc 51.4.1 实测为裁判（temp/impscope/adl/）：
//   b: 文件级函数用包内 import        → 找不到类型 DisplayObject
//   c: 包内类用包外 import            → 找不到类型 DisplayObject
//   e: 包外 import 写在 package 之前  → 包内仍找不到类型
//   f: 包外 helper 类用包内 import    → 找不到类型 DisplayObject
//   g/h: import 写在声明之后          → 接受（块内提升）
//   d: 同名短名分属两包时，各自的解析互不干扰
//
// 这正是 Starling 的 Starling.as 的写法：包块 import starling.display.DisplayObject，
// 文件尾再 import flash.display.DisplayObject 给文件级 helper
// isNativeDisplayObjectEmpty 用（源码注释写着「put here to avoid naming conflicts」）。
// 此前自由函数不带 import 上下文，参数类型在**调用方**作用域里解析，于是
// helper(_nativeStage) 被判成 Stage → starling.display.DisplayObject 的隐式强转。
package {
  public class PkgScope {
    public function PkgScope() {}
    // 包块内 DisplayObject 仍是 alt 的那个（包外 import 不得改写它）。
    public function altTag():String { var o:DisplayObject = new DisplayObject(); return o.tag; }
    // 跨作用域调用：实参是 flash 的 Sprite，形参属于文件级作用域。
    public function helperIs(o:flash.display.Sprite):Boolean { return flashIsDisplayObject(o); }
    public function helperName(o:flash.display.Sprite):String { return flashTypeName(o); }
  }
  // 写在类之后：import 对整个包块生效。
  import alt.DisplayObject;
}

package alt { public class DisplayObject { public var tag:String = "alt"; } }

import flash.display.DisplayObject;
import flash.display.Sprite;
import flash.utils.getQualifiedClassName;

// 文件级函数的形参类型属于**文件级**作用域：这里的 DisplayObject 是 flash 的那个。
function flashIsDisplayObject(o:DisplayObject):Boolean { return o is DisplayObject; }
function flashTypeName(o:DisplayObject):String { return getQualifiedClassName(o); }

// 写在 import 之前的文件级函数：同样能看到本块后面那条 import。
function earlyHelper(o:Point):Boolean { return o == null; }
import flash.geom.Point;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

var s:Sprite = new Sprite();
var p:PkgScope = new PkgScope();

check(p.altTag() == "alt", "the package block keeps its own import of the same short name");
check(p.helperIs(s), "a free function's parameter resolves in its own file scope (flash.display.DisplayObject)");
check(p.helperName(s) == "flash.display::Sprite", "the argument keeps its real class across the scope boundary");
check(flashIsDisplayObject(s), "the same helper called from file scope agrees");
check(earlyHelper(null), "an import is visible to declarations written before it in the same block");
check(!flashIsDisplayObject(null), "null is not an instance of the file-scope class");

trace("import-scope: OK");