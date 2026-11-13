// Video HDR -> SDR tone mapping seam (docs/zh-cn/video.md §16.10/§16.11).
//
// Kept as plain C with no Skia and no FFmpeg headers so that it is (a) callable from
// vendor/video_glue.c without dragging types across the boundary, and (b) directly
// testable by compiling this file alone -- the colour numbers are the thing that has to
// be right, and a source-level pin cannot check them.

#ifndef AS_VIDEO_HDR_H
#define AS_VIDEO_HDR_H

typedef struct as_hdr as_hdr;

// Dynamic metadata summary, already converted to nits by the caller. The seam takes
// plain numbers instead of AVDynamicHDRPlus/AVDOVIMetadata structs on purpose: the
// curve is the part that needs testing, and it must be testable without FFmpeg.
typedef struct {
  int kind;         // 0 = none, 1 = HDR10+ (ST 2094-40), 2 = Dolby Vision, 3 = static only
  float peak_nits;  // brightest pixel this scene targets (0 = unknown)
  float avg_nits;   // mean of the scene's linearised maxRGB (0 = unknown)
  float master_nits;   // mastering display peak (static)
  float max_cll_nits;  // MaxCLL (static)
  float max_fall_nits; // MaxFALL (static)
  float tsdl_nits;     // HDR10+ targeted system display maximum luminance
  int dv_profile;      // Dolby Vision profile (0 when not DV)
  int dv_level;
  int dv_bl_compat;    // dv_bl_signal_compatibility_id: 1 = HDR10, 4 = HLG, 0 = none
} as_hdr_meta;

// kind: 1 = PQ (SMPTE ST 2084, HDR10/HDR10+/DV BL), 2 = HLG (BT.2100).
// Returns NULL for an unknown kind or when the tables cannot be allocated.
as_hdr* as_hdr_create(int kind, int src_2020);
// Exposure, 1.0 = BT.2408. Rejected (left unchanged) when <= 0 or not finite.
void as_hdr_set_gain(as_hdr* h, float gain);
// Per-scene curve. peak_nits drives the shoulder (an empty scene compresses less, so
// the picture does not lose contrast to a shoulder nothing reaches); avg_nits is
// reported and used as the local mapping anchor when the frame itself is ambiguous.
void as_hdr_set_meta(as_hdr* h, const as_hdr_meta* m);
// HLG nominal display peak in nits: sets the OOTF system gamma (1.2 at 1000 nits).
void as_hdr_set_hlg_peak(as_hdr* h, float nits);
// Local (spatially varying) tone mapping. strength 0 disables; 0.25 is the measured
// default. Returns 1 when enabled.
int as_hdr_set_local(as_hdr* h, float strength);
// 1 = two-sided (compress bright neighbourhoods too, the textbook operator),
// 0 = shadow lift only (default: measured to keep the top end intact).
int as_hdr_set_local_mode(as_hdr* h, int two_sided);
void as_hdr_destroy(as_hdr* h);

// Packed RGB48LE (6 bytes per pixel, full range, still in the source transfer
// function) -> BGRA8 (4 bytes per pixel, sRGB). Byte strides, not pixel strides.
// Returns 1 on success, 0 on bad arguments.
int as_hdr_tonemap_rgb48(as_hdr* h, const unsigned char* src, int sstride,
                         unsigned char* dst, int dstride, int w, int rows);

// Same source, but straight to native HDR: RGBA16F in BT.709 linear light where
// 1.0 == white_nits. Used when the window presents an scRGB swapchain, in which case
// the DISPLAY does the mapping to its own peak and anything compressed here would be
// compressed twice. So this path applies no shoulder, no local map, no sRGB OETF and no
// clamp: decode, BT.2020 -> BT.709, scale to the window's white level. Values above 1.0
// are the highlights and must stay above 1.0.
int as_hdr_tonemap_rgb48_f16(as_hdr* h, const unsigned char* src, int sstride,
                             unsigned char* dst, int dstride, int w, int rows,
                             float white_nits);

// Diagnostic: what one 16-bit source code maps to, on the same path the loop takes
// (for HLG this is the neutral-grey value; the cross-channel term is identity there).
int as_hdr_map8(const as_hdr* h, int code);

// Diagnostics for AS_VIDEO_STATS and the unit test.
float as_hdr_curve_knee(const as_hdr* h);
float as_hdr_curve_tau(const as_hdr* h);
float as_hdr_scene_peak(const as_hdr* h);
float as_hdr_scene_avg(const as_hdr* h);
int as_hdr_meta_kind(const as_hdr* h);
int as_hdr_local_strength(const as_hdr* h);
int as_hdr_local_mode(const as_hdr* h);
// Mean local gain applied to the last mapped frame (1.0 when local mapping is off).
float as_hdr_last_gain(const as_hdr* h);

#endif  // AS_VIDEO_HDR_H