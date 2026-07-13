//! Motor de grabación basado en **libobs** (proceso servidor `leaguerec-obs`), controlado por IPC.
//!
//! Sustituye al antiguo motor WGC (`wgc_recorder`). La API pública (`start_recording`,
//! `stop_recording`, `is_recording`, `detect_system_audio_device`) se mantiene idéntica para
//! los llamadores (`commands.rs`). El servidor libobs se lanza de forma perezosa en la primera
//! grabación y se **reutiliza** entre partidas (no se reinicia cada vez).
//!
//! El audio del juego se captura vía `wasapi_output_capture` (loopback nativo de OBS) → ya no hace
//! falta ningún dispositivo de audio virtual (VB-CABLE / virtual-audio-capturer).

use crate::commands::VideoSettings;
use crate::obs_client::{ObsClient, StartConfig};
use crate::storage::get_match_dir;
use std::path::PathBuf;
use std::sync::Mutex;

/// Nombre del named pipe (debe coincidir con el que pasamos al server con `--pipe`).
const PIPE_NAME: &str = "leaguerec-obs";
/// Segundos que mantiene el replay buffer en memoria (para clipar la última jugada).
const REPLAY_BUFFER_SECONDS: i32 = 30;
/// Ventana del cliente 3D de League. Se usa el modo "window_crop": el server captura el monitor y
/// recorta a la región de esta ventana (window_capture WGC no funciona en el proceso headless).
const GAME_WINDOW: &str = "League of Legends (TM) Client";

pub struct RecorderState {
    /// Servidor libobs persistente (se lanza perezosamente y se reutiliza).
    client: Mutex<Option<ObsClient>>,
    /// match_id de la grabación en curso. Refleja la INTENCIÓN de grabar (ver `is_recording`).
    current_match: Mutex<Option<String>>,
}

impl Default for RecorderState {
    fn default() -> Self {
        Self {
            client: Mutex::new(None),
            current_match: Mutex::new(None),
        }
    }
}

/// Rutas del runtime de OBS necesarias para lanzar el server.
struct ObsPaths {
    exe: PathBuf,      // leaguerec-obs.exe (dentro de bin/64bit, junto a obs.dll)
    rundir: PathBuf,   // build_x64/rundir/RelWithDebInfo
    deps_bin: PathBuf, // .deps/obs-deps-*-x64/bin (DLLs de ffmpeg)
}

/// Localiza el runtime de OBS. Orden:
///   1. PROD: `<dir_del_exe>/obs-runtime` (bundle autocontenido; las DLLs de ffmpeg van en bin/64bit).
///   2. DEV : env `LEAGUEREC_OBS_ROOT` o `third_party/obs-studio` (subiendo desde current_exe).
fn resolve_obs_paths() -> Result<ObsPaths, String> {
    // 0) Ruta explícita del runtime bundleado (la fija lib.rs desde resource_dir() en producción).
    if let Ok(p) = std::env::var("LEAGUEREC_OBS_RUNTIME") {
        let rt = PathBuf::from(p);
        let server = rt.join("bin").join("64bit").join("leaguerec-obs.exe");
        if server.exists() {
            let bin = rt.join("bin").join("64bit");
            return Ok(ObsPaths {
                exe: server,
                rundir: rt,
                deps_bin: bin,
            });
        }
    }

    // 1) Runtime empaquetado con la app (producción). Todo autocontenido en obs-runtime/. Según cómo
    //    empaquete Tauri los recursos, puede quedar junto al exe o bajo resources/.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for cand in [dir.join("obs-runtime"), dir.join("resources").join("obs-runtime")] {
                let server = cand.join("bin").join("64bit").join("leaguerec-obs.exe");
                if server.exists() {
                    let bin = cand.join("bin").join("64bit");
                    return Ok(ObsPaths {
                        exe: server,
                        rundir: cand,
                        deps_bin: bin, // en el bundle las DLLs de ffmpeg están en el propio bin/64bit
                    });
                }
            }
        }
    }

    // 2) Árbol de desarrollo third_party/obs-studio (env override o autodetección).
    let root = resolve_obs_root_dev()?;
    let rundir = root.join("build_x64").join("rundir").join("RelWithDebInfo");
    let exe = rundir.join("bin").join("64bit").join("leaguerec-obs.exe");
    if !exe.exists() {
        return Err(format!(
            "no existe el servidor de grabación: {} (ejecuta build-server.ps1)",
            exe.display()
        ));
    }
    // La carpeta de deps lleva fecha en el nombre; elegimos la última obs-deps-*-x64 (NO la qt6).
    let deps_root = root.join(".deps");
    let deps_bin = std::fs::read_dir(&deps_root)
        .map_err(|e| format!("no se pudo leer {}: {e}", deps_root.display()))?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("obs-deps-") && n.ends_with("-x64") && !n.contains("qt"))
                .unwrap_or(false)
        })
        .max()
        .map(|p| p.join("bin"))
        .ok_or_else(|| format!("no se encontró obs-deps-*-x64 en {}", deps_root.display()))?;

    Ok(ObsPaths {
        exe,
        rundir,
        deps_bin,
    })
}

