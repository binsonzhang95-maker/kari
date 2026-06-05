@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM ---------------------------------------------------------------------------
REM Kari Desktop — Windows packaging (one-shot).
REM Reproduces docs/packaging.zh-CN.md end-to-end so operators don't have to
REM remember the env vars / proxy / step order. Run from the repo root.
REM ---------------------------------------------------------------------------

cd /d "%~dp0"

REM Optional flags: --skip-rebuild bypasses @electron/rebuild (use the
REM prebuilt node-pty .node that npm ci downloaded). Last resort when
REM the box can't install MSVC Spectre-mitigated libs; risks ABI
REM mismatch with Electron at runtime (terminal panes may refuse to
REM load). Confirm by smoke-testing Local Shell after install.
set "SKIP_REBUILD="
:parse_args
if "%~1"=="" goto :args_done
if /I "%~1"=="--skip-rebuild" set "SKIP_REBUILD=1" & shift & goto :parse_args
echo Unknown flag: %~1
exit /b 1
:args_done

echo === Kari Desktop Windows build ===
echo Repo: %CD%
if defined SKIP_REBUILD echo Mode:  --skip-rebuild (using prebuilt node-pty; Spectre libs not required)
echo.

REM --- 0. Quick sanity: bundled runtime present -------------------------------
if not exist "bundled-runtime\windows-x64\kari-syncd.exe" goto :missing_syncd
if not exist "bundled-runtime\windows-x64\kari.exe" goto :missing_kari

REM --- 1. Proxy + electron mirrors (only set if operator hasn't overridden) ---
if not defined HTTP_PROXY set "HTTP_PROXY=http://127.0.0.1:7897"
if not defined HTTPS_PROXY set "HTTPS_PROXY=http://127.0.0.1:7897"
if not defined ELECTRON_MIRROR set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
if not defined ELECTRON_BUILDER_BINARIES_MIRROR set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"

REM Skip Windows code-signing (ad-hoc / unsigned dev build).
set "CSC_IDENTITY_AUTO_DISCOVERY=false"

echo HTTP_PROXY=!HTTP_PROXY!
echo ELECTRON_MIRROR=!ELECTRON_MIRROR!
echo.

REM --- 2. Install dependencies ------------------------------------------------
echo === [1/4] npm ci ===
call npm.cmd ci
if errorlevel 1 goto :fail_step

REM --- 3. Typecheck + unit tests ---------------------------------------------
echo.
echo === [2/4] typecheck ===
call npm.cmd run typecheck
if errorlevel 1 goto :fail_step

echo.
echo === [3/4] tests ===
call npm.cmd test
if errorlevel 1 goto :fail_step

REM --- 4. Renderer build -----------------------------------------------------
echo.
echo === [4/5] renderer build ===
call npm.cmd run build
if errorlevel 1 goto :fail_step
if not exist "dist\renderer\index.html" goto :missing_renderer_before_package

echo.
echo === [5/5] package ===
if defined SKIP_REBUILD (
  call npm.cmd run package -- --win zip --x64 --publish never -c.npmRebuild=false
) else (
  call npm.cmd run package -- --win zip --x64 --publish never
)
if errorlevel 1 goto :fail_package

REM --- 5. Post-build verification: renderer + runtime in the asar -------------
echo.
echo === Verifying packaged artifacts ===

if not exist "dist\win-unpacked\resources\app.asar" goto :missing_asar
if not exist "dist\win-unpacked\resources\bundled-runtime\windows-x64\kari-syncd.exe" goto :missing_runtime_in_pack
if not exist "dist\win-unpacked\resources\bundled-runtime\windows-x64\kari.exe" goto :missing_runtime_in_pack

call node.exe scripts\verify-packaged-app.cjs ^
  --asar "dist\win-unpacked\resources\app.asar" ^
  --resource "dist\win-unpacked\resources" ^
  --asar-entry "dist/renderer/index.html" ^
  --runtime "bundled-runtime\windows-x64\kari-syncd.exe" ^
  --runtime "bundled-runtime\windows-x64\kari.exe"
if errorlevel 1 goto :missing_renderer_in_asar

echo.
echo === Done. Artifacts: ===
dir /b dist\*.zip dist\*.exe 2>nul
exit /b 0

REM ---------------------------------------------------------------------------

:missing_syncd
echo ERROR: bundled-runtime\windows-x64\kari-syncd.exe missing.
echo Run `git pull` then make sure this file is present before packaging.
exit /b 1

:missing_kari
echo ERROR: bundled-runtime\windows-x64\kari.exe missing.
echo Rebuild from trans/cmd/kari (see docs/packaging.zh-CN.md).
exit /b 1

:fail_step
echo.
echo ERROR: previous step exited with code %errorlevel%. Stopping.
exit /b 1

:fail_package
echo.
echo ERROR: packaging step failed (exit code %errorlevel%).
echo.
echo Common causes:
echo.
echo   1. MSB8040 / Spectre-mitigated libraries missing.
echo      Open Visual Studio Installer -^> modify VS Build Tools 2022 -^>
echo      Individual components tab -^> search "Spectre" -^> install:
echo        - MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs (Latest)
echo        - Windows 10/11 SDK (whatever you have)
echo      Then close all cmd/PowerShell windows and re-run this bat.
echo.
echo   2. node-pty rebuild failed for other reasons. Inspect the output
echo      above for the actual MSBuild / node-gyp error.
echo.
echo   3. electron-builder couldn't download Electron itself (proxy /
echo      mirror issue). Check ELECTRON_MIRROR is reachable:
echo        curl -I %ELECTRON_MIRROR%
echo.
exit /b 1

:missing_asar
echo ERROR: dist\win-unpacked\resources\app.asar not produced. electron-builder probably failed.
exit /b 1

:missing_renderer_before_package
echo ERROR: dist\renderer\index.html was not produced before packaging.
echo Run npm.cmd run build and inspect the Vite output above.
exit /b 1

:missing_runtime_in_pack
echo ERROR: packaged app is missing bundled-runtime\windows-x64\kari-syncd.exe / kari.exe.
echo Check package.json build.extraResources still includes bundled-runtime/.
exit /b 1

:missing_renderer_in_asar
echo ERROR: packaged asar does NOT contain dist/renderer/index.html.
echo Renderer was not built / not included before packing. This is the silent black-screen bug.
echo The offline verifier above reads app.asar directly; check package.json build.files.
exit /b 1
