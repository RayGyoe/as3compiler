// stage3d_glue.mm — the Objective-C++ -> C bridge for Stage3D's raw Metal
// pipeline (flash.display3D). Unlike metal_glue.mm (which wraps Skia's Ganesh
// backend for the 2D display list), this file owns the *programmable* GPU
// triangle pipeline: MTLBuffer vertex/index buffers, MTLTexture 2D textures,
// MTLLibrary (MSL compiled from AGAL bytecode), MTLRenderPipelineDescriptor +
// MTLDepthStencilState, and a MTLRenderPassDescriptor that renders into an
// offscreen MTLTexture so pixels can be read back (drawToBitmapData / tests).
//
// It is deliberately self-contained and offscreen-first: it creates its own
// MTLDevice + MTLCommandQueue, renders into an offscreen render target, and
// exposes a flat extern "C" API for the generated C to call. Compositing that
// render target with Skia's 2D surface into a single CAMetalLayer drawable is
// the stage 82 P2 follow-up (shared device/queue); the offscreen path here is
// the testable core that stage 82's acceptance ("assert the triangle's pixels")
// and stage 83's drawToBitmapData both build on.

#import <Metal/Metal.h>
#include <cstdio>
#include <cstdint>
#include <cstring>

extern "C" {

// ---- opaque context ----
// One context owns a device, queue, offscreen render target, the current
// pipeline, and the bound resources. The generated C holds an opaque `void*`
// (never dereferenced) and passes it back on every call.
struct S3DContext;

// Vertex stream layout: each setVertexBufferAt(i, buffer, offset, format)
// becomes one attribute i fed from MTLBuffer index i. `components` is 1..4
// (FLOAT_1..FLOAT_4); Metal fills the missing .zw components with 0 and .w with
// 1, matching AGAL's float4 register semantics.
struct S3DStream {
  id<MTLBuffer> buffer;
  int components;   // 1..4
  int numVertices;
};

struct S3DContext {
  id<MTLDevice> device;
  id<MTLCommandQueue> queue;
  id<MTLTexture> target;          // offscreen render target (BGRA8Unorm)
  id<MTLTexture> renderOverride;  // render-to-texture target (nil = back buffer)
  int width, height;
  // current pipeline
  id<MTLRenderPipelineState> pso;
  // bound resources
  S3DStream streams[8];
  int numStreams;
  id<MTLBuffer> indexBuffer;
  int numIndices;
  id<MTLBuffer> vc;               // vertex constants (float4 array)
  id<MTLBuffer> fc;               // fragment constants (float4 array)
  id<MTLTexture> textures[8];     // fragment samplers fs0..fs7
  // clear color / blend
  float clearR, clearG, clearB, clearA;
  const char* blendSource;   // AS3 blend-factor name (e.g. "one"), NULL = off
  const char* blendDest;     // AS3 blend-factor name (e.g. "oneMinusSourceAlpha")
  int instanceCount;               // 1 unless drawTrianglesInstanced set it
};

// ---- lifecycle ----

void* s3d_create(int width, int height) {
  id<MTLDevice> device = MTLCreateSystemDefaultDevice();
  if (device == nil) { fprintf(stderr, "stage3d_glue: no Metal device\n"); return NULL; }
  S3DContext* c = new S3DContext();
  c->device = device;
  c->queue = [device newCommandQueue];
  c->width = width > 0 ? width : 1;
  c->height = height > 0 ? height : 1;
  c->target = nil;
  c->renderOverride = nil;
  c->pso = nil;
  c->numStreams = 0;
  c->indexBuffer = nil;
  c->numIndices = 0;
  c->vc = nil;
  c->fc = nil;
  for (int i = 0; i < 8; i++) { c->streams[i].buffer = nil; c->streams[i].components = 0; c->streams[i].numVertices = 0; c->textures[i] = nil; }
  c->clearR = c->clearG = c->clearB = 0.0f; c->clearA = 1.0f;
  c->blendSource = NULL;
  c->blendDest = NULL;
  c->instanceCount = 1;
  // Offscreen render target (BGRA8Unorm, the same format as CAMetalLayer so the
  // eventual compositing step is a straight blit). ShaderRead usage is required
  // by drawToBitmapData's readback and by render-to-texture (stage 83).
  MTLTextureDescriptor* td = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
      width:c->width height:c->height mipmapped:NO];
  td.usage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead;
  // Shared storage (not the private default): the offscreen target is read back
  // to the CPU every frame (s3d_readback_render). A private-storage texture makes
  // getBytes do an internal GPU->CPU blit each call, allocating one blit command
  // buffer + blit context per frame that the driver never returns to the pool —
  // the residual shmup leak (AGXG14XFamilyBlitContext × 1/frame). Shared storage
  // (unified memory on Apple Silicon) makes getBytes a direct memcpy, no blit.
  td.storageMode = MTLStorageModeShared;
  c->target = [device newTextureWithDescriptor:td];
  if (c->target == nil) { fprintf(stderr, "stage3d_glue: failed to create render target\n"); delete c; return NULL; }
  return (void*)c;
}

