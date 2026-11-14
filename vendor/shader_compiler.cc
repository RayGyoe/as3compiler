// shader_compiler.cc -- GLSL ES 3.00 -> MSL / HLSL through the Khronos toolchain.
//
// The chain is the one Flutter Impeller and Godot 4 use in production:
//
//   GLSL ES 3.00 (author)   --glslang-->   SPIR-V   --SPIRV-Cross-->   MSL / HLSL
//
// Three facts about that chain were measured on this machine and are encoded
// below; each one is a real error I hit, not a guess (docs/zh-cn/native-shader-plan.md §3):
//
//  1. glslang refuses `#version 300 es` for SPIR-V output ("ES shaders for SPIR-V
//     require version 310 or higher"), so the version directive is raised to 310
//     in place before parsing. ES 3.10 is a superset of 3.00, and the author keeps
//     writing 3.00 -- the WebGL2 passthrough path still ships the original text.
//  2. `-V --target-env vulkan1.0` rejects loose uniforms ("non-opaque uniforms
//     outside a block"), i.e. exactly the `uniform float uTime;` shape three.js
//     authors write. So the SPIR-V environment is *OpenGL*, not Vulkan.
//  3. SPIR-V requires a location on every in/out, so auto-mapping is on; without
//     it a plain `out vec2 vUV;` fails with "'location' : SPIR-V requires location
//     for user input/output".
#include "shader_compiler.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <utility>
#include <vector>

#include <glslang/Public/ResourceLimits.h>
#include <glslang/Public/ShaderLang.h>
#include <SPIRV/GlslangToSpv.h>
#include <spirv_cross_c.h>

