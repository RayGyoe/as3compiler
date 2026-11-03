// stage3d_webgl.cc — the WebGL2 (GLES3) implementation of Stage3D's raw
// programmable triangle pipeline (flash.display3D), for the wasm/web target.
//
// This is the web counterpart of stage3d_glue.mm (Metal) and it implements the
// exact same flat extern "C" s3d_* API, so the generated C's Context3D state
// machine (src/emit.ts) and its as_s3d_* wrappers are backend-agnostic: the
// build manifest picks one glue (ASC_RENDER_STAGE3D + either stage3d_glue.mm or
// this file) and the matching shader language (ASC_S3D_GLSL selects GLSL ES in
// the runtime's AGAL translator instead of MSL).
//
// Why a whole GL backend is needed at all: Starling draws *everything* through
// Context3D (drawTriangles with AGAL programs), so without a Stage3D backend the
// as_s3d_* wrappers are no-ops and the browser shows only the 2D display-list
// overlay (background + progress bar) while the stage stays black.
//
// Design notes, and where GL differs from Metal:
//
//  * Orientation. Stage3D (like Metal, and like AIR on every platform) stores
//    frame-buffer row 0 at the TOP of the image, which is also how BitmapData
//    pixels are laid out and therefore how texture coordinate v=0 is defined.
//    GL's convention is the opposite: row 0 of a render target is the BOTTOM row
//    ("the first element returned by glReadPixels corresponds to the lower left
//    corner"), while a texture uploaded from a top-down pixel buffer already has
//    v=0 at its first row. The GLSL vertex program the AGAL translator emits
//    therefore negates clip-space Y on the GL target: every GL render target
//    (back buffer and render textures) then holds the image top-down exactly like
//    Metal's, texture sampling stays consistent, and glReadPixels rows line up
//    with Skia's top-down canvas. The negation flips triangle winding, which is
//    why front faces are GL's default CCW here (Metal needed CW for the same
//    reason).
//
//  * Blending. Metal bakes blend state into MTLRenderPipelineState and caches one
//    pipeline per blend-factor pair; GL has per-draw blend state, so this file
//    simply calls glEnable(GL_BLEND)+glBlendFuncSeparate before the draw. That
//    makes setBlendFactors take effect between two draws for free.
//
//  * Sampler state. The AGAL->GLSL translator declares one sampler2D per texture
//    register (fs0..fs7) with no sampler objects, so filter/wrap state is applied
//    to the *texture object* of each bound unit (applied lazily at draw time,
//    cached per texture so a steady state costs nothing).
//
//  * Cube maps. A Stage3D CubeTexture (away3d's skybox/environment maps) becomes
//    a GL cube map: six glTexImage2D calls on the six GL_TEXTURE_CUBE_MAP_POSITIVE_X
//    slices plus a mip chain, because the AGAL translator declares the matching
//    samplerCube only when the bytecode says <cube>. GL distinguishes 2D and cube
//    *targets* (binding a cube name to GL_TEXTURE_2D is GL_INVALID_OPERATION and
//    samples black, and the parameters live on the cube target), and it offers no
//    query for which target a name was created with -- so uploads record it in a
//    per-context registry (S3DTexTarget) that bind/sampler paths consult.
//
//  * Depth/stencil. Context3D.clear() is deferred to the next draw (Stage3D
//    clears once per frame and then issues many drawTriangles), the depth/stencil
//    attachment is only *used* by the passes that need it, and Starling's masking
//    relies on the stencil reference/compare/ops triple — all mirrored from the
//    Metal glue, which is where those semantics were verified against adl.
//
//  * Skia interop. The window's Skia Ganesh context is the same WebGL2 context
//    (Emscripten GL calls go to the current context), and Ganesh caches GL state,
//    so every entry point that touches GL marks Ganesh's state dirty via
//    sk_gr_reset_context() — cheap (it sets a bit); the actual state re-sync
//    happens on Ganesh's next operation.
//
//  * Native shaders (E6, `--features native-shader`). WebGL2 is the one backend
//    that runs the author's GLSL ES 3.00 AS WRITTEN, so this file is also the
//    native channel's web arm -- and it is a *passthrough*, not a translation:
//    glCompileShader consumes the source, and the reflection table Context3DNative
//    reports comes from the driver (glGetActiveUniform / glGetActiveAttrib) rather
//    than from glslang. Nothing about the native path is cross-compiled here; the
//    MSL/HLSL arms of vendor/shader_compiler.cc are simply not in this build.
//    What STILL has to exist is the host half: s3d_native_* (program bind, uniform
//    upload by reflected slot, sampler units, MRT/float/depth targets), which is
//    what this section below adds. Two GL-specific consequences are worth knowing
//    before reading it:
//      - Metal binds a native uniform at buffer index == its reflected slot, so
//        SPIRV-Cross bakes the slot into the source. GL binds uniforms BY NAME, so
//        the name->slot table has to be handed to this file once per program
//        (s3d_native_layout) to be turned into glGetUniformLocation results.
//      - fragment slots map to texture units 0..7 and vertex slots to 8..15, since
//        GL has one unit namespace while Metal has one per stage.

#ifdef __EMSCRIPTEN__

#include <emscripten.h>
#include <emscripten/html5.h>
#include <GLES3/gl3.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string.h>   // strdup: <cstring> does not declare the POSIX extension
#include <ctype.h>    // isalnum, in the uniform-declaration scan
#include <cmath>
#include <cstdint>

// The reflection/binding table Context3DNative is built on. Declared by the same
// header the native arm's cross-compiler uses, so the two arms of the channel cannot
// disagree about the struct layout the emitted C hands them.
#ifdef ASC_USE_NATIVE_SHADER
#include "shader_compiler.h"
#endif

// Ganesh state invalidation (skia_glue.cc). Declared here rather than in a shared
// header to keep this file's dependency surface flat, like the Metal glue.
extern "C" void sk_gr_reset_context(void);
// Registers the sampler-cache invalidator below with skia_glue.cc, which fires it
// after sk_gl_draw_texture hands one of our render targets to Skia (see the
// definition for why that invalidates our cache).
extern "C" void sk_gr_set_texture_dirty_hook(void (*fn)(void));

