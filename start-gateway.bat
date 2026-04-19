@echo off
setlocal

echo [Lumina_PC] Starting Tool-Calling Proxy on port 4321...
start "Lumina Tool-Proxy" /min cmd /c "node \"%~dp0tool-proxy\server.mjs\""

echo [Lumina_PC] Starting OpenClaw Gateway...
set OPENCLAW_CONFIG_PATH=%USERPROFILE%\.lumina\openclaw.json
set OPENCLAW_STATE_DIR=%USERPROFILE%\.lumina\openclaw-state
set OPENCLAW_BUNDLED_PLUGINS_DIR=%~dp0Open_PC\dist-runtime\extensions
cd /d "%~dp0Open_PC"
node --stack-size=65536 openclaw.mjs gateway run

endlocal
