<#
.SYNOPSIS
    Descarga el ffmpeg que se empaqueta con la app en src-tauri/bin/ffmpeg.exe.

.DESCRIPTION
    Mismo patrón que setup_runtime.ps1: binario pesado que se obtiene en local o en
    CI y se ignora en git. Se usa el build "essentials" de gyan.dev (el origen
    oficial de los builds de ffmpeg para Windows) y se verifica su SHA256 contra el
    hash publicado antes de instalarlo.

    Por qué "essentials" y no "full": la app solo necesita demux/mux de MP4, copia
    de streams y un decoder h264 con encoder mjpeg. El build completo pesa 217 MB
    para dar códecs que no se usan.

    Para qué se usa ffmpeg en la app (todo lo demás lo hace libobs):
      - recortar la grabación a su duración final al parar   (-c copy)
      - exportar clips y clips de error                      (-c copy)
      - extraer fotogramas JPEG para el generador de dataset (h264 -> mjpeg)
      - leer la resolución de un vídeo desde su cabecera

.EXAMPLE
    pwsh scripts/fetch-ffmpeg.ps1
    pwsh scripts/fetch-ffmpeg.ps1 -Force     # reemplaza el que ya hubiera
#>
[CmdletBinding()]
param(
    [string]$Url = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir
$BinDir    = Join-Path $RepoRoot "src-tauri\bin"
$Dest      = Join-Path $BinDir "ffmpeg.exe"

if ((Test-Path $Dest) -and -not $Force) {
    $mb = (Get-Item $Dest).Length / 1MB
    Write-Host ("[fetch-ffmpeg] Ya existe {0} ({1:N0} MB). Usa -Force para reemplazarlo." -f $Dest, $mb) -ForegroundColor Green
    exit 0
}

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$Tmp = Join-Path $env:TEMP "ffmpeg-essentials.zip"

Write-Host "[fetch-ffmpeg] Descargando $Url ..."
Invoke-WebRequest -Uri $Url -OutFile $Tmp

# El hash publicado vive junto al zip. Sin esta comprobación estaríamos metiendo un
# binario de terceros en el instalador a ciegas.
Write-Host "[fetch-ffmpeg] Verificando SHA256..."
$expected = (Invoke-WebRequest -Uri "$Url.sha256").Content.Trim().Split()[0]
$actual = (Get-FileHash $Tmp -Algorithm SHA256).Hash
if ($actual -ne $expected) {
    Remove-Item $Tmp -Force
    throw "SHA256 no coincide. Publicado: $expected / Descargado: $actual"
}
Write-Host "[fetch-ffmpeg] SHA256 OK: $actual" -ForegroundColor Green

$Extract = Join-Path $env:TEMP "ffmpeg-extract"
if (Test-Path $Extract) { Remove-Item -Recurse -Force $Extract }
Expand-Archive -Path $Tmp -DestinationPath $Extract -Force

# Solo ffmpeg.exe: ffprobe y ffplay no los usa nadie (la resolución se lee de la
# cabecera que ffmpeg escribe en stderr, ver proc::video_dimensions).
$src = Get-ChildItem $Extract -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
if (-not $src) { throw "El zip no contiene ffmpeg.exe" }
Copy-Item $src.FullName $Dest -Force

Remove-Item $Tmp -Force
Remove-Item -Recurse -Force $Extract

$ver = & $Dest -hide_banner -version 2>&1 | Select-Object -First 1
$mb = (Get-Item $Dest).Length / 1MB
Write-Host ("[fetch-ffmpeg] Instalado en {0} ({1:N0} MB)" -f $Dest, $mb) -ForegroundColor Green
Write-Host "[fetch-ffmpeg] $ver"
