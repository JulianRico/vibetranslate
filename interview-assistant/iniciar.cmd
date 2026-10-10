@echo off
setlocal
cd /d "%~dp0"
if not exist ".env" (
  echo Falta el archivo .env: copia .env.example a .env y pon tu GEMINI_API_KEY.
  echo Sin clave la app funciona en modo reducido: DOCX y texto si; PDF, audio y sugerencias no.
  echo.
)
if not defined PORT set PORT=3100
rem NO_BROWSER=1 arranca solo el servidor (lo usan las pruebas); normalmente abre Chrome en la URL.
if not defined NO_BROWSER start "" /b cmd /c timeout /t 2 /nobreak ^>nul ^& start "" chrome http://127.0.0.1:%PORT%
node server.js
echo.
echo El servidor se detuvo. Pulsa una tecla para cerrar.
pause >nul
