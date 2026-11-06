# RepaintBoundary 脏层重绘 — 设计文档（施工计划）

> 状态：**设计阶段，未实施**。本文是后续阶段的施工蓝图，不是已落地行为。
>
> 一句话：把渲染失效从「每帧全量指纹探测」升级为「**写时脏标记 + 边界隔离 + 只重绘脏层**」，
> 对齐 AIR 的 `cacheAsBitmap` 写时失效语义，并向 Flutter 的 `RepaintBoundary` 靠拢。
>
> 动机与性能缺口、现有 auto-bake 机制的完整实测，见 [`skia.md`](skia.md) §6.10~§6.14 与
> [`gc.md`](gc.md) §6。本文只讲「脏层重绘」这一条线的设计。

---

## 1. 背景与动机

### 1.1 现状：每帧全量重绘 + 被动 auto-bake

当前渲染是**保留语义、每帧全量**的组合：

1. **窗口级脏检测**（已存在）：`ASC_window_render(id)` 先对整棵 Stage 算 `render_fp`，指纹不变就跳过
   swapchain acquire + clear + `Present`（`src/emit.ts` 的 `ASCWin.render_fp`）。这是**整帧**粒度，不是子树。
2. **子树级被动烘焙**（已存在）：`as_render_fp(o)` 每帧递归整树算指纹；一个对象指纹连续
   `ASC_AUTO_BAKE_FRAMES`（=3）帧不变，且非单图元节点（`!as_single_primitive`），就 `_auto_baked=1` 烘成
   一张 `SkImage`（`_cache_image`），之后 `as_render_object` 走 `as_render_cached` 只 blit 快照。显式
   `cacheAsBitmap`（`_cache_flag`）走同一条烘焙路径。
3. **没有**主动失效：指纹一变，`_auto_baked=0`、`_cache_valid=0`，对象掉烘焙 → 走 N 帧 live 重画整棵子树 →
   静置 N 帧 → 重新烘。

### 1.2 性能缺口（已实测，非推测）

- `skia.md` §6.14：面板场景优化后单件绘制仍 **2.56 µs/项**，AIR 是 **1.85 µs/项**；`panel_192`
  **1.331 ms/帧**。交叉点从 ≈46 项推到 >1100 项，但海量显示对象（几百行列表）仍是输的场景。
- `TODO.md` 阶段四十七：FPS 场景 native 每帧全量 CPU 光栅化 2000×1360 + SDL blit，而 AIR 是
  GPU 合成 + **脏矩形**（只重绘 90×20 的 TextField 小块）。
- 被动探测的两个固有代价：
  - **每帧 O(树) 指纹**：`as_render_fp` 无论画面变没变，都要递归整树哈希所有渲染输入（变换、graphics、
    文本、滤镜、子列表…），这笔开销与「要不要重画」无关。
  - **失效延迟**：静置 3 帧才烘、掉烘焙后要空转 3 帧 live 再烘。hover/滚动/编辑这类「变一下、又静止」的
    交互，正好在「烘 ↔ 掉烘」之间来回，§6.12/§6.14 里的「抖动」「clear 又 blur」都源于此。

### 1.3 Flutter 的对照

Flutter 的 `RepaintBoundary` 之所以快，不是后端（它也用 Skia/Impeller）比我们快，而是它在光栅化之上
搭了**保留模式 + 脏标记 + 层合成**：`markNeedsPaint` 把「谁脏了」沿树向上传到最近的 `RepaintBoundary`，
帧内**只重绘那一个脏层**，兄弟层、父层、背景层一帧都不动。我们要补的正是这一层「写时失效 + 只重绘脏层」，
而不是换后端。

---

## 2. 目标与非目标

### 2.1 目标

1. **写时脏标记**：渲染输入的每一次写（`x`/`text`/`graphics`/`addChild`/…）都置脏并向上传播，替代「每帧
   全量指纹探测」这一读路径。
2. **边界隔离**：把 `cacheAsBitmap` 确立为显式重绘边界（它本来就是「子树烘成独立位图、父级只 blit」），
   并让自动边界（auto-bake）继承同一套失效语义。
3. **只重绘脏层**：帧内只有脏的边界层重新光栅化，其余层复用上一帧快照；边界内（阶段 C）进一步只重绘
   脏区域/脏子树。

### 2.2 非目标

- **不改 AIR 已定义行为**：`cacheAsBitmap` 的 AS3 语义（`getCacheAsBitmap`、含 filters 时隐式开启、
  `cacheAsBitmapMatrix`）逐字保持。本设计只在**失效时机**上对齐 AIR（见 §4.1），不新增/改写任何 AIR 语义。
