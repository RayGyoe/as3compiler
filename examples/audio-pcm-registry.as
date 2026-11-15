// audio-pcm-registry.as — PCM 注册表按需增长（阶段四百三十二，G46）。
// 旧实现是固定 64 槽（vendor/audio_glue.c g_bufs[64]），第 65 个解码/注册的 PCM
// 镜像会让 as_audio_register_pcm 返回 -1，进而在有音频后端时抛 #2068。一个逐页
// 解码图片配乐的相册（hymn-demo）就会撞上。现在表按需倍增、旧块永不释放（实时
// 音频线程持旧指针仍安全）。本例注册 80 个 PCM 镜像（> 64）验证上限已消除。
import flash.media.Sound;
import flash.media.SoundChannel;
import flash.utils.ByteArray;

function check(cond:Boolean, msg:String):void { if (!cond) throw new Error("FAIL: " + msg); }

var RATE:int = 44100;
var FRAMES:int = 100;
var loaded:int = 0;
var last:Sound = null;
for (var i:int = 0; i < 80; i++) {
  var pcm:ByteArray = new ByteArray();
  for (var n:int = 0; n < FRAMES; n++) pcm.writeFloat(Math.sin(2 * Math.PI * 440 * n / RATE) * 0.5);
  pcm.position = 0;
  var s:Sound = new Sound();
  s.loadPCMFromByteArray(pcm, FRAMES, "float", false, RATE);
  check(s.length > 0, "buffer " + i + " must load (length>0), got " + s.length);
  loaded++;
  last = s;
}
check(loaded == 80, "all 80 PCM buffers registered, got " + loaded);

// 第 80 个（远超旧 64 上限）仍可播放。无音频设备的 CI 上 play 可能返回 null，
// 但注册本身不得抛 #2068——那正是本缺陷的症状。
var ch:SoundChannel = last.play();
trace("PASS audio-pcm-registry loaded=" + loaded);