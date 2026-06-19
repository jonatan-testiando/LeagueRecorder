use crate::storage::get_match_dir;
use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

pub struct RecorderState {
    pub child_process: Mutex<Option<Child>>,
}

impl Default for RecorderState {
    fn default() -> Self {
        Self {
            child_process: Mutex::new(None),
        }
    }
}

fn get_ffmpeg_executable() -> String {
    // 1. Verificar si existe empaquetado junto al ejecutable (Producción)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(parent) = exe_path.parent() {
            // Tauri lo coloca en la subcarpeta bin si se especifica así en resources, o en la raíz
            let bundled_bin = parent.join("bin").join("ffmpeg.exe");
            if bundled_bin.exists() {
                if let Some(path_str) = bundled_bin.to_str() {
                    return path_str.to_string();
                }
            }
            let bundled_root = parent.join("ffmpeg.exe");
            if bundled_root.exists() {
                if let Some(path_str) = bundled_root.to_str() {
                    return path_str.to_string();
                }
            }
            // En desarrollo local (cargo run), probamos subir un par de niveles y buscar en src-tauri/bin
            let local_dev = parent.join("../../bin/ffmpeg.exe");
            if local_dev.exists() {
                if let Some(path_str) = local_dev.to_str() {
                    return path_str.to_string();
                }
            }
        }
    }

    // 2. Probar en la ruta de links de WinGet (Fallback)
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let winget_path = std::path::Path::new(&local_app_data)
            .join("Microsoft")
            .join("WinGet")
            .join("Links")
            .join("ffmpeg.exe");
        if winget_path.exists() {
            if let Some(path_str) = winget_path.to_str() {
                return path_str.to_string();
            }
        }
    }

    // 2. Comprobar si está disponible en el PATH
    let mut cmd = Command::new("ffmpeg");
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    if cmd
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok()
    {
        return "ffmpeg".to_string();
    }

    "ffmpeg".to_string()
}

