@echo off
rem Build libmp3lame.dll (LAME 3.100: GNU LGPL version 2 or later, see lame-3.100\COPYING;
rem the crate's own Rust bindings are LGPL-3.0, but we use none of them)
rem from source with MSVC, for the compressed copy of recordings (src-tauri/src/audio/compressed.rs).
rem
rem Source: third_party\lame\lame-3.100-source.zip = the lame-3.100 folder of the crates.io package
rem mp3lame-sys 0.1.11 (the LAME 3.100 release tree), zipped unmodified. The same zip ships beside
rem the DLL (LGPL: source of the library we ship), so what we ship is exactly what we built from.
rem Nothing is downloaded here.
rem
rem Output: src-tauri\target\lame\libmp3lame.dll, copied next to target\release\glossline.exe and into
rem target\debug (cargo test), each with a LAME-license folder (license texts, source zip, this script).
rem
rem Run from anywhere:  app\tools\build_lame_dll.bat
setlocal

set "APP=%~dp0.."
set "OUT=%APP%\src-tauri\target\lame"
set "ZIP=%APP%\third_party\lame\lame-3.100-source.zip"
if not exist "%ZIP%" (
  echo [build_lame_dll] LAME source zip not found: %ZIP%
  exit /b 1
)
if exist "%OUT%\src" rmdir /s /q "%OUT%\src"
mkdir "%OUT%\src" 2>nul
tar -x -f "%ZIP%" -C "%OUT%\src" || exit /b 1
set "SRC=%OUT%\src\lame-3.100"
if not exist "%SRC%\include\lame.h" (
  echo [build_lame_dll] unexpected zip layout: %SRC%\include\lame.h missing
  exit /b 1
)
echo [build_lame_dll] source: %ZIP%

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
set "VSDIR="
for /f "usebackq delims=" %%I in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSDIR=%%I"
if "%VSDIR%"=="" (
  echo [build_lame_dll] MSVC not found ^(Visual Studio Build Tools with C++^).
  exit /b 1
)
call "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1

if exist "%OUT%\obj" rmdir /s /q "%OUT%\obj"
mkdir "%OUT%\obj" 2>nul
mkdir "%OUT%\inc" 2>nul
copy /y "%SRC%\configMS.h" "%OUT%\inc\config.h" >nul || exit /b 1

rem Same files and defines as mp3lame-sys build.rs (Windows branch), plus the mpglib decoder so that
rem every name in include\lame.def exists (the tests decode with it; the app only encodes).
set "LS=%SRC%\libmp3lame"
set "MP=%SRC%\mpglib"
cl /nologo /c /O2 /MD /W0 /Brepro /Fo"%OUT%\obj\\" ^
  /I"%SRC%\include" /I"%OUT%\inc" /I"%LS%" /I"%MP%" ^
  /DHAVE_CONFIG_H /DTAKEHIRO_IEEE754_HACK /DFLOAT8=float /DREAL_IS_FLOAT=1 /DBS_FORMAT=BINARY /DHAVE_MPGLIB ^
  "%LS%\bitstream.c" "%LS%\encoder.c" "%LS%\fft.c" "%LS%\gain_analysis.c" "%LS%\id3tag.c" "%LS%\lame.c" ^
  "%LS%\newmdct.c" "%LS%\presets.c" "%LS%\psymodel.c" "%LS%\quantize_pvt.c" "%LS%\vector\xmm_quantize_sub.c" ^
  "%LS%\quantize.c" "%LS%\reservoir.c" "%LS%\set_get.c" "%LS%\tables.c" "%LS%\takehiro.c" "%LS%\util.c" ^
  "%LS%\vbrquantize.c" "%LS%\VbrTag.c" "%LS%\version.c" "%LS%\mpglib_interface.c" ^
  "%MP%\common.c" "%MP%\dct64_i386.c" "%MP%\decode_i386.c" "%MP%\interface.c" "%MP%\layer1.c" ^
  "%MP%\layer2.c" "%MP%\layer3.c" "%MP%\tabinit.c" || exit /b 1

link /nologo /Brepro /DLL /OUT:"%OUT%\libmp3lame.dll" /DEF:"%SRC%\include\lame.def" "%OUT%\obj\*.obj" || exit /b 1

rem The DLL travels with its license texts, its source zip (both in third_party\lame) and this script.
rem Every copy is checked: a DLL shipped without its source would break the LGPL, silently.
for %%T in (release debug) do (
  if exist "%APP%\src-tauri\target\%%T" (
    copy /y "%OUT%\libmp3lame.dll" "%APP%\src-tauri\target\%%T\libmp3lame.dll" >nul || exit /b 1
    mkdir "%APP%\src-tauri\target\%%T\LAME-license" 2>nul
    copy /y "%APP%\third_party\lame\*" "%APP%\src-tauri\target\%%T\LAME-license\" >nul || exit /b 1
    copy /y "%~f0" "%APP%\src-tauri\target\%%T\LAME-license\build_lame_dll.bat" >nul || exit /b 1
    if not exist "%APP%\src-tauri\target\%%T\LAME-license\lame-3.100-source.zip" (
      echo [build_lame_dll] source zip did not reach target\%%T\LAME-license
      exit /b 1
    )
  )
)
echo [build_lame_dll] done: %OUT%\libmp3lame.dll
endlocal
