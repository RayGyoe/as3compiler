# js2as：受限 JS→AS3 转译器（`scripts/js2as.ts`）

> 一句话：把**纯算法**的 JS 文件按一个**白名单子集**转成 AS3，喂给本编译器做端到端对照；
> 超出子集的一律**按名拒绝并给出 `行:列`**，绝不猜。

这个工具存在的理由是**上游同步**：`asaot3d/apps/nyc-m36` 对着 Web 版
（`mrdoob/slop-newyork`）做视觉对齐，而 Web 版的城市生成、交通、行人、镜头这些
**纯数据/纯算法**文件会持续变动。手工重抄一遍 AS3 端口既慢又容易抄错，于是把这些
文件当输入、把「翻译」这件事固定下来。

## 1. 为什么不做「通用 JS 转译」

本仓库的铁律是「生成可读的 C，语义错比功能缺更糟」（AGENTS.md §0/§2.4）。把整个
Web 工程直接转过来会撞上四层，而**只有第一层是语言问题**：

| 层 | 撞什么 | 结论 |
|---|---|---|
| 语言语义 | 原型链、`this` 重绑定、闭包捕获、动态属性、Promise、模块解析 | 静态度假能转，但每次访问都退化成 `Dictionary` + 反射（AGENTS.md §2.4 明令禁止的「静默降级」） |
| 渲染管线 | TSL 节点图里的 compute pass、storage buffer、MRT、间接绘制 | 后端 seam（`s3d_native_set_targets`）只绑单一颜色附件 —— 这是**后端能力缺口**，不是语言差距 |
| 几何语义 | `InstancedMesh`、无 16 位索引上限 | 同上 |
| 资产 | `city.json`、贴图、模型本来就已经是数据 | 转译没有意义 |

所以本工具的定位是**第二档粒度**：只吃「不碰 WebGPU/TSL/compute」的文件。渲染相关的
东西仍然手写（TSL 节点图按图逐个翻成 GLSL 是另一条通道，见
[`native-shader.md`](native-shader.md)）。

## 2. 子集

### 接受

- `var` / `let` / `const`（`let` 一律改写成 `var`；见 §4 的块作用域提醒）
- `function` 声明与函数表达式、递归、默认参数
- **箭头函数**（改写成 AS3 匿名函数，见 §3；体内出现 `this`/`arguments`/`super` 就拒绝）
- **对象/数组解构**（声明处、形参处；改写成属性/下标读取，见 §3）
- `if` / `for` / `while` / `do-while` / `switch` / `break` / `continue` / `return`
- 对象字面量 `{a: 1}`、数组字面量 `[1, 2]`、`new Array(n)`
- `+ - * / %`、比较、`&& || !`、`?:`、`typeof`、`===/!==`、位运算
- 模板字符串（展开成字符串拼接，见 §3）
- `export` 语句（单文件产物没有模块边界，见 §3）；`import` 一律拒绝
- `Math.*`、`Number(...)`、`parseInt/parseFloat`、`JSON`

### 拒绝（每条都带 `行:列` 与「该改写成什么」）

| 构造 | 报错文案（节选） |
|---|---|
| `class` | `classes are not in the subset; write an AS3 class with typed fields` |
| 展开/剩余 `...` | `spread/rest is not in the subset` |
| `for...of` | `` for-of is not in the subset; use an index loop (AS3 `for each` iterates values, not entries) `` |
| 嵌套解构 `{a: {b}}` | `nested destructuring \`{ b }\` is not in the subset; destructure one level at a time` |
| 解构里的剩余 `{...r}` | `rest in a destructuring declaration is not in the subset` |
| 计算键 `{[k]: v}` | `computed or nested key \`[k]\` in a destructuring declaration is not in the subset` |
| 箭头体内的 `this` | ``\`this\` inside an arrow function has no faithful AS3 rewrite (an AS3 anonymous function rebinds it); write a named function`` |
| `**` | `the exponent operator is not in the subset; use Math.pow` |
| 可选链 `?.` | `optional chaining is not in the subset; guard with an explicit null test` |
| `async`/`await`/`yield` | 同名拒绝 |
| `arguments` | `the implicit \`arguments\` object has no AS3 equivalent in the subset` |
| `import` | `imports are not in the subset (the file is not self-contained); translate a file that stands alone` |
| `export *` / `export default` / `export ... from` | 各自指名拒绝（都要另一个模块） |
| 多行模板字符串 | `multi-line template literals are not in the subset (line numbers must survive translation)` |

