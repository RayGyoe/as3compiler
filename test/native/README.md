# Native integration probes

Run from the compiler checkout on macOS with an available GUI session:

```sh
mkdir -p temp/desktop-interaction
clang++ -std=c++17 -I vendor test/native/native-drag-macos.mm \
  vendor/native_drag_macos.mm -framework Cocoa \
  -o temp/desktop-interaction/native-cocoa-probe
temp/desktop-interaction/native-cocoa-probe
```

This uses real NSWindow/NSView and NSPasteboard objects, with synthetic
NSDraggingInfo messages. It checks Unicode multi-file/text/URL transport,
synchronous operation feedback, idempotent attachment and restoration of the
original view class. It is not a Finder gesture or a drag-source acceptance test.
The ordinary unit suite tests the generated AS3 runtime with an injected C ABI.
