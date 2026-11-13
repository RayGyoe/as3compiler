// Video HDR -> SDR tone mapping seam (docs/zh-cn/video.md §16.10).
//
// Kept as plain C with no Skia and no FFmpeg headers so that it is (a) callable from
// vendor/video_glue.c without dragging types across the boundary, and (b) directly
// testable by compiling this file alone -- the colour numbers are the thing that has to
// be right, and a source-level pin cannot check them.

#ifndef AS_VIDEO_HDR_H
#define AS_VIDEO_HDR_H

typedef struct {
  int kind;      // 1 = PQ (SMPTE ST 2084, HDR10/HDR10+), 2 = HLG (BT.2100)
  int src_2020;  // source primaries are BT.2020 and must be mapped to BT.709
  float gain;    // exposure in reference-white units, applied after linearisation
} as_hdr;

// Returns NULL for an unknown kind or when the tables cannot be allocated.
as_hdr* as_hdr_create(int kind, int src_2020);
// Exposure, 1.0 = BT.2408. Rejected (left unchanged) when <= 0 or not finite.
void as_hdr_set_gain(as_hdr* h, float gain);
void as_hdr_destroy(as_hdr* h);

// Packed RGB48LE (6 bytes per pixel, full range, still in the source transfer
// function) -> BGRA8 (4 bytes per pixel, sRGB). Byte strides, not pixel strides.
// Returns 1 on success, 0 on bad arguments.
int as_hdr_tonemap_rgb48(const as_hdr* h, const unsigned char* src, int sstride,
                         unsigned char* dst, int dstride, int w, int rows);

// Diagnostic: what one 16-bit source code maps to, on the same path the loop takes.
int as_hdr_map8(const as_hdr* h, int code);

#endif  // AS_VIDEO_HDR_H