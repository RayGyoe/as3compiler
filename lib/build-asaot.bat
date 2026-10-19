@echo off
rem Build the FRE host pair (asaot.dll + asaot.lib) from asaot_host.c.
rem
rem Why a script: the ANE import library must record the module name `asaot.dll`
rem so that a recompiled ANE imports the AOT runtime in place of `Adobe AIR.dll`.
rem Deriving the import library from the linker (rather than llvm-dlltool) keeps
rem ONE source of truth for the export set -- the DLL itself -- because lld names
rem the import library's module after /OUT:. (llvm-lib's /DEF: path silently
rem produces an import library with a BLANK module name; llvm-dlltool needs a
rem separate .def whose first line spells LIBRARY asaot.dll.) The `findstr` guard
rem at the end of :build exists because that blank-module failure is invisible at
rem build time and only surfaces much later, as a recompiled ANE that still wants
rem Adobe AIR.dll.
rem
rem No MSVC toolset is required: clang (LLVM) + lld-link drive both steps, and
rem -fms-runtime-lib=static avoids depending on the MSVC redistributable DLLs.
rem
rem Widths: BOTH hosts are built by default. Which one a build consumes is chosen
rem by --ane-platform (src/ane.ts aneHostDirName), and an extension pack declares
rem its own platform, so building only the width of the machine you happen to sit
rem at is how `--ane-platform Windows-x86` came to be served the 64-bit library
rem while exiting 0. The two hosts differ in exactly ONE flag -- the target triple.
rem asaot_host.c is width-agnostic forwarding code, so a single source serves both;
rem there is no second file to keep in sync, only a second directory.
rem
rem Output is platform-tagged under bin\<platform>\, the layout vendor/ already
rem uses (vendor/sdl2/lib/windows-x64, vendor/curl/lib/windows-x64), so a second host
rem platform is an added directory rather than a reshuffle of this one. What
rem stays in the directory above is the hand-written pair: asaot.h is the ABI
rem contract every ANE is recompiled against, asaot_host.c its implementation.
rem
rem There is deliberately NO ARM64 host here, and that absence is a decision
rem rather than an omission. AIR has no Windows ARM64 runtime, so no extension can
rem declare an ARM64 Windows slice and no runtime would look for one: in AIR SDK
rem 51.4.1 each Windows runtime carries exactly ONE platform key -- win/Adobe AIR.dll
rem says Windows-x86, the win64 one says Windows-x86-64 -- so the closed set is those
rem two, and win/ + win64/ are the only Windows runtimes the SDK ships. On Windows-on-ARM, AIR itself is the x64 build under emulation, so an
rem x64 host library is what gets used there as well. bin\ is where a host
rem platform goes once something can load it -- a third directory would be a
rem library with no consumer, the same reasoning that keeps a wasm/ one out.
rem
rem   bin\windows-x86\asaot.{dll,lib}   i686-pc-windows-msvc
rem   bin\windows-x64\asaot.{dll,lib}   x86_64-pc-windows-msvc
rem
rem Usage:
rem   build-asaot.bat        build BOTH hosts (same as `all`)
rem   build-asaot.bat all    build BOTH hosts
rem   build-asaot.bat x86    rebuild only bin\windows-x86\
rem   build-asaot.bat x64    rebuild only bin\windows-x64\
rem
rem Any other argument is an ERROR, not a skip: silently building nothing (or the
rem wrong width) is the failure mode this default exists to remove.

setlocal
cd /d "%~dp0"

set "CLANG=clang"
where %CLANG% >nul 2>nul || set "PATH=C:\Program Files\LLVM\bin;%PATH%"

set "WHICH=%~1"
if "%WHICH%"=="" set "WHICH=all"

if /i "%WHICH%"=="all" (
  call :build windows-x86 i686-pc-windows-msvc
  if errorlevel 1 exit /b 1
  call :build windows-x64 x86_64-pc-windows-msvc
  if errorlevel 1 exit /b 1
  echo [asaot] ok -- both hosts
  exit /b 0
)
if /i "%WHICH%"=="x86" (
  call :build windows-x86 i686-pc-windows-msvc
  if errorlevel 1 exit /b 1
  echo [asaot] ok -- windows-x86
  exit /b 0
)
if /i "%WHICH%"=="x64" (
  call :build windows-x64 x86_64-pc-windows-msvc
  if errorlevel 1 exit /b 1
  echo [asaot] ok -- windows-x64
  exit /b 0
)

echo [asaot] unknown argument: %WHICH%
echo [asaot] expected one of: all, x86, x64   (no argument = all)
exit /b 2

rem -------------------------------------------------------------------- :build
rem %1 = platform directory under bin\, %2 = clang target triple.
rem Its own setlocal, so PLATFORM/TRIPLE cannot leak into the next width.
:build
setlocal
set "PLATFORM=%~1"
set "TRIPLE=%~2"
set "OUT=bin\%PLATFORM%"
if not exist "%OUT%" mkdir "%OUT%"

echo [asaot] %PLATFORM%: compiling asaot_host.c -^> %OUT%\asaot.dll + %OUT%\asaot.lib
%CLANG% --target=%TRIPLE% -fms-runtime-lib=static -O2 -shared ^
  -Wall -Wextra -DASAOT_BUILD -I. asaot_host.c -o %OUT%\asaot.dll ^
  -Wl,/IMPLIB:%OUT%\asaot.lib

if errorlevel 1 (
  echo [asaot] %PLATFORM%: FAILED
  endlocal
  exit /b 1
)

rem The import library must name the forwarder module (see the header comment:
rem a blank module name is build-time-silent and load-time-fatal for every ANE).
findstr /c:"asaot.dll" "%OUT%\asaot.lib" >nul 2>nul
if errorlevel 1 (
  echo [asaot] %PLATFORM%: FAILED - %OUT%\asaot.lib does not name asaot.dll
  endlocal
  exit /b 1
)

echo [asaot] %PLATFORM%: ok
endlocal
exit /b 0
