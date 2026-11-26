@echo off
title ViBeTranslate - Haru-4B Full-Duplex Server (Port 8999)
cd /d "%~dp0"
set PYTHONDONTWRITEBYTECODE=1
if "%HARU_PORT%"=="" set HARU_PORT=8999
if "%HARU_HOST%"=="" set HARU_HOST=127.0.0.1
echo [Haru-Service] Iniciando servidor Full-Duplex multilingue en %HARU_HOST%:%HARU_PORT%...
python server.py
