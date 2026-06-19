use crate::commands::VideoSettings;
use crate::storage::get_match_dir;
use crate::wgc_recorder::start_wgc_recording;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Estado de una grabación en curso: el video va por WGC (hilo propio) y el audio del sistema
/// por un ffmpeg en paralelo. Al detener se muxean en el {match_id}.mp4 final.
struct RecordingSession {
    is_active: Arc<Mutex<bool>>,
    finished: Arc<AtomicBool>,
    audio_child: Option<Child>,
    video_path: PathBuf,
    audio_path: PathBuf,
}

pub struct RecorderState {
    session: Mutex<Option<RecordingSession>>,
}

impl Default for RecorderState {
    fn default() -> Self {
        Self {
            session: Mutex::new(None),
        }
    }
}

/// Localiza el ffmpeg empaquetado (junto al ejecutable) o cae al del PATH.
fn ffmpeg_path() -> String {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let bundled = parent.join("bin").join("ffmpeg.exe");
            if bundled.exists() {
                return bundled.to_string_lossy().to_string();
            }
            let dev = parent.join("../../bin/ffmpeg.exe");
            if dev.exists() {
                return dev.to_string_lossy().to_string();
            }
        }
    }
    "ffmpeg".to_string()
}

/// Lanza un ffmpeg que captura el audio del SISTEMA (loopback) a un .m4a AAC. Stdin queda abierto
/// para poder enviarle 'q' y que cierre el contenedor limpiamente.
fn start_system_audio_capture(audio_path: &Path) -> Option<Child> {
    let mut cmd = Command::new(ffmpeg_path());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    cmd.args([
        "-y",
        "-f",
        "dshow",
        "-thread_queue_size",
        "1024",
        "-i",
        "audio=virtual-audio-capturer",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        &audio_path.to_string_lossy(),
    ])
    .stdin(Stdio::piped())
    .stdout(Stdio::null())
    .stderr(Stdio::null());

    cmd.spawn().ok()
}

/// Inicia la grabación: audio del sistema (ffmpeg) + video del juego (WGC), en paralelo.
pub fn start_recording(
    match_id: &str,
    state: &RecorderState,
    settings: &VideoSettings,
) -> Result<String, String> {
    let mut guard = state.session.lock().unwrap();
    if guard.is_some() {
        return Err("La grabación ya está en curso".to_string());
    }

    let dir = get_match_dir(match_id);
    std::fs::create_dir_all(&dir).ok();
    let video_path = dir.join(format!("{}.mp4", match_id));
    let audio_path = dir.join(format!("{}_audio.m4a", match_id));
    let video_path_str = video_path
        .to_str()
        .ok_or("Ruta de video inválida")?
        .to_string();

    // Limpiar restos previos (evita errores de creación de contenedor).
    let _ = std::fs::remove_file(&video_path);
    let _ = std::fs::remove_file(&audio_path);

    // Arrancamos el audio PRIMERO: dshow tarda más en inicializar que WGC, así quedan mejor
    // alineados. La captura de audio es de coste despreciable (no toca la GPU).
    let audio_child = start_system_audio_capture(&audio_path);
    if audio_child.is_none() {
        eprintln!("Aviso: no se pudo iniciar la captura de audio del sistema (se grabará sin sonido).");
    }

    // Capturamos el juego en 3D ("League of Legends (TM) Client", no el launcher).
    let (is_active, finished) =
        start_wgc_recording("League of Legends (TM) Client", video_path_str.clone(), settings.fps as u32, &settings.quality);

    *guard = Some(RecordingSession {
        is_active,
        finished,
        audio_child,
        video_path,
        audio_path,
    });

    println!("Grabadora WGC + audio del sistema iniciada en: {}", video_path_str);
    Ok(video_path_str)
}

/// Detiene la grabación: para el video y el audio, espera a que el mp4 se finalice y muxea el audio.
pub fn stop_recording(state: &RecorderState) -> Result<(), String> {
    let session = state.session.lock().unwrap().take();
    let mut s = match session {
        Some(s) => s,
        None => return Err("No hay ninguna grabación activa para detener".to_string()),
    };

    // 1) Señal de parada al video WGC.
    *s.is_active.lock().unwrap() = false;

    // 2) Detener el ffmpeg de audio limpiamente ('q' por stdin) y esperar a que cierre el .m4a.
    if let Some(mut child) = s.audio_child.take() {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(b"q\n");
            let _ = stdin.flush();
        }
        let _ = child.wait();
    }

    // 3) Esperar a que WGC finalice el mp4 (escribe el moov atom DESPUÉS de la señal). Máx ~8s.
    for _ in 0..80 {
        if s.finished.load(Ordering::SeqCst) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    // 4) Muxear audio + video en el {match_id}.mp4 final (copia de streams, sin recodificar).
    let file_ok = |p: &Path| p.exists() && std::fs::metadata(p).map(|m| m.len() > 1024).unwrap_or(false);
    if file_ok(&s.video_path) && file_ok(&s.audio_path) {
        let muxed = s.video_path.with_extension("muxed.mp4");
        let mut cmd = Command::new(ffmpeg_path());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000);
        let status = cmd
            .args([
                "-y",
                "-i",
                &s.video_path.to_string_lossy(),
                "-i",
                &s.audio_path.to_string_lossy(),
                "-c",
                "copy",
                "-map",
                "0:v:0",
                "-map",
                "1:a:0",
                "-shortest",
                "-movflags",
                "+faststart",
                &muxed.to_string_lossy(),
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();

        match status {
            Ok(st) if st.success() => {
                let _ = std::fs::remove_file(&s.video_path);
                let _ = std::fs::rename(&muxed, &s.video_path);
                println!("Grabadora detenida; audio del sistema muxeado en el video.");
            }
            _ => {
                let _ = std::fs::remove_file(&muxed);
                eprintln!("Aviso: el mux de audio falló; se conserva el video sin sonido.");
            }
        }
    } else {
        println!("Grabadora detenida; sin pista de audio para muxear (video conservado).");
    }

    // Limpiar el .m4a temporal.
    let _ = std::fs::remove_file(&s.audio_path);
    Ok(())
}

pub fn is_recording(state: &RecorderState) -> bool {
    // Refleja la INTENCIÓN de grabar (se pone en start, se quita en stop), NO si el hilo de WGC
    // sigue vivo. WGC se auto-detiene cuando la ventana del juego se cierra al acabar la partida;
    // si is_recording cayera a false ahí, el monitor nunca dispararía finalize_match (la rama
    // `!lol_running && recording`) y no se guardaría la metadata de la partida.
    state.session.lock().unwrap().is_some()
}

pub fn detect_system_audio_device() -> Option<String> {
    // El audio del sistema se captura con ffmpeg dshow "virtual-audio-capturer".
    Some("virtual-audio-capturer".to_string())
}