/// Enumera los dispositivos de audio DirectShow consultando a FFmpeg en tiempo de ejecución.
/// Esto evita codificar nombres de dispositivos que pueden no existir en el equipo.
pub fn list_audio_devices() -> Vec<String> {
    let ffmpeg = get_ffmpeg_executable();
    let mut cmd = Command::new(&ffmpeg);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = cmd
        .args([
            "-hide_banner",
            "-list_devices",
            "true",
            "-f",
            "dshow",
            "-i",
            "dummy",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output();

    let mut devices = Vec::new();
    if let Ok(out) = output {
        let stderr = String::from_utf8_lossy(&out.stderr);
        for line in stderr.lines() {
            // Solo nos interesan las líneas de dispositivos de audio, p.ej:
            //   [in#0 @ ...] "Micrófono (PD200X Podcast Microphone)" (audio)
            if line.contains("(audio)") {
                if let Some(start) = line.find('"') {
                    if let Some(end) = line[start + 1..].find('"') {
                        let name = &line[start + 1..start + 1 + end];
                        if !name.is_empty() {
                            devices.push(name.to_string());
                        }
                    }
                }
            }
        }
    }
    devices
}

/// Devuelve el dispositivo de captura de AUDIO DEL SISTEMA (lo que se escucha por los altavoces)
/// más adecuado de entre los disponibles. Prioriza dispositivos virtuales de loopback.
pub fn detect_system_audio_device() -> Option<String> {
    let devices = list_audio_devices();
    // Orden de preferencia para capturar el SONIDO DEL JUEGO (no el micrófono).
    // Priorizamos dispositivos de LOOPBACK PASIVO que capturan lo que ya suena por los
    // altavoces/auriculares sin reenrutar nada ni añadir latencia. "CABLE Output" (VB-CABLE)
    // va al final porque sólo capta audio si se reenruta la salida hacia él (añade latencia).
    let priorities = [
        "virtual-audio-capturer", // screen-capture-recorder: loopback del dispositivo por defecto
        "stereo mix",
        "mezcla estéreo",
        "mezcla estereo",
        "what u hear",
        "wave out mix",
        "voicemeeter out", // VoiceMeeter (si el usuario lo usa)
        "cable output",    // VB-CABLE (requiere reenrutar la salida hacia el cable)
    ];

    for needle in priorities {
        if let Some(found) = devices.iter().find(|d| d.to_lowercase().contains(needle)) {
            return Some(found.clone());
        }
    }
    None
}

/// Devuelve un micrófono como último recurso de audio (no captura el sonido del juego).
fn detect_microphone_device() -> Option<String> {
    let devices = list_audio_devices();
    devices.into_iter().find(|d| {
        let l = d.to_lowercase();
        l.contains("micr") || l.contains("microphone") || l.contains("mic ")
    })
}

#[derive(Clone, Copy)]
enum VideoMode {
    GpuNvenc,   // Captura DirectX (ddagrab) + codificación por GPU (NVENC). Cero impacto de CPU.
    GpuX264, // Captura DirectX (ddagrab) + codificación por CPU (x264). Captura sin coste, encode ligero.
    CpuGdigrab, // Captura GDI + codificación por CPU. Compatibilidad máxima.
}

use crate::commands::VideoSettings;

/// Construye los argumentos de FFmpeg para un modo de vídeo y un dispositivo de audio opcional.
fn build_ffmpeg_args(
    video_path: &str,
    mode: VideoMode,
    audio: Option<&str>,
    settings: &VideoSettings,
) -> Vec<String> {
    let mut args: Vec<String> = vec!["-y".into()];

    let fps = settings.fps.to_string();
    let (nvenc_cq, x264_crf) = match settings.quality.as_str() {
        "High" => ("24", "23"),
        "Medium" => ("28", "28"),
        "Low" => ("32", "32"),
        _ => ("24", "23"),
    };

    match mode {
        VideoMode::GpuNvenc | VideoMode::GpuX264 => {
            args.extend(["-init_hw_device".into(), "d3d11va".into()]);

            let has_audio = audio.is_some();
            // Etiquetamos la salida [v] sólo cuando hay audio (para poder mapear ambos streams).
            let label = if has_audio { "[v]" } else { "" };
            let scale_y = match settings.resolution.as_str() {
                "720p" => "720",
                _ => "1080",
            };
            let filter = match mode {
                // NVENC: path ZERO-COPY. ddagrab entrega frames BGRA que viven en la GPU (D3D11)
                // y h264_nvenc los consume DIRECTAMENTE (sin hwdownload ni escalado por CPU). Esto
                // captura a resolución nativa con coste de CPU prácticamente nulo => no baja FPS en
                // el juego. No se escala porque scale_d3d11 está roto en este build/driver y bajar a
                // RAM para escalar (lo que hacía antes) era justo lo que comía CPU. NVENC convierte
                // BGRA->yuv420p internamente, así que el MP4 sigue siendo reproducible en el WebView.
                VideoMode::GpuNvenc => {
                    format!("ddagrab=0:framerate={}{}", fps, label)
                }
                // x264 (fallback por CPU): aquí sí bajamos a RAM y escalamos, porque el encode es
                // por software de todas formas. format=bgra es el formato nativo de DDA en FFmpeg 8.x.
                _ => {
                    format!(
                        "ddagrab=0:framerate={},hwdownload,format=bgra,scale=-2:{},format=yuv420p{}",
                        fps, scale_y, label
                    )
                }
            };
            args.extend(["-filter_complex".into(), filter]);

            // Cuando hay audio, el dshow es el ÚNICO input real, por tanto índice 0.
            if let Some(dev) = audio {
                args.extend([
                    "-thread_queue_size".into(),
                    "1024".into(),
                    "-f".into(),
                    "dshow".into(),
                    "-rtbufsize".into(),
                    "256M".into(),
                    "-i".into(),
                    format!("audio={}", dev),
                    "-map".into(),
                    "[v]".into(),
                    "-map".into(),
                    "0:a".into(),
                ]);
            }

            // Codificador de vídeo
            match mode {
                VideoMode::GpuNvenc => args.extend([
                    "-c:v".into(),
                    "h264_nvenc".into(),
                    // Preset de baja latencia (ll) y sin B-frames: reduce la presión sobre el
                    // encoder y evita el fallo "CreateInputBuffer failed: invalid param" que
                    // aparece en algunos drivers/GPU (Blackwell) cuando hay un juego acaparando
                    // recursos de la GPU. -surfaces acotado limita la memoria de buffers de entrada.
                    "-preset".into(),
                    "p5".into(),
                    "-tune".into(),
                    "ll".into(),
                    "-rc".into(),
                    "vbr".into(),
                    "-cq".into(),
                    nvenc_cq.into(),
                    "-b:v".into(),
                    "0".into(),
                    "-bf".into(),
                    "0".into(),
                    "-g".into(),
                    "120".into(),
                    "-surfaces".into(),
                    "16".into(),
                ]),
                _ => args.extend([
                    "-c:v".into(),
                    "libx264".into(),
                    "-preset".into(),
                    "ultrafast".into(),
                    "-crf".into(),
                    x264_crf.into(),
                ]),
            }
        }
        VideoMode::CpuGdigrab => {
            // Captura GDI del escritorio (input #0)
            args.extend([
                "-thread_queue_size".into(),
                "1024".into(),
                "-f".into(),
                "gdigrab".into(),
                "-framerate".into(),
                fps,
                "-i".into(),
                "desktop".into(),
            ]);

            if let Some(dev) = audio {
                // dshow audio = input #1
                args.extend([
                    "-thread_queue_size".into(),
                    "1024".into(),
                    "-f".into(),
                    "dshow".into(),
                    "-rtbufsize".into(),
                    "256M".into(),
                    "-i".into(),
                    format!("audio={}", dev),
                    "-map".into(),
                    "0:v".into(),
                    "-map".into(),
                    "1:a".into(),
                ]);
            }

            let scale_y = match settings.resolution.as_str() {
                "720p" => "720",
                _ => "1080",
            };
            args.extend([
                "-vf".into(),
                format!("scale=-2:{}", scale_y),
                "-c:v".into(),
                "libx264".into(),
                "-preset".into(),
                "ultrafast".into(),
                "-crf".into(),
                x264_crf.into(),
            ]);
        }
    }

    // Codificador de audio común (sólo si hay audio)
    if audio.is_some() {
        args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "160k".into()]);
    }

    // Compatibilidad de reproducción en el WebView (H.264 yuv420p) y faststart para
    // que el reproductor pueda buscar/seek aunque el archivo crezca.
    // faststart para que el reproductor pueda buscar/seek aunque el archivo crezca.
    if !matches!(mode, VideoMode::GpuNvenc) {
        args.extend(["-pix_fmt".into(), "yuv420p".into()]);
    }

    args.extend([
        "-movflags".into(),
        "+faststart".into(),
        video_path.into(),
    ]);

    args
}