- **不引入第三方依赖**（§3.1 铁律）：脏标记是运行时 C 结构 + 发射器注入，Skia 之外的任何库都不碰。
- **首版不做完整 DisplayList 记录**：Flutter 的 `DisplayList`（绘制命令录制 + replay）是更大的工程，
  列为阶段 D（可选），不在阶段 A~C 的验收范围内。
- **不做分代 GC**：GC 的每帧 `gc_step()` 预算、写屏障开销是另一条线（`gc.md` §6），不在本文范围内。

---

## 3. 现状盘点

| 能力 | 现状 | 位置 |
|---|---|---|
| 窗口级脏检测（整帧跳过 Present） | ✅ | `ASC_window_render` / `ASCWin.render_fp` |
| 子树级被动烘焙（auto-bake） | ✅ | `as_render_fp` → `_auto_baked`，`as_render_cached` |
| 显式烘焙（cacheAsBitmap） | ✅ | `_cache_flag` → 同一 `as_render_cached` |
| 快照位图 + 设备栅格吸附 + 相位 | ✅ | `_cache_image` / `_cache_phx` / `_cache_phy` / §6.12 |
| 单图元 alpha 折叠 / 单图元拒绝烘焙 | ✅ | `as_single_primitive` / `as_draw_count` |
| **写时脏标记 + 向上传播** | ❌ | 无 |
| **边界内局部重绘（脏矩形/脏子树）** | ❌ | 无（`emit.ts:40320` 明确「no AIR-style region list」） |
| 渲染输入全集枚举 | ✅（作为指纹） | `as_render_fp` 的哈希字段清单 |

**关键观察**：`as_render_fp` 已经是「渲染输入全集」的枚举——它哈希了 `x/y/rotation/scale*/alpha/visible/
blendMode/mask/scrollRect/transform/filters/graphics/bitmapData/text/…` 每一项。这个清单**就是**「需要注入
脏标记的写点清单」的现成来源：把它从「每帧读哈希」改成「写时置位」，就是阶段 B 的全部核心工作。这大大
降低了「漏掉哪个写点」的风险——指纹漏过的输入，本来就会导致烘焙冻结（文档里已有大量教训），所以清单是
被逐次踩坑补全过的。

---

## 4. 核心设计

### 4.1 API 形态：为什么复用 `cacheAsBitmap`

AIR **没有** `RepaintBoundary` 这个概念。AIR 里的对应物是三件套：

1. `cacheAsBitmap`：子树烘成位图，对象或其子变化时**再生**位图；
2. `scrollRect`：滚动窗口；
3. GPU 硬件合成器：把这些位图按变换合成上屏，配合**脏矩形**只重绘失效区域。

其中 `cacheAsBitmap` 在语义上**已经是一个重绘边界**——它把子树与父级隔离成两层。而且 AIR 的失效是
**写时**的：`skia.md` §6.10 已实测确认「AIR's cache is not a snapshot: the player regenerates the bitmap
when the object or its children change」。也就是说，**对齐 AIR 的正确实现本来就该是「写时失效 + 变化时重烘」，
而不是我们现在「读时指纹探测 + 静置 3 帧才烘」**。

结论：

- **主方案**：`cacheAsBitmap` = 显式 RepaintBoundary。不新增 AS3 API，语义对齐 AIR，只在失效模型上从
  「帧指纹探测」升级为「写时脏标记」。这是**修实现、不是增强**——AIR 的 cacheAsBitmap 失效本来就是写时的。
- **辅助方案**：auto-bake 作为「自动边界」，沿用同一套脏标记（把 auto-bake 从「静置探测」升级为「写时失效」）。
- **可选增强**（真正超出 AIR、必须 opt-in）：新增 `flash.display.RepaintBoundary` 容器类，或构建清单
  `repaint-boundaries` 自动插入边界。这部分**默认关闭**，与 AIR 同构。列为阶段 C 之后的独立增强，本文只
  给出接口形状，不承诺首版落地。

### 4.2 数据结构

在 `DisplayObject` 结构体上新增（`src/emit.ts` 的 `_cache_*` 字段旁，字段清单见 §3 的表）：

```c
int   _render_dirty;     // 自己或子树自上次渲染以来是否失效
// 阶段 C 才有：
double _dirty_l, _dirty_t, _dirty_r, _dirty_b;  // 失效矩形（对象自身坐标系，-INF 表示未初始化）
```

边界判定复用现有语义：

- `_cache_flag`（显式 `cacheAsBitmap`）⇒ 是边界；
- `_auto_baked`（自动烘焙）⇒ 是边界，但它是**运行时决策**（见 §4.5 与帧指纹的关系）。

