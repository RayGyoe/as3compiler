// sound-nobackend.as — 没有音频后端时的载入口径（不是「载入即失败」）
//
// 背景（TODO 遗留表「web 目标无音频后端时 loadCompressedDataFromByteArray 直接抛
// #2068」）：无后端构建里 `as_audio_decode` 是恒返 -1 的桩，而 AS3 侧把 -1 一律翻成
// 「数据坏」⇒ 载荷根本进不了 Sound，`areSoundsInaccessible()` 那条「载入但无声」的
// 口径也就用不上。AIR 只在**数据真的坏**时才让装载失败；机器没有声卡时它照样装载成功，
// 无声是在 play() 时才体现的（`length` 为 0、`play()` 返 null、
// `SoundMixer.areSoundsInaccessible()` 为 true）。
//
// 于是把「没有解码器」与「数据坏」分开：没有解码器时载荷记在 AS_SND_NOCDC（-2），
// 与「完全没数据」的 -1 区分开 —— 空 Sound 的 play() 照旧抛 #2068（adl 实测，
// 有无设备都一样），而装载成功的 Sound 的 play() 按无设备口径返 null。
//
// 本示例只在**无音频后端**的构建里断言（`examples/audio.build.json` 那种带 miniaudio
// 的构建下整组跳过：那边有真解码器，垃圾数据本来就该抛 #2068）。
//
// 编译：as-aot examples/sound-nobackend.as --run

import flash.media.Sound;
import flash.media.SoundMixer;
import flash.utils.ByteArray;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

// --- ① 空 Sound 的 play() 仍然响亮失败（有无设备都一样） ----------------------
var empty:Sound = new Sound();
var emptyThrew:Boolean = false;
try { empty.play(); } catch (e:Error) { emptyThrew = true; }
check(emptyThrew, "play() on a Sound with no data must still throw #2068");

if (SoundMixer.areSoundsInaccessible()) {
  // --- ② 压缩数据：装载成功，不抛，bytesTotal 记账 --------------------------
  var payload:ByteArray = new ByteArray();
  payload.writeUTFBytes("this build has no audio decoder at all");
  var n:int = payload.length;
  payload.position = 0;

  var snd:Sound = new Sound();
  var threw:Boolean = false;
  try {
    snd.loadCompressedDataFromByteArray(payload, n);
  } catch (e2:Error) {
    threw = true;
  }
  check(!threw, "with no audio backend, loadCompressedDataFromByteArray must NOT throw");
  check(snd.bytesTotal == n, "bytesTotal records the payload, got " + snd.bytesTotal + " vs " + n);
  check(snd.bytesLoaded == n, "bytesLoaded records the payload, got " + snd.bytesLoaded);
  check(snd.length == 0, "length is 0 when there is nothing to decode with, got " + snd.length);
  check(payload.position == n, "the source position still advances to the end, got " + payload.position);

  // 载入成功但无设备 ⇒ play() 返 null（**不**抛；这正是与空 Sound 的区别）
  var ch:* = null;
  var playThrew:Boolean = false;
  try {
    ch = snd.play();
  } catch (e3:Error) {
    playThrew = true;
  }
  check(!playThrew, "play() on a loaded-but-silent Sound must not throw");
  check(ch == null, "play() returns null without a device, got " + ch);

  // --- ③ PCM 数据同一口径 --------------------------------------------------
  var pcm:ByteArray = new ByteArray();
  var i:int = 0;
  while (i < 400) { pcm.writeFloat(0); i++; }
  pcm.position = 0;
  var snd2:Sound = new Sound();
  var pcmThrew:Boolean = false;
  try {
    snd2.loadPCMFromByteArray(pcm, 100, "float", false, 44100);
  } catch (e4:Error) {
    pcmThrew = true;
  }
  check(!pcmThrew, "with no audio backend, loadPCMFromByteArray must NOT throw");
  check(snd2.bytesTotal == 400, "PCM bytesTotal is the payload size, got " + snd2.bytesTotal);
  check(snd2.length == 0, "PCM length is 0 without a decoder, got " + snd2.length);
  check(snd2.play() == null, "PCM play() returns null without a device");

  // --- ④ 参数校验仍然排在前面（不是「无后端就什么都放过」） ------------------
  var shortArr:ByteArray = new ByteArray();
  shortArr.writeUTFBytes("ab");
  var shortThrew:Boolean = false;
  try { new Sound().loadCompressedDataFromByteArray(shortArr, 100); } catch (e5:Error) { shortThrew = true; }
  check(shortThrew, "asking for more bytes than the ByteArray holds still throws #2084");

  var badFmt:Boolean = false;
  try { new Sound().loadPCMFromByteArray(pcm, 10, "bogus", false, 44100); } catch (e6:Error) { badFmt = true; }
  check(badFmt, "an unknown PCM format still throws #2005");

  trace("sound-nobackend: OK (loaded but silent: length=0, play()=null, areSoundsInaccessible=true)");
} else {
  trace("sound-nobackend: OK (audio backend present: the no-decoder branch is not reachable)");
}