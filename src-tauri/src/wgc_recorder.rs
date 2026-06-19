use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use log::{error, info};

use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::encoder::{
    AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder,
    VideoSettingsSubType,
};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;

pub struct RecorderHandler {
    encoder: Option<VideoEncoder>,
    is_active: Arc<Mutex<bool>>,
    // Se pone en true DESPUÉS de que encoder.finish() cierra el mp4 (escribe el moov atom).
    // stop_recording espera esta señal antes de muxear el audio, para no tocar un archivo a medio cerrar.
    finished: Arc<AtomicBool>,
}

impl GraphicsCaptureApiHandler for RecorderHandler {
    type Flags = (String, Arc<Mutex<bool>>, Arc<AtomicBool>, i32, i32, u32, String); // path, is_active, finished, w, h, fps, quality
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let (path, is_active, finished, width, height, fps, quality) = ctx.flags;

        // Bitrate por nivel de calidad. Como WGC graba SIEMPRE a resolución nativa (no escala),
        // estos pisos están calibrados para verse bien a 1440p, no para resoluciones menores.
        let bitrate = match quality.as_str() {
            "High" => 22_000_000,   // 22 Mbps
            "Medium" => 14_000_000, // 14 Mbps
            "Low" => 8_000_000,     // 8 Mbps
            _ => 14_000_000,
        };

        let video_settings = VideoSettingsBuilder::new(width as u32, height as u32)
            .sub_type(VideoSettingsSubType::H264)
            .frame_rate(fps)
            .bitrate(bitrate);

        // Audio DESHABILITADO en el encoder de WGC: el crate NO captura audio del sistema. El audio
        // del juego se graba aparte (ffmpeg dshow virtual-audio-capturer) y se muxea al finalizar.
        // Si se dejara habilitado sin alimentar buffers, el muxer de MF se bloquea y el video se
        // congela tras ~1s.
        let audio_settings = AudioSettingsBuilder::default().disabled(true);
        let container_settings = ContainerSettingsBuilder::default();

        let encoder = VideoEncoder::new(video_settings, audio_settings, container_settings, path)?;

        Ok(Self {
            encoder: Some(encoder),
            is_active,
            finished,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if !*self.is_active.lock().unwrap() {
            if let Some(encoder) = self.encoder.take() {
                encoder.finish()?;
            }
            self.finished.store(true, Ordering::SeqCst);
            capture_control.stop();
            return Ok(());
        }

        if let Some(encoder) = self.encoder.as_mut() {
            encoder.send_frame(frame)?;
        }

        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        // La ventana del juego se cerró (fin de partida): cerramos el encoder y avisamos.
        if let Some(encoder) = self.encoder.take() {
            encoder.finish()?;
        }
        *self.is_active.lock().unwrap() = false;
        self.finished.store(true, Ordering::SeqCst);
        Ok(())
    }
}

/// Inicia la captura WGC en un hilo propio. Devuelve:
/// - `is_active`: ponlo en false para pedir la parada.
/// - `finished`: pasa a true cuando el mp4 quedó finalizado (para esperar antes de muxear).
pub fn start_wgc_recording(
    window_title_contains: &str,
    output_path: String,
    fps: u32,
    quality: &str,
) -> (Arc<Mutex<bool>>, Arc<AtomicBool>) {
    let is_active = Arc::new(Mutex::new(true));
    let finished = Arc::new(AtomicBool::new(false));
    let is_active_clone = is_active.clone();
    let finished_clone = finished.clone();
    let title_search = window_title_contains.to_string();
    let quality_str = quality.to_string();

    std::thread::spawn(move || {
        let mut target_window = None;
        if let Ok(windows) = Window::enumerate() {
            for window in windows {
                if let Ok(title) = window.title() {
                    if title.contains(&title_search) {
                        target_window = Some(window);
                        break;
                    }
                }
            }
        }

        let window = match target_window {
            Some(w) => w,
            None => {
                error!("No se encontró la ventana conteniendo: {}", title_search);
                *is_active_clone.lock().unwrap() = false;
                finished_clone.store(true, Ordering::SeqCst);
                return;
            }
        };

        info!("Iniciando captura de ventana: {}", window.title().unwrap_or_default());

        let size = match (window.width(), window.height()) {
            (Ok(w), Ok(h)) => (w, h),
            _ => {
                error!("Error al obtener tamaño de ventana");
                *is_active_clone.lock().unwrap() = false;
                finished_clone.store(true, Ordering::SeqCst);
                return;
            }
        };

        let settings = Settings::new(
            window,
            CursorCaptureSettings::Default,
            DrawBorderSettings::WithoutBorder,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Default,
            DirtyRegionSettings::Default,
            ColorFormat::Bgra8, // coincide con el formato de entrada del encoder (evita R/B invertido)
            (output_path, is_active_clone.clone(), finished_clone.clone(), size.0, size.1, fps, quality_str),
        );

        if let Err(e) = RecorderHandler::start(settings) {
            error!("Error durante la captura: {:?}", e);
            *is_active_clone.lock().unwrap() = false;
            finished_clone.store(true, Ordering::SeqCst);
        }
    });

    (is_active, finished)
}
