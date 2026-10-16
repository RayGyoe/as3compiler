// entry-ui.as — AOT 侧的 **UI 网格**入口（对应 adl 侧的 UiMain.as）。
//
// 与 entry.as 的唯一区别是打开 Main 的 UI 开关：多铺一张网格图。报告仍然照写。
// 本文件在 test/examples.ts 的 SKIP_FILES 里——目录单元只跑 entry.as 的纯数值口径，
// 否则每次回归都会多写一个 4 MB 位图。UI 口径由 run-aot-ui.sh 单独跑。
var u:Main = new Main(true);
