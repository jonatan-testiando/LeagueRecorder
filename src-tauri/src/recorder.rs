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
use crate::obs_client::{ObsClient, ObsStatus, StartConfig};
use crate::storage::get_match_dir;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

/// Nombre del named pipe (debe coincidir con el que pasamos al server con `--pipe`).
const PIPE_NAME: &str = "leaguerec-obs";
/// Segundos que mantiene el replay buffer en memoria (para clipar la última jugada).
pub const REPLAY_BUFFER_SECONDS: i32 = 30;
/// Ventana del cliente 3D de League. Se usa el modo "window_crop": el server captura el monitor y
/// recorta a la región de esta ventana (window_capture WGC no funciona en el proceso headless).
pub const GAME_WINDOW: &str = "League of Legends (TM) Client";
/// Techo del lienzo. Por encima el archivo se dispara y el encoder empieza a ser
/// el cuello de botella de la partida, no de la grabación.
const MAX_CANVAS: (u32, u32) = (2560, 1440);

pub struct RecorderState {
    /// Servidor libobs persistente (se lanza perezosamente y se reutiliza).
    client: Mutex<Option<ObsClient>>,
    /// match_id de la grabación en curso. Refleja la INTENCIÓN de grabar (ver `is_recording`).
    current_match: Mutex<Option<String>>,
    /// Cuándo arrancó la grabación en curso. Sirve para nombrar los clips del
    /// replay con el segundo de vídeo en el que caen.
    started_at: Mutex<Option<Instant>>,
    /// Último "¿hay loopback de audio?" que contestó el servidor. `None` = aún no
    /// se ha preguntado nunca (no es lo mismo que "no hay").
    audio_ok: Mutex<Option<bool>>,
}

