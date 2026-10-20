@echo off
rem Build the "Probe" ANE fixture -- the ONE native extension that examples/ane/ and
rem examples/ane-app/ share.
rem
rem Why a script rather than a loose command line: those two examples reach the same
rem extension by two different routes (a manifest's `ane-paths` versus an application
rem descriptor's <extensions>), and they are the before/after pair a reader compares.
rem build.bat therefore compiles the source ONCE and copies the result into BOTH
rem staging trees, so the two cannot come to disagree about what com.example.probe is.
rem Nothing in the build enforces that: they are two independent directories, and a
rem tree that lost its descriptor still compiles and still links -- the only symptom
rem is `as_ane_load` failing at run time, on one example, on one platform. Hence the
rem descriptor guard per tree and the import-table guard on the artifact below.
rem
rem The import table is the whole point of the recipe. ProbeANE.c is written the way a
rem REAL ANE is written: it includes the AIR SDK's header name, registers a function
rem table from the context initializer, reads arguments with FREGetObjectAs* and
rem answers with FRENewObjectFrom*. Two things make it AOT-loadable without AIR:
rem
rem   - `shim\FlashRuntimeExtensions.h` sits AHEAD of the extension's own directory on
rem     the include path, so that header name resolves to the asaot ABI and the source
rem     tree stays unmodified;
rem   - asaot.lib, not Adobe AIR's import library, is what gets linked, so the DLL
rem     records `asaot.dll`. There is no Adobe AIR runtime next to an AOT executable to
rem     satisfy the other import, even though the FRE function table is identical.
rem
rem /MD, not the static CRT: the shipped fixture is a dynamic-CRT build (it imports
rem VCRUNTIME140.dll + api-ms-win-crt-*). Measured on this machine, the same source
rem built /MT embeds a second CRT and goes from 18,432 B to 148,480 B -- and the
rem `clang` driver's -fms-runtime-lib=dynamic does NOT change that (the resulting DLL
rem imports neither CRT at all and is 147,456 B), so clang-cl is the driver used here,
rem with /MD spelled the way the MSVC flag set spells it. clang-cl locates the MSVC
rem toolchain by itself: no vcvars is needed for this step.
rem The width is
rem fixed at x86_64 to match the platform key the descriptor declares; --ane-platform
rem follows the manifest's `architecture`, and the two must agree (docs/zh-cn/ane.md
rem 4.7), so an x86 slice here would be a library no build asks for.
rem
rem Intermediates land in temp\ (git-ignored) rather than beside the sources. The
rem staged DLLs are the committed fixture, so those two copies are the only things
rem this script writes into the example trees.
rem
rem The macOS half of this recipe is examples/ane/build-ane.sh -- the same one
rem compile, the same two trees, the same guards, with the platform's own file
rem names (a .dylib linked against libasaot.dylib instead of a .dll against
rem asaot.lib). Neither script can substitute for the other, and the descriptor
rem declares both platform entries so either host finds the one it asks for.
rem
rem Usage: build-ane.bat

setlocal
cd /d "%~dp0"

set "ID=com.example.probe"
set "PLAT=Windows-x86-64"
rem NOT called LIB: clang-cl and lld-link read the MSVC `LIB` environment variable as
rem their library search path, and a `set LIB=ProbeANE.dll` here would take precedence
rem over the toolchain clang-cl detects by itself. The symptom is not an error about the
rem name -- it is `lld-link: error: could not open 'msvcrt.lib'`, i.e. the dynamic CRT
rem the /MD above asks for, reported as if no toolchain were installed. Measured here.
set "DLL=ProbeANE.dll"
set "EX=%~dp0"
set "REPO=%~dp0..\.."
set "SCRATCH=%REPO%\temp\ane-probe-build"