新增一个内联判定 `as_is_boundary(o)` = `_cache_flag || _auto_baked`（阶段 B 只有 `_cache_flag` 是稳定边界，
`_auto_baked` 因为会被掉烘而退化成非边界，见 §6 风险 3）。

### 4.3 失效传播（写时置脏 + 向上冒泡到根）

**核心不变量**：任何「会改变渲染输出」的写，都必须把**自己**和**祖先链上到根**的所有对象标记为脏。
**必须冒泡到根，不能在内层 cacheAsBitmap 边界停**——两条理由：
1. `as_render_fp` 的指纹 fold 会**穿透内层边界**递归到子树（见 §3），若标脏停在内层，外层的指纹变而
   `_render_dirty==0`，持续 `DIRTY_MISS`；
2. 嵌套 cacheAsBitmap 的父层快照了子层的位图，子层重烘后父层必须重烘，否则父层 blit 的是过期图像。
非边界祖先的 `_render_dirty` 无人消费（只有 cache 分支读它），所以穿透是安全且必要的。

```
写 leaf.x = 10
  → leaf._render_dirty = 1
  → 沿 parent 链上溯到根：
     对每个祖先 a：
       a._render_dirty = 1
       （不再在 _cache_flag 处停：穿透内层边界，直到 parent == NULL）
```

写点注入的三类来源（清单来自 `as_render_fp` 的字段枚举，见 §3）：

1. **DisplayObject accessor setter**：`x/y/rotation/scaleX/scaleY/alpha/visible/blendMode/mask/scrollRect/
   filters/transform/opaqueBackground/cacheAsBitmap`。这些在 `src/emit.ts` 里是发射出的 getter/setter
   C 函数，注入点明确。
2. **方法调用**：`Graphics` 的 `beginFill/lineStyle/moveTo/lineTo/curveTo/draw*/clear`；`DisplayObjectContainer`
   的 `addChild/removeChild/setChildIndex/swapChildren/…`；`TextField` 的 `text/appendText/htmlText/
   setTextFormat/scrollV/scrollH/…`；`MovieClip` 的 `gotoAndStop/play/stop` 与帧推进（`as_mc_tick`）。
3. **间接输入**：`BitmapData` 的写（已有 `_px_ver` 版本计数器，可把它读作「脏」，见 §4.5）、
   `Matrix`/`ColorTransform` 字段写（`transform.matrix` / `transform.colorTransform` 的逐字段 setter）、
   SWC 时间轴帧切换。
4. **动态字段写（`as_dyn_set`）**：`obj[key] = v` 走 vtable 反射，对 DisplayObject 的渲染输入字段
   （`x/y/rotation/scaleX/scaleY/alpha/visible/blendMode/opaqueBackground/transform`）是**直接写字段**
   （`case 1/2/3/7/11`），既不走 accessor setter，也不走 emitAssign 字段写尾——Starling Juggler tween 就是
   通过 Object 类型 target 驱动 alpha 的，这是真机最后一批 `DIRTY_MISS` 的根因。修复：RUNTIME_PREAMBLE 声明
   `as_disp_dirty_hook`，`as_dyn_set` 在 case 1/2/3/7/11 字段写后触发；render preamble 的
   `as_disp_dirty_impl` 用 `as_is(obj,&DisplayObject_vt)` 判定接收者后 `as_mark_dirty`，`main` 里
   `as_disp_dirty_wire()` 安装。钩子用 `as_is` 判定，避免对 DropShadowFilter 等同名 `alpha` 字段误标脏。

**关键工程约束**：脏标记必须覆盖**全部**写点。漏一处 = 该对象永不失效 = 边界缓存冻结（和现有「指纹漏算 →
画面冻结」是同一类 bug，`skia.md` §6.10/§6.14 里已有多处实测教训）。这是阶段 B 最大的工作量，也是最大的
回归风险面。

### 4.4 边界隔离与局部重绘

**渲染入口改造**（`as_render_object` 的缓存分支，现 `src/emit.ts:29717`）：

```
// 现：命中 _cache_flag/_auto_baked 就走 as_render_cached（blit 快照）
// 改：命中边界时先问「脏不脏」
if (边界 && 命中快照) {
  if (!o._render_dirty) { blit 快照; }          // 复用，不重画
  else { 重绘该边界（阶段 B：整边界重烘；阶段 C：只重绘脏区域）; o._render_dirty = 0; }
}
```

