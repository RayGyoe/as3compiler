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

#ifdef __EMSCRIPTEN__

#include <emscripten.h>
#include <emscripten/html5.h>
#include <GLES3/gl3.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>

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
};

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
  S3DRtTex rtTex[32];
  int rtTexN;
  // Scratch buffer for pixel upload/readback conversions (BGRA <-> RGBA), grown
  // on demand and reused: a per-frame malloc of 8+ MB would shred the wasm heap.
  uint8_t* scratch;
  int scratchBytes;
  // VAO for the attribute setup; the element-buffer binding is VAO state in GLES3.
  GLuint vao;
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
    if (c->overrideRt != NULL && c->overrideRt->color == t) c->overrideRt = NULL;
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
  c->uniVC[0] = -1;  // memset already zeroed; -1 marks "not linked yet"
  for (int i = 0; i < 256; i++) { c->uniVC[i] = -1; c->uniFC[i] = -1; }
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
  // c->textures[] and overrideRt->color are BORROWED (owned by Texture->gpu).
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
void* s3d_create_render_texture(void* ctx, int width, int height) {
  if (ctx == NULL || width <= 0 || height <= 0) return NULL;
  S3DContext* c = (S3DContext*)ctx;
  GLuint tex = 0;
  glGenTextures(1, &tex);
  glBindTexture(GL_TEXTURE_2D, tex);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, width, height, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  if (c->rtTexN < 32) {
    c->rtTex[c->rtTexN].id = tex;
    c->rtTex[c->rtTexN].width = width;
    c->rtTex[c->rtTexN].height = height;
    c->rtTexN++;
  }
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
  int w = 0, h = 0;
  for (int i = 0; i < c->rtTexN; i++) {
    if (c->rtTex[i].id == t) { w = c->rtTex[i].width; h = c->rtTex[i].height; break; }
  }
  if (w <= 0 || h <= 0) return;
  c->overrideRt = s3d_rt_for(c, t, w, h);
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

  GLuint fbo = (c->overrideRt != NULL) ? c->overrideRt->fbo : c->fbo;
  int tw = (c->overrideRt != NULL) ? c->overrideRt->width : c->width;
  int th = (c->overrideRt != NULL) ? c->overrideRt->height : c->height;
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
  for (int i = 0; i < S3D_MAX_TEX; i++) {
    if (c->samplerStateSet[i] && c->samplerMip[i] != 0 && c->texHasMips[i] == 0 && c->textures[i] != 0) {
      if (asc_s3d_dump())
        fprintf(stderr, "S3D mip-drop: unit %d asks for mipmaps but the bound texture has no chain (AIR drops the draw)\n", i);
      return 0;
    }
  }

  glUseProgram(c->prog);
  s3d_flush_constants(c);

  // Depth/stencil are only *used* by passes that need them, mirroring the Metal
  // glue: an always-attached D24S8 costs a per-draw load/store of the whole
  // surface, and Starling issues tens of thousands of draws per second.
  int dsNeeded = (c->depthCompare != NULL && strcmp(c->depthCompare, "always") != 0)
              || (c->stencilCompare != NULL && strcmp(c->stencilCompare, "always") != 0)
              || (c->stencilBothPass != NULL && strcmp(c->stencilBothPass, "keep") != 0);
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
  // GLSL vertex stage negates clip-space Y (see the header): Stage3D's front face
  // is CW on Metal, which does not flip.
  if (c->cullMode != NULL && !strcmp(c->cullMode, "back")) {
    glEnable(GL_CULL_FACE); glCullFace(GL_BACK);
  } else if (c->cullMode != NULL && !strcmp(c->cullMode, "front")) {
    glEnable(GL_CULL_FACE); glCullFace(GL_FRONT);
  } else {
    glDisable(GL_CULL_FACE);
  }
  glFrontFace(GL_CCW);

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

  // Vertex streams -> attributes 0..7 (bound by name in s3d_compile).
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

int s3d_readback_render(void* ctx, uint8_t* out) {
  if (ctx == NULL || out == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
  if (c->overrideRt != NULL)
    return s3d_readback_target(c, c->overrideRt->fbo, c->overrideRt->width, c->overrideRt->height, out);
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