use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// Estado compartido del listener global de entrada: conteo de acciones (APM) y
/// estela del ratón.
///
pub struct UltState {
    /// Instantes de pulsación pendientes de procesar por el monitor.
    pub presses: Mutex<Vec<Instant>>,
    /// Tecla configurada para la ultimate (por defecto "R").
    pub key: Mutex<String>,
    /// Activa/desactiva la detección de ultimate.
    pub enabled: Mutex<bool>,
    /// Contador acumulado de acciones (teclas + clics) para calcular el APM.
    pub actions: AtomicU64,
    /// Solo se cuentan acciones mientras hay una grabación en curso.
    pub counting: AtomicBool,
    /// Eventos de ratón guardados temporalmente: (Instant, x, y, evento)
    pub mouse_events: Mutex<Vec<(Instant, f64, f64, String)>>,
    /// Tiempo del último movimiento registrado (para downsampling a 30fps)
    pub last_mouse_move: Mutex<Option<Instant>>,
    /// Posición actual del ratón para cuando ocurre un clic
    pub current_mouse_pos: Mutex<(f64, f64)>,
    /// Tecla que guarda los últimos segundos del replay buffer (por defecto F8).
    /// Se carga de `hotkeys.json` al arrancar y la refresca `set_hotkeys`.
    pub replay_key: Mutex<String>,
    /// Última vez que se disparó el replay, para el antirrebote de 2 s: la tecla
    /// se pulsa en mitad de una pelea y repetir el clip no aporta nada.
    pub last_replay: Mutex<Option<Instant>>,
}

/// Antirrebote del atajo de replay.
const REPLAY_DEBOUNCE_SECS: f64 = 2.0;

impl Default for UltState {
    fn default() -> Self {
        Self {
            presses: Mutex::new(Vec::new()),
            key: Mutex::new("R".to_string()),
            enabled: Mutex::new(true),
            actions: AtomicU64::new(0),
            counting: AtomicBool::new(false),
            mouse_events: Mutex::new(Vec::new()),
            last_mouse_move: Mutex::new(None),
            current_mouse_pos: Mutex::new((0.0, 0.0)),
            replay_key: Mutex::new(crate::storage::load_hotkeys().replay),
            last_replay: Mutex::new(None),
        }
    }
}

