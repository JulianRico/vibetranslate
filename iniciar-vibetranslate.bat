@echo off
title ViBeTranslate Pro Studio - Launcher Completo
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
set PYTHONDONTWRITEBYTECODE=1

echo =====================================================================
echo   ViBeTranslate Pro Studio + Haru-4B (A10G) + PersonaPlex Full-Duplex
echo =====================================================================

netstat -ano | findstr ":8998 " | findstr "LISTENING" >nul 2>&1
if errorlevel 1 (
    echo [1/3] Iniciando microservicio PersonaPlex en 127.0.0.1:8998...
    start "ViBeTranslate - PersonaPlex (8998)" /min cmd /c "cd /d "%~dp0personaplex_service" && python server.py"
) else (
    echo [1/3] PersonaPlex ya esta activo en 127.0.0.1:8998.
)

netstat -ano | findstr ":8999 " | findstr "LISTENING" >nul 2>&1
if errorlevel 1 (
    echo [2/3] Iniciando microservicio Haru-4B (HF ZeroGPU A10G) en 127.0.0.1:8999...
    start "ViBeTranslate - Haru-4B (8999)" /min cmd /c "cd /d "%~dp0haru_service" && python server.py"
) else (
    echo [2/3] Haru-4B ya esta activo en 127.0.0.1:8999.
)

echo [3/3] Abriendo ViBeTranslate Pro Studio...
cd /d "%~dp0electron_app"
start "" "%~dp0electron_app\node_modules\electron\dist\electron.exe" .