`of` 只在 `for (` 头部被拒；当普通标识符用（`const of = 1`）是放行的 —— 按名拒绝
只针对**该构造**，不能把合法文件的变量名一起打死。

## 3. 改写

| JS | AS3 | 说明 |
|---|---|---|
| `let x = 1` | `var x:* = 1` | AS3 没有块作用域；子集里的 `let` 不跨块 |
| `console.log(...)` 等 | `trace(...)` | 两者都是「参数空格分隔打印到宿主日志」 |
| `process.hrtime.bigint()` | `(new Date().getTime() * 1000000)` | **不是**单调时钟，只有「两次读数相减」这一点等价；负耗时会暴露这个差异，因此如实写在这里而不是藏起来 |
| `` `a=${x}b` `` | `("a=" + (x) + "b")` | 在**词法分析之前**用字符串处理展开（编译器没有模板字符串 token，也不该为一个 JS 专有特性去动编译器）；多行模板直接拒绝，否则行号会漂。插值里再套模板会**递归**展开 |
| `(a, b) => expr` | `(function (a:*, b:*):* { return expr; })` | AS3 **有**匿名函数，所以箭头是可译的；唯一译不了的是 `this`（箭头是词法 `this`，AS3 匿名函数是调用接收者），那种就拒绝 |
| `(a) => { ... }` | `(function (a:*):* { ... })` | 块体原样保留，只补类型 |
| `const { x, z: sz } = o` | `const x:* = o.x, sz:* = o.z` | 属性读取在 AS3 是同一个操作 |
| `const [p, , q] = arr` | `const p:* = arr[0], q:* = arr[2]` | 洞按位跳过 |
| `const { a } = pick()` | `const __d0:* = pick(); const a:* = __d0.a` | 右值不是裸标识符时先落临时量，保证 **只求值一次**（与 JS 相同） |
| `const { a = 5 } = o` | `const a:* = (typeof o.a === "undefined") ? 5 : o.a` | 默认值只在 `undefined` 时触发（`null` 不触发），所以用 `typeof`；编译器没有 `undefined` 标识符可比 |
| `function f({ a, b }, c)` | `function f(__p0:*, c:*) { const a:* = __p0.a, b:* = __p0.b; ... }` | 形参位置与走位保持不变，解构在函数体开头做 |
| `const { a } = o, b = 1` | `const a:* = o.a, b:* = 1` | 同一语句里的其余声明原样带走 |
| `export function f` / `export const K` | `function f` / `const K` | 单文件产物没有模块边界 |
| `export { f };` | 整句清空（**保留该行**） | 行号必须存活 |
| `import ...` | —（拒绝） | 有 import 的文件不是自包含的，猜「这个名字在哪一侧」就是瞎猜 |

类型标注：**每个绑定一律 `:*`**（AS3 动态类型）。这是 JS 值语义的忠实映射
（ES3 的 ToPrimitive、`+`、`==`、装箱），编译器对 `*` 已经实现了这套语义。
唯一的例外都不做推断 —— 见 §5。

## 4. 自检：输出必须能被真正的解析器吃下

`jsToAs()` 在返回前会把结果交给**编译器自己的 parser** 解析一遍。失败时报
`translated output does not parse, which is a js2as bug`。这条自检把两类错误分开：
「你的 JS 用了我不支持的构造」（正常的、带位置的拒绝）与「我生成了坏 AS3」（工具 bug）。
没有这条自检，后者会在下游变成一个莫名其妙的编译错误。

