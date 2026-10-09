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
$ShimDir    = Join-Path $BuildTools 'win-deps-shim'    # python/python3 名字垫片

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

$PythonExe = Find-Exe 'python3'
if (-not $PythonExe) { $PythonExe = Find-Exe 'python' }
if (-not $PythonExe) {
  Fail '找不到 python（需要 Python 3）。安装：https://www.python.org/downloads/windows/（勾 Add python.exe to PATH）'
}
Write-Ok "python -> $PythonExe"

# Skia 的 gn 在生成阶段会用 exec_script 调 python；不同版本的 gn 认的名字不一样（python 或 python3）。
# 这里做一个同时提供两个名字的垫片目录放到 PATH 最前面，把「名字对不上」这类坑一次性抹掉。
New-Item -ItemType Directory -Force -Path $ShimDir | Out-Null
foreach ($n in @('python.exe', 'python3.exe')) {
  $t = Join-Path $ShimDir $n
  if (-not (Test-Path $t)) { Copy-Item $PythonExe $t -Force }
}
$env:PATH = "$ShimDir;$env:PATH"
Write-Ok "python 垫片就绪：$ShimDir"

$GitExe = $null
if ($NeedGit) { $GitExe = Require-Exe 'git' '安装 Git for Windows：https://git-scm.com/download/win' }
$TarExe = $null
if ($NeedTar) { $TarExe = Require-Exe 'tar' 'Windows 10+ 自带 tar.exe；缺失时可从 Git 安装目录的 usr\bin 复制。' }
$CmakeExe = $null
if ($NeedCmake) { $CmakeExe = Require-Exe 'cmake' '安装 CMake 并加入 PATH：https://cmake.org/download/' }

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
  $cands += 'C:\LLVM'
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
找不到 clang-cl.exe。请安装 LLVM（内含 clang-cl）：
  https://github.com/llvm/llvm-project/releases  选 LLVM-<版本>-win64.exe
安装时勾选 "Add LLVM to the system PATH"，或用 -LlvmHome 'C:\Program Files\LLVM' 指定。
'@
}
$ClangCl = Join-Path $LlvmRoot 'bin\clang-cl.exe'
Write-Ok "LLVM: $LlvmRoot"
& $ClangCl --version 2>&1 | Select-Object -First 1 | ForEach-Object { Write-Info $_ }

# ---------------------------------------------------------------- 5. ninja
# CMake(-G Ninja) 与 Skia 都要 ninja。系统没有就用 Skia 自带的 fetch-ninja 取一个。
function Resolve-Ninja {
  $n = Find-Exe 'ninja'
  if ($n) { Write-Ok "ninja -> $n"; return $n }
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
  if (Test-Path $destDir) { Remove-Item -Recurse -Force $destDir }
  & $TarExe -xzf $file -C $DlDir
  Assert-Ok "解包 $file"
  if (-not (Test-Path $destDir)) { Fail "解包后没有预期目录：$destDir" }
  Write-Ok "解包完成：$destDir"
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

  # 注意：Windows 上的 Git 默认 core.autocrlf=true，Skia 源码里的换行很可能是 CRLF，而本文件里的
  # here-string 是 LF。先归一化再比对，否则补丁会“找不到锚点”而假失败；写回时恢复原换行风格。
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
    $g += "clang_win = `"$(To-Fwd $LlvmRoot)`""
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
    # 与 Skia 保持一致：Skia 的 gn 没设 /MT，走 MSVC 默认的 /MD。
    '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDLL'
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
      '-DSDL_TESTS=OFF'
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
      '-DENABLE_DOC=OFF'
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