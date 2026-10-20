<#
.SYNOPSIS
    Copia el runtime de Visual C++ (vcruntime140, msvcp140...) junto a los binarios
    que se empaquetan, y falla si alguno lo sigue pidiendo a System32.

.DESCRIPTION
    leaguerec-obs.exe, libobs y sus plugins, y onnxruntime enlazan el runtime de VC++
    de forma dinámica. En la máquina de desarrollo y en el runner de CI está
    instalado en System32 (lo trae Visual Studio), así que todo carga; en un Windows
    sin el redistribuible no existe, y:
      - el servidor de grabación no arranca ("no se encontró VCRUNTIME140.dll"),
      - `import onnxruntime` falla, y con él el detector de minimapa y el YOLO de VOD.
    Además, quien tenga un redistribuible VIEJO (anterior a 14.40) puede cargarlo y
    reventar en std::mutex con binarios compilados con el toolset nuevo.

    El arreglo estándar es el despliegue local a la app: las DLL de
    Microsoft.VC14x.CRT en la carpeta del .exe que las carga, que Windows mira antes
    que System32. Se copian del Redist de Visual Studio, que es de donde Microsoft
    permite redistribuirlas.

    Con -Scan, además, revisa con dumpbin todo binario bajo esa carpeta: cada DLL del
    runtime que importe tiene que estar en -Dest. Es lo que hace que esto no vuelva a
    pasar en silencio la próxima vez que entre un plugin o una wheel nueva.

.EXAMPLE
    pwsh scripts/vc-runtime.ps1 -Dest src-tauri/obs-runtime/bin/64bit -Scan src-tauri/obs-runtime
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Dest,
    [string]$Scan
)

$ErrorActionPreference = "Stop"
$Dest = [System.IO.Path]::GetFullPath($Dest)
if (-not (Test-Path $Dest)) { throw "[vc-runtime] No existe la carpeta destino: $Dest" }

$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path $vswhere)) { throw "[vc-runtime] No se encontró vswhere.exe: hace falta Visual Studio (o Build Tools) con las herramientas de C++." }
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1
if (-not $vs) { throw "[vc-runtime] Visual Studio no tiene instaladas las herramientas de C++ x64." }

# El Redist trae una carpeta por versión (14.44.35112...) y otra "v143" solo con los instaladores.
$redist = Get-ChildItem (Join-Path $vs "VC\Redist\MSVC") -Directory |
          Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } |
          Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
$crt = if ($redist) { Get-ChildItem (Join-Path $redist.FullName "x64") -Directory -Filter "Microsoft.VC*.CRT" | Select-Object -First 1 }
if (-not $crt) { throw "[vc-runtime] No se encontró x64\Microsoft.VC*.CRT en $vs\VC\Redist\MSVC" }

Copy-Item (Join-Path $crt.FullName "*.dll") $Dest -Force
Write-Host "[vc-runtime] Runtime de VC++ $($redist.Name) copiado a $Dest" -ForegroundColor Green

if (-not $Scan) { return }

$Scan = [System.IO.Path]::GetFullPath($Scan)
$dumpbin = Get-ChildItem (Join-Path $vs "VC\Tools\MSVC\*\bin\Hostx64\x64\dumpbin.exe") |
           Sort-Object { [version]$_.Directory.Parent.Parent.Parent.Name } -Descending | Select-Object -First 1
if (-not $dumpbin) { throw "[vc-runtime] No se encontró dumpbin.exe para revisar los imports." }

# Solo los nombres estándar: las wheels que vendorizan su propia copia la renombran
# con un hash (numpy.libs\msvcp140-<hash>.dll) y la cargan ellas mismas.
$vcName = '^(vcruntime140(_1|_threads)?|msvcp140(_1|_2|_atomic_wait|_codecvt_ids)?|concrt140|vccorlib140|vcomp140|vcamp140)\.dll$'
$faltan = @()
$binarios = Get-ChildItem $Scan -Recurse -File -Include *.exe, *.dll, *.pyd
foreach ($b in $binarios) {
    $deps = & $dumpbin.FullName /nologo /dependents $b.FullName |
            ForEach-Object { $_.Trim() } | Where-Object { $_ -match $vcName }
    foreach ($d in $deps) {
        if (-not (Test-Path (Join-Path $Dest $d))) { $faltan += "$($b.FullName.Substring($Scan.Length + 1)) -> $d" }
    }
}
if ($faltan.Count -gt 0) {
    throw "[vc-runtime] Binarios que piden el runtime de VC++ y no lo encontrarían en un Windows limpio:`n  " + ($faltan -join "`n  ")
}
Write-Host "[vc-runtime] $($binarios.Count) binarios revisados en ${Scan}: ninguno depende del runtime de VC++ del sistema." -ForegroundColor Green