extern "C" {

// Defined below (after the context registry); registered with skia_glue.cc from
// s3d_create so Ganesh can tell us when it has retuned a texture's GL sampler
// state behind our back.
void s3d_sampler_cache_invalidate(void);

// fprintf cost probe (ASC_S3D_STATS=1): draws/s plus CPU time per 240 draws, the
// web counterpart of the Metal glue's probe — same purpose, comparing the draw
// rate against the frame rate to tell whether the frame is CPU- or GPU-bound.
static double asc_dbg_now_ms(void) {
  return (double)emscripten_get_now();
}
static int asc_s3d_stats(void) {
  static int on = -1;
  if (on < 0) on = (getenv("ASC_S3D_STATS") != NULL) ? 1 : 0;
  return on;
}
// Per-draw state dump (ASC_S3D_DUMP=1), the web counterpart of the Metal glue's
// asc_s3d_dump: names the draw-state decisions that are otherwise invisible.
static int asc_s3d_dump(void) {
  static int on = -1;
  if (on < 0) on = (getenv("ASC_S3D_DUMP") != NULL) ? 1 : 0;
  return on;
}

#define S3D_MAX_TEX  8
#define S3D_MAX_ATTR 8

// One texture-object state cache entry: sampler state lives on the texture object
// in GL, so re-applying the same six glTexParameteri calls on every draw of a
// Starling batch would be pure overhead. Keyed by GL texture name.
struct S3DTexState {
  GLuint id;
  int filter;   // 0 = linear, 1 = nearest
  int wrap;     // 0 = clamp, 1 = repeat
  int mip;      // 0 = none, 1 = nearest, 2 = linear
};

// Registry entry for a render-target texture: WebGL2 has no
// glGetTexLevelParameteriv (ES 3.1), so a texture's size is remembered at creation
// instead of queried when it becomes the render override.
struct S3DRtTex {
  GLuint id;
  int width, height;
  int isHalf;     // GL_RGBA16F instead of GL_RGBA8 (readback must narrow it)
};

// A native (Context3DNative) target set: up to four colour attachments plus an
// optional depth attachment, all TEXTURES the caller owns. Cached by the set's
// identity because a pass list alternates between a handful of sets every frame and
// a per-frame glGenFramebuffers/attach/check would churn the object tables.
struct S3DNativeTarget {
  int used;
  GLuint fbo;
  GLuint colors[4];
  int ncolors;
  GLuint depth;
  int width, height;
  int complete;      // 0 = the GL driver refused this set (reported once)
};
#define S3D_MAX_NATIVE_TARGETS 8
// Samplers a native program may declare in one stage. Not S3D_MAX_TEX (8): that is the
// AGAL limit on texture *registers*, and a translated GLSL ES 3.00 program is not
// written in AGAL. GLES3 guarantees 16 per stage, which is the real ceiling here.
#define S3D_MAX_NATIVE_TEX 16

// Registry entry for a texture object's GL target. A cube map can only ever be
// bound to GL_TEXTURE_CUBE_MAP (and its sampler parameters live on that target),
// but GL has no "what target is this name" query, so the uploads record it here
// and the bind/sampler paths look it up. Entries are dropped by
// s3d_destroy_texture -- a GL name can be recycled, and a stale "cube" label on a
// reused name would make a 2D texture unbindable.
struct S3DTexTarget {
  GLuint id;
  int cube;   // 0 = GL_TEXTURE_2D, 1 = GL_TEXTURE_CUBE_MAP
};

struct S3DContext;

// One compiled program: the linked GL program plus its cached constant-register
// uniform locations. Stage3D lets a scene switch Program3D between draws (away3d
// alternates its torus material and its skybox material on EVERY frame), and a
// GL program link is a driver operation, not a bind. Compiling/linking per draw
// was also 512 glGetUniformLocation string lookups + a glDeleteProgram per draw.
// The compiled program is therefore cached per Program3D identity and merely
// SELECTED on a switch (see s3d_compile), exactly like AIR's program bind.
#define S3D_MAX_PROGRAMS 16

struct S3DProgramCache {
  void* key;              // Program3D identity (never cleared: the slot's name)
  unsigned long long srcHash;  // hash of the GLSL this slot was compiled from
  int used;               // whether the slot is allocated
  GLuint prog;            // owned by the slot while it is STASHED
  int uniVC[256];         // constant-register uniform locations (per program!)
  int uniFC[256];
  unsigned long stamp;    // LRU stamp
};

// An offscreen render target that can also be sampled: a color texture plus its
// own framebuffer (the back buffer's FBO is `fbo`; a render texture gets one
// lazily and keeps it until the size changes).
struct S3DRt {
  GLuint fbo;
  GLuint color;   // GL texture name
  GLuint depthStencil;
  int width, height;
  int isHalf;     // color attachment is RGBA16F (readback must narrow it)
};

struct S3DContext {
  int width, height;
  // Back-buffer target (BGRA8-equivalent RGBA8 + depth24stencil8).
  GLuint fbo;
  GLuint color;
  GLuint depthStencil;
  // Current render override (rendering into a render texture); nil when drawing
  // to the back buffer.
  S3DRt* overrideRt;
  // The LIVE program: borrowed from the cache slot named c->progKey (see
  // s3d_prog_load), or owned here while key == NULL. s3d_prog_stash hands this
  // state back to its slot before any switch, so exactly one place owns it.
  GLuint prog;
  // Attribute locations are bound explicitly before linking (glBindAttribLocation
  // in s3d_compile), so stream i is always attribute i — the GLSL ES 1.00
  // analogue of Metal's vertex descriptor in the Metal glue.
  // Constant-register uniform locations, indexed by register number (256 max).
  int uniVC[256];
  int uniFC[256];
  // Compiled-program cache (see S3DProgramCache).
  S3DProgramCache progs[S3D_MAX_PROGRAMS];
  int nprogs;
  void* progKey;            // identity of the live program (NULL = not cached)
  unsigned long long progHash;   // GLSL source hash of the live program
  unsigned long progstamp;  // LRU source for the slots
  // Vertex streams: one VBO per stream index, uploaded on s3d_upload_vertex.
  GLuint vbo[S3D_MAX_ATTR];
  int components[S3D_MAX_ATTR];
  int numVertices[S3D_MAX_ATTR];
  int numStreams;
  GLuint ibo;
  int numIndices;
  // Constant registers (float4 array indexed by register * 4 + component).
  float vcData[256 * 4];
  int vcCount;      // doubles (components), as handed to s3d_upload_constants
  float fcData[256 * 4];
  int fcCount;
  // Bound fragment samplers fs0..fs7 (GL texture names; ownership stays with the
  // Texture->gpu handle, released by s3d_destroy_texture).
  GLuint textures[S3D_MAX_TEX];
  // Deferred clear (see the header comment): Stage3D's clear() arms the next draw.
  float clearR, clearG, clearB, clearA, clearDepthValue;
  unsigned int clearStencilValue;
  int clearPending, clearColorBit, clearDepthBit, clearStencilBit;
  // Stage3D state machine, recorded as AS3 enum-name strings and resolved to GL
  // enums when the draw is issued (mirrors the Metal glue, glue-side names only).
  const char* blendSource;
  const char* blendDest;
  int instanceCount;
  int depthWrite;
  const char* depthCompare;
  const char* cullMode;
  const char* stencilFace;
  const char* stencilCompare;
  const char* stencilBothPass;
  const char* stencilDepthFail;
  const char* stencilDepthPassStencilFail;
  unsigned int stencilRef, stencilReadMask, stencilWriteMask;
  int scissorOn, scissorX, scissorY, scissorW, scissorH;
  // setColorMask: which channels the following draws may write (1 = write);
  // applied with glColorMask when the draw is issued (Stage3D's
  // set-state-then-drawTriangles order). 1 on context creation.
  int colorMaskR, colorMaskG, colorMaskB, colorMaskA;
  int samplerFilter[S3D_MAX_TEX];
  int samplerWrap[S3D_MAX_TEX];
  int samplerMip[S3D_MAX_TEX];
  int samplerStateSet[S3D_MAX_TEX];
  // Whether the texture bound at each unit owns a mip chain (reported by
  // s3d_bind_texture; consulted by s3d_draw to reproduce AIR's rule that a
  // mip-filtered sample on a chainless texture drops the whole draw -- in GL the
  // alternative is an INCOMPLETE texture, which samples black).
  int texHasMips[S3D_MAX_TEX];
  S3DTexState texState[64];
  int texStateN;
  S3DTexTarget texTarget[64];
  int texTargetN;
  // Registry of render-target textures: id -> size. WebGL2 dropped
  // glGetTexLevelParameteriv (ES 3.1), so this is the only way to know how big a
  // texture is when an FBO has to be created for it. GROWABLE on purpose: the ocean
  // demo alone creates 48 targets, and a fixed 32-entry table silently stopped
  // recording after the FFT cascades -- every later target then sized its framebuffer
  // from the SCREEN, drew through a viewport four times too large, and produced a
  // constant LUT and a black composite (the bug this comment replaces).
  S3DRtTex* rtTex;
  int rtTexN;
  int rtTexCap;
  // Scratch buffer for pixel upload/readback conversions (BGRA <-> RGBA), grown
  // on demand and reused: a per-frame malloc of 8+ MB would shred the wasm heap.
  uint8_t* scratch;
  int scratchBytes;
  // VAO for the attribute setup; the element-buffer binding is VAO state in GLES3.
  GLuint vao;
  // ---- E6 native shader channel (see the header note; unused unless a
  // Context3DNative program is bound). `nativeMode` mirrors the Metal glue: once a
  // native program is live the constant-register model is off for this context.
  int nativeMode;
  int nativeNColor;                       // colour attachments the live program writes
  unsigned char nativeUniform[2][16][64]; // staged floats, by stage and reflected slot
  unsigned char nativeUniformSet[2][16];
  int nativeLoc[2][16];                   // glGetUniformLocation per (stage, slot)
  int nativeBase[2][16];                  // ASC_SHADER_BASE_* of that uniform
  int nativeComps[2][16];                 // scalars per element (1..4, 4/9/16 for mats)
  int nativeSize[2][16];                  // array element count (1 for a plain uniform)
  int nativeUnit[2][S3D_MAX_NATIVE_TEX];  // sampler (stage, slot) -> GL texture unit
  GLuint nativeTex[2][S3D_MAX_NATIVE_TEX];   // texture bound at that sampler
  int nativeSampler[2][S3D_MAX_NATIVE_TEX][3];  // filter, wrap, mip per (stage, slot)
  int nativeSamplerSet[2][S3D_MAX_NATIVE_TEX];
  // Which (stage, slot) pairs the LIVE program actually declares as samplers. Binding is
  // driven by this and not by "whatever slots are non-zero", so an unit is never left with
  // the previous program's texture on it: an unbound sampler then samples black, which is
  // the loud failure, instead of silently sampling a plausible-looking wrong texture.
  unsigned char nativeTexTable[2][S3D_MAX_NATIVE_TEX];
  S3DNativeTarget nativeTargets[S3D_MAX_NATIVE_TARGETS];
  S3DNativeTarget* nativeTarget;          // NULL = draw to the back buffer
  GLuint nativeLayoutProg;                // program the layout table was resolved for
  unsigned long long nativeLayoutHash;    // and the table it was resolved from
};

// Program-cache helper, defined with s3d_compile further down but needed by the
// teardown path above it.
static void s3d_prog_release(S3DProgramCache* e);

// Live contexts, so a destroyed texture can be scrubbed out of every binding (a
// GL texture name freed while still bound would be rebound by a later alloc and
// sampled as garbage). Same invariant as the Metal glue's live registry.
#define S3D_MAX_CTX 4
static S3DContext* s3d_live[S3D_MAX_CTX];
static int s3d_live_n = 0;

static void s3d_register_ctx(S3DContext* c) {
  if (s3d_live_n < S3D_MAX_CTX) s3d_live[s3d_live_n++] = c;
}
static void s3d_unregister_ctx(S3DContext* c) {
  for (int i = 0; i < s3d_live_n; i++)
    if (s3d_live[i] == c) { s3d_live[i] = s3d_live[--s3d_live_n]; return; }
}
static void s3d_unbind_texture_everywhere(GLuint t) {
  if (t == 0) return;
  for (int k = 0; k < s3d_live_n; k++) {
    S3DContext* c = s3d_live[k];
    for (int i = 0; i < S3D_MAX_TEX; i++) if (c->textures[i] == t) { c->textures[i] = 0; c->texHasMips[i] = 0; }
    for (int s = 0; s < 2; s++)
      for (int i = 0; i < S3D_MAX_NATIVE_TEX; i++) if (c->nativeTex[s][i] == t) c->nativeTex[s][i] = 0;
    if (c->overrideRt != NULL && c->overrideRt->color == t) c->overrideRt = NULL;
    // A destroyed attachment leaves its cached FBO unusable, and a stale entry would
    // be found again by the identity match (ids are recycled) and drawn into.
    for (int i = 0; i < S3D_MAX_NATIVE_TARGETS; i++) {
      S3DNativeTarget* nt = &c->nativeTargets[i];
      if (!nt->used) continue;
      int hit = (nt->depth == t);
      for (int k2 = 0; k2 < nt->ncolors; k2++) if (nt->colors[k2] == t) hit = 1;
      if (!hit) continue;
      if (c->nativeTarget == nt) c->nativeTarget = NULL;
      if (nt->fbo != 0) glDeleteFramebuffers(1, &nt->fbo);
      memset(nt, 0, sizeof *nt);
    }
  }
}

// ---- Stage3D enum strings -> GL enums ---------------------------------------
// The string values are the ones the AS3 port emits (verified against adl in the
// Metal glue, e.g. "lessEqual", "incrementSaturate", "frontAndBack").
static GLenum s3d_compare(const char* name) {
  if (name == NULL) return GL_ALWAYS;
  if (!strcmp(name, "never")) return GL_NEVER;
  if (!strcmp(name, "less")) return GL_LESS;
  if (!strcmp(name, "equal")) return GL_EQUAL;
  if (!strcmp(name, "lessEqual")) return GL_LEQUAL;
  if (!strcmp(name, "greater")) return GL_GREATER;
  if (!strcmp(name, "notEqual")) return GL_NOTEQUAL;
  if (!strcmp(name, "greaterEqual")) return GL_GEQUAL;
  return GL_ALWAYS;
}

static GLenum s3d_stencil_op(const char* name) {
  if (name == NULL) return GL_KEEP;
  if (!strcmp(name, "keep")) return GL_KEEP;
  if (!strcmp(name, "zero")) return GL_ZERO;
  if (!strcmp(name, "replace")) return GL_REPLACE;
  // Stage3D's SET writes the reference value like REPLACE; GL has no SET either.
  if (!strcmp(name, "set")) return GL_REPLACE;
  if (!strcmp(name, "incrementSaturate")) return GL_INCR;
  if (!strcmp(name, "decrementSaturate")) return GL_DECR;
  if (!strcmp(name, "invert")) return GL_INVERT;
  if (!strcmp(name, "incrementWrap")) return GL_INCR_WRAP;
  if (!strcmp(name, "decrementWrap")) return GL_DECR_WRAP;
  return GL_KEEP;
}

// Context3DBlendFactor name -> GL blend factor. Unknown/NULL falls back to ONE so
// the common premultiplied (ONE, ONE_MINUS_SOURCE_ALPHA) path is the safe default.
static GLenum s3d_blend_factor(const char* name) {
  if (name == NULL) return GL_ONE;
  if (!strcmp(name, "zero")) return GL_ZERO;
  if (!strcmp(name, "one")) return GL_ONE;
  if (!strcmp(name, "sourceColor")) return GL_SRC_COLOR;
  if (!strcmp(name, "oneMinusSourceColor")) return GL_ONE_MINUS_SRC_COLOR;
  if (!strcmp(name, "sourceAlpha")) return GL_SRC_ALPHA;
  if (!strcmp(name, "oneMinusSourceAlpha")) return GL_ONE_MINUS_SRC_ALPHA;
  if (!strcmp(name, "destinationColor")) return GL_DST_COLOR;
  if (!strcmp(name, "oneMinusDestinationColor")) return GL_ONE_MINUS_DST_COLOR;
  if (!strcmp(name, "destinationAlpha")) return GL_DST_ALPHA;
  if (!strcmp(name, "oneMinusDestinationAlpha")) return GL_ONE_MINUS_DST_ALPHA;
  return GL_ONE;
}

// ---- pixel buffer helpers ---------------------------------------------------
// BitmapData.pixels is straight ARGB as a uint32 word (0xAARRGGBB). On a
// little-endian host its bytes are B,G,R,A -- GLES with GL_UNSIGNED_BYTE wants
// R,G,B,A, so both directions need one 32-bit word swap. (Metal's BGRA8Unorm
// matches the word layout exactly, which is why the Metal glue uploads the
// buffer straight through; GL has no such format in the ES3 core subset.)
static uint8_t* s3d_scratch(S3DContext* c, int bytes) {
  if (c->scratchBytes >= bytes && c->scratch != NULL) return c->scratch;
  free(c->scratch);
  c->scratch = (uint8_t*)malloc((size_t)bytes);
  c->scratchBytes = (c->scratch != NULL) ? bytes : 0;
  return c->scratch;
}

static void s3d_argb_to_rgba(const uint32_t* argb, uint8_t* rgba, int n) {
  for (int i = 0; i < n; i++) {
    uint32_t p = argb[i];
    rgba[i * 4 + 0] = (uint8_t)((p >> 16) & 0xFF);  // R
    rgba[i * 4 + 1] = (uint8_t)((p >> 8) & 0xFF);   // G
    rgba[i * 4 + 2] = (uint8_t)(p & 0xFF);          // B
    rgba[i * 4 + 3] = (uint8_t)((p >> 24) & 0xFF);  // A
  }
}

static void s3d_rgba_to_bgra(const uint8_t* rgba, uint8_t* bgra, int n) {
  for (int i = 0; i < n; i++) {
    bgra[i * 4 + 0] = rgba[i * 4 + 2];  // B
    bgra[i * 4 + 1] = rgba[i * 4 + 1];  // G
    bgra[i * 4 + 2] = rgba[i * 4 + 0];  // R
    bgra[i * 4 + 3] = rgba[i * 4 + 3];  // A
  }
}

// The GL target a texture object was created with (see S3DTexTarget); an unknown
// name is assumed 2D, which is what every creator but the cube upload makes.
static GLenum s3d_tex_gltarget(S3DContext* c, GLuint tex) {
  for (int i = 0; i < c->texTargetN; i++)
    if (c->texTarget[i].id == tex) return c->texTarget[i].cube ? GL_TEXTURE_CUBE_MAP : GL_TEXTURE_2D;
  return GL_TEXTURE_2D;
}

static void s3d_record_target(S3DContext* c, GLuint tex, int cube) {
  for (int i = 0; i < c->texTargetN; i++)
    if (c->texTarget[i].id == tex) { c->texTarget[i].cube = cube; return; }
  if (c->texTargetN < 64) {
    c->texTarget[c->texTargetN].id = tex;
    c->texTarget[c->texTargetN].cube = cube;
    c->texTargetN++;
  }
}

// Write one texture's sampler parameters. A cube map also needs the third axis
// (Stage3D's wrap mode is per-axis but AGAL names only one, so all three take it),
// while a 2D texture must NOT be given GL_TEXTURE_WRAP_R.
static void s3d_set_tex_params(GLenum target, int f, int w, int m) {
  GLenum wt = (w == 1) ? GL_REPEAT : GL_CLAMP_TO_EDGE;
  glTexParameteri(target, GL_TEXTURE_WRAP_S, wt);
  glTexParameteri(target, GL_TEXTURE_WRAP_T, wt);
  if (target == GL_TEXTURE_CUBE_MAP) glTexParameteri(target, GL_TEXTURE_WRAP_R, wt);
  glTexParameteri(target, GL_TEXTURE_MAG_FILTER, (f == 1) ? GL_NEAREST : GL_LINEAR);
  glTexParameteri(target, GL_TEXTURE_MIN_FILTER,
                  (m == 0) ? ((f == 1) ? GL_NEAREST : GL_LINEAR)
                           : ((m == 1) ? GL_NEAREST_MIPMAP_NEAREST : GL_LINEAR_MIPMAP_LINEAR));
}

// Apply the recorded sampler state to one bound texture (cached: sampler state
// lives on the texture object in GL, so a steady state issues no GL calls).
static void s3d_apply_sampler(S3DContext* c, GLuint tex, int unit) {
  if (!c->samplerStateSet[unit]) return;
  int f = c->samplerFilter[unit], w = c->samplerWrap[unit], m = c->samplerMip[unit];
  GLenum target = s3d_tex_gltarget(c, tex);
  for (int i = 0; i < c->texStateN; i++) {
    S3DTexState* s = &c->texState[i];
    if (s->id == tex) {
      if (s->filter == f && s->wrap == w && s->mip == m) return;
      s->filter = f; s->wrap = w; s->mip = m;
      glBindTexture(target, tex);
      s3d_set_tex_params(target, f, w, m);
      return;
    }
  }
  // Not seen before: remember and apply.
  if (c->texStateN < 64) {
    S3DTexState* s = &c->texState[c->texStateN++];
    s->id = tex; s->filter = f; s->wrap = w; s->mip = m;
    glBindTexture(target, tex);
    s3d_set_tex_params(target, f, w, m);
  }
}

// Recreate the back buffer's attachments (s3d_create / s3d_resize).
static int s3d_alloc_target(S3DContext* c, int width, int height) {
  c->width = width > 0 ? width : 1;
  c->height = height > 0 ? height : 1;
  if (c->fbo == 0) glGenFramebuffers(1, &c->fbo);
  if (c->color == 0) glGenTextures(1, &c->color);
  glBindTexture(GL_TEXTURE_2D, c->color);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, c->width, c->height, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
#ifdef ASC_RENDER_DEPTH_STENCIL
  if (c->depthStencil == 0) glGenRenderbuffers(1, &c->depthStencil);
  glBindRenderbuffer(GL_RENDERBUFFER, c->depthStencil);
  glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH24_STENCIL8, c->width, c->height);
#endif
  glBindFramebuffer(GL_FRAMEBUFFER, c->fbo);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, c->color, 0);
#ifdef ASC_RENDER_DEPTH_STENCIL
  glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_STENCIL_ATTACHMENT, GL_RENDERBUFFER, c->depthStencil);
#endif
  GLenum st = glCheckFramebufferStatus(GL_FRAMEBUFFER);
  glBindFramebuffer(GL_FRAMEBUFFER, 0);
  if (st != GL_FRAMEBUFFER_COMPLETE) {
    fprintf(stderr, "stage3d_webgl: back-buffer FBO incomplete (0x%x)\n", (unsigned)st);
    return 0;
  }
  return 1;
}

// ---- lifecycle -------------------------------------------------------------

void* s3d_create(int width, int height) {
  S3DContext* c = new S3DContext();
  memset(c, 0, sizeof(S3DContext));
  c->clearA = 1.0f;
  c->clearPending = 1;  // the first draw must clear the fresh target
  c->clearColorBit = c->clearDepthBit = c->clearStencilBit = 1;
  c->clearDepthValue = 1.0f;
  c->instanceCount = 1;
  c->stencilReadMask = 0xFF;
  c->stencilWriteMask = 0xFF;
  c->colorMaskR = c->colorMaskG = c->colorMaskB = c->colorMaskA = 1;
  c->nativeLoc[0][0] = c->nativeLoc[1][0] = -1;
  for (int s = 0; s < 2; s++)
    for (int i = 0; i < 16; i++) { c->nativeLoc[s][i] = -1; c->nativeBase[s][i] = 0; c->nativeComps[s][i] = 1; }
  for (int s = 0; s < 2; s++)
    for (int i = 0; i < S3D_MAX_NATIVE_TEX; i++) c->nativeUnit[s][i] = (s == 0) ? (8 + i) : i;
  c->nativeLayoutProg = 0;
  c->nativeTarget = NULL;
  c->uniVC[0] = -1;  // memset already zeroed; -1 marks "not linked yet"
  for (int i = 0; i < 256; i++) { c->uniVC[i] = -1; c->uniFC[i] = -1; }
  // WebGL only lets a shader use '#extension GL_EXT_frag_depth' after the
  // CONTEXT has enabled it through getExtension -- the shader-side directive alone
  // is rejected with "extension is not supported" (measured in Chrome/ANGLE:
  // temp/metalshader/glslcheck.html vs glslcheck2.html, the only difference being
  // this call). Without it every AGAL program that writes `od` failed to compile
  // even though its GLSL was valid ES 1.00.
  // Returns 0 when the platform does not offer it; the od shader then fails to
  // compile with a clear driver message instead of silently dropping the write.
  emscripten_webgl_enable_extension(emscripten_webgl_get_current_context(), "EXT_frag_depth");
  // The native channel renders into float targets (rgba32f / r16f / rgba16f); WebGL2
  // keeps those non-renderable until one of these extensions is enabled. Enabling is
  // idempotent and harmless for demos that never allocate one, so it is unconditional
  // here rather than a lazily-guarded call in create_texture_fmt -- a failed
  // allocation must be attributable to the format, not to whether the first call
  // happened to win a race with the context.
  emscripten_webgl_enable_extension(emscripten_webgl_get_current_context(), "EXT_color_buffer_float");
  emscripten_webgl_enable_extension(emscripten_webgl_get_current_context(), "EXT_color_buffer_half_float");
  emscripten_webgl_enable_extension(emscripten_webgl_get_current_context(), "OES_texture_float_linear");
  if (!s3d_alloc_target(c, width, height)) { delete c; return NULL; }
  glGenVertexArrays(1, &c->vao);
  s3d_register_ctx(c);
  sk_gr_set_texture_dirty_hook(s3d_sampler_cache_invalidate);
  sk_gr_reset_context();
  return (void*)c;
}

