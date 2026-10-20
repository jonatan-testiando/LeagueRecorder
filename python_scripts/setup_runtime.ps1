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
# El marcador guarda también el hash de requirements.txt: si cambian las versiones, el
# runtime local se rehace en vez de seguir con las de cuando se construyó. Sin esto, la
# máquina de desarrollo probaba con unas versiones y la instalación recibía otras.
$Ready = "ready $PythonVersion $((Get-FileHash $Requirements -Algorithm SHA256).Hash)"
$VcRuntime = Join-Path $RepoRoot "scripts\vc-runtime.ps1"

if ((Test-Path $Marker) -and ((Get-Content $Marker -Raw).Trim() -eq $Ready) -and -not $Force) {
    # Un runtime construido antes de que se copiara el de VC++ no lo trae: se completa aquí.
    & $VcRuntime -Dest $RuntimeDir -Scan $RuntimeDir
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

# 4b) Runtime de VC++ junto a python.exe. onnxruntime pide msvcp140.dll y msvcp140_1.dll, que
#     el Python embebible no trae: aquí los ponía Visual Studio en System32, y en un Windows sin
#     el redistribuible `import onnxruntime` fallaba (detector de minimapa y YOLO de VOD).
#     Windows busca las dependencias de un .pyd en la carpeta de python.exe antes que en System32.
& $VcRuntime -Dest $RuntimeDir -Scan $RuntimeDir

# 5) Verificación rápida de que cv2 importa dentro del runtime aislado
Write-Host "[setup_runtime] Verificando OpenCV en el runtime aislado..."
& $PythonExe -c "import cv2, numpy, onnxruntime; print('OK cv2', cv2.__version__, '| numpy', numpy.__version__, '| ort', onnxruntime.__version__)"
if ($LASTEXITCODE -ne 0) {
    throw "El runtime se construyó pero cv2/numpy/onnxruntime no importan. Revisa la versión de Python."
}

# 6) Podar lo que no se ejecuta nunca en el runtime del usuario.
#    - pip: solo hacía falta durante este script (~12 MB).
#    - tests/ de numpy: baterías de pruebas del propio paquete (~15 MB).
#    - __pycache__: se regenera solo si hiciera falta.
#    La verificación va ANTES a propósito, para no podar un runtime roto.
Write-Host "[setup_runtime] Podando lo que no se usa en ejecución..."
$before = (Get-ChildItem $RuntimeDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
$sitePkgs = Join-Path $RuntimeDir "Lib\site-packages"
$prune = @()
$prune += Get-ChildItem $sitePkgs -Directory -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -in @("pip", "pkg_resources", "setuptools") -or $_.Name -like "pip-*" }
$prune += Get-ChildItem $sitePkgs -Recurse -Directory -Filter "tests" -ErrorAction SilentlyContinue
$prune += Get-ChildItem $RuntimeDir -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue
foreach ($d in $prune) { if (Test-Path $d.FullName) { Remove-Item -Recurse -Force $d.FullName } }

# Con pip fuera, cv2/numpy tienen que seguir importando. Si no, es un fallo de build.
& $PythonExe -c "import cv2, numpy, onnxruntime" 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "La poda rompió el runtime: cv2/numpy ya no importan. Revisa la lista de directorios podados."
}
$after = (Get-ChildItem $RuntimeDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
Write-Host ("[setup_runtime] Podado: {0:N0} MB -> {1:N0} MB ({2:N0} MB menos)" -f $before, $after, ($before - $after)) -ForegroundColor Yellow

# Marcar como listo para builds incrementales
$Ready | Set-Content -Path $Marker -Encoding ascii
Write-Host "[setup_runtime] Runtime listo en $RuntimeDir" -ForegroundColor Green
