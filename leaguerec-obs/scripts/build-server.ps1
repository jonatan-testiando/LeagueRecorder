<#
  Fase 1 — Compila el servidor headless (leaguerec-obs.exe) contra el libobs
  ya construido por build-obs.ps1.

  Uso:
    ./build-server.ps1
    ./build-server.ps1 -ObsDir D:\obs-studio   # árbol de OBS alternativo
#>
[CmdletBinding()]
param(
  [string]$ObsDir   = (Join-Path $PSScriptRoot "..\..\third_party\obs-studio"),
  [string]$BuildDir = (Join-Path $PSScriptRoot "..\build")
)

$ErrorActionPreference = "Stop"

function Find-VsCMake {
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path $vswhere)) { throw "vswhere no encontrado." }
  $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if (-not $vs) { $vs = & $vswhere -latest -products * -property installationPath }
  $cmake = Join-Path $vs "Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
  if (-not (Test-Path $cmake)) { throw "CMake no encontrado en $vs" }
  return $cmake
}

$cmake   = Find-VsCMake
$ObsDir  = [System.IO.Path]::GetFullPath($ObsDir)
$ObsBuild = Join-Path $ObsDir "build_x64"
$srcDir  = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))

if (-not (Test-Path (Join-Path $ObsDir "libobs\obs.h"))) {
  throw "No encuentro libobs en $ObsDir. Ejecuta primero build-obs.ps1."
}

Write-Host "Configurando leaguerec-obs ..." -ForegroundColor Cyan
& $cmake -S $srcDir -B $BuildDir -G "Visual Studio 17 2022" -A x64 `
    "-DOBS_SOURCE_DIR=$ObsDir" "-DOBS_BUILD_DIR=$ObsBuild"
if ($LASTEXITCODE -ne 0) { throw "configure falló ($LASTEXITCODE)" }

Write-Host "Compilando ..." -ForegroundColor Cyan
& $cmake --build $BuildDir --config RelWithDebInfo
if ($LASTEXITCODE -ne 0) { throw "build falló ($LASTEXITCODE)" }

$exe = Join-Path $BuildDir "RelWithDebInfo\leaguerec-obs.exe"

# Copiar el exe al bin/64bit de OBS (junto a obs.dll): libobs busca su data/ relativa al exe,
# y tanto run-dev.ps1 como recorder.rs (la app) esperan el server ahí.
$binDir = Join-Path $ObsBuild "rundir\RelWithDebInfo\bin\64bit"
if (Test-Path $binDir) {
  Copy-Item $exe $binDir -Force
  Write-Host "Servidor copiado a $binDir" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "Servidor compilado: $exe" -ForegroundColor Green
Write-Host "Ejecútalo con ./run-dev.ps1" -ForegroundColor Green
