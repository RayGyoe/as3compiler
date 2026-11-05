# Native file dialogs

```sh
node src/index.ts --air-app examples/desktop-files/app.xml --main-class Main --package app -o temp/DesktopFiles
open temp/DesktopFiles.app
```

Run from the compiler checkout root. The macOS panel path has been exercised. Windows Shell/OLE sources are included but are disabled by default: the existing ACP filesystem boundary must be migrated to UTF-8 first. They have not been compiled or tested on Windows.
The example uses standard AIR APIs and can also be compiled with the AIR SDK.

Choose a disposable text file to test Open / Read file. Multiple and FR list
exercise the two distinct list APIs. Save path only selects a destination;
Save text writes sample UTF-8 text after confirmation. Cancel calls cancel()
on the active IO objects; as in AIR, this does not dismiss an open browse panel.
Use the panel's own Cancel button to dismiss it.

The highlighted drop area accepts files/text/URLs with COPY. Drag from it to export
the last dropped file, or sample text before any file is dropped. Source start and
complete events are logged. Finder/editor acceptance and the full interaction
matrix still need manual verification. On Windows, custom drag images are not yet
implemented. See
[implementation status](../../docs/zh-cn/desktop-file-interaction.md).
