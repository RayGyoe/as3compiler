// export-meta.as — [WasmExport] 声明式导出示例。
// 与 --export fib 的命令行方式不同，这里用 AS3 metadata 在源码里声明哪些
// 无 this 的函数要暴露进 .wasm 导出表，供浏览器 JS 直接调用。编译器会自动
// 收集这些标记、注入链接器 --export，并在 .wasm 旁生成 .exports.json 说明。

package mathlib {
    // 顶层函数：无别名，JS 用 C 符号名直接调用 instance.exports.add(1, 2)。
    [WasmExport]
    function add(a:int, b:int):int {
        return a + b;
    }

    // 带别名：JS 用 multiply 调用，而非长符号名。
    [WasmExport("multiply")]
    function mul(a:int, b:int):int {
        return a * b;
    }

    // 静态方法：符号名是 mathlib_Calc_twice，用别名 twice 导出。
    class Calc {
        [WasmExport("twice")]
        public static function twice(a:int):int {
            return a * 2;
        }
    }
}

trace(add(3, 4));
trace(mul(6, 7));
trace(Calc.twice(21));
