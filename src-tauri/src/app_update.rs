//! Actualización en dos tiempos: descargar mientras trabajas, instalar cuando tú digas.
//!
//! El botón de Ajustes llamaba a `downloadAndInstall`, que hace las dos cosas de
//! una: pulsabas y te quedabas mirando ~100 MB de descarga con la app a punto de
//! cerrarse. Los treinta segundos que se sentían eternos eran la descarga, no la
//! instalación.
//!
//! Aquí se separan. Nada más arrancar, y en segundo plano, se comprueba y se
//! descarga el paquete —la app se usa con normalidad mientras tanto—. Cuando está
//! listo se avisa sin interrumpir, y al pulsar "instalar" ya no hay nada que
//! bajar: son unos segundos de instalador silencioso y la app vuelve sola.
//!
//! Por qué no se instala al cerrar, que sería lo ideal: con `installMode: "quiet"`
//! el plugin manda siempre `/S /R` al instalador de NSIS, y esa `/R` relanza la
//! app al terminar. Instalar al salir la resucitaría justo después de que la
//! hubieras cerrado. Quitar la `/R` obliga a construir los argumentos a mano
//! (`installMode: "basicUi"` + `installerArgs`), y su orden en la línea de
//! comandos no se puede comprobar sin publicar una release de verdad.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Margen antes de mirar si hay actualización: arrancar la app ya mueve disco y
/// red de sobra (biblioteca, runtime de OBS, detección de partida).
const STARTUP_GRACE: Duration = Duration::from_secs(25);

/// Paquete ya descargado y con la firma verificada, esperando a instalarse.
struct Pending {
    update: Update,
    bytes: Vec<u8>,
}

#[derive(Default)]
pub struct UpdateState {
    pending: Mutex<Option<Pending>>,
    /// Hay una descarga en marcha. Sin esto, pulsar "buscar actualizaciones"
    /// mientras la de fondo sigue bajando lanzaba una segunda descarga entera.
    downloading: AtomicBool,
}

/// Suelta la marca de "descargando" pase lo que pase, también si la descarga
/// falla a medias.
struct DownloadGuard<'a>(&'a AtomicBool);

impl Drop for DownloadGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Lo que la interfaz necesita saber de una actualización lista.
#[derive(Clone, Serialize)]
pub struct PendingInfo {
    pub version: String,
    pub notes: Option<String>,
}

/// Progreso de la descarga en segundo plano.
#[derive(Clone, Serialize)]
struct Progress {
    percent: u8,
    version: String,
}

/// Lanza la comprobación y descarga en segundo plano. No devuelve error: si no
/// hay red, o la release no existe, o el endpoint falla, se queda callada. Una
/// actualización que no se puede bajar no es un problema del usuario.
pub fn spawn_background_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_GRACE).await;
        match check_and_download(&app).await {
            Ok(Some(version)) => log::info!("actualización {version} descargada y lista"),
            Ok(None) => log::debug!("no hay actualización pendiente"),
            Err(err) => log::warn!("no se pudo preparar la actualización: {err}"),
        }
    });
}

async fn check_and_download(app: &AppHandle) -> Result<Option<String>, String> {
    let state = app.state::<UpdateState>();
    // Si ya hay una lista de una comprobación anterior, no se vuelve a bajar.
    if state.pending.lock().unwrap().is_some() {
        return Ok(None);
    }
    if state
        .downloading
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Ok(None); // ya hay una descarga en marcha
    }
    let _guard = DownloadGuard(&state.downloading);

    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(None);
    };

    let version = update.version.clone();
    let notes = update.body.clone();

    // El progreso se emite solo cuando cambia el porcentaje entero: por chunk
    // serían miles de eventos para pintar la misma barra.
    let mut downloaded: u64 = 0;
    let mut last_percent: u8 = u8::MAX;
    let progress_app = app.clone();
    let progress_version = version.clone();

    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                let Some(total) = total.filter(|t| *t > 0) else {
                    return;
                };
                let percent = ((downloaded * 100) / total).min(100) as u8;
                if percent != last_percent {
                    last_percent = percent;
                    let _ = progress_app.emit(
                        "update-progress",
                        Progress {
                            percent,
                            version: progress_version.clone(),
                        },
                    );
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;

    app.state::<UpdateState>()
        .pending
        .lock()
        .unwrap()
        .replace(Pending { update, bytes });

    let _ = app.emit(
        "update-ready",
        PendingInfo {
            version: version.clone(),
            notes,
        },
    );
    Ok(Some(version))
}

/// Qué hay descargado y esperando, si es que hay algo.
#[tauri::command]
pub fn get_pending_update(state: tauri::State<'_, UpdateState>) -> Option<PendingInfo> {
    state.pending.lock().unwrap().as_ref().map(|p| PendingInfo {
        version: p.update.version.clone(),
        notes: p.update.body.clone(),
    })
}

/// Instala lo ya descargado. En Windows esto **no vuelve**: el plugin lanza el
/// instalador y mata el proceso; la `/R` de NSIS relanza la app al acabar.
#[tauri::command]
pub fn install_pending_update(app: AppHandle) -> Result<(), String> {
    let pending = app
        .state::<UpdateState>()
        .pending
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| "No hay ninguna actualización descargada".to_string())?;

    // El servidor de grabación es un proceso hijo: si no se cierra antes, el
    // instalador se encuentra ficheros en uso.
    if let Some(state) = app.try_state::<std::sync::Arc<crate::recorder::RecorderState>>() {
        crate::recorder::shutdown_recorder(&state);
    }

    pending
        .update
        .install(&pending.bytes)
        .map_err(|e| e.to_string())
}

/// Comprobación a petición del usuario (el botón de Ajustes). Devuelve la versión
/// lista para instalar, o `None` si ya estás al día.
#[tauri::command]
pub async fn check_for_update_now(app: AppHandle) -> Result<Option<PendingInfo>, String> {
    check_and_download(&app).await?;
    Ok(get_pending_update(app.state::<UpdateState>()))
}
