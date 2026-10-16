# `examples/textfield` — TextField 显示矩阵探针

「对齐 TextField 这座大山」的**尺子**。同一份程序在 AOT 与 AIR `adl` 两端跑，把每一格
TextField 显示自由度的**可观测数值**写成**同一格式**的报告，逐行 diff。

立项文档：[`docs/zh-cn/flash-text.md`](../../docs/zh-cn/flash-text.md)（§3 矩阵、§5 验收口径、§8 首次实测）。

## 文件

| 文件 | 作用 |
|---|---|
| `Main.as` | 探针本体（文档类 `Main extends Sprite`，ctor 调 `run()`，笼 `Main(ui)` 开第二条通道）。**adl 侧的入口** |
| `entry.as` | AOT 侧入口（顶层 `new Main();`）。目录单元把两个 `.as` 一起编译，顶层语句即 main |
| `UiMain.as` | adl 侧的 **UI 网格**文档类（mxmlc 只能拿无参构造的类当文档类 ⇒ `super(true)`） |
| `entry-ui.as` | AOT 侧的 UI 网格入口（`new Main(true)`）。在 `test/examples.ts` 的 `SKIP_FILES` 里 |
| `app.xml` | adl 描述符（窗口 `visible=false`；两个通道都不需要窗口） |
| `textfield.build.json` | AOT 链接清单（`ASC_USE_SKIA=1` + Skia/SDL 库；`textWidth`/`getLineMetrics`/离屏光栅都需 Skia 文本后端） |
| `run-adl.sh` / `run-aot.sh` | 通道一：两端各产一份数值报告到 `temp/textfield-oracle/` |
| `run-adl-ui.sh` / `run-aot-ui.sh` | 通道二：两端各产一份网格位图到 `temp/textfield-oracle-ui/` |
| `grid.py` | 把两端位图合成 PNG 并并排拼成对照图 |

`test/examples.ts` 把本目录当作一个目录单元（链 Skia）跑，作为回归——**只跑通道一**
（`entry.as` ⇒ `new Main()`），否则每次回归都会多写一个 4 MB 位图。

## 用法

```sh
# 真值裁判（AIR）——AIRSDK_HOME 指向 AIRSDK 根目录
AIRSDK_HOME=/path/to/AIRSDK_51.4.1 sh examples/textfield/run-adl.sh
# 被测方（本编译器）
sh examples/textfield/run-aot.sh
# 逐行 diff
diff temp/textfield-oracle/adl.txt temp/textfield-oracle/aot.txt
```

报告落点由 `File.applicationStorageDirectory` 决定：AIR 在
`~/Library/Application Support/textfieldprobe/Local Store/`，AOT 在
`~/Library/Application Support/as3aot/Local Store/`。

### 通道二：并排网格图（给人眼看）

报告只量**数值**——它看不见颜色（`textColor`/`<font color>`/`borderColor`/`backgroundColor`
一个都没进报告）、看不见粗斜下划线的**形状**，也看不见字形本身（衬线 vs 无衬线、CJK 回退、
`\t` 的宽度）。通道二把 42 个用例铺成一张带标签的 4 列网格，两端各出一张图，并排拼起来。

```sh
AIRSDK_HOME=/path/to/AIRSDK_51.4.1 sh examples/textfield/run-adl-ui.sh   # -> temp/textfield-oracle-ui/adl.raw
sh examples/textfield/run-aot-ui.sh                                       # -> temp/textfield-oracle-ui/aot.raw
python3 examples/textfield/grid.py \
    temp/textfield-oracle-ui/adl.raw temp/textfield-oracle-ui/aot.raw \
    temp/textfield-oracle-ui/grid-cmp.png
```

两条命令跑的是**同一段 AS3**（只差光栅器）：网格由 `BitmapData.draw(this)` 离屏光栅化，
`getPixels()` 取原始像素，写 `textfield-grid.raw`（头 `TFGRID 1 <W> <H>\n`，随后每像素 4 字节
`A,R,G,B`）。不开窗口、不截图、不管进程。三个口径细节（为什么格位用「声明盒」、为什么不
做像素 diff、为什么 alpha 合到白底）见 `docs/zh-cn/flash-text.md` §5.2；首次出图的结果见 §8.1。

## 报告格式（通道一，两端逐字相同）

```
# textfield-probe v1
case=<label> type=<dynamic|input> ml=<0|1> ww=<0|1> as=<none|left|center|right> align=<..> font=<..>
             size=<%.2f> bold=<0|1> italic=<0|1> pw=<0|1> tw=<%.2f> th=<%.2f> nl=<n> msv=<n> fw=<%.2f> fh=<%.2f>
line=<label> i=<n> asc=<%.2f> desc=<%.2f> lead=<%.2f> w=<%.2f> h=<%.2f> x=<%.2f>
...
summary cases=<n> fails=<n>
```

数值固定两位小数（无 `toFixed`，自写 `num()`）；`NaN`/`±Infinity` 有显式拼写，保证可 diff。

ui 模式（通道二）在 `summary` 后多一行 `grid cells=<n> size=<W>x<H>`，并另写 `textfield-grid.raw`。

## 覆盖维度

类型、`multiline`×`wordWrap`、`autoSize`、`align`、文本内容（空/多行/行尾空格/tab/CJK/混排）、
字体（`null`/`_sans`/`_serif`/`_typewriter`/Arial/Helvetica/Times New Roman/Courier/未知）、
字号、粗斜下划线/字距/字间距、`leading`、`password`（含**设置顺序**）、`maxChars`、`appendText`、
`htmlText`（`b/font/br/p/span`）、`setTextFormat` 区间、`border`/`background`、可编辑、滚动。

**通道二只铺其中 42 例**（`Main.as` 的 `UI_LABELS`）：报告覆盖 79 例，全铺出来一张图看
不完；挑的是每个维度最有诊断性的那几个。要改覆盖范围就改 `UI_LABELS`（增删标签即可）。

**不含** SWC 静态文本（`DefineText`/`DefineEditText` 的 D-T1/2/3 需要 `.swc` 素材）——那部分用
`adl` 跑真实应用对照。

## 约定

这是**观测器**不是断言器：AIR 真值由 adl 侧提供。本例只断言**自洽不变量**（度量非负、逐行度量可读、
空文本 `textWidth==0`、`numLines>=1`）——这些在两端都必须成立，不成立即运行时出错，非零退出响亮失败。
