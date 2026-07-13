<#
  Descarga los retratos (square) de TODOS los campeones de League desde Data Dragon a
  public/champions/<Champion>.png, para no depender de la CDN en runtime (ahorra recursos y
  evita fallos de red). Se sirven como estáticos de Vite en /champions/<Champion>.png.

  Uso: ./scripts/download-champions.ps1
#>
[CmdletBinding()]
param(
  [string]$OutDir = (Join-Path $PSScriptRoot "..\public\champions")
)
$ErrorActionPreference = "Stop"
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Force $OutDir | Out-Null

Write-Host "Obteniendo última versión de Data Dragon..." -ForegroundColor Cyan
$ver = (Invoke-RestMethod "https://ddragon.leagueoflegends.com/api/versions.json")[0]
Write-Host "Versión: $ver" -ForegroundColor DarkGray

$champs = (Invoke-RestMethod "https://ddragon.leagueoflegends.com/cdn/$ver/data/en_US/champion.json").data.PSObject.Properties.Name
Write-Host ("Descargando $($champs.Count) campeones...") -ForegroundColor Cyan

$ok = 0; $fail = 0
foreach ($c in $champs) {
  $dest = Join-Path $OutDir "$c.png"
  if (Test-Path $dest) { $ok++; continue }
  try {
    Invoke-WebRequest "https://ddragon.leagueoflegends.com/cdn/$ver/img/champion/$c.png" -OutFile $dest -UseBasicParsing
    $ok++
  } catch { Write-Host "  falló $c" -ForegroundColor Yellow; $fail++ }
}
Write-Host ("Listo: $ok descargados, $fail fallidos -> $OutDir") -ForegroundColor Green
# Guardamos la versión usada para referencia.
Set-Content (Join-Path $OutDir "_version.txt") $ver -NoNewline
