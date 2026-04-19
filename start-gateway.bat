@echo off
setlocal

echo [Lumina_PC] Starting Tool-Calling Proxy on port 4321...
start "Lumina Tool-Proxy" /min cmd /c "node C:\Lumina_PC\tool-proxy\server.mjs"

echo [Lumina_PC] Starting OpenClaw Gateway...
set OPENCLAW_BUNDLED_PLUGINS_DIR=C:\Lumina_PC\minimal-ext
cd /d "C:\Lumina_PC\Open_PC"
node --stack-size=65536 openclaw.mjs gateway run

endlocal
