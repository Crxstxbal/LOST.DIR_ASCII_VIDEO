@echo off
rem LOST.DIR — ASCII CINEMA: lanza el estudio local y abre el navegador.
cd /d "%~dp0"
if not exist node_modules (
  echo Instalando dependencias...
  call npm install
)
start "" http://localhost:5178/
call npx vite --port 5178 --strictPort
