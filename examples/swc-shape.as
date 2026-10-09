// swc-shape.as — 阶段九十五 E/F：SWC 矢量 shape + 显示树 + 九宫格 + 按钮四态的结构回归。
//
// 与 swc-bitmap.as 同一套样本（`temp/skin.swc`），但看的是**另一半资源**：`DefineShape*`
// 与 `DefineSprite` 烘焙出的显示树、`DefineScalingGrid` 九宫格、`DefineButton2` 按钮四态。
// 判据刻意只取**与后端无关的结构层**：
//   · 导出符号（sprite `元件97`、按钮 `upvpage`）在编译期被合成为 AST 类，
//     `getDefinitionByName` 能拿到、能 `new`、且类型正确（Sprite / SimpleButton 子类）；
//   · 构造器里 `as_swc_bind` 把烘焙显示树挂上去 ⇒ `numChildren > 0`、子件类型正确；
//   · 按钮的**几何命中**按 AIR 口径走（hit 态是普通 Shape，不是 InteractiveObject），
//     `hitTestPoint(..., true)` 在按钮可见区域返回 true、在远处返回 false。
// 纯 C 构建（无 Skia）下 `sk_path_*`/`as_skia_*` 都是空桩、画不出像素，但**对象树本身仍然建起来**，
// 故上述结构断言两侧都成立；渲染层面的九宫格/四态对照见 docs/zh-cn/swc.md §9.2。
//
// 编译（结构层）：  as-aot examples/swc-shape.as --swc ../temp/skin.swc --run
// 编译（渲染层）：  as-aot examples/swc-shape.as --manifest examples/swc-bitmap.build.json --run

import flash.display.DisplayObject;
import flash.display.Sprite;
import flash.display.SimpleButton;
import flash.display.MovieClip;
import flash.display.FrameLabel;
import flash.text.TextField;
import flash.utils.getDefinitionByName;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// ---- ① 导出 sprite（元件97，带 DefineScalingGrid #545）----
var sprCls:Class = getDefinitionByName("\u5143\u4ef697") as Class;
check(sprCls != null, "getDefinitionByName must resolve the exported sprite 元件97");
var spr:DisplayObject = new sprCls() as DisplayObject;
check(spr is Sprite, "the exported sprite must be a Sprite");
check((spr as Sprite).numChildren > 0, "the baked display tree must be attached in the constructor");

// ---- ② 导出按钮（upvpage，DefineButton2）----
var btnCls:Class = getDefinitionByName("upvpage") as Class;
check(btnCls != null, "getDefinitionByName must resolve the exported button upvpage");
var btn:DisplayObject = new btnCls() as DisplayObject;
check(btn is SimpleButton, "the exported button must be a SimpleButton");
// SimpleButton 在 AIR 里 extends InteractiveObject（**不是** DisplayObjectContainer），
// 所以它没有 numChildren——不要照 Sprite 断言。

// ---- ③ 按钮几何命中（AIR 口径：按 hit 态的几何，而非交互性）----
// upvpage 的可见画面实测约 200x20 逻辑像素，位于自身 (4,-4)-(196,16)。
var hit:Boolean = btn.hitTestPoint(btn.x + 100, btn.y + 6, true);
check(hit, "hitTestPoint must hit the button's hit state (geometric, not interactive)");
check(!btn.hitTestPoint(btn.x + 4000, btn.y + 4000, true), "hitTestPoint must miss far away");

// ---- ④ 九宫格只由 SWF tag 烘焙而来（AS3 侧无 scale9Grid 属性，见 TODO.md 遗留表）----
// 这里只能断言缩放不改变对象树结构；拉伸效果本身在 temp/swc-render（swc.md §9.2 F1）里与 adl 对照。
var before:Number = spr.width;
spr.scaleX = 2;
check(spr.scaleX == 2, "scaling a gridded sprite must be settable");
check(spr.width > 0 && before > 0, "the gridded sprite must have a measurable width");

