<#
  Ejecuta leaguerec-obs.exe con el entorno correcto:
    - OBS_RUNDIR apunta al rundir de OBS (plugins + data)
    - el bin/64bit de OBS se antepone al PATH para que cargue obs.dll
      (libobs localiza su data/libobs relativa a obs.dll)

  Uso:
    ./run-dev.ps1 -Source monitor -Seconds 10 -Out "$env:USERPROFILE\Desktop\smoke.mp4"
    ./run-dev.ps1 -Source game -Window "League of Legends (TM) Client" -Seconds 15 -Out clip.mp4
#>
[CmdletBinding()]
param(
  [ValidateSet("monitor","game")][string]$Source = "monitor",
  [string]$Window = "",
  [string]$Exe = "",
  [string]$Out = "$env:USERPROFILE\Desktop\leaguerec-smoke.mp4",
  [int]$Seconds = 10,
  [int]$Fps = 60,
  [int]$Bitrate = 12000,
  [string]$ObsDir = (Join-Path $PSScriptRoot "..\..\third_party\obs-studio"),
  [string]$BuildDir = (Join-Path $PSScriptRoot "..\build")
)

$ErrorActionPreference = "Stop"

$ObsDir = [System.IO.Path]::GetFullPath($ObsDir)
$rundir = Join-Path $ObsDir "build_x64\rundir\RelWithDebInfo"
if (-not (Test-Path $rundir)) { throw "Rundir de OBS no encontrado: $rundir. ¿Compilaste OBS?" }

$exe = Join-Path ([System.IO.Path]::GetFullPath($BuildDir)) "RelWithDebInfo\leaguerec-obs.exe"
if (-not (Test-Path $exe)) { throw "leaguerec-obs.exe no encontrado. Ejecuta build-server.ps1." }

# El PATH necesita DOS directorios de OBS:
#   - bin/64bit          -> obs.dll y libobs-*.dll
#   - .deps/.../bin       -> DLLs de ffmpeg (avcodec/avformat/...) y zlib que obs.dll importa
# (el rundir de OBS no copia las de ffmpeg; hay que exponerlas nosotros)
$binDir  = Join-Path $rundir "bin\64bit"
# La carpeta de deps lleva fecha en el nombre (obs-deps-YYYY-MM-DD-x64) y cambia por versión de OBS.
$depsRoot = Join-Path $ObsDir ".deps"
$depsBin = Get-ChildItem $depsRoot -Directory -Filter "obs-deps-*-x64" -ErrorAction SilentlyContinue |
           Sort-Object Name -Descending | Select-Object -First 1 |
           ForEach-Object { Join-Path $_.FullName "bin" }
if (-not $depsBin -or -not (Test-Path $depsBin)) { throw "DLLs de deps no encontradas bajo $depsRoot" }

$env:OBS_RUNDIR = $rundir
$env:PATH = $binDir + ";" + $depsBin + ";" + $env:PATH

# libobs busca su carpeta data/libobs (los .effect) RELATIVA a la ubicación del EXE
# (espera <exe>/../../data/libobs). Por eso el server debe ejecutarse desde bin/64bit,
# junto a obs.dll y data/, igual que hace ascent-obs. Copiamos el exe ahí.
$exeInBin = Join-Path $binDir "leaguerec-obs.exe"
Copy-Item $exe $exeInBin -Force

$args = @("--source", $Source, "--out", $Out, "--seconds", $Seconds, "--fps", $Fps, "--bitrate", $Bitrate)
if ($Window) { $args += @("--window", $Window) }
if ($Exe)    { $args += @("--exe", $Exe) }

Write-Host "OBS_RUNDIR = $rundir" -ForegroundColor DarkGray
Write-Host "Ejecutando: $exeInBin $($args -join ' ')" -ForegroundColor Cyan
Push-Location $binDir
try { & $exeInBin @args } finally { Pop-Location }
Write-Host "Salida: $Out" -ForegroundColor Green
