<#
  Fase 0 — Clona y compila OBS Studio desde fuente (RelWithDebInfo, x64).

  Compilamos OBS por dos razones:
    1) Obtener obs.lib + headers para enlazar nuestro servidor headless.
    2) Obtener obs.dll + los plugins (win-capture, obs-ffmpeg/nvenc, win-wasapi)
       para cargarlos en runtime.

  El preset 'windows-x64' de OBS descarga automáticamente las dependencias
  prebuilt y usa el generador "Visual Studio 17 2022" (funciona con Build Tools).

  Uso:
    ./build-obs.ps1                      # versión por defecto
    ./build-obs.ps1 -ObsVersion 30.2.3   # fija otra versión
    ./build-obs.ps1 -Clean               # borra el árbol y reclona
#>
[CmdletBinding()]
param(
  [string]$ObsVersion = "32.1.2",
  [string]$ObsDir     = (Join-Path $PSScriptRoot "..\..\third_party\obs-studio"),
  [switch]$Clean
)

$ErrorActionPreference = "Stop"

function Find-VsCMake {
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path $vswhere)) { throw "vswhere no encontrado; ¿Visual Studio Build Tools instalado?" }
  $vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if (-not $vs) { $vs = & $vswhere -latest -products * -property installationPath }
  if (-not $vs) { throw "No se encontró instalación de Visual Studio con toolset C++." }
  $cmake = Join-Path $vs "Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
  if (-not (Test-Path $cmake)) { throw "CMake no encontrado en $vs. Instala el componente CMake de VS." }
  return $cmake
}

$cmake = Find-VsCMake
Write-Host "CMake: $cmake" -ForegroundColor Cyan

$ObsDir = [System.IO.Path]::GetFullPath($ObsDir)

if ($Clean -and (Test-Path $ObsDir)) {
  Write-Host "Limpiando $ObsDir ..." -ForegroundColor Yellow
  Remove-Item -Recurse -Force $ObsDir
}

if (-not (Test-Path $ObsDir)) {
  Write-Host "Clonando OBS $ObsVersion (recursive) ..." -ForegroundColor Cyan
  New-Item -ItemType Directory -Force (Split-Path $ObsDir) | Out-Null
  git clone --recursive --depth 1 --branch $ObsVersion https://github.com/obsproject/obs-studio.git $ObsDir
} else {
  Write-Host "Reutilizando árbol existente en $ObsDir" -ForegroundColor DarkGray
}

# --- Parche de plugins ---------------------------------------------------------
# El toolset MSVC nuevo (14.44) rompe al compilar OBS 30.2.3 en plugins que NO
# necesitamos para grabar League y que dependen de ATL (no instalado en Build Tools):
#   - win-dshow  : captura DirectShow (webcams/capturadoras) + soporte Elgato (atlstr.h)
#   - obs-qsv11  : encoder Intel QSV (atlbase.h)  [se puede re-activar instalando ATL]
# Los comentamos en plugins/CMakeLists.txt de forma idempotente.
$pluginsCMake = Join-Path $ObsDir "plugins\CMakeLists.txt"
if (Test-Path $pluginsCMake) {
  # win-dshow no tiene flag ENABLE_ propio; hay que comentar su add_obs_plugin (depende de ATL vía Elgato).
  # obs-qsv11 se desactiva con -DENABLE_QSV11=OFF (no hace falta patch).
  $txt = Get-Content $pluginsCMake -Raw
  $txt = [regex]::Replace($txt, '(?m)^(\s*)(add_obs_plugin\(win-dshow\b)', '$1# [leaguerec] $2')
  Set-Content -Path $pluginsCMake -Value $txt -NoNewline
  Write-Host "Plugin win-dshow excluido (ATL)." -ForegroundColor DarkGray
}

# OBS 31/32 fija en el preset la versión exacta del Windows SDK (10.0.22621.0). Si esta máquina
# tiene otra (p.ej. 10.0.26100.0), el generador falla. Reescribimos la versión pinneada a la instalada.
$presets = Join-Path $ObsDir "CMakePresets.json"
if (Test-Path $presets) {
  $sdk = (Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\Include" -Directory -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -match '^10\.' } | Sort-Object { [version]$_.Name } -Descending |
          Select-Object -First 1).Name
  if ($sdk) {
    $pj = Get-Content $presets -Raw
    $pj = [regex]::Replace($pj, 'version=10\.0\.\d+\.\d+', "version=$sdk")
    Set-Content -Path $presets -Value $pj -NoNewline
    Write-Host "Windows SDK del preset fijado a $sdk." -ForegroundColor DarkGray
  }
}

Push-Location $ObsDir
try {
  # build_x64 limpio para asegurar reconfiguración con ENABLE_UI/WX nuevos.
  $bx = Join-Path $ObsDir "build_x64"
  if (Test-Path (Join-Path $bx "CMakeCache.txt")) { Remove-Item -Recurse -Force $bx }

  Write-Host "Configurando (headless: UI OFF, browser/websocket OFF, /WX OFF) ..." -ForegroundColor Cyan
  & $cmake --preset windows-x64 `
      -DENABLE_UI=OFF `
      -DENABLE_FRONTEND=OFF `
      -DENABLE_SCRIPTING=OFF `
      -DENABLE_BROWSER=OFF `
      -DENABLE_WEBSOCKET=OFF `
      -DENABLE_QSV11=OFF `
      -DCMAKE_COMPILE_WARNING_AS_ERROR=OFF
  if ($LASTEXITCODE -ne 0) { throw "cmake configure falló ($LASTEXITCODE)" }

  Write-Host "Compilando RelWithDebInfo (esto tarda) ..." -ForegroundColor Cyan
  & $cmake --build --preset windows-x64 --config RelWithDebInfo
  if ($LASTEXITCODE -ne 0) { throw "cmake build falló ($LASTEXITCODE)" }
}
finally { Pop-Location }

Write-Host ""
Write-Host "OBS compilado. Árbol: $ObsDir" -ForegroundColor Green
Write-Host "  Build dir esperado: $ObsDir\build_x64" -ForegroundColor Green
Write-Host "Siguiente: ./build-server.ps1" -ForegroundColor Green