// ---- ⑤ `PlaceObject3` 的 `Visible = 0`：AIR **建**子件但置 `visible = false` ----
// `vbitemskin`（#293）第 1 帧有 6 条 placement，depth 6（#286）带 `Visible = 0`。
// 实测 `adl 51.4.1`（`temp/vishidden/`）：`numChildren` 是 **6**（不是 5）——子件仍在
// 显示列表里，只是 `visible == false`。故烘焙侧设 `visible = false` 而**不是**跳过该 placement
// （见 docs/zh-cn/swc.md §9.2 F3）。
var vbCls:Class = getDefinitionByName("vbitemskin") as Class;
check(vbCls != null, "getDefinitionByName must resolve the exported sprite vbitemskin");
var vb:Sprite = new vbCls() as Sprite;
check(vb.numChildren == 6, "a PlaceObject3 with Visible=0 must still create its child (AIR: 6 children)");
var hiddenCount:int = 0;
for (var vi:int = 0; vi < vb.numChildren; vi++) {
  if (!vb.getChildAt(vi).visible) hiddenCount++;
}
check(hiddenCount == 1, "exactly the one Visible=0 placement must be invisible");

// ---- ⑥ `PlaceObject3` 的 FILTERLIST / BlendMode / BitmapCached ----
// 这三样原先**解析后被静默丢弃**。adl 51.4.1 从同一份 SWF 字节重建的滤镜对象
// （`temp/attrsprobe/`）钉住了每个字段：`#343 staticskin` depth 1（字符 #324）挂
// `Glow{color:0xff000000, blurX:16, blurY:16, strength:0.19921875, quality:1}`，
// `homeskin` depth 2 是 `darken`，`mymtskin`/`subtitleskin` 带 BitmapCached。
function filtersOf(c:DisplayObject):Array { return c.filters; }
function glowOf(c:DisplayObject):GlowFilter {
  var fl:Array = c.filters;
  if (fl == null || fl.length == 0) return null;
  return fl[0] as GlowFilter;
}
var stuck:Class = getDefinitionByName("staticskin") as Class;
var sk:Sprite = new stuck() as Sprite;
var glowCount:int = 0;
for (var si:int = 0; si < sk.numChildren; si++) {
  var gl:GlowFilter = glowOf(sk.getChildAt(si));
  // AIR reports GlowFilter.color as RGB only (the record's RGBA alpha byte 0xff
  // becomes GlowFilter.alpha == 1, measured in temp/attrsprobe), so this black
  // glow reads back as colour 0.
  if (gl != null && gl.blurX == 16 && gl.color == 0) {
    glowCount++;
    // FIXED8 51/256 is an exact double, so this comparison is exact, not a tolerance.
    check(gl.strength == 0.19921875, "a baked glow must keep the SWF strength (0.19921875 == 51/256)");
    check(gl.quality == 1, "a baked glow must keep the SWF quality");
  }
}
check(glowCount == 1, "exactly one child of staticskin carries the baked Glow (adl: depth 1, char #324)");

var homeCls:Class = getDefinitionByName("homeskin") as Class;
var home:Sprite = new homeCls() as Sprite;
var darkCount:int = 0;
var normalCount:int = 0;
for (var hi:int = 0; hi < home.numChildren; hi++) {
  var bm:String = home.getChildAt(hi).blendMode;
  if (bm == "darken") darkCount++;
  if (bm == "normal") normalCount++;
}
check(darkCount == 1, "homeskin must keep its one darken placement (adl: depth 2, BlendMode 6)");

// userskin carries two BlendMode.LAYER placements (adl: depth 4 and 6).
var usCls:Class = getDefinitionByName("userskin") as Class;
var us:Sprite = new usCls() as Sprite;
var layerCount:int = 0;
for (var ui:int = 0; ui < us.numChildren; ui++) {
  if (us.getChildAt(ui).blendMode == "layer") layerCount++;
}
check(layerCount == 2, "userskin must keep both layer placements (adl: depth 4 and 6)");

