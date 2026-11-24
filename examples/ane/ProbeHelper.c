/*
 * ProbeHelper -- the SIBLING dependency of ProbeANE.dll (stage 464).
 *
 * A real ANE often ships helper DLLs beside its main library (codec cores,
 * vendor SDKs). The Win32 loader's DEFAULT search order never includes the
 * directory of a DLL loaded by full path, so ProbeANE.dll's import of this
 * library fails with error 126 even though the file sits right next to it --
 * unless the host loads with LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR. This fixture is
 * that reproduction: one exported function, no FRE surface of its own.
 *
 * Windows-only by design: the macOS half of the fixture (build-ane.sh) does not
 * build this file, and ProbeANE.c guards the import with _WIN32, so the shared
 * fixture stays byte-identical in behaviour on the other platform.
 */

#ifdef _WIN32
  #define HELPER_EXPORT __declspec(dllexport)
#else
  #define HELPER_EXPORT __attribute__((visibility("default")))
#endif

HELPER_EXPORT int ProbeHelperValue(void) {
    return 4242;
}