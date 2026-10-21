// Unit pins for the async job pool's platform coverage (stage 230).
//
// Until stage 230 the pool was POSIX-only: `#if !defined(__wasi__) &&
// !defined(__EMSCRIPTEN__) && !defined(_WIN32)` left the Windows build on the
// "inline strategy", i.e. every HTTP/FS transfer ran ON the AS3 thread inside
// load()/open(), so the UI thread stalled for the whole round trip of each
// request. Measured with temp/asyncprobe (a server that answers after 150/400 ms):
//
//   inline (before)  load() returned after 154 ms for a 150 ms transfer
//   pool   (after)   load() returned in 1 ms; 4 x 400 ms transfers finished in
//                    417 ms instead of ~1600 ms serialised
//
// In the real meeting client this is the "opening a document freezes the app for
// several seconds" symptom: FilePreviewView.loadThumbImage fetches one slide per
// COMPLETE (32 slides deep), so the old behaviour serialised 32 round trips on
// the UI thread, each one a full stall.
//
// These pins are source-level: the preamble is a string, and the property under
// test ("Windows gets real workers; POSIX keeps pthreads; no job-pool call is
// left on raw pthread_*") is exactly what the text says.
import { join } from 'node:path';
import { registerGroup, root, readNorm } from '../harness.ts';

export function checkAsyncWorkerPool(): string[] {
  const bad: string[] = [];
  const pre = readNorm(join(root, 'src', 'runtime.ts'));

  const has = (needle: string, label: string): void => {
    if (!pre.includes(needle)) bad.push(label);
  };
  const lacks = (needle: string, label: string): void => {
    if (pre.includes(needle)) bad.push(label);
  };

  // 1. The guard covers Windows now, and still leaves WASI / Emscripten alone
  //    (WASI has no thread primitives, Emscripten needs -pthread + COOP/COEP).
  has(
    '#if !defined(__wasi__) && !defined(__EMSCRIPTEN__)\n#define ASC_ASYNC_THREADS 1',
    'ASC_ASYNC_THREADS is enabled for every native target, Windows included',
  );
  lacks(
    '!defined(_WIN32)\n#define ASC_ASYNC_THREADS 1',
    'the old POSIX-only guard (Windows fell back to inline transfers) is gone',
  );

  // 2. Windows primitives: the SRWLOCK + CONDITION_VARIABLE pair is the closest
  //    Win32 match to pthread_mutex_t + pthread_cond_t, and _beginthreadex (not
  //    CreateThread) is what the MSVC CRT needs for malloc/fopen/libcurl on a
  //    worker.
  has('#include <process.h>', 'Windows worker spawner includes <process.h>');
  has('typedef SRWLOCK as_jm_t;', 'the job lock is an SRWLOCK on Windows');
  has('typedef CONDITION_VARIABLE as_jc_t;', 'the job wakeup is a CONDITION_VARIABLE on Windows');
  has('SleepConditionVariableSRW((c), (m), INFINITE, 0)', 'waiting uses SleepConditionVariableSRW');
  has('WakeAllConditionVariable(c)', 'broadcasting wakes all waiters');
  has('(HANDLE)_beginthreadex(NULL, 0, as_job_worker_win, NULL, 0, NULL)',
    'workers are spawned with _beginthreadex');
  has('static unsigned __stdcall as_job_worker_win(void* arg)', 'the Win32 worker has the CRT signature');

  // 3. POSIX is unchanged: pthreads behind the same macro names, so the macOS /
  //    Linux behaviour that every existing example was validated against cannot
  //    drift.
  has('#define AS_JOB_LOCK(m)      pthread_mutex_lock(m)', 'POSIX still uses pthread_mutex_lock');
  has('#define AS_JOB_WAKE_ALL(c)  pthread_cond_broadcast(c)', 'POSIX still uses pthread_cond_broadcast');
  has('static void* as_job_worker(void* arg) {', 'the POSIX worker entry point still exists');

  // 4. One queue loop, not two: the claim/run/publish body is shared by both
  //    spawners, so a fix there cannot land on one platform only.
  has('static void as_job_worker_loop(void) {', 'both spawners share one pool loop');

  // 5. No job-pool call is left on raw pthread_* — that would be an undeclared
  //    identifier on Windows (the bug class this stage removes).
  lacks('pthread_mutex_lock(&as_job_lock)', 'no raw pthread_mutex_lock on the job lock');
  lacks('pthread_mutex_unlock(&as_job_lock)', 'no raw pthread_mutex_unlock on the job lock');
  lacks('pthread_cond_wait(&as_job_wake', 'no raw pthread_cond_wait on the job wakeup');
  lacks('pthread_cond_broadcast(&as_job_wake', 'no raw pthread_cond_broadcast on the job wakeup');

  // 6. The lock is still taken where the job table is mutated: publish, the
  //    frame-boundary dispatch passes and the URLStream buffer all run against a
  //    worker, so a dropped lock is a data race on Windows now.
  const lockSites = (pre.match(/AS_JOB_LOCK\(&as_job_lock\)/g) ?? []).length;
  if (lockSites < 8) bad.push(`the job lock is taken at every mutating site (found ${lockSites}, expected >= 8)`);
  has('static int as_stream_append(as_job* j, const void* p, size_t n) {', 'the streaming append still exists');

  // 7. libcurl's progress meter is off: AIR prints nothing for a transfer, and
  //    with four workers the stderr table interleaves into noise.
  has('curl_easy_setopt(h, CURLOPT_NOPROGRESS, 1L)', 'CURLOPT_NOPROGRESS is set');

  return bad;
}

registerGroup('unit: runtime/AsyncWorkerPool', checkAsyncWorkerPool);