rem The host library must exist before the fixture can link against it. Named here
rem rather than left to the linker, whose message for a missing asaot.lib is about a
rem search path rather than about the library that was never built (the mirror of
rem examples/ane/build-ane.sh's pre-check).
if not exist "%REPO%\lib\bin\windows-x64\asaot.lib" (
  echo [ane] FAILED - lib\bin\windows-x64\asaot.lib is not built
  echo [ane] run lib\build-asaot.bat first
  exit /b 1
)

set "CC=clang-cl"
where %CC% >nul 2>nul || set "PATH=C:\Program Files\LLVM\bin;%PATH%"

if not exist "%SCRATCH%" mkdir "%SCRATCH%"

echo [ane] compiling ProbeANE.c -^> %DLL%
rem /I shim BEFORE the extension's own directory: that is what redirects the AIR SDK
rem header name to the asaot ABI (see the header comment).
rem
rem Compiled with the scratch directory as the working directory, so the .obj/.lib/.exp
rem land there: spelling an output directory as `/Fo:"dir\"` cannot be done from cmd
rem (the trailing backslash escapes the closing quote, and the whole tail of the command
rem line is then swallowed into the path).
pushd "%SCRATCH%"
%CC% /nologo /LD /O2 /MD ^
  /I "%EX%shim" /I "%REPO%\lib" ^
  "%EX%ProbeANE.c" /Fe:%DLL% ^
  /link /LIBPATH:"%REPO%\lib\bin\windows-x64" /INCREMENTAL:NO /MACHINE:X64 asaot.lib
if errorlevel 1 (
  popd
  echo [ane] FAILED - compile/link
  exit /b 1
)
popd

rem --- import-table guard (docs/zh-cn/ane.md 4.5) --------------------------------
rem A DLL that still imports Adobe AIR.dll builds and links perfectly and then fails
rem to load, so the artifact itself is what gets asserted, not the flags above.
llvm-objdump -p "%SCRATCH%\%DLL%" > "%SCRATCH%\dump.txt" 2>&1
if errorlevel 1 (
  echo [ane] FAILED - could not inspect %SCRATCH%\%DLL%
  exit /b 1
)
findstr /c:"DLL Name: asaot.dll" "%SCRATCH%\dump.txt" >nul
if errorlevel 1 (
  echo [ane] FAILED - %DLL% does not import asaot.dll
  exit /b 1
)
findstr /c:"Adobe AIR.dll" "%SCRATCH%\dump.txt" >nul
if not errorlevel 1 (
  echo [ane] FAILED - %DLL% still imports Adobe AIR.dll
  exit /b 1
)
findstr /c:"ProbeExtInitializer" "%SCRATCH%\dump.txt" >nul
if errorlevel 1 (
  echo [ane] FAILED - %DLL% exports no ProbeExtInitializer
  exit /b 1
)

rem --- stage into BOTH trees, guarding each descriptor first ----------------------
for %%T in ("%EX%ext-aot" "%EX%..\ane-app\ext-aot") do (
  findstr /c:"<id>%ID%</id>" "%%~fT\%ID%\extension.xml" >nul
  if errorlevel 1 (
    echo [ane] FAILED - %%~fT\%ID%\extension.xml does not declare %ID%
    exit /b 1
  )
  findstr /c:"<nativeLibrary>%DLL%</nativeLibrary>" "%%~fT\%ID%\extension.xml" >nul
  if errorlevel 1 (
    echo [ane] FAILED - %%~fT\%ID%\extension.xml does not name %DLL%
    exit /b 1
  )
  rem The platform entry too: a descriptor that names the library but not the key it
  rem belongs to would stage a DLL no build ever looks for, and the symptom is the
  rem build refusing the package with "has no <platform name=Windows-x86-64> entry".
  rem (`findstr /r` with `.` standing for the quotes keeps the pattern free of the
  rem embedded `"` a literal /c: search string cannot carry.)
  findstr /r /c:"<platform name=.%PLAT%." "%%~fT\%ID%\extension.xml" >nul
  if errorlevel 1 (
    echo [ane] FAILED - %%~fT\%ID%\extension.xml declares no ^<platform name="%PLAT%"^> entry
    exit /b 1
  )
  if not exist "%%~fT\%ID%\%PLAT%" mkdir "%%~fT\%ID%\%PLAT%"
  copy /y "%SCRATCH%\%DLL%" "%%~fT\%ID%\%PLAT%\%DLL%" >nul
  if errorlevel 1 (
    echo [ane] FAILED - could not stage into %%~fT\%ID%\%PLAT%\
    exit /b 1
  )
  echo [ane] staged -^> %%~fT\%ID%\%PLAT%\%DLL%
)

echo [ane] ok -- one compile, both trees
endlocal
exit /b 0