// editnickname's glow is blur 17 (adl: temp/attrsprobe, depth 1).
var edCls:Class = getDefinitionByName("editnickname") as Class;
var ed:Sprite = new edCls() as Sprite;
var edGlow:GlowFilter = glowOf(ed.getChildAt(0));
check(edGlow != null && edGlow.blurX == 17, "editnickname's baked glow must keep its 17px blur (adl: depth 1)");
check(normalCount + darkCount == home.numChildren, "every child must carry a non-null blendMode string (AIR defaults to normal)");

var mmCls:Class = getDefinitionByName("mymtskin") as Class;
var mm:Sprite = new mmCls() as Sprite;
var cached:int = 0;
for (var mi:int = 0; mi < mm.numChildren; mi++) {
  if (mm.getChildAt(mi).cacheAsBitmap) cached++;
}
check(cached == 1, "mymtskin must keep its one BitmapCached placement visible to cacheAsBitmap");

// ---- ⑦ 子件数与 x/y 对齐（阶段九十五·八）----
// AIR 的显示树里，`DefineText`/`DefineEditText` 与 `DefineMorphShape` 都是**真实子件**，
// clipDepth 遮罩对象本身也是（`temp/childfx/`，adl 51.4.1）：staticskin 19 个子件、
// loginskin 9 个（c1 是遮罩对象）、fileitemskin 5 个（c2 内部 4 个，含 morph 遮罩）。
// 原先这三类都被整个丢弃，子件数与索引顺序都偏少（swc.md §9.2 F5）。
var sk2:Sprite = new (getDefinitionByName("staticskin") as Class)() as Sprite;
check(sk2.numChildren == 19, "staticskin must have AIR's 19 children (text characters are children)");
var t0:DisplayObject = sk2.getChildAt(1);
check(t0 is TextField, "staticskin child 1 must be a TextField (AIR: flash.text::TextField)");
// TextField 子件的位置 = placement 平移 + 字符 RECT 原点（其余子件直接就是平移）：
// 该字符 RECT 原点 (-5.2,-2)、placement 平移 (14.45,57.7) ⇒ AIR 侧 x=9.25 / y=55.7。
check(t0.x == 9.25 && t0.y == 55.7, "a text child's x/y must be placement.translation + RECT origin");
check((t0 as TextField).width == 79.4 && (t0 as TextField).height == 19.95, "a text child's box must be the SWF RECT size (AIR: exactly 79.4x19.95)");

var fi2:Sprite = new (getDefinitionByName("fileitemskin") as Class)() as Sprite;
check(fi2.numChildren == 5, "fileitemskin must have AIR's 5 children");
var nested:Sprite = fi2.getChildAt(2) as Sprite;
check(nested != null && nested.numChildren == 4, "元件77_265 must keep AIR's 4 children (incl. the morph mask)");
check(nested.getChildAt(1) is Shape, "the morph placeholder must be a Shape (AIR: flash.display::MorphShape)");

var lg2:Sprite = new (getDefinitionByName("loginskin") as Class)() as Sprite;
check(lg2.numChildren == 9, "loginskin must have AIR's 9 children (the clipDepth mask object is a child)");
check(lg2.getChildAt(1) is Shape && lg2.getChildAt(1).visible, "a mask object stays a visible child (AIR: vis=true)");

// 拆分 placement 矩阵：平移进子件自身 x/y（与 AIR 逐位一致），2x2 留在 transform.matrix。
// popchatitem c0（元件97，带 DefineScalingGrid）在 SWF 里被拉伸到 sx=1.4973 / sy=1.2：
// x/y 必须与 AIR 相同，而自身 scaleX/scaleY 必须仍是 1——否则我们自己的九宫格会误触发
// （§9.2 F1，实测：让它在 placement 拉伸下生效会让 42 条 entry 全部离 adl 更远）。
var pc2:Sprite = new (getDefinitionByName("popchatitem") as Class)() as Sprite;
var pc0:DisplayObject = pc2.getChildAt(0);
check(pc0.scaleX == 1 && pc0.scaleY == 1, "a placement stretch must live in transform.matrix, not in scaleX/scaleY");
check(pc0.transform.matrix.a == 1.497314453125 && pc0.transform.matrix.d == 1.1999969482421875, "transform.matrix must read AIR's composed placement matrix");

