//! Entrenamiento de teclas de cámara aliada (las "F-Keys").
//!
//! Reúne las cuatro piezas del ejercicio:
//!   1. Configuración de qué tecla mira a qué rol (por defecto 1/2/3/4).
//!   2. Historial de sesiones de los drills offline (mapeo y lectura rápida).
//!   3. Muestreo del estado de la partida para el quiz de awareness posterior.
//!   4. Estado en vivo compartido con el listener global de teclado (overlay).
//!
//! Todo vive en `%APPDATA%/LeagueRecorder/training/`, aparte de los vídeos, porque
//! son datos de progreso del usuario y no de una partida concreta.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

/// Una tecla de cámara y el rol al que apunta.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CameraBinding {
    /// Tecla física tal y como la escribe el usuario: "1", "F2", "4"…
    pub key: String,
    /// Rol al que salta la cámara: TOP / JUNGLE / MID / ADC / SUPPORT.
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrainingConfig {
    /// Teclas de cámara aliada, en el orden en que aparecen en el TAB.
    pub bindings: Vec<CameraBinding>,
    /// Tecla que devuelve la cámara a tu campeón (por defecto la barra espaciadora).
    pub self_key: String,
    /// Overlay metrónomo activo durante la partida.
    pub metronome_enabled: bool,
    /// Cada cuántos segundos pide el metrónomo revisar a un aliado.
    pub metronome_interval_secs: u64,
    /// Cuánto tiempo tienes para responder al metrónomo antes de contarlo como fallo.
    pub metronome_window_secs: u64,
    /// Duración del destello en el drill de lectura rápida (occlusion).
    pub flash_ms: u64,
    /// Cada cuántos segundos se muestrea el estado de la partida para el quiz.
    pub snapshot_interval_secs: u64,
    /// Genera el quiz de awareness al terminar la partida.
    pub awareness_quiz_enabled: bool,
}

impl Default for TrainingConfig {
    fn default() -> Self {
        Self {
            // El reparto que describe el usuario: números superiores, sin la jungla.
            bindings: vec![
                CameraBinding { key: "1".into(), role: "TOP".into() },
                CameraBinding { key: "2".into(), role: "MID".into() },
                CameraBinding { key: "3".into(), role: "ADC".into() },
                CameraBinding { key: "4".into(), role: "SUPPORT".into() },
            ],
            self_key: "Space".into(),
            metronome_enabled: false,
            metronome_interval_secs: 20,
            metronome_window_secs: 5,
            flash_ms: 400,
            snapshot_interval_secs: 5,
            awareness_quiz_enabled: true,
        }
    }
}

// ---------------------------------------------------------------------------
// Rutas y persistencia
// ---------------------------------------------------------------------------

/// `%APPDATA%/LeagueRecorder/training/`, creado si no existe.
pub fn training_dir() -> PathBuf {
    let appdata = std::env::var("APPDATA").unwrap_or_else(|_| "C:".to_string());
    let dir = PathBuf::from(appdata).join("LeagueRecorder").join("training");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir
}

/// Subcarpeta con los snapshots de estado de partida (uno por partida).
pub fn awareness_dir() -> PathBuf {
    let dir = training_dir().join("awareness");
    if !dir.exists() {
        let _ = fs::create_dir_all(&dir);
    }
    dir
}

fn config_path() -> PathBuf {
    training_dir().join("config.json")
}

fn sessions_path() -> PathBuf {
    training_dir().join("sessions.json")
}

pub fn load_config() -> TrainingConfig {
    fs::read_to_string(config_path())
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default()
}

pub fn save_config(cfg: &TrainingConfig) -> Result<(), String> {
    let content =
        serde_json::to_string_pretty(cfg).map_err(|e| format!("Error serializando config: {}", e))?;
    fs::write(config_path(), content).map_err(|e| format!("Error guardando config: {}", e))
}

// ---------------------------------------------------------------------------
// Sesiones de drill
// ---------------------------------------------------------------------------

/// Desglose por rol dentro de una sesión: dónde estás flojo.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoleStat {
    pub role: String,
    pub attempts: u32,
    pub hits: u32,
    pub avg_latency_ms: f64,
}

