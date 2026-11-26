@echo off
title ViBeTranslate - NVIDIA PersonaPlex Full-Duplex Server
echo ===================================================================
echo Iniciando Microservicio PersonaPlex (Full-Duplex 24kHz) en :8998...
echo ===================================================================
if "%PERSONAPLEX_PORT%"=="" set PERSONAPLEX_PORT=8998
if "%PERSONAPLEX_HOST%"=="" set PERSONAPLEX_HOST=127.0.0.1
python "%~dp0server.py"
pause
