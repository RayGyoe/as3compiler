package {
  import flash.display.Sprite;
  import flash.desktop.NativeApplication;
  import flash.filesystem.File;
  import flash.filesystem.FileStream;
  import flash.filesystem.FileMode;
  import flash.utils.getTimer;

  // nbody_air.as — 5 天体 N 体模拟（浮点基准，原生 AIR AS3 版）
  public class nbody_air extends Sprite {
    private var PI:Number = 3.141592653589793;
    private var SOLAR_MASS:Number = 4.0 * PI * PI;
    private var DPY:Number = 365.24;

    public function nbody_air() {
      var bodies:Vector.<Body> = new Vector.<Body>();
      bodies.push(new Body(0, 0, 0, 0, 0, 0, SOLAR_MASS));
      bodies.push(new Body(4.84143144246472090, -1.16032004402742839, -0.103622044471123109,
        0.00166007664274403694 * DPY, 0.00769901118419740425 * DPY, -0.0000690460016972063023 * DPY,
        0.000954791938424326609 * SOLAR_MASS));
      bodies.push(new Body(8.34336671824457987, 4.12479856412430479, -0.403523417114321381,
        -0.00276742510726862411 * DPY, 0.00499852801234917238 * DPY, 0.0000230417297573763929 * DPY,
        0.000285885980666130812 * SOLAR_MASS));
      bodies.push(new Body(12.8943695621391310, -15.1111514016986312, -0.223307578892655734,
        0.00296460137564761618 * DPY, 0.00237847173959480950 * DPY, -0.0000296589568540237556 * DPY,
        0.0000436624404335156298 * SOLAR_MASS));
      bodies.push(new Body(15.3796971148509165, -25.9193146099879641, 0.179258772950371181,
        0.00268067772490389322 * DPY, 0.00162824170038242295 * DPY, -0.0000951592254519715870 * DPY,
        0.0000515138902046611451 * SOLAR_MASS));

      var px:Number = 0;
      var py:Number = 0;
      var pz:Number = 0;
      for (var i:int = 0; i < 5; i++) {
        var b:Body = bodies[i];
        px += b.vx * b.mass;
        py += b.vy * b.mass;
        pz += b.vz * b.mass;
      }
      var sun:Body = bodies[0];
      sun.vx = -px / SOLAR_MASS;
      sun.vy = -py / SOLAR_MASS;
      sun.vz = -pz / SOLAR_MASS;

      var t0:int = getTimer();
      var e0:Number = energy(bodies);
      for (var step:int = 0; step < 5000000; step++) { advance(bodies, 0.01); }
      var e1:Number = energy(bodies);
      var t1:int = getTimer();

      var fs:FileStream = new FileStream();
      var out:File = File.applicationStorageDirectory.resolvePath("nbody_air.log");
      fs.open(out, FileMode.WRITE);
      fs.writeUTFBytes("result=" + int(Math.floor(e0 * 1000000.0)) + "," + int(Math.floor(e1 * 1000000.0)) + "\n");
      fs.writeUTFBytes("time=" + (t1 - t0) + "\n");
      fs.close();

      NativeApplication.nativeApplication.exit();
    }

    private function energy(bodies:Vector.<Body>):Number {
      var e:Number = 0;
      for (var i:int = 0; i < 5; i++) {
        var b:Body = bodies[i];
        e += 0.5 * b.mass * (b.vx * b.vx + b.vy * b.vy + b.vz * b.vz);
        for (var j:int = i + 1; j < 5; j++) {
          var b2:Body = bodies[j];
          var dx:Number = b.x - b2.x;
          var dy:Number = b.y - b2.y;
          var dz:Number = b.z - b2.z;
          e -= (b.mass * b2.mass) / Math.sqrt(dx * dx + dy * dy + dz * dz);
        }
      }
      return e;
    }

    private function advance(bodies:Vector.<Body>, dt:Number):void {
      for (var i:int = 0; i < 5; i++) {
        var b:Body = bodies[i];
        for (var j:int = i + 1; j < 5; j++) {
          var b2:Body = bodies[j];
          var dx:Number = b.x - b2.x;
          var dy:Number = b.y - b2.y;
          var dz:Number = b.z - b2.z;
          var d2:Number = dx * dx + dy * dy + dz * dz;
          var mag:Number = dt / (d2 * Math.sqrt(d2));
          b.vx -= dx * b2.mass * mag;
          b.vy -= dy * b2.mass * mag;
          b.vz -= dz * b2.mass * mag;
          b2.vx += dx * b.mass * mag;
          b2.vy += dy * b.mass * mag;
          b2.vz += dz * b.mass * mag;
        }
        b.x += dt * b.vx;
        b.y += dt * b.vy;
        b.z += dt * b.vz;
      }
    }
  }
}

class Body {
  public var x:Number = 0;
  public var y:Number = 0;
  public var z:Number = 0;
  public var vx:Number = 0;
  public var vy:Number = 0;
  public var vz:Number = 0;
  public var mass:Number = 0;

  public function Body(x:Number, y:Number, z:Number, vx:Number, vy:Number, vz:Number, mass:Number) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.vx = vx;
    this.vy = vy;
    this.vz = vz;
    this.mass = mass;
  }
}