impl Default for RecorderState {
    fn default() -> Self {
        Self {
            client: Mutex::new(None),
            current_match: Mutex::new(None),
            started_at: Mutex::new(None),
            audio_ok: Mutex::new(None),
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

/// CQP (calidad constante de NVENC) según la calidad configurada. Menor = más nitidez y más peso.
/// Ojo con la escala: es inversa al bitrate que había antes, y cada -6 puntos duplica el tamaño
/// aproximadamente. Por debajo de 18 no se gana nada visible y el archivo se dispara.
fn cqp_for(quality: &str) -> i32 {
    match quality {
        "High" => 20,
        "Medium" => 23,
        "Low" => 26,
        _ => 23,
    }
}

/// Lienzo (base y salida) con el que se graba.
///
/// El valor por defecto es "native": el tamaño REAL del área cliente de League.
/// Hasta ahora el servidor grababa siempre a 1920×1080 fijo, así que quien juega
/// a 1440p perdía resolución sin ganar nada. Si el juego no está abierto se cae
/// al monitor donde suele estar, y en último término a 1080p.
pub fn canvas_size(settings: &VideoSettings) -> (i32, i32) {
    let (w, h) = match settings.resolution.as_str() {
        "1080p" => (1920, 1080),
        "1440p" => (2560, 1440),
        _ => crate::winsys::window_client_size(GAME_WINDOW)
            .or_else(|| crate::winsys::monitor_of_window(GAME_WINDOW).map(|m| (m.width, m.height)))
            .unwrap_or((1920, 1080)),
    };
    clamp_canvas(w, h)
}

/// Acota a `MAX_CANVAS` conservando la relación de aspecto y deja los dos lados
/// PARES: NVENC rechaza dimensiones impares y el fallo sale como "no se pudo
/// iniciar la grabación", que no señala a ningún sitio.
fn clamp_canvas(w: u32, h: u32) -> (i32, i32) {
    if w == 0 || h == 0 {
        return (1920, 1080);
    }
    let (max_w, max_h) = MAX_CANVAS;
    let escala = (max_w as f64 / w as f64)
        .min(max_h as f64 / h as f64)
        .min(1.0);
    let mut w = (w as f64 * escala).round() as i32;
    let mut h = (h as f64 * escala).round() as i32;
    w -= w % 2;
    h -= h % 2;
    (w.max(2), h.max(2))
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

    let (width, height) = canvas_size(settings);
    let cfg = StartConfig {
        // "window_crop": captura el monitor y recorta a la región de la ventana de League. Así graba
        // solo el juego aunque juegue en modo ventana. Fiable en headless (a diferencia de WGC window).
        source: "window_crop".to_string(),
        window: GAME_WINDOW.to_string(),
        out: out_str.clone(),
        fps: settings.fps,
        cqp: cqp_for(&settings.quality),
        width,
        height,
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
    *state.started_at.lock().unwrap() = Some(Instant::now());
    println!(
        "Grabadora libobs iniciada en: {} ({}x{} @ {}fps)",
        out_str, width, height, settings.fps
    );
    Ok(out_str)
}

/// Guarda los últimos segundos del replay buffer a un clip. Devuelve la ruta del clip,
/// ya movido a la carpeta de la partida y con el nombre que espera `get_all_clips`.
pub fn save_replay(state: &RecorderState) -> Result<String, String> {
    // Los datos de la sesión ANTES de tocar el cliente: los dos mutex se toman
    // siempre en el mismo orden (current_match → client), igual que en start/stop.
    let (match_id, elapsed) = {
        let cur = state.current_match.lock().unwrap();
        let Some(id) = cur.clone() else {
            return Err("No hay grabación activa para clipar".to_string());
        };
        let started = *state.started_at.lock().unwrap();
        (
            id,
            started.map(|t| t.elapsed().as_secs_f64()).unwrap_or(0.0),
        )
    };

    let raw = {
        let mut guard = state.client.lock().unwrap();
        match guard.as_mut() {
            Some(client) => client.save_replay()?,
            None => return Err("No hay servidor de grabación activo".to_string()),
        }
    };
    if raw.is_empty() {
        return Err("el servidor no devolvió ninguna ruta de clip".to_string());
    }

    Ok(rename_replay_clip(&match_id, &raw, elapsed))
}

/// Renombra el clip que escribió OBS (`replay_2026-09-02_12-00-00.mp4`) al formato
/// que la biblioteca sabe listar: `<match_id>_clip_<mmss>.mp4` dentro de la carpeta
/// de la partida. `elapsed` son los segundos de vídeo que llevaba la grabación; el
/// nombre lleva el INICIO del clip (30 s antes), que es el punto al que se salta.
///
/// Si el renombrado falla se devuelve la ruta original: perder el clip por no
/// poder ponerle un nombre bonito sería el peor resultado posible.
fn rename_replay_clip(match_id: &str, raw: &str, elapsed: f64) -> String {
    let origen = PathBuf::from(raw);
    let inicio = (elapsed - REPLAY_BUFFER_SECONDS as f64).max(0.0) as u64;
    let dir = get_match_dir(match_id);
    for intento in 0..100u32 {
        let sufijo = if intento == 0 {
            String::new()
        } else {
            format!("_{}", intento)
        };
        let destino = dir.join(format!(
            "{}_clip_{:02}{:02}{}.mp4",
            match_id,
            inicio / 60,
            inicio % 60,
            sufijo
        ));
        if destino.exists() {
            continue;
        }
        return match std::fs::rename(&origen, &destino) {
            Ok(()) => destino.to_string_lossy().to_string(),
            Err(e) => {
                eprintln!(
                    "Replay: no se pudo renombrar {} → {}: {e}",
                    origen.display(),
                    destino.display()
                );
                raw.to_string()
            }
        };
    }
    raw.to_string()
}

/// Detiene la grabación en curso. El servidor libobs se mantiene vivo para la siguiente partida.
///
/// Devuelve `Err` si el servidor no pudo cerrar la grabación: quien llama tiene
/// que enterarse, porque en ese caso el mp4 puede haber quedado a medias o no
/// existir. El estado local se limpia igualmente.
pub fn stop_recording(state: &RecorderState) -> Result<(), String> {
    let mut cur = state.current_match.lock().unwrap();
    if cur.is_none() {
        return Err("No hay ninguna grabación activa para detener".to_string());
    }

    let mut fallo = None;
    {
        let mut guard = state.client.lock().unwrap();
        if let Some(client) = guard.as_mut() {
            match client.stop() {
                Ok(file) => println!("Grabadora libobs detenida; archivo: {}", file),
                Err(e) => {
                    eprintln!("Aviso: stop libobs falló ({e}); se descarta el servidor.");
                    *guard = None; // forzar relanzamiento limpio la próxima vez
                    fallo = Some(e);
                }
            }
        }
    }

    *cur = None;
    *state.started_at.lock().unwrap() = None;
    match fallo {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// Pregunta al servidor si el output sigue emitiendo de verdad.
///
/// `None` = no hay servidor al que preguntar, que es "no se sabe" y nunca
/// "se murió". Si el pipe SÍ está pero falla, eso es otra cosa: el protocolo es
/// síncrono y bloqueante, así que un error de lectura/escritura significa que el
/// proceso servidor ya no está. En ese caso se descarta el cliente (para que la
/// próxima grabación lo relance limpio) y se reporta inactivo.
pub fn probe_status(state: &RecorderState) -> Option<ObsStatus> {
    let respuesta = {
        let mut guard = state.client.lock().unwrap();
        let client = guard.as_mut()?;
        match client.status() {
            Ok(st) => st,
            Err(e) => {
                eprintln!("El servidor de grabación no responde ({e}); se descarta.");
                *guard = None;
                ObsStatus {
                    active: false,
                    recording: false,
                    audio: false,
                }
            }
        }
    };
    // La caché de audio solo se refresca con una respuesta REAL del servidor y
    // mientras haya algo emitiendo: con la tubería parada `audio_src_` es null
    // de todos modos, y guardar ese false diría que no hay audio cuando lo hay.
    if respuesta.active {
        *state.audio_ok.lock().unwrap() = Some(respuesta.audio);
    }
    Some(respuesta)
}

/// Si la fuente de loopback de audio llegó a crearse en la última sesión.
/// `None` mientras no se haya podido preguntar nunca.
pub fn last_audio_ok(state: &RecorderState) -> Option<bool> {
    *state.audio_ok.lock().unwrap()
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
    *state.started_at.lock().unwrap() = None;
}

pub fn detect_system_audio_device() -> Option<String> {
    // El audio del sistema se captura con el loopback nativo de OBS (wasapi_output_capture):
    // ya no se requiere un dispositivo de audio virtual. Pero el loopback necesita
    // que exista una salida de audio: sin ella no hay nada que capturar y decir
    // que sí era mentira.
    if crate::winsys::has_playback_device() {
        Some("OBS wasapi_output_capture (loopback)".to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::clamp_canvas;

    #[test]
    fn el_lienzo_respeta_el_techo_y_la_forma() {
        // Nativo por debajo del techo: se graba tal cual.
        assert_eq!(clamp_canvas(1920, 1080), (1920, 1080));
        assert_eq!(clamp_canvas(2560, 1440), (2560, 1440));
        // 4K se baja a 1440p conservando el 16:9, no se recorta.
        assert_eq!(clamp_canvas(3840, 2160), (2560, 1440));
        // Ultrapanorámico: manda el lado que primero toca el techo.
        assert_eq!(clamp_canvas(3440, 1440), (2560, 1072));
        // Lados impares (una ventana arrastrada a mano) quedan pares: NVENC los
        // rechaza y el fallo salía como "no se pudo iniciar la grabación".
        assert_eq!(clamp_canvas(1601, 901), (1600, 900));
        // Sin datos no se inventa un lienzo de 0: 1080p, como antes de esto.
        assert_eq!(clamp_canvas(0, 0), (1920, 1080));
    }
}
