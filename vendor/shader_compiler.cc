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

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
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

int resource_array_size(spvc_compiler comp, spvc_type_id type_id) {
  spvc_type t = spvc_compiler_get_type_handle(comp, type_id);
  if (spvc_type_get_num_array_dimensions(t) == 0) return 1;
  unsigned d = spvc_type_get_array_dimension(t, 0);
  return d > 0 ? (int)d : 1;
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
        unsigned loc = spvc_compiler_get_decoration(comp, list[i].id, SpvDecorationLocation);
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
                   int* cap, std::string* err) {
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
  const char* src = nullptr;
  if (spvc_compiler_compile(comp, &src) != SPVC_SUCCESS || src == nullptr) {
    *err = std::string("SPIRV-Cross: ") + spvc_context_get_last_error_string(ctx);
    spvc_context_destroy(ctx);
    return false;
  }
  result->source.assign(src);
  // Reflection must run AFTER compile: the automatic resource indices are assigned
  // during code generation, so querying earlier returns unset decorations.
  if (backend == SPVC_BACKEND_MSL) {
    reflect_msl(comp, stage, out, cap);
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
  StageResult vres, fres;
  int cap = 0;
  if (!cross_compile(vs_spv, backend, 0, "vs_main", &vres, out, &cap, &err)) {
    error_out(out, "native shader: vertex: " + err);
    asc_shader_program_free(out);
    return 0;
  }
  if (!cross_compile(fs_spv, backend, 1, "fs_main", &fres, out, &cap, &err)) {
    error_out(out, "native shader: fragment: " + err);
    asc_shader_program_free(out);
    return 0;
  }
  out->vertex_source = strdup(vres.source.c_str());
  out->fragment_source = strdup(fres.source.c_str());
  out->color_attachments = fres.color_attachments > 0 ? fres.color_attachments : 1;
  return 1;
}

}  // extern "C"