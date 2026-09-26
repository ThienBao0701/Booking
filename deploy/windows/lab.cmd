@echo off
rem Automation Lab deployment entry point (Phase 15). Uses the Node.js on PATH
rem (22.6 or newer); the installed service runs on its own bundled copy.
rem   lab install [--extension-id <id>] [--port 4577] [--safety-mode OBSERVE]
rem   lab upgrade | uninstall [--purge-data] | status | start | stop | restart | config ...
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.6 or newer is required: winget install OpenJS.NodeJS.LTS
  exit /b 2
)
node --experimental-strip-types --experimental-sqlite --no-warnings "%~dp0..\..\windows-service\src\deploy\cli.ts" %*
exit /b %errorlevel%
