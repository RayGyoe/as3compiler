// native-shader-probe.as — 阶段三百五十三：E6 原生着色器直通（M2 编译器侧）。
//
// 只跑「翻译 + 反射 + 错误面」这一半，不碰 GPU：Context3DNative.uploadProgram
// 完全在 CPU 上走 glslang + SPIRV-Cross，所以这个探针不需要窗口、不需要 Metal，
// 链接时也不需要 Stage3D 后端（as_s3d_native_* 在 ASC_RENDER_STAGE3D 关闭时是
// 「如实报错」的桩，见 runtime.ts）。
//
// 覆盖：
//  1. 双输出 MRT 片元着色器 → colorAttachments == 2
//  2. 反射表：uniform 按名字可查、类型/阶段/槽位齐全；拼错的名字查不到（-1）
//  3. #version 100（ES 1.00）被拒绝，infoLog 带 glslang 原文与行号
//  4. `attribute` 等 legacy 语法被拒绝（ES 3.00 只认 in/out）
//  5. 成功编译时 infoLog 为空串，getTranslatedSource 非空

// 反射 kind 的取值，与 runtime.ts 的 ASC_SHADER_KIND_* 一一对应。
const K_UNIFORM:int = 1;
const K_TEXTURE:int = 2;
const STAGE_VERTEX:int = 0;
const STAGE_FRAGMENT:int = 1;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// 一个两输出的 FFT 形状片元着色器：这正是 Ultra-Water 的 OceanSim 需要而 AGAL
// 永远表达不了的东西（MRT + 浮点目标）。
const VS_OK:String =
  "#version 300 es\n" +
  "layout(location=0) in vec2 aPos;\n" +
  "uniform mat4 uMVP;\n" +
  "uniform float uTime;\n" +
  "out vec2 vUV;\n" +
  "void main() {\n" +
  "  vUV = aPos * 0.5 + 0.5 + uTime * 0.0;\n" +
  "  gl_Position = uMVP * vec4(aPos, 0.0, 1.0);\n" +
  "}\n";

const FS_OK:String =
  "#version 300 es\n" +
  "precision highp float;\n" +
  "in vec2 vUV;\n" +
  "uniform sampler2D uSpectrum;\n" +
  "uniform float uTime;\n" +
  "layout(location=0) out vec4 oDisplacement;\n" +
  "layout(location=1) out vec4 oDerivatives;\n" +
  "void main() {\n" +
  "  vec4 s = texture(uSpectrum, vUV);\n" +
  "  oDisplacement = vec4(s.xy * uTime, 0.0, 1.0);\n" +
  "  oDerivatives = vec4(s.zw, 0.0, 1.0);\n" +
  "}\n";

// ES 1.00：glslang 在 `#version 300 es` 之外一律拒绝。这条断言是「不静默降级」的
// 核心：宁可编译失败，也不要把一份 1.00 文本当 3.00 塞进后端。
const FS_ES100:String =
  "#version 100\n" +
  "precision mediump float;\n" +
  "varying vec2 vUV;\n" +
  "void main() { gl_FragColor = vec4(vUV, 0.0, 1.0); }\n";

// legacy 语法：`attribute` 在 3.00 里已删除，必须报错而不是被容忍。
const VS_LEGACY:String =
  "#version 300 es\n" +
  "attribute vec2 aPos;\n" +
  "void main() { gl_Position = vec4(aPos, 0.0, 1.0); }\n";

// 顶层直接跑（examples 的约定：模块级语句就是程序体）。
check(Context3DNative.isAvailable(), "isAvailable() should be true in a --features native-shader build");

const c3n:Context3DNative = new Context3DNative(null);

// ---- 1 + 2 + 5: MRT + 反射 ----
const p:NativeProgram3D = c3n.uploadProgram(VS_OK, FS_OK);
check(p.ok, "MRT program should compile, infoLog=" + p.infoLog);
check(p.infoLog == "", "infoLog should be empty on success, got: " + p.infoLog);
check(p.colorAttachments == 2, "expected 2 colour attachments, got " + p.colorAttachments);
check(c3n.getTranslatedSource(p, true).length > 0, "translated vertex source must not be empty");
check(c3n.getTranslatedSource(p, false).length > 0, "translated fragment source must not be empty");
// 顶点属性 layout(location=0) ↔ 顶点流 0，编译期就已经钉死，不靠运行期约定。
check(p.findSlot("aPos", 3, STAGE_VERTEX) == 0, "aPos should be attribute location 0");
check(p.findSlot("uMVP", K_UNIFORM, STAGE_VERTEX) >= 0, "uMVP must be reflected in the vertex stage");
check(p.findSlot("uTime", K_UNIFORM, STAGE_VERTEX) >= 0, "uTime must be reflected in the vertex stage");
check(p.findSlot("uTime", K_UNIFORM, STAGE_FRAGMENT) >= 0, "uTime must ALSO be reflected in the fragment stage");
check(p.findSlot("uSpectrum", K_TEXTURE, STAGE_FRAGMENT) >= 0, "uSpectrum must be reflected as a fragment sampler");
// 大小写敏感的拼错必须查不到 —— setUniform 靠这张表把拼错变成 ArgumentError，
// 而不是静默保留旧值（那看起来就像「着色器不理我的光照」）。
check(p.findSlot("uMVP", K_UNIFORM, STAGE_FRAGMENT) == -1, "uMVP is not in the fragment stage");
check(p.findSlot("uMvp", K_UNIFORM, STAGE_VERTEX) == -1, "uniform lookup must be case sensitive");
check(p.findSlot("uSpectrum", K_UNIFORM, STAGE_FRAGMENT) == -1, "uSpectrum is a sampler, not a uniform");

// ---- 3: ES 1.00 被拒 ----
const bad:NativeProgram3D = c3n.uploadProgram(VS_OK, FS_ES100);
check(!bad.ok, "#version 100 must be rejected");
check(bad.infoLog.length > 0, "a rejected program must carry a non-empty infoLog");

// ---- 4: legacy attribute 语法被拒 ----
const legacy:NativeProgram3D = c3n.uploadProgram(VS_LEGACY, FS_OK);
check(!legacy.ok, "'attribute' must be rejected in ES 3.00");

trace("native-shader-probe OK");
trace("  MRT colour attachments: " + p.colorAttachments);
trace("  reflection entries: " + p.bindingNames.length);
trace("  ES1.00 rejection: " + bad.infoLog);
trace("  legacy rejection: " + legacy.infoLog);
