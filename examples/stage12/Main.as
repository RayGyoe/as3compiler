// stage12 Main.as — 从 package foo 跨文件 import Greeter 并实例化调用。

import foo.Greeter;
import foo.Peer;

var g:Greeter = new Greeter("Hello");
trace(g.greet("world"));   // Hello, world!
trace(g.greet("AS3"));     // Hello, AS3!

// 同包内 Peer 可访问 internal 成员；顶层（default package）直接访问会拒绝。
var p:Peer = new Peer();
trace(p.reveal(g));        // internal