- **阶段 B**：边界脏 → 重烘整张快照（等价于现在「掉烘焙 → 重画 → 再烘」，但**去掉了静置延迟**：脏了就
  当帧重烘，不空转 3 帧 live）。
- **阶段 C**：边界脏 → 用 `_dirty_l/t/r/b` 裁剪，只重绘快照里脏矩形覆盖的像素，其余 blit 旧快照。这是
  「FPS 场景只重绘 90×20 小块」的落地形态，也是收益最大、最难做对的一步。

**帧末复位**：`Stage_render` 与 `ASC_window_render` 在 Present 后（渲染完成、snapshot/save 前）调用
`as_clear_dirty(stage)`，把**所有**对象的 `_render_dirty` 清 0（边界重绘过的和未重绘的都要清，因为下一帧
的脏要从零累积）。配套地，**根（stage）不 auto-bake**——否则根烘焙后，任何子对象写点冒泡到根都会把整个
窗口 tear-down + re-bake。

### 4.5 与帧指纹的关系（关键取舍）

帧指纹 `as_render_fp` 是**读时探测**（每帧算，O(树)），脏标记是**写时置位**（写时 O(1)，读时 O(脏)）。
两者不是等价替换，各有用途：

| 用途 | 现方案 | 新方案 |
|---|---|---|
| 窗口级「整帧没变跳过 Present」 | `render_fp`（整树哈希） | **改为** 全局脏 epoch（`ASC_dirty_epoch`），写时 `++`，O(1) 判「本帧是否有脏」 |
| cacheAsBitmap 失效 | 指纹变 → 掉烘 | **改为** 写时脏标记（对齐 AIR） |
| auto-bake 触发 | 静置 3 帧才烘 | **改为** 写时脏标记（脏了就烘，静止即烘，无静置延迟） |
| 渲染输入全集（防漏清单） | `as_render_fp` 的哈希字段 | **保留为「写点注入清单」的来源**，但不再每帧执行 |

**迁移策略（防回归，已完成切换 + 彻底移除）**：阶段 B **先并行、后切换**——新增脏标记与现有指纹并存一段时间，
用 `DIRTY_MISS` 探针验证「指纹变 ⇔ 脏标记置位」在全部示例上同真同假；清零后，`_cache_flag` 失效与 auto-bake
触发都切到写时脏标记，`as_render_fp` 的掉烘逻辑删除。阶段 C 第二步**彻底移除每帧整树哈希**：窗口 Present-skip
键从 `w->render_fp == _window_fp` 改为全局 `ASC_dirty_epoch` 单调计数（写时 `++`）；`as_render_fp` 替换为
`as_render_states`（每帧只结算 MovieClip/SimpleButton 状态，不哈希）；`_auto_fp`/指纹 helper/`DIRTY_MISS` 诊断一并删除。

`BitmapData` 的 `_px_ver`/`_uid` 版本计数器（现已被指纹读取）在脏标记方案里**语义不变**——它仍然是
「BitmapData 内容变了」的权威信号，只是从「被指纹每帧读」改成「写时直接置脏其所有显示实例」。这一步是
阶段 B 里最需要小心的：一个 `BitmapData` 可能被多个 `Bitmap` 显示，写它要置脏**所有**引用它的 Bitmap
（现方案靠 `_px_ver` 全局递增让每个 Bitmap 的指纹都变，天然覆盖了这一点）。阶段三百六十六已把它落地为
`BitmapData._refs` 强引用反向边：13 个 mutator 统一走 `as_bd_mark_dirty`（`_px_ver++` + 遍历 `_refs` 标脏每个
引用者），`removeChild` 时递归解绑防泄漏（Mark-Sweep 把 Bitmap↔BitmapData 环当整体回收）。

---

## 5. 分阶段实施

> 阶段编号只表示本文内部的实施顺序；真正开工时纳入 `TODO.md` 路线图，按项目惯例分配「阶段三百六十五 +」全局编号。

### 阶段 A：边界语义收口（文档化，基本已有）

- [ ] 把 `cacheAsBitmap` 确立为「显式重绘边界」的文档口径（本文 §4.1），在 `skia.md` 补一段对照。
- [ ] 盘点 `_cache_flag` / `_auto_baked` 的边界语义差异，明确「稳定边界（显式） vs 运行时边界（自动）」。
- **验收**：无代码行为变更，仅文档；现有 `unit: render/*` 与 `examples/autobake-*.as` 全绿。

### 阶段 B：写时脏标记 + 边界级失效（核心）

