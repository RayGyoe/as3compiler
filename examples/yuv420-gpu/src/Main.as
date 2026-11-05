package demo {
  import flash.display.Sprite;
  import flash.display.Bitmap;
  import flash.display.BitmapData;
  import flash.geom.Rectangle;
  import flash.utils.ByteArray;
  import flash.events.Event;
  import flash.system.System;

  // yuv420-gpu：BitmapData.setYuv420（E20，--features yuv420）的 GPU 直渲 BT.601
  // 逐像素验色。需要 --air-app + <renderMode>direct</renderMode>（macOS Metal 窗口）。
  //
  // 原理：构造已知 I420 纯色帧 → setYuv420 → 通过 Bitmap 显示对象 draw 采样。BitmapData
  // .draw 的 Bitmap 源分支走 as_bmd_live_image 的 YUV 分支（Skia TextureFromYUVAPixmaps，
  // kRec601_Limited），把 GPU YUV 纹理画到 probe 再读回 CPU。断言采样颜色 = BT.601 视频
  // 范围公式（容差 ±2）。
  //
  // 判定口径：
  //   * GPU 直渲生效（Metal context 存在）：采样颜色 ≈ BT.601 期望 → PASS；
  //   * CPU 后端（无 Metal context）：as_bmd_live_image 返回 NULL → 黑屏 → 采样 = 0，
  //     非黑断言失败 → FAIL。这正是要区分的两个结果。

  public class Main extends Sprite {
    private static var fails:int = 0;

    public function Main() {
      if (stage) start();
      else addEventListener(Event.ADDED_TO_STAGE, onAdded);
    }

    private function onAdded(e:Event):void {
      removeEventListener(Event.ADDED_TO_STAGE, onAdded);
      start();
    }

    private function start():void {
      // Metal 上下文在窗口创建时同步建好，但等一帧更稳（避开启动序列异步 IO）。
      addEventListener(Event.ENTER_FRAME, onFrame);
    }

    private function onFrame(e:Event):void {
      removeEventListener(Event.ENTER_FRAME, onFrame);
      verifyAll();
      if (fails == 0) {
        trace("yuv420-gpu: OK (GPU BT.601 direct render verified)");
        System.exit(0);
      } else {
        trace("yuv420-gpu: FAIL (" + fails + " case(s))");
        System.exit(1);
      }
    }

    // ---- BT.601 视频范围（limited range）YUV → RGB，精确系数 -----------------
    // 系数 = 标准 BT.601（SMPTE 170M）limited range：Y∈[16,235]，U/V∈[16,240]。
    private static function clamp255(v:Number):int {
      var r:int = Math.round(v);
      if (r < 0) return 0;
      if (r > 255) return 255;
      return r;
    }
    private static function yuv2r(y:int, u:int, v:int):int {
      return clamp255(1.16438356 * (y - 16) + 1.59602679 * (v - 128));
    }
    private static function yuv2g(y:int, u:int, v:int):int {
      return clamp255(1.16438356 * (y - 16) - 0.39176229 * (u - 128) - 0.81296765 * (v - 128));
    }
    private static function yuv2b(y:int, u:int, v:int):int {
      return clamp255(1.16438356 * (y - 16) + 2.01723214 * (u - 128));
    }

    // ---- 构造 w×h 的 I420 纯色帧（Y | U | V，紧凑无 stride）------------------
    private static function makeYuv(w:int, h:int, y:int, u:int, v:int):ByteArray {
      var ba:ByteArray = new ByteArray();
      var i:int;
      for (i = 0; i < w * h; i++) ba.writeByte(y);
      for (i = 0; i < (w / 2) * (h / 2); i++) ba.writeByte(u);
      for (i = 0; i < (w / 2) * (h / 2); i++) ba.writeByte(v);
      ba.position = 0;
      return ba;
    }

    // ---- 采样：Bitmap 显示对象 → draw 到 probe（走 as_bmd_live_image 的 YUV 分支）--
    private static function sample(w:int, h:int, y:int, u:int, v:int):int {
      var bd:BitmapData = new BitmapData(w, h, false, 0);
      bd.setYuv420(new Rectangle(0, 0, w, h), makeYuv(w, h, y, u, v));
      var bmp:Bitmap = new Bitmap(bd);
      var probe:BitmapData = new BitmapData(w, h, false, 0);
      probe.draw(bmp);
      return probe.getPixel32(w / 2, h / 2) & 0xFFFFFF;
    }

    // ---- 验色：比较采样 RGB 与期望（容差 ±2，容纳 GPU shader 的 LSB 舍入）-----
    private static function verify(y:int, u:int, v:int, label:String):void {
      var px:int = sample(8, 8, y, u, v);
      var er:int = yuv2r(y, u, v);
      var eg:int = yuv2g(y, u, v);
      var eb:int = yuv2b(y, u, v);
      var pr:int = (px >> 16) & 0xFF;
      var pg:int = (px >> 8) & 0xFF;
      var pb:int = px & 0xFF;
      var ok:Boolean = Math.abs(pr - er) <= 2 && Math.abs(pg - eg) <= 2 && Math.abs(pb - eb) <= 2;
      trace("  " + label + " YUV(" + y + "," + u + "," + v + ") -> RGB(" + pr + "," + pg + "," + pb +
        ") expected (" + er + "," + eg + "," + eb + "): " + (ok ? "PASS" : "FAIL"));
      if (!ok) fails++;
    }

    private static function verifyAll():void {
      trace("yuv420-gpu: sampling BT.601 colours through the GPU YUV path");
      verify(16, 128, 128, "black  ");   // 黑电平
      verify(235, 128, 128, "white  ");  // 白电平
      verify(128, 128, 128, "grey   ");  // 中性灰（对系数精度最敏感）
      verify(81, 90, 240, "red    ");    // R 分量 + V 色度
      verify(145, 54, 34, "green  ");    // G 分量
      verify(41, 240, 110, "blue   ");   // B 分量 + U 色度
    }
  }
}