void s3d_destroy(void* ctx) {
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  // MRC: release every retained resource the context owns. device/queue/target
  // and the vertex/index/constant buffers are +1 (from create/init and uploads).
  // c->textures[i] and c->renderOverride are BORROWED references (their +1 is
  // owned by the Texture->gpu handle and released by s3d_destroy_texture), so do
  // NOT release them here — that would double-free.
  for (int i = 0; i < 8; i++) {
    if (c->streams[i].buffer != nil) [c->streams[i].buffer release];
  }
  if (c->indexBuffer != nil) [c->indexBuffer release];
  if (c->vc != nil) [c->vc release];
  if (c->fc != nil) [c->fc release];
  if (c->pso != nil) [c->pso release];
  if (c->target != nil) [c->target release];
  if (c->queue != nil) [c->queue release];
  if (c->device != nil) [c->device release];
  delete c;
}

// Resize the offscreen render target (drawToBitmapData + window resize path).
int s3d_resize(void* ctx, int width, int height) {
  if (ctx == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
  if (width <= 0 || height <= 0) return 0;
  if (width == c->width && height == c->height) return 1;
  c->width = width; c->height = height;
  MTLTextureDescriptor* td = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
      width:c->width height:c->height mipmapped:NO];
  td.usage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead;
  td.storageMode = MTLStorageModeShared;
  if (c->target != nil) [c->target release];
  c->target = [c->device newTextureWithDescriptor:td];
  return c->target != nil ? 1 : 0;
}

// ---- buffers ----

// Upload a vertex stream. `data` is `numVertices * components` doubles (AS3
// Vector.<Number> holds doubles); converted to float32 on the Metal side. `stream`
// is the attribute index (0..7). Returns 1 on success.
int s3d_upload_vertex(void* ctx, int stream, const double* data, int numVertices, int components) {
  if (ctx == NULL || stream < 0 || stream > 7) return 0;
  S3DContext* c = (S3DContext*)ctx;
  if (components < 1 || components > 4 || numVertices <= 0) return 0;
  size_t n = (size_t)numVertices * (size_t)components;
  float* tmp = (float*)malloc(n * sizeof(float));
  for (size_t i = 0; i < n; i++) tmp[i] = (float)data[i];
  // MRC: release the previous frame's buffer before overwriting the pointer,
  // otherwise every upload leaks one full vertex buffer (this ran every frame).
  if (c->streams[stream].buffer != nil) [c->streams[stream].buffer release];
  c->streams[stream].buffer = [c->device newBufferWithBytes:tmp length:n * sizeof(float) options:0];
  free(tmp);
  c->streams[stream].components = components;
  c->streams[stream].numVertices = numVertices;
  if (stream + 1 > c->numStreams) c->numStreams = stream + 1;
  return c->streams[stream].buffer != nil ? 1 : 0;
}

// Upload the index buffer (uint32 indices).
int s3d_upload_index(void* ctx, const uint32_t* data, int numIndices) {
  if (ctx == NULL || numIndices <= 0) return 0;
  S3DContext* c = (S3DContext*)ctx;
  if (c->indexBuffer != nil) [c->indexBuffer release];
  c->indexBuffer = [c->device newBufferWithBytes:data length:(size_t)numIndices * sizeof(uint32_t) options:0];
  c->numIndices = numIndices;
  return c->indexBuffer != nil ? 1 : 0;
}

// Upload float4 constants: `isFragment ? fc : vc`, `count` doubles total (AS3
// Vector.<Number>); converted to float32 here.
int s3d_upload_constants(void* ctx, int isFragment, const double* data, int count) {
  if (ctx == NULL || count <= 0) return 0;
  S3DContext* c = (S3DContext*)ctx;
  id<MTLBuffer>* slot = isFragment ? &c->fc : &c->vc;
  float* tmp = (float*)malloc((size_t)count * sizeof(float));
  for (int i = 0; i < count; i++) tmp[i] = (float)data[i];
  if (*slot != nil) [*slot release];
  *slot = [c->device newBufferWithBytes:tmp length:(size_t)count * sizeof(float) options:0];
  free(tmp);
  return *slot != nil ? 1 : 0;
}