// ---- ⑧ 时间轴烘焙（阶段九十五·九）----
// 多帧 DefineSprite 的**关键帧差值**在编译期烘焙成 `as_swc_tl_*` 表，运行期
// `gotoAndStop`/`nextFrame`/`prevFrame`/`currentLabels` 逐项对齐 adl 51.4.1
// （证据：temp/tlprobe/，68 行 API 对照 0 差异）。四个符号的期望值全部来自 adl：
var dsi:MovieClip = new (getDefinitionByName("desktopshareitem") as Class)() as MovieClip;
check(dsi.totalFrames == 21, "desktopshareitem must report AIR's 21 frames");
check(dsi.currentFrame == 1 && dsi.currentLabel == "_up" && dsi.currentFrameLabel == "_up", "frame 1 must be labelled _up");
// AIR 的皮肤符号在 DoABC 里第 1 帧 stop()（我们读不到），所以烘焙剪辑**起始停在第 1 帧**：
check(!dsi.isPlaying, "a baked clip must start stopped on frame 1 (adl never auto-advances it either)");
check(dsi.currentLabels.length == 3, "desktopshareitem must carry AIR's 3 FrameLabels");
var fl0:FrameLabel = dsi.currentLabels[1] as FrameLabel;
check(fl0.name == "_over" && fl0.frame == 8, "currentLabels[1] must be _over@8 in AIR's order");
dsi.gotoAndStop("_down");
check(dsi.currentFrame == 15 && dsi.currentLabel == "_down", "gotoAndStop(\"_down\") must land on AIR's frame 15");
check(dsi.numChildren == 4, "a modify-only rollover frame keeps all 4 children (frame-8/15 art swaps)");
dsi.gotoAndStop(1); dsi.nextFrame();
check(dsi.currentFrame == 2, "nextFrame must advance 1 -> 2");
dsi.prevFrame();
check(dsi.currentFrame == 1, "prevFrame must step back to 1");

// 帧 2 = 「RemoveObject2(深度 2) + 在深度 3 放新字符」：删记录必须生效，否则会多出一个子件
// （原先 RemoveObject2 被解析器**静默丢弃**，adl 报 3 个子件、我们报 4 —— 本阶段修掉）。
var tb:MovieClip = new (getDefinitionByName("toastbtn") as Class)() as MovieClip;
check(tb.totalFrames == 2 && tb.numChildren == 3, "toastbtn frame 1 must have AIR's 3 children");
tb.gotoAndStop(2);
check(tb.currentFrame == 2 && tb.numChildren == 3, "the frame-2 RemoveObject2 must keep the child count at 3");
tb.prevFrame();
check(tb.currentFrame == 1 && tb.numChildren == 3, "prevFrame must rebuild frame 1 with 3 children");

// 帧 2 的**替换/修改**记录：文本子件被移动到 x=200/20 + RECT 原点(-2) = 8（AIR 实测 8），
// 回退到第 1 帧时重新构树 ⇒ 回到 24。
var cb:MovieClip = new (getDefinitionByName("checkbom") as Class)() as MovieClip;
check(cb.totalFrames == 2 && cb.getChildAt(1).x == 24, "checkbom frame 1 must place the label at x=24");
cb.gotoAndStop(2);
check(cb.currentFrame == 2 && cb.getChildAt(1).x == 8, "a frame-2 modify must move the text child to AIR's x=8");
cb.prevFrame();
check(cb.currentFrame == 1 && cb.getChildAt(1).x == 24, "a backward jump must rebuild the frame-1 placement");

var m3:MovieClip = new (getDefinitionByName("skin_fla.元件172_339") as Class)() as MovieClip;
check(m3.totalFrames == 3 && m3.numChildren == 1, "元件172_339 must report AIR's 3 frames / 1 child");

check(true, "swc-shape structural checks passed");
trace("swc-shape-ok");