void s3d_destroy(void* ctx) {
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  s3d_unregister_ctx(c);
  if (c->prog != 0) glDeleteProgram(c->prog);
  for (int i = 0; i < c->nprogs; i++) s3d_prog_release(&c->progs[i]);
  c->nprogs = 0;
  c->progKey = NULL;
  for (int i = 0; i < S3D_MAX_ATTR; i++) if (c->vbo[i] != 0) glDeleteBuffers(1, &c->vbo[i]);
  if (c->ibo != 0) glDeleteBuffers(1, &c->ibo);
  if (c->fbo != 0) glDeleteFramebuffers(1, &c->fbo);
  if (c->color != 0) glDeleteTextures(1, &c->color);
  if (c->depthStencil != 0) glDeleteRenderbuffers(1, &c->depthStencil);
  if (c->vao != 0) glDeleteVertexArrays(1, &c->vao);
  for (int i = 0; i < S3D_MAX_NATIVE_TARGETS; i++)
    if (c->nativeTargets[i].fbo != 0) glDeleteFramebuffers(1, &c->nativeTargets[i].fbo);
  // c->textures[] and overrideRt->color are BORROWED (owned by Texture->gpu).
  free(c->rtTex);
  free(c->scratch);
  delete c;
  sk_gr_reset_context();
}

int s3d_resize(void* ctx, int width, int height) {
  if (ctx == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
  if (width <= 0 || height <= 0) return 0;
  if (width == c->width && height == c->height) return 1;
  int ok = s3d_alloc_target(c, width, height);
  sk_gr_reset_context();
  return ok;
}

int s3d_width(void* ctx) { return ctx ? ((S3DContext*)ctx)->width : 0; }
int s3d_height(void* ctx) { return ctx ? ((S3DContext*)ctx)->height : 0; }

// Largest 2D texture edge this context can allocate. Unlike D3D12/Metal there is no
// platform-wide guarantee for WebGL2 -- GL_MAX_TEXTURE_SIZE is 2048 on some drivers,
// so it has to be asked for rather than assumed. Cached because the answer is
// invariant for the life of the page. When no GL context is current the query yields
// 0 and we fall back to 2048, which makes the generated C report "baseline" instead
// of claiming a 4096 ceiling the device may not have.
int s3d_max_texture_size(void) {
  static int cached = 0;
  if (cached != 0) return cached;
  GLint v = 0;
  glGetIntegerv(GL_MAX_TEXTURE_SIZE, &v);
  cached = (v >= 2048) ? (int)v : 2048;
  return cached;
}

// ---- buffers ---------------------------------------------------------------

int s3d_upload_vertex(void* ctx, int stream, const double* data, int numVertices, int components) {
  if (ctx == NULL || stream < 0 || stream >= S3D_MAX_ATTR) return 0;
  S3DContext* c = (S3DContext*)ctx;
  if (components < 1 || components > 4 || numVertices <= 0 || data == NULL) return 0;
  size_t n = (size_t)numVertices * (size_t)components;
  float* tmp = (float*)malloc(n * sizeof(float));
  if (tmp == NULL) return 0;
  for (size_t i = 0; i < n; i++) tmp[i] = (float)data[i];
  if (c->vbo[stream] == 0) glGenBuffers(1, &c->vbo[stream]);
  glBindBuffer(GL_ARRAY_BUFFER, c->vbo[stream]);
  // orphaning + data: Starling re-uploads every batch each frame, so the same
  // buffer object is reused rather than reallocated.
  glBufferData(GL_ARRAY_BUFFER, (GLsizeiptr)(n * sizeof(float)), tmp, GL_DYNAMIC_DRAW);
  glBindBuffer(GL_ARRAY_BUFFER, 0);
  free(tmp);
  c->components[stream] = components;
  c->numVertices[stream] = numVertices;
  if (stream + 1 > c->numStreams) c->numStreams = stream + 1;
  sk_gr_reset_context();
  return 1;
}

int s3d_upload_index(void* ctx, const uint32_t* data, int numIndices) {
  if (ctx == NULL || numIndices <= 0 || data == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
  if (c->ibo == 0) glGenBuffers(1, &c->ibo);
  // Bind through the VAO: GL_ELEMENT_ARRAY_BUFFER is vertex-array state, so a
  // stray binding on the default VAO would be overwritten by the draw's own.
  glBindVertexArray(c->vao);
  glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, c->ibo);
  glBufferData(GL_ELEMENT_ARRAY_BUFFER, (GLsizeiptr)((size_t)numIndices * sizeof(uint32_t)), data, GL_DYNAMIC_DRAW);
  glBindVertexArray(0);
  glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, 0);
  c->numIndices = numIndices;
  sk_gr_reset_context();
  return 1;
}

// Constant registers. GL has one named uniform per register in the AGAL->GLSL
// output (uniform vec4 vc0; vc1; ...) rather than Metal's single array, so the
// values are staged here and uploaded per register at draw time.
int s3d_upload_constants(void* ctx, int isFragment, const double* data, int count) {
  if (ctx == NULL || count <= 0 || data == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
  if (count > 256 * 4) count = 256 * 4;
  float* dst = isFragment ? c->fcData : c->vcData;
  for (int i = 0; i < count; i++) dst[i] = (float)data[i];
  if (isFragment) c->fcCount = count; else c->vcCount = count;
  return 1;
}

// ---- textures --------------------------------------------------------------

// Record id -> size. Called by every path that creates a texture this file may later
// be asked to make drawable. Growing is not optional bookkeeping: losing an entry
// means the FBO below falls back to the screen size, which draws wrong rather than
// failing, so a failed realloc is reported instead of swallowed.
static void s3d_rt_register(S3DContext* c, GLuint id, int width, int height, int isHalf) {
  if (c->rtTexN >= c->rtTexCap) {
    int cap = c->rtTexCap == 0 ? 32 : c->rtTexCap * 2;
    S3DRtTex* nx = (S3DRtTex*)realloc(c->rtTex, (size_t)cap * sizeof *nx);
    if (nx == NULL) {
      fprintf(stderr, "stage3d_webgl: out of memory recording texture %u (%dx%d); a framebuffer for it would be sized from the screen\n",
              (unsigned)id, width, height);
      return;
    }
    c->rtTex = nx;
    c->rtTexCap = cap;
  }
  S3DRtTex* e = &c->rtTex[c->rtTexN++];
  e->id = id;
  e->width = width;
  e->height = height;
  e->isHalf = isHalf;
}


// Upload pixels into a new GL texture and return its name (the caller caches it in
// Texture->gpu and releases it with s3d_destroy_texture). It does NOT bind to any
// unit: binding is the caller's job (s3d_bind_texture), which is what lets an
// upload happen before anything is drawn.
void* s3d_texture_from_pixels(void* ctx, int width, int height, const uint32_t* argb) {
  if (ctx == NULL || width <= 0 || height <= 0 || argb == NULL) return NULL;
  S3DContext* c = (S3DContext*)ctx;
  int n = width * height;
  uint8_t* rgba = s3d_scratch(c, n * 4);
  if (rgba == NULL) return NULL;
  s3d_argb_to_rgba(argb, rgba, n);
  GLuint tex = 0;
  glGenTextures(1, &tex);
  glBindTexture(GL_TEXTURE_2D, tex);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, width, height, 0, GL_RGBA, GL_UNSIGNED_BYTE, rgba);
  // Stage3D's default texture state: linear filtering, clamp to edge, no mips
  // (WebGL2 allows REPEAT and mipmapping on non-power-of-two textures, so
  // Starling's NPOT atlases need no padding).
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  sk_gr_reset_context();
  return (void*)(uintptr_t)tex;
}

// Bytes of texture this backend will attempt in ONE allocation. WebGL exposes no
// budget query, so a conservative 1 GiB is used: above every realistic game texture
// and still below what any WebGL2 implementation would fail to allocate. The value
// only backs the create-time pre-check (AIR's Error #3684); the drive itself
// reports a real failure through the upload path.
double s3d_max_texture_memory(void) { return 1073741824.0; }

// Upload an rgbaHalfFloat texture: width*height texels of four half floats
// (R,G,B,A), handed to GL as GL_HALF_FLOAT -- no narrowing, which is the point of
// the format. WebGL2 core has RGBA16F as a colour-renderable+filterable internal
// format, so filtering and setRenderToTexture need no extension.
void* s3d_texture_from_pixels_half(void* ctx, int width, int height, const void* rgba) {
  if (ctx == NULL || width <= 0 || height <= 0 || rgba == NULL) return NULL;
  S3DContext* c = (S3DContext*)ctx;
  (void)c;
  GLuint tex = 0;
  glGenTextures(1, &tex);
  glBindTexture(GL_TEXTURE_2D, tex);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA16F, width, height, 0, GL_RGBA, GL_HALF_FLOAT, rgba);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  sk_gr_reset_context();
  return (void*)(uintptr_t)tex;
}

// Upload pixels AND bind them as fragment sampler fs{unit} in one step (the
// sequential upload-then-draw path in Context3D_submit).
void* s3d_upload_texture(void* ctx, int unit, int width, int height, const uint32_t* argb) {
  if (ctx == NULL || unit < 0 || unit >= S3D_MAX_TEX) return NULL;
  void* tex = s3d_texture_from_pixels(ctx, width, height, argb);
  if (tex != NULL) {
    S3DContext* c = (S3DContext*)ctx;
    c->textures[unit] = (GLuint)(uintptr_t)tex;
    c->texHasMips[unit] = 0;  // level 0 only, no chain (see s3d_draw)
  }
  return tex;
}

// Upload ONE mip level (level > 0) from the top-left lw x lh rectangle of a
// source whose row stride is srcW pixels -- AIR's region rule, measured in
// temp/mipprobe (see the Metal glue's s3d_texture_upload_level for the numbers).
// GL's glTexImage2D has no row-stride argument, so the region is first copied
// row by row into a packed scratch buffer; that keeps both backends fed with the
// SAME pixels (the dual-target requirement), which a glGenerateMipmap off level 0
// could not guarantee for an app that supplies its own levels.
void s3d_texture_upload_level(void* ctx, void* tex, int level, int lw, int lh, const uint32_t* src, int srcW) {
  if (ctx == NULL || tex == NULL || src == NULL) return;
  if (level <= 0 || lw <= 0 || lh <= 0 || srcW < lw) return;
  S3DContext* c = (S3DContext*)ctx;
  uint8_t* rgba = s3d_scratch(c, lw * lh * 4);
  if (rgba == NULL) return;
  for (int y = 0; y < lh; y++) {
    s3d_argb_to_rgba(src + (size_t)y * (size_t)srcW, rgba + (size_t)y * (size_t)lw * 4, lw);
  }
  GLuint t = (GLuint)(uintptr_t)tex;
  GLenum target = s3d_tex_gltarget(c, t);
  glBindTexture(target, t);
  glTexImage2D(target, level, GL_RGBA8, lw, lh, 0, GL_RGBA, GL_UNSIGNED_BYTE, rgba);
  glBindTexture(target, 0);
  sk_gr_reset_context();
}

// Bind an existing texture (a bitmap upload or a render texture) as sampler
// fs{unit}. No pixel transfer — the texture already holds content.
int s3d_bind_texture(void* ctx, int unit, void* tex, int hasChain) {
  if (ctx == NULL || unit < 0 || unit >= S3D_MAX_TEX || tex == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
  c->textures[unit] = (GLuint)(uintptr_t)tex;
  c->texHasMips[unit] = hasChain ? 1 : 0;
  return 1;
}

// Upload a Stage3D CubeTexture (six square faces, ARGB like every other upload)
// as one GL cube map and bind it as sampler fs{unit}. The AGAL translator only
// declares a `samplerCube` when the bytecode says <cube>, so the GL target must
// match: one slice per GL_TEXTURE_CUBE_MAP_POSITIVE_X+face.
//
// A mip chain is built at upload (mirroring the Metal glue's cube upload): the
// <cube,linear,miplinear> sampler the env-map path asks for needs a complete
// chain or the sampler returns black, and 512 texels squeezed into a few hundred
// screen pixels of skybox has no level to fall back to without it.
void* s3d_upload_cube_texture(void* ctx, int unit, int size, const uint32_t* const* argb) {
  if (ctx == NULL || unit < 0 || unit >= S3D_MAX_TEX || size <= 0 || argb == NULL) return NULL;
  S3DContext* c = (S3DContext*)ctx;
  int n = size * size;
  uint8_t* rgba = s3d_scratch(c, n * 4);
  if (rgba == NULL) return NULL;
  GLuint tex = 0;
  glGenTextures(1, &tex);
  glBindTexture(GL_TEXTURE_CUBE_MAP, tex);
  for (int face = 0; face < 6; face++) {
    if (argb[face] == NULL) { glDeleteTextures(1, &tex); return NULL; }
    s3d_argb_to_rgba(argb[face], rgba, n);
    glTexImage2D(GL_TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, GL_RGBA8, size, size, 0,
                 GL_RGBA, GL_UNSIGNED_BYTE, rgba);
  }
  glGenerateMipmap(GL_TEXTURE_CUBE_MAP);
  // Stage3D's default sampler state (clamp, linear, miplinear) -- the AGAL `tex`
  // flags retune it at draw time through s3d_apply_sampler.
  s3d_set_tex_params(GL_TEXTURE_CUBE_MAP, 0, 0, 2);
  s3d_record_target(c, tex, 1);
  c->textures[unit] = tex;
  c->texHasMips[unit] = 1;  // cube maps always carry a chain (built just above)
  sk_gr_reset_context();
  return (void*)(uintptr_t)tex;
}

void s3d_destroy_texture(void* tex) {
  if (tex == NULL) return;
  GLuint t = (GLuint)(uintptr_t)tex;
  s3d_unbind_texture_everywhere(t);
  glDeleteTextures(1, &t);
  for (int k = 0; k < s3d_live_n; k++) {
    S3DContext* c = s3d_live[k];
    for (int i = 0; i < c->texStateN; i++) if (c->texState[i].id == t) c->texState[i].id = 0;
    for (int i = 0; i < c->texTargetN; i++) {
      if (c->texTarget[i].id == t) { c->texTarget[i] = c->texTarget[--c->texTargetN]; break; }
    }
    for (int i = 0; i < c->rtTexN; i++) {
      if (c->rtTex[i].id == t) { c->rtTex[i] = c->rtTex[--c->rtTexN]; break; }
    }
  }
  sk_gr_reset_context();
}

// Drop every cached per-texture sampler state. Called by skia_glue.cc's
// sk_gl_draw_texture: Ganesh applies its own filter/wrap to the texture objects
// it samples, and our render-target texture is one of them. GL keeps that state
// on the texture object, so after Skia has sampled it our cache (S3DTexState) may
// claim "already LINEAR/CLAMP" while Ganesh left GL_NEAREST (its default) set —
// which would silently degrade the next Stage3D sampling of that same texture
// (the RenderTexture / filter scenes sample their render targets). Dropping the
// cache is O(live contexts × ≤64 entries) and only costs a few glTexParameteri
// calls on the next draw, versus a wrong filter mode.
void s3d_sampler_cache_invalidate(void) {
  for (int k = 0; k < s3d_live_n; k++) {
    S3DContext* c = s3d_live[k];
    c->texStateN = 0;
    for (int i = 0; i < S3D_MAX_TEX; i++) { c->samplerStateSet[i] = 0; c->texHasMips[i] = 0; }
  }
}

// ---- render-to-texture -----------------------------------------------------

// A render-target texture (optimizeForRenderToTexture=true): sampled like any
// other texture, and legal as the render override while a filter draws into it.
void* s3d_create_render_texture_fmt(void* ctx, int width, int height, int isHalf);

void* s3d_create_render_texture(void* ctx, int width, int height) {
  return s3d_create_render_texture_fmt(ctx, width, height, 0);
}

// isHalf != 0 allocates an RGBA16F target (Context3DTextureFormat.RGBA_HALF_FLOAT).
// Unlike Metal/D3D12, GL bakes no attachment format into its program objects, so
// the only extra state is the texture format itself and the readback conversion.
void* s3d_create_render_texture_fmt(void* ctx, int width, int height, int isHalf) {
  if (ctx == NULL || width <= 0 || height <= 0) return NULL;
  S3DContext* c = (S3DContext*)ctx;
  GLuint tex = 0;
  glGenTextures(1, &tex);
  glBindTexture(GL_TEXTURE_2D, tex);
  if (isHalf)
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA16F, width, height, 0, GL_RGBA, GL_HALF_FLOAT, NULL);
  else
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, width, height, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  s3d_rt_register(c, tex, width, height, isHalf ? 1 : 0);
  sk_gr_reset_context();
  return (void*)(uintptr_t)tex;
}