/// Una tanda completa de un drill.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DrillSession {
    pub id: String,
    pub date: String,
    /// "reflex" (mapeo tecla→rol) | "recall" (lectura en 400 ms).
    pub kind: String,
    pub rounds: u32,
    pub hits: u32,
    pub avg_latency_ms: f64,
    pub best_latency_ms: f64,
    #[serde(default)]
    pub per_role: Vec<RoleStat>,
    /// Modo del drill, para poder comparar peras con peras ("role" | "champion" | "loaded").
    #[serde(default)]
    pub mode: String,
}

pub fn load_sessions() -> Vec<DrillSession> {
    fs::read_to_string(sessions_path())
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default()
}

/// Añade una sesión al historial. Recorta a las últimas 500 para que el JSON no crezca sin fin.
pub fn append_session(session: DrillSession) -> Result<(), String> {
    let mut all = load_sessions();
    all.push(session);
    if all.len() > 500 {
        let excess = all.len() - 500;
        all.drain(0..excess);
    }
    let content = serde_json::to_string_pretty(&all)
        .map_err(|e| format!("Error serializando sesiones: {}", e))?;
    fs::write(sessions_path(), content).map_err(|e| format!("Error guardando sesiones: {}", e))
}

// ---------------------------------------------------------------------------
// Estado en vivo (compartido con el listener global de teclado)
// ---------------------------------------------------------------------------

/// Estado runtime del entrenamiento durante una partida.
///
/// El listener de `rdev` corre en su propio hilo y solo *escribe* pulsaciones aquí;
/// el monitor de fondo las consume. Nunca se inyecta input al juego.
pub struct TrainingState {
    /// Teclas de cámara vigiladas, en minúsculas y ya resueltas a su rol.
    pub watched: Mutex<Vec<CameraBinding>>,
    /// Pulsaciones detectadas pendientes de procesar: (instante, rol).
    pub presses: Mutex<Vec<(Instant, String)>>,
    /// Solo se registra mientras hay una partida en curso.
    pub active: AtomicBool,
    /// Contador acumulado de pulsaciones de cámara en la partida actual.
    pub total_presses: AtomicU64,
}

impl Default for TrainingState {
    fn default() -> Self {
        let cfg = load_config();
        Self {
            watched: Mutex::new(cfg.bindings),
            presses: Mutex::new(Vec::new()),
            active: AtomicBool::new(false),
            total_presses: AtomicU64::new(0),
        }
    }
}

impl TrainingState {
    /// Refresca las teclas vigiladas tras un cambio de configuración.
    pub fn set_bindings(&self, bindings: Vec<CameraBinding>) {
        if let Ok(mut w) = self.watched.lock() {
            *w = bindings;
        }
    }

    /// Llamado desde el hilo de `rdev` en cada pulsación. Devuelve el rol si la
    /// tecla es una de las de cámara configuradas.
    pub fn note_key(&self, key: rdev::Key) -> Option<String> {
        if !self.active.load(Ordering::Relaxed) {
            return None;
        }
        let role = {
            let watched = self.watched.lock().ok()?;
            watched
                .iter()
                .find(|b| parse_key(&b.key) == Some(key))
                .map(|b| b.role.clone())?
        };
        self.total_presses.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut p) = self.presses.lock() {
            p.push((Instant::now(), role.clone()));
            // Cinturón de seguridad: si nadie consume (partida sin monitor), no crecer sin fin.
            if p.len() > 4096 {
                p.drain(0..2048);
            }
        }
        Some(role)
    }

    /// Vacía y devuelve las pulsaciones acumuladas.
    pub fn drain_presses(&self) -> Vec<(Instant, String)> {
        self.presses
            .lock()
            .map(|mut p| p.drain(..).collect())
            .unwrap_or_default()
    }

    /// Reinicia el estado al empezar una partida.
    pub fn reset(&self) {
        self.total_presses.store(0, Ordering::Relaxed);
        if let Ok(mut p) = self.presses.lock() {
            p.clear();
        }
    }
}

// ---------------------------------------------------------------------------
// Metrónomo
// ---------------------------------------------------------------------------

/// Lo que el metrónomo quiere que ocurra en pantalla este tick.
#[derive(Debug, Clone, PartialEq)]
pub enum MetronomeEvent {
    /// Pide revisar a un aliado.
    Prompt { role: String, key: String, window_secs: u64 },
    /// Resuelve el aviso anterior.
    Ack { ok: bool, role: String, latency_ms: f64 },
}