/// Lanza FFmpeg y verifica que siga vivo tras un margen suficiente para detectar
/// fallos de inicialización del codificador (NVENC puede tardar ~1s en abortar).
fn spawn_ffmpeg_and_verify(ffmpeg_exe: &str, args: &[String]) -> Option<Child> {
    let mut cmd = Command::new(ffmpeg_exe);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let log_path = std::env::temp_dir().join("leaguerecorder_ffmpeg.log");
    let stderr_dest = match std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(true)
        .open(&log_path)
    {
        Ok(file) => Stdio::from(file),
        Err(_) => Stdio::null(),
    };

    match cmd
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(stderr_dest)
        .spawn()
    {
        Ok(mut child) => {
            std::thread::sleep(std::time::Duration::from_millis(1200));
            match child.try_wait() {
                Ok(None) => Some(child), // sigue vivo => grabación en marcha
                _ => {
                    let _ = child.kill();
                    None
                }
            }
        }
        Err(_) => None,
    }
}

/// Inicia la grabación de video+audio en segundo plano con una cascada robusta de fallback.
pub fn start_recording(
    match_id: &str,
    state: &RecorderState,
    settings: &VideoSettings,
) -> Result<String, String> {
    let mut child_guard = state.child_process.lock().unwrap();
    if child_guard.is_some() {
        return Err("La grabación ya está en curso".to_string());
    }

    let dir = get_match_dir(match_id);
    let video_path = dir.join(format!("{}.mp4", match_id));
    let video_path_str = video_path.to_str().ok_or("Ruta de video inválida")?;
    let ffmpeg_exe = get_ffmpeg_executable();

    // Elegir la mejor fuente de audio disponible: primero el audio del SISTEMA (sonido del juego),
    // si no, un micrófono, si no, sin audio.
    let system_audio = detect_system_audio_device();
    let audio_device = system_audio.clone().or_else(detect_microphone_device);

    match &system_audio {
        Some(d) => println!("Grabadora: audio del sistema detectado -> '{}'", d),
        None => match &audio_device {
            Some(d) => println!(
                "Grabadora: sin audio de sistema; usando micrófono -> '{}'",
                d
            ),
            None => println!(
                "Grabadora: no se detectó ningún dispositivo de audio; se grabará sin sonido."
            ),
        },
    }

    // Cascada de intentos. PRIORIDAD: codificación por GPU (NVENC) ante todo, porque es la que
    // no consume CPU y no baja FPS en el juego. Agotamos TODAS las variantes de NVENC (con y sin
    // audio) ANTES de caer a x264; de lo contrario un fallo puntual de NVENC+audio degradaba la
    // grabación a x264 por CPU (que tira los FPS). x264 y luego gdigrab quedan solo como red de
    // seguridad de compatibilidad. Para cada modo probamos primero con audio y luego sin audio.
    let modes = [
        VideoMode::GpuNvenc,
        VideoMode::GpuX264,
        VideoMode::CpuGdigrab,
    ];
    let mut attempts: Vec<(VideoMode, Option<String>)> = Vec::new();
    for m in modes {
        if audio_device.is_some() {
            attempts.push((m, audio_device.clone()));
        }
        // Fallback sin audio por si el dispositivo elegido falla al abrir.
        attempts.push((m, None));
    }

    let mut child: Option<Child> = None;
    'outer: for (mode, audio) in &attempts {
        let label = match mode {
            VideoMode::GpuNvenc => "GPU/NVENC (DirectX)",
            VideoMode::GpuX264 => "GPU captura + CPU x264",
            VideoMode::CpuGdigrab => "CPU GDI (compatibilidad)",
        };
        // NVENC puede fallar de forma transitoria al abrir el encoder (CreateInputBuffer) si la GPU
        // está bajo carga del juego; le damos un reintento antes de degradar a CPU.
        let tries = if matches!(mode, VideoMode::GpuNvenc) { 2 } else { 1 };
        for attempt_n in 1..=tries {
            println!(
                "Grabadora: intentando modo '{}' {} a {} FPS (Quality: {}) [intento {}/{}]...",
                label,
                if audio.is_some() {
                    "con audio"
                } else {
                    "sin audio"
                },
                settings.fps,
                settings.quality,
                attempt_n,
                tries
            );
            let args = build_ffmpeg_args(video_path_str, *mode, audio.as_deref(), settings);
            child = spawn_ffmpeg_and_verify(&ffmpeg_exe, &args);
            if child.is_some() {
                println!("Grabadora: arrancó correctamente en modo '{}'.", label);
                break 'outer;
            }
            if attempt_n < tries {
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
        }
    }

    match child {
        Some(child_proc) => {
            *child_guard = Some(child_proc);
            Ok(video_path_str.to_string())
        }
        None => Err("No se pudo iniciar FFmpeg en ningún modo de compatibilidad. Verifica tu instalación de FFmpeg.".to_string())
    }
}

/// Detiene la grabación actual de forma limpia enviando la letra 'q' por stdin
pub fn stop_recording(state: &RecorderState) -> Result<(), String> {
    let mut child_guard = state.child_process.lock().unwrap();
    if let Some(mut child) = child_guard.take() {
        if let Some(mut stdin) = child.stdin.take() {
            // Escribir 'q' para que FFmpeg cierre el contenedor MP4 limpiamente (moov atom).
            let _ = stdin.write_all(b"q\n");
            let _ = stdin.flush();
        }
        // Esperar a que el proceso FFmpeg finalice limpiamente
        let _ = child.wait();
        Ok(())
    } else {
        Err("No hay ninguna grabación activa para detener".to_string())
    }
}

pub fn is_recording(state: &RecorderState) -> bool {
    state.child_process.lock().unwrap().is_some()
}