## 5. 为什么不推断类型（附实测）

任何 JS→强类型语言的转译器都会想做类型推断。这里**刻意不做**，理由不是保守而是**实测**：

- `nbody`（对象字段访问为主的物理循环）在「全 `*`」与「把所有可证为数值的绑定标成
  `Number`」两版之间：**390 ms vs 394 ms**（2000 步，噪声内）。
- 纯算术循环（2000 万次 `s += i * 0.5`）：两版都是 **7 ms**，并且与 `node` 的 7 ms 相同。

原因是 `-O2` 把 `as_value` 的装箱/拆箱**全部内联掉了**（tag 判断在局部可折叠），
标量装箱根本不是瓶颈。400× 的差距全部来自**动态成员访问**：

```js
b[i].x      // → 字符串键查表 + 装箱索引，每次访问都走一遍
```

这种开销**局部类型推断治不了** —— 要治好必须推断出**对象形状**（每个属性名与类型），
把 `{x:0,y:0,...}` 变成 typed class / `Vector.<T>`，那是全程序分析加语义风险，
和「宁可缺功能不可错语义」直接冲突。真实结论是：**热循环请手写带类型的端口**，
转译器负责正确性与冷路径。

## 6. 实测：五个基准的端到端结果

命令形状：`node scripts/js2as.ts <x>.js -o temp/x.as && node src/index.ts temp/x.as --run`，
与 `node <x>.js` 对照。**五个基准的校验和逐位一致**。

| 基准 | node | 转译产物 | 倍率 | 手写 AS 端口 |
|---|---:|---:|---:|---:|
| `fib` (fib(40)) | 536 ms | 1092 ms | 2.0× | 212 ms |
| `nbody` (2000 步) | 1 ms | 390 ms | ≈390× | 500 万步 199 ms（转译同规模约 16 分钟） |
| `mandelbrot` | 87 ms | 753 ms | 8.7× | — |
| `strings` | 91 ms | 214 ms | 2.4× | — |
| `array` | 18 ms | 21294 ms | 1183× | — |

倍率与「动态成员/元素访问的密度」强相关：`fib` 只有标量算术（2×）、`strings` 走字符串
内建（2.4×）、`array` 每步都在 `*` 数组上做 `a[i]` 读写（1183×）。这一列不是缺陷清单，
而是**选型依据**：告诉你在什么形状的代码上可以放心用转译、什么形状上必须手写端口。

`benchmarks/oop/oop.js` 是以 `class` 写的，被按名拒绝 —— 带类型的类就是要手写的地方。

### 6.1 首个真实上游文件：`js/vehicle-physics.js` → 原生，与 node 逐位一致

目标是 `temp/slop-newyork/js/`（nyc-m36 对齐的 Web 参考实现，24 个文件 34k 行）。补上解构与
箭头之前，**没有一个文件能过**；现在离得最近的是 162 行的 `vehicle-physics.js`
（0 个 `import`、0 个 `class`、0 个箭头、1 处对象解构 + 尾部 `export { ... }`）。

做法：`js2as` 转出 163 行 AS3，再在同一个文件末尾追加 A/B 夹具（**整数化打印**：所有字段
× 1000/1e6 后 `Math.round`，这样比较不会被 JS 与 AS3 的 Number→String 格式差异糊过去），
然后 `node src/index.ts temp/vp2-run.as --run` 与 `node temp/ab-veh.mjs` 逐行 `diff`。

**14 行（8 个 `vehicleContact`+`resolveVehicleContact` 夹具、6 个 `sweptVehicleContact` 夹具）
逐位一致**，包括「不接触」与 NaN 路径。这正是 §8 第 3 条那个三目缺陷的发现过程：
第一版 `contact.x` 全是 0，而 `resolveVehicleContact` 内部的 `closing` 却完全正确 ——
差别只在「读出来再算」这一步，于是定位到 `?:` 的强转。

