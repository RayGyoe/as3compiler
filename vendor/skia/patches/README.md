# vendor/skia 的本地补丁

`vendor/skia/lib/` 里是**预编译好的** Skia 静态库（macOS arm64 / wasm / Windows 各一份）。
其中 **macOS arm64 那一份不是官方预编译产物**，而是从 `build-tools/skia-src`（完整 Skia m124 源码树）
自行编译、并带回下列本地补丁的产物。换机器/换 CI 时，要么从同一个源码树重编，要么先打这些补丁再编。

| 补丁 | 目标文件 | 为什么 |
|---|---|---|
| `skia-m124-ct-exact-copy-keep-face.patch` | `src/utils/mac/SkCTFontCreateExactCopy.cpp` | CoreText 在「同族同 PS 名的两个字体文件」间会换脸（阶段一百六十七）。详见 `docs/zh-cn/skia.md` §6.9 |

重编 + 部署（本机实测约 3 秒）：

```bash
cd build-tools/skia-src
patch -p1 < ../patches/skia-m124-ct-exact-copy-keep-face.patch   # 只在干净源码树上需要
ninja -C out/macos-arm64 skia                                    # 增量：编 1 个 .cpp + 重打 libskia.a
cp out/macos-arm64/libskia.a as3compiler/vendor/skia/lib/macos-arm64/libskia.a
```

> 补丁只作用于 `SK_BUILD_FOR_MAC || SK_BUILD_FOR_IOS` 分支，**wasm / Windows 的库不受影响**，
> 二者的预编译产物无需同步。