// Lazily create the FBO that makes a render texture drawable (kept for the
// texture's lifetime; a per-frame frame-buffer allocation would churn the GL
// object tables during Starling's filter passes).
static S3DRt* s3d_rt_for(S3DContext* c, GLuint color, int width, int height) {
  S3DRt* rt = new S3DRt();
  rt->color = color;
  rt->width = width; rt->height = height;
  rt->isHalf = 0;   // s3d_set_render_target records the real format below
  glGenFramebuffers(1, &rt->fbo);
  glGenRenderbuffers(1, &rt->depthStencil);
  glBindRenderbuffer(GL_RENDERBUFFER, rt->depthStencil);
  glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH24_STENCIL8, width, height);
  glBindFramebuffer(GL_FRAMEBUFFER, rt->fbo);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, color, 0);
  glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_STENCIL_ATTACHMENT, GL_RENDERBUFFER, rt->depthStencil);
  GLenum st = glCheckFramebufferStatus(GL_FRAMEBUFFER);
  glBindFramebuffer(GL_FRAMEBUFFER, 0);
  if (st != GL_FRAMEBUFFER_COMPLETE) {
    fprintf(stderr, "stage3d_webgl: render-texture FBO incomplete (0x%x)\n", (unsigned)st);
    glDeleteFramebuffers(1, &rt->fbo);
    glDeleteRenderbuffers(1, &rt->depthStencil);
    delete rt;
    return NULL;
  }
  (void)c;
  return rt;
}

// Bind the render override. tex == NULL restores the back buffer. (The Metal glue
// also checks for missing render-target usage; GL has no such flag, and the same
// texture is always created through s3d_create_render_texture.)
void s3d_set_render_target(void* ctx, void* tex, int enableDepthAndStencil) {
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  (void)enableDepthAndStencil;  // the attachment is always allocated (see the header)
  if (tex == NULL) { c->overrideRt = NULL; return; }
  GLuint t = (GLuint)(uintptr_t)tex;
  if (c->overrideRt != NULL && c->overrideRt->color == t) return;
  if (c->overrideRt != NULL) {
    S3DRt* old = c->overrideRt;
    glDeleteFramebuffers(1, &old->fbo);
    glDeleteRenderbuffers(1, &old->depthStencil);
    delete old;
    c->overrideRt = NULL;
  }
  int w = 0, h = 0, isHalf = 0;
  for (int i = 0; i < c->rtTexN; i++) {
    if (c->rtTex[i].id == t) {
      w = c->rtTex[i].width; h = c->rtTex[i].height; isHalf = c->rtTex[i].isHalf; break;
    }
  }
  if (w <= 0 || h <= 0) return;
  c->overrideRt = s3d_rt_for(c, t, w, h);
  // The format is what makes drawToBitmapData narrow instead of memcpy.
  if (c->overrideRt != NULL) c->overrideRt->isHalf = isHalf;
  sk_gr_reset_context();
}

// The current render target's color texture (render override if set, else the
// back buffer) — the GPU-direct composite path may sample it instead of readback.
void* s3d_get_render_target(void* ctx) {
  if (ctx == NULL) return NULL;
  S3DContext* c = (S3DContext*)ctx;
  GLuint t = (c->overrideRt != NULL) ? c->overrideRt->color : c->color;
  return (void*)(uintptr_t)t;
}

// ---- program ---------------------------------------------------------------

// Release everything a cache slot owns. The slot's KEY is deliberately left in
// place: it is how an emptied slot is still found on the next switch to that
// program.
static void s3d_prog_release(S3DProgramCache* e) {
  if (e->prog != 0) { glDeleteProgram(e->prog); e->prog = 0; }
  for (int i = 0; i < 256; i++) { e->uniVC[i] = -1; e->uniFC[i] = -1; }
}

// Move the LIVE program into the cache slot named c->progKey, so a later switch
// back to it is a lookup instead of a re-link. Ownership MOVES: the live slots
// are emptied afterwards. A full table evicts the least recently used slot.
// No-op when the live program is unkeyed (key == NULL).
static void s3d_prog_stash(S3DContext* c) {
  if (c->progKey == NULL) return;
  int idx = -1;
  for (int i = 0; i < c->nprogs; i++) if (c->progs[i].used && c->progs[i].key == c->progKey) { idx = i; break; }
  if (idx < 0) {
    if (c->nprogs < S3D_MAX_PROGRAMS) {
      idx = c->nprogs++;
      memset(&c->progs[idx], 0, sizeof(S3DProgramCache));
      c->progs[idx].used = 1;
      c->progs[idx].key = c->progKey;
    } else {
      idx = 0;
      for (int i = 1; i < c->nprogs; i++) if (c->progs[i].stamp < c->progs[idx].stamp) idx = i;
      s3d_prog_release(&c->progs[idx]);
      c->progs[idx].key = c->progKey;
    }
  } else {
    // The slot still holds an older copy (a recompile of the same Program3D).
    s3d_prog_release(&c->progs[idx]);
  }
  S3DProgramCache* e = &c->progs[idx];
  e->prog = c->prog;
  memcpy(e->uniVC, c->uniVC, sizeof(e->uniVC));
  memcpy(e->uniFC, c->uniFC, sizeof(e->uniFC));
  e->srcHash = c->progHash;
  e->stamp = ++c->progstamp;
  c->prog = 0;
  for (int i = 0; i < 256; i++) { c->uniVC[i] = -1; c->uniFC[i] = -1; }
  c->progKey = NULL;
}

// Move a cached program's state back into the live slots. The slot keeps its key
// (so it is still findable) and gives up ownership of the program.
static void s3d_prog_load(S3DContext* c, int idx) {
  S3DProgramCache* e = &c->progs[idx];
  c->prog = e->prog;
  memcpy(c->uniVC, e->uniVC, sizeof(c->uniVC));
  memcpy(c->uniFC, e->uniFC, sizeof(c->uniFC));
  e->prog = 0;
  for (int i = 0; i < 256; i++) { e->uniVC[i] = -1; e->uniFC[i] = -1; }
  c->progKey = e->key;
  c->progHash = e->srcHash;
  e->stamp = ++c->progstamp;
}

// FNV-1a over both shader sources: the cache slot's content check. The Program3D
// pointer alone is not enough — Stage3D lets the SAME Program3D be re-uploaded
// with new bytecode (Program3D.upload), which produces different GLSL that must
// be recompiled instead of silently reusing the stale program.
static unsigned long long s3d_src_hash(const char* vs, const char* fs) {
  unsigned long long h = 1469598103934665603ULL;
  for (const char* p = vs; p != NULL && *p != '\0'; p++) { h ^= (unsigned char)*p; h *= 1099511628211ULL; }
  h ^= 0xFFUL; h *= 1099511628211ULL;   // separator: vs and fs must not be confusable
  for (const char* p = fs; p != NULL && *p != '\0'; p++) { h ^= (unsigned char)*p; h *= 1099511628211ULL; }
  return h;
}

