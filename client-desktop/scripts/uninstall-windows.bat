@echo off
REM Kari Desktop — full uninstall (Windows).
REM
REM Kills running Kari processes, then removes every directory the app
REM writes to under the user's profile. Mirrors scripts/uninstall-mac.sh.
REM Run as the same user who installed Kari (no elevation needed for
REM per-user app data, but admin helps if processes won't die).
REM
REM Usage (cmd.exe or PowerShell):
REM   uninstall-windows.bat                    interactive, asks before deleting
REM   uninstall-windows.bat --yes              non-interactive
REM   uninstall-windows.bat --yes "C:\Apps\Kari"
REM                                            also removes the extracted zip folder
REM
REM The path arg lets you also wipe wherever you unzipped Kari-X.Y.Z-win.zip
REM (the app exe + bundled-runtime live there, not under %APPDATA%).

setlocal EnableExtensions EnableDelayedExpansion

set "YES="
set "APP_ROOT="
:parse_args
if "%~1"=="" goto :args_done
if /I "%~1"=="--yes" set "YES=1" & shift & goto :parse_args
if /I "%~1"=="-y"    set "YES=1" & shift & goto :parse_args
if not defined APP_ROOT (
  set "APP_ROOT=%~1" & shift & goto :parse_args
)
echo Unknown extra arg: %~1
exit /b 2
:args_done

set "USER_DATA=%APPDATA%\Kari"
set "USER_DATA_LOCAL=%LOCALAPPDATA%\Kari"
set "USER_DATA_LOCAL_CACHE=%LOCALAPPDATA%\Kari Cache"
set "USER_RUNTIME=%USERPROFILE%\.kari"
set "CRASH_REPORTS=%LOCALAPPDATA%\CrashDumps\Kari.exe"

echo Kari Desktop uninstall will remove the following if present:
echo.
call :show "%USER_DATA%"
call :show "%USER_DATA_LOCAL%"
call :show "%USER_DATA_LOCAL_CACHE%"
call :show "%USER_RUNTIME%"
call :show "%CRASH_REPORTS%"
if defined APP_ROOT call :show "%APP_ROOT%"
echo.

if not defined YES (
  set /p ANS="Proceed? [y/N] "
  if /I not "!ANS!"=="y" (
    if /I not "!ANS!"=="yes" (
      echo aborted.
      exit /b 1
    )
  )
)

echo.
echo Stopping Kari processes...

REM Kill the Electron shell + bundled-runtime children. /T also kills
REM descendant processes so the syncthing child dies with its parent.
taskkill /F /T /IM Kari.exe          >nul 2>&1
taskkill /F /T /IM kari-syncd.exe    >nul 2>&1
taskkill /F /T /IM syncthing.exe     >nul 2>&1
taskkill /F /T /IM kari.exe          >nul 2>&1
taskkill /F /T /IM frpc.exe          >nul 2>&1
taskkill /F /T /IM opencode.exe      >nul 2>&1
REM Brief pause so file handles are released before rd.
ping -n 2 127.0.0.1 >nul 2>&1

echo.
echo Removing app data...

call :remove "%USER_DATA%"
call :remove "%USER_DATA_LOCAL%"
call :remove "%USER_DATA_LOCAL_CACHE%"
call :remove "%USER_RUNTIME%"
call :remove "%CRASH_REPORTS%"
if defined APP_ROOT call :remove "%APP_ROOT%"

echo.
echo Done. To install a new build, unzip Kari-X.Y.Z-win.zip and run Kari.exe.
exit /b 0


:show
REM Print whether a target exists; called as :show "<path>"
set "TARGET=%~1"
if exist "%TARGET%\" (
  echo   [DIR ]  %TARGET%
) else (
  if exist "%TARGET%" (
    echo   [FILE]  %TARGET%
  ) else (
    echo   [----]  %TARGET%  ^(absent^)
  )
)
exit /b 0


:remove
REM Delete a directory or file silently; report result.
set "TARGET=%~1"
if not exist "%TARGET%" (
  exit /b 0
)
if exist "%TARGET%\" (
  rd /S /Q "%TARGET%" 2>nul
  if exist "%TARGET%\" (
    echo   FAILED:   %TARGET%   ^(in use? try closing Explorer windows showing it^)
  ) else (
    echo   removed:  %TARGET%
  )
) else (
  del /F /Q "%TARGET%" 2>nul
  if exist "%TARGET%" (
    echo   FAILED:   %TARGET%
  ) else (
    echo   removed:  %TARGET%
  )
)
exit /b 0