// Upload a 2D texture. AS3 BitmapData stores ARGB (0xAARRGGBB) in its `pixels`
// buffer; `argb` is that buffer (width*height uint32) and this converts each
// pixel to BGRA byte order for the MTLPixelFormatBGRA8Unorm target.
//
// Returns the MTLTexture handle (owned +1 by the caller, released via
// s3d_destroy_texture) so the caller can cache it and bind on later frames
// instead of re-uploading the same sprite sheet every frame. The context keeps
// only a borrowed reference in c->textures[unit] for drawing.
void* s3d_upload_texture(void* ctx, int unit, int width, int height, const uint32_t* argb) {
  if (ctx == NULL || unit < 0 || unit > 7 || width <= 0 || height <= 0) return NULL;
  S3DContext* c = (S3DContext*)ctx;
  MTLTextureDescriptor* td = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
      width:width height:height mipmapped:NO];
  td.usage = MTLTextureUsageShaderRead;
  id<MTLTexture> tex = [c->device newTextureWithDescriptor:td];
  if (tex == nil) return NULL;
  size_t n = (size_t)width * (size_t)height;
  uint8_t* bgra = (uint8_t*)malloc(n * 4);
  for (size_t i = 0; i < n; i++) {
    uint32_t p = argb[i];
    bgra[i * 4 + 0] = (uint8_t)(p & 0xFF);         // B
    bgra[i * 4 + 1] = (uint8_t)((p >> 8) & 0xFF);  // G
    bgra[i * 4 + 2] = (uint8_t)((p >> 16) & 0xFF); // R
    bgra[i * 4 + 3] = (uint8_t)((p >> 24) & 0xFF); // A
  }
  [tex replaceRegion:MTLRegionMake2D(0, 0, width, height) mipmapLevel:0
      withBytes:bgra bytesPerRow:width * 4];
  free(bgra);
  c->textures[unit] = tex;  // borrowed; caller owns the +1
  return (void*)tex;
}

// ---- program ----

// Vertex streams bind at MTLBuffer indices STREAM_BASE..STREAM_BASE+7. Buffer
// index 0 is reserved for the vertex-constant array (vc, `[[buffer(0)]]` in the
// generated MSL); Metal's `[[attribute(i)]]` resolves its buffer through the
// vertex descriptor's `bufferIndex`, so attribute i reads buffer STREAM_BASE+i
// without colliding with the constants. This mirrors the demo shaders that read
// va0/va1 while also using vc0..vc3.
#define S3D_STREAM_BASE 8

// Map an AGAL vertex-buffer component count to a Metal vertex format. Metal
// fetches 1/2/3 floats and expands the float4 register with (0,0,1) padding,
// which is exactly how AGAL's vaN float4 is defined.
static MTLVertexFormat s3d_vformat(int components) {
  switch (components) {
    case 1: return MTLVertexFormatFloat;
    case 2: return MTLVertexFormatFloat2;
    case 3: return MTLVertexFormatFloat3;
    case 4: return MTLVertexFormatFloat4;
    default: return MTLVertexFormatFloat4;
  }
}

// Map an AS3 Context3DBlendFactor name (the constClass string value, e.g.
// "one" / "oneMinusSourceAlpha") to the Metal blend factor. Unknown/NULL falls
// back to ONE so the common premultiplied (ONE, ONE_MINUS_SOURCE_ALPHA) path is
// the safe default.
static MTLBlendFactor s3d_blend_factor(const char* name) {
  if (name == NULL) return MTLBlendFactorOne;
  if (strcmp(name, "zero") == 0) return MTLBlendFactorZero;
  if (strcmp(name, "one") == 0) return MTLBlendFactorOne;
  if (strcmp(name, "sourceColor") == 0) return MTLBlendFactorSourceColor;
  if (strcmp(name, "oneMinusSourceColor") == 0) return MTLBlendFactorOneMinusSourceColor;
  if (strcmp(name, "sourceAlpha") == 0) return MTLBlendFactorSourceAlpha;
  if (strcmp(name, "oneMinusSourceAlpha") == 0) return MTLBlendFactorOneMinusSourceAlpha;
  if (strcmp(name, "destinationColor") == 0) return MTLBlendFactorDestinationColor;
  if (strcmp(name, "oneMinusDestinationColor") == 0) return MTLBlendFactorOneMinusDestinationColor;
  if (strcmp(name, "destinationAlpha") == 0) return MTLBlendFactorDestinationAlpha;
  if (strcmp(name, "oneMinusDestinationAlpha") == 0) return MTLBlendFactorOneMinusDestinationAlpha;
  return MTLBlendFactorOne;
}

