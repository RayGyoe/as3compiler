/* shader_compiler.h -- the ONE C entry point into the GLSL ES 3.00 cross-compiler.
 *
 * E6 (native shader passthrough): an author hands us GLSL ES 3.00 source and we
 * hand back the backend's own language (MSL / HLSL) plus a reflection table that
 * says where every uniform / texture / attribute landed. Everything glslang and
 * SPIRV-Cross do lives behind this one function so the generated C never has to
 * see a C++ type -- the same split as vendor/skia_glue.cc.
 *
 * Why this exists at all: AGAL's ceiling is ES 1.00 (no texelFetch, no integer
 * types, no explicit LOD, no MRT), and Ultra-Water's whole FFT/HDR chain sits above
 * it. AGENTS.md §0 forbids routing around that ceiling with a CPU fallback, so the
 * fix is to feed the GPU the language it actually speaks.
 */
#ifndef ASC_SHADER_COMPILER_H
#define ASC_SHADER_COMPILER_H

#ifdef __cplusplus
extern "C" {
#endif

/* Which language to emit. GLSL_ES3 is the WebGL2 passthrough: nothing is
 * translated, the source is returned verbatim, but it is still parsed first so a
 * syntax error is reported at upload time instead of as a black stage. */
#define ASC_SHADER_TARGET_MSL 0
#define ASC_SHADER_TARGET_GLSL_ES3 1
#define ASC_SHADER_TARGET_HLSL 2

/* What a binding names. */
#define ASC_SHADER_KIND_UNIFORM 1
#define ASC_SHADER_KIND_TEXTURE 2
#define ASC_SHADER_KIND_ATTRIBUTE 3

typedef struct {
  char* name;    /* owned by the program; freed by asc_shader_program_free */
  int kind;      /* ASC_SHADER_KIND_* */
  int binding;   /* MSL/HLSL slot index. For attributes: the vertex location. */
  int stage;     /* 0 = vertex, 1 = fragment (uniforms/attributes differ) */
  int size;      /* array element count; 1 when not an array */
} asc_shader_binding;

typedef struct {
  char* vertex_source;    /* owned */
  char* fragment_source;  /* owned */
  asc_shader_binding* bindings;
  int binding_count;
  /* Highest fragment color output index + 1, i.e. how many MRT attachments the
   * program writes. 1 for a normal single-target shader. */
  int color_attachments;
  /* Non-empty means failure; the text is glslang/SPIRV-Cross' own diagnostic so
   * the author gets "line:col: message" rather than "compile failed". */
  char error[1024];
} asc_shader_program;

/* Translate a vertex/fragment pair. Returns 1 on success, 0 on failure (out->error
 * is filled either way). `out` is zeroed first, so a failed call still needs
 * asc_shader_program_free. */
int asc_shader_translate(const char* vs, const char* fs, int target, asc_shader_program* out);

/* Release everything asc_shader_translate allocated. Safe on a zeroed struct. */
void asc_shader_program_free(asc_shader_program* p);

/* Which compiler this build actually carries, for the build/run banner. */
const char* asc_shader_backend_info(void);

#ifdef __cplusplus
}
#endif

#endif /* ASC_SHADER_COMPILER_H */