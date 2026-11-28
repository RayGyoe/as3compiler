// Unit checks: the native-memory ledger and the finalizer table (stage 383).
//
// Every probe in this stage is env-gated, so a shipping build pays only one
// getenv at start-up and nothing per frame; these checks pin that shape, because
// a leak tool that silently starts costing time in production is worse than no
// tool at all. They also pin the two invariants that a real leak hunt depends on:
// the ledger must de-duplicate by address (glibc and Skia both hand the same
// address back out), and the finalizer table must grow instead of silently
// dropping registrations (a fixed 4096 cap was the biggest leak in the app).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerGroup, root } from '../harness.ts';

const runtime = readFileSync(join(root, 'src/runtime.ts'), 'utf8');
const emit = readFileSync(join(root, 'src/emit.ts'), 'utf8');

/** The C body of one emitted runtime helper, from its signature to the closing brace. */
function fnBody(src: string, signature: string): string {
  const at = src.indexOf(signature);
  if (at < 0) return '';
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  return '';
}

registerGroup('memledger/Ledger', () => {
  const bad: string[] = [];
  const check = (label: string, condition: boolean): void => {
    if (condition) console.log(`PASS  [memledger] ${label}`);
    else { bad.push(label); console.log(`FAIL  [memledger] ${label}`); }
  };

  // --- opt-in only -------------------------------------------------------
  check('ASC_MEM_TRACE is read from the environment', runtime.includes('getenv("ASC_MEM_TRACE")'));
  check('ASC_MEM_CLASSES census is opt-in', runtime.includes('getenv("ASC_MEM_CLASSES")'));
  check('ASC_MEM_FORCE_GC is opt-in', runtime.includes('getenv("ASC_MEM_FORCE_GC")'));

  // --- address de-duplication -------------------------------------------
  const track = fnBody(runtime, 'static void as_mem_track_site(void* p, double bytes, int tag, int site) {');
  check('tracking de-duplicates by address', track.includes('int dup = as_mem_find(p);'));
  check('a duplicate subtracts its old bytes from every bucket',
    track.includes('AS_mem_live[dt] -= AS_memp_bytes[dup];') &&
    track.includes('AS_mem_site_live[dt][ds] -= AS_memp_bytes[dup];'));
  check('a full ledger warns once and keeps counting instead of corrupting state',
    track.includes('if (!warned)') && track.includes('newer resources are untracked'));

  // --- site bucketing ----------------------------------------------------
  check('14 creation sites', runtime.includes('#define AS_MEM_SITES 14'));
  const sites = runtime.slice(runtime.indexOf('static const char* AS_mem_site_name'), runtime.indexOf('static double AS_mem_site_live'));
  for (const name of ['s9', 'textfield', 'bitmapdata', 'bake_do', 'bake_verify']) {
    check(`site bucket "${name}" exists`, sites.includes(`"${name}"`));
  }
  // The five bake call sites have different lifetimes (snapshot-and-delete,
  // self-drawn TextField, self-drawn BitmapData, long-lived display object,
  // verification scratch), so they must map to distinct ids.
  const callSites = [...emit.matchAll(/as_skia_surface_bake_new_site\([^;]*?,\s*(\d+)\)/g)].map((m) => m[1]);
  // Four explicit ids plus the default-constructed site (the long-lived
  // display-object path keeps the default so it cannot be mistaken for scratch).
  check('four emitted tagged bake sites plus one default', callSites.length === 4);
  check('the tagged ids are distinct and none reuses the long-lived default',
    new Set(callSites).size === callSites.length && callSites.every((n) => Number(n) !== 11));
  check('the long-lived display-object path keeps the default site',
    emit.includes('void* surface = as_skia_surface_bake_new(pw, ph);'));

  // --- pure-C builds still compile --------------------------------------
  // Every bake call site is emitted unconditionally (the DisplayObject methods
  // exist without Skia too), so the tagged constructor needs a no-op stub or
  // every non-Skia program fails with "call to undeclared function".
  check('tagged constructor has a non-Skia stub',
    runtime.includes('static inline void* as_skia_surface_bake_new_site(int w, int h, int site)'));
  check('window-surface tag has a non-Skia definition',
    runtime.includes('#define AS_MEM_SURF_WIN 1') &&
    runtime.includes('static inline void* as_skia_surface_new_tagged(int w, int h, int tag)'));

  return bad;
});