/// Máquina de estados del metrónomo: pide revisar un aliado cada N segundos,
/// rotando roles, y comprueba si respondiste dentro de la ventana.
///
/// Rota en orden fijo en vez de al azar a propósito: el objetivo es que acabes
/// cubriendo a todo el equipo, no que te sorprenda.
#[derive(Default)]
pub struct MetronomeRunner {
    enabled: bool,
    bindings: Vec<CameraBinding>,
    idx: usize,
    interval: f64,
    window: f64,
    next_at: f64,
    /// (rol pedido, tiempo de juego del aviso)
    pending: Option<(String, f64)>,
    pub results: Vec<crate::awareness::MetronomeResult>,
}

impl MetronomeRunner {
    /// Arranca (o reinicia) para una partida nueva. `first_at` es el segundo de
    /// juego del primer aviso: conviene dejar pasar la fase inicial.
    pub fn start(&mut self, cfg: &TrainingConfig, first_at: f64) {
        self.enabled = cfg.metronome_enabled && !cfg.bindings.is_empty();
        self.bindings = cfg.bindings.clone();
        self.idx = 0;
        self.interval = cfg.metronome_interval_secs.max(5) as f64;
        self.window = cfg.metronome_window_secs.max(1) as f64;
        self.next_at = first_at;
        self.pending = None;
        self.results.clear();
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn stop(&mut self) {
        self.enabled = false;
        self.pending = None;
    }

    /// Carril del mapa que corresponde a cada puesto.
    ///
    /// El jungla no tiene: un clic de minimapa dice a qué zona miraste, y la
    /// jungla no es una zona que se pueda separar así. Para ese puesto sigue
    /// haciendo falta la tecla de cámara.
    fn carril_de(role: &str) -> Option<&'static str> {
        match role {
            "TOP" => Some("top"),
            "MID" | "MIDDLE" => Some("mid"),
            "ADC" | "BOTTOM" | "SUPPORT" | "UTILITY" => Some("bot"),
            _ => None,
        }
    }

