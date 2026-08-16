@echo off
REM Relanza el rastreador del corpus. Es reanudable: continua donde se quedo,
REM asi que se puede ejecutar tantas veces como haga falta (tras un reinicio,
REM tras matarlo, tras un corte de red).
REM
REM Si cambias la clave en el portal de Riot, cambiala tambien aqui.

set RIOT_KEY=RGAPI-b2aaaa32-24bb-4379-8a86-a40746288eb0
set DESTINO=D:\lol-corpus

cd /d "%~dp0..\.."
echo Reanudando el rastreo en %DESTINO% ...
python tools\corpus\crawl.py --out "%DESTINO%" --target 50000
pause
