<#
.SYNOPSIS
    Construye un runtime de Python embebido y autocontenido para el analizador
    de VODs, de modo que el usuario final NO necesite instalar Python ni OpenCV.

.DESCRIPTION
    Descarga la distribución "embeddable" oficial de Python, habilita pip y site,
    e instala las dependencias de requirements.txt dentro de la propia carpeta.
    El resultado (src-tauri/python-runtime/) se empaqueta como recurso de Tauri
    (ver tauri.conf.json) y queda junto al .exe en el instalador.

    El patrón es idéntico al de ffmpeg: binario pesado que se construye en CI /
    en local y se ignora en git (no se commitea).

.EXAMPLE
    pwsh python_scripts/setup_runtime.ps1
    pwsh python_scripts/setup_runtime.ps1 -Force          # reconstruye desde cero
#>
[CmdletBinding()]
param(
    [string]$PythonVersion = "3.12.7",
    [switch]$Force
)

$ErrorActionPreference = "Stop"

# Rutas: el script vive en python_scripts/, el runtime va en src-tauri/python-runtime/
$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot    = Split-Path -Parent $ScriptDir
$RuntimeDir  = Join-Path $RepoRoot "src-tauri\python-runtime"
$Requirements = Join-Path $ScriptDir "requirements.txt"

$PyShort = ($PythonVersion -split '\.')[0..1] -join ''   # "3.12.7" -> "312"
$EmbedUrl = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
$GetPipUrl = "https://bootstrap.pypa.io/get-pip.py"

$Marker = Join-Path $RuntimeDir ".runtime-ready"

if ((Test-Path $Marker) -and -not $Force) {
    Write-Host "[setup_runtime] Runtime ya construido en $RuntimeDir (usa -Force para rehacerlo)." -ForegroundColor Green
    exit 0
}

if (Test-Path $RuntimeDir) {
    Write-Host "[setup_runtime] Limpiando runtime anterior..."
    Remove-Item -Recurse -Force $RuntimeDir
}
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null

# 1) Descargar y extraer el Python embebible
$Tmp = Join-Path $env:TEMP "py-embed-$PythonVersion.zip"
Write-Host "[setup_runtime] Descargando Python $PythonVersion embebible..."
Invoke-WebRequest -Uri $EmbedUrl -OutFile $Tmp
Expand-Archive -Path $Tmp -DestinationPath $RuntimeDir -Force
Remove-Item $Tmp -Force

# 2) Habilitar 'site' y site-packages en el archivo ._pth
$PthFile = Join-Path $RuntimeDir "python$PyShort._pth"
if (-not (Test-Path $PthFile)) {
    throw "No se encontró $PthFile; ¿cambió el layout del zip embebible?"
}
$pth = Get-Content $PthFile
$pth = $pth -replace '^\s*#\s*import site', 'import site'
if ($pth -notcontains 'Lib\site-packages') {
    $pth += 'Lib\site-packages'
}
Set-Content -Path $PthFile -Value $pth -Encoding ascii

# 3) Bootstrap de pip
$PythonExe = Join-Path $RuntimeDir "python.exe"
$GetPip = Join-Path $RuntimeDir "get-pip.py"
Write-Host "[setup_runtime] Instalando pip..."
Invoke-WebRequest -Uri $GetPipUrl -OutFile $GetPip
& $PythonExe $GetPip --no-warn-script-location
Remove-Item $GetPip -Force

# 4) Instalar dependencias (numpy + opencv headless)
Write-Host "[setup_runtime] Instalando dependencias de $Requirements..."
& $PythonExe -m pip install --no-cache-dir --no-warn-script-location -r $Requirements

# 5) Verificación rápida de que cv2 importa dentro del runtime aislado
Write-Host "[setup_runtime] Verificando OpenCV en el runtime aislado..."
& $PythonExe -c "import cv2, numpy; print('OK cv2', cv2.__version__, '| numpy', numpy.__version__)"
if ($LASTEXITCODE -ne 0) {
    throw "El runtime se construyó pero cv2/numpy no importan. Revisa la versión de Python."
}

# Marcar como listo para builds incrementales
"ready $PythonVersion" | Set-Content -Path $Marker -Encoding ascii
Write-Host "[setup_runtime] Runtime listo en $RuntimeDir" -ForegroundColor Green
