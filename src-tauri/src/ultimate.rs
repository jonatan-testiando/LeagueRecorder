use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;

/// Estado compartido para la detección (best-effort) del uso de la ultimate por tecla
/// y el conteo de acciones (APM).
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
}

impl Default for UltState {
    fn default() -> Self {
        Self {
            presses: Mutex::new(Vec::new()),
            key: Mutex::new("R".to_string()),
            enabled: Mutex::new(true),
            actions: AtomicU64::new(0),
            counting: AtomicBool::new(false),
        }
    }
}

/// Lanza un listener global de teclado en un hilo dedicado. Cuando se pulsa la tecla
/// configurada y la detección está activa, registra el instante de la pulsación.
/// El monitor decidirá luego si cuenta (solo en partida grabando y con la R disponible).
pub fn spawn_keyboard_listener(state: Arc<UltState>) {
    std::thread::spawn(move || {
        use rdev::{listen, EventType};
        let result = listen(move |event| {
            match event.event_type {
                EventType::KeyPress(key) => {
                    // Contar acción para el APM (solo mientras se graba).
                    if state.counting.load(Ordering::Relaxed) {
                        state.actions.fetch_add(1, Ordering::Relaxed);
                    }
                    // Detección de ultimate.
                    if *state.enabled.lock().unwrap() {
                        let configured = state.key.lock().unwrap().clone();
                        if key_matches(key, &configured) {
                            state.presses.lock().unwrap().push(Instant::now());
                        }
                    }
                }
                EventType::ButtonPress(_) => {
                    // Los clics también cuentan como acciones para el APM.
                    if state.counting.load(Ordering::Relaxed) {
                        state.actions.fetch_add(1, Ordering::Relaxed);
                    }
                }
                _ => {}
            }
        });
        if let Err(e) = result {
            eprintln!("Ultimate: no se pudo iniciar el listener de teclado: {:?}", e);
        }
    });
}

/// Compara la tecla pulsada con la configurada (letras y dígitos comunes).
fn key_matches(key: rdev::Key, configured: &str) -> bool {
    use rdev::Key::*;
    let target = match configured.trim().to_uppercase().as_str() {
        "A" => KeyA, "B" => KeyB, "C" => KeyC, "D" => KeyD, "E" => KeyE, "F" => KeyF,
        "G" => KeyG, "H" => KeyH, "I" => KeyI, "J" => KeyJ, "K" => KeyK, "L" => KeyL,
        "M" => KeyM, "N" => KeyN, "O" => KeyO, "P" => KeyP, "Q" => KeyQ, "R" => KeyR,
        "S" => KeyS, "T" => KeyT, "U" => KeyU, "V" => KeyV, "W" => KeyW, "X" => KeyX,
        "Y" => KeyY, "Z" => KeyZ,
        "1" => Num1, "2" => Num2, "3" => Num3, "4" => Num4, "5" => Num5,
        "6" => Num6, "7" => Num7, "8" => Num8, "9" => Num9, "0" => Num0,
        _ => return false,
    };
    key == target
}