> **实施状态（阶段三百六十九）**：写点已覆盖全部渲染输入（DisplayObject 字段/accessor、容器结构、MovieClip
> 帧、Graphics、Transform、Bitmap/BitmapData 反向引用、TextField、Stage）+ 7 类运行时内部状态（焦点、选择/caret、
> IME 组合、caret 闪烁、filter 字段、Stage3D、SimpleButton hover）+ 动态字段写（`as_dyn_set`）钩子标脏，并修复
> `as_mark_dirty` 短路 bug、autoSize 漏标脏、嵌套 cacheAsBitmap 不穿透、动态字段写漏标脏。真机 `DIRTY_MISS` 已清零，
> **切换已完成**：失效改由 `_render_dirty` 驱动（`as_render_fp` 不再掉烘，只保留窗口 Present-skip 键 + DIRTY_MISS
> 诊断）；auto-bake 触发由「静置 3 帧」改为「无脏即烘」；缓存分支区分显式 `cacheAsBitmap`（脏→当帧重烘）与
> auto-bake（脏→退出边界、落到 live，静止当帧重烘）。
> **阶段 C 第二步（移除每帧指纹哈希）已落地**：`as_render_fp` 彻底删除，替换为 `as_render_states`（每帧只结算
> MovieClip/SimpleButton 状态）；窗口 Present-skip 键改为全局 `ASC_dirty_epoch`（写时 `++`）；`_auto_fp`/指纹 helper/
> `DIRTY_MISS`/`ASC_DIRTY_TRACE` 诊断全部删除；auto-bake 触发迁到 `as_render_object` cache 决策前。
> **阶段 C 第一步（脏矩形基础设施）已落地**：`DisplayObject` 增 `_dirty_full/_dirty_l/t/r/b` 字段；`as_mark_dirty`
> 升级为整对象脏（置 `_dirty_full`）；新增 `as_dirty_merge`（防非有限矩形）与 `as_mark_dirty_rect`（合并 + 复用
> `as_bounds_xform` 上溯变换）；新增 `as_clear_dirty` 递归清脏（**本次未启用**）。脏矩形**写了不读**，增量重烘留待
> 下一步。

- [x] `DisplayObject` 增 `_render_dirty` 字段与 `as_is_boundary` 判定（§4.2）。
- [x] 按 `as_render_fp` 的字段枚举清单，在所有渲染输入写点注入 `as_mark_dirty(o)` + 向上传播（§4.3）。
      **已覆盖**：9 个直接字段（`x/y/rotation/scaleX/scaleY/alpha/visible/blendMode/opaqueBackground`）+
      `width`/`height`/`scale9Grid`/`filters`/`mask`/`scrollRect`/`cacheAsBitmap` accessor、`addChild`/`removeChild`
      结构、`MovieClip` 帧推进、`Graphics` 绘制命令（经 `_owner`）、`Transform.matrix/colorTransform`（经 `_owner`）、
      `Bitmap.bitmapData`/`smoothing`、`BitmapData` 13 个 mutator（经 `_refs` 反向引用）、`TextField` 文本/格式/颜色/滚动
      写点、`Stage.color/align/scaleMode`、动态字段写（`as_dyn_set` → `as_disp_dirty_hook`）。
- [x] `as_render_object` 缓存分支：显式 `cacheAsBitmap` 脏→掉烘+当帧重烘；auto-bake 脏→退出边界+落到
      filters/content live，无脏即烘（§4.4 阶段 B，去静置延迟）。
- [x] `as_render_fp` 移除掉烘：`_auto_fp` 仍保留（窗口 Present-skip 键 + DIRTY_MISS 诊断），`_auto_still`
      静置计数与 `ASC_AUTO_BAKE_FRAMES` 宏删除。
- [x] `_render_dirty` 复位（§4.4）—— 实现为**消费时清脏**（缓存分支重烘前清），非帧末统一复位。
- [x] **并行验证 → 切换**：脏标记与指纹同真同假（§4.5 迁移策略），全量 `node test.ts` 绿后才切换。
      探针已就位（`ASC_DIRTY_TRACE` + `DIRTY_MISS`：指纹变而 `_render_dirty==0` 即报漏写点，切换后仅诊断不兑底）。
      首轮跑出**大量 `DIRTY_MISS`**，定位「指纹输入 ≠ AS3 写点」，补齐 7 类内部状态写点；第二轮复验仍未清零，
      进一步定位 `as_mark_dirty` 的 `!o->_render_dirty` 短路 bug（非边界子对象跨帧保持脏、祖先边界同帧被清，
      下一帧冒泡被跳过），改为全链冒泡；第三轮复验定位 autoSize 漏标脏；第四轮（dump 子树）定位嵌套
      cacheAsBitmap 标脏不穿透；第五轮（dump 增强到全指纹字段）定位 Starling Juggler 动态写 alpha 漏标脏，
      加 `as_disp_dirty_hook` 钩子后真机 `DIRTY_MISS` 清零；第六轮切换后真机 `DIRTY_MISS` 仍 0、无崩溃。
