@echo off
REM Seaport Global - Working Capital platform. Double-click to start, then open http://localhost:3000
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
node --disable-warning=ExperimentalWarning src\server.ts
pause
