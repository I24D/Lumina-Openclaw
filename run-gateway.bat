@echo off
set OPENCLAW_CONFIG_PATH=%USERPROFILE%\.openclaw\openclaw.json
set OPENCLAW_STATE_DIR=%USERPROFILE%\.lumina\openclaw-state
set OPENCLAW_BUNDLED_PLUGINS_DIR=%~dp0Open_PC\dist-runtime\extensions
cd /d "%~dp0Open_PC"
node --stack-size=65536 --max-old-space-size=4096 openclaw.mjs gateway run
