<#
  Parche de libobs-winrt (captura WGC): limita el ritmo al que Windows entrega
  fotogramas a la captura.

  Sin tope, WGC entrega un fotograma por cada vez que se recompone el
  escritorio: 240 por segundo en un monitor de 240 Hz con League sin limite de
  FPS. OBS copia cada uno (CopyResource de la pantalla entera) aunque el lienzo
  vaya a 60. Con `GraphicsCaptureSession.MinUpdateInterval` (Windows 11 24H2 en
  adelante; antes no existe y no se toca nada) se limita al DOBLE de los FPS del
  lienzo: al componer siempre hay un fotograma de hace menos de medio periodo,
  asi que la grabacion no gana repetidos, y se copian la mitad o menos.

  Lo llama build-obs.ps1 tras clonar. Idempotente: si ya esta, no hace nada.
#>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$ObsDir)

$f = Join-Path $ObsDir "libobs-winrt\winrt-capture.cpp"
if (-not (Test-Path $f)) { throw "No encuentro $f" }
$txt = [System.IO.File]::ReadAllText($f)
if ($txt.Contains("leaguerec_limitar_ritmo")) {
  Write-Host "Parche WGC ya aplicado." -ForegroundColor DarkGray
  return
}
$nl = if ($txt.Contains("`r`n")) { "`r`n" } else { "`n" }

# `MinUpdateInterval` solo existe en las cabeceras C++/WinRT del SDK 10.0.26100
# en adelante. OBS compila con el SDK más nuevo instalado (build-obs.ps1 lo fija
# en el preset): si ese no lo trae, el parche no compilaría y se tumbaría la
# release entera. Sin él se graba igual, solo que sin el tope de ritmo.
$sdk = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\Include" -Directory -ErrorAction SilentlyContinue |
       Where-Object { $_.Name -match '^10\.' } | Sort-Object { [version]$_.Name } -Descending |
       Select-Object -First 1
$cab = if ($sdk) { Join-Path $sdk.FullName "cppwinrt\winrt\impl\windows.graphics.capture.0.h" } else { $null }
if (-not $cab -or -not (Test-Path $cab) -or -not (Select-String -Path $cab -SimpleMatch "MinUpdateInterval" -Quiet)) {
  Write-Warning "Parche WGC NO aplicado: el SDK de Windows ($($sdk.Name)) no trae MinUpdateInterval."
  return
}

$ayuda = @'
/* [leaguerec] Ritmo de la captura WGC: como mucho el doble de los FPS del
 * lienzo (ver leaguerec-obs/scripts/parche-wgc.ps1). Sin esto Windows entrega
 * un fotograma por cada recomposicion del escritorio (240/s a 240 Hz) y cada
 * uno se copia entero aunque se grabe a 60. */
static void leaguerec_limitar_ritmo(const winrt::Windows::Graphics::Capture::GraphicsCaptureSession &session)
try {
	if (!winrt::Windows::Foundation::Metadata::ApiInformation::IsPropertyPresent(
		    L"Windows.Graphics.Capture.GraphicsCaptureSession", L"MinUpdateInterval"))
		return;
	struct obs_video_info ovi;
	if (!obs_get_video_info(&ovi) || !ovi.fps_num)
		return;
	/* TimeSpan cuenta en unidades de 100 ns. */
	const int64_t intervalo = (int64_t)10000000 * ovi.fps_den / (2 * (int64_t)ovi.fps_num);
	session.MinUpdateInterval(winrt::Windows::Foundation::TimeSpan{intervalo});
	blog(LOG_INFO, "[leaguerec] WGC: un fotograma como mucho cada %.2f ms", intervalo / 10000.0);
} catch (...) {
	blog(LOG_WARNING, "[leaguerec] WGC: sin MinUpdateInterval (0x%08X)", winrt::to_hresult().value);
}

'@ -replace "`r?`n", $nl

$ancla = "static bool winrt_capture_border_toggle_supported()"
if (-not $txt.Contains($ancla)) { throw "Parche WGC: no encuentro '$ancla' (¿otra versión de OBS?)" }
$txt = $txt.Replace($ancla, $ayuda + $ancla)

$sesion = "frame_pool.CreateCaptureSession(item);"
$n = ([regex]::Matches($txt, [regex]::Escape($sesion))).Count
if ($n -lt 1) { throw "Parche WGC: no encuentro '$sesion'" }
$txt = $txt.Replace($sesion, $sesion + $nl + "`tleaguerec_limitar_ritmo(session);")

[System.IO.File]::WriteAllText($f, $txt, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Parche WGC aplicado ($n sesiones)." -ForegroundColor DarkGray