/// Raíz del árbol de OBS de desarrollo (`third_party/obs-studio`), vía env o subiendo desde el exe.
fn resolve_obs_root_dev() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("LEAGUEREC_OBS_ROOT") {
        let pb = PathBuf::from(p);
        if pb.join("build_x64").exists() {
            return Ok(pb);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        for anc in exe.ancestors() {
            let cand = anc.join("third_party").join("obs-studio");
            if cand.join("build_x64").exists() {
                return Ok(cand);
            }
        }
    }
    Err("no se encontró el runtime de OBS (empaqueta obs-runtime, compila leaguerec-obs, o define LEAGUEREC_OBS_ROOT)".into())
}

/// Bitrate CBR (kbps) según la calidad configurada.
fn bitrate_for(quality: &str) -> i32 {
    match quality {
        "High" => 18000,
        "Medium" => 10000,
        "Low" => 6000,
        _ => 12000,
    }
}

/// Inicia la grabación del juego. Lanza el servidor libobs si aún no está vivo.
pub fn start_recording(
    match_id: &str,
    state: &RecorderState,
    settings: &VideoSettings,
) -> Result<String, String> {
    let mut cur = state.current_match.lock().unwrap();
    if cur.is_some() {
        return Err("La grabación ya está en curso".to_string());
    }

    let dir = get_match_dir(match_id);
    std::fs::create_dir_all(&dir).ok();
    let video_path = dir.join(format!("{}.mp4", match_id));
    let _ = std::fs::remove_file(&video_path);
    let out_str = video_path
        .to_str()
        .ok_or("Ruta de video inválida")?
        .to_string();

    let mut guard = state.client.lock().unwrap();
    if guard.is_none() {
        let paths = resolve_obs_paths()?;
        let client =
            ObsClient::spawn_and_connect(&paths.exe, &paths.rundir, &paths.deps_bin, PIPE_NAME)?;
        *guard = Some(client);
    }

    let cfg = StartConfig {
        // "window_crop": captura el monitor y recorta a la región de la ventana de League. Así graba
        // solo el juego aunque juegue en modo ventana. Fiable en headless (a diferencia de WGC window).
        source: "window_crop".to_string(),
        window: GAME_WINDOW.to_string(),
        out: out_str.clone(),
        fps: settings.fps,
        bitrate: bitrate_for(&settings.quality),
        ..Default::default()
    };

    let client = guard.as_mut().unwrap();
    if let Err(e) = client.start(&cfg) {
        // El server pudo haber muerto; lo descartamos para que se relance en el próximo intento.
        *guard = None;
        return Err(format!("No se pudo iniciar la grabación libobs: {e}"));
    }

    // Además de la grabación continua, arrancamos el replay buffer (concurrente, encoders
    // compartidos) para poder clipar los últimos segundos con save_replay(). Best-effort.
    if let Err(e) = client.start_replay(&cfg, REPLAY_BUFFER_SECONDS) {
        eprintln!("Aviso: no se pudo iniciar el replay buffer: {e}");
    }

    *cur = Some(match_id.to_string());
    println!("Grabadora libobs iniciada en: {}", out_str);
    Ok(out_str)
}

/// Guarda los últimos segundos del replay buffer a un clip. Devuelve la ruta del clip.
pub fn save_replay(state: &RecorderState) -> Result<String, String> {
    let mut guard = state.client.lock().unwrap();
    match guard.as_mut() {
        Some(client) => client.save_replay(),
        None => Err("No hay grabación activa para clipar".to_string()),
    }
}

/// Detiene la grabación en curso. El servidor libobs se mantiene vivo para la siguiente partida.
pub fn stop_recording(state: &RecorderState) -> Result<(), String> {
    let mut cur = state.current_match.lock().unwrap();
    if cur.is_none() {
        return Err("No hay ninguna grabación activa para detener".to_string());
    }

    let mut guard = state.client.lock().unwrap();
    if let Some(client) = guard.as_mut() {
        match client.stop() {
            Ok(file) => println!("Grabadora libobs detenida; archivo: {}", file),
            Err(e) => {
                eprintln!("Aviso: stop libobs falló ({e}); se descarta el servidor.");
                *guard = None; // forzar relanzamiento limpio la próxima vez
            }
        }
    }

    *cur = None;
    Ok(())
}

pub fn is_recording(state: &RecorderState) -> bool {
    // Refleja la INTENCIÓN de grabar (se pone en start, se quita en stop), NO si el output de OBS
    // sigue activo. Igual que con el motor WGC: si el juego se cierra al acabar la partida, la
    // captura pierde su target pero is_recording debe seguir true para que el monitor dispare
    // finalize_match (rama `!lol_running && recording`).
    state.current_match.lock().unwrap().is_some()
}

/// Apaga el servidor libobs (para llamar al cerrar la app, si se desea un cierre limpio).
pub fn shutdown_recorder(state: &RecorderState) {
    let mut guard = state.client.lock().unwrap();
    if let Some(mut client) = guard.take() {
        let _ = client.shutdown();
    }
    *state.current_match.lock().unwrap() = None;
}

pub fn detect_system_audio_device() -> Option<String> {
    // El audio del sistema se captura con el loopback nativo de OBS (wasapi_output_capture):
    // ya no se requiere un dispositivo de audio virtual.
    Some("OBS wasapi_output_capture".to_string())
}