namespace {

const char* const kDefaultVersion = "#version 310 es\n";

// A found `#version` line: where it starts and how long it is, so the 310 upgrade
// can rewrite just that directive (line count unchanged => author line numbers in
// diagnostics stay valid).
struct VersionLine {
  size_t start = 0;
  size_t length = 0;
  int version = 0;
  bool is_es = false;
  bool found = false;
};

VersionLine scan_version(const char* src, size_t len) {
  VersionLine v;
  size_t line_start = 0;
  // Only the leading comment/blank block may hold `#version`; a `#version`
  // anywhere later is a syntax error glslang should report, not this scanner.
  while (line_start < len) {
    size_t line_end = line_start;
    while (line_end < len && src[line_end] != '\n') line_end++;
    size_t p = line_start;
    while (p < line_end && (src[p] == ' ' || src[p] == '\t' || src[p] == '\r')) p++;
    if (p < line_end && src[p] == '#') {
      // "#version"
      static const char kw[] = "#version";
      size_t k = 0;
      while (p + k < line_end && kw[k] != '\0' && src[p + k] == kw[k]) k++;
      if (kw[k] == '\0') {
        v.start = line_start;
        v.length = line_end - line_start;
        v.found = true;
        size_t q = p + k;
        while (q < line_end && (src[q] == ' ' || src[q] == '\t')) q++;
        int num = 0;
        while (q < line_end && src[q] >= '0' && src[q] <= '9') { num = num * 10 + (src[q] - '0'); q++; }
        v.version = num;
        while (q < line_end && (src[q] == ' ' || src[q] == '\t')) q++;
        v.is_es = (q + 1 < line_end && src[q] == 'e' && src[q + 1] == 's');
        return v;
      }
    } else if (p < line_end && src[p] == '/' && p + 1 < line_end && (src[p + 1] == '/' || src[p + 1] == '*')) {
      // A comment before `#version` is legal in ES 3.00.
    } else if (p < line_end) {
      // First real token is not `#version` => the shader has none.
      return v;
    }
    line_start = line_end + 1;
  }
  return v;
}

// Returns "" when acceptable, else the author-facing complaint.
std::string check_version(const char* src, size_t len, VersionLine* out) {
  VersionLine v = scan_version(src, len);
  *out = v;
  if (!v.found) return std::string();  // absent: we prepend 300 es (three.js shape)
  if (v.version != 300 || !v.is_es) {
    char buf[256];
    snprintf(buf, sizeof buf,
             "native shader: only `#version 300 es` (GLSL ES 3.00) is accepted, found "
             "`#version %d%s`; the 310/330 upgrade this backend performs internally is one-way",
             v.version, v.is_es ? " es" : "");
    return std::string(buf);
  }
  return std::string();
}

// The source glslang is fed: same line count, version directive raised to 310.
std::string to_spirv_source(const char* src, size_t len, const VersionLine& v) {
  std::string out;
  if (!v.found) {
    out.reserve(len + strlen(kDefaultVersion));
    out += kDefaultVersion;
    out.append(src, len);
    return out;
  }
  out.reserve(len + 8);
  out.append(src, v.start);
  out += "#version 310 es";
  // Keep whatever trailing text the author had on the directive line so the line
  // numbering (and any `// comment`) survives untouched.
  out.append(src + v.start + v.length, len - v.start - v.length);
  return out;
}

void error_out(asc_shader_program* out, const std::string& msg) {
  snprintf(out->error, sizeof out->error, "%s", msg.c_str());
}

// glslang is process-global state; initialise once, tolerate repeated calls.
bool ensure_glslang() {
  static bool ready = false;
  if (!ready) {
    ready = glslang::InitializeProcess();
  }
  return ready;
}

struct StageParse {
  glslang::TShader shader;
  explicit StageParse(EShLanguage lang) : shader(lang) {}
};

bool configure(glslang::TShader* shader, EShLanguage lang) {
  shader->setEnvInput(glslang::EShSourceGlsl, lang, glslang::EShClientOpenGL, 450);
  shader->setEnvClient(glslang::EShClientOpenGL, glslang::EShTargetOpenGL_450);
  shader->setEnvTarget(glslang::EShTargetSpv, glslang::EShTargetSpv_1_0);
  shader->setAutoMapLocations(true);
  shader->setAutoMapBindings(true);
  return true;
}

std::string trim_log(const char* log) {
  if (log == nullptr) return std::string();
  std::string s(log);
  while (!s.empty() && (s.back() == '\n' || s.back() == '\r' || s.back() == ' ')) s.pop_back();
  return s;
}

bool parse_pair(const std::string& vs, const std::string& fs,
                std::vector<uint32_t>* vs_spv, std::vector<uint32_t>* fs_spv,
                std::string* err) {
  glslang::TShader vshader(EShLangVertex);
  glslang::TShader fshader(EShLangFragment);
  configure(&vshader, EShLangVertex);
  configure(&fshader, EShLangFragment);
  const char* vsrc = vs.c_str();
  const char* fsrc = fs.c_str();
  vshader.setStrings(&vsrc, 1);
  fshader.setStrings(&fsrc, 1);
  vshader.setSourceFile("vertex shader");
  fshader.setSourceFile("fragment shader");
  const TBuiltInResource* res = GetDefaultResources();
  if (!vshader.parse(res, 310, false, EShMsgDefault)) {
    *err = "vertex: " + trim_log(vshader.getInfoLog());
    return false;
  }
  if (!fshader.parse(res, 310, false, EShMsgDefault)) {
    *err = "fragment: " + trim_log(fshader.getInfoLog());
    return false;
  }
  glslang::TProgram program;
  program.addShader(&vshader);
  program.addShader(&fshader);
  if (!program.link(EShMsgDefault)) {
    *err = "link: " + trim_log(program.getInfoLog());
    return false;
  }
  glslang::SpvOptions spv_options;
  spv_options.generateDebugInfo = false;
  spv_options.disableOptimizer = true;
  glslang::GlslangToSpv(*program.getIntermediate(EShLangVertex), *vs_spv, &spv_options);
  glslang::GlslangToSpv(*program.getIntermediate(EShLangFragment), *fs_spv, &spv_options);
  return true;
}

void add_binding(asc_shader_program* out, int* cap, const char* name, int kind, int binding,
                 int stage, int size, int components = 1, int base_type = ASC_SHADER_BASE_FLOAT) {
  if (name == nullptr || name[0] == '\0') return;
  if (out->binding_count == *cap) {
    int next = *cap == 0 ? 16 : *cap * 2;
    out->bindings = (asc_shader_binding*)realloc(out->bindings, sizeof(asc_shader_binding) * next);
    *cap = next;
  }
  asc_shader_binding* b = &out->bindings[out->binding_count++];
  b->name = strdup(name);
  b->kind = kind;
  b->binding = binding;
  b->stage = stage;
  b->size = size > 0 ? size : 1;
  b->components = components > 0 ? components : 1;
  b->base_type = base_type;
}

// Scalar count and scalar category of a uniform type, looking THROUGH an array to
// its element type (`uniform vec4 uSpecA[2]` -> components 4, size 2).
void type_info(spvc_compiler comp, spvc_type_id type_id, int* size_out, int* components_out,
               int* base_type_out) {
  spvc_type t = spvc_compiler_get_type_handle(comp, type_id);
  int size = 1;
  unsigned dims = spvc_type_get_num_array_dimensions(t);
  if (dims > 0) {
    size = 1;
    for (unsigned d = 0; d < dims; d++) {
      unsigned n = spvc_type_get_array_dimension(t, d);
      if (n > 0) size *= (int)n;
    }
    t = spvc_compiler_get_type_handle(comp, spvc_type_get_base_type_id(t));
  }
  int vec = (int)spvc_type_get_vector_size(t);
  if (vec <= 0) vec = 1;
  int cols = (int)spvc_type_get_columns(t);
  if (cols <= 0) cols = 1;
  int base = ASC_SHADER_BASE_FLOAT;
  switch (spvc_type_get_basetype(t)) {
    case SPVC_BASETYPE_INT8: case SPVC_BASETYPE_INT16: case SPVC_BASETYPE_INT32: case SPVC_BASETYPE_INT64:
      base = ASC_SHADER_BASE_INT; break;
    case SPVC_BASETYPE_UINT8: case SPVC_BASETYPE_UINT16: case SPVC_BASETYPE_UINT32: case SPVC_BASETYPE_UINT64:
      base = ASC_SHADER_BASE_UINT; break;
    case SPVC_BASETYPE_BOOLEAN:
      base = ASC_SHADER_BASE_BOOL; break;
    default:
      base = ASC_SHADER_BASE_FLOAT; break;
  }
  *size_out = size;
  *components_out = vec * cols;
  *base_type_out = base;
}

// ---------------------------------------------------------------------------
// MSL: read-only REFERENCE parameters become by-value parameters.
//
// WHAT GOES WRONG WITHOUT THIS. SPIRV-Cross promotes a plain (non-block) uniform
// into an entry-point parameter in the `constant` address space --
//
//   fs_main(constant float& uGain [[buffer(0)]], ...)
//
// and when a HELPER function reads that uniform it appends the uniform as one more
// parameter of the helper, but in the `thread` address space:
//
//   Med medium(thread const float& h, thread const float& uGain)
//   ...  Med m = medium(param, uGain);
//   // error: cannot bind reference in address space 'constant' to object in
//   //        default address space in 2nd argument
//
// Metal rejects that, so EVERY shader written as helpers-that-read-uniforms fails
// to compile: the Hillaire atmosphere (medium / transmittance / integrate), the FFT
// slopes, the underwater scattering loop. The alternative is inlining every helper
// by hand, i.e. encoding "write shaders the awkward way" into the engine -- which is
// exactly what this project refuses to do.
//
// WHY BY-VALUE IS SEMANTICS-PRESERVING. SPIRV-Cross only emits `thread const T&`
// for objects that are never written (a written one loses the `const`). A copy of a
// read-only scalar/vector/matrix/small struct is therefore observably identical.
//
// SCOPE. Only FUNCTION PARAMETER LISTS are rewritten: the same qualifier also
// appears on local aliases, and while copying those would usually be fine too, the
// parameter list is the shape we have measured Metal rejecting. MSL only -- HLSL
// and GLSL have no address spaces.
static void normalize_msl_param_refs(std::string& src) {
  static const char* kQualifier = "thread const ";
  static const size_t kThread = 7;   // strlen("thread ")
  const size_t qlen = strlen(kQualifier);
  std::string out;
  out.reserve(src.size());
  size_t pos = 0;      // first source byte not yet copied
  size_t search = 0;
  while (true) {
    size_t i = src.find(kQualifier, search);
    if (i == std::string::npos) break;
    search = i + qlen;
    // Only a parameter list: the previous non-space character must be '(' (first
    // parameter) or ',' (any later one). A local alias declaration cannot follow a
    // comma -- SPIRV-Cross emits one statement per alias -- so this is precise for
    // the shapes it produces.
    size_t k = i;
    while (k > 0 && (src[k - 1] == ' ' || src[k - 1] == '\t')) k--;
    if (k == 0 || (src[k - 1] != '(' && src[k - 1] != ',')) continue;
    // Find the '&' that closes the declarator, skipping template arguments so
    // `spvUnsafeArray<float, 4>&` keeps its comma.
    size_t j = i + qlen;
    int depth = 0;
    bool found = false;
    while (j < src.size()) {
      char c = src[j];
      if (c == '<') depth++;
      else if (c == '>') { if (depth > 0) depth--; }
      else if (c == '&' && depth == 0) { found = true; break; }
      else if (c == ';' || c == '{' || c == '}' || c == ')' || c == '\n') break;
      j++;
    }
    if (!found) continue;
    out.append(src, pos, i - pos);          // up to the qualifier
    out.append(src, i + kThread, j - (i + kThread));   // "const T" without the '&'
    pos = j + 1;                            // skip the '&'
    search = pos;
  }
  out.append(src, pos, src.size() - pos);
  src.swap(out);
}

// Matrix uniforms must be declared `row_major` in HLSL. WHY, measured:
//
// SPIRV-Cross translates GLSL `M * v` into `mul(v, M)` (row-vector convention),
// which is only equivalent to `M * v` when the matrix arrives TRANSPOSED. With the
// default column_major packing -- i.e. the exact byte order `mat4` uniforms are
// uploaded in everywhere else in this engine, and the order Metal consumes
// unchanged -- the product is silently `M^T v`. On temp/s3dnat's identity-ish
// matrices that difference is invisible; on a real camera matrix it puts the
// whole scene out of clip space and the frame comes out EMPTY, with no error from
// D3DCompile, no PSO failure and every uniform readback correct.
// (apps/shader-m30 was black for exactly this reason: swapping only the vertex
// stage to `row_major` and nothing else makes it render.)
//
// `row_major` flips the interpretation, not the data: the same column-major bytes
// then read as the transposed logical matrix, `mul(v, M)` becomes `M * v`, and the
// AS3 side keeps uploading matrices in the one order that works on both backends.
// Nested products are consistent too, because HLSL's `mul(A, B)` is the logical
// product whatever the storage class is.
//
// Only DECLARATOR lines are rewritten (a matrix type followed by a name), so
// constructors, casts and function return types written by hand are left alone.
// HLSL only -- MSL and GLSL are column-major natively.
static bool is_matrix_type(const std::string& s, size_t pos, size_t* end) {
  static const char* kFloat = "float";
  if (s.compare(pos, 5, kFloat) != 0) return false;
  size_t p = pos + 5;
  if (p >= s.size() || s[p] < '1' || s[p] > '4') return false;
  p++;
  if (p >= s.size() || s[p] != 'x') return false;
  p++;
  if (p >= s.size() || s[p] < '1' || s[p] > '4') return false;
  p++;
  if (p < s.size()) {
    const char c = s[p];
    if ((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
        c == '_')
      return false;   // float4x4Ext or float4x4foo: not a matrix type
  }
  *end = p;
  return true;
}

static void make_matrices_row_major(std::string& src) {
  const char* kQualifiers[] = { "uniform", "static", "const", "row_major" };
  std::string out;
  out.reserve(src.size() + 64);
  size_t line_start = 0;
  while (line_start < src.size()) {
    size_t line_end = src.find('\n', line_start);
    if (line_end == std::string::npos) line_end = src.size();
    const std::string line = src.substr(line_start, line_end - line_start);
    size_t pos = 0;
    while (pos < line.size() && (line[pos] == ' ' || line[pos] == '\t')) pos++;
    bool already = false;
    for (bool progressed = true; progressed;) {
      progressed = false;
      for (size_t q = 0; q < sizeof kQualifiers / sizeof kQualifiers[0]; q++) {
        const size_t len = strlen(kQualifiers[q]);
        if (line.compare(pos, len, kQualifiers[q]) != 0) continue;
        const size_t after = pos + len;
        if (after < line.size() && line[after] != ' ' && line[after] != '\t' && line[after] != '(')
          continue;
        if (q == 3) already = true;
        pos = after;
        while (pos < line.size() && (line[pos] == ' ' || line[pos] == '\t')) pos++;
        progressed = true;
        break;
      }
    }
    size_t type_end = 0;
    if (!already && is_matrix_type(line, pos, &type_end)) {
      // A declarator needs a name after the type; `float4x4(...)` is a cast.
      size_t name = type_end;
      while (name < line.size() && (line[name] == ' ' || line[name] == '\t')) name++;
      const bool declarator = name < line.size() &&
          ((line[name] >= 'a' && line[name] <= 'z') || (line[name] >= 'A' && line[name] <= 'Z') ||
           line[name] == '_') && line.find(';') != std::string::npos;
      if (declarator) {
        out.append(src, line_start, pos);
        out += "row_major ";
        out.append(src, line_start + pos, line_end - line_start - pos);
        out += '\n';
        line_start = (line_end < src.size()) ? line_end + 1 : line_end;
        continue;
      }
    }
    out.append(src, line_start, line_end - line_start);
    if (line_end < src.size()) out += '\n';
    line_start = (line_end < src.size()) ? line_end + 1 : line_end;
  }
  src.swap(out);
}

int resource_array_size(spvc_compiler comp, spvc_type_id type_id) {
  spvc_type t = spvc_compiler_get_type_handle(comp, type_id);
  if (spvc_type_get_num_array_dimensions(t) == 0) return 1;
  unsigned d = spvc_type_get_array_dimension(t, 0);
  return d > 0 ? (int)d : 1;
}

// The slot of ONE stage input, as the emitted HLSL/MSL declaration numbers it.
//
// A GLSL ES 3.00 vertex shader need NOT declare layout(location): glslang then
// emits the variable with no Location decoration, and SPIRV-Cross numbers the
// attributes itself in SPIR-V ID order -- which is DECLARATION order, because the
// ids of globals are allocated as they are declared. Reading the absent decoration
// as 0 (what spvc_compiler_get_decoration returns) reported every attribute as
// slot 0: measured on the D3D12 probe, `in vec3 aPos; in vec2 aUV;` reflected as
// aPos=0 AND aUV=0 while the HLSL emitted `aPos : TEXCOORD0, aUV : TEXCOORD1`, so a
// host binding streams by the reflected slot fed one stream twice.
static unsigned stage_input_slot(spvc_compiler comp, const spvc_reflected_resource* list,
                                 size_t count, size_t i) {
  if (spvc_compiler_has_decoration(comp, list[i].id, SpvDecorationLocation))
    return spvc_compiler_get_decoration(comp, list[i].id, SpvDecorationLocation);
  unsigned rank = 0;
  for (size_t j = 0; j < count; j++) {
    if (j == i) continue;
    if (spvc_compiler_has_decoration(comp, list[j].id, SpvDecorationLocation)) continue;
    if (list[j].id < list[i].id) rank++;
  }
  return rank;   // rank among the UNDECORATED inputs, by id
}

// Give every stage input a Location before code generation.
//
// glslang leaves the decoration off a GLSL ES 3.00 attribute (locations are optional
// there), and the two consumers then disagree about the numbering: SPIRV-Cross's
// HLSL emits `aPos : TEXCOORD0, aUV : TEXCOORD1` in DECLARATION order, while
// spvc_compiler_get_decoration answers whatever location glslang happened to pick
// (measured: aUV=0, aPos=1 -- the opposite order). A host that binds attribute
// streams by the reflected slot then feeds one stream twice.
//
// Pinning the undecorated inputs to declaration order (SPIR-V id order, ids being
// allocated as the globals are declared) makes all three agree, and leaves a
// shader that DOES declare layout(location) exactly as it is: decorated inputs keep
// their location, and the pinned ones start above the highest of them.
// VARYINGS ARE LINKED BY NAME IN HLSL, NOT BY LOCATION.
//
// GLSL ES 3.00 is free to omit `layout(location)` on a varying, and both stages of a
// pair then get their TEXCOORD index from SPIRV-Cross's own numbering -- which is
// per stage and depends on declaration order. Measured on the city shader: the
// vertex stage emitted `vDepth : TEXCOORD0, vNormal : TEXCOORD1, vUV : TEXCOORD2,
// vWorld : TEXCOORD3`, while the fragment stage (pinned below by SPIR-V id order)
// asked for `vUV : TEXCOORD0, vNormal : TEXCOORD1, vWorld : TEXCOORD2,
// vDepth : TEXCOORD3`. D3D validates VS-out against PS-in when the pipeline state
// object is created and answers E_INVALIDARG -- CreateGraphicsPipelineState fails,
// the draw is dropped, and nothing about it is visible in the frame. Metal and GL
// link varyings by location, which is why the same pair was fine there.
//
// So the two stages are given ONE name -> index table, built before either is
// translated: the union of the vertex outputs and the fragment inputs, sorted by
// name. Sorting by name (rather than by per-stage id) is what makes the two
// independent compilations agree, and taking the UNION first is what keeps them
// agreeing when one stage drops a varying the other still writes.
typedef std::vector<std::pair<std::string, int>> VaryingTable;

// Names of one stage's varyings; built from the SPIR-V module alone, so it costs a
// second parse and no code generation.
static void collect_stage_names(const std::vector<uint32_t>& spv, spvc_resource_type rt,
                                std::vector<std::string>* names) {
  spvc_context ctx = nullptr;
  if (spvc_context_create(&ctx) != SPVC_SUCCESS) return;
  spvc_parsed_ir ir = nullptr;
  if (spvc_context_parse_spirv(ctx, spv.data(), spv.size(), &ir) == SPVC_SUCCESS) {
    spvc_compiler comp = nullptr;
    if (spvc_context_create_compiler(ctx, SPVC_BACKEND_HLSL, ir,
                                     SPVC_CAPTURE_MODE_TAKE_OWNERSHIP, &comp) == SPVC_SUCCESS) {
      spvc_resources res = nullptr;
      if (spvc_compiler_create_shader_resources(comp, &res) == SPVC_SUCCESS) {
        const spvc_reflected_resource* list = nullptr;
        size_t count = 0;
        if (spvc_resources_get_resource_list_for_type(res, rt, &list, &count) == SPVC_SUCCESS) {
          for (size_t i = 0; i < count; i++) {
            // gl_Position / SV_Target / gl_FragCoord are built-ins and take no
            // location; setting one on them is an error, not a rename.
            if (spvc_compiler_has_decoration(comp, list[i].id, SpvDecorationBuiltIn)) continue;
            if (list[i].name == nullptr || list[i].name[0] == '\0') continue;
            names->push_back(std::string(list[i].name));
          }
        }
      }
    }
  }
  spvc_context_destroy(ctx);
}

static void build_varying_table(const std::vector<uint32_t>& vs_spv,
                                const std::vector<uint32_t>& fs_spv, VaryingTable* vt) {
  std::vector<std::string> names;
  collect_stage_names(vs_spv, SPVC_RESOURCE_TYPE_STAGE_OUTPUT, &names);
  collect_stage_names(fs_spv, SPVC_RESOURCE_TYPE_STAGE_INPUT, &names);
  std::sort(names.begin(), names.end());
  names.erase(std::unique(names.begin(), names.end()), names.end());
  vt->clear();
  for (size_t i = 0; i < names.size(); i++) vt->push_back(std::make_pair(names[i], (int)i));
}

static int varying_slot(const VaryingTable& vt, const char* name) {
  if (name == nullptr) return -1;
  for (size_t i = 0; i < vt.size(); i++) {
    if (vt[i].first == name) return vt[i].second;
  }
  return -1;
}

// Give one stage's varyings the shared table's indices: the vertex stage's outputs,
// or the fragment stage's inputs. Attributes (the vertex stage's inputs) are NOT
// touched here -- they keep pin_stage_input_locations' rule, and the host binds
// streams by the slots that reflection reports for it.
static void pin_hlsl_varyings(spvc_compiler comp, int stage, const VaryingTable* vt) {
  if (vt == nullptr || vt->empty()) return;
  const spvc_resource_type rt = (stage == 0) ? SPVC_RESOURCE_TYPE_STAGE_OUTPUT
                                             : SPVC_RESOURCE_TYPE_STAGE_INPUT;
  spvc_resources res = nullptr;
  if (spvc_compiler_create_shader_resources(comp, &res) != SPVC_SUCCESS) return;
  const spvc_reflected_resource* list = nullptr;
  size_t count = 0;
  if (spvc_resources_get_resource_list_for_type(res, rt, &list, &count) != SPVC_SUCCESS) return;
  for (size_t i = 0; i < count; i++) {
    if (spvc_compiler_has_decoration(comp, list[i].id, SpvDecorationBuiltIn)) continue;
    if (spvc_compiler_has_decoration(comp, list[i].id, SpvDecorationLocation)) continue;
    const int slot = varying_slot(*vt, list[i].name);
    if (slot < 0) continue;
    if (getenv("ASC_NATIVE_DUMP_BINDINGS"))
      fprintf(stderr, "[pinvary] %s -> %d\n", list[i].name, slot);
    spvc_compiler_set_decoration(comp, list[i].id, SpvDecorationLocation, (unsigned)slot);
  }
}

static void pin_stage_input_locations(spvc_compiler comp) {
  spvc_resources res = nullptr;
  if (spvc_compiler_create_shader_resources(comp, &res) != SPVC_SUCCESS) return;
  const spvc_reflected_resource* list = nullptr;
  size_t count = 0;
  if (spvc_resources_get_resource_list_for_type(res, SPVC_RESOURCE_TYPE_STAGE_INPUT,
                                                &list, &count) != SPVC_SUCCESS)
    return;
  unsigned next = 0;
  for (size_t i = 0; i < count; i++) {
    if (!spvc_compiler_has_decoration(comp, list[i].id, SpvDecorationLocation)) continue;
    const unsigned l = spvc_compiler_get_decoration(comp, list[i].id, SpvDecorationLocation);
    if (l + 1 > next) next = l + 1;
  }
  // Two passes on purpose: ranking must see the ORIGINAL decoration state. Doing it
  // in one pass pins the first input, which then counts as "decorated" for the next
  // one's rank -- measured: aUV and aPos both came out as location 0, and both were
  // emitted as TEXCOORD0, which is worse than the bug being fixed.
  size_t pinned[32];
  unsigned slot_of[32];
  size_t npinned = 0;
  for (size_t i = 0; i < count && npinned < 32; i++) {
    if (spvc_compiler_has_decoration(comp, list[i].id, SpvDecorationLocation)) continue;
    unsigned rank = 0;
    for (size_t j = 0; j < count; j++) {
      if (j == i) continue;
      if (spvc_compiler_has_decoration(comp, list[j].id, SpvDecorationLocation)) continue;
      if (list[j].id < list[i].id) rank++;
    }
    pinned[npinned] = i;
    slot_of[npinned] = next + rank;
    npinned++;
  }
  for (size_t k = 0; k < npinned; k++) {
    if (getenv("ASC_NATIVE_DUMP_BINDINGS"))
      fprintf(stderr, "[pinloc] %s id=%u -> %u\n", list[pinned[k]].name,
              list[pinned[k]].id, slot_of[k]);
    spvc_compiler_set_decoration(comp, list[pinned[k]].id, SpvDecorationLocation, slot_of[k]);
  }
}

// Reflection for the MSL backend: the automatic resource indices are what the
// emitted declarations actually use, so they are read back rather than recomputed.
void reflect_msl(spvc_compiler comp, int stage, asc_shader_program* out, int* cap) {
  spvc_resources res = nullptr;
  if (spvc_compiler_create_shader_resources(comp, &res) != SPVC_SUCCESS) return;
  const spvc_reflected_resource *list = nullptr;
  size_t count = 0;

  if (stage == 0) {
    if (spvc_resources_get_resource_list_for_type(res, SPVC_RESOURCE_TYPE_STAGE_INPUT, &list, &count) == SPVC_SUCCESS) {
      for (size_t i = 0; i < count; i++) {
        const unsigned loc = stage_input_slot(comp, list, count, i);
        add_binding(out, cap, list[i].name, ASC_SHADER_KIND_ATTRIBUTE, (int)loc, stage,
                    resource_array_size(comp, list[i].type_id));
      }
    }
  }
  // Loose uniforms (`uniform float uTime;`) each get their own [[buffer(N)]].
  if (spvc_resources_get_resource_list_for_type(res, SPVC_RESOURCE_TYPE_GL_PLAIN_UNIFORM, &list, &count) == SPVC_SUCCESS) {
    for (size_t i = 0; i < count; i++) {
      unsigned idx = spvc_compiler_msl_get_automatic_resource_binding(comp, list[i].id);
      if (idx == (unsigned)-1) continue;
      int usize = 1, ucomp = 1, ubase = ASC_SHADER_BASE_FLOAT;
      type_info(comp, list[i].type_id, &usize, &ucomp, &ubase);
      add_binding(out, cap, list[i].name, ASC_SHADER_KIND_UNIFORM, (int)idx, stage, usize, ucomp, ubase);
    }
  }
  if (spvc_resources_get_resource_list_for_type(res, SPVC_RESOURCE_TYPE_UNIFORM_BUFFER, &list, &count) == SPVC_SUCCESS) {
    for (size_t i = 0; i < count; i++) {
      unsigned idx = spvc_compiler_msl_get_automatic_resource_binding(comp, list[i].id);
      if (idx == (unsigned)-1) continue;
      add_binding(out, cap, list[i].name, ASC_SHADER_KIND_UNIFORM, (int)idx, stage, 1);
    }
  }
  // Combined image samplers: primary = texture slot, secondary = sampler slot.
  // We hand out the texture slot; the glue binds the sampler at the same index
  // because SPIRV-Cross assigns both from the same counter for combined samplers.
  if (spvc_resources_get_resource_list_for_type(res, SPVC_RESOURCE_TYPE_SAMPLED_IMAGE, &list, &count) == SPVC_SUCCESS) {
    for (size_t i = 0; i < count; i++) {
      unsigned idx = spvc_compiler_msl_get_automatic_resource_binding(comp, list[i].id);
      if (idx == (unsigned)-1) continue;
      add_binding(out, cap, list[i].name, ASC_SHADER_KIND_TEXTURE, (int)idx, stage,
                  resource_array_size(comp, list[i].type_id));
    }
  }
  if (spvc_resources_get_resource_list_for_type(res, SPVC_RESOURCE_TYPE_SEPARATE_IMAGE, &list, &count) == SPVC_SUCCESS) {
    for (size_t i = 0; i < count; i++) {
      unsigned idx = spvc_compiler_msl_get_automatic_resource_binding(comp, list[i].id);
      if (idx == (unsigned)-1) continue;
      add_binding(out, cap, list[i].name, ASC_SHADER_KIND_TEXTURE, (int)idx, stage,
                  resource_array_size(comp, list[i].type_id));
    }
  }
}

// ---------------------------------------------------------------------------
// HLSL (D3D12): pin the registers, then answer reflection from the same numbers.
//
// WHY MSL'S SHAPE DOES NOT CARRY OVER. Metal lets SPIRV-Cross hand EVERY loose
// uniform its own `[[buffer(N)]]`, so the host uploads 64 bytes per uniform and
// never thinks about packing. HLSL has no such form: loose uniforms land in the
// implicit `$Globals` constant buffer at b0 and D3D decides their byte offsets, so
// "slot -> where do I write these floats" has two halves:
//
//   * WHICH buffer -- that is a register, and it is ours to pin. Left alone,
//     SPIRV-Cross numbers resources in module order, which is not the order this
//     table enumerates them; a two-texture shader would then bind t0/t1 to the
//     wrong names with no error anywhere. So each image is pinned to tN/sN where N
//     is the slot this table publishes.
//   * WHICH offset -- D3D12 asks D3DReflect for it by NAME at program-create time
//     (stage3d_d3d.cc). Keeping the offset out of this ABI is deliberate: cbuffer
//     packing rules are D3D's, and duplicating them here is how the two ends drift.
//
// Slots are per stage and per kind, exactly like the MSL path: the AS3 side looks
// uniforms up as (name, kind, stage).
// 64, not 16. This is only an ENUMERATION bound -- the host looks a uniform up by
// NAME and reads its byte offset from D3DReflect, so the slot is a key and nothing
// else. It was 16, and the city shader (20 loose uniforms) silently lost the last
// four: `smoothstep(uFogNear, uFogFar, …)` read 0 and the tone operator multiplied
// by a uExposure that was never uploaded, i.e. a black frame from a reflection
// truncation rather than from a shader error. 64 matches S3D_MAX_NRV, the number
// the D3D12 backend can actually track per stage.
const int HLSL_MAX_UNIFORM_SLOTS = 64;
const int HLSL_UBO_REGISTER_BASE = 8;

void pin_hlsl_registers(spvc_compiler comp, int stage) {
  const SpvExecutionModel model = stage == 0 ? SpvExecutionModelVertex : SpvExecutionModelFragment;
  spvc_resources res = nullptr;
  if (spvc_compiler_create_shader_resources(comp, &res) != SPVC_SUCCESS) return;
  const spvc_reflected_resource *list = nullptr;
  size_t count = 0;

  // Images: register N == slot N, so the glue's bindTexture(unit) reaches the
  // texture the reflection reported under the same number.
  const spvc_resource_type image_types[2] = {SPVC_RESOURCE_TYPE_SAMPLED_IMAGE, SPVC_RESOURCE_TYPE_SEPARATE_IMAGE};
  for (int t = 0; t < 2; t++) {
    if (spvc_resources_get_resource_list_for_type(res, image_types[t], &list, &count) != SPVC_SUCCESS) continue;
    for (size_t i = 0; i < count; i++) {
      spvc_hlsl_resource_binding b;
      memset(&b, 0, sizeof b);
      b.stage = model;
      b.desc_set = spvc_compiler_get_decoration(comp, list[i].id, SpvDecorationDescriptorSet);
      // Every combined image-sampler comes out of build_combined_image_samplers with
      // binding 0 (glslang leaves loose sampler bindings at 0 in OpenGL mode), and
      // spvc_hlsl_resource_binding keys on (set, binding) -- so two textures would
      // pin to the SAME register and the emitted pair reads t1/t1, which compiles
      // and samples the wrong texture. Give each one its own binding first.
      spvc_compiler_set_decoration(comp, list[i].id, SpvDecorationBinding, (unsigned)i);
      b.binding = (unsigned)i;
      if (getenv("ASC_NATIVE_DUMP_BINDINGS"))
        fprintf(stderr, "[pin] %s set=%u binding=%u -> t%zu\n", list[i].name, b.desc_set, b.binding, i);
      b.srv.register_space = 0;
      b.srv.register_binding = (unsigned)i;
      b.sampler.register_space = 0;
      b.sampler.register_binding = (unsigned)i;
      if (getenv("ASC_NO_PIN")) { /* probe: rely on auto numbering */ } else spvc_compiler_hlsl_add_resource_binding(comp, &b);
    }
  }
  // Explicit uniform BLOCKS go to b8.. so they cannot collide with $Globals at b0.
  if (spvc_resources_get_resource_list_for_type(res, SPVC_RESOURCE_TYPE_UNIFORM_BUFFER, &list, &count) == SPVC_SUCCESS) {
    for (size_t i = 0; i < count; i++) {
      spvc_hlsl_resource_binding b;
      memset(&b, 0, sizeof b);
      b.stage = model;
      b.desc_set = spvc_compiler_get_decoration(comp, list[i].id, SpvDecorationDescriptorSet);
      b.binding = spvc_compiler_get_decoration(comp, list[i].id, SpvDecorationBinding);
      b.cbv.register_space = 0;
      b.cbv.register_binding = (unsigned)(HLSL_UBO_REGISTER_BASE + i);
      spvc_compiler_hlsl_add_resource_binding(comp, &b);
    }
  }
}

void reflect_hlsl(spvc_compiler comp, int stage, asc_shader_program* out, int* cap) {
  spvc_resources res = nullptr;
  if (spvc_compiler_create_shader_resources(comp, &res) != SPVC_SUCCESS) return;
  const spvc_reflected_resource *list = nullptr;
  size_t count = 0;

  if (stage == 0) {
    if (spvc_resources_get_resource_list_for_type(res, SPVC_RESOURCE_TYPE_STAGE_INPUT, &list, &count) == SPVC_SUCCESS) {
      for (size_t i = 0; i < count; i++) {
        const unsigned loc = stage_input_slot(comp, list, count, i);
        add_binding(out, cap, list[i].name, ASC_SHADER_KIND_ATTRIBUTE, (int)loc, stage,
                    resource_array_size(comp, list[i].type_id));
      }
    }
  }
  // Loose uniforms share $Globals, so the slot can only be a handle the host uses
  // to find the NAME again (it is the key into the backend's D3DReflect table).
  if (spvc_resources_get_resource_list_for_type(res, SPVC_RESOURCE_TYPE_GL_PLAIN_UNIFORM, &list, &count) == SPVC_SUCCESS) {
    for (size_t i = 0; i < count && (int)i < HLSL_MAX_UNIFORM_SLOTS; i++) {
      int usize = 1, ucomp = 1, ubase = ASC_SHADER_BASE_FLOAT;
      type_info(comp, list[i].type_id, &usize, &ucomp, &ubase);
      add_binding(out, cap, list[i].name, ASC_SHADER_KIND_UNIFORM, (int)i, stage, usize, ucomp, ubase);
    }
  }
  if (spvc_resources_get_resource_list_for_type(res, SPVC_RESOURCE_TYPE_UNIFORM_BUFFER, &list, &count) == SPVC_SUCCESS) {
    for (size_t i = 0; i < count; i++)
      add_binding(out, cap, list[i].name, ASC_SHADER_KIND_UNIFORM, HLSL_UBO_REGISTER_BASE + (int)i, stage, 1);
  }
  const spvc_resource_type image_types[2] = {SPVC_RESOURCE_TYPE_SAMPLED_IMAGE, SPVC_RESOURCE_TYPE_SEPARATE_IMAGE};
  for (int t = 0; t < 2; t++) {
    if (spvc_resources_get_resource_list_for_type(res, image_types[t], &list, &count) != SPVC_SUCCESS) continue;
    for (size_t i = 0; i < count; i++)
      add_binding(out, cap, list[i].name, ASC_SHADER_KIND_TEXTURE, (int)i, stage,
                  resource_array_size(comp, list[i].type_id));
  }
}

// Opt-in dump of the reflection table. The native channel binds by reflected name,
// so "my uniform is always 0" is either "the program never declared it" or "the
// reflection stopped early"; both are invisible from AS3 and this is the only place
// that can distinguish them.
static void dump_bindings(const char* stage_name, const asc_shader_program* out) {
  if (getenv("ASC_NATIVE_DUMP_BINDINGS") == NULL) return;
  fprintf(stderr, "[bindings] %s: %d\n", stage_name, out->binding_count);
  for (int i = 0; i < out->binding_count; i++) {
    const asc_shader_binding& b = out->bindings[i];
    fprintf(stderr, "[bindings]   %d kind=%d slot=%d size=%d comp=%d base=%d %s\n",
            b.stage, b.kind, b.binding, b.size, b.components, b.base_type, b.name);
  }
}

int count_color_attachments(spvc_compiler comp) {
  spvc_resources res = nullptr;
  if (spvc_compiler_create_shader_resources(comp, &res) != SPVC_SUCCESS) return 1;
  const spvc_reflected_resource *list = nullptr;
  size_t count = 0;
  if (spvc_resources_get_resource_list_for_type(res, SPVC_RESOURCE_TYPE_STAGE_OUTPUT, &list, &count) != SPVC_SUCCESS)
    return 1;
  int max_loc = -1;
  for (size_t i = 0; i < count; i++) {
    unsigned loc = spvc_compiler_get_decoration(comp, list[i].id, SpvDecorationLocation);
    if ((int)loc > max_loc) max_loc = (int)loc;
  }
  return max_loc + 1;
}

struct StageResult {
  std::string source;
  int color_attachments = 1;
};

// Compile one stage to the target language and fill reflection for it.
bool cross_compile(const std::vector<uint32_t>& spv, spvc_backend backend, int stage,
                   const char* entry_name, StageResult* result, asc_shader_program* out,
                   int* cap, const VaryingTable* vt, std::string* err) {
  spvc_context ctx = nullptr;
  if (spvc_context_create(&ctx) != SPVC_SUCCESS) {
    *err = "SPIRV-Cross: cannot create context";
    return false;
  }
  spvc_parsed_ir ir = nullptr;
  if (spvc_context_parse_spirv(ctx, spv.data(), spv.size(), &ir) != SPVC_SUCCESS) {
    *err = std::string("SPIRV-Cross: ") + spvc_context_get_last_error_string(ctx);
    spvc_context_destroy(ctx);
    return false;
  }
  spvc_compiler comp = nullptr;
  if (spvc_context_create_compiler(ctx, backend, ir, SPVC_CAPTURE_MODE_TAKE_OWNERSHIP, &comp) != SPVC_SUCCESS) {
    *err = std::string("SPIRV-Cross: ") + spvc_context_get_last_error_string(ctx);
    spvc_context_destroy(ctx);
    return false;
  }
  spvc_compiler_options opts = nullptr;
  if (spvc_compiler_create_compiler_options(comp, &opts) == SPVC_SUCCESS) {
    if (backend == SPVC_BACKEND_MSL) {
      spvc_compiler_options_set_uint(opts, SPVC_COMPILER_OPTION_MSL_VERSION, SPVC_MAKE_MSL_VERSION(2, 1, 0));
      // ES semantics: clip-space Z is [0, w] on both D3D and Metal. glslang emits
      // GL-style clip space, so let SPIRV-Cross fix it up rather than every shader
      // carrying the conversion.
      spvc_compiler_options_set_bool(opts, SPVC_COMPILER_OPTION_FIXUP_DEPTH_CONVENTION, SPVC_TRUE);
    } else if (backend == SPVC_BACKEND_HLSL) {
      spvc_compiler_options_set_uint(opts, SPVC_COMPILER_OPTION_HLSL_SHADER_MODEL, 51);
      // Emit `vs_main` / `fs_main` as the entry names instead of the wrapper `main`:
      // D3DCompile takes one entry point name per stage and a VS/PS pair that both
      // say "main" reads as a typo, not as a convention. (Ignored by older
      // SPIRV-Cross, which always writes `main`; the backend reads the real name
      // back from the blob instead of guessing -- see stage3d_d3d.cc.)
      spvc_compiler_options_set_bool(opts, SPVC_COMPILER_OPTION_HLSL_USE_ENTRY_POINT_NAME, SPVC_TRUE);
    }
    spvc_compiler_install_compiler_options(comp, opts);
  }
  // glslang emits separate texture/sampler pairs for OpenGL SPIR-V; Metal wants the
  // combined form (texture + sampler as one logical object).
  if (spvc_compiler_build_combined_image_samplers(comp) != SPVC_SUCCESS) {
    *err = std::string("SPIRV-Cross: ") + spvc_context_get_last_error_string(ctx);
    spvc_context_destroy(ctx);
    return false;
  }
  // `main` -> `vs_main` / `fs_main`, which is what stage3d_glue.mm looks up. Done
  // through the API, not by rewriting the text: a textual replace would also hit
  // "main0" inside comments and identifiers.
  spvc_compiler_rename_entry_point(comp, "main", entry_name,
                                   stage == 0 ? SpvExecutionModelVertex : SpvExecutionModelFragment);
  // Before any code generation: the reflected attribute slots and the emitted
  // TEXCOORD/attribute indices must be the same numbering (see the helper).
  //
  // The VERTEX stage's inputs are its attributes, so they are pinned there on both
  // backends. The FRAGMENT stage's inputs are varyings, whose numbering only works
  // out if it is shared with the vertex stage -- on HLSL that comes from the table
  // below, on MSL from the per-stage id rule as before (Metal's varyings are
  // [[user(locnN)]] and the pair has always linked there).
  if (stage == 0 || backend == SPVC_BACKEND_MSL) pin_stage_input_locations(comp);
  if (backend == SPVC_BACKEND_HLSL) {
    pin_hlsl_varyings(comp, stage, vt);
    pin_hlsl_registers(comp, stage);
  }
  const char* src = nullptr;
  if (spvc_compiler_compile(comp, &src) != SPVC_SUCCESS || src == nullptr) {
    *err = std::string("SPIRV-Cross: ") + spvc_context_get_last_error_string(ctx);
    spvc_context_destroy(ctx);
    return false;
  }
  result->source.assign(src);
  if (backend == SPVC_BACKEND_MSL) normalize_msl_param_refs(result->source);
  if (backend == SPVC_BACKEND_HLSL) make_matrices_row_major(result->source);
  // Reflection must run AFTER compile: the automatic resource indices are assigned
  // during code generation, so querying earlier returns unset decorations.
  if (backend == SPVC_BACKEND_MSL) {
    reflect_msl(comp, stage, out, cap);
    dump_bindings(stage == 0 ? "vs" : "fs", out);
    if (stage == 1) result->color_attachments = count_color_attachments(comp);
  } else if (backend == SPVC_BACKEND_HLSL) {
    reflect_hlsl(comp, stage, out, cap);
    dump_bindings(stage == 0 ? "vs" : "fs", out);
    if (stage == 1) result->color_attachments = count_color_attachments(comp);
  }
  spvc_context_destroy(ctx);  // frees comp/ir/strings; we already copied the text
  return true;
}

}  // namespace

extern "C" {

const char* asc_shader_backend_info(void) {
  return "glslang + SPIRV-Cross (Khronos, Apache-2.0)";
}

void asc_shader_program_free(asc_shader_program* p) {
  if (p == nullptr) return;
  free(p->vertex_source);
  free(p->fragment_source);
  for (int i = 0; i < p->binding_count; i++) free(p->bindings[i].name);
  free(p->bindings);
  memset(p, 0, sizeof *p);
}

int asc_shader_translate(const char* vs, const char* fs, int target, asc_shader_program* out) {
  if (out == nullptr) return 0;
  memset(out, 0, sizeof *out);
  if (vs == nullptr || fs == nullptr) {
    error_out(out, "native shader: vertex and fragment source are both required");
    return 0;
  }
  if (target != ASC_SHADER_TARGET_MSL && target != ASC_SHADER_TARGET_GLSL_ES3 && target != ASC_SHADER_TARGET_HLSL) {
    error_out(out, "native shader: unknown target language");
    return 0;
  }
  if (!ensure_glslang()) {
    error_out(out, "native shader: glslang failed to initialise");
    return 0;
  }

  const size_t vs_len = strlen(vs);
  const size_t fs_len = strlen(fs);
  VersionLine vs_ver, fs_ver;
  std::string verr = check_version(vs, vs_len, &vs_ver);
  if (!verr.empty()) { error_out(out, "vertex shader: " + verr); return 0; }
  verr = check_version(fs, fs_len, &fs_ver);
  if (!verr.empty()) { error_out(out, "fragment shader: " + verr); return 0; }

  const std::string vs310 = to_spirv_source(vs, vs_len, vs_ver);
  const std::string fs310 = to_spirv_source(fs, fs_len, fs_ver);

  std::vector<uint32_t> vs_spv, fs_spv;
  std::string err;
  if (!parse_pair(vs310, fs310, &vs_spv, &fs_spv, &err)) {
    error_out(out, "native shader: " + err);
    return 0;
  }

  // The WebGL2 passthrough: the author's own text is what compiles, so return it
  // verbatim. Parsing above still happened, which is the point -- a syntax error is
  // reported here at upload instead of as a black stage.
  if (target == ASC_SHADER_TARGET_GLSL_ES3) {
    out->vertex_source = strdup(vs);
    out->fragment_source = strdup(fs);
    out->color_attachments = 1;
    return 1;
  }

  const spvc_backend backend = (target == ASC_SHADER_TARGET_MSL) ? SPVC_BACKEND_MSL : SPVC_BACKEND_HLSL;
  // One varying name -> slot table for the PAIR (see VaryingTable): HLSL links
  // varyings by TEXCOORD name+index, so the two stages cannot be numbered
  // independently.
  VaryingTable varyings;
  if (backend == SPVC_BACKEND_HLSL) build_varying_table(vs_spv, fs_spv, &varyings);
  StageResult vres, fres;
  int cap = 0;
  // The message has to survive the cleanup: asc_shader_program_free() memsets the
  // struct, so reporting BEFORE freeing is the same as reporting nothing -- and an
  // empty error string is exactly how a failed cross-compile presented itself on the
  // first Windows build (a black stage with "FAIL: " in the log).
  const char* stage_msg = nullptr;
  if (!cross_compile(vs_spv, backend, 0, "vs_main", &vres, out, &cap, &varyings, &err)) {
    stage_msg = "native shader: vertex: ";
    error_out(out, std::string(stage_msg) + err);
  }
  if (stage_msg == nullptr &&
      !cross_compile(fs_spv, backend, 1, "fs_main", &fres, out, &cap, &varyings, &err)) {
    stage_msg = "native shader: fragment: ";
    error_out(out, std::string(stage_msg) + err);
  }
  if (stage_msg != nullptr) {
    std::string keep(out->error);
    asc_shader_program_free(out);
    snprintf(out->error, sizeof out->error, "%s", keep.c_str());
    return 0;
  }
  out->vertex_source = strdup(vres.source.c_str());
  out->fragment_source = strdup(fres.source.c_str());
  out->color_attachments = fres.color_attachments > 0 ? fres.color_attachments : 1;
  return 1;
}

}  // extern "C"