@echo off
title ViBeTranslate - Servidor VoxCPM Ultrarrapido
cd /d "%~dp0"
echo =====================================================================
echo    Iniciando Servidor VoxCPM - Microservicio de Audio para ViBeTranslate
echo =====================================================================
echo.

REM Verificar si Python está instalado
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python no se encuentra instalado o no esta en el PATH.
    echo Por favor instala Python 3.10 o superior.
    pause
    exit /b 1
)

REM Instalar dependencias si faltan
echo [1/2] Verificando dependencias necesarias...
pip install -r requirements.txt

echo.
echo [2/2] Iniciando servidor VoxCPM en puerto 8765...
echo =====================================================================
echo Servidor listo en: http://127.0.0.1:8765
echo WebSocket Streaming en: ws://127.0.0.1:8765/v1/tts/live
echo =====================================================================
echo.
python server.py

pause