// Compile the AGAL->GLSL pair into one linked program and make it current.
// `key` is the Program3D identity the caller wants current (NULL = no caching).
// A program whose source is already compiled is merely SELECTED. `errbuf`
// receives the GL info log on failure (Context3D_submit turns it into an AS3
// Error, exactly like the Metal glue's NSError path).
int s3d_compile(void* ctx, void* key, const char* vs_glsl, const char* fs_glsl, char* errbuf, int errbuf_size) {
  if (ctx == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
  const unsigned long long srchash = s3d_src_hash(vs_glsl, fs_glsl);
  if (key != NULL) {
    int cached = -1;
    for (int i = 0; i < c->nprogs; i++) if (c->progs[i].used && c->progs[i].key == key) { cached = i; break; }
    if (cached >= 0 && c->progs[cached].srcHash == srchash) {
      if (c->progKey == key && c->progHash == srchash) return 1;
      if (c->progKey != key) { s3d_prog_stash(c); s3d_prog_load(c, cached); return 1; }
    }
    // Preserve whatever program is live, then drop a stale copy of THIS one.
    // (Re-find it afterwards: the stash may have evicted that very slot.)
    s3d_prog_stash(c);
    for (int i = 0; i < c->nprogs; i++) if (c->progs[i].used && c->progs[i].key == key) { s3d_prog_release(&c->progs[i]); break; }
  } else {
    // No identity to cache under: the previous program is unreachable.
    if (c->prog != 0) { glDeleteProgram(c->prog); c->prog = 0; }
  }
  GLuint vs = glCreateShader(GL_VERTEX_SHADER);
  glShaderSource(vs, 1, &vs_glsl, NULL);
  glCompileShader(vs);
  GLint ok = 0;
  glGetShaderiv(vs, GL_COMPILE_STATUS, &ok);
  if (!ok) {
    char log[512]; log[0] = 0;
    glGetShaderInfoLog(vs, sizeof(log) - 1, NULL, log);
    fprintf(stderr, "stage3d_webgl: GLSL(vertex) compile failed: %s\n%s\n", log, vs_glsl);
    if (errbuf && errbuf_size > 0) snprintf(errbuf, errbuf_size, "GLSL(vertex): %s", log);
    glDeleteShader(vs);
    return 0;
  }
  GLuint fs = glCreateShader(GL_FRAGMENT_SHADER);
  glShaderSource(fs, 1, &fs_glsl, NULL);
  glCompileShader(fs);
  glGetShaderiv(fs, GL_COMPILE_STATUS, &ok);
  if (!ok) {
    char log[512]; log[0] = 0;
    glGetShaderInfoLog(fs, sizeof(log) - 1, NULL, log);
    fprintf(stderr, "stage3d_webgl: GLSL(fragment) compile failed: %s\n%s\n", log, fs_glsl);
    if (errbuf && errbuf_size > 0) snprintf(errbuf, errbuf_size, "GLSL(fragment): %s", log);
    glDeleteShader(vs);
    glDeleteShader(fs);
    return 0;
  }
  GLuint prog = glCreateProgram();
  glAttachShader(prog, vs);
  glAttachShader(prog, fs);
  // Attribute locations are fixed before linking so vertex stream i is always
  // attribute i, independent of how the driver would otherwise assign them.
  for (int i = 0; i < S3D_MAX_ATTR; i++) {
    char name[8];
    snprintf(name, sizeof(name), "va%d", i);
    glBindAttribLocation(prog, i, name);
  }
  glLinkProgram(prog);
  glDeleteShader(vs);
  glDeleteShader(fs);
  glGetProgramiv(prog, GL_LINK_STATUS, &ok);
  if (!ok) {
    char log[512]; log[0] = 0;
    glGetProgramInfoLog(prog, sizeof(log) - 1, NULL, log);
    fprintf(stderr, "stage3d_webgl: GLSL link failed: %s\n", log);
    if (errbuf && errbuf_size > 0) snprintf(errbuf, errbuf_size, "GLSL link: %s", log);
    glDeleteProgram(prog);
    return 0;
  }
  c->prog = prog;
  // Record the live program's identity + source hash, so the next switch away
  // stashes it under the right slot and a re-upload is detected.
  c->progKey = key;
  c->progHash = srchash;
  for (int i = 0; i < c->nprogs; i++) if (c->progs[i].used && c->progs[i].key == key) { c->progs[i].stamp = ++c->progstamp; break; }
  // Cache the constant-register and sampler locations once per program (a per-draw
  // glGetUniformLocation would cost a string lookup for every register).
  glUseProgram(prog);
  for (int i = 0; i < 256; i++) {
    char name[16];
    snprintf(name, sizeof(name), "vc%d", i);
    c->uniVC[i] = glGetUniformLocation(prog, name);
    snprintf(name, sizeof(name), "fc%d", i);
    c->uniFC[i] = glGetUniformLocation(prog, name);
  }
  for (int i = 0; i < S3D_MAX_TEX; i++) {
    char name[8];
    snprintf(name, sizeof(name), "fs%d", i);
    GLint loc = glGetUniformLocation(prog, name);
    if (loc >= 0) glUniform1i(loc, i);  // sampler fsN reads texture unit N
  }
  glUseProgram(0);
  sk_gr_reset_context();
  return 1;
}

// ---- E6 native shader channel (WebGL2 passthrough) --------------------------
//
// Everything below exists only when the build asked for `--features native-shader`.
// It is the web arm of the channel the Metal glue implements with MTLProgram and the
// SPIRV-Cross reflection table; here the shaders are the author's own GLSL ES 3.00
// (WebGL2 compiles it as written) and the reflection table comes from the driver.
//
// The four host-side facts that shape this code:
//
//  1. GL has ONE uniform namespace per program, while Metal has one per stage. The
//     AS3 API carries a stage with every binding, so reflection here is done per
//     SHADER OBJECT (glGetActiveUniform works on a shader) -- that is what makes
//     "this sampler belongs to the fragment stage" knowable, and it is why a
//     fragment-only sampler does not get bound to a vertex unit.
//  2. Uniforms are addressed by NAME in GL. setUniform* only carries the reflected
//     slot, so the caller hands the name->slot table over once per program
//     (s3d_native_layout) and this file turns it into glGetUniformLocation results.
//  3. Texture units are one namespace: fragment slot s -> unit s, vertex slot s ->
//     unit 8+s (GLES3 guarantees MAX_VERTEX_TEXTURE_IMAGE_UNITS >= 16).
//  4. Same-source re-uploads and per-frame program switches must not re-link or
//     re-query: the program cache (s3d_compile) and nativeLayoutProg do that.
#ifdef ASC_USE_NATIVE_SHADER

// Format token -> GL internal format. Same id space as the Metal glue's
// s3d_fmt_from_id and emit.ts's as_shader_format_id (0 BGRA8 / 1 rgba32f / 2 r32f /
// 3 rg32f / 4 rgbaHalfFloat / 5 r16f / 6 rg16f / 7 r11g11b10f / 8 r8 / 9 depth32f /
// 10 depth16). `format`/`type` are the *transfer* descriptors, which only matter when
// pixels are uploaded -- these textures are GPU-written, so they are NULL here.
static int s3d_fmt_web(int fmtId, GLint* internal, GLenum* format, GLenum* type, int* isDepth) {
  *isDepth = 0;
  switch (fmtId) {
    case 0:  *internal = GL_RGBA8;    *format = GL_RGBA; *type = GL_UNSIGNED_BYTE; return 1;
    case 1:  *internal = GL_RGBA32F;  *format = GL_RGBA; *type = GL_FLOAT; return 1;
    case 2:  *internal = GL_R32F;     *format = GL_RED;  *type = GL_FLOAT; return 1;
    case 3:  *internal = GL_RG32F;    *format = GL_RG;   *type = GL_FLOAT; return 1;
    case 4:  *internal = GL_RGBA16F;  *format = GL_RGBA; *type = GL_HALF_FLOAT; return 1;
    case 5:  *internal = GL_R16F;     *format = GL_RED;  *type = GL_HALF_FLOAT; return 1;
    case 6:  *internal = GL_RG16F;    *format = GL_RG;   *type = GL_HALF_FLOAT; return 1;
    case 7:  *internal = GL_R11F_G11F_B10F; *format = GL_RGB; *type = GL_HALF_FLOAT; return 1;
    case 8:  *internal = GL_R8;       *format = GL_RED;  *type = GL_UNSIGNED_BYTE; return 1;
    case 9:  *internal = GL_DEPTH_COMPONENT32F; *format = GL_DEPTH_COMPONENT; *type = GL_FLOAT; *isDepth = 1; return 1;
    case 10: *internal = GL_DEPTH_COMPONENT16;  *format = GL_DEPTH_COMPONENT; *type = GL_UNSIGNED_SHORT; *isDepth = 1; return 1;
    default: return 0;
  }
}

// ---- the GLSL ES 3.00 gate ------------------------------------------------
//
// The channel's contract is "GLSL ES 3.00 in" on EVERY backend: the native arm
// checks it in shader_compiler.cc (refusing `#version 100`, prepending `300 es` when
// the directive is absent) and this arm has to reach the same verdict for the same
// source, or the same ShaderMaterial would be accepted on web and refused on Metal.
// WebGL2 is happy to compile an ES 1.00 shader, so silence here would be a real
// behavioural difference, not a technicality.
//
// Returns a malloc'd ES 3.00 source (the caller frees it) or NULL with `err` filled.
static char* s3d_es3_source(const char* src, const char* stage, char* err, int errcap) {
  const char* def = "#version 300 es\n";
  size_t i = 0, n = strlen(src);
  // Only the leading comment/blank block may hold `#version` (same rule as the
  // native arm's scan_version): anything later is the driver's error to report.
  for (;;) {
    while (i < n && (src[i] == ' ' || src[i] == '\t' || src[i] == '\r' || src[i] == '\n')) i++;
    if (i + 1 < n && src[i] == '/' && src[i + 1] == '/') {
      while (i < n && src[i] != '\n') i++;
      continue;
    }
    if (i + 1 < n && src[i] == '/' && src[i + 1] == '*') {
      i += 2;
      while (i + 1 < n && !(src[i] == '*' && src[i + 1] == '/')) i++;
      i = (i + 1 < n) ? i + 2 : n;
      continue;
    }
    break;
  }
  if (i + 8 <= n && strncmp(src + i, "#version", 8) == 0) {
    size_t j = i + 8;
    while (j < n && (src[j] == ' ' || src[j] == '\t')) j++;
    int num = 0;
    while (j < n && src[j] >= '0' && src[j] <= '9') { num = num * 10 + (src[j] - '0'); j++; }
    while (j < n && (src[j] == ' ' || src[j] == '\t')) j++;
    int is_es = (j + 1 < n && src[j] == 'e' && src[j + 1] == 's');
    if (num == 300 && is_es) return strdup(src);
    snprintf(err, (size_t)errcap,
             "%s shader: only `#version 300 es` (GLSL ES 3.00) is accepted, found `#version %d%s`",
             stage, num, is_es ? " es" : "");
    return NULL;
  }
  // Absent: accepted (the three.js shape), by prepending the directive. Same
  // permissive reading as the native arm's kDefaultVersion.
  size_t dl = strlen(def);
  char* out = (char*)malloc(dl + n + 1);
  if (out == NULL) { snprintf(err, (size_t)errcap, "%s shader: out of memory", stage); return NULL; }
  memcpy(out, def, dl);
  memcpy(out + dl, src, n + 1);
  return out;
}

// glGetActiveUniform / glGetActiveAttrib type -> (kind, base type, scalars per element).
// The base type is not cosmetic: setUniformInts hands over INT BITS in a float
// payload, so an `int` uniform must go through glUniform*iv and a float one through
// glUniform*fv (see the header comment on asc_shader_binding.base_type).
static void s3d_gl_type_parts(GLenum type, int* kind, int* base, int* comps) {
  *kind = ASC_SHADER_KIND_UNIFORM;
  *base = ASC_SHADER_BASE_FLOAT;
  *comps = 1;
  switch (type) {
    case GL_FLOAT: *comps = 1; return;
    case GL_FLOAT_VEC2: *comps = 2; return;
    case GL_FLOAT_VEC3: *comps = 3; return;
    case GL_FLOAT_VEC4: *comps = 4; return;
    case GL_FLOAT_MAT2: *comps = 4; return;
    case GL_FLOAT_MAT3: *comps = 9; return;
    case GL_FLOAT_MAT4: *comps = 16; return;
    case GL_INT: *base = ASC_SHADER_BASE_INT; *comps = 1; return;
    case GL_INT_VEC2: *base = ASC_SHADER_BASE_INT; *comps = 2; return;
    case GL_INT_VEC3: *base = ASC_SHADER_BASE_INT; *comps = 3; return;
    case GL_INT_VEC4: *base = ASC_SHADER_BASE_INT; *comps = 4; return;
    case GL_UNSIGNED_INT: *base = ASC_SHADER_BASE_UINT; *comps = 1; return;
    case GL_UNSIGNED_INT_VEC2: *base = ASC_SHADER_BASE_UINT; *comps = 2; return;
    case GL_UNSIGNED_INT_VEC3: *base = ASC_SHADER_BASE_UINT; *comps = 3; return;
    case GL_UNSIGNED_INT_VEC4: *base = ASC_SHADER_BASE_UINT; *comps = 4; return;
    case GL_BOOL: *base = ASC_SHADER_BASE_BOOL; *comps = 1; return;
    case GL_BOOL_VEC2: *base = ASC_SHADER_BASE_BOOL; *comps = 2; return;
    case GL_BOOL_VEC3: *base = ASC_SHADER_BASE_BOOL; *comps = 3; return;
    case GL_BOOL_VEC4: *base = ASC_SHADER_BASE_BOOL; *comps = 4; return;
    case GL_SAMPLER_2D: case GL_SAMPLER_3D: case GL_SAMPLER_CUBE:
    case GL_SAMPLER_2D_ARRAY: case GL_SAMPLER_2D_SHADOW:
    case GL_INT_SAMPLER_2D: case GL_INT_SAMPLER_3D: case GL_INT_SAMPLER_CUBE:
    case GL_INT_SAMPLER_2D_ARRAY: case GL_UNSIGNED_INT_SAMPLER_2D:
    case GL_UNSIGNED_INT_SAMPLER_3D: case GL_UNSIGNED_INT_SAMPLER_CUBE:
    case GL_UNSIGNED_INT_SAMPLER_2D_ARRAY:
      *kind = ASC_SHADER_KIND_TEXTURE;
      *base = ASC_SHADER_BASE_INT;
      *comps = 1;
      return;
    default:
      // Unreachable for a program the driver accepted (every active uniform has one
      // of the types above); leaving the float default is the harmless branch.
      return;
  }
}

// Count the fragment outputs that carry an explicit `layout(location = N)`. WebGL2 has
// no query for "how many draw buffers does this program write" (glGetProgramResource*
// is GL 4.3), and MRT programs are exactly the ones that need the count right, so the
// declaration is read back from the source. A program with no explicit location has
// one output, which is the language default.
static int s3d_count_frag_outputs(const char* fs) {
  int maxLoc = -1;
  for (const char* p = fs; (p = strstr(p, "location")) != NULL; p++) {
    const char* q = p + 8;
    while (*q == ' ' || *q == '\t') q++;
    if (*q != '=') continue;
    q++;
    while (*q == ' ' || *q == '\t') q++;
    int n = 0, digits = 0;
    while (*q >= '0' && *q <= '9') { n = n * 10 + (*q - '0'); q++; digits = 1; }
    if (!digits) continue;
    while (*q == ' ' || *q == '\t') q++;
    if (*q != ')') continue;
    q++;
    while (*q == ' ' || *q == '\t' || *q == '\n' || *q == '\r') q++;
    // `out` (and not `in`): the qualifier that follows the layout block.
    if (strncmp(q, "out", 3) != 0) continue;
    if (n > maxLoc) maxLoc = n;
  }
  return maxLoc >= 0 ? maxLoc + 1 : 1;
}

// Compile one stage. Returns 0 with `err` prefixed by the stage name on failure.
static GLuint s3d_compile_stage(GLenum type, const char* src, const char* stage, char* err, int errcap) {
  GLuint s = glCreateShader(type);
  glShaderSource(s, 1, &src, NULL);
  glCompileShader(s);
  GLint ok = 0;
  glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
  if (!ok) {
    char log[512];
    log[0] = 0;
    glGetShaderInfoLog(s, sizeof(log) - 1, NULL, log);
    fprintf(stderr, "stage3d_webgl: native GLSL(%s) compile failed: %s\n%s\n", stage, log, src);
    if (err != NULL && errcap > 0) snprintf(err, (size_t)errcap, "GLSL(%s): %s", stage, log);
    glDeleteShader(s);
    return 0;
  }
  return s;
}

// Does this source DECLARE `name` as a uniform? Needed because GL exposes one uniform
// namespace per PROGRAM: glGetActiveUniform on the linked program answers "there is a
// uniform called uColor" but not "which stage declared it", and the stage decides which
// texture unit a sampler gets (fragment 0..7 vs vertex 8..15). (The obvious alternative
// -- reflecting each SHADER object -- does not exist in GLES 3.0: the active-uniform
// query is program-only there, measured as an empty list on this backend.)
//
// The scan is deliberately narrow: walk tokens, and when `uniform` is seen, compare the
// whole declaration (up to the closing semicolon) token by token. That covers
// `uniform mat4 m;`, `uniform sampler2D t[8];`, `uniform highp float f;` and the block
// form `uniform Foo { ... } bar;` without pretending to parse GLSL.
static int s3d_declares_uniform(const char* src, const char* name) {
  if (src == NULL || name == NULL || name[0] == '\0') return 0;
  size_t n = strlen(src), i = 0;
  int armed = 0;   // inside a uniform declaration, before the ';'
  while (i < n) {
    char c = src[i];
    if (c == '/' && i + 1 < n && src[i + 1] == '/') { while (i < n && src[i] != '\n') i++; continue; }
    if (c == '/' && i + 1 < n && src[i + 1] == '*') {
      i += 2;
      while (i + 1 < n && !(src[i] == '*' && src[i + 1] == '/')) i++;
      i = (i + 1 < n) ? i + 2 : n;
      continue;
    }
    if (!(isalnum((unsigned char)c) || c == '_')) {
      if (c == ';') armed = 0;
      i++;
      continue;
    }
    size_t j = i;
    while (j < n && (isalnum((unsigned char)src[j]) || src[j] == '_')) j++;
    size_t len = j - i;
    if (!armed) {
      if (len == 7 && strncmp(src + i, "uniform", 7) == 0) armed = 1;
    } else {
      size_t nl = strlen(name);
      if (len == nl && strncmp(src + i, name, nl) == 0) return 1;
    }
    i = j;
  }
  return 0;
}

// Fill the reflection table from the linked PROGRAM. One entry per stage that declares
// the uniform (two when both do, which is how Metal reports it too -- the AS3 side keys
// setUniform on (stage, slot)).
static int s3d_reflect_uniforms(GLuint prog, const char* vs, const char* fs,
                                asc_shader_binding** buf, int* n, int* cap) {
  GLint count = 0;
  glGetProgramiv(prog, GL_ACTIVE_UNIFORMS, &count);
  // Slots are numbered PER (kind, stage), starting at 0 -- exactly what Metal's
  // spvc_compiler_msl_get_automatic_resource_binding hands out, where [[buffer(N)]] and
  // [[texture(N)]] are independent namespaces inside a stage. Numbering them across kinds
  // instead (the first version of this function) pushed a program's samplers past slot 7
  // as soon as it also declared a few uniforms, and the sampler table then refused them:
  // the sky sampled an unbound unit and the whole ocean rendered black with no GL error.
  int nextSlot[3][2] = { { 0, 0 }, { 0, 0 }, { 0, 0 } };
  for (GLint i = 0; i < count; i++) {
    char name[256];
    GLsizei len = 0;
    GLint size = 1;
    GLenum type = 0;
    glGetActiveUniform(prog, (GLuint)i, (GLsizei)sizeof(name), &len, &size, &type, name);
    if (len <= 0) continue;
    // An array uniform is reported as "uFoo[0]": the table names the uniform, which is
    // what glGetUniformLocation also takes.
    char* bracket = strchr(name, '[');
    if (bracket != NULL) *bracket = '\0';
    int kind = ASC_SHADER_KIND_UNIFORM, base = ASC_SHADER_BASE_FLOAT, comps = 1;
    s3d_gl_type_parts(type, &kind, &base, &comps);
    int in_vs = s3d_declares_uniform(vs, name);
    int in_fs = s3d_declares_uniform(fs, name);
    if (!in_vs && !in_fs) in_fs = 1;   // a program-level uniform nothing declared: report once
    for (int stage = 0; stage < 2; stage++) {
      if (stage == 0 && !in_vs) continue;
      if (stage == 1 && !in_fs) continue;
      if (*n >= *cap) {
        int ncap = (*cap) * 2;
        asc_shader_binding* nb = (asc_shader_binding*)realloc(*buf, (size_t)ncap * sizeof **buf);
        if (nb == NULL) return 0;
        *buf = nb;
        *cap = ncap;
      }
      asc_shader_binding* b = &(*buf)[(*n)++];
      memset(b, 0, sizeof *b);
      b->name = strdup(name);
      b->kind = kind;
      // The slot is the binding index the AS3 side keys setUniform/setTextureAt on:
      // sequential per (kind, stage), see nextSlot above.
      {
        int k = (kind >= 0 && kind <= 2) ? kind : 1;
        b->binding = nextSlot[k][stage]++;
      }
      b->stage = stage;
      b->size = size > 0 ? size : 1;
      b->components = comps;
      b->base_type = base;
    }
  }
  return 1;
}

// ---- reflection by the driver ---------------------------------------------
//
// Replaces asc_shader_translate for this backend: same output struct, same contract
// (ok/infoLog/reflection), no cross-compiler. `ctx` is unused (reflection needs the
// GL context only implicitly -- the driver is already current), and it stays in the
// signature because the seam is shared with the native arm.
int s3d_native_reflect(void* ctx, const char* vs, const char* fs, asc_shader_program* out) {
  (void)ctx;
  if (out == NULL) return 0;
  memset(out, 0, sizeof *out);
  if (vs == NULL || fs == NULL) {
    snprintf(out->error, sizeof out->error, "native shader: vertex and fragment source are both required");
    return 0;
  }
  char e[1024];
  e[0] = 0;
  char* v3 = s3d_es3_source(vs, "vertex", e, (int)sizeof e);
  if (v3 == NULL) { snprintf(out->error, sizeof out->error, "%s", e); return 0; }
  char* f3 = s3d_es3_source(fs, "fragment", e, (int)sizeof e);
  if (f3 == NULL) { free(v3); snprintf(out->error, sizeof out->error, "%s", e); return 0; }

  GLuint vsh = s3d_compile_stage(GL_VERTEX_SHADER, v3, "vertex", out->error, (int)sizeof out->error);
  if (vsh == 0) { free(v3); free(f3); return 0; }
  GLuint fsh = s3d_compile_stage(GL_FRAGMENT_SHADER, f3, "fragment", out->error, (int)sizeof out->error);
  if (fsh == 0) { glDeleteShader(vsh); free(v3); free(f3); return 0; }

  int cap = 32, n = 0;
  asc_shader_binding* bindings = (asc_shader_binding*)calloc((size_t)cap, sizeof *bindings);
  if (bindings == NULL) {
    glDeleteShader(vsh); glDeleteShader(fsh); free(v3); free(f3);
    snprintf(out->error, sizeof out->error, "native shader: out of memory");
    return 0;
  }

  GLuint prog = glCreateProgram();
  glAttachShader(prog, vsh);
  glAttachShader(prog, fsh);
  glLinkProgram(prog);
  GLint ok = 0;
  glGetProgramiv(prog, GL_LINK_STATUS, &ok);
  if (!ok) {
    char log[512];
    log[0] = 0;
    glGetProgramInfoLog(prog, sizeof(log) - 1, NULL, log);
    fprintf(stderr, "stage3d_webgl: native GLSL link failed: %s\n", log);
    snprintf(out->error, sizeof out->error, "GLSL link: %s", log);
    glDeleteProgram(prog); glDeleteShader(vsh); glDeleteShader(fsh);
    for (int i = 0; i < n; i++) free(bindings[i].name);
    free(bindings); free(v3); free(f3);
    return 0;
  }
  // Reflection is program-level (see s3d_declares_uniform for why), so it happens here,
  // after the link, with both sources at hand to attribute each uniform to its stage.
  s3d_reflect_uniforms(prog, v3, f3, &bindings, &n, &cap);
  // Attributes need the linked program (glGetAttribLocation takes one). Their
  // `binding` is the vertex location, which is exactly the vertex-stream index the
  // draw binds -- that is the contract a native vertex shader signs by declaring
  // `layout(location = N) in ...`.
  GLint nattr = 0;
  glGetProgramiv(prog, GL_ACTIVE_ATTRIBUTES, &nattr);
  for (GLint i = 0; i < nattr; i++) {
    char name[256];
    GLsizei len = 0;
    GLint size = 1;
    GLenum type = 0;
    glGetActiveAttrib(prog, (GLuint)i, (GLsizei)sizeof(name), &len, &size, &type, name);
    if (len <= 0) continue;
    int loc = glGetAttribLocation(prog, name);
    if (n >= cap) {
      int ncap = cap * 2;
      asc_shader_binding* nb = (asc_shader_binding*)realloc(bindings, (size_t)ncap * sizeof *bindings);
      if (nb == NULL) break;
      bindings = nb;
      cap = ncap;
    }
    int kind = ASC_SHADER_KIND_UNIFORM, base = ASC_SHADER_BASE_FLOAT, comps = 1;
    s3d_gl_type_parts(type, &kind, &base, &comps);
    asc_shader_binding* b = &bindings[n++];
    memset(b, 0, sizeof *b);
    b->name = strdup(name);
    b->kind = ASC_SHADER_KIND_ATTRIBUTE;
    b->binding = loc;
    b->stage = 0;
    b->size = size > 0 ? size : 1;
    b->components = comps;
    b->base_type = base;
  }
  out->bindings = bindings;
  out->binding_count = n;
  out->color_attachments = s3d_count_frag_outputs(f3);
  // On this backend "translated" means "the text that was compiled": the author's own
  // ES 3.00 (with the directive prepended when it was absent). Reporting it keeps
  // getTranslatedSource useful instead of answering "" -- and a caller asserting on it
  // (shader-m30 does) sees reality rather than a lie about a nonexistent translation.
  out->vertex_source = v3;
  out->fragment_source = f3;
  glDeleteProgram(prog);
  glDeleteShader(vsh);
  glDeleteShader(fsh);
  return 1;
}

// asc_shader_program_free lives in the cross-compiler on the native arm, which this
// build does not link. Same contract (owns both sources and every binding name).
void asc_shader_program_free(asc_shader_program* p) {
  if (p == NULL) return;
  free(p->vertex_source);
  free(p->fragment_source);
  for (int i = 0; i < p->binding_count; i++) free(p->bindings[i].name);
  free(p->bindings);
  memset(p, 0, sizeof *p);
}

// The banner's answer on this backend: there is no cross-compiler here at all.
const char* asc_shader_backend_info(void) {
  return "WebGL2 passthrough (driver reflection; no cross-compiler)";
}

// ---- the host half -------------------------------------------------------

int s3d_native_use(void* ctx, const char* vs, const char* fs, int ncolor, char* err, int errcap) {
  if (ctx == NULL || vs == NULL || fs == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
  if (ncolor < 1) ncolor = 1;
  if (ncolor > 4) ncolor = 4;
  // The staged uniforms belong to the program that was current, not to this one.
  memset(c->nativeUniformSet, 0, sizeof c->nativeUniformSet);
  c->nativeMode = 1;
  c->nativeNColor = ncolor;
  // The same submit path as Metal: `vs` is the translated text the caller owns and one
  // NativeProgram3D has exactly one, so it is the compile-cache key.
  if (!s3d_compile(ctx, (void*)vs, vs, fs, err, errcap)) {
    // Leave nativeMode set: the caller throws on 0, and a half-configured context that
    // then fell back to AGAL would draw with the wrong uniform model.
    return 0;
  }
  return 1;
}

void s3d_native_uniform(void* ctx, int stage, int slot, const float* f, int nfloats) {
  if (ctx == NULL || f == NULL || nfloats <= 0) return;
  S3DContext* c = (S3DContext*)ctx;
  if (stage < 0 || stage > 1 || slot < 0 || slot > 15) return;
  int n = nfloats * 4;
  if (n > 64) n = 64;   // the 64-byte per-slot payload ceiling of the whole channel
  memcpy(c->nativeUniform[stage][slot], f, (size_t)n);
  c->nativeUniformSet[stage][slot] = 1;
}

void s3d_native_bind_texture(void* ctx, int stage, int slot, void* tex) {
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  if (slot < 0 || slot >= S3D_MAX_NATIVE_TEX) {
    if (asc_s3d_dump())
      fprintf(stderr, "stage3d_webgl: native texture slot %d is outside 0..%d (not bound)\n",
              slot, S3D_MAX_NATIVE_TEX - 1);
    return;
  }
  if (stage < 0 || stage > 1) stage = 1;
  c->nativeTex[stage][slot] = (GLuint)(uintptr_t)tex;
}

void s3d_native_set_sampler_state(void* ctx, int stage, int unit, int filter, int wrap, int mip) {
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  if (stage < 0 || stage > 1 || unit < 0 || unit >= S3D_MAX_NATIVE_TEX) return;
  c->nativeSampler[stage][unit][0] = filter;
  c->nativeSampler[stage][unit][1] = wrap;
  c->nativeSampler[stage][unit][2] = mip;
  c->nativeSamplerSet[stage][unit] = 1;
}

// Resolve the caller's name->slot table into GL locations for the LIVE program. Called
// once per program bind (the caller cannot know when it is already resolved), so the
// (program, table) pair is hashed and a repeat is a no-op -- otherwise every frame
// would cost one glGetUniformLocation per binding per material.
void s3d_native_layout(void* ctx, const char* const* names, const int* kinds, const int* stages,
                       const int* slots, const int* base_types, const int* components,
                       const int* sizes, int count) {
  if (ctx == NULL || names == NULL || count <= 0) return;
  S3DContext* c = (S3DContext*)ctx;
  if (c->prog == 0) return;
  unsigned long long h = 1469598103934665603ULL;
  for (int i = 0; i < count; i++) {
    const char* p = names[i];
    for (; p != NULL && *p != '\0'; p++) { h ^= (unsigned char)*p; h *= 1099511628211ULL; }
    h ^= (unsigned long long)(kinds[i] * 131 + stages[i] * 17 + slots[i]);
    h *= 1099511628211ULL;
  }
  if (c->nativeLayoutProg == c->prog && c->nativeLayoutHash == h) return;
  GLint prev = 0;
  glGetIntegerv(GL_CURRENT_PROGRAM, &prev);
  glUseProgram(c->prog);
  // Texture units are ONE global namespace in GL (glActiveTexture) although the sampler
  // uniforms that name them live per stage, so the two stages' slot ranges must not
  // overlap: Metal keeps them apart by construction ([[texture(N)]] in the vertex stage
  // and in the fragment stage are different bindings), GL does not. Count each stage's
  // samplers and lay them out back to back, vertex first. Splitting at a fixed 8 (the
  // AGAL convention) breaks the ocean program, which declares 7 + 9.
  int texSlots[2] = { 0, 0 };
  for (int i = 0; i < count; i++) {
    if (kinds[i] != ASC_SHADER_KIND_TEXTURE) continue;
    int st0 = stages[i] < 0 ? 0 : (stages[i] > 1 ? 1 : stages[i]);
    if (slots[i] >= 0 && slots[i] < S3D_MAX_NATIVE_TEX && slots[i] + 1 > texSlots[st0]) texSlots[st0] = slots[i] + 1;
  }
  int texBase[2];
  texBase[0] = 0;
  texBase[1] = texSlots[0];
  if (texBase[1] + texSlots[1] > 16) {
    static int warned = 0;
    if (!warned) {
      fprintf(stderr, "stage3d_webgl: native program needs %d + %d samplers, more than the 16 texture units this seam shares between stages; the excess is unbound\n",
              texSlots[0], texSlots[1]);
      warned = 1;
    }
  }
  for (int s = 0; s < 2; s++) {
    for (int i = 0; i < 16; i++) { c->nativeLoc[s][i] = -1; c->nativeComps[s][i] = 1; c->nativeSize[s][i] = 1; }
    memset(c->nativeTexTable[s], 0, sizeof c->nativeTexTable[s]);
  }
  for (int i = 0; i < count; i++) {
    if (names[i] == NULL || names[i][0] == '\0') continue;
    int stage = stages[i] < 0 ? 0 : (stages[i] > 1 ? 1 : stages[i]);
    int slot = slots[i];
    if (slot < 0) continue;
    if (kinds[i] == ASC_SHADER_KIND_ATTRIBUTE) continue;  // layout(location=N) IS the stream index
    if (kinds[i] == ASC_SHADER_KIND_TEXTURE) {
      // Slots are per (kind, stage), so a sampler's slot means nothing to the uniform
      // table and is deliberately NOT written there -- the two tables only share the
      // context, never the index.
      if (slot >= S3D_MAX_NATIVE_TEX) continue;
      int unit = texBase[stage] + slot;
      GLint sloc = glGetUniformLocation(c->prog, names[i]);
      c->nativeUnit[stage][slot] = unit;
      c->nativeTexTable[stage][slot] = 1;
      // A sampler uniform's value is the texture UNIT, and it is program state: bind it
      // once here rather than on every draw.
      if (sloc >= 0) glUniform1i(sloc, unit);
      continue;
    }
    if (slot > 15) continue;
    GLint loc = glGetUniformLocation(c->prog, names[i]);
    c->nativeLoc[stage][slot] = loc;
    c->nativeBase[stage][slot] = base_types[i];
    c->nativeComps[stage][slot] = components != NULL && components[i] > 0 ? components[i] : 1;
    c->nativeSize[stage][slot] = sizes != NULL && sizes[i] > 0 ? sizes[i] : 1;
  }
  c->nativeLayoutProg = c->prog;
  c->nativeLayoutHash = h;
  if (prev != (GLint)c->prog) glUseProgram((GLuint)prev);
  sk_gr_reset_context();
}

// Apply the staged uniforms of the live native program. GL has no notion of "a buffer
// per uniform slot", so each entry is a glUniform* call whose width/array length comes
// from the reflection: matrices by components 4/9/16, vectors by 1..4, integer
// uniforms through the *iv entry points (the payload carries int bits, not floats).
static void s3d_apply_native_uniforms(S3DContext* c) {
  for (int stage = 0; stage < 2; stage++) {
    for (int slot = 0; slot < 16; slot++) {
      if (!c->nativeUniformSet[stage][slot]) continue;
      int loc = c->nativeLoc[stage][slot];
      if (loc < 0) continue;   // optimized out by the driver: same as Metal's unused buffer
      const float* f = (const float*)c->nativeUniform[stage][slot];
      int comps = c->nativeComps[stage][slot];
      int size = c->nativeSize[stage][slot];
      if (size < 1) size = 1;
      int base = c->nativeBase[stage][slot];
      if (comps == 16) { glUniformMatrix4fv(loc, size, GL_FALSE, f); continue; }
      if (comps == 9) { glUniformMatrix3fv(loc, size, GL_FALSE, f); continue; }
      if (comps < 1 || comps > 4) comps = 4;
      int n = size;
      // The 64-byte payload ceiling caps what one call can carry; a longer array was
      // already truncated at the AS3 boundary (setUniformFloats rejects > 16).
      int maxn = 16 / comps;
      if (n > maxn) n = maxn;
      if (base == ASC_SHADER_BASE_INT || base == ASC_SHADER_BASE_BOOL) {
        const GLint* v = (const GLint*)f;
        switch (comps) {
          case 1: glUniform1iv(loc, n, v); break;
          case 2: glUniform2iv(loc, n, v); break;
          case 3: glUniform3iv(loc, n, v); break;
          default: glUniform4iv(loc, n, v); break;
        }
      } else if (base == ASC_SHADER_BASE_UINT) {
        const GLuint* v = (const GLuint*)f;
        switch (comps) {
          case 1: glUniform1uiv(loc, n, v); break;
          case 2: glUniform2uiv(loc, n, v); break;
          case 3: glUniform3uiv(loc, n, v); break;
          default: glUniform4uiv(loc, n, v); break;
        }
      } else {
        switch (comps) {
          case 1: glUniform1fv(loc, n, f); break;
          case 2: glUniform2fv(loc, n, f); break;
          case 3: glUniform3fv(loc, n, f); break;
          default: glUniform4fv(loc, n, f); break;
        }
      }
    }
  }
}

// Bind the native samplers to their units and give each bound texture the sampler state
// the caller asked for at that (stage, slot). Sampler state lives on the TEXTURE OBJECT
// in GL, so a per-material change has to touch the object -- and it invalidates the AGAL
// path's "already applied" cache for that texture, which is why the cache is dropped.
static void s3d_bind_native_textures(S3DContext* c) {
  int dirty = 0;
  for (int stage = 0; stage < 2; stage++) {
    // S3D_MAX_NATIVE_TEX, not S3D_MAX_TEX: the AGAL path has eight texture registers per
    // stage, a translated GLSL ES 3.00 program may declare sixteen, and the ocean's water
    // program declares ten. Looping to eight left slots 8..15 unbound on their unit -- the
    // displacement cascade then sampled whatever the previous draw left on unit 0, which
    // reads as a perfectly flat (constant) height field rather than as an error.
    for (int slot = 0; slot < S3D_MAX_NATIVE_TEX; slot++) {
      if (!c->nativeTexTable[stage][slot]) continue;   // this program has no sampler here
      int unit = c->nativeUnit[stage][slot];
      if (unit < 0 || unit >= 32) continue;
      glActiveTexture(GL_TEXTURE0 + unit);
      GLuint tex = c->nativeTex[stage][slot];
      if (tex == 0) { glBindTexture(GL_TEXTURE_2D, 0); glBindTexture(GL_TEXTURE_CUBE_MAP, 0); continue; }
      GLenum tgt = s3d_tex_gltarget(c, tex);
      glBindTexture(tgt, tex);
      if (c->nativeSamplerSet[stage][slot]) {
        int f = c->nativeSampler[stage][slot][0];
        int w = c->nativeSampler[stage][slot][1];
        int m = c->nativeSampler[stage][slot][2];
        s3d_set_tex_params(tgt, f, w, m);
        c->texStateN = 0;
        dirty = 1;
      }
    }
  }
  glActiveTexture(GL_TEXTURE0);
  (void)dirty;
}

// A native target set: up to four colour textures plus an optional depth texture, cached
// by identity. Everything is attached as a TEXTURE (not a renderbuffer) because the
// whole point of a native target is that the same object is sampled afterwards.
static S3DNativeTarget* s3d_native_target_create(S3DContext* c, const GLuint* colors, int ncolors, GLuint depth) {
  S3DNativeTarget* t = NULL;
  for (int i = 0; i < S3D_MAX_NATIVE_TARGETS; i++)
    if (!c->nativeTargets[i].used) { t = &c->nativeTargets[i]; break; }
  if (t == NULL) {
    // No free slot: recycle the first. A pass list with more than eight live sets is
    // outside what this channel is used for, and reusing one is visible (a wasted
    // create) rather than silently wrong.
    t = &c->nativeTargets[0];
    if (t->fbo != 0) glDeleteFramebuffers(1, &t->fbo);
  }
  memset(t, 0, sizeof *t);
  t->ncolors = ncolors;
  t->depth = depth;
  for (int i = 0; i < ncolors && i < 4; i++) t->colors[i] = colors[i];
  // Size comes from the registry: WebGL2 has no glGetTexLevelParameteriv (that is ES
  // 3.1), so every texture this file creates records its dimensions at creation.
  int w = 0, h = 0;
  for (int i = 0; i < c->rtTexN; i++) {
    if (ncolors > 0 && c->rtTex[i].id == colors[0]) { w = c->rtTex[i].width; h = c->rtTex[i].height; break; }
    if (ncolors == 0 && depth != 0 && c->rtTex[i].id == depth) { w = c->rtTex[i].width; h = c->rtTex[i].height; break; }
  }
  if (w <= 0 || h <= 0) { w = c->width; h = c->height; }
  t->width = w;
  t->height = h;
  glGenFramebuffers(1, &t->fbo);
  glBindFramebuffer(GL_FRAMEBUFFER, t->fbo);
  GLenum bufs[4] = { GL_COLOR_ATTACHMENT0, GL_COLOR_ATTACHMENT1, GL_COLOR_ATTACHMENT2, GL_COLOR_ATTACHMENT3 };
  for (int i = 0; i < ncolors && i < 4; i++) {
    if (colors[i] != 0) glFramebufferTexture2D(GL_FRAMEBUFFER, (GLenum)(GL_COLOR_ATTACHMENT0 + i), GL_TEXTURE_2D, colors[i], 0);
  }
  if (ncolors > 0) glDrawBuffers(ncolors, bufs);
  else { GLenum none = GL_NONE; glDrawBuffers(1, &none); }
  if (depth != 0) glFramebufferTexture2D(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_TEXTURE_2D, depth, 0);
  GLenum st = glCheckFramebufferStatus(GL_FRAMEBUFFER);
  glBindFramebuffer(GL_FRAMEBUFFER, 0);
  t->used = 1;
  t->complete = (st == GL_FRAMEBUFFER_COMPLETE);
  if (!t->complete) {
    // Reported with the ids so the caller can map them back to its own passes: an
    // incomplete native target is otherwise a silently black picture. The most common
    // cause on WebGL2 is a MRT set whose attachments differ in FORMAT (the spec
    // requires them to match), which no amount of correct shader code fixes.
    fprintf(stderr, "stage3d_webgl: native target FBO incomplete (0x%x) colors=%u,%u,%u,%u depth=%u %dx%d\n",
            (unsigned)st, (unsigned)t->colors[0], (unsigned)t->colors[1], (unsigned)t->colors[2],
            (unsigned)t->colors[3], (unsigned)depth, w, h);
  }
  return t;
}

void s3d_native_set_targets(void* ctx, void** colors, int ncolors, void* depth) {
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  int n = colors != NULL ? ncolors : 0;
  if (n > 4) n = 4;
  if (n < 0) n = 0;
  GLuint col[4] = { 0, 0, 0, 0 };
  for (int i = 0; i < n; i++) col[i] = (GLuint)(uintptr_t)(colors[i]);
  GLuint d = (GLuint)(uintptr_t)depth;
  if (n == 0 && d == 0) { c->nativeTarget = NULL; sk_gr_reset_context(); return; }
  S3DNativeTarget* t = NULL;
  for (int i = 0; i < S3D_MAX_NATIVE_TARGETS; i++) {
    S3DNativeTarget* e = &c->nativeTargets[i];
    if (!e->used || e->ncolors != n || e->depth != d) continue;
    int same = 1;
    for (int k = 0; k < n; k++) if (e->colors[k] != col[k]) { same = 0; break; }
    if (same) { t = e; break; }
  }
  if (t == NULL) t = s3d_native_target_create(c, col, n, d);
  c->nativeTarget = t;
  if (t != NULL) c->nativeNColor = t->ncolors > 0 ? t->ncolors : 1;
  sk_gr_reset_context();
}

void* s3d_create_texture_fmt(void* ctx, int width, int height, int fmtId, int renderable, int mipmapped) {
  if (ctx == NULL || width <= 0 || height <= 0) return NULL;
  S3DContext* c = (S3DContext*)ctx;
  GLint internal = 0;
  GLenum format = 0, type = 0;
  int isDepth = 0;
  if (!s3d_fmt_web(fmtId, &internal, &format, &type, &isDepth)) {
    fprintf(stderr, "stage3d_webgl: createTexture: unsupported format id %d\n", fmtId);
    return NULL;
  }
  GLuint tex = 0;
  glGenTextures(1, &tex);
  glBindTexture(GL_TEXTURE_2D, tex);
  glTexImage2D(GL_TEXTURE_2D, 0, internal, width, height, 0, format, type, NULL);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  // LINEAR even for float formats: OES_texture_float_linear is enabled at context
  // creation for the formats that need it, and a GPU-data pass that wanted NEAREST
  // sets it through setSamplerStateAtStage anyway.
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  if (isDepth) {
    // Sampled as a float (`texture(tDepth, uv).r`), never compared: WebGL2 keeps a depth
    // texture filterable only in this mode, and the ocean's underwater absorption reads
    // it exactly that way. GL does not need the texture to be "incomplete" to be
    // sampleable once the compare mode is off.
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_COMPARE_MODE, GL_NONE);
  }
  (void)renderable;
  s3d_rt_register(c, tex, width, height, fmtId == 4 ? 1 : 0);
  (void)mipmapped;  // the chain is allocated by the first s3d_generate_mips call
  sk_gr_reset_context();
  return (void*)(uintptr_t)tex;
}

void s3d_generate_mips(void* ctx, void* tex) {
  if (ctx == NULL || tex == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  GLuint t = (GLuint)(uintptr_t)tex;
  GLenum tgt = s3d_tex_gltarget(c, t);
  glActiveTexture(GL_TEXTURE0);
  glBindTexture(tgt, t);
  while (glGetError() != 0) { }
  glGenerateMipmap(tgt);
  // A refused chain is invisible at the call site and black at the sample site: a
  // textureLod past level 0 of an unmipmapped texture returns (0,0,0,1), which looks
  // exactly like "my sky shader does nothing". WebGL2 refuses glGenerateMipmap for a
  // format the device cannot filter (a float target without the linear-filter
  // extension), so it is reported rather than left to be debugged as a shader bug.
  {
    GLenum e = glGetError();
    if (e != 0) {
      static int warned = 0;
      if (!warned) {
        fprintf(stderr, "stage3d_webgl: glGenerateMipmap(0x%x) failed on texture %u (0x%x); every LOD>0 sample of it will read black\n",
                (unsigned)e, (unsigned)t, (unsigned)tgt);
        warned = 1;
      }
    }
  }
  // The chain exists now: the AGAL path's "this texture has no mips ⇒ drop the draw"
  // rule (AIR fidelity) has to see that, or a mip-filtered sample of a target that was
  // just generated would be dropped for the rest of the frame.
  for (int i = 0; i < S3D_MAX_TEX; i++) if (c->textures[i] == t) c->texHasMips[i] = 1;
  sk_gr_reset_context();
}

// Per-target multisample level. NOT IMPLEMENTED on this backend yet: WebGL2 can do it
// (multisampled renderbuffers + glBlitFramebuffer resolve) but the resolve has to be
// interleaved with the pass list rather than being a per-texture flag, and a control
// that silently does nothing is worse than one that reports (AGENTS.md §0). Returns 0,
// which the AS3 side reports as "the device refused the level".
int s3d_set_target_samples(void* ctx, void* tex, int samples) {
  (void)tex;
  (void)samples;
  if (ctx == NULL) return 0;
  static int warned = 0;
  if (!warned) {
    fprintf(stderr, "stage3d_webgl: setRenderTargetSamples: per-target MSAA is not implemented on "
                    "WebGL2 yet — the level is refused (reported), edges stay aliased\n");
    warned = 1;
  }
  return 0;
}

#endif  // ASC_USE_NATIVE_SHADER

// ---- render ----------------------------------------------------------------

void s3d_clear(void* ctx, float r, float g, float b, float a, float depth, unsigned int stencil, int maskBits) {
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  c->clearR = r; c->clearG = g; c->clearB = b; c->clearA = a;
  c->clearDepthValue = depth;
  c->clearStencilValue = stencil & 0xFFu;
  // Stage3D's clear() records the color and the NEXT draw applies it: Starling
  // clears once per frame and then issues many drawTriangles, so an immediate
  // glClear would erase every batch already drawn.
  c->clearPending = 1;
  c->clearColorBit = (maskBits & 1) ? 1 : 0;    // Context3DClearMask.COLOR
  c->clearDepthBit = (maskBits & 2) ? 1 : 0;    // DEPTH
  c->clearStencilBit = (maskBits & 4) ? 1 : 0;  // STENCIL
}

void s3d_set_depth(void* ctx, int depthMask, const char* compareMode) {
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  c->depthWrite = depthMask;
  c->depthCompare = compareMode;
}
void s3d_set_cull(void* ctx, const char* face) {
  if (ctx == NULL) return;
  ((S3DContext*)ctx)->cullMode = face;
}
// setColorMask: record the per-channel write mask applied by the next draw
// (mirrors the Metal glue; away3d's DepthRenderer masks all four channels off for
// its depth-only prepass and then restores them).
void s3d_set_color_mask(void* ctx, int r, int g, int b, int a) {
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  c->colorMaskR = r ? 1 : 0;
  c->colorMaskG = g ? 1 : 0;
  c->colorMaskB = b ? 1 : 0;
  c->colorMaskA = a ? 1 : 0;
}
void s3d_set_stencil(void* ctx, const char* face, const char* compare, const char* bothPass, const char* depthFail, const char* dpFail) {
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  c->stencilFace = face;
  c->stencilCompare = compare;
  c->stencilBothPass = bothPass;
  c->stencilDepthFail = depthFail;
  c->stencilDepthPassStencilFail = dpFail;
}
void s3d_set_stencil_ref(void* ctx, unsigned int ref, unsigned int readMask, unsigned int writeMask) {
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  c->stencilRef = ref & 0xFFu;
  // Stage3D's masks default to 8 bits and callers that pass 0 mean "unset".
  unsigned int rm = (readMask != 0) ? (readMask & 0xFFu) : c->stencilReadMask;
  unsigned int wm = (writeMask != 0) ? (writeMask & 0xFFu) : c->stencilWriteMask;
  c->stencilReadMask = rm;
  c->stencilWriteMask = wm;
}
// setSamplerStateAt(unit, wrap, filter, mipfilter): the AS3 side passes enum
// *strings*, which decode to the same ints s3d_set_sampler_state_i takes. Stage3D
// keeps ONE per-unit sampler state, written by both this call and the AGAL `tex`
// flags of the bound program, so "last writer wins" -- which is why the AGAL path
// (s3d_set_sampler_state_i, called from Context3D_setProgram) and this path must
// share the same storage. Mirrors the Metal glue's split exactly.
void s3d_set_sampler_state_i(void* ctx, int unit, int filter, int wrap, int mip) {
  if (ctx == NULL || unit < 0 || unit >= S3D_MAX_TEX) return;
  S3DContext* c = (S3DContext*)ctx;
  if (filter < 0 || filter > 1) filter = 0;
  if (wrap < 0 || wrap > 1) wrap = 0;
  if (mip < 0 || mip > 2) mip = 0;
  c->samplerFilter[unit] = filter;
  c->samplerWrap[unit] = wrap;
  c->samplerMip[unit] = mip;
  c->samplerStateSet[unit] = 1;
}
void s3d_set_sampler_state(void* ctx, int unit, const char* wrap, const char* filter, const char* mipfilter) {
  int f = (filter != NULL && !strcmp(filter, "nearest")) ? 1 : 0;
  int w = (wrap != NULL && !strcmp(wrap, "repeat")) ? 1 : 0;
  int m = 0;
  if (mipfilter != NULL) {
    if (!strcmp(mipfilter, "mipnearest")) m = 1;
    else if (!strcmp(mipfilter, "miplinear")) m = 2;
  }
  s3d_set_sampler_state_i(ctx, unit, f, w, m);
}
void s3d_set_scissor(void* ctx, int on, int x, int y, int w, int h) {
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  c->scissorOn = on;
  c->scissorX = x; c->scissorY = y; c->scissorW = w; c->scissorH = h;
}
void s3d_set_blend(void* ctx, const char* sourceFactor, const char* destFactor) {
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  c->blendSource = sourceFactor;
  c->blendDest = destFactor;
}
void s3d_set_instance_count(void* ctx, int n) {
  if (ctx == NULL) return;
  ((S3DContext*)ctx)->instanceCount = n > 0 ? n : 1;
}

// Upload the staged constant registers into the current program's uniforms.
static void s3d_flush_constants(S3DContext* c) {
  if (c->vcCount > 0) {
    int regs = c->vcCount / 4;
    if (regs > 256) regs = 256;
    for (int i = 0; i < regs; i++) {
      int loc = c->uniVC[i];
      if (loc >= 0) glUniform4fv(loc, 1, &c->vcData[i * 4]);
    }
    c->vcCount = 0;
  }
  if (c->fcCount > 0) {
    int regs = c->fcCount / 4;
    if (regs > 256) regs = 256;
    for (int i = 0; i < regs; i++) {
      int loc = c->uniFC[i];
      if (loc >= 0) glUniform4fv(loc, 1, &c->fcData[i * 4]);
    }
    c->fcCount = 0;
  }
}

// Issue one draw: bind the current program and the recorded state, apply the
// deferred clear, then draw the bound index/vertex streams. One shot per call —
// the AGAL/Stage3D model is clear/draw/present per frame, not a retained scene.
int s3d_draw(void* ctx, int numTriangles) {
  if (ctx == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
  const int dbg = asc_s3d_stats();
  const double t0 = dbg ? asc_dbg_now_ms() : 0.0;
  if (c->prog == 0 || c->numStreams == 0) return 0;
  if (c->ibo == 0) return 0;
  if (numTriangles <= 0) { c->clearPending = 0; return 0; }

  // Which surface this draw lands on. Three cases, in priority order:
  //   native target set (Context3DNative.setRenderTargets) -- the E6 channel renders
  //     into up to four float/half textures and an optional depth texture, so the FBO
  //     is the cached one for that set rather than the AGAL render override;
  //   AGAL render override (setRenderTarget) -- one texture;
  //   the back buffer.
  // An incomplete native set refuses the draw instead of falling through to the back
  // buffer: silently drawing the scene into the visible surface while the caller
  // samples an untouched texture is the exact "plausible wrong picture" this codebase
  // rules out.
  GLuint fbo;
  int tw, th;
  if (c->nativeMode && c->nativeTarget != NULL) {
    if (!c->nativeTarget->complete) {
      if (asc_s3d_dump())
        fprintf(stderr, "S3D native-drop: the active native target set is incomplete (see the create log)\n");
      return 0;
    }
    fbo = c->nativeTarget->fbo;
    tw = c->nativeTarget->width;
    th = c->nativeTarget->height;
  } else if (c->overrideRt != NULL) {
    fbo = c->overrideRt->fbo;
    tw = c->overrideRt->width;
    th = c->overrideRt->height;
  } else {
    fbo = c->fbo;
    tw = c->width;
    th = c->height;
  }
  glBindFramebuffer(GL_FRAMEBUFFER, fbo);
  glViewport(0, 0, tw, th);

  // Deferred clear (only the first draw after clear() clears; the rest accumulate).
  if (c->clearPending) {
    GLbitfield bits = 0;
    if (c->clearColorBit) {
      glClearColor(c->clearR, c->clearG, c->clearB, c->clearA);
      bits |= GL_COLOR_BUFFER_BIT;
    }
    if (c->clearDepthBit) {
      glClearDepthf(c->clearDepthValue);
      bits |= GL_DEPTH_BUFFER_BIT;
    }
    if (c->clearStencilBit) {
      // Starling clears the stencil to Painter.DEFAULT_STENCIL_VALUE (127), not 0:
      // its mask passes compare EQUAL against the incremented reference, so a zero
      // clear would fail the first mask and every masked object would vanish.
      glClearStencil((GLint)c->clearStencilValue);
      bits |= GL_STENCIL_BUFFER_BIT;
    }
    if (bits != 0) {
      // glClear obeys the *write masks*, unlike Metal's loadAction=Clear, while
      // Stage3D sets those masks per draw (setColorMask / depthWrite / stencil
      // write mask). A pass that draws with depthWrite=false leaves
      // GL_DEPTH_WRITEMASK off, so the next frame's deferred depth clear would be
      // silently skipped: the previous frame's near depth then rejects every
      // later draw — the skybox (z ~ 1.0 loses against a stale near depth) leaves
      // the clear colour and the geometry cannot re-draw itself, i.e. a frozen
      // black silhouette that shadows the object wherever it has been. Force the
      // write masks on for the clear; nothing leaks into a draw, because every
      // pass that depends on a mask re-applies its own before drawing (colour
      // mask per draw below, depth and stencil whenever the pass tests them).
      glDepthMask(GL_TRUE);
      glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
      glStencilMask(0xFF);
      glClear(bits);
    }
    c->clearPending = 0;
    c->clearColorBit = c->clearDepthBit = c->clearStencilBit = 0;
  }

  // AIR fidelity: a mip-filtered sampler (miplinear/mipnearest) on a texture
  // that has NO mip chain makes AIR drop the whole draw (temp/sampprobe A6: a
  // level-0-only 2x2 texture read back as the clear colour, while the same
  // texture with <2d,linear,nomip> drew normally). GL has no such rule -- it
  // would treat the texture as INCOMPLETE and sample black, i.e. draw a black
  // quad where AIR draws nothing -- so the drop is enforced here. Placed AFTER
  // the deferred clear so the frame still clears, which is what AIR does.
  if (!c->nativeMode) {
    for (int i = 0; i < S3D_MAX_TEX; i++) {
      if (c->samplerStateSet[i] && c->samplerMip[i] != 0 && c->texHasMips[i] == 0 && c->textures[i] != 0) {
        if (asc_s3d_dump())
          fprintf(stderr, "S3D mip-drop: unit %d asks for mipmaps but the bound texture has no chain (AIR drops the draw)\n", i);
        return 0;
      }
    }
  }

  glUseProgram(c->prog);
  // Two uniform models share this draw. AGAL stages its constants in vc/fc and they are
  // flushed here; a native program gets one uniform at a time through setUniform* into
  // nativeUniform, which is uploaded with the width the reflection reported.
  if (c->nativeMode) s3d_apply_native_uniforms(c);
  else s3d_flush_constants(c);

  // Depth/stencil are only *used* by passes that need them, mirroring the Metal
  // glue: an always-attached D24S8 costs a per-draw load/store of the whole
  // surface, and Starling issues tens of thousands of draws per second.
  int dsNeeded = (c->depthCompare != NULL && strcmp(c->depthCompare, "always") != 0)
              || (c->stencilCompare != NULL && strcmp(c->stencilCompare, "always") != 0)
              || (c->stencilBothPass != NULL && strcmp(c->stencilBothPass, "keep") != 0);
  // A native target set carries its OWN depth attachment (or none). Enabling
  // GL_DEPTH_TEST against an FBO with no depth attachment is a no-op in GL, so the
  // state would claim a test that cannot happen; say so through the dump hook and leave
  // it off, which is also what Metal does with a nil depth texture.
  if (c->nativeMode && c->nativeTarget != NULL && c->nativeTarget->depth == 0) {
    if (asc_s3d_dump() && dsNeeded)
      fprintf(stderr, "S3D native: draw asks for a depth test but the target set has no depth attachment (test off)\n");
    dsNeeded = 0;
  }
  if (dsNeeded) {
    glEnable(GL_DEPTH_TEST);
    glDepthMask(c->depthWrite ? GL_TRUE : GL_FALSE);
    glDepthFunc(s3d_compare(c->depthCompare));
    if (c->stencilCompare != NULL) {
      glEnable(GL_STENCIL_TEST);
      GLenum cmp = s3d_compare(c->stencilCompare);
      GLenum bothPass = s3d_stencil_op(c->stencilBothPass);
      GLenum depthFail = s3d_stencil_op(c->stencilDepthFail);
      GLenum dpFail = s3d_stencil_op(c->stencilDepthPassStencilFail);
      // "frontAndBack" (Starling's masking) drives both faces; the front/back
      // selection mirrors the Metal glue's two-stencil-descriptor handling.
      int useFront = 1, useBack = 1;
      if (c->stencilFace != NULL && !strcmp(c->stencilFace, "front")) useBack = 0;
      else if (c->stencilFace != NULL && !strcmp(c->stencilFace, "back")) useFront = 0;
      if (useFront) {
        glStencilFuncSeparate(GL_FRONT, cmp, (GLint)c->stencilRef, (GLuint)c->stencilReadMask);
        glStencilOpSeparate(GL_FRONT, GL_KEEP, dpFail, bothPass);
      }
      if (useBack) {
        glStencilFuncSeparate(GL_BACK, cmp, (GLint)c->stencilRef, (GLuint)c->stencilReadMask);
        glStencilOpSeparate(GL_BACK, GL_KEEP, dpFail, bothPass);
      }
      glStencilMask((GLuint)c->stencilWriteMask);
    } else {
      glDisable(GL_STENCIL_TEST);
    }
  } else {
    glDisable(GL_DEPTH_TEST);
    glDisable(GL_STENCIL_TEST);
  }

  // Culling. Stage3D's "frontAndBack" is its "do not cull" default (Starling
  // renders with it), NOT GL's cull-everything. Front faces are CCW because the
  // AGAL GLSL vertex stage negates clip-space Y (see the header): Stage3D's front
  // face is CW on Metal, which does not flip.
  //
  // A NATIVE program gets no such help -- it writes gl_Position itself, with no Y
  // negation -- so GL judges the SAME geometry with the opposite winding. The fix is to
  // flip the FRONT-FACE WINDING for native draws rather than to complement the cull mode:
  // complementing the cull mode does put the same triangles on screen, but it leaves
  // gl_FrontFacing inverted, and that is a second, silent difference. Without either fix
  // a FrontSide quad (shader-m30 has exactly that) is culled away -- uniforms and
  // attributes all resolve, glError stays 0, and the screen is the clear colour; with
  // only the cull complement the ocean's surface pass classified every fragment as the
  // UNDERSIDE of the water (49.9% underside / 0.2% top side) for the same reason.
  glFrontFace(c->nativeMode ? GL_CW : GL_CCW);
  {
    const char* cull = c->cullMode;
    if (cull != NULL && !strcmp(cull, "back")) {
      glEnable(GL_CULL_FACE); glCullFace(GL_BACK);
    } else if (cull != NULL && !strcmp(cull, "front")) {
      glEnable(GL_CULL_FACE); glCullFace(GL_FRONT);
    } else {
      glDisable(GL_CULL_FACE);
    }
  }

  // Color write mask (setColorMask): GL keeps it as context state, so an
  // unmasked draw must explicitly restore all four channels (unlike Metal, whose
  // per-draw encoder starts writable).
  glColorMask(c->colorMaskR ? GL_TRUE : GL_FALSE, c->colorMaskG ? GL_TRUE : GL_FALSE,
              c->colorMaskB ? GL_TRUE : GL_FALSE, c->colorMaskA ? GL_TRUE : GL_FALSE);

  // Blending: (NULL, NULL) is Stage3D's initial (ONE, ZERO) — Metal disables
  // blending entirely for it and so does GL. Alpha uses the same factors as RGB,
  // matching the Metal glue's four-factor setup.
  if (c->blendSource != NULL || c->blendDest != NULL) {
    GLenum sf = s3d_blend_factor(c->blendSource);
    GLenum df = s3d_blend_factor(c->blendDest);
    glEnable(GL_BLEND);
    glBlendFuncSeparate(sf, df, sf, df);
  } else {
    glDisable(GL_BLEND);
  }

  // Scissor (setScissorRectangle; Starling uses it for rectangular masks and
  // TextField viewports). Stage3D rects are DEVICE pixels from the top-left, GL
  // scissor boxes are from the bottom-left, so y is mirrored; the rect is then
  // clamped into the target (GL drops a rect outside the attachment).
  if (c->scissorOn) {
    int x = c->scissorX, y = c->scissorY, w = c->scissorW, h = c->scissorH;
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x > tw) x = tw;
    if (y > th) y = th;
    if (w < 0) w = 0;
    if (h < 0) h = 0;
    if (x + w > tw) w = tw - x;
    if (y + h > th) h = th - y;
    glEnable(GL_SCISSOR_TEST);
    glScissor(x, th - (y + h), w, h);
  } else {
    glDisable(GL_SCISSOR_TEST);
  }

  // Vertex streams -> attributes 0..7 (bound by name in s3d_compile). This is the same
  // rule for a native program: the author signs the contract by declaring
  // `layout(location = N) in ...`, so stream N feeds attribute N.
  glBindVertexArray(c->vao);
  for (int i = 0; i < S3D_MAX_ATTR; i++) {
    if (c->vbo[i] != 0 && c->components[i] > 0) {
      glBindBuffer(GL_ARRAY_BUFFER, c->vbo[i]);
      glEnableVertexAttribArray(i);
      glVertexAttribPointer(i, c->components[i], GL_FLOAT, GL_FALSE, 0, 0);
    } else {
      glDisableVertexAttribArray(i);
    }
  }
  if (c->nativeMode) {
    // Native samplers: named ones, at their own units (fragment 0..7 / vertex 8..15),
    // with the state setSamplerStateAtStage recorded for that (stage, slot).
    s3d_bind_native_textures(c);
  } else {
    // Fragment samplers fs0..fs7 -> texture units 0..7 (wired at link time), with
    // each unit's recorded sampler state applied to its texture object. The bind
    // target must match what the texture was created as (a cube map on
    // GL_TEXTURE_2D is GL_INVALID_OPERATION and samples black); an empty unit
    // clears BOTH targets, since a leftover cube binding would otherwise be what a
    // samplerCube samples.
    for (int i = 0; i < S3D_MAX_TEX; i++) {
      glActiveTexture(GL_TEXTURE0 + i);
      if (c->textures[i] != 0) {
        GLenum tgt = s3d_tex_gltarget(c, c->textures[i]);
        glBindTexture(tgt, c->textures[i]);
        s3d_apply_sampler(c, c->textures[i], i);
      } else {
        glBindTexture(GL_TEXTURE_2D, 0);
        glBindTexture(GL_TEXTURE_CUBE_MAP, 0);
      }
    }
    glActiveTexture(GL_TEXTURE0);
  }
  glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, c->ibo);

  if (c->instanceCount > 1) {
    glDrawElementsInstanced(GL_TRIANGLES, numTriangles * 3, GL_UNSIGNED_INT, 0, c->instanceCount);
  } else {
    glDrawElements(GL_TRIANGLES, numTriangles * 3, GL_UNSIGNED_INT, 0);
  }

  glBindVertexArray(0);
  glBindBuffer(GL_ARRAY_BUFFER, 0);
  glBindBuffer(GL_ELEMENT_ARRAY_BUFFER, 0);
  glBindFramebuffer(GL_FRAMEBUFFER, 0);

  if (dbg) {
    static double acc = 0, accTri = 0;
    static long n = 0, tot = 0;
    static double tFirst = 0;
    double t1 = asc_dbg_now_ms();
    if (tFirst == 0.0) tFirst = t0;
    acc += (t1 - t0);
    accTri += numTriangles;
    n++; tot++;
    if (n % 240 == 0) {
      double elapsed = (t1 - tFirst) / 1000.0;
      fprintf(stderr, "s3d_stats(web) t=%.1fs draws=%ld draws/s=%.1f tri/draw=%.0f cpu=%.3fms per-draw\n",
              elapsed, tot, elapsed > 0 ? (double)tot / elapsed : 0.0, accTri / (double)n, acc / (double)n);
      fflush(stderr);
      acc = accTri = 0; n = 0;
    }
  }
  // Raw GL leaves Ganesh's cached state stale; mark it (a bit set — the real
  // re-sync happens on Ganesh's next operation).
  sk_gr_reset_context();
  return 1;
}

// ---- readback --------------------------------------------------------------

// Read the current render target into a tightly packed BGRA8 buffer
// (width*height*4), which is what ASC_window_render composites with
// as_skia_canvas_draw_bgra. GL returns RGBA rows bottom-up, but because the GLSL
// vertex stage negates clip-space Y the stored image is already top-down, so only
// the channel order needs a swap.
// IEEE 754 binary16 -> float. Spelled out so the conversion is identical across
// toolchains (denormals, Inf, NaN included).
static float s3d_half_to_float(uint16_t h) {
  const int sign = (h >> 15) & 1;
  const int exp = (h >> 10) & 0x1F;
  const int man = h & 0x3FF;
  float v;
  if (exp == 0) v = (float)man / 1024.0f * ldexpf(1.0f, -14);
  else if (exp == 31) v = (man == 0) ? INFINITY : NAN;
  else v = (1.0f + (float)man / 1024.0f) * ldexpf(1.0f, exp - 15);
  return sign ? -v : v;
}

static int s3d_readback_target(S3DContext* c, GLuint fbo, int w, int h, uint8_t* out) {
  if (out == NULL || w <= 0 || h <= 0) return 0;
  int n = w * h;
  uint8_t* rgba = s3d_scratch(c, n * 4);
  if (rgba == NULL) return 0;
  glBindFramebuffer(GL_FRAMEBUFFER, fbo);
  glReadPixels(0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, rgba);
  glBindFramebuffer(GL_FRAMEBUFFER, 0);
  s3d_rgba_to_bgra(rgba, out, n);
  sk_gr_reset_context();
  return 1;
}

int s3d_readback(void* ctx, uint8_t* out) {
  if (ctx == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
  return s3d_readback_target(c, c->fbo, c->width, c->height, out);
}

// Narrow an RGBA16F framebuffer to the caller's BGRA8 contract
// (Context3D.drawToBitmapData), clamping to [0,1]: an 8-bit surface cannot hold an
// HDR value, and AIR clamps on the same path.
static int s3d_readback_half(S3DContext* c, S3DRt* rt, uint8_t* out) {
  const int n = rt->width * rt->height;
  uint16_t* tmp = (uint16_t*)malloc((size_t)n * 4 * sizeof(uint16_t));
  if (tmp == NULL) return 0;
  glBindFramebuffer(GL_FRAMEBUFFER, rt->fbo);
  glReadPixels(0, 0, rt->width, rt->height, GL_RGBA, GL_HALF_FLOAT, tmp);
  glBindFramebuffer(GL_FRAMEBUFFER, 0);
  for (int i = 0; i < n; i++) {
    float ch[4];
    for (int k = 0; k < 4; k++) {
      float v = s3d_half_to_float(tmp[i * 4 + k]);
      if (!(v == v)) v = 0.0f;              // NaN
      if (v < 0.0f) v = 0.0f;
      if (v > 1.0f) v = 1.0f;
      ch[k] = v;
    }
    out[i * 4 + 0] = (uint8_t)(ch[2] * 255.0f + 0.5f);  // B
    out[i * 4 + 1] = (uint8_t)(ch[1] * 255.0f + 0.5f);  // G
    out[i * 4 + 2] = (uint8_t)(ch[0] * 255.0f + 0.5f);  // R
    out[i * 4 + 3] = (uint8_t)(ch[3] * 255.0f + 0.5f);  // A
  }
  free(tmp);
  sk_gr_reset_context();
  return 1;
}

int s3d_readback_render(void* ctx, uint8_t* out) {
  if (ctx == NULL || out == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
  if (c->overrideRt != NULL) {
    if (c->overrideRt->isHalf) return s3d_readback_half(c, c->overrideRt, out);
    return s3d_readback_target(c, c->overrideRt->fbo, c->overrideRt->width, c->overrideRt->height, out);
  }
  return s3d_readback_target(c, c->fbo, c->width, c->height, out);
}

// The Metal glue batches a frame's draws into one MTLCommandBuffer and commits it
// from the flush entry points (see stage3d_glue.mm), which come in a
// commit+wait flavour (s3d_flush, before a CPU readback) and a commit-only one
// (s3d_flush_async, the frame boundary); reusing the target's contents across
// draws is free there because a render pass keeps them in tile memory.
//
// GL has no such batch to retire: glDrawElements only appends to the command
// stream, which the driver submits on its own, and every point that observes the
// target (glReadPixels in the readback path, GrDirectContext::flushAndSubmit for
// the on-screen composite) already synchronizes. So these exist to keep the extern "C" s3d_* ABI
// identical across the two backends — the generated C calls them unconditionally
// — and do the cheapest honest thing: submit the queue without waiting. The two
// flavours therefore coincide here.
void s3d_flush(void* ctx) {
  (void)ctx;
  glFlush();
}
void s3d_flush_async(void* ctx) {
  (void)ctx;
  glFlush();
}
void s3d_flush_all(void) {
  glFlush();
}
void s3d_flush_all_async(void) {
  glFlush();
}

}  // extern "C"

#else  // !__EMSCRIPTEN__

// The web Stage3D backend is only built for the wasm target (build manifests add
// this file alongside ASC_S3D_GLSL). An empty translation unit keeps a stray
// native compile from failing on the missing GLES3 headers.
static int asc_stage3d_webgl_native_stub = 0;

#endif  // __EMSCRIPTEN__