// entry.as — AOT 回归的入口（examples/textfield 目录单元）。
//
// 目录单元把 examples/textfield/ 下所有 .as 一起编译，顶层语句就是 AOT 的 main。
// mxmlc 侧只编 Main.as（文档类），看不到本文件；本行只是让 AOT 侧把同一份探针跑起来。
var m:Main = new Main();
