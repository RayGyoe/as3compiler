// spectralnorm.as — 谱范数（Vector.<Number> 密集矩阵-向量乘基准，as3compiler 版）
const N:int = 1000;

function evalA(i:int, j:int):Number {
  var ij:int = i + j;
  return 1.0 / ((ij * (ij + 1)) / 2 + i + 1);
}

function multiplyAv(v:Vector.<Number>, av:Vector.<Number>):void {
  for (var i:int = 0; i < N; i++) {
    var sum:Number = 0.0;
    for (var j:int = 0; j < N; j++) { sum += evalA(i, j) * v[j]; }
    av[i] = sum;
  }
}

function multiplyAtv(v:Vector.<Number>, atv:Vector.<Number>):void {
  for (var i:int = 0; i < N; i++) {
    var sum:Number = 0.0;
    for (var j:int = 0; j < N; j++) { sum += evalA(j, i) * v[j]; }
    atv[i] = sum;
  }
}

function multiplyAtAv(v:Vector.<Number>, atav:Vector.<Number>, tmp:Vector.<Number>):void {
  multiplyAv(v, tmp);
  multiplyAtv(tmp, atav);
}

var u:Vector.<Number> = new Vector.<Number>();
var v:Vector.<Number> = new Vector.<Number>();
var tmp:Vector.<Number> = new Vector.<Number>();
for (var k:int = 0; k < N; k++) {
  u.push(1.0);
  v.push(0.0);
  tmp.push(0.0);
}

var t0:Number = new Date().getTime();
for (var iter:int = 0; iter < 10; iter++) {
  multiplyAtAv(u, v, tmp);
  multiplyAtAv(v, u, tmp);
}

var vBv:Number = 0.0;
var vv:Number = 0.0;
for (var i:int = 0; i < N; i++) {
  vBv += u[i] * v[i];
  vv += v[i] * v[i];
}
var t1:Number = new Date().getTime();

trace("result=" + int(Math.floor(Math.sqrt(vBv / vv) * 1000000.0)));
trace("time=" + int(t1 - t0));
