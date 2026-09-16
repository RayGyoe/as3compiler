// stage13.as — 代码质量与语义收尾：null 装箱语义、字符串 arena 压力。

class Foo {
  var x:int = 1;
}

// null 赋给对象类型后，字符串拼接与比较应把 null 当作 "null"。
var f:Foo = null;
trace("f == null: " + (f == null));   // f == null: true
trace("f: " + f);                     // f: null
trace(f);                             // null

var g:Foo = new Foo();
trace("g == null: " + (g == null));   // g == null: false

// 高频字符串拼接（arena 分配，不泄漏、不崩溃）。
var s:String = "";
var i:int = 0;
while (i < 200) {
  s = s + "x";
  i = i + 1;
}
trace("len: " + s.length);            // len: 200
trace(s.substring(0, 5));             // xxxxx