- **验收**：
  - `temp/` 探针：`x` 连写两次 → 第二次（写时脏已置）当帧重烘，无静置 3 帧延迟（`ASC_BAKE_TRACE` 时间戳）。
  - 单件绘制斜率不再因「掉烘空转」而抖动（§6.14 的 hover 场景 A/B）。
  - `test/unit/render.ts` 源级钉：脏标记字段、`as_is_boundary`、注入点覆盖清单、缓存分支区分显式/auto、指纹不再掉烘。

### 阶段 C：边界内脏矩形/脏子树增量重绘（最难，收益最大）

- [x] **彻底移除每帧指纹哈希**：`as_render_fp` 删除 → `as_render_states`（只结算 MovieClip/SimpleButton 状态）；
      窗口 Present-skip 键改全局 `ASC_dirty_epoch`（写时 `++`）；删 `_auto_fp`/指纹 helper/`DIRTY_MISS`/`ASC_DIRTY_TRACE`。
- [x] `DisplayObject` 增 `_dirty_l/t/r/b` + `_dirty_full`（§4.2）。
- [x] 脏矩形合并/上溯：`as_dirty_merge`（防非有限矩形）+ `as_mark_dirty_rect`（合并 + 复用 `as_bounds_xform`
      上溯变换到父坐标）；`as_mark_dirty` 置整对象脏（`_dirty_full=1`）。**精确矩形写点已落地**：闭合形状
      （`drawRect`/`drawCircle`/`drawEllipse`）经 `as_gpath_mark_rect` 携带精确矩形（含 `_max_sw` 描边外扩），
      `as_gflush` 用累计 bounds 做精确矩形（不再整对象脏）；开放路径（`moveTo`/`lineTo`/`curveTo` 等）与
      9 个直接字段仍走 `as_mark_dirty` 整对象脏（其 bounds 无法在写点时刻定）。
- [x] **边界内增量重烘（bake_patch）**：`as_render_cached` 在边界脏且 `_dirty_full==0` 且无 filter 时，用保留的
      raster surface（`_cache_surface`，重建时同步释放/替换 + finalizer 按 kind 区分 SkImage/SkSurface）做
      `save` + `clipRect(_dirty_*)` + `clearRect(_dirty_*)` + 局部重画 + 重新 snapshot；`_dirty_full` 或有 filter
      则复用 surface 整重烘（`reset` + clear + 重画）；尺寸/相位变化仍走整边界重建（bake_rebuild）。显式
      `cacheAsBitmap` 脏不再在 `as_render_object` 里清 `_render_dirty`/`_cache_valid`，改为交给 `as_render_cached`
      消费后清脏；auto-bake 脏仍掉烘落到 live。
- [x] 「帧末统一复位」（`as_clear_dirty`）启用：`Stage_render` 与 `ASC_window_render` 在 Present 后（渲染完成、
  snapshot/save 前）调用 `as_clear_dirty(stage)`，把**所有**对象的 `_render_dirty`/脏矩形清 0（缓存分支消费后已清、
  live 子树从未被清的那部分也一并清），下一帧从零累积脏。配套修掉 auto-bake 增加暴露的漏点：**根（stage）不再
  auto-bake**（auto-bake 触发加 `o->parent != NULL`）——否则根烘焙后，任何子对象写点冒泡到根都会把整个窗口
  tear-down + re-bake，正是阶段四十七「为了 90×20 小块重绘整帧 2000×1360」的代价本阶段要消除的。
- **验收**：
  - [x] FPS 计数器场景（`TODO.md` 阶段四十七的 90×20 小块）：`examples/fps-counter.as` 静止大背景 auto-bake 只烘一次、
    之后 blit，每帧变化的小块走 live；`ASC_BAKE_TRACE=1` 观察 bake_on/bake_rebuild（只出现一次）而非每帧整帧重烘。
  - [x] `showRedrawRegions` 从「接受但无覆盖层」升级为「真画出脏矩形」：`as_render_cached` 记录刚重绘的矩形
    （`redrawn` + `rl/rt/rr/rb`），在 blit 后画 1px stroke 轮廓（`ASC_show_redraw_regions`/`as_show_redraw_regions`）；
    `examples/show-redraw-regions.as` 钉「整边界重建描整个边界、增量重烘只描脏矩形」的像素。
  - [x] 像素钉子：滚动列表只重绘滚动内容，固定 header 一帧不动：`examples/scroll-header-pin.as` 固定 header 在列表
    容器之外，滚动只改 `list.scrollRect`（脏只冒泡 list 及其祖先），`BitmapData.draw` 前后采样 header 逐点不变、
    滚动窗内容随位移变化。

