<#
.SYNOPSIS
  在 Windows 上把 as3compiler 所需的本地依赖库（Skia / SDL2 / curl）从源码编译出来，
  产物直接落到 as3compiler/vendor/<pkg>/ 里 —— **x64 与 x86（win32）两套**，
  由 AIR 描述符的 <application><architecture>（"32" / "64"，**缺省 32**）决定用哪一套。

.DESCRIPTION
  背景：build-tools/ 不在 git 里（Windows 上 clone 本仓库不会有它），所以本脚本自己把源码下到
  build-tools/ 下再编译；而 vendor/ 在 git 里，产物落在那里才能被后续复用/提交。

  为什么必须是 MSVC ABI（而不是 MinGW-w64）——这是实测出来的硬约束：
    Skia 的 gn 里写死了 `if (is_win) { set_default_toolchain("//gn/toolchain:msvc") }`
    （gn/BUILDCONFIG.gn），Windows 上根本没有 GCC/MinGW toolchain；而且 msvc_toolchain 只在
    `clang_win` 非空时才把 cl 换成 clang-cl.exe + lld-link.exe。于是：
      * 编 Skia 绕不开 MSVC ABI（需要装 MSVC Build Tools 的头/库 + Windows SDK，编译器可用 clang-cl）；
      * MSVC ABI 的静态库与 GNU/MinGW ABI 的不能互链，所以 SDL2 / curl 也必须编成 MSVC ABI。
    结论：三个库一律用 LLVM 的 clang-cl 编（clang 前端 + MSVC ABI），产物是 .lib。

  为什么编译侧改动可以很小：
    clang-cl 只负责产出这些「库」；程序本体用 `clang --target=<三元组>`（64 位
    x86_64-pc-windows-msvc / 32 位 i686-pc-windows-msvc；GNU 风格驱动、但目标 ABI 同为 MSVC）
    来编即可——它接受 src/build.ts 现在生成的那套 GNU 风格旗标（-O2 -I -L -l -o），产出的
    COFF 目标文件与上面的 .lib 同 ABI，可直接互链。

  前置需求（脚本会自检并给出下载地址）：
    1. Visual Studio 2022 生成工具，工作负载勾「使用 C++ 的桌面开发」（MSVC x86/x64 工具集 + Windows SDK）。
    2. LLVM/clang（含 clang-cl.exe）：https://github.com/llvm/llvm-project/releases
       安装时勾 "Add LLVM to the system PATH"，或设环境变量 LLVM_HOME 指向安装根目录。
    3. Git（拉 Skia 源码）、Python 3（跑 Skia 的 git-sync-deps / fetch-gn / fetch-ninja）。
    4. CMake（编 SDL2/curl）。Ninja 由脚本自动取（Skia 自带 fetch-ninja），你也可以自己装一个。

  用法（PowerShell）：
    cd as3compiler\vendor
    powershell -ExecutionPolicy Bypass -File .\build-windows-deps.ps1
    常用开关：-Arch both|x64|x86（缺省 both）   -Only skia,sdl2,curl
              -SkipSkia / -SkipSdl2 / -SkipCurl
              -Clean（清构建目录重编） -SkipDownload（源码下好了，跳过下载） -LlvmHome 'C:\Program Files\LLVM'

  产物布局（<arch> = windows-x64 | windows-x86）：
    vendor/skia/lib/<arch>/*.lib               （无 lib 前缀：skia.lib / skottie.lib / libpng.lib ...）
    vendor/sdl2/<arch>/{include,lib}           （SDL2.lib / SDL2main.lib）
    vendor/curl/{include,lib/<arch>}           （curl.lib / nghttp2.lib / zlib.lib / z.lib）

  注意：Skia 编一次很久（30~60 分钟、几千个 C++ 文件），属正常，不是卡死。两套位宽就是两棵
  独立的 out 目录，时间与磁盘大致翻倍。

  x86 的已知障碍（脚本自动处理并响亮报明）：
    Skia 的 gn 在 x86 上强制要求 `$win_sdk/bin/SetEnv.cmd /x86`（gn/toolchain/BUILD.gn），源码注释
    自陈「本地 MSVC 安装不支持 x86 构建」——那是给 Chromium 式「下载的 toolchain 资产」准备的旧
    脚本，新版 Windows Kits 里通常没有。缺它时脚本会对下载下来的 Skia 源码打一处**最小工具链
    补丁**（仅当 clang_win 非空时跳过 env_setup，cl.exe 路径一字不改），并打印改了什么。这是
    「上游不受支持」的地带，所以构建后脚本会**核对产物真实位宽**（dumpbin / llvm-readobj），
    对不上就报错，而不是让一份 x64 的 .lib 冒充 x86 静默出货。

  Windows 上的已知障碍（脚本自动处理并响亮报明）：
    * Windows 自带的 tar.exe（bsdtar）在未开「开发者模式」/无「创建符号链接」特权时解不了 tarball
      里的符号链接，而 SDL2 的发布包里正好有两条（android-project-ant/{src,AndroidManifest.xml}，
      指向 android-project 里同一份源码，是给已废弃的 Ant 版 Android 工程模板用的，与 Windows
      构建无关）→ 整个解包被判失败。脚本只对“这种 Can't create 失败”自愈：排除这些条目重解一次，
      并把跳过的条目逐条列出；其它任何解包错误一律原样响亮抛错。
    * LLVM 23 起 clang 的 resource dir **只用主版本号**（lib/clang/23，不再是 X.Y.Z），而 Skia m124
      的 gn/highest_version_dir.py 正则写死 X.Y.Z，扫不到就 IndexError 把 gn gen 整个搞挂 —— 脚本
      自己算出 clang_win_version 写进 args.gn，绕开那个脆弱探测。
    * clang 23 删除了裸 builtin __builtin_ia32_vcvtph2ps256，而 m124 自带的 skcms 正用它做
      f16->f32 的 AVX2 快速路径 —— 脚本照抄上游 skcms 的最小修法（_Float16 +
      __builtin_convertvector）打补丁，不降级、不失速。
    * dng_sdk 的 dng_pthread.cpp 用 std::auto_ptr，而 MSVC STL 在 /std:c++17 下把它移除了
      （yvals_core.h: _HAS_AUTO_PTR_ETC = !_HAS_CXX17）—— Windows + MSVC STL 独有的必然失败，
      与 clang 版本无关。脚本只给 dng_sdk 这一个 target 加 _HAS_AUTO_PTR_ETC=1，Adobe 源码一字不改。
    * Skia 自己的 GrD3DUtil.h 声明 std::wstring/std::string 却没 include <string>，同样依赖了
      MSVC STL 旧版的间接包含 —— 脚本补一行显式 include。

.NOTES
  所有版本 pin 死，且与 build-tools/ 里既有的 macOS/wasm 构建同源，避免「头文件配另一份实现」的
  ABI 漂移（docs/zh-cn/skia.md §6.5 的告诫）。Skia 的 args.gn 刻意镜像 out/macos-arm64/args.gn，
  只把 target 换成 win、关掉 Metal/PDF/XPS、打开 win 上默认关着的 piex，从而让链接库集合保持 1:1。
#>

[CmdletBinding()]
param(
  # 目标位宽。both = 两套都产（对应 AIR 描述符 <architecture> 可 32 也可 64）。
  [ValidateSet('x64', 'x86', 'both')]
  [string]$Arch = 'both',

  # 只构建其中一部分：skia / sdl2 / curl
  [ValidateSet('skia', 'sdl2', 'curl')]
  [string[]]$Only,

  [switch]$SkipSkia,
  [switch]$SkipSdl2,
  [switch]$SkipCurl,

  # 清掉构建输出目录（不动已下载的源码，便于重编）
  [switch]$Clean,

  # 源码已下好，跳过下载/解包
  [switch]$SkipDownload,

  # LLVM 安装根目录（含 bin\clang-cl.exe）。默认取 $env:LLVM_HOME，或自动探测。
  [string]$LlvmHome = $env:LLVM_HOME,

  # 并行任务数。0 = 按 CPU 核数。
  [int]$Jobs = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- pin 死的版本
$SkiaBranch = 'chrome/m124'                                        # 与 build-tools/skia-src 同源（SK_MILESTONE 124）
$SkiaCommit = '03c4671cffded59a3bb00e18bfae3c2763424fc6'
$Sdl2Version = '2.32.10'
$CurlVersion = '8.11.1'
$Nghttp2Version = '1.64.0'
$ZlibVersion = '1.3.1'

$Urls = @{
  sdl2    = "https://github.com/libsdl-org/SDL/releases/download/release-$Sdl2Version/SDL2-$Sdl2Version.tar.gz"
  curl    = "https://curl.se/download/curl-$CurlVersion.tar.gz"
  nghttp2 = "https://github.com/nghttp2/nghttp2/releases/download/v$Nghttp2Version/nghttp2-$Nghttp2Version.tar.gz"
  # zlib.net 的当前版本在根目录，历史版本在 /fossils/。
  zlib    = "https://zlib.net/fossils/zlib-$ZlibVersion.tar.gz"
}

# ---------------------------------------------------------------- 路径
$Vendor   = $PSScriptRoot
$AsDir    = Split-Path $Vendor -Parent            # .../as3compiler
$RepoRoot = Split-Path $AsDir -Parent             # .../as3compiler-aot
$BuildTools = Join-Path $RepoRoot 'build-tools'
$DlDir      = Join-Path $BuildTools 'win-deps-dl'      # 源码压缩包 + 解包

$script:NinjaExe = $null

# 每套位宽一套独立的中间前缀与构建目录：x64 与 x86 的 .lib 绝不能混进同一个前缀，否则 curl 的
# find_library(zlib / nghttp2) 会跨位宽取到对方那一份，链接期报 LNK1112 机器类型冲突。
function Curl-Prefix([string]$arch) { return (Join-Path $BuildTools "win-deps-prefix-$arch") }
function Build-DirFor([string]$pkg, [string]$arch) { return (Join-Path $BuildTools "win-build-$pkg-$arch") }

# ---------------------------------------------------------------- 输出小工具
function Write-Step([string]$m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Write-Ok([string]$m)   { Write-Host "  [ok] $m" -ForegroundColor Green }
function Write-Info([string]$m) { Write-Host "  $m" -ForegroundColor Gray }
function Write-Note([string]$m) { Write-Host "  [warn] $m" -ForegroundColor Yellow }
function Fail([string]$m)       { throw $m }

# 取最近一条原生命令的退出码。不直接读 $LASTEXITCODE：StrictMode 下它可能尚未定义。
function Get-ExitCode {
  $c = Get-Variable -Name LASTEXITCODE -Scope Global -ValueOnly -ErrorAction SilentlyContinue
  if ($null -eq $c) { return 0 }
  return [int]$c
}
function Assert-Ok([string]$what) {
  $c = Get-ExitCode
  if ($c -ne 0) { Fail "$what 失败（exit code $c）" }
}

function To-Fwd([string]$p) { return ($p -replace '\\', '/') }   # gn / CMake 里用的正斜杠

function New-CleanDir([string]$p) {
  if (Test-Path $p) { Remove-Item -Recurse -Force $p }
  New-Item -ItemType Directory -Force -Path $p | Out-Null
}

function Find-Exe([string]$name) {
  $c = Get-Command $name -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  return $null
}

function Require-Exe([string]$name, [string]$hint) {
  $p = Find-Exe $name
  if (-not $p) { Fail "找不到 $name。$hint" }
  Write-Ok "$name -> $p"
  return $p
}

# ---------------------------------------------------------------- 0. 目录
New-Item -ItemType Directory -Force -Path $BuildTools | Out-Null
New-Item -ItemType Directory -Force -Path $DlDir | Out-Null
Write-Ok "build-tools: $BuildTools"
Write-Ok "vendor:      $Vendor"

# ---------------------------------------------------------------- 1. 要构建哪些
$Want = @()
if ($Only) { $Want = @($Only) } else { $Want = @('skia', 'sdl2', 'curl') }
if ($SkipSkia) { $Want = @($Want | Where-Object { $_ -ne 'skia' }) }
if ($SkipSdl2) { $Want = @($Want | Where-Object { $_ -ne 'sdl2' }) }
if ($SkipCurl) { $Want = @($Want | Where-Object { $_ -ne 'curl' }) }
if ($Want.Count -eq 0) { Fail '没有要构建的目标（-Only / -Skip* 全被关掉了）。' }

# 位宽列表。x64 与 x86 是两棵独立的 Skia out 目录、两套 CMake 构建目录、两个中间前缀。
$Arches = @()
if ($Arch -eq 'both') { $Arches = @('x64', 'x86') } else { $Arches = @($Arch) }
Write-Step "本次要构建：$($Want -join ', ')   位宽：$($Arches -join ', ')"

if ($Jobs -le 0) { $Jobs = [int]$env:NUMBER_OF_PROCESSORS; if ($Jobs -le 0) { $Jobs = 4 } }
Write-Info "并行任务数：$Jobs"

# ---------------------------------------------------------------- 2. 环境自检
Write-Step '环境自检'

$NeedCmake = ($Want -contains 'sdl2') -or ($Want -contains 'curl')
$NeedGit   = ($Want -contains 'skia')
$NeedTar   = $NeedCmake

# Windows 上的 `python` 常常不是真解释器，而是商店的「应用执行别名」
# （C:\...\WindowsApps\python.exe，0 字节的 ReparsePoint）：Copy-Item 它会直接抛
# "The file cannot be accessed by the system."（实测）。而且**不能**把解释器单独拷到别处做垫片 ——
# python.exe 依赖同目录的 pythonXX.dll 与 Lib\，单独拷一份一启动就哑火（实测无任何输出）。
# 正确做法：定位真解释器**自己的目录**（home = 同时有 python.exe 与 pythonXY.dll），把它放到
# PATH 最前；缺哪个名字就在**该目录内部**补 —— 同目录才有 DLL，拷/链到别处都不可用。
function Test-PythonHome([string]$dir) {
  if (-not $dir -or -not (Test-Path $dir)) { return $false }
  $exe = Join-Path $dir 'python.exe'
  if (-not (Test-Path $exe)) { return $false }
  # 真解释器目录必带 pythonXY.dll；商店别名目录没有，单独拷贝出来的 exe 也缺。
  $hasDll = [bool](@(Get-ChildItem -Path $dir -Filter 'python3*.dll' -File -ErrorAction SilentlyContinue |
                     Where-Object { $_.Name -match '^python3\d+\.dll$' }).Count)
  if (-not $hasDll) { return $false }
  # 光有文件还不够：商店版 Python 的**包目录**（C:\Program Files\WindowsApps\PythonSoftware...）
  # 同样含 python.exe + python3X.dll，但 ACL 受限，**直接执行会 Access denied**（只有商店别名桩能
  # 拉起它）。而 gn / fetch-gn / git-sync-deps 要的是一个能直接跑的 exe，故此处必须真跑一次确认，
  # 否则会选到一个「看着像真 home、实则跑不起来」的目录，等到 Skia 那步才炸。
  try {
    & $exe -c 'import sys' 1>$null 2>$null
  } catch { return $false }
  return ((Get-ExitCode) -eq 0)
}

function Resolve-PythonHome {
  $cands = @()
  # 0) 显式覆盖
  if ($env:ASC_PYTHON_HOME) { $cands += $env:ASC_PYTHON_HOME }
  # 1) PATH 上解析到的 python 所在目录（若非商店别名，常常就是真 home）
  # 2) 直接问能跑的 python 要 sys.prefix（商店版也能答，且答出的是真 home）
  foreach ($n in @('python3', 'python')) {
    $p = Find-Exe $n
    if (-not $p) { continue }
    $cands += (Split-Path $p -Parent)
    $prefix = (& $p '-c' 'import sys;print(sys.prefix)' 2>$null | Select-Object -Last 1)
    if ($prefix) { $cands += ('' + $prefix).Trim() }
  }
  # 3) pyenv-win 的版本目录（自带 python.exe + python3.exe + pythonXY.dll，且可写）
  $pyenvRoot = if ($env:PYENV_ROOT) { $env:PYENV_ROOT } else { Join-Path $env:USERPROFILE '.pyenv\pyenv-win' }
  $cands += @(Get-ChildItem -Path (Join-Path $pyenvRoot 'versions') -Directory -ErrorAction SilentlyContinue |
              Sort-Object Name -Descending | ForEach-Object { $_.FullName })
  # 4) 常见布局：python.org 安装器 / scoop / 盘根目录
  if ($env:LOCALAPPDATA) {
    $cands += @(Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Programs\Python') -Directory -ErrorAction SilentlyContinue |
                ForEach-Object { $_.FullName })
  }
  foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, 'C:\')) {
    if (-not $base) { continue }
    $cands += @(Get-ChildItem -Path $base -Filter 'Python3*' -Directory -ErrorAction SilentlyContinue |
                ForEach-Object { $_.FullName })
  }
  if ($env:USERPROFILE) {
    $cands += @(Get-ChildItem -Path (Join-Path $env:USERPROFILE 'scoop\apps') -Filter 'python*' -Directory -ErrorAction SilentlyContinue |
                ForEach-Object { Join-Path $_.FullName 'current' })
  }
  foreach ($c in $cands) {
    if (Test-PythonHome $c) { return (Resolve-Path $c).Path }
  }
  return $null
}

$PythonHome = Resolve-PythonHome
if (-not $PythonHome) {
  Fail '找不到可用的 Python 3 解释器（需真解释器目录，即同时含 python.exe 与 pythonXY.dll，且该 python.exe 能被直接执行）。安装：https://www.python.org/downloads/windows/（勾 Add python.exe to PATH），或用环境变量 ASC_PYTHON_HOME 直接指定解释器所在目录。'
}
$PythonExe = Join-Path $PythonHome 'python.exe'
Write-Ok "python -> $PythonExe"

# Skia 的 gn 在生成阶段会用 exec_script 调 python；不同版本的 gn 认的名字不一样（python 或 python3）。
# 真 home 通常两个名字都有（python.org 3.10+ / pyenv 都有）；缺哪个就在 home 内部补一个，
# 这样 gn 按名找不到时也能落到同一个真解释器上。
foreach ($n in @('python3.exe', 'python.exe')) {
  $t = Join-Path $PythonHome $n
  if (Test-Path $t) { continue }
  try {
    New-Item -ItemType HardLink -Path $t -Target $PythonExe -ErrorAction Stop | Out-Null
    Write-Info "已在 python home 内补 $n（硬链接）"
  } catch {
    try {
      Copy-Item $PythonExe $t -Force -ErrorAction Stop
      Write-Info "已在 python home 内补 $n（拷贝）"
    } catch {
      Write-Note "无法在 $PythonHome 内补 $n（目录只读？）：$($_.Exception.Message)"
    }
  }
}
$env:PATH = "$PythonHome;$env:PATH"
Write-Ok "python home 已置于 PATH 最前：$PythonHome"

$GitExe = $null
if ($NeedGit) { $GitExe = Require-Exe 'git' '安装 Git for Windows：https://git-scm.com/download/win' }
$TarExe = $null
if ($NeedTar) { $TarExe = Require-Exe 'tar' 'Windows 10+ 自带 tar.exe；缺失时可从 Git 安装目录的 usr\bin 复制。' }
# cmake 的定位放在「MSVC 环境」之后 —— 要借用 $vsPath 才能发现 Visual Studio 自带的那一份 CMake。
$CmakeExe = $null

# ---------------------------------------------------------------- 3. MSVC 环境
# clang-cl 用 MSVC 前端语义，需要 MSVC 的头/库与 Windows SDK；gn 的 win toolchain 也需要
# win_vc / win_sdk。注意 x64 与 x86 的**头/库路径不同**（INCLUDE/LIB 指向各自架构那一份），
# 所以每套位宽都要单独导入一次环境 —— 这正是 Import-MsvcEnv 存在的原因。
Write-Step '导入 MSVC 构建环境（vcvarsall）'

$pf86 = ${env:ProgramFiles(x86)}
$vswhere = $null
if ($pf86) { $vswhere = Join-Path $pf86 'Microsoft Visual Studio\Installer\vswhere.exe' }
if (-not ($vswhere -and (Test-Path $vswhere))) {
  Fail @'
找不到 vswhere.exe，说明没装 Visual Studio / Build Tools。
请安装「Visual Studio 2022 生成工具」，工作负载勾选「使用 C++ 的桌面开发」（会带上 MSVC x86/x64 工具集与 Windows SDK）。
下载页：https://visualstudio.microsoft.com/downloads/  → "Tools for Visual Studio" → Build Tools
'@
}
$vsPath = & $vswhere '-latest' '-products' '*' '-requires' 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64' '-property' 'installationPath'
$vsPath = @($vsPath | Where-Object { $_ -and $_.Trim() })[0]
if (-not $vsPath) { Fail 'vswhere 没找到带 VC++ x86/x64 工具集的 VS。请补装「使用 C++ 的桌面开发」工作负载。' }
$vsPath = $vsPath.Trim()
Write-Info "VS 安装路径：$vsPath"

# ---- CMake：优先 PATH，其次 VS 自带的 CMake（「使用 C++ 的桌面开发」工作负载会带一份），
# 再次各家安装器的默认目录。之前只查 PATH，而「CMake 装好了却没进 PATH」是很常见的情形。
function Resolve-Cmake {
  $c = Find-Exe 'cmake'
  if ($c) { return $c }
  $cands = @()
  if ($vsPath) { $cands += (Join-Path $vsPath 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe') }
  if ($env:ProgramFiles) { $cands += (Join-Path $env:ProgramFiles 'CMake\bin\cmake.exe') }
  if (${env:ProgramFiles(x86)}) { $cands += (Join-Path ${env:ProgramFiles(x86)} 'CMake\bin\cmake.exe') }
  if ($env:LOCALAPPDATA) { $cands += (Join-Path $env:LOCALAPPDATA 'Programs\CMake\bin\cmake.exe') }
  if ($env:USERPROFILE) {
    $cands += @(Get-ChildItem -Path (Join-Path $env:USERPROFILE 'scoop\apps\cmake') -Recurse -Filter 'cmake.exe' -File -ErrorAction SilentlyContinue |
                ForEach-Object { $_.FullName })
  }
  foreach ($x in $cands) { if ($x -and (Test-Path $x)) { return (Resolve-Path $x).Path } }
  return $null
}

if ($NeedCmake) {
  $CmakeExe = Resolve-Cmake
  if (-not $CmakeExe) {
    Fail '找不到 cmake。安装 CMake 并加入 PATH：https://cmake.org/download/（或装 Visual Studio 的「使用 C++ 的桌面开发」工作负载，它自带一份 CMake）。'
  }
  Write-Ok "cmake -> $CmakeExe"
}
$vcvarsall = Join-Path $vsPath 'VC\Auxiliary\Build\vcvarsall.bat'
if (-not (Test-Path $vcvarsall)) { Fail "找不到 vcvarsall.bat：$vcvarsall" }

$ComspecPath = $env:COMSPEC
if (-not $ComspecPath) { $ComspecPath = 'cmd.exe' }

# 把 vcvarsall.bat <arch> 的环境导入当前进程。arch 用 vcvarsall 自己的词：x64 / x86。
# 经典手法：在 cmd 里跑完 vcvarsall 再 set，把全部环境变量读回来逐条导入本进程。
function Import-MsvcEnv([string]$arch) {
  $lines = & $ComspecPath /c "`"$vcvarsall`" $arch >nul 2>&1 && set"
  if ((Get-ExitCode) -ne 0) {
    Fail "执行 vcvarsall.bat $arch 失败：$vcvarsall （x86 需要 VC++ x86 工具集，工作负载「使用 C++ 的桌面开发」自带。）"
  }
  foreach ($line in $lines) {
    if ($line -match '^([^=]+)=(.*)$') {
      # 形如 "=C:=C:\..." 的怪条目会因 env: 路径非法而被静默跳过
      Set-Item -Path ('env:' + $matches[1]) -Value $matches[2] -ErrorAction SilentlyContinue
    }
  }
  if (-not $env:VCToolsInstallDir) { Fail "vcvarsall $arch 执行后仍没有 VCToolsInstallDir，环境导入失败。" }
  Write-Ok "已导入 vcvarsall $arch 环境（VSCMD_ARG_TGT_ARCH=$env:VSCMD_ARG_TGT_ARCH）"
}

# 先用第一套位宽导入一次，用来推导 gn 要的 win_vc / win_sdk —— 这两个与位宽无关。
Import-MsvcEnv $Arches[0]

# 从环境推出 gn 要的 win_vc / win_sdk 与版本号（显式给出就不会再调 python 去探测）。
# 统一写成 ('' + $env:X).TrimEnd('\')：环境变量缺失时得到空串而不是 null，避免在 null 上调方法。
$vcTools = ('' + $env:VCToolsInstallDir).TrimEnd('\')          # ...\VC\Tools\MSVC\14.44.35207
$winVc = ''
$winToolchainVersion = ''
if ($vcTools) {
  $winVc = ($vcTools -replace '\\Tools\\MSVC\\[^\\]+$', '')     # ...\VC
  $winToolchainVersion = Split-Path $vcTools -Leaf
  if ($winVc -eq $vcTools) { Fail "VCToolsInstallDir 目录结构异常，推不出 win_vc：$vcTools" }
}
$winSdk = ('' + $env:WindowsSdkDir).TrimEnd('\')               # C:\Program Files (x86)\Windows Kits\10
$winSdkVersion = ('' + $env:WindowsSDKVersion).TrimEnd('\')    # 10.0.22621.0
if (-not $winVc -or -not $winSdk -or -not $winSdkVersion) { Fail '无法从 vcvars 环境推出 win_vc / win_sdk / win_sdk_version。' }
Write-Ok "win_vc  = $winVc  ($winToolchainVersion)"
Write-Ok "win_sdk = $winSdk ($winSdkVersion)"

# ---------------------------------------------------------------- 4. LLVM clang-cl
# clang 资源目录的版本名（$LlvmRoot/lib/clang/<ver>）。为什么要自己算、不交给 gn：
# gn 在 clang_win 非空且 clang_win_version 为空时会跑 gn/highest_version_dir.py 扫这个目录，
# 而那个脚本的正则写死成 X.Y.Z。**LLVM 23 起 resource dir 只用主版本号**（实测 clang 23.1.3
# 的 resource dir 就是 lib/clang/23），正则一项都匹配不上 → sorted(...)[-1] 抛 IndexError
# → gn gen 直接失败（gn/BUILDCONFIG.gn:157，报 "Script returned non-zero exit code"）。所以
# 这里由脚本自己给出，绕开那个脆弱的探测脚本。
# 安全性：clang_win_version 在 Skia 里**只**被 ASAN 分支引用（gn/skia/BUILD.gn:362 的
# $clang_win/lib/clang/$clang_win_version/lib/windows/clang_rt.asan-x86_64.lib），本构建不开
# sanitize，故填任何真实存在的目录名都无害。
function Resolve-ClangResDirVersion([string]$clangCl, [string]$llvmRoot) {
  # 权威来源：直接问 clang 自己 —— 对任何命名方案都成立，不猜。
  $lines = @()
  try { $lines = @(& $clangCl -print-resource-dir 2>$null) } catch { $lines = @() }
  if ($lines.Count -gt 0) {
    $rd = ('' + $lines[0]).Trim()
    if ($rd -and (Test-Path $rd)) { return (Split-Path $rd -Leaf) }
  }
  # 退路：-print-resource-dir 万一不可用时自己扫 lib\clang，取版本号最大的目录名。
  $parent = Join-Path $llvmRoot 'lib\clang'
  $names = @()
  if (Test-Path $parent) {
    $names = @(Get-ChildItem -Directory -Path $parent -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
  }
  if ($names.Count -eq 0) {
    Fail @"
$llvmRoot 下找不到 clang 资源目录（lib\clang\*）—— 这不是一份完整的 LLVM/clang 安装。
请重装 LLVM 并确认含 clang 组件：https://github.com/llvm/llvm-project/releases 选 LLVM-<版本>-win64.exe
（若 LLVM 装在别处，用 -LlvmHome 'C:\...' 或环境变量 LLVM_HOME 指过去。）
"@
  }
  $best = $names[0]
  $bestKey = -1
  foreach ($n in $names) {
    # 目录名可能是 "23" 或 "23.1.3" 或带后缀，取数字段补齐三位再比大小，避免 "23" 被误判小于 "21.1.5"。
    $nums = @()
    foreach ($p in ($n -split '[^0-9]+')) { if ($p -ne '') { $nums += [int]$p } }
    if ($nums.Count -eq 0) { $nums = @(0) }
    while ($nums.Count -lt 3) { $nums += 0 }
    $key = $nums[0] * 1000000 + $nums[1] * 1000 + $nums[2]
    if ($key -gt $bestKey) { $bestKey = $key; $best = $n }
  }
  return $best
}

Write-Step '定位 LLVM clang-cl'

$LlvmRoot = $null
if ($LlvmHome) {
  if (Test-Path (Join-Path $LlvmHome 'bin\clang-cl.exe')) { $LlvmRoot = (Resolve-Path $LlvmHome).Path }
  else { Fail "-LlvmHome / LLVM_HOME 下没有 bin\clang-cl.exe：$LlvmHome" }
} else {
  $cands = @()
  if ($env:ProgramFiles) { $cands += (Join-Path $env:ProgramFiles 'LLVM') }
  if (${env:ProgramFiles(x86)}) { $cands += (Join-Path ${env:ProgramFiles(x86)} 'LLVM') }
  if ($env:LOCALAPPDATA) { $cands += (Join-Path $env:LOCALAPPDATA 'Programs\LLVM') }
  if ($env:USERPROFILE) { $cands += (Join-Path $env:USERPROFILE 'scoop\apps\llvm\current') }
  $cands += 'C:\LLVM'
  # Visual Studio 的「C++ Clang Compiler for Windows」组件会把 clang-cl 装在 VC\Tools\Llvm\<host>\ 下
  # （注意：只装 clang-format/clang-tidy 的常见情形下这个目录里**没有** clang-cl，下面会报明）。
  if ($vsPath) {
    $cands += (Join-Path $vsPath 'VC\Tools\Llvm\x64')
    $cands += (Join-Path $vsPath 'VC\Tools\Llvm')
  }
  foreach ($c in $cands) {
    if ($c -and (Test-Path (Join-Path $c 'bin\clang-cl.exe'))) { $LlvmRoot = (Resolve-Path $c).Path; break }
  }
  if (-not $LlvmRoot) {
    $exe = Find-Exe 'clang-cl'
    if ($exe) { $LlvmRoot = Split-Path (Split-Path $exe -Parent) -Parent }
  }
}
if (-not $LlvmRoot) {
  Fail @'
找不到 clang-cl.exe（全机扫了一遍：PATH / Program Files\LLVM / scoop / Visual Studio 的 VC\Tools\Llvm）。
二选一：
  A) 独立安装 LLVM（推荐，clang-cl + llvm-readobj 齐备）：
       https://github.com/llvm/llvm-project/releases  选 LLVM-<版本>-win64.exe
       装时勾 "Add LLVM to the system PATH"，或用 -LlvmHome 'C:\Program Files\LLVM'（等价环境变量 LLVM_HOME）指定。
  B) 给已装的 Visual Studio 补组件（只需 clang-cl，但脚本的位宽核对还想要 llvm-readobj）：
       Visual Studio Installer → 修改 → 单个组件 → 勾 "C++ Clang Compiler for Windows"。
'@
}
$ClangCl = Join-Path $LlvmRoot 'bin\clang-cl.exe'
Write-Ok "LLVM: $LlvmRoot"
& $ClangCl --version 2>&1 | Select-Object -First 1 | ForEach-Object { Write-Info $_ }
$ClangResDirVersion = Resolve-ClangResDirVersion $ClangCl $LlvmRoot
Write-Ok "clang 资源目录版本：lib/clang/$ClangResDirVersion"

# ---------------------------------------------------------------- 5. ninja
# CMake(-G Ninja) 与 Skia 都要 ninja。系统没有就用 Skia 自带的 fetch-ninja 取一个。
function Resolve-Ninja {
  $n = Find-Exe 'ninja'
  if ($n) { Write-Ok "ninja -> $n"; return $n }
  # Visual Studio 的「使用 C++ 的桌面开发」工作负载自带一份 ninja（就放在 CMake 扩展目录下）。
  # 这比让用户去装 ninja 或先 clone 整个 Skia 取 fetch-ninja 都省事。
  if ($vsPath) {
    $vsNinja = Join-Path $vsPath 'Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja\ninja.exe'
    if (Test-Path $vsNinja) { Write-Ok "ninja -> $vsNinja"; return $vsNinja }
  }
  if ($env:USERPROFILE) {
    $sn = @(Get-ChildItem -Path (Join-Path $env:USERPROFILE 'scoop\apps\ninja') -Recurse -Filter 'ninja.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($sn.Count -gt 0) { Write-Ok "ninja -> $($sn[0].FullName)"; return $sn[0].FullName }
  }
  $src = Join-Path $BuildTools 'skia-src'
  $bundled = Join-Path $src 'third_party\ninja\ninja.exe'
  if ((Test-Path (Join-Path $src 'DEPS')) -and -not (Test-Path $bundled)) {
    Write-Info '本机没有 ninja，用 Skia 的 bin/fetch-ninja 取一个'
    Push-Location $src
    try {
      & $PythonExe bin/fetch-ninja
      Assert-Ok 'fetch-ninja'
    } finally { Pop-Location }
  }
  if (Test-Path $bundled) { Write-Ok "ninja -> $bundled"; return $bundled }
  Fail '找不到 ninja。装一个（choco install ninja / scoop install ninja）再重跑，或先跑本脚本的 Skia 部分（它会自带 fetch-ninja）。'
}

# ---------------------------------------------------------------- 6. 下载/解包
# 解包 tarball，返回被跳过的条目（正常为 0 条）。
#
# 为什么不能只写一句 `tar -xzf`：Windows 自带的 tar.exe（bsdtar）在**没开「开发者模式」/没有
# 「创建符号链接」特权**时建不了符号链接，一遇到就报
#     <归档内相对路径>: Can't create '\\?\C:\...': Invalid argument
# 并在最后以 exit 1 收尾。SDL2 的发布包正好有两条符号链接（android-project-ant/{src,
# AndroidManifest.xml}，指向 android-project 里同一份源码 —— 给已废弃的 Ant 版 Android 工程模板用，
# 与 Windows 构建无关），于是整个解包被判失败 —— 不该让用户手工处理。
#
# 处理原则：**只自愈这一种已知失败，其余一律原样响亮抛错**，不猜、不静默：
#   1) 先原样解包，成功就返回；
#   2) 失败后逐行核对 tar 的输出：只接受上面那种 "Can't create" 行，以及
#      "tar.exe: Error exit delayed from previous errors" 这一行总结；出现任何别的行，
#      说明是别的毛病，把原始输出整段抛出去；
#   3) 删掉半成品目录，把这些条目用 --exclude 逐条排除后再解一次；
#   4) 仍非 0 退出 → 同样整段抛错；
#   5) 成功则把跳过的条目**逐条列出**，让用户看得见「少了什么」。
function Expand-Tarball([string]$file, [string]$destDir) {
  if (Test-Path $destDir) { Remove-Item -Recurse -Force $destDir }

  # PS 5.1 下 $ErrorActionPreference='Stop' + 2>&1 会把原生 stderr 直接升级成**终止性**错误，
  # 所以这里必须临时降到 Continue，才能把 tar 的报错文本拿到手里逐行筛查。
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out = @(& $TarExe -xzf $file -C $DlDir 2>&1)
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prevEap
  if ($code -eq 0) { return @() }

  $blocked = @()
  foreach ($line in $out) {
    $s = ([string]$line).Trim()
    if ($s -eq '') { continue }
    if ($s -match "^([^:]+): Can't create '") { $blocked += $matches[1]; continue }
    if ($s -match '^tar(\.exe)?: Error exit delayed from previous errors') { continue }
    Fail ("解包 $file 失败（exit $code），且不是已知的符号链接问题。tar 原始输出：`n" + ($out -join "`n"))
  }
  if ($blocked.Count -eq 0) {
    Fail ("解包 $file 失败（exit $code），但没有解析出可跳过的条目。tar 原始输出：`n" + ($out -join "`n"))
  }

  Write-Note ("Windows 建不了以下 $($blocked.Count) 条符号链接（需要「开发者模式」或「创建符号链接」特权），已跳过它们重新解包：`n" +
              (($blocked | ForEach-Object { '        ' + $_ }) -join "`n"))

  if (Test-Path $destDir) { Remove-Item -Recurse -Force $destDir }
  $excl = @()
  foreach ($b in $blocked) { $excl += @('--exclude', $b) }
  $ErrorActionPreference = 'Continue'
  $out2 = @(& $TarExe -xzf $file -C $DlDir @excl 2>&1)
  $code2 = $LASTEXITCODE
  $ErrorActionPreference = $prevEap
  if ($code2 -ne 0) {
    Fail ("排除了上述符号链接后，解包 $file 仍然失败（exit $code2）。tar 原始输出：`n" + ($out2 -join "`n"))
  }
  return $blocked
}

function Get-SourceTarball([string]$key, [string]$destDir) {
  $url = $Urls[$key]
  $file = Join-Path $DlDir ($url -split '/')[-1]
  if (Test-Path $file) {
    Write-Ok "已下载，跳过：$file"
  } else {
    Write-Info "下载 $url"
    $curlExe = Find-Exe 'curl.exe'
    if ($curlExe) {
      # 大文件别用 Invoke-WebRequest（PS5.1 下慢且吃内存）；curl.exe 是 Windows 10+ 自带。
      & $curlExe -fL --retry 3 -o $file $url
      Assert-Ok "下载 $key"
    } else {
      Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing
    }
    Write-Ok "下载完成：$file"
  }
  $skipped = @(Expand-Tarball -file $file -destDir $destDir)
  if (-not (Test-Path $destDir)) { Fail "解包后没有预期目录：$destDir" }
  if ($skipped.Count -gt 0) {
    Write-Ok "解包完成（跳过 $($skipped.Count) 条建不了的符号链接）：$destDir"
  } else {
    Write-Ok "解包完成：$destDir"
  }
}

# ---------------------------------------------------------------- 6.5 x86 的 Skia 工具链与产物位宽核对
# Skia 的 gn 在 x86 上强制要 `$win_sdk/bin/SetEnv.cmd /x86`（gn/toolchain/BUILD.gn），源码注释
# 自陈「本地 MSVC 安装不支持 x86 构建」——那是给 Chromium 式「下载的 toolchain 资产」准备的脚本。
# 本机 win_sdk 是新版 Windows Kits 时通常没有它，于是 x86 会在**每一步编译**上都失败。处理办法：
# 仅在缺 SetEnv.cmd 时，对下载下来的 Skia 源码打一处最小补丁 —— 当 clang_win 非空（即用
# clang-cl）时跳过 env_setup；cl.exe 路径的行为一字不改。补丁可重入，且会响亮报明。
#
# 另注（实测 COFF 头 machine 字段）：gn 给 clang-cl 传的是 `-m32`，而 `-m32` 的含义是
# 「**宿主架构**的 32 位」而不是「x86」——在 x64 宿主上它是 i386（0x014c，正确），但在 arm64
# 宿主上会得到 ARMNT（0x01c4）。gn 注释自陈「All our builders are x86-64」，所以标准 x64 构建机
# 上没问题；本例因此不改 gn 的 `-m32`（少改上游），而是靠下面的 Assert-LibBitness 在构建后把任何
# 位宽错位**响亮地**抳出来。本脚本自己的 CMake 构建不用 `-m32`，一律用显式三元组
# `--target=i686-pc-windows-msvc`（实测确实产 I386 COFF，与宿主无关）。
function Repair-SkiaX86Toolchain([string]$src) {
  $gnToolchain = Join-Path $src 'gn\toolchain\BUILD.gn'
  if (-not (Test-Path $gnToolchain)) { Fail "找不到 Skia 工具链文件：$gnToolchain" }

  $setEnv = Join-Path $winSdk 'bin\SetEnv.cmd'
  if (Test-Path $setEnv) {
    Write-Ok "win_sdk 自带 SetEnv.cmd（$setEnv），x86 无需补丁。"
    return
  }
  Write-Note "win_sdk 里没有 bin\SetEnv.cmd：$setEnv"

  # 注意：**两边的换行都要归一化再比对**。Windows 上（git 默认 core.autocrlf=true）Skia 源码是 CRLF；
  # 而本脚本自身也可能是 CRLF 检出 —— PS 5.1 的 here-string 会原样沿用源文件的换行，所以 CRLF
  # 检出时 here-string 也是 CRLF，与归一化成 LF 的文本永远比不中（这就是本补丁在 CRLF 检出下
  # “找不到锚点”假失败的真因；反之在 LF 检出下曾经能过 —— 同一个脚本两副面孔）。写回时恢复目标
  # 文件自己的换行风格。
  $text = [System.IO.File]::ReadAllText($gnToolchain)
  $crlf = $text.Contains("`r`n")
  $norm = if ($crlf) { $text.Replace("`r`n", "`n") } else { $text }

  if ($norm.Contains('ASC-X86-CLANG-PATCH')) {
    Write-Ok 'Skia 工具链已打过 x86 补丁（ASC-X86-CLANG-PATCH），跳过。'
    return
  }
  $old = @'
    if (toolchain_target_cpu == "x86") {
      # Toolchain asset includes a script that configures for x86 building.
      # We don't support x86 builds with local MSVC installations.
      env_setup = "$shell $win_sdk/bin/SetEnv.cmd /x86 && "
    } else if (toolchain_target_cpu == "arm64") {
'@
  $new = @'
    if (toolchain_target_cpu == "x86") {
      # ASC-X86-CLANG-PATCH: 本机 win_sdk（新版 Windows Kits）没有 bin/SetEnv.cmd，而这是上游给
      # 「下载的 toolchain 资产」准备的旧脚本。用 clang-cl 时不需要它：架构由 -m32 定，头/库
      # 路径来自调用方导入的 x86 vcvars 环境，归档由 lld-link /lib 完成（不碰系统库）。
      # 仅 cl.exe 路径保留原行为。
      if (clang_win == "") {
        env_setup = "$shell $win_sdk/bin/SetEnv.cmd /x86 && "
      }
    } else if (toolchain_target_cpu == "arm64") {
'@
  # 这里必须把 here-string 也压成 LF：PS 5.1 的 here-string 沿用源文件换行，本文件是 CRLF 检出时
  # $old 就是 CRLF，跟上面归一化过的 $norm 根本比不中（详见本函数开头的注释）。
  $old = $old.Replace("`r`n", "`n")
  $new = $new.Replace("`r`n", "`n")
  if (-not $norm.Contains($old)) {
    Fail @"
Skia 的 gn/toolchain/BUILD.gn 与预期不符，补丁无法安全套用（上游可能改过这段）。
请手工让 toolchain_target_cpu == "x86" 分支在 clang_win 非空时不设 env_setup，然后加 -SkipDownload 重跑。
文件：$gnToolchain
"@
  }
  $patched = $norm.Replace($old, $new)
  if ($crlf) { $patched = $patched.Replace("`n", "`r`n") }
  [System.IO.File]::WriteAllText($gnToolchain, $patched, (New-Object System.Text.UTF8Encoding($false)))
  Write-Note "已对 Skia 源码打 x86 工具链补丁（跳过 SetEnv.cmd）：$gnToolchain"
  Write-Note '这是「上游不受支持」的地带，本脚本会在构建后核对产物真实位宽。'
}

# ---------------------------------------------------------------- 6.6 skcms 的 f16->f32 builtin
# clang 23 删除了裸 builtin __builtin_ia32_vcvtph2ps256（LLVM 23.1.3 实测报 "use of undeclared
# identifier"，并给一个语义无关的建议），而 Skia m124 自带的那份 skcms 正用它做 f16 -> f32 的
# AVX2 快速路径（modules/skcms/src/Transform_inl.h 的 F_from_Half），于是 skcms_TransformHsw.cc
# 每次都编不过。上游 skcms 早已修过这点（_Float16 向量 + __builtin_convertvector，clang >= 15
# 起可用），m124 里那份早于该修复。
# 这里照抄上游的**最小**修法：保留旧 builtin 给老 clang / 非 clang（不降级），clang >= 15 走
# convertvector —— 与上游行为逐字一致，AVX2 快速路径不变（仍编出 VCVTPH2PS），且对任意 clang
# 版本都安全（所以无条件打，不必探测版本）。可重入；源码与预期不符时响亮报错，绝不静默改。
function Repair-SkcmsClangBuiltin([string]$src) {
  $file = Join-Path $src 'modules\skcms\src\Transform_inl.h'
  if (-not (Test-Path $file)) { Fail "找不到 skcms 源码：$file" }

  $text = [System.IO.File]::ReadAllText($file, (New-Object System.Text.UTF8Encoding($false)))
  if ($text.Contains('ASC-CLANG23-SKCMS-PATCH')) {
    Write-Ok 'skcms 已打过 f16 builtin 补丁（ASC-CLANG23-SKCMS-PATCH），跳过。'
    return
  }
  # Skia 源码在 Windows 上常是 CRLF（Git core.autocrlf）；先归一化再比对，写回时恢复原风格。
  $crlf = $text.Contains("`r`n")
  $norm = $text.Replace("`r`n", "`n")

  $old = @'
#elif defined(USING_AVX_F16C)
    typedef int16_t __attribute__((vector_size(16))) I16;
    return __builtin_ia32_vcvtph2ps256((I16)half);
#else
'@
  $new = @'
#elif defined(USING_AVX_F16C)
    // ASC-CLANG23-SKCMS-PATCH: clang 23 删除了 __builtin_ia32_vcvtph2ps256，改用上游 skcms 的修法：
    // _Float16 向量 + __builtin_convertvector。语义相同（8×f16 -> 8×f32，仍走 VCVTPH2PS），
    // 老 clang / 非 clang 仍走原来的裸 builtin。
#if defined(__clang__) && __clang_major__ >= 15 // for _Float16 support
    typedef _Float16 __attribute__((vector_size(16))) F16;
    return __builtin_convertvector((F16)half, F);
#else
    typedef int16_t __attribute__((vector_size(16))) I16;
    return __builtin_ia32_vcvtph2ps256((I16)half);
#endif // defined(__clang__)
#else
'@
  # here-string 的字面换行在不同 PowerShell 版本下可能是 CRLF 也可能是 LF，两边都归一。
  $old = $old.Replace("`r`n", "`n")
  $new = $new.Replace("`r`n", "`n")

  if (-not $norm.Contains($old)) {
    Fail @"
Skia 的 modules/skcms/src/Transform_inl.h 与预期不符，clang 23 的补丁无法安全套用（上游可能改过这段）。
请手工把 F_from_Half() 的 USING_AVX_F16C 分支改成：
  #if defined(__clang__) && __clang_major__ >= 15
      typedef _Float16 __attribute__((vector_size(16))) F16;
      return __builtin_convertvector((F16)half, F);
  #else
      typedef int16_t __attribute__((vector_size(16))) I16;
      return __builtin_ia32_vcvtph2ps256((I16)half);
  #endif
然后加 -SkipDownload 重跑。文件：$file
"@
  }
  $patched = $norm.Replace($old, $new)
  if ($crlf) { $patched = $patched.Replace("`n", "`r`n") }
  [System.IO.File]::WriteAllText($file, $patched, (New-Object System.Text.UTF8Encoding($false)))
  Write-Note "已对 Skia 源码打 skcms f16 补丁（clang 23 删除了 __builtin_ia32_vcvtph2ps256）：$file"
}

# ---------------------------------------------------------------- 6.7 dng_sdk 的 std::auto_ptr
# dng_sdk 的 dng_pthread.cpp（Windows 上的 pthread 仿真，qDNGThreadSafe=1 时编）用了 std::auto_ptr：
#   std::auto_ptr<trampoline_args> args(...)
# 而 MSVC STL 在 /std:c++17 下把 auto_ptr **移除了**（yvals_core.h: `_HAS_AUTO_PTR_ETC = !_HAS_CXX17`），
# 于是这个 TU 必然编不过（报 "no member named 'auto_ptr' in namespace 'std'"）。注意：这不是 clang
# 版本问题（macOS/Linux 的 libc++/libstdc++ 仍保留 auto_ptr，所以在那边一直编得过），而是
# **Windows + MSVC STL** 独有的；上游 AOSP 的 dng_sdk 至今也还在用 auto_ptr（无上游修法可抄）。
# 处理：只给 dng_sdk 这一个 target 加 `_HAS_AUTO_PTR_ETC=1`（MSVC STL 给这种“C++17 模式编旧代码”
# 提供的官方开关），**Adobe 源码一字不改** —— auto_ptr 的所有权语义保持原样，不会被我方换成
# unique_ptr 而抳动行为。可重入；BUILD.gn 与预期不符时响亮报错。
function Repair-DngSdkAutoPtr([string]$src) {
  $file = Join-Path $src 'third_party\dng_sdk\BUILD.gn'
  if (-not (Test-Path $file)) { Fail "找不到 dng_sdk 构建文件：$file" }

  $text = [System.IO.File]::ReadAllText($file, (New-Object System.Text.UTF8Encoding($false)))
  if ($text.Contains('ASC-DNG-AUTOPTR-PATCH')) {
    Write-Ok 'dng_sdk 已打过 auto_ptr 补丁（ASC-DNG-AUTOPTR-PATCH），跳过。'
    return
  }
  $crlf = $text.Contains("`r`n")
  $norm = $text.Replace("`r`n", "`n")

  $old = @'
  defines = [
    "qDNGReportErrors=0",
    "qDNGThreadSafe=1",
'@
  $new = @'
  defines = [
    # ASC-DNG-AUTOPTR-PATCH: dng_pthread.cpp（Windows 的 pthread 仿真）用 std::auto_ptr，而
    # MSVC STL 在 /std:c++17 下把它移除了（yvals_core.h: _HAS_AUTO_PTR_ETC = !_HAS_CXX17），
    # 这个 TU 必然编不过。只在本 target 内放开官方开关，Adobe 源码一字不改。
    "_HAS_AUTO_PTR_ETC=1",
    "qDNGReportErrors=0",
    "qDNGThreadSafe=1",
'@
  $old = $old.Replace("`r`n", "`n")
  $new = $new.Replace("`r`n", "`n")

  if (-not $norm.Contains($old)) {
    Fail @"
Skia 的 third_party/dng_sdk/BUILD.gn 与预期不符，auto_ptr 补丁无法安全套用（上游可能改过这段）。
请手工给 third_party("dng_sdk") 的 defines 加上 "_HAS_AUTO_PTR_ETC=1"，然后加 -SkipDownload 重跑。
文件：$file
"@
  }
  $patched = $norm.Replace($old, $new)
  if ($crlf) { $patched = $patched.Replace("`n", "`r`n") }
  [System.IO.File]::WriteAllText($file, $patched, (New-Object System.Text.UTF8Encoding($false)))
  Write-Note "已对 Skia 源码打 dng_sdk auto_ptr 补丁（_HAS_AUTO_PTR_ETC=1）：$file"
}

# ---------------------------------------------------------------- 6.8 GrD3DUtil.h 缺 <string>
# Skia 自己的 src/gpu/ganesh/d3d/GrD3DUtil.h 在 163 行声明：
#   std::wstring GrD3DMultiByteToWide(const std::string& str);
# 却从不 include <string> —— 以前靠别的头间接带进来，而 MSVC STL 14.43（/std:c++17）不再间接提供，
# 于是 GrD3DUtil.cpp / GrD3DAMDMemoryAllocator.cpp 双双报 "no type named 'string' in namespace 'std'"。
# 处理：补一行显式 include（IWYU 正解，纯声明可见性，不改任何行为）。可重入。
function Repair-GrD3DUtilStringInclude([string]$src) {
  $file = Join-Path $src 'src\gpu\ganesh\d3d\GrD3DUtil.h'
  if (-not (Test-Path $file)) {
    # 不同 Skia 版本里 D3D 后端的位置可能变（也可能整体移除）。找不到就只提示，不算致命 ——
    # 真有 TU 因此编不过，ninja 会在那里报错，不会静默。
    Write-Note "未找到 Skia 的 GrD3DUtil.h（D3D 后端路径可能变了），跳过 <string> 补丁：$file"
    return
  }

  $text = [System.IO.File]::ReadAllText($file, (New-Object System.Text.UTF8Encoding($false)))
  if ($text.Contains('ASC-D3DUTIL-STRING-PATCH')) {
    Write-Ok 'GrD3DUtil.h 已打过 <string> 补丁（ASC-D3DUTIL-STRING-PATCH），跳过。'
    return
  }
  $crlf = $text.Contains("`r`n")
  $norm = $text.Replace("`r`n", "`n")

  $old = @'
#include "include/core/SkImage.h"
#include "include/gpu/GrTypes.h"
'@
  $new = @'
// ASC-D3DUTIL-STRING-PATCH: 本头文件声明了 std::wstring/std::string，却从不 include <string>；
// MSVC STL 14.43 在 /std:c++17 下不再间接提供它，于是用了本头文件的 TU 全部编不过。
#include <string>

#include "include/core/SkImage.h"
#include "include/gpu/GrTypes.h"
'@
  $old = $old.Replace("`r`n", "`n")
  $new = $new.Replace("`r`n", "`n")

  if (-not $norm.Contains($old)) {
    Fail @"
Skia 的 src/gpu/ganesh/d3d/GrD3DUtil.h 与预期不符，<string> 补丁无法安全套用（上游可能改过这段）。
请手工在 GrD3DUtil.h 的 include 块里补上 #include <string>，然后加 -SkipDownload 重跑。
文件：$file
"@
  }
  $patched = $norm.Replace($old, $new)
  if ($crlf) { $patched = $patched.Replace("`n", "`r`n") }
  [System.IO.File]::WriteAllText($file, $patched, (New-Object System.Text.UTF8Encoding($false)))
  Write-Note "已对 Skia 源码打 GrD3DUtil.h <string> 补丁：$file"
}

# 核对产物真实位宽 —— 防止「x86 目标却编出 x64 对象」这种静默错误一路滑到链接期
# （clang-cl 默认按**宿主**架构 x64 编，Skia 靠 gn 传 -m32；万一那个旗标没生效，产物会错位且安静）。
# 读不出结论时只告警（不假装通过），因为拿不到权威输出时本就无从判定。
function Assert-LibBitness {
  param(
    [Parameter(Mandatory)][string]$Dir,
    [Parameter(Mandatory)][string]$Arch,
    [Parameter(Mandatory)][string]$Label
  )
  $probe = @(Get-ChildItem -Path $Dir -Filter '*.lib' -File | Sort-Object Name | Select-Object -First 3)
  if ($probe.Count -eq 0) { Write-Note "$Label：$Dir 里没有 .lib，跳过位宽核对。"; return }

  $dumpbin = Find-Exe 'dumpbin'
  $readobj = Join-Path $LlvmRoot 'bin\llvm-readobj.exe'
  foreach ($f in $probe) {
    $found = ''
    if ($dumpbin) {
      $out = (& $dumpbin /headers $f.FullName 2>&1 | Out-String)
      # 认全四种：只要认出但与目标不符就是**硬失败**；完全认不出才告警（见下方）。
      # 这对 arm64 宿主尤其重要：gn 的 `-m32` 在那里会给出 ARMNT 而不是 x86。
      if ($out -match 'machine \(x64\)') { $found = 'x64' }
      elseif ($out -match 'machine \(x86\)') { $found = 'x86' }
      elseif ($out -match 'machine \(ARM64\)') { $found = 'arm64' }
      elseif ($out -match 'machine \(ARM\)') { $found = 'arm' }
    }
    if (-not $found -and (Test-Path $readobj)) {
      $out = (& $readobj --file-headers $f.FullName 2>&1 | Out-String)
      if ($out -match 'IMAGE_FILE_MACHINE_AMD64') { $found = 'x64' }
      elseif ($out -match 'IMAGE_FILE_MACHINE_I386') { $found = 'x86' }
      elseif ($out -match 'IMAGE_FILE_MACHINE_ARM64') { $found = 'arm64' }
      elseif ($out -match 'IMAGE_FILE_MACHINE_ARMNT') { $found = 'arm' }
    }
    if (-not $found) {
      Write-Note "$Label：读不出 $($f.Name) 的位宽（无 dumpbin / llvm-readobj 输出），未核对。"
      return
    }
    if ($found -ne $Arch) {
      Fail "$Label 的产物位宽不对：$($f.Name) 是 $found，但目标是 $Arch。工具链旗标未生效或输出目录被污染。"
    }
  }
  Write-Ok "$Label：产物位宽核对通过（$Arch）。"
}

# ---------------------------------------------------------------- 7. Skia
function Build-Skia([string]$arch) {
  Write-Step "构建 Skia（m124 / Windows $arch / clang-cl + lld-link）"

  $src = Join-Path $BuildTools 'skia-src'
  if (-not (Test-Path (Join-Path $src '.git'))) {
    if ($SkipDownload) { Fail "-SkipDownload 指定了，但 $src 里没有 Skia 源码。" }
    Write-Info "clone Skia $SkiaBranch -> $src"
    & $GitExe clone --branch $SkiaBranch --depth 1 https://skia.googlesource.com/skia.git $src
    Assert-Ok 'clone Skia'
  } else {
    Write-Ok "已存在 Skia 源码：$src"
  }

  Push-Location $src
  try {
    $head = ("$(& $GitExe rev-parse HEAD)").Trim()
    Write-Info "skia HEAD = $head"
    if ($head -ne $SkiaCommit) {
      Write-Note "HEAD 与预期 pin（$SkiaCommit）不一致。"
      Write-Note '若 vendor/skia/include 是照该 pin 做的，头文件与实现可能漂移（docs/zh-cn/skia.md §6.5）。'
    }

    if (-not $SkipDownload) {
      Write-Info '拉 third_party 依赖（tools/git-sync-deps，会 clone 一批子仓库，较慢）'
      & $PythonExe tools/git-sync-deps
      Assert-Ok 'git-sync-deps'
      Write-Info '取 gn'
      & $PythonExe bin/fetch-gn
      Assert-Ok 'fetch-gn'
    }

    $script:NinjaExe = Resolve-Ninja

    $gnExe = Join-Path $src 'bin\gn.exe'
    if (-not (Test-Path $gnExe)) { Fail "找不到 $gnExe（bin/fetch-gn 应已下载它）。" }

    # x86 上 gn 会强制要求 $win_sdk/bin/SetEnv.cmd（见 gn/toolchain/BUILD.gn）。本机 win_sdk
    # 未必有它（那是旧 SDK 的布局），没有就补一处最小的工具链补丁 —— 只影响 clang-cl 路径。
    if ($arch -eq 'x86') { Repair-SkiaX86Toolchain $src }

    # skcms 的 f16->f32 builtin：clang 23 删掉了它，与位宽无关，x64/x86 都要处理。
    Repair-SkcmsClangBuiltin $src

    # dng_sdk 的 std::auto_ptr：MSVC STL 在 /std:c++17 下移除了它，也与位宽无关。
    Repair-DngSdkAutoPtr $src

    # GrD3DUtil.h 缺 <string> 的显式 include（MSVC STL 新版不再间接提供），同样与位宽无关。
    Repair-GrD3DUtilStringInclude $src

    # ---- 写 args.gn：镜像 out/macos-arm64/args.gn，换成 win 目标
    $outName = "windows-$arch"
    $outDir = Join-Path $src ("out\" + $outName)
    if ($Clean -and (Test-Path $outDir)) { Remove-Item -Recurse -Force $outDir }
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null

    $g = @()
    $g += '# 由 as3compiler/vendor/build-windows-deps.ps1 生成；手改会被下次运行覆盖。'
    $g += "# Windows $arch 静态库，MSVC ABI，编译器 clang-cl，链接器 lld-link。"
    $g += ''
    $g += 'target_os = "win"'
    $g += "target_cpu = `"$arch`""
    $g += ''
    $g += 'is_debug = false'
    $g += 'is_official_build = true'        # 关 tools/tests/fuzzers，字体与编解码全用自带静态源码
    $g += 'is_component_build = false'
    $g += 'werror = false'
    $g += ''
    $g += '# gn 的 win toolchain 仅在 clang_win 非空时才切到 clang-cl + lld-link。'
    $g += '# win_vc / win_sdk 显式给出，免得 gn 再去调 python 探测。'
    $g += '# clang_win_version 也必须自己给：gn 的自探测脚本 gn/highest_version_dir.py 只认 X.Y.Z，'
    $g += '# 而 LLVM 23 起 resource dir 只用主版本号（lib/clang/23），交给它扫会 IndexError 搞挂 gn gen。'
    $g += "clang_win = `"$(To-Fwd $LlvmRoot)`""
    $g += "clang_win_version = `"$ClangResDirVersion`""
    $g += "win_vc = `"$(To-Fwd $winVc)`""

    $g += "win_toolchain_version = `"$winToolchainVersion`""
    $g += "win_sdk = `"$(To-Fwd $winSdk)`""
    $g += "win_sdk_version = `"$winSdkVersion`""
    $g += ''
    $g += '# 后端：CPU（软件光栅）+ D3D12。Ganesh 的 D3D12 后端是本项目 Windows 原生窗口'
    $g += '# 的 GPU 合成路径（vendor/d3d_glue.cc 拿 GrD3DBackendContext 交给 Skia）。'
    $g += '# 它会带来 SK_DIRECT3D 公共宏、third_party/d3d12allocator 归档与 d3d12/dxgi/'
    $g += '# d3dcompiler 三个系统库——这三项 air-app.ts 的链接清单里已对应声明，改这里'
    $g += '# 必须同步改那边，否则会在客户机上链接失败。'
    $g += 'skia_use_metal = false'
    $g += 'skia_use_vulkan = false'
    $g += 'skia_use_direct3d = true'
    $g += 'skia_use_angle = false'
    $g += 'skia_use_dawn = false'
    $g += 'skia_use_webgl = false'
    $g += 'skia_use_webgpu = false'
    $g += 'skia_enable_ganesh = true'
    $g += 'skia_enable_graphite = false'
    $g += ''
    $g += '# 第三方全部用 third_party/externals 里的源码，不吃系统库。'
    $g += 'skia_use_system_expat = false'
    $g += 'skia_use_system_freetype2 = false'
    $g += 'skia_use_system_harfbuzz = false'
    $g += 'skia_use_system_icu = false'
    $g += 'skia_use_system_libjpeg_turbo = false'
    $g += 'skia_use_system_libpng = false'
    $g += 'skia_use_system_libwebp = false'
    $g += 'skia_use_system_zlib = false'
    $g += ''
    $g += '# 打开 air-app.ts 链接清单需要的组件（这些归档必须存在）。'
    $g += 'skia_use_freetype = true'
    $g += 'skia_use_fontconfig = false'
    $g += 'skia_use_harfbuzz = true'
    $g += 'skia_use_icu = true'
    $g += 'skia_use_client_icu = false'
    $g += 'skia_use_icu4x = false'
    $g += 'skia_use_libgrapheme = false'
    $g += 'skia_use_zlib = true'
    $g += 'skia_use_wuffs = true'
    $g += 'skia_use_expat = true'
    $g += 'skia_use_piex = true'            # win 上默认关，必须显式打开
    $g += 'skia_use_dng_sdk = true'
    $g += 'skia_use_libjpeg_turbo_decode = true'
    $g += 'skia_use_libjpeg_turbo_encode = false'
    $g += 'skia_use_libpng_decode = true'
    $g += 'skia_use_libpng_encode = true'
    $g += 'skia_use_libwebp_decode = true'
    $g += 'skia_use_libwebp_encode = false'
    $g += 'skia_use_no_png_encode = false'
    $g += 'skia_enable_skottie = true'
    $g += 'skia_enable_svg = true'
    $g += ''
    $g += '# 用不上的关掉：XPS / PDF / lua / heif / Rust / 各种自定义 fontmgr。'
    $g += 'skia_use_xps = false'
    $g += 'skia_enable_pdf = false'
    $g += 'skia_use_lua = false'
    $g += 'skia_use_libheif = false'
    $g += 'skia_build_rust_targets = false'
    $g += 'skia_enable_sksl_tracing = false'
    $g += 'skia_enable_fontmgr_custom_empty = false'
    $g += 'skia_enable_fontmgr_custom_embedded = false'
    $g += 'skia_use_freetype_woff2 = false'
    $g += 'skia_enable_skshaper = true'
    $g += 'skia_enable_skparagraph = true'
    $argsPath = Join-Path $outDir 'args.gn'
    # 用「UTF-8 无 BOM」写：Set-Content -Encoding ASCII 会把非 ASCII 路径（如中文用户名目录）
    # 替换成 '?'，-Encoding UTF8 在 PS5.1 下又会加 BOM（gn 不一定吃）。
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($argsPath, ($g -join "`n"), $utf8NoBom)
    Write-Ok "已写 $argsPath"

    Write-Info 'gn gen'
    & $gnExe gen ("out/" + $outName)
    Assert-Ok 'gn gen'

    # 点名目标（这些名字已核对过存在于 Skia 的 build.ninja）。它们的依赖会自动带上。
    $libTargets = @(
      'skia', 'skparagraph', 'skshaper', 'skunicode', 'skottie', 'sksg', 'svg',
      'skresources', 'bentleyottmann', 'skcms', 'wuffs',
      'libpng', 'libjpeg', 'libwebp', 'libwebp_sse41', 'dng_sdk', 'piex',
      'expat', 'freetype2', 'harfbuzz', 'icu', 'zlib'
    )
    Write-Info "ninja -C out/$outName -j$Jobs $($libTargets -join ' ')"
    Write-Info '（Skia 首次编译很慢，请耐心等待）'
    & $script:NinjaExe -C ("out/" + $outName) "-j$Jobs" @libTargets
    Assert-Ok 'ninja (skia)'

    # ---- 收产物：out 目录里所有 .lib 全搬过去（对齐 macOS 的做法：整目录搬）
    $dest = Join-Path $Vendor "skia\lib\windows-$arch"
    New-CleanDir $dest
    $libs = @(Get-ChildItem -Path $outDir -Filter '*.lib' -File)
    if ($libs.Count -eq 0) { Fail "out 目录里没编出任何 .lib：$outDir" }
    foreach ($f in $libs) { Copy-Item $f.FullName $dest -Force }
    Write-Ok "已拷 $($libs.Count) 个 .lib -> $dest"
    Write-Info (($libs | Sort-Object Name | ForEach-Object { $_.Name }) -join ' ')
    Assert-LibBitness -Dir $dest -Arch $arch -Label "Skia ($arch)"

    # ---- 运行时数据：icudtl.dat（Skia 的 ICU 数据，SkParagraph/SkUnicode 文本整形必需）
    # 程序侧是静态 exe，SkLoadICU()（third_party/icu/SkLoadICU.cpp）只探 exe 目录与库目录，
    # 故 icudtl.dat 必须随 .lib 一起入库，编译期再由 build.ts 把它拷到 exe 旁。缺了它首跑
    # 会在首次文本整形时 SIGILL（SkParagraph::Cluster::Cluster 读空 grapheme 表越界 SK_ABORT）。
    $icuData = Join-Path $outDir 'icudtl.dat'
    if (Test-Path $icuData) {
      Copy-Item $icuData (Join-Path $dest 'icudtl.dat') -Force
      Write-Ok '已拷 icudtl.dat -> 与 skia .lib 同目录'
    } else {
      Fail "out 目录里没有 icudtl.dat（Skia 的 ICU 数据未产出）：$outDir"
    }

    # ---- 头文件一致性提醒（docs/zh-cn/skia.md §6.5）
    $vendorInclude = Join-Path $Vendor 'skia\include'
    $srcInclude = Join-Path $src 'include'
    if (Test-Path $vendorInclude) {
      $null = & $GitExe --no-pager diff --no-index --stat -- $vendorInclude $srcInclude 2>&1
      if ((Get-ExitCode) -ne 0) {
        Write-Note 'vendor/skia/include 与本次编译所用源码的 include/ 不一致：'
        Write-Note '请用本次源码的 include/ 覆盖 vendor/skia/include，否则头与实现可能漂移。'
      } else {
        Write-Ok 'vendor/skia/include 与本次编译源码的 include/ 一致。'
      }
    }
  } finally {
    Pop-Location
  }
}

# ---------------------------------------------------------------- 8. CMake 通用
function Invoke-CmakeBuild {
  param(
    [Parameter(Mandatory)][string]$SrcDir,
    [Parameter(Mandatory)][string]$BuildDir,
    [Parameter(Mandatory)][string]$Arch,        # x64 / x86
    [string]$InstallPrefix,
    [string[]]$ExtraCFlags,                     # 编译期额外旗标（与位宽旗标合并后传给 CMAKE_C_FLAGS）
    [string[]]$Options,
    [Parameter(Mandatory)][string]$Label
  )
  if (-not $script:NinjaExe) { $script:NinjaExe = Resolve-Ninja }
  if ($Clean -and (Test-Path $BuildDir)) { Remove-Item -Recurse -Force $BuildDir }
  New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null

  # 位宽旗标。clang-cl 默认按**宿主**架构（x64）编，要产 x86 必须显式告诉它。编译与链接都要带：
  # CMake 的编译旗标不会自动进链接行，否则 configure 阶段的 try_compile 会按 x64 链接，
  # 探测结果与实际产物不一致（后继还可能误判库 ABI）。
  $archFlags = @()
  if ($Arch -eq 'x86') { $archFlags = @('--target=i686-pc-windows-msvc') }
  $cFlags = (@($archFlags) + @($ExtraCFlags)) -join ' '

  $cmakeArgs = @(
    '-S', $SrcDir, '-B', $BuildDir, '-G', 'Ninja',
    '-DCMAKE_BUILD_TYPE=Release',
    "-DCMAKE_C_COMPILER=$ClangCl",
    "-DCMAKE_CXX_COMPILER=$ClangCl",
    "-DCMAKE_MAKE_PROGRAM=$script:NinjaExe",
    # 与 Skia 保持一致：Skia 的 gn 用 is_official_build 时显式走 /MT（静态 CRT），
    # 链接清单里 skia.lib / SDL2.lib 引用的都是本地 _malloc/_memcpy（无 __imp_ 前缀）。
    # 所以这里也必须 /MT（MultiThreaded），否则 curl/nghttp2/zlib 会编成 /MD，引用
    # __imp__malloc 等动态 CRT 符号，链静态 CRT 时出现 __except_handler4_common、
    # __fdopen 等一串 lld-link 未解析符号。
    '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded'
  )
  if ($cFlags) {
    $cmakeArgs += "-DCMAKE_C_FLAGS=$cFlags"
    $cmakeArgs += "-DCMAKE_CXX_FLAGS=$cFlags"
  }
  if ($archFlags.Count -gt 0) {
    $lf = $archFlags -join ' '
    $cmakeArgs += "-DCMAKE_EXE_LINKER_FLAGS=$lf"
    $cmakeArgs += "-DCMAKE_SHARED_LINKER_FLAGS=$lf"
    $cmakeArgs += "-DCMAKE_MODULE_LINKER_FLAGS=$lf"
  }
  if ($Options) { $cmakeArgs += $Options }
  if ($InstallPrefix) { $cmakeArgs += "-DCMAKE_INSTALL_PREFIX=$InstallPrefix" }

  Write-Info "cmake $($cmakeArgs -join ' ')"
  & $CmakeExe @cmakeArgs
  Assert-Ok "cmake configure ($Label)"

  & $CmakeExe --build $BuildDir --parallel $Jobs
  Assert-Ok "cmake build ($Label)"

  if ($InstallPrefix) {
    & $CmakeExe --install $BuildDir
    Assert-Ok "cmake install ($Label)"
    Write-Ok "已安装到 $InstallPrefix"
  }
}

# ---------------------------------------------------------------- 9. SDL2
function Build-Sdl2([string]$arch) {
  Write-Step "构建 SDL2 $Sdl2Version（Windows $arch / clang-cl）"

  $src = Join-Path $DlDir "SDL2-$Sdl2Version"
  if (-not (Test-Path $src)) {
    if ($SkipDownload) { Fail "-SkipDownload 指定了，但 $src 不存在。" }
    Get-SourceTarball 'sdl2' $src
  }
  $dest = Join-Path $Vendor "sdl2\windows-$arch"

  Invoke-CmakeBuild -SrcDir $src `
    -BuildDir (Build-DirFor 'sdl2' $arch) `
    -Arch $arch `
    -InstallPrefix $dest `
    -Label "SDL2 ($arch)" `
    -Options @(
      '-DSDL_SHARED=OFF',
      '-DSDL_STATIC=ON',
      '-DSDL_TEST=OFF',
      '-DSDL_TESTS=OFF',
      # SDL2 同样不用 CMake 的 CMAKE_MSVC_RUNTIME_LIBRARY，而是自带 SDL_FORCE_STATIC_VCRT
      # 开关（CMakeLists.txt:267）：开启后把 CMAKE_C/CXX_FLAGS 里的 /MD 换成 /MT。不开启会
      # 编成 /MD（每个 obj 带 /DEFAULTLIB:msvcrt.lib），与 /MT 的 skia/curl 混链时 msvcrt.lib
      # 的 __except_handler4 引用 __except_handler4_common，而该符号只在 libcmt.lib（静态 CRT）里，
      # 链静态 CRT 时未解析。
      '-DSDL_FORCE_STATIC_VCRT=ON'
    )

  # SDL2 的 CMake 静态库叫 SDL2-static.lib；补一个 SDL2.lib，让 -lSDL2 能解析。
  $libDir = Join-Path $dest 'lib'
  if (-not (Test-Path $libDir)) { Fail "SDL2 安装后没有 lib 目录：$libDir" }
  foreach ($f in @(Get-ChildItem $libDir -Filter 'SDL2*.lib' -File)) {
    if ($f.Name -eq 'SDL2-static.lib') {
      Copy-Item $f.FullName (Join-Path $libDir 'SDL2.lib') -Force
      Write-Ok 'SDL2-static.lib -> SDL2.lib'
    }
  }
  Write-Info "lib: $((@(Get-ChildItem $libDir -File) | ForEach-Object { $_.Name }) -join ' ')"
  Assert-LibBitness -Dir $libDir -Arch $arch -Label "SDL2 ($arch)"
}

# ---------------------------------------------------------------- 10. curl 三件套
function Build-CurlStack([string]$arch) {
  Write-Step "构建 curl $CurlVersion 依赖栈（Windows $arch：zlib $ZlibVersion / nghttp2 $Nghttp2Version / curl）"

  # 每套位宽一个独立中间前缀：x64 与 x86 的 .lib 混在一起会让 curl 的 find_library(zlib/nghttp2)
  # 跨位宽取错，链接期报 LNK1112 机器类型冲突。
  $CurlPrefix = Curl-Prefix $arch

  $srcZlib = Join-Path $DlDir "zlib-$ZlibVersion"
  $srcNg = Join-Path $DlDir "nghttp2-$Nghttp2Version"
  $srcCurl = Join-Path $DlDir "curl-$CurlVersion"
  if (-not $SkipDownload) {
    if (-not (Test-Path $srcZlib)) { Get-SourceTarball 'zlib' $srcZlib }
    if (-not (Test-Path $srcNg)) { Get-SourceTarball 'nghttp2' $srcNg }
    if (-not (Test-Path $srcCurl)) { Get-SourceTarball 'curl' $srcCurl }
  }
  foreach ($d in @($srcZlib, $srcNg, $srcCurl)) {
    if (-not (Test-Path $d)) { Fail "源码目录不存在：$d" }
  }
  New-Item -ItemType Directory -Force -Path $CurlPrefix | Out-Null

  # --- zlib：curl 的 gzip/deflate 依赖；Skia 的链接清单里也有 -lz / -lzlib
  Invoke-CmakeBuild -SrcDir $srcZlib `
    -BuildDir (Build-DirFor 'zlib' $arch) `
    -Arch $arch `
    -InstallPrefix $CurlPrefix `
    -Label "zlib ($arch)" `
    -Options @('-DZLIB_BUILD_EXAMPLES=OFF')

  # zlib 的 CMakeLists 无条件同时 add_library 了 SHARED 的 `zlib` 与 STATIC 的 `zlibstatic`
  # （没有任何开关能只建静态版）。在 MSVC 下 SHARED 那个会产出一个叫 zlib.lib 的 **import lib**，
  # 名字恰好和静态库惯用名撞车：curl 的 find_package(ZLIB) 会优先拿到它，最后链接成“要带 zlib.dll
  # 才能跑”的半残库。所以这里把 import lib（以及对应的 dll）删掉，只留 zlibstatic.lib。
  foreach ($stale in @((Join-Path $CurlPrefix 'lib\zlib.lib'), (Join-Path $CurlPrefix 'bin\zlib.dll'))) {
    if (Test-Path $stale) { Remove-Item $stale -Force; Write-Ok "已移除 zlib 的 SHARED 产物：$stale" }
  }

  # --- nghttp2：HTTP/2。
  # 选项名以源码 CMakeOptions.txt 为准：静态库由 BUILD_STATIC_LIBS 控制，不是 ENABLE_STATIC_LIB。
  # BUILD_SHARED_LIBS=OFF 很关键：只有不建共享版，静态库输出名才是 nghttp2.lib（否则 MSVC 下
  # ARCHIVE_OUTPUT_NAME 会变成 nghttp2_static，且同样多出一个 import lib）。
  Invoke-CmakeBuild -SrcDir $srcNg `
    -BuildDir (Build-DirFor 'nghttp2' $arch) `
    -Arch $arch `
    -InstallPrefix $CurlPrefix `
    -Label "nghttp2 ($arch)" `
    -Options @(
      '-DENABLE_LIB_ONLY=ON',
      '-DBUILD_SHARED_LIBS=OFF',
      '-DBUILD_STATIC_LIBS=ON',
      '-DBUILD_TESTING=OFF',
      '-DENABLE_DOC=OFF',
      # nghttp2 不用 CMake 的 CMAKE_MSVC_RUNTIME_LIBRARY（那是 3.15+ 的 MSVC_RUNTIME_LIBRARY
      # target property 才读的东西），而是自带 ENABLE_STATIC_CRT 开关，把 CMAKE_C/CXX_FLAGS 里的
      # /MD 换成 /MT（CMakeLists.txt:396）。不开启会编成 /MD，引用 __imp__malloc / __imp__wassert，
      # 与 /MT 的 skia/sdl2/curl 混链时出现 __wassert 未解析。
      '-DENABLE_STATIC_CRT=ON'
    )

  # --- curl：TLS 走系统 Schannel（Windows 原生，不引 OpenSSL；信任区用系统证书库，无需 CA bundle，
  # 与 macOS 那边选 SecureTransport 是同一个思路）。依赖面按 flash.net 实际能提的需求裁到
  # http/https + proxy。（选项名均已在 curl-8.11.1/CMakeLists.txt 里核对。）
  Invoke-CmakeBuild -SrcDir $srcCurl `
    -BuildDir (Build-DirFor 'curl' $arch) `
    -Arch $arch `
    -InstallPrefix $CurlPrefix `
    -ExtraCFlags @('-DNGHTTP2_STATICLIB') `
    -Label "curl ($arch)" `
    -Options @(
      '-DBUILD_SHARED_LIBS=OFF',
      '-DBUILD_CURL_EXE=OFF',
      '-DBUILD_EXAMPLES=OFF',
      '-DBUILD_TESTING=OFF',
      '-DHTTP_ONLY=ON',
      '-DCURL_USE_SCHANNEL=ON',
      '-DCURL_USE_OPENSSL=OFF',
      '-DCURL_ZLIB=ON',
      '-DUSE_NGHTTP2=ON',
      # curl 是用 find_library(NAMES nghttp2) + find_path 找 nghttp2 的（不是 CMake package），
      # 所以 nghttp2 那个 PUBLIC 的 -DNGHTTP2_STATICLIB 不会自动传过来。少了它，头文件会把 API
      # 声明成 __declspec(dllimport)，链静态库时就会出 __imp_ 未解析符号。
      # 它经 -ExtraCFlags 传（而不是在这里直接写 -DCMAKE_C_FLAGS），以便与 x86 的位宽旗标合并 ——
      # 命令行上重复给 CMAKE_C_FLAGS 会互相覆盖。

      # zlib 同理：优先找静态版（CMake ≥ 3.24 认这个变量；老版就靠上面删掉 import lib 来兜底）。
      '-DZLIB_USE_STATIC_LIBS=ON',
      # 与 macOS 的 --enable-threaded-resolver 对齐
      '-DENABLE_THREADED_RESOLVER=ON',
      # 明关掉这些默认 ON 的可选依赖，免得机器上恰有 zstd/idn2 之类就偷偷链进去
      '-DUSE_LIBIDN2=OFF',
      '-DCURL_USE_LIBPSL=OFF',
      '-DCURL_USE_LIBSSH2=OFF',
      '-DUSE_NGTCP2=OFF',
      '-DUSE_QUICHE=OFF',
      "-DCMAKE_PREFIX_PATH=$CurlPrefix",
      "-DCMAKE_LIBRARY_PATH=$(Join-Path $CurlPrefix 'lib')",
      "-DCMAKE_INCLUDE_PATH=$(Join-Path $CurlPrefix 'include')"
    )

  # --- 收产物到 vendor/curl
  $destInclude = Join-Path $Vendor 'curl\include'
  $destLib = Join-Path $Vendor "curl\lib\windows-$arch"
  New-Item -ItemType Directory -Force -Path $destInclude | Out-Null
  New-CleanDir $destLib

  $srcInclude = Join-Path $CurlPrefix 'include'
  if (-not (Test-Path $srcInclude)) { Fail "curl 安装前缀里没有 include：$srcInclude" }
  Copy-Item (Join-Path $srcInclude '*') $destInclude -Recurse -Force
  Write-Ok "头文件 -> $destInclude"

  $srcLib = Join-Path $CurlPrefix 'lib'
  if (-not (Test-Path $srcLib)) { Fail "curl 安装前缀里没有 lib：$srcLib" }
  foreach ($f in @(Get-ChildItem $srcLib -Filter '*.lib' -File)) {
    # zlib.lib 在 MSVC 下是 SHARED 目标的 import lib（上面已删；这里再兜一道），不当静态库收
    if ($f.Name -eq 'zlib.lib') { continue }
    Copy-Item $f.FullName $destLib -Force
    # libcurl.lib -> curl.lib（去掉 lib 前缀，让 -lcurl 能解析）
    if ($f.Name -match '^lib(.+)\.lib$') {
      Copy-Item $f.FullName (Join-Path $destLib ($matches[1] + '.lib')) -Force
    }
  }
  # -lz 与 -lzlib 两个名字都要能解析（Skia 链接清单里两个都在）。别名一律从 zlibstatic.lib 来。
  $zStatic = Join-Path $destLib 'zlibstatic.lib'
  if (Test-Path $zStatic) {
    Copy-Item $zStatic (Join-Path $destLib 'zlib.lib') -Force
    Copy-Item $zStatic (Join-Path $destLib 'z.lib') -Force
    Write-Ok 'zlibstatic.lib -> zlib.lib / z.lib'
  } else {
    Write-Note '没找到 zlibstatic.lib，-lz/-lzlib 可能解析不到。'
  }
  Write-Info "lib: $((@(Get-ChildItem $destLib -File) | ForEach-Object { $_.Name }) -join ' ')"
  Assert-LibBitness -Dir $destLib -Arch $arch -Label "curl 依赖栈 ($arch)"
}

# ---------------------------------------------------------------- 11. 跑
# 每套位宽：先导入该位宽的 vcvars 环境（头/库路径随架构变），再把这一位宽的目标全建完。
# 顺序是「按位宽分层」而不是「按包分层」—— 因为 vcvars 环境是进程级的，切架构必须整段切。
$script:NinjaExe = Resolve-Ninja
foreach ($archName in $Arches) {
  Import-MsvcEnv $archName
  if ($Want -contains 'skia') { Build-Skia $archName }
  if ($Want -contains 'sdl2') { Build-Sdl2 $archName }
  if ($Want -contains 'curl') { Build-CurlStack $archName }
}

# ---------------------------------------------------------------- 12. 汇总
Write-Step '完成，产物清单'
$summaryPaths = @()
foreach ($a in $Arches) {
  $summaryPaths += "skia\lib\windows-$a"
  $summaryPaths += "sdl2\windows-$a"
  $summaryPaths += "curl\lib\windows-$a"
}
foreach ($p in $summaryPaths) {
  $full = Join-Path $Vendor $p
  if (Test-Path $full) {
    $files = @(Get-ChildItem $full -Recurse -File)
    $mb = [math]::Round((($files | Measure-Object -Property Length -Sum).Sum / 1MB), 1)
    Write-Ok "$p  ($($files.Count) 个文件, $mb MB)"
  } else {
    Write-Note "$p 不存在（本次已跳过）"
  }
}

$nextSteps = @'

下一步（编译侧还需要处理的）：
  * 位宽由 AIR 描述符决定：<application><architecture> 取 "32" 或 "64"，**缺省 32**。
    对应关系（即将在 src/air-app.ts 里落地）：
      <architecture>64</architecture> -> vendor/*/windows-x64 + clang --target=x86_64-pc-windows-msvc
      <architecture>32</architecture> -> vendor/*/windows-x86 + clang --target=i686-pc-windows-msvc
    （src/air-app.ts 目前**完全没解析**这个元素，且把链接路径写死成 macOS 的
      vendor/skia/lib/macos-arm64 与 vendor/sdl2/arm64/lib；link-libs 也按 macOS 命名 ——
      macOS 是 libskia.a，Windows 是 skia.lib / libpng.lib / libcurl.lib，没有 lib 前缀。）
    32 位与 64 位不能混链：Capabilities.cpuAddressSize / supports32BitProcesses 也必须与
    所选三元组一致，否则会与描述符自相矛盾。
  * 程序本体用 clang --target=<三元组> 编译（GNU 风格旗标可用：-O2 -I -L -l -o），
    与上面这些 clang-cl 产出的 .lib 同为 MSVC ABI，可直接互链。
  * --target native 在 Windows 上还缺原生后端（Win32 + D3D/Skia），见 as3compiler/TODO.md。
'@
Write-Host $nextSteps -ForegroundColor Yellow