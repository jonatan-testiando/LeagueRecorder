use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// Estado compartido del listener global de entrada: conteo de acciones (APM) y
/// estela del ratón.
///
/// Ya no detecta el uso de la ultimate: eso dependía de reconocer una tecla concreta
/// del juego y se retiró por seguridad frente a Vanguard. La Live Client API no expone
/// cooldowns ni lanzamientos de habilidad, así que no hay sustituto por polling; las
/// partidas antiguas conservan sus eventos "Ultimate" y el reproductor los sigue
/// pintando, pero no se generan nuevos.
pub struct UltState {
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
}

impl Default for UltState {
    fn default() -> Self {
        Self {
            actions: AtomicU64::new(0),
            counting: AtomicBool::new(false),
            mouse_events: Mutex::new(Vec::new()),
            last_mouse_move: Mutex::new(None),
            current_mouse_pos: Mutex::new((0.0, 0.0)),
        }
    }
}

/// Lanza un listener global de teclado y ratón en un hilo dedicado: cuenta acciones
/// para el APM, guarda la estela del ratón y pasa las teclas de cámara aliada al
/// entrenamiento. Solo lee eventos; nunca inyecta input en el juego.
pub fn spawn_keyboard_listener(state: Arc<UltState>, training: Arc<crate::training::TrainingState>) {
    std::thread::spawn(move || {
        use rdev::{listen, Button, EventType};
        let pressed_keys = Arc::new(std::sync::Mutex::new(std::collections::HashSet::new()));

        let result = listen(move |event| {
            let is_counting = state.counting.load(Ordering::Relaxed);
            match event.event_type {
                EventType::KeyPress(key) => {
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
                }
                EventType::KeyRelease(key) => {
                    pressed_keys.lock().unwrap().remove(&key);
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

/// Resolución del escritorio donde `rdev` entrega las coordenadas del ratón.
/// El reproductor la necesita para escalar la estela: son coordenadas de PANTALLA,
/// no del vídeo, y grabar a una resolución distinta descuadraba el trazo.
/// Devuelve (0, 0) si no se puede consultar.
pub fn mouse_coordinate_space() -> (u32, u32) {
    match rdev::display_size() {
        Ok((w, h)) => (w as u32, h as u32),
        Err(e) => {
            eprintln!("No se pudo obtener el tamaño de pantalla para la estela: {:?}", e);
            (0, 0)
        }
    }
}