> **阶段 C 收尾后补充（v0.4.343，阶段三百七十八）**：Stage C 的增量重烘在**真实 asaotui 交互**里最初从不触发——
> `bake_patch` 被两个整对象失效源头重新放大成 `_dirty_full`：① `Graphics_clear` 首句无条件 `as_mark_dirty(g->_owner)`
> （`clear`+`drawRect` 改色链路的第一步就把脏矩形抹掉）；② asaotui `paintSelf` 每帧无条件写 `backing.alpha`，
> render-input 标量字段写尾无条件 `as_mark_dirty`。修复：`Graphics_clear` 改用旧累积 bounds 的精确脏矩形（空 graphics
> 不标脏）；render-input **标量**字段（double/bool）写点加「值不变就不标脏」变化检测（RHS 副作用先 hoist，指针/boxed
> 字段保持无条件标脏）；asaotui 侧 `backing.alpha` 改「值变了才写」。`ASC_BAKE_TRACE=1` 下
> `asaotui/probes/widgets/repaint-boundary` 改 `s1` 颜色后 `stable` 出现 `bake_patch`（脏矩形 = `s1` 的 bounds），
> 增量重烘收益真正生效。详见 TODO.md 阶段三百七十八。

> **阶段 C 收尾后补充（v0.4.345，阶段三百八十）**：`x`/`y` 属于 render input，写点此前一律走整对象
> `as_mark_dirty` ⇒ auto-bake 边界当帧丢烘焙、下一帧整块重烘。位移**不改变子树内容**（烘焙位图活在对象自己的
> 局部空间，表面带 `translate(-bxo,-byo)`、贴回套当前 CTM，任意整数偏移都精确），所以 `x`/`y` 改写走
> `as_mark_moved`：只把**祖先链**置脏，被移动对象保留 `_cache_valid`，下一帧直接贴回旧位图。旋转/缩放**不在**
> 其列（它们改变烘焙的设备分辨率，位图必须重做）；`_mask_user` 对象退回整对象（遮罩位置是别的对象的输入）；
> 亚像素位移仍由设备相位检查（`_cache_phx/_cache_phy`）拦下走 live。真机 bake-trace：修复前 `bake_patch` 恒为 0、
> 每次小改动整块（354×841 = 0.67 Mpx）重烘；示例级 A/B 重建次数 12 → 10、重烘面积 15430 → 14260 px。详见
> TODO.md 阶段三百八十；像素钉 `examples/autobake-move.as`，结构钉 `test/unit/render.ts` 的 `render/MovedBake`。

> **阶段 C 收尾后补充（v0.4.346，阶段三百八十一）**：auto-bake 脏了不再「整块掉烘 → 活态 → 下一帧从零重烘」，
> 而是**原地修复保留的 surface**（阶段 C 早就实现的 `bake_patch` / 整面重画两条路），只对**零散变更**开放：
> `DisplayObject._cache_dirty_run` 记「连续多少次渲染都是脏的」，`== 1` 表示上一帧还是干净的 ⇒ 这次是零散变更，
> 修一次；`>= 2` 表示每帧都在变（动画/滚动）⇒ 照旧退回活态，不为此每帧多付一次快照 + 贴回。干净的渲染把它清零。
> 收益是「一次变更一次光栅化」：旧路径是「当帧活态光栅化 + 下一帧整块重建（重新分配 surface + 再光栅化 + 快照 +
> 贴回）」，同一份内容画两遍还要分一次面。示例级 A/B（同一份 `examples/autobake-patch.as`，只换 emit.ts）：
> `bake_rebuild` 47 → 5、`bake_patch` 0 → 7。
>
> 配套 **`ASC_BAKE_VERIFY=1` 自校验 oracle**（§4.5 想要的「两张臂比像素」的最小可用形态）：每次原地修复后，把同一
> 状态从零重建到一张临时 surface 上，回读两份 ARGB 逐像素比，不一致就打 `bake_verify_bad o=… kind=patch npix=…`。
> 原地修复的全部风险就是「漏一个写点 ⇒ 留下一块永久过期像素」，而任何只看「我改的那块」的门都发现不了它；这条
> oracle 把「漏标记」从静默花屏变成一行 stderr。默认关闭（每次修复多付一次完整光栅化），只在验证时开。
> 像素钉 `examples/autobake-patch.as`（零散改色、连续 5 帧改色、收尾后再改色，三种情形都必须与「同一内容整块新烘」
> 逐像素相同），结构钉 `test/unit/render.ts` 的 `render/AutoBakePatch`。详见 TODO.md 阶段三百八十一。