// Compile vertex + fragment MSL into a render pipeline and bind it. `numAttr`
// is how many vertex streams (attributes) the vertex shader reads; the vertex
// descriptor maps attribute i -> MTLBuffer index i with the stream's format.
// Returns 1 on success, 0 on failure (errbuf receives a truncated message).
int s3d_compile(void* ctx, const char* vs_msl, const char* fs_msl, char* errbuf, int errbuf_size) {
  if (ctx == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
  NSError* err = nil;
  id<MTLLibrary> vlib = [c->device newLibraryWithSource:[NSString stringWithUTF8String:vs_msl] options:nil error:&err];
  if (vlib == nil) {
    fprintf(stderr, "stage3d_glue: MSL(vertex) compile failed: %s\n", [[err localizedDescription] UTF8String]);
    if (errbuf && errbuf_size > 0) snprintf(errbuf, errbuf_size, "MSL(vertex): %s", [[err localizedDescription] UTF8String]);
    return 0;
  }
  id<MTLFunction> vfn = [vlib newFunctionWithName:@"vs_main"];
  if (vfn == nil) { if (errbuf && errbuf_size > 0) snprintf(errbuf, errbuf_size, "MSL: no vs_main"); return 0; }

  id<MTLLibrary> flib = [c->device newLibraryWithSource:[NSString stringWithUTF8String:fs_msl] options:nil error:&err];
  if (flib == nil) {
    fprintf(stderr, "stage3d_glue: MSL(fragment) compile failed: %s\n", [[err localizedDescription] UTF8String]);
    if (errbuf && errbuf_size > 0) snprintf(errbuf, errbuf_size, "MSL(fragment): %s", [[err localizedDescription] UTF8String]);
    return 0;
  }
  id<MTLFunction> ffn = [flib newFunctionWithName:@"fs_main"];
  if (ffn == nil) { if (errbuf && errbuf_size > 0) snprintf(errbuf, errbuf_size, "MSL: no fs_main"); return 0; }

  MTLRenderPipelineDescriptor* pd = [[MTLRenderPipelineDescriptor alloc] init];
  pd.vertexFunction = vfn;
  pd.fragmentFunction = ffn;
  pd.colorAttachments[0].pixelFormat = MTLPixelFormatBGRA8Unorm;
  // Blending defaults to off; setBlendFactors turns it on (see below).
  pd.colorAttachments[0].blendingEnabled = NO;
  if (c->blendSource != NULL || c->blendDest != NULL) {
    MTLBlendFactor sf = s3d_blend_factor(c->blendSource);
    MTLBlendFactor df = s3d_blend_factor(c->blendDest);
    pd.colorAttachments[0].blendingEnabled = YES;
    pd.colorAttachments[0].sourceRGBBlendFactor = sf;
    pd.colorAttachments[0].destinationRGBBlendFactor = df;
    pd.colorAttachments[0].sourceAlphaBlendFactor = sf;
    pd.colorAttachments[0].destinationAlphaBlendFactor = df;
    pd.colorAttachments[0].rgbBlendOperation = MTLBlendOperationAdd;
    pd.colorAttachments[0].alphaBlendOperation = MTLBlendOperationAdd;
  }

  // Vertex descriptor: one layout per stream, stride = components * 4 bytes.
  MTLVertexDescriptor* vd = [MTLVertexDescriptor vertexDescriptor];
  int attrCount = 0;
  for (int i = 0; i < c->numStreams && i < 8; i++) {
    if (c->streams[i].components <= 0) continue;
    int bi = S3D_STREAM_BASE + i;
    vd.attributes[i].format = s3d_vformat(c->streams[i].components);
    vd.attributes[i].offset = 0;
    vd.attributes[i].bufferIndex = bi;
    vd.layouts[bi].stride = c->streams[i].components * sizeof(float);
    vd.layouts[bi].stepFunction = MTLVertexStepFunctionPerVertex;
    vd.layouts[bi].stepRate = 1;
    attrCount++;
  }
  pd.vertexDescriptor = vd;

  c->pso = [c->device newRenderPipelineStateWithDescriptor:pd error:&err];
  if (c->pso == nil) {
    fprintf(stderr, "stage3d_glue: pipeline create failed: %s\n", [[err localizedDescription] UTF8String]);
    if (errbuf && errbuf_size > 0) snprintf(errbuf, errbuf_size, "pipeline: %s", [[err localizedDescription] UTF8String]);
    return 0;
  }
  // MRC: the pipeline descriptor, vertex/fragment functions and libraries are
  // all +1 and no longer needed once the pipeline state is built — release them
  // so each recompile (and program swap) does not leak them.
  [pd release];
  [vfn release];
  [ffn release];
  [vlib release];
  [flib release];
  fprintf(stderr, "stage3d_glue: shader pipeline compiled OK\n");
  return 1;
}

// ---- render ----

void s3d_clear(void* ctx, float r, float g, float b, float a) {
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  c->clearR = r; c->clearG = g; c->clearB = b; c->clearA = a;
}

void s3d_set_blend(void* ctx, const char* sourceFactor, const char* destFactor) {
  if (ctx == NULL) return;
  S3DContext* c = (S3DContext*)ctx;
  c->blendSource = sourceFactor;
  c->blendDest = destFactor;
}

// Instance count for the next draw (drawTrianglesInstanced). 0 clamps to 1.
void s3d_set_instance_count(void* ctx, int n) {
  if (ctx == NULL) return;
  ((S3DContext*)ctx)->instanceCount = n > 0 ? n : 1;
}

// Encode + submit one draw: clear to the stored color, draw the bound
// index/vertex streams with the bound pipeline, commit, and wait (so the caller
// can immediately read back). This is a one-shot frame — the AGAL/Stage3D model
// is clear/draw/present per frame, not a persistent retained-mode scene.
int s3d_draw(void* ctx, int numTriangles) {
  if (ctx == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
  if (c->pso == nil || c->numStreams == 0) return 0;
  static int first = 1;
  if (first) { fprintf(stderr, "stage3d_glue: first draw numTriangles=%d numStreams=%d\n", numTriangles, c->numStreams); first = 0; }

  // The command buffer / render pass descriptor / render encoder returned by
  // these factory methods are autoreleased (not +1). The C++ SDL main loop has
  // no autorelease pool, so without an explicit @autoreleasepool they would
  // accumulate for the whole run (the air-native slow leak). Drain per frame.
  @autoreleasepool {
  id<MTLCommandBuffer> cb = [c->queue commandBuffer];
  MTLRenderPassDescriptor* rp = [MTLRenderPassDescriptor renderPassDescriptor];
  rp.colorAttachments[0].texture = c->renderOverride != nil ? c->renderOverride : c->target;
  rp.colorAttachments[0].loadAction = MTLLoadActionClear;
  rp.colorAttachments[0].clearColor = MTLClearColorMake((double)c->clearR, (double)c->clearG, (double)c->clearB, (double)c->clearA);
  rp.colorAttachments[0].storeAction = MTLStoreActionStore;

  id<MTLRenderCommandEncoder> enc = [cb renderCommandEncoderWithDescriptor:rp];
  [enc setRenderPipelineState:c->pso];
  if (c->vc != nil) [enc setVertexBuffer:c->vc offset:0 atIndex:0];
  if (c->fc != nil) [enc setFragmentBuffer:c->fc offset:0 atIndex:0];
  // Vertex streams: attribute i reads MTLBuffer S3D_STREAM_BASE+i (buffer 0 is
  // the vertex-constant array vc).
  for (int i = 0; i < c->numStreams && i < 8; i++) {
    if (c->streams[i].buffer != nil) [enc setVertexBuffer:c->streams[i].buffer offset:0 atIndex:(S3D_STREAM_BASE + i)];
  }
  // Fragment textures fs0..fs7 -> texture(0..7) + a single shared sampler.
  for (int i = 0; i < 8; i++) {
    if (c->textures[i] != nil) [enc setFragmentTexture:c->textures[i] atIndex:i];
  }

  if (c->indexBuffer != nil) {
    [enc drawIndexedPrimitives:MTLPrimitiveTypeTriangle indexCount:numTriangles * 3
        indexType:MTLIndexTypeUInt32 indexBuffer:c->indexBuffer indexBufferOffset:0
        instanceCount:c->instanceCount];
  } else {
    int vcount = 0;
    for (int i = 0; i < c->numStreams && i < 8; i++) if (c->streams[i].numVertices > vcount) vcount = c->streams[i].numVertices;
    [enc drawPrimitives:MTLPrimitiveTypeTriangle vertexStart:0 vertexCount:numTriangles * 3
        instanceCount:c->instanceCount];
  }
  [enc endEncoding];
  [cb commit];
  [cb waitUntilCompleted];
  }  // @autoreleasepool
  return 1;
}

// Read back the render target into a tightly packed BGRA8 buffer (width*height*4).
// Returns 1 on success.
int s3d_readback(void* ctx, uint8_t* out) {
  if (ctx == NULL || out == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
  // getBytes on a render target synchronizes with the GPU and may internally
  // create an autoreleased blit command buffer/encoder. With no pool in the C++
  // SDL loop that would leak one command buffer per frame (the shmup residual
  // leak), so drain it here like s3d_draw does.
  @autoreleasepool {
  [c->target getBytes:out bytesPerRow:c->width * 4
      fromRegion:MTLRegionMake2D(0, 0, c->width, c->height) mipmapLevel:0];
  }
  return 1;
}

int s3d_width(void* ctx) { return ctx ? ((S3DContext*)ctx)->width : 0; }
int s3d_height(void* ctx) { return ctx ? ((S3DContext*)ctx)->height : 0; }

// ---- render-to-texture (stage 83) ----
// A render-target texture (optimizeForRenderToTexture=true) is an MTLTexture with
// both RenderTarget and ShaderRead usage: drawTriangles renders into it when it is
// the current render override, and setTextureAt can later sample it as fsN.
void* s3d_create_render_texture(void* ctx, int width, int height) {
  if (ctx == NULL || width <= 0 || height <= 0) return NULL;
  S3DContext* c = (S3DContext*)ctx;
  MTLTextureDescriptor* td = [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatBGRA8Unorm
      width:width height:height mipmapped:NO];
  td.usage = MTLTextureUsageRenderTarget | MTLTextureUsageShaderRead;
  id<MTLTexture> tex = [c->device newTextureWithDescriptor:td];
  // `newTextureWithDescriptor:` is a "new" method, so it already returns +1.
  // No extra retain here (that would leak) — the caller owns this +1 and must
  // balance it with s3d_destroy_texture (MRR, not ARC).
  return (void*)tex;
}

// Bind the render override. tex == NULL restores the back-buffer target.
void s3d_set_render_target(void* ctx, void* tex) {
  if (ctx == NULL) return;
  ((S3DContext*)ctx)->renderOverride = (id<MTLTexture>)tex;
}

// Bind an existing render-target texture as a fragment sampler fs{unit} (no
// ARGB pixel upload — the texture already holds rendered content).
int s3d_bind_texture(void* ctx, int unit, void* tex) {
  if (ctx == NULL || unit < 0 || unit > 7 || tex == NULL) return 0;
  ((S3DContext*)ctx)->textures[unit] = (id<MTLTexture>)tex;
  return 1;
}

// Expose the current render target (render override if set, else back buffer) as
// an opaque MTLTexture handle for direct GPU→GPU compositing by the Skia Metal
// backend. The caller BORROWS it — ownership stays with the context — so the
// composite path samples the live texture each frame without a CPU readback.
void* s3d_get_render_target(void* ctx) {
  if (ctx == NULL) return NULL;
  S3DContext* c = (S3DContext*)ctx;
  id<MTLTexture> src = c->renderOverride != nil ? c->renderOverride : c->target;
  return (void*)src;
}

// Read back the current render target (render override if set, else back buffer).
int s3d_readback_render(void* ctx, uint8_t* out) {
  if (ctx == NULL || out == NULL) return 0;
  S3DContext* c = (S3DContext*)ctx;
  id<MTLTexture> src = c->renderOverride != nil ? c->renderOverride : c->target;
  // Same autorelease-pool wrap as s3d_readback: getBytes may allocate an
  // autoreleased blit command buffer each frame (see the shmup residual leak).
  @autoreleasepool {
  [src getBytes:out bytesPerRow:(NSUInteger)src.width * 4
      fromRegion:MTLRegionMake2D(0, 0, src.width, src.height) mipmapLevel:0];
  }
  return 1;
}

void s3d_destroy_texture(void* tex) {
  if (tex == NULL) return;
  [(id<MTLTexture>)tex release];
}

}  // extern "C"
