@echo off
echo [Lumina_PC] Iniciando Tool-Proxy en puerto 4321...
start "Lumina Tool-Proxy" /min node "%~dp0tool-proxy\server.mjs"

echo [Lumina_PC] Iniciando OpenClaw Gateway...
start "Lumina Gateway" cmd /k "%~dp0run-gateway.bat"

echo [Lumina_PC] Listo - puedes cerrar esta ventana.