### 阶段 D（可选，独立增强）：DisplayList 记录 + replay

- [ ] 把边界的绘制命令录成 DisplayList（类似 `SkPicture`），静态内容只 replay + 平移，不重新生成绘制命令。
- **明确不承诺首版**：工程量大、与脏矩形方案部分重叠；只有在阶段 C 仍达不到目标时才启动。

---

## 6. 风险与边界（如实报明）

1. **漏标记 = 画面冻结**。这是本设计最大的风险，也是现有 auto-bake「指纹漏算」的同一类 bug（`skia.md`
   已有多处实测教训）。缓解：§4.5 的「先并行后切换」，让指纹在阶段 B 期间兜底发现漏点。
2. **写点覆盖是最大工程量**。`DisplayObject`/`Graphics`/`TextField`/`Container`/`MovieClip`/`BitmapData`/
   `Matrix`/`ColorTransform`/SWC 帧脚本九条线都要注入，且要与「直接字段写 vs accessor」的实际发射形态对齐。
   低估它会导致阶段 B 长期红。
3. **auto-bake 作为「运行时边界」的漂移**：`_auto_baked` 会被掉烘退化成非边界，边界集合每帧可变；脏标记
   传播到「上一帧是边界、这一帧不是」的对象时会冒泡过头或不够。阶段 B 应**先只对显式 `_cache_flag` 做脏标记**，
   auto-bake 最后切换（§4.5 顺序）。
4. **增强与 AIR 同构的边界**：`cacheAsBitmap` 的失效改造成脏标记，是**对齐 AIR 的修实现**，不是增强；
   但「新增 `RepaintBoundary` 类 / 自动插入边界」（§4.1 可选）是**超出 AIR 的增强**，必须 opt-in、默认关闭。
5. **跨端差异**：web（WASI + emcc）无 `Present` 概念，脏层跳过与 GPU 合成路径要按后端显式分流；Windows
   的 D3D12 合成与 macOS Metal 的边界重绘成本不同，阶段 C 的脏矩形裁剪两端都要真机验证（当前 Windows 无法
   本机验证，记 `TODO.md`）。
6. **与 `BitmapData.draw` / 滤镜 pass 的交互**：这些路径走「烘焙到另一张画布」（`skia.md` §6.12 的相位/落点），
   脏标记的「对象自身坐标系脏矩形」在这些非窗口画布上的语义要单独定义，否则会读到错的裁剪窗口。

---

## 7. 验收与回归总纲

- **语义对齐**：`cacheAsBitmap` on/off 的像素输出**逐字节不变**（`examples/autobake-origin.as` 的既有钉子
  必须继续绿）——脏标记只改「何时重绘」，不改「画成什么样」。
- **行为对齐**：同一份 `.as` 双端跑（AOT + `mxmlc`/`adl`），`cacheAsBitmap` 失效时机与像素一致（AIR 的
  cacheAsBitmap 是写时失效，改造后应比现在更贴近 adl）。
- **结构钉**：`test/unit/render.ts` 增脏标记字段、`as_is_boundary`、注入点清单、帧末复位、脏矩形合并的源级钉。
- **性能**：阶段 B 后 `output/perf/chat` 的 `panel_192` 斜率不再因掉烘空转而抖动；阶段 C 后 FPS 场景的重绘
  面积降到小块级。
- **全量回归**：每个阶段收尾 `node test.ts` 全绿 + 文档双语同步 + 版本 bump（§2.7）。

---

## 8. 参考

- [`skia.md`](skia.md) §6.10~§6.14：auto-bake / cacheAsBitmap / 帧指纹 / 单图元折叠的完整实测。
- [`gc.md`](gc.md) §6：增量 GC 的每帧预算与写屏障（与本设计正交的另一条性能线）。
- `src/emit.ts`：`as_mark_dirty`/`as_mark_dirty_rect`/`as_clear_dirty`、`as_render_states`、`as_render_cached`
  （rebuild/patch/full retained repaint + showRedrawRegions 轮廓）、`as_render_object`（auto-bake 触发含根排除）、
  `as_render_object_content`、`ASC_window_render`、`Stage_render`（帧末复位）。
- `TODO.md` 阶段四十七（`947-948`）：脏矩形 invalidate 管线的原始记录。