    /// Avanza un tick. `now` es el tiempo de juego, `presses` el histórico de
    /// pulsaciones de cámara y `looks` los clics de minimapa con su carril, los
    /// dos en tiempo de juego.
    ///
    /// Aceptar el clic no es una comodidad: medido sobre las partidas del
    /// usuario, las teclas de cámara aliada salen a 0 ó 1 por partida y los
    /// clics de minimapa a más de 300. Un drill que sólo mira las teclas está
    /// puntuando a cero a alguien que comprueba el mapa quince veces por minuto.
    pub fn tick(
        &mut self,
        now: f64,
        presses: &[crate::awareness::CameraPress],
        looks: &[(f64, &'static str)],
    ) -> Option<MetronomeEvent> {
        if !self.enabled || self.bindings.is_empty() {
            return None;
        }

        if let Some((role, at)) = self.pending.clone() {
            // Sólo cuenta una respuesta del puesto pedido y posterior al aviso:
            // la tecla de ese aliado, o un clic de minimapa en su carril.
            let carril = Self::carril_de(&role);
            let respuesta = presses
                .iter()
                .find(|p| p.t >= at && p.role == role)
                .map(|p| p.t)
                .into_iter()
                .chain(
                    looks
                        .iter()
                        .filter(|(t, c)| *t >= at && carril == Some(*c))
                        .map(|(t, _)| *t),
                )
                .min_by(f64::total_cmp);
            if let Some(t_resp) = respuesta {
                let latency_ms = ((t_resp - at) * 1000.0).max(0.0);
                self.results.push(crate::awareness::MetronomeResult {
                    t: at,
                    role: role.clone(),
                    responded: true,
                    latency_ms,
                });
                self.pending = None;
                self.next_at = now + self.interval;
                return Some(MetronomeEvent::Ack { ok: true, role, latency_ms });
            }
            if now - at > self.window {
                self.results.push(crate::awareness::MetronomeResult {
                    t: at,
                    role: role.clone(),
                    responded: false,
                    latency_ms: 0.0,
                });
                self.pending = None;
                self.next_at = now + self.interval;
                return Some(MetronomeEvent::Ack { ok: false, role, latency_ms: 0.0 });
            }
            return None;
        }

        if now >= self.next_at {
            let b = &self.bindings[self.idx % self.bindings.len()];
            self.idx += 1;
            self.pending = Some((b.role.clone(), now));
            return Some(MetronomeEvent::Prompt {
                role: b.role.clone(),
                key: b.key.to_uppercase(),
                window_secs: self.window as u64,
            });
        }
        None
    }
}

// ---------------------------------------------------------------------------
// Parseo de teclas
// ---------------------------------------------------------------------------

/// Traduce el nombre de una tecla escrito por el usuario a la `rdev::Key`
/// correspondiente. Acepta letras, dígitos de la fila superior, F1–F12, el
/// teclado numérico y algunas teclas sueltas útiles (espacio, tab).
///
/// **El teclado numérico es una tecla distinta**, no un alias del dígito: en
/// Windows `Num1` y `Kp1` son códigos de barrido distintos y el listener recibe
/// el que se pulsó. Quien configuraba "1" pensando en el 1 del numpad —que es
/// donde cae la mano izquierda de mucha gente al jugar— tenía un atajo que no
/// disparaba nunca y ninguna pista de por qué.
///
/// Los nombres canónicos son `NUM0`..`NUM9` (y `NUMPLUS`, `NUMMINUS`,
/// `NUMMULT`, `NUMDIV`), que es lo que devuelve [`key_name`]: así una tecla
/// leída del teclado y guardada en la config vuelve a leerse igual. Se aceptan
/// además las formas `KP0`/`NUMPAD0` porque son las que la gente escribe.
pub fn parse_key(s: &str) -> Option<rdev::Key> {
    use rdev::Key::*;
    let t = s.trim().to_uppercase();
    // "NUMPAD3" / "KP3" / "NUM3" → "3", y de ahí a la tecla del numpad.
    for prefijo in ["NUMPAD", "NUM", "KP"] {
        if let Some(d) = t.strip_prefix(prefijo) {
            let tecla = match d {
                "0" => Kp0, "1" => Kp1, "2" => Kp2, "3" => Kp3, "4" => Kp4,
                "5" => Kp5, "6" => Kp6, "7" => Kp7, "8" => Kp8, "9" => Kp9,
                "PLUS" | "+" | "ADD" => KpPlus,
                "MINUS" | "-" | "SUB" => KpMinus,
                "MULT" | "*" | "MULTIPLY" => KpMultiply,
                "DIV" | "/" | "DIVIDE" => KpDivide,
                _ => continue,
            };
            return Some(tecla);
        }
    }
    Some(match t.as_str() {
        "A" => KeyA, "B" => KeyB, "C" => KeyC, "D" => KeyD, "E" => KeyE,
        "F" => KeyF, "G" => KeyG, "H" => KeyH, "I" => KeyI, "J" => KeyJ,
        "K" => KeyK, "L" => KeyL, "M" => KeyM, "N" => KeyN, "O" => KeyO,
        "P" => KeyP, "Q" => KeyQ, "R" => KeyR, "S" => KeyS, "T" => KeyT,
        "U" => KeyU, "V" => KeyV, "W" => KeyW, "X" => KeyX, "Y" => KeyY,
        "Z" => KeyZ,
        "0" => Num0, "1" => Num1, "2" => Num2, "3" => Num3, "4" => Num4,
        "5" => Num5, "6" => Num6, "7" => Num7, "8" => Num8, "9" => Num9,
        "F1" => F1, "F2" => F2, "F3" => F3, "F4" => F4, "F5" => F5, "F6" => F6,
        "F7" => F7, "F8" => F8, "F9" => F9, "F10" => F10, "F11" => F11, "F12" => F12,
        "SPACE" | "SPACEBAR" | "ESPACIO" => Space,
        "TAB" => Tab,
        _ => return None,
    })
}

/// El nombre canónico de una tecla: la inversa de [`parse_key`].
///
/// Existe para que el ciclo "pulsa una tecla → se guarda en la config → se
/// vuelve a leer al arrancar" cierre. Sin esto, capturar una tecla del numpad
/// obligaba a inventarse su nombre en el frontend, y bastaba escribirlo de otra
/// manera para que `parse_key` devolviera `None` y el atajo dejara de existir
/// en silencio.
///
/// `None` para una tecla que no se sabe nombrar: es lo mismo que decir que no
/// se puede guardar, que es la verdad.
pub fn key_name(k: rdev::Key) -> Option<String> {
    use rdev::Key::*;
    let s = match k {
        KeyA => "A", KeyB => "B", KeyC => "C", KeyD => "D", KeyE => "E",
        KeyF => "F", KeyG => "G", KeyH => "H", KeyI => "I", KeyJ => "J",
        KeyK => "K", KeyL => "L", KeyM => "M", KeyN => "N", KeyO => "O",
        KeyP => "P", KeyQ => "Q", KeyR => "R", KeyS => "S", KeyT => "T",
        KeyU => "U", KeyV => "V", KeyW => "W", KeyX => "X", KeyY => "Y",
        KeyZ => "Z",
        Num0 => "0", Num1 => "1", Num2 => "2", Num3 => "3", Num4 => "4",
        Num5 => "5", Num6 => "6", Num7 => "7", Num8 => "8", Num9 => "9",
        F1 => "F1", F2 => "F2", F3 => "F3", F4 => "F4", F5 => "F5", F6 => "F6",
        F7 => "F7", F8 => "F8", F9 => "F9", F10 => "F10", F11 => "F11", F12 => "F12",
        Kp0 => "NUM0", Kp1 => "NUM1", Kp2 => "NUM2", Kp3 => "NUM3", Kp4 => "NUM4",
        Kp5 => "NUM5", Kp6 => "NUM6", Kp7 => "NUM7", Kp8 => "NUM8", Kp9 => "NUM9",
        KpPlus => "NUMPLUS",
        KpMinus => "NUMMINUS",
        KpMultiply => "NUMMULT",
        KpDivide => "NUMDIV",
        Space => "SPACE",
        Tab => "TAB",
        _ => return None,
    };
    Some(s.to_string())
}

// ---------------------------------------------------------------------------
// Comandos Tauri
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_training_config() -> TrainingConfig {
    load_config()
}

/// Guarda la configuración y propaga los bindings al listener de teclado en caliente.
#[tauri::command]
pub async fn set_training_config(
    state: tauri::State<'_, std::sync::Arc<TrainingState>>,
    config: TrainingConfig,
) -> Result<TrainingConfig, String> {
    // Rechazamos teclas que el listener no sabría reconocer: si no, el usuario
    // configuraría algo que nunca dispara y parecería que el overlay está roto.
    let mut config = config;
    for b in config.bindings.iter_mut() {
        let Some(tecla) = parse_key(&b.key) else {
            return Err(format!("Unrecognized key: \"{}\"", b.key));
        };
        if b.role.trim().is_empty() {
            return Err("One of the roles is empty.".to_string());
        }
        // Al fichero va el nombre canónico: así "kp3", "numpad3" y "NUM3"
        // quedan guardados igual y el ciclo escribir→leer cierra siempre.
        if let Some(nombre) = key_name(tecla) {
            b.key = nombre;
        }
    }
    save_config(&config)?;
    state.set_bindings(config.bindings.clone());
    Ok(config)
}

#[tauri::command]
pub async fn get_drill_sessions(limit: Option<usize>) -> Vec<DrillSession> {
    let mut all = load_sessions();
    all.reverse(); // más recientes primero
    if let Some(n) = limit {
        all.truncate(n);
    }
    all
}

#[tauri::command]
pub async fn save_drill_session(session: DrillSession) -> Result<(), String> {
    append_session(session)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metronomo(role: &str) -> MetronomeRunner {
        let cfg = TrainingConfig {
            metronome_enabled: true,
            metronome_interval_secs: 20,
            metronome_window_secs: 3,
            bindings: vec![CameraBinding { key: "F1".into(), role: role.into() }],
            ..Default::default()
        };
        let mut m = MetronomeRunner::default();
        m.start(&cfg, 100.0);
        m
    }

    /// Lo que motivó el cambio: el usuario mira el mapa con el ratón, no con
    /// F1-F5, y el drill le puntuaba a cero. Un clic en el carril del puesto que
    /// se pidió cuenta como respuesta.
    #[test]
    fn un_clic_en_el_carril_pedido_responde_al_metronomo() {
        let mut m = metronomo("TOP");
        assert!(matches!(m.tick(100.0, &[], &[]), Some(MetronomeEvent::Prompt { .. })));
        let ack = m.tick(101.0, &[], &[(100.5, "top")]);
        match ack {
            Some(MetronomeEvent::Ack { ok, latency_ms, .. }) => {
                assert!(ok, "el clic en top tenía que valer");
                assert!((latency_ms - 500.0).abs() < 1.0, "latencia: {latency_ms}");
            }
            otro => panic!("esperaba un Ack, llegó {otro:?}"),
        }
    }

    /// Mirar OTRO carril no es haber mirado el que se pidió.
    #[test]
    fn un_clic_en_otro_carril_no_vale() {
        let mut m = metronomo("TOP");
        m.tick(100.0, &[], &[]);
        assert!(m.tick(101.0, &[], &[(100.5, "bot")]).is_none());
        // Y al pasar la ventana, se cuenta como fallo.
        match m.tick(104.0, &[], &[(100.5, "bot")]) {
            Some(MetronomeEvent::Ack { ok, .. }) => assert!(!ok),
            otro => panic!("esperaba un Ack fallido, llegó {otro:?}"),
        }
    }

    /// Un clic ANTERIOR al aviso tampoco: responder es mirar después de que te
    /// lo pidan, no haber mirado por casualidad hace un rato.
    #[test]
    fn un_clic_anterior_al_aviso_no_cuenta() {
        let mut m = metronomo("TOP");
        m.tick(100.0, &[], &[]);
        assert!(m.tick(101.0, &[], &[(99.0, "top")]).is_none());
    }

    /// Al jungla no se le puede responder con el minimapa: su cámara no es una
    /// zona del mapa. Ahí sigue haciendo falta la tecla.
    #[test]
    fn el_jungla_sigue_exigiendo_la_tecla() {
        let mut m = metronomo("JUNGLE");
        m.tick(100.0, &[], &[]);
        assert!(m.tick(101.0, &[], &[(100.5, "top")]).is_none());
        let presses = [crate::awareness::CameraPress { t: 100.7, role: "JUNGLE".into() }];
        match m.tick(101.0, &presses, &[]) {
            Some(MetronomeEvent::Ack { ok, .. }) => assert!(ok),
            otro => panic!("esperaba un Ack bueno, llegó {otro:?}"),
        }
    }

    #[test]
    fn parsea_digitos_y_fkeys() {
        assert_eq!(parse_key("1"), Some(rdev::Key::Num1));
        assert_eq!(parse_key("f3"), Some(rdev::Key::F3));
        assert_eq!(parse_key(" space "), Some(rdev::Key::Space));
        assert_eq!(parse_key("ñ"), None);
    }

    /// El numpad NO es el mismo código que la fila de números: quien ata un
    /// atajo al 1 del numpad tiene que recibir `Kp1`, no `Num1`.
    #[test]
    fn el_teclado_numerico_es_una_tecla_aparte() {
        use rdev::Key::*;
        assert_eq!(parse_key("NUM1"), Some(Kp1));
        assert_eq!(parse_key("kp0"), Some(Kp0));
        assert_eq!(parse_key(" numpad9 "), Some(Kp9));
        assert_ne!(parse_key("NUM1"), parse_key("1"));
        assert_eq!(parse_key("NUMPLUS"), Some(KpPlus));
        assert_eq!(parse_key("num-"), Some(KpMinus));
        assert_eq!(parse_key("NUMMULT"), Some(KpMultiply));
        assert_eq!(parse_key("kpdiv"), Some(KpDivide));
        // Un prefijo que no completa una tecla del numpad no se traga la
        // cadena: "NUMX" no existe, pero tampoco puede tapar a otra.
        assert_eq!(parse_key("NUMX"), None);
    }

    /// Ida y vuelta: lo que `key_name` escribe en la config, `parse_key` lo
    /// vuelve a leer como la MISMA tecla. Es lo que hace que un atajo capturado
    /// del teclado sobreviva a cerrar la app.
    #[test]
    fn el_nombre_de_una_tecla_vuelve_a_parsearse() {
        use rdev::Key::*;
        for k in [
            KeyQ, Num4, F5, Space, Tab, Kp0, Kp5, Kp9, KpPlus, KpMinus, KpMultiply, KpDivide,
        ] {
            let nombre = key_name(k).unwrap_or_else(|| panic!("sin nombre para {k:?}"));
            assert_eq!(parse_key(&nombre), Some(k), "no cerró el ciclo: {nombre}");
        }
        // Una tecla que no se sabe nombrar es una tecla que no se puede
        // guardar, y decirlo es mejor que inventarse un nombre que no vuelve.
        assert_eq!(key_name(Escape), None);
    }

    #[test]
    fn config_por_defecto_mapea_los_cuatro_roles() {
        let cfg = TrainingConfig::default();
        let roles: Vec<&str> = cfg.bindings.iter().map(|b| b.role.as_str()).collect();
        assert_eq!(roles, vec!["TOP", "MID", "ADC", "SUPPORT"]);
        // La jungla se queda fuera a propósito (el reparto es de números superiores).
        assert!(!roles.contains(&"JUNGLE"));
        let adc = cfg.bindings.iter().find(|b| b.role == "ADC").unwrap();
        assert_eq!(adc.key, "3");
    }

    fn cfg_metronomo() -> TrainingConfig {
        TrainingConfig {
            metronome_enabled: true,
            metronome_interval_secs: 20,
            metronome_window_secs: 5,
            ..Default::default()
        }
    }

    #[test]
    fn metronomo_pide_rota_y_acierta() {
        use crate::awareness::CameraPress;
        let mut m = MetronomeRunner::default();
        m.start(&cfg_metronomo(), 60.0);

        // Antes de la hora no pide nada.
        assert_eq!(m.tick(59.0, &[], &[]), None);

        // Primer aviso: el primer binding (TOP → tecla 1).
        assert_eq!(
            m.tick(60.0, &[], &[]),
            Some(MetronomeEvent::Prompt {
                role: "TOP".into(),
                key: "1".into(),
                window_secs: 5
            })
        );

        // Respondemos a los 400 ms.
        let presses = vec![CameraPress { t: 60.4, role: "TOP".into() }];
        match m.tick(61.0, &presses, &[]) {
            Some(MetronomeEvent::Ack { ok, role, latency_ms }) => {
                assert!(ok);
                assert_eq!(role, "TOP");
                assert!((latency_ms - 400.0).abs() < 1.0, "latencia {}", latency_ms);
            }
            other => panic!("esperaba ack correcto, llegó {:?}", other),
        }

        // El siguiente aviso llega un intervalo después y es el rol siguiente.
        assert_eq!(m.tick(70.0, &presses, &[]), None);
        match m.tick(81.0, &presses, &[]) {
            Some(MetronomeEvent::Prompt { role, .. }) => assert_eq!(role, "MID"),
            other => panic!("esperaba prompt de MID, llegó {:?}", other),
        }
    }

    #[test]
    fn metronomo_falla_al_pasar_la_ventana() {
        let mut m = MetronomeRunner::default();
        m.start(&cfg_metronomo(), 60.0);
        m.tick(60.0, &[], &[]);
        // Dentro de la ventana todavía no se decide nada.
        assert_eq!(m.tick(64.0, &[], &[]), None);
        assert_eq!(
            m.tick(66.0, &[], &[]),
            Some(MetronomeEvent::Ack {
                ok: false,
                role: "TOP".into(),
                latency_ms: 0.0
            })
        );
        assert_eq!(m.results.len(), 1);
        assert!(!m.results[0].responded);
    }

    #[test]
    fn metronomo_ignora_pulsaciones_previas_al_aviso() {
        use crate::awareness::CameraPress;
        let mut m = MetronomeRunner::default();
        m.start(&cfg_metronomo(), 60.0);
        // Una pulsación de TOP ANTES del aviso no debe validarlo.
        let previas = vec![CameraPress { t: 30.0, role: "TOP".into() }];
        m.tick(60.0, &previas, &[]);
        assert_eq!(m.tick(61.0, &previas, &[]), None);
        assert!(matches!(
            m.tick(66.0, &previas, &[]),
            Some(MetronomeEvent::Ack { ok: false, .. })
        ));
    }

    #[test]
    fn metronomo_desactivado_no_hace_nada() {
        let mut m = MetronomeRunner::default();
        m.start(&TrainingConfig::default(), 0.0); // metronome_enabled = false
        assert!(!m.is_enabled());
        assert_eq!(m.tick(1000.0, &[], &[]), None);
    }

    #[test]
    fn note_key_ignora_si_no_esta_activo() {
        let st = TrainingState::default();
        st.set_bindings(vec![CameraBinding { key: "2".into(), role: "MID".into() }]);
        assert_eq!(st.note_key(rdev::Key::Num2), None);
        st.active.store(true, Ordering::Relaxed);
        assert_eq!(st.note_key(rdev::Key::Num2), Some("MID".to_string()));
        assert_eq!(st.note_key(rdev::Key::Num9), None);
        assert_eq!(st.drain_presses().len(), 1);
        assert!(st.drain_presses().is_empty());
    }
}