registerGroup('memledger/Finalizers', () => {
  const bad: string[] = [];
  const check = (label: string, condition: boolean): void => {
    if (condition) console.log(`PASS  [memledger] ${label}`);
    else { bad.push(label); console.log(`FAIL  [memledger] ${label}`); }
  };

  // The table holds owner -> C++ resource pairs so a resource is released when
  // its AS3 owner dies. A fixed 4096-entry cap silently dropped every later
  // registration, which is what made a window opened and closed a few thousand
  // times leak its whole Skia surface set.
  check('the table starts small and grows', runtime.includes('#define ASC_FINAL_SLOTS_INIT 1024'));
  check('no fixed-capacity table remains', !/#define ASC_FINAL_SLOTS\s+\d+/.test(runtime));
  check('the columns are pointers, so they can be reallocated',
    runtime.includes('static void** ASC_final_owner = NULL;') &&
    runtime.includes('static void** ASC_final_res = NULL;'));
  check('capacity is tracked separately from usage',
    runtime.includes('ASC_final_cap') && runtime.includes('ASC_final_used'));
  const grow = fnBody(runtime, 'static void as_final_grow(void) {');
  check('growth reallocates all three columns',
    grow.includes('ASC_final_owner') && grow.includes('ASC_final_res') && grow.includes('ASC_final_kind'));
  check('a failed grow warns instead of corrupting the table',
    grow.includes('finalizer table cannot grow past'));
  check('registration grows before giving up',
    runtime.includes('if (ASC_final_used >= ASC_final_cap)'));
  check('dead owners are released on sweep',
    runtime.includes('as_final_on_free('));

  return bad;
});

// EP-C: allocation-proportional slice pacing. A GUI frame boundary arrives at vsync
// rate while a time-sliced producer (video export) allocates many MB per boundary;
// one 3 ms slice per boundary drained slower than the producer allocated (measured
// GB-scale sawtooth; headless with unlimited boundary rate stayed ~92 MB). gc_step
// must run extra slices per safe point proportional to bytes allocated since the
// previous one, while keeping the per-slice latency cap and an idle floor of one.
registerGroup('memledger/GcSlicePacing', () => {
  const bad: string[] = [];
  const check = (label: string, condition: boolean): void => {
    if (condition) console.log(`PASS  [memledger] ${label}`);
    else { bad.push(label); console.log(`FAIL  [memledger] ${label}`); }
  };
  const step = fnBody(runtime, 'static void gc_step(void) {');
  const slice = fnBody(runtime, 'static bool gc_slice(double t0, double cap_ms) {');
  check('gc_step exists and delegates slices to gc_slice', step.length > 0 && slice.length > 0);
  check('alloc since the previous safe point is counted in gc_alloc',
    runtime.includes('gc_step_alloc += sizeof(gc_header) + h->size;'));
  check('the safe point consumes and resets the alloc counter',
    step.includes('const size_t alloc_since = gc_step_alloc;') && step.includes('gc_step_alloc = 0;'));
  check('slice count scales with allocated bytes (floor one, capped)',
    step.includes('size_t slices = 1 + alloc_since / gc_alloc_slice_bytes();')
    && step.includes('if (slices > max_slices) slices = max_slices;'));
  check('each slice keeps its own wall-clock cap (single-slice pause unchanged)',
    step.includes('gc_slice(as_now_ms(), gc_time_budget_ms())'));
  check('the whole safe point is bounded by a point cap',
    step.includes('gc_point_budget_ms()') && step.includes('as_now_ms() - point_t0 >= point_cap'));
  check('a finished cycle stops extra slices early',
    step.includes('if (!gc_slice(') && slice.includes('return gc_inc.state != GC_IDLE;'));
  check('the knobs are env-overridable for A/B measurement',
    runtime.includes('getenv("ASC_GC_ALLOC_SLICE_BYTES")')
    && runtime.includes('getenv("ASC_GC_MAX_SLICES")')
    && runtime.includes('getenv("ASC_GC_POINT_BUDGET_MS")'));
  check('idle frames still run exactly one slice (4 MiB unit, max 5, point 15 ms)',
    runtime.includes('v = e ? (size_t)strtoul(e, NULL, 10) : (4u << 20);')
    && runtime.includes('v = e ? (size_t)strtoul(e, NULL, 10) : 5;')
    && runtime.includes('v = e ? atof(e) : 15.0;'));
  check('high alloc rate caps the collection trigger (inuse/8 feedback loop broken)',
    runtime.includes('gc_alloc_rate_high = alloc_since >= gc_alloc_slice_bytes() ? 1 : 0;')
    && runtime.includes('if (gc_alloc_rate_high) {')
    && runtime.includes('if (t > ceil) t = ceil;'));
  check('the trigger ceiling is env-overridable (default 32 MiB)',
    runtime.includes('getenv("ASC_GC_TRIGGER_CEIL_BYTES")')
    && runtime.includes('v = e ? (size_t)strtoul(e, NULL, 10) : (32u << 20);'));
  return bad;
});