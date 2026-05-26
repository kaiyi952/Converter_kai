@echo off
setlocal

cd /d "%~dp0"

REM Start the Node server in a minimized background window.
REM If the server is already running, this will fail silently (port in use),
REM but Chrome will still open and use the existing instance.
start "Word HTML Converter Server" /MIN cmd /c "node server.js"

REM Give the server a moment to bind to the port.
timeout /t 1 /nobreak >nul

REM Launch Chrome in app mode (no address bar, no tabs - looks like a desktop app).
start chrome --app=http://localhost:3000

endlocal