同时它也划出了边界：`pedestrian-routes.js`（219 行）卡在**对象展开** `{...extra}`，
`building-collision.js` 卡在 `for...of`，其余大件（`traffic.js` 103 处解构 / 31 箭头 / 9 import、
`cars.js` 95 箭头）都还差得远。**用途是冷路径算法核对，不是替换渲染逻辑**：
`src/city/*.as` 是带类型的实现，全 `*` 转译产物在每帧热路径上会慢几个数量级（§5/§6）。

## 7. 用法

```bash
node scripts/js2as.ts path/to/input.js -o path/to/output.as
node scripts/js2as.ts path/to/input.js            # 打到 stdout
```

输出文件首行带 `// Transpiled from <input> by scripts/js2as.ts -- regenerate, do not hand-edit.`，
免得有人把它当成手写源码改起来。

## 8. 顺带修掉的三个编译器缺口

转译时撞到三处**AS3 合法但语义/编译不对**的缺口，都按 §0 从根上修，而不是在工作区里绕
（前两条来自 `nbody`，第三条来自首个真文件 `vehicle-physics`）：

1. **`*` 槽上的 `++` / `--` 编译不过**。发射器把目标当 C 左值直接写 `(g_x++)`，clang 报
   `cannot increment value of type 'as_value'`。AS3 允许对无类型槽自增（ES3 §11.3.1/§11.4.1：
   读写都过 `ToNumber`）。现在展开成 `x = as_v_num(Number(x) ± 1)`，且**后缀式的值取
   `ToNumber(旧值)`** —— 所以 `"5"++` 得 `5`（`Number`），槽变成 `6`；非数字字符串得 `NaN`。
   语句位置、`for` 的更新子句（值被丢弃处）不留无用临时变量。
2. **`const x:* = 5;` 编译不过**。此前发射 `static const as_value g_x = as_v_num(5);`，
   而 C 的 `static` 初始化器必须是编译期常量。现在凡是「C 类型需要构造调用才能得到字面量」
   的槽（`*` 是 `as_value`）一律按运行期初始化处理：声明给默认值，初始化表达式在 `main()`
   里按源码顺序跑一次 —— 与既有的 `static const d = new Dictionary()` 同一条通路。
   `int`/`Number`/`String` 字面量仍是真正的 C 静态常量（生成的 C 没有变化）。

3. **三目 `?:` 会把一侧按另一侧的静态类型强转**（转译 `js/vehicle-physics.js` 时暴露）。
   `unifyType(any, int)` 取 `int`，`convert` 再把 `any` 侧 unbox 成 int，于是
   `v == null ? 0 : v`（v = 0.974）**静默返回 0**；同理 `true ? 0 : "x"` 把 0 串成 `"0"`。
   这是 `&&`/`||` 早已按红线处理过的同一个错误 —— 条件运算符同样只返回**被选中一侧的值**，
   不做转换。现在它与 `&&`/`||` 共用同一道门：只有同 kind 或都数值才共享 C 类型，否则两侧
   都装箱；`null` 臂仍交给 `unifyType` 原有的精确规则（G16 的 `? null : Bitmap` 不受影响）。
   实测：改前 `pickNum(0.974) = 0`，改后 `0.974`；`typeof (true ? 0 : "x")` 由 `string` 变回 `number`。

四条都有回归：`examples/dynamic-inc.as`（端到端断言）、`test/unit/js2as.ts`、
`test/unit/logical.ts` 的 `unit: logical/TernaryOperand`（生成 C 的源级钉）。

## 9. 仍未做

- **对象形状推断**（见 §5）：这是把热路径变快的唯一办法，也是风险最高的地方。
- 闭包捕获的变量仍按 `*` 传递，未做逃逸分析。
- `for...of` 不自动改写成索引循环：`for (x of obj)` 在对象上是「遍历值」还是「遍历键」
  取决于对象类型，猜错就是语义错误，所以留给作者。
- 多文件/模块：一次一个文件。
- 类型提升的**代码已删**（不是「暂缓」）：实测无收益（§5），留着只是维护负担。