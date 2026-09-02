# Despliega el proxy de Riot en Cloudflare Workers en tres pasos guiados.
#
#   .\deploy.ps1            # login (si hace falta) + clave + deploy
#   .\deploy.ps1 -SoloClave # solo renovar la clave (a diario si es de desarrollo)
#
# La clave se pide por teclado y va directa a Cloudflare como secreto: no se
# guarda en ningún fichero de este repo. Cloudflare Workers es gratis para este
# uso (100.000 peticiones al día en el plan Free).
param([switch]$SoloClave)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path "node_modules\.bin\wrangler.cmd")) {
    Write-Host "Instalando wrangler (una sola vez)..." -ForegroundColor Cyan
    npm install
}

if (-not $SoloClave) {
    Write-Host ""
    Write-Host "1/3  Cuenta de Cloudflare" -ForegroundColor Cyan
    Write-Host "     Se abre el navegador para iniciar sesión (o crear una cuenta gratis)."
    Write-Host "     Si ya has hecho login antes, este paso se salta solo."
    npx wrangler whoami 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { npx wrangler login }
}

Write-Host ""
Write-Host "2/3  Clave de la API de Riot" -ForegroundColor Cyan
Write-Host "     Pega la clave (RGAPI-...) y pulsa Enter. No se muestra al escribir."
Write-Host "     Se saca en https://developer.riotgames.com (Regenerate API key)."
npx wrangler secret put RIOT_API_KEY
if ($LASTEXITCODE -ne 0) { throw "No se pudo guardar la clave." }

if ($SoloClave) {
    Write-Host ""
    Write-Host "Clave renovada. No hace falta volver a desplegar." -ForegroundColor Green
    exit 0
}

Write-Host ""
Write-Host "3/3  Desplegar" -ForegroundColor Cyan
npx wrangler deploy
if ($LASTEXITCODE -ne 0) { throw "El despliegue falló." }

Write-Host ""
Write-Host "Listo. Copia la URL que termina en .workers.dev (sin barra final) en" -ForegroundColor Green
Write-Host "LeagueRecorder → Ajustes → Avanzado → Riot proxy URL." -ForegroundColor Green
Write-Host "Para renovar la clave mañana:  .\deploy.ps1 -SoloClave" -ForegroundColor Green
