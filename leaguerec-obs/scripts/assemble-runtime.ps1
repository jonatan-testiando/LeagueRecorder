<#
  Ensambla un runtime de OBS mínimo y AUTOCONTENIDO para distribuir con la app.
  Copia solo lo que el grabador headless necesita (sin Qt/UI ni plugins de captura de
  dispositivos) a `src-tauri/obs-runtime/`, con las DLLs de ffmpeg dentro de bin/64bit
  para que no haga falta un PATH externo.

  Layout resultante (lo que espera recorder.rs en producción):
    obs-runtime/
      bin/64bit/        obs.dll, libobs-*.dll, w32-pthreads.dll, ffmpeg *.dll, leaguerec-obs.exe
      obs-plugins/64bit/ win-capture, win-wasapi, obs-ffmpeg, obs-nvenc, obs-x264 (.dll)
      data/libobs/       efectos base
      data/obs-plugins/  data de esos plugins (graphics-hook, etc.)

  Uso: ./assemble-runtime.ps1   (tras build-obs.ps1 y build-server.ps1)
#>
[CmdletBinding()]
param(
  [string]$ObsDir = (Join-Path $PSScriptRoot "..\..\third_party\obs-studio"),
  [string]$OutDir = (Join-Path $PSScriptRoot "..\..\src-tauri\obs-runtime")
)
$ErrorActionPreference = "Stop"
$ObsDir = [System.IO.Path]::GetFullPath($ObsDir)
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
$rundir = Join-Path $ObsDir "build_x64\rundir\RelWithDebInfo"
$serverExe = Join-Path $PSScriptRoot "..\build\RelWithDebInfo\leaguerec-obs.exe"
if (-not (Test-Path $rundir)) { throw "No existe el rundir de OBS: $rundir (ejecuta build-obs.ps1)" }
if (-not (Test-Path $serverExe)) { throw "No existe el server: $serverExe (ejecuta build-server.ps1)" }

$depsBin = Get-ChildItem (Join-Path $ObsDir ".deps") -Directory -Filter "obs-deps-*-x64" |
           Where-Object { $_.Name -notmatch 'qt' } | Sort-Object Name -Descending |
           Select-Object -First 1 | ForEach-Object { Join-Path $_.FullName "bin" }
if (-not $depsBin) { throw "No se encontró obs-deps-*-x64" }

# Plugins que usa el grabador (video/audio/encoders). El resto (aja, decklink, vst...) no se copia.
$plugins = @("win-capture", "win-wasapi", "obs-ffmpeg", "obs-nvenc", "obs-x264")

$binOut  = Join-Path $OutDir "bin\64bit"
$plugOut = Join-Path $OutDir "obs-plugins\64bit"
$dataObs = Join-Path $OutDir "data\libobs"
$dataPlg = Join-Path $OutDir "data\obs-plugins"
foreach ($d in @($binOut, $plugOut, $dataObs, $dataPlg)) { New-Item -ItemType Directory -Force $d | Out-Null }

Write-Host "Copiando libobs + runtime a $binOut ..." -ForegroundColor Cyan
foreach ($dll in @("obs.dll","libobs-d3d11.dll","libobs-winrt.dll","libobs-opengl.dll","w32-pthreads.dll")) {
  Copy-Item (Join-Path $rundir "bin\64bit\$dll") $binOut -Force
}
# Helpers .exe que OBS lanza como procesos aparte: muxeo (ffmpeg-mux) y sondeo de encoders
# (nvenc-test, amf-test). Sin ellos, la grabación y/o el encoder NVENC fallan.
foreach ($helper in @("obs-ffmpeg-mux.exe","obs-nvenc-test.exe","obs-amf-test.exe")) {
  $hp = Join-Path $rundir "bin\64bit\$helper"
  if (Test-Path $hp) { Copy-Item $hp $binOut -Force }
}
# DLLs de ffmpeg/zlib (deps) dentro de bin/64bit -> runtime autocontenido, sin PATH externo.
Copy-Item (Join-Path $depsBin "*.dll") $binOut -Force
# Nuestro servidor, junto a obs.dll (libobs busca data/ relativa al exe).
Copy-Item $serverExe $binOut -Force

Write-Host "Copiando plugins ($($plugins -join ', ')) ..." -ForegroundColor Cyan
foreach ($p in $plugins) {
  Copy-Item (Join-Path $rundir "obs-plugins\64bit\$p.dll") $plugOut -Force
  $pdata = Join-Path $rundir "data\obs-plugins\$p"
  if (Test-Path $pdata) { Copy-Item $pdata $dataPlg -Recurse -Force }
}

Write-Host "Copiando data/libobs ..." -ForegroundColor Cyan
Copy-Item (Join-Path $rundir "data\libobs\*") $dataObs -Recurse -Force

$size = (Get-ChildItem $OutDir -Recurse | Measure-Object Length -Sum).Sum / 1MB
Write-Host ("Runtime ensamblado en $OutDir ({0:N0} MB)" -f $size) -ForegroundColor Green
