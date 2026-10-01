# vendor/curl — self-contained static HTTP client (macOS arm64)

Static archives for the native `flash.net` HTTP backend (`ASC_HAVE_CURL`,
see [`docs/zh-cn/flash-net.md`](../../docs/zh-cn/flash-net.md) §4.1.1).

Linked **statically** so the produced executable has no `libcurl.4.dylib`
dyld dependency — the only remaining dependencies are Apple frameworks that
ship with every macOS (`Security`, `CoreFoundation`, `CoreServices`,
`SystemConfiguration`).

| archive | version | purpose |
|---|---|---|
| `lib/macos-arm64/libcurl.a` | 8.11.1 | HTTP/HTTPS client, TLS via **SecureTransport** (system trust store, no CA bundle) |
| `lib/macos-arm64/libnghttp2.a` | 1.64.0 | HTTP/2 (curl has no built-in h2 implementation) |
| `lib/macos-arm64/libz.a` | 1.3.1 | `Content-Encoding: gzip/deflate` decoding |

Build recipe (reproducible): [`build-tools/curl-src/build-static.sh`](../../../build-tools/curl-src/build-static.sh).

Link line:

```
-L<repo>/as3compiler/vendor/curl/lib/macos-arm64 -lcurl -lnghttp2 -lz \
  -framework CoreFoundation -framework CoreServices \
  -framework Security -framework SystemConfiguration
```

`libz.a` is shipped alongside `libcurl.a` on purpose: `-lz` must resolve to a
static archive here, otherwise the dynamic `/usr/lib/libz.1.dylib` creeps back
into the link. Any `-L` to this directory therefore wins over the system search
path for both `-lcurl` and `-lz`.

Licenses: `LICENSE.curl` (curl), `LICENSE.nghttp2` (nghttp2), `LICENSE.zlib`
(zlib).