/// Lanza un listener global de teclado y ratón en un hilo dedicado: cuenta acciones
/// para el APM, guarda la estela del ratón, pasa las teclas de cámara aliada al
/// entrenamiento y atiende el atajo de replay. Solo lee eventos; nunca inyecta
/// input en el juego.
pub fn spawn_keyboard_listener(
    state: Arc<UltState>,
    training: Arc<crate::training::TrainingState>,
    recorder: Arc<crate::recorder::RecorderState>,
    app: tauri::AppHandle,
) {
    let ctrl_pressed = Arc::new(AtomicBool::new(false));

    std::thread::spawn(move || {
        use rdev::{listen, Button, EventType, Key};
        let pressed_keys = Arc::new(std::sync::Mutex::new(std::collections::HashSet::new()));

        let result = listen(move |event| {
            let is_counting = state.counting.load(Ordering::Relaxed);
            match event.event_type {
                EventType::KeyPress(key) => {
                    if key == Key::ControlLeft || key == Key::ControlRight {
                        ctrl_pressed.store(true, Ordering::Relaxed);
                    }

                    let is_new_press = pressed_keys.lock().unwrap().insert(key);

                    // Contar acción para el APM (solo mientras se graba y solo si es pulsación nueva).
                    if is_counting && is_new_press {
                        state.actions.fetch_add(1, Ordering::Relaxed);
                    }
                    // Teclas de cámara aliada: registrar la pulsación para el entrenamiento.
                    // `note_key` ya filtra por si el entrenamiento no está activo.
                    if is_new_press {
                        training.note_key(key);
                    }

                    // Atajo de replay: guarda los últimos 30 s que el buffer tiene
                    // en memoria. Solo mientras hay grabación (sin buffer no hay
                    // nada que clipar) y con antirrebote, porque la tecla se
                    // machaca justo cuando pasa algo.
                    if is_new_press && crate::recorder::is_recording(&recorder) {
                        let configured = state.replay_key.lock().unwrap().clone();
                        if key_matches(key, &configured) && !debounced(&state) {
                            // El guardado tarda hasta ~5 s (el servidor espera a
                            // que el clip esté cerrado en disco): en el callback
                            // de rdev bloquearía TODO el teclado del sistema.
                            let rec = Arc::clone(&recorder);
                            let app = app.clone();
                            std::thread::spawn(move || match crate::recorder::save_replay(&rec) {
                                Ok(path) => {
                                    println!("Replay guardado: {}", path);
                                    crate::commands::emit_recorder_alert(
                                        &app,
                                        "replay_saved",
                                        "Replay clip saved",
                                        Some(path),
                                    );
                                }
                                Err(e) => {
                                    eprintln!("Replay: no se pudo guardar el clip: {e}");
                                    crate::commands::emit_recorder_alert(
                                        &app,
                                        "replay_failed",
                                        "Could not save the replay clip",
                                        Some(e),
                                    );
                                }
                            });
                        }
                    }

                    // Detección de ultimate en vivo (Keylogger local)
                    if *state.enabled.lock().unwrap() {
                        let configured = state.key.lock().unwrap().clone();
                        // Ignorar si CTRL está pulsado (ej. subiendo de nivel la habilidad con CTRL+R)
                        if key_matches(key, &configured) && !ctrl_pressed.load(Ordering::Relaxed) {
                            state.presses.lock().unwrap().push(Instant::now());
                        }
                    }
                }
                EventType::KeyRelease(key) => {
                    pressed_keys.lock().unwrap().remove(&key);
                    if key == Key::ControlLeft || key == Key::ControlRight {
                        ctrl_pressed.store(false, Ordering::Relaxed);
                    }
                }
                EventType::ButtonPress(btn) => {
                    // Los clics también cuentan como acciones para el APM.
                    if is_counting {
                        state.actions.fetch_add(1, Ordering::Relaxed);
                        let evt_str = match btn {
                            Button::Left => "left_click",
                            Button::Right => "right_click",
                            _ => return,
                        };
                        let (x, y) = *state.current_mouse_pos.lock().unwrap();
                        state.mouse_events.lock().unwrap().push((
                            Instant::now(),
                            x,
                            y,
                            evt_str.to_string(),
                        ));
                    }
                }
                EventType::MouseMove { x, y } => {
                    if is_counting {
                        *state.current_mouse_pos.lock().unwrap() = (x, y);
                        let now = Instant::now();
                        let mut last = state.last_mouse_move.lock().unwrap();
                        let should_record = match *last {
                            Some(t) => now.duration_since(t).as_millis() >= 33, // ~30 fps
                            None => true,
                        };
                        if should_record {
                            *last = Some(now);
                            state.mouse_events.lock().unwrap().push((
                                now,
                                x,
                                y,
                                "move".to_string(),
                            ));
                        }
                    }
                }
                _ => {}
            }
        });
        if let Err(e) = result {
            eprintln!(
                "Ultimate: no se pudo iniciar el listener de teclado: {:?}",
                e
            );
        }
    });
}

/// ¿Está el atajo de replay dentro de su ventana de antirrebote? Si no lo está,
/// deja anotado este disparo.
fn debounced(state: &UltState) -> bool {
    let mut last = state.last_replay.lock().unwrap();
    let now = Instant::now();
    if let Some(t) = *last {
        if now.duration_since(t).as_secs_f64() < REPLAY_DEBOUNCE_SECS {
            return true;
        }
    }
    *last = Some(now);
    false
}

/// Resolución del escritorio donde `rdev` entrega las coordenadas del ratón.
/// El reproductor la necesita para escalar la estela: son coordenadas de PANTALLA,
/// no del vídeo, y grabar a una resolución distinta descuadraba el trazo.
///
/// Es el monitor donde está la ventana de League, no el primario: con el juego en
/// un secundario, escalar contra el primario descolocaba la estela entera (y con
/// ella la detección de clics de minimapa, que se apoya en estas coordenadas).
/// Devuelve (0, 0) si no se puede consultar.
pub fn mouse_coordinate_space() -> (u32, u32) {
    if let Some(m) = crate::winsys::monitor_of_window(crate::recorder::GAME_WINDOW) {
        if m.width > 0 && m.height > 0 {
            return (m.width, m.height);
        }
    }
    match rdev::display_size() {
        Ok((w, h)) => (w as u32, h as u32),
        Err(e) => {
            eprintln!("No se pudo obtener el tamaño de pantalla para la estela: {:?}", e);
            (0, 0)
        }
    }
}

/// Compara la tecla pulsada con la configurada. Delega en el parser de `training`,
/// que además de letras y dígitos entiende F1–F12.
fn key_matches(key: rdev::Key, configured: &str) -> bool {
    crate::training::parse_key(configured) == Some(key)
}
