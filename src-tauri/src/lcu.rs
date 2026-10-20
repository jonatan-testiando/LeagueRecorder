//! Conexión de SOLO LECTURA al cliente de League (el LCU, `LeagueClientUx.exe`).
//!
//! La app solo sabía de la partida por la API del juego en el puerto 2999, que
//! existe mientras el juego corre y nada más: no dice la cola, ni el `gameId`,
//! ni en qué punto del ciclo (cola, selección, carga, post-partida) está el
//! cliente. Por eso la partida de Riot se emparejaba al final por duración
//! ±180 s. El cliente sí lo sabe, y lo sirve por HTTPS en 127.0.0.1.
//!
//! Tres piezas:
//!   - Credenciales: el `lockfile` de la carpeta de instalación
//!     (`nombre:pid:puerto:contraseña:protocolo`) o, si no aparece, la línea de
//!     comandos de `LeagueClientUx.exe` (`--app-port`, `--remoting-auth-token`).
//!   - Un cliente HTTP propio que verifica el TLS contra la CA raíz de Riot y
//!     contra nada más. El certificado del LCU lo firma esa CA y lleva
//!     `IP:127.0.0.1` en el SAN (medido el 2026-10-19), así que no hace falta
//!     aceptar certificados inválidos: se valida entero, nombre incluido. Sin
//!     proxy y sin redirecciones, para que la contraseña no salga de la máquina.
//!   - Un sondeo cada 2 s de la fase de gameflow y, con partida, de la sesión
//!     (`gameId`, cola). El WebSocket WAMP del cliente lo daría por eventos;
//!     queda como mejora.
//!
//! Solo GET: nada de este módulo escribe en el cliente.
//!
//! La contraseña no va a ningún log: `Credenciales` tiene un `Debug` propio que
//! la oculta, y los errores de reqwest llevan la URL, no las cabeceras.

use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Emitter;

/// CA raíz de Riot ("LoL Game Engineering Certificate Authority"), la
/// `riotgames.pem` que publica Riot para las APIs locales. SHA-256
/// CA:8C:9D:32:…:4A:50:4E:A3, la misma que presenta el cliente; caduca en 2043.
const RIOT_CA_PEM: &str = include_str!("../certs/riotgames.pem");

/// Cada cuánto se pregunta la fase.
const SONDEO: Duration = Duration::from_secs(2);

/// Tiempo de respuesta máximo. Es localhost: lo que tarde más es un cliente
/// colgado, y el sondeo no debe quedarse esperándolo.
const TIMEOUT: Duration = Duration::from_secs(3);

/// Una lectura de la sesión vale como "partida en curso" durante este tiempo.
/// Pasado, el monitor de partida no se fía: puede ser de antes de un corte.
const FRESCURA: Duration = Duration::from_secs(10);

/// El nombre que pone el LCU en su lockfile. El de Riot Client (`Riot Client`)
/// tiene el mismo formato pero es otro servidor y otra contraseña.
const NOMBRE_LCU: &str = "LeagueClient";

const EXE_UX: &str = "LeagueClientUx.exe";

/// Instalación por defecto, por si `RiotClientInstalls.json` no la lista.
const CARPETA_POR_DEFECTO: &str = r"C:\Riot Games\League of Legends";

/// Fases de gameflow en las que la sesión ya es la de una partida concreta y
/// trae su `gameId`. Antes (sala, cola, selección) no hay partida que guardar.
pub const FASES_CON_PARTIDA: [&str; 6] = [
    "GameStart",
    "InProgress",
    "Reconnect",
    "WaitingForStats",
    "PreEndOfGame",
    "EndOfGame",
];

/// Fases en las que la partida todavía no ha terminado para el cliente: el
/// juego sigue abierto, o se cerró pero el servidor aún no ha mandado las
/// estadísticas. `Reconnect` es un juego que se cerró a lo bruto con la
/// partida viva: no es un final.
const FASES_SIN_TERMINAR: [&str; 4] = ["GameStart", "InProgress", "Reconnect", "WaitingForStats"];

/// Puerto y contraseña de la API del cliente.
#[derive(Clone, PartialEq, Eq)]
pub struct Credenciales {
    pub puerto: u16,
    pub password: String,
}

impl std::fmt::Debug for Credenciales {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credenciales")
            .field("puerto", &self.puerto)
            .field("password", &"<oculta>")
            .finish()
    }
}

/// Un lockfile leído.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lockfile {
    pub nombre: String,
    pub pid: u32,
    pub cred: Credenciales,
}

/// `LeagueClient:15164:50097:<contraseña>:https` → sus campos.
///
/// Se lee de derecha a izquierda: el nombre es el único campo que podría traer
/// dos puntos, así que se queda con todo lo que sobre. Solo vale `https`, que
/// es lo único que sirve el cliente y lo único que habla `cliente_http`.
pub fn parse_lockfile(texto: &str) -> Option<Lockfile> {
    let texto = texto.trim_start_matches('\u{feff}').trim();
    let mut campos = texto.rsplitn(5, ':');
    let protocolo = campos.next()?;
    let password = campos.next()?;
    let puerto = campos.next()?;
    let pid = campos.next()?;
    let nombre = campos.next()?;
    if !protocolo.eq_ignore_ascii_case("https") || nombre.is_empty() {
        return None;
    }
    if password.is_empty() || password.chars().any(char::is_whitespace) {
        return None;
    }
    Some(Lockfile {
        nombre: nombre.to_string(),
        pid: pid.parse().ok()?,
        cred: Credenciales {
            puerto: puerto.parse().ok().filter(|p| *p != 0)?,
            password: password.to_string(),
        },
    })
}

/// Puerto y contraseña desde la línea de comandos de `LeagueClientUx.exe`.
///
/// El token no es la contraseña del lockfile: el UX tiene el suyo y el servidor
/// acepta los dos (medido el 2026-10-19).
///
/// Los argumentos van entre comillas y algunos llevan espacios (rutas), pero
/// los dos que interesan no, así que basta con trocear por comillas y blancos.
/// Ojo con los parecidos: `--riotclient-app-port` y `--riotclient-auth-token`
/// son los del Riot Client, otro servidor; por eso se compara el prefijo
/// entero y no un `contains`.
pub fn parse_linea_de_comandos(cmd: &str) -> Option<Credenciales> {
    let mut puerto = None;
    let mut password = None;
    for tok in cmd.split(|c: char| c == '"' || c.is_whitespace()) {
        if let Some(v) = tok.strip_prefix("--app-port=") {
            puerto = v.parse::<u16>().ok().filter(|p| *p != 0);
        } else if let Some(v) = tok.strip_prefix("--remoting-auth-token=") {
            password = Some(v.to_string()).filter(|p| !p.is_empty());
        }
    }
    Some(Credenciales {
        puerto: puerto?,
        password: password?,
    })
}

/// Carpetas de `associated_client` en `RiotClientInstalls.json`: sus claves son
/// las instalaciones (`"C:/Riot Games/League of Legends/": "…/RiotClientServices.exe"`).
/// Puede listar otros juegos de Riot; el nombre del lockfile los descarta luego.
pub fn carpetas_de_installs(json: &str) -> Vec<PathBuf> {
    serde_json::from_str::<Value>(json)
        .ok()
        .and_then(|v| v.get("associated_client")?.as_object().cloned())
        .map(|m| m.keys().map(PathBuf::from).collect())
        .unwrap_or_default()
}

/// Dónde buscar el lockfile, sin repetir.
fn carpetas_de_instalacion() -> Vec<PathBuf> {
    let programdata = std::env::var("PROGRAMDATA").unwrap_or_else(|_| r"C:\ProgramData".into());
    let installs = Path::new(&programdata).join("Riot Games").join("RiotClientInstalls.json");
    let mut carpetas = std::fs::read_to_string(installs)
        .map(|t| carpetas_de_installs(&t))
        .unwrap_or_default();
    carpetas.push(PathBuf::from(CARPETA_POR_DEFECTO));
    let mut vistas = std::collections::HashSet::new();
    carpetas.retain(|c| {
        let clave = c.to_string_lossy().replace('\\', "/").trim_end_matches('/').to_lowercase();
        vistas.insert(clave)
    });
    carpetas
}

/// Credenciales de los lockfiles del LCU que haya en disco. Un lockfile puede
/// ser viejo (el cliente se cerró a lo bruto); eso lo descubre la conexión.
fn candidatos_lockfile() -> Vec<Credenciales> {
    carpetas_de_instalacion()
        .into_iter()
        .filter_map(|dir| std::fs::read_to_string(dir.join("lockfile")).ok())
        .filter_map(|t| parse_lockfile(&t))
        .filter(|lf| lf.nombre == NOMBRE_LCU)
        .map(|lf| lf.cred)
        .collect()
}

/// Cliente HTTP del LCU: confía en la CA de Riot y en ninguna otra.
///
/// No usa `danger_accept_invalid_certs`: el certificado se valida entero
/// (firma, fechas, uso y nombre) contra esa única raíz. Lo que no esté firmado
/// por Riot no se acepta ni en 127.0.0.1, y ningún servidor público lo está,
/// así que este cliente tampoco sirve para hablar con fuera.
fn cliente_http() -> Result<reqwest::Client, String> {
    let ders = rustls_pemfile::certs(&mut RIOT_CA_PEM.as_bytes())
        .map_err(|e| format!("CA de Riot ilegible: {e}"))?;
    let mut raices = rustls::RootCertStore::empty();
    let (validas, _) = raices.add_parsable_certificates(&ders);
    if validas != 1 {
        return Err(format!("CA de Riot: {validas} certificados válidos, se esperaba 1"));
    }
    let tls = rustls::ClientConfig::builder()
        .with_safe_defaults()
        .with_root_certificates(raices)
        .with_no_client_auth();
    reqwest::Client::builder()
        .use_preconfigured_tls(tls)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| format!("No se pudo crear el cliente del LCU: {e}"))
}

/// Por qué falló una petición: o el servidor no está (o no nos reconoce), o
/// está y contestó algo raro. Lo primero obliga a buscar credenciales de nuevo.
enum Fallo {
    SinServidor,
    Respuesta(String),
}

/// Conexión al LCU. Busca credenciales cuando no las tiene o dejan de valer.
pub struct Lcu {
    http: reqwest::Client,
    cred: Option<Credenciales>,
}

impl Lcu {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            http: cliente_http()?,
            cred: None,
        })
    }

    async fn pedir(&self, c: &Credenciales, ruta: &str) -> Result<Option<Value>, Fallo> {
        let url = format!("https://127.0.0.1:{}{}", c.puerto, ruta);
        let r = self
            .http
            .get(&url)
            .basic_auth("riot", Some(&c.password))
            .send()
            .await
            .map_err(|_| Fallo::SinServidor)?;
        match r.status().as_u16() {
            200..=299 => r
                .json::<Value>()
                .await
                .map(Some)
                .map_err(|e| Fallo::Respuesta(format!("{ruta}: {e}"))),
            // 404 es una respuesta: "no hay sesión de partida", por ejemplo.
            404 => Ok(None),
            // Contraseña que ya no vale: el cliente se reinició con otra.
            401 | 403 => Err(Fallo::SinServidor),
            s => Err(Fallo::Respuesta(format!("{ruta}: HTTP {s}"))),
        }
    }

    /// Prueba los lockfiles y, si ninguno contesta, la línea de comandos del
    /// proceso. Esta va la última porque cuesta una lista de procesos.
    async fn conectar(&mut self, ruta: &str) -> Result<Option<Value>, Fallo> {
        let mut probadas: Vec<Credenciales> = Vec::new();
        let linea = || {
            crate::winsys::process_command_line(EXE_UX).and_then(|l| parse_linea_de_comandos(&l))
        };
        for c in candidatos_lockfile().into_iter().map(Some).chain(std::iter::once_with(linea)) {
            let Some(c) = c else { continue };
            if probadas.contains(&c) {
                continue;
            }
            match self.pedir(&c, ruta).await {
                Err(Fallo::SinServidor) => probadas.push(c),
                r => {
                    self.cred = Some(c);
                    return r;
                }
            }
        }
        Err(Fallo::SinServidor)
    }

    /// GET de solo lectura. `Ok(None)` si el cliente contesta 404.
    pub async fn get(&mut self, ruta: &str) -> Result<Option<Value>, String> {
        let r = match self.cred.clone() {
            Some(c) => match self.pedir(&c, ruta).await {
                Err(Fallo::SinServidor) => {
                    self.cred = None;
                    self.conectar(ruta).await
                }
                r => r,
            },
            None => self.conectar(ruta).await,
        };
        r.map_err(|f| match f {
            Fallo::SinServidor => "El cliente de League no está abierto".to_string(),
            Fallo::Respuesta(e) => e,
        })
    }

    pub fn conectado(&self) -> bool {
        self.cred.is_some()
    }
}

/// Lo que se sabe del cliente ahora mismo. Va tal cual a la interfaz.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct LcuStatus {
    /// Hay un cliente que contesta.
    pub connected: bool,
    /// Fase de gameflow tal cual la da el cliente: "None", "Lobby",
    /// "Matchmaking", "ReadyCheck", "ChampSelect", "GameStart", "InProgress",
    /// "Reconnect", "WaitingForStats", "PreEndOfGame", "EndOfGame"…
    pub phase: Option<String>,
    /// `gameData.gameId` de la sesión. Solo en `FASES_CON_PARTIDA`.
    pub game_id: Option<i64>,
    /// `gameData.queue.id` (420 clasificatoria solo/dúo, 440 flex…).
    pub queue_id: Option<i32>,
    /// Plataforma del cliente ("LA1", "EUW1"): el prefijo del id de Match-V5.
    pub platform_id: Option<String>,
}

/// La partida que el cliente dice que se está jugando.
#[derive(Debug, Clone, PartialEq)]
pub struct PartidaLcu {
    pub game_id: i64,
    pub queue_id: Option<i32>,
    pub platform_id: Option<String>,
}

struct Estado {
    status: LcuStatus,
    leido: Option<Instant>,
}

static ESTADO: Mutex<Estado> = Mutex::new(Estado {
    status: LcuStatus {
        connected: false,
        phase: None,
        game_id: None,
        queue_id: None,
        platform_id: None,
    },
    leido: None,
});

/// Último estado leído del cliente.
pub fn status() -> LcuStatus {
    ESTADO.lock().map(|e| e.status.clone()).unwrap_or_default()
}

/// La partida en curso según el cliente, solo si la lectura es reciente y la
/// fase es de partida. Lo que pida esto para etiquetar una grabación prefiere
/// quedarse sin `gameId` a ponerle el de la partida anterior.
pub fn partida_en_curso() -> Option<PartidaLcu> {
    let e = ESTADO.lock().ok()?;
    if !e.leido.is_some_and(|t| t.elapsed() < FRESCURA) {
        return None;
    }
    partida_de(&e.status)
}

/// Lo más que se espera a que vuelva el juego de una partida que se cayó viva.
/// Pulsar «Reconectar» y pasar otra vez la pantalla de carga se lleva uno o dos
/// minutos. Pasado esto la partida se guarda como esté, y si el jugador vuelve
/// más tarde, la vuelta es otra grabación.
pub const MAX_ESPERA_RECONEXION: Duration = Duration::from_secs(5 * 60);

/// Fases en las que el juego de la partida puede volver. `Reconnect` es el
/// juego caído con la partida viva. `GameStart` e `InProgress` son el juego
/// relanzándose tras pulsar «Reconectar», y también lo que se lee durante los
/// primeros segundos de la caída, antes de que el cliente se entere o el
/// sondeo vea el cambio.
const FASES_DE_VUELTA: [&str; 3] = ["Reconnect", "GameStart", "InProgress"];

/// ¿Se sigue esperando a que vuelva el juego, en vez de cerrar la partida?
///
/// `fase` y `game_id` son lo que dice el cliente. `partida` es el `gameId` de
/// la sesión que se está grabando y `caido`, cuánto lleva sin contestar la API
/// del juego (puerto 2999). Solo se espera por la misma partida: sin `gameId`
/// de la sesión no hay con qué comparar, y se cierra como siempre.
pub fn seguir_esperando(
    fase: Option<&str>,
    game_id: Option<i64>,
    partida: Option<i64>,
    caido: Duration,
) -> bool {
    caido < MAX_ESPERA_RECONEXION
        && partida.is_some()
        && game_id == partida
        && fase.is_some_and(|f| FASES_DE_VUELTA.contains(&f))
}

/// `seguir_esperando` con lo último que se leyó del cliente. Una lectura vieja
/// o un cliente cerrado no sostienen la espera.
pub fn esperar_reconexion(partida: Option<i64>, caido: Duration) -> bool {
    let Ok(e) = ESTADO.lock() else {
        return false;
    };
    e.leido.is_some_and(|t| t.elapsed() < FRESCURA)
        && e.status.connected
        && seguir_esperando(e.status.phase.as_deref(), e.status.game_id, partida, caido)
}

fn partida_de(st: &LcuStatus) -> Option<PartidaLcu> {
    if !st.connected || !FASES_CON_PARTIDA.contains(&st.phase.as_deref()?) {
        return None;
    }
    Some(PartidaLcu {
        game_id: st.game_id.filter(|g| *g > 0)?,
        queue_id: st.queue_id,
        platform_id: st.platform_id.clone(),
    })
}

/// ¿Ha terminado la partida según el cliente? `None` si no se sabe: cliente
/// cerrado o lectura vieja.
///
/// Es el disparo de iTero: de `InProgress` a cualquier fase de después, sea
/// `PreEndOfGame` (honor), `EndOfGame` (estadísticas) o `None`/`Lobby` si el
/// jugador se salta la pantalla de fin. Quien lo use tiene que haber visto
/// antes la partida en curso: esto mira la fase de ahora, no la transición.
pub fn partida_terminada() -> Option<bool> {
    let e = ESTADO.lock().ok()?;
    if !e.leido.is_some_and(|t| t.elapsed() < FRESCURA) {
        return None;
    }
    terminada(&e.status)
}

fn terminada(st: &LcuStatus) -> Option<bool> {
    if !st.connected {
        return None;
    }
    let fase = st.phase.as_deref()?;
    Some(!FASES_SIN_TERMINAR.contains(&fase))
}

/// Espera, como mucho `max`, a que el cliente dé la partida por terminada.
/// `true` si lo dijo; `false` si se agotó el plazo o no hay cliente al que
/// preguntar (entonces no se espera nada).
pub async fn esperar_fin_de_partida(max: Duration) -> bool {
    let hasta = Instant::now() + max;
    loop {
        match partida_terminada() {
            Some(true) => return true,
            None => return false,
            Some(false) if Instant::now() >= hasta => return false,
            Some(false) => tokio::time::sleep(Duration::from_secs(1)).await,
        }
    }
}

/// `(gameId, queueId)` de `/lol-gameflow/v1/session`. Un 0 o un negativo es
/// "todavía no hay" (las colas personalizadas no tienen id de cola real).
pub fn parse_sesion(sesion: &Value) -> (Option<i64>, Option<i32>) {
    let datos = sesion.get("gameData");
    let game_id = datos
        .and_then(|d| d.get("gameId"))
        .and_then(Value::as_i64)
        .filter(|g| *g > 0);
    let queue_id = datos
        .and_then(|d| d.get("queue"))
        .and_then(|q| q.get("id"))
        .and_then(Value::as_i64)
        .filter(|q| *q >= 0)
        .and_then(|q| i32::try_from(q).ok());
    (game_id, queue_id)
}

/// Plataforma del cliente. `/lol-chat/v1/me` la da tal cual ("LA1"); si no
/// contesta, la región de `/riotclient/region-locale` vale cuando coincide con
/// una plataforma conocida (LA1, LA2, OC1…). Las que no coinciden ("EUW" no es
/// "EUW1") se quedan sin plataforma, y la sincronización vuelve al emparejado
/// por duración.
async fn leer_plataforma(lcu: &mut Lcu) -> Option<String> {
    let de = |v: Option<Value>, campo: &str| {
        v.and_then(|v| v.get(campo)?.as_str().map(str::to_string))
            .filter(|p| crate::riot_api::platform_conocida(p).is_some())
            .map(|p| p.to_ascii_uppercase())
    };
    if let Some(p) = de(lcu.get("/lol-chat/v1/me").await.ok().flatten(), "platformId") {
        return Some(p);
    }
    de(lcu.get("/riotclient/region-locale").await.ok().flatten(), "region")
}

/// Una vuelta del sondeo.
async fn sondear(lcu: &mut Lcu, plataforma: &mut Option<String>, antes: &LcuStatus) -> LcuStatus {
    let fase = match lcu.get("/lol-gameflow/v1/gameflow-phase").await {
        Ok(Some(Value::String(f))) => f,
        Ok(_) => "None".to_string(),
        Err(_) if !lcu.conectado() => {
            // Cliente cerrado: la próxima vez puede ser otra cuenta y otra región.
            *plataforma = None;
            return LcuStatus::default();
        }
        // Contestó pero mal (un plugin aún arrancando): se mantiene lo que había.
        Err(_) => return antes.clone(),
    };
    if plataforma.is_none() {
        *plataforma = leer_plataforma(lcu).await;
    }
    let mut st = LcuStatus {
        connected: true,
        phase: Some(fase.clone()),
        platform_id: plataforma.clone(),
        ..Default::default()
    };
    if FASES_CON_PARTIDA.contains(&fase.as_str()) {
        // La sesión se relee al cambiar de fase o mientras no traiga gameId;
        // dentro de una misma fase no cambia.
        if antes.phase.as_deref() == Some(fase.as_str()) && antes.game_id.is_some() {
            st.game_id = antes.game_id;
            st.queue_id = antes.queue_id;
        } else if let Ok(Some(sesion)) = lcu.get("/lol-gameflow/v1/session").await {
            (st.game_id, st.queue_id) = parse_sesion(&sesion);
        }
    }
    st
}

/// Sondea el cliente cada 2 s, guarda el estado para `status()` y
/// `partida_en_curso()`, y avisa a la interfaz con `lcu-status` al cambiar.
pub fn spawn_monitor(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut lcu = match Lcu::new() {
            Ok(l) => l,
            Err(e) => {
                log::warn!("LCU desactivado: {e}");
                return;
            }
        };
        let mut plataforma = None;
        let mut antes = LcuStatus::default();
        loop {
            let ahora = sondear(&mut lcu, &mut plataforma, &antes).await;
            if let Ok(mut e) = ESTADO.lock() {
                e.status = ahora.clone();
                e.leido = Some(Instant::now());
            }
            if ahora != antes {
                log::info!(
                    "LCU: conectado={} fase={:?} gameId={:?} cola={:?} plataforma={:?}",
                    ahora.connected,
                    ahora.phase,
                    ahora.game_id,
                    ahora.queue_id,
                    ahora.platform_id
                );
                let _ = app.emit("lcu-status", &ahora);
                antes = ahora;
            }
            tokio::time::sleep(SONDEO).await;
        }
    });
}

#[tauri::command]
pub fn get_lcu_status() -> LcuStatus {
    status()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lockfile_del_lcu() {
        let lf = parse_lockfile("LeagueClient:15164:50097:AbC-d_EfGh12345678ZyXw:https").unwrap();
        assert_eq!(lf.nombre, "LeagueClient");
        assert_eq!(lf.pid, 15164);
        assert_eq!(lf.cred.puerto, 50097);
        assert_eq!(lf.cred.password, "AbC-d_EfGh12345678ZyXw");
    }

    #[test]
    fn lockfile_con_salto_de_linea_y_bom() {
        let lf = parse_lockfile("\u{feff}LeagueClient:1:2999:pw:https\r\n").unwrap();
        assert_eq!(lf.cred.puerto, 2999);
        assert_eq!(lf.cred.password, "pw");
    }

    #[test]
    fn lockfile_del_riot_client_se_lee_pero_lleva_otro_nombre() {
        // Mismo formato, otro servidor: el filtro por nombre es lo que lo aparta.
        let lf = parse_lockfile("Riot Client:18824:56342:pw:https").unwrap();
        assert_eq!(lf.nombre, "Riot Client");
        assert_ne!(lf.nombre, NOMBRE_LCU);
    }

    #[test]
    fn lockfile_con_dos_puntos_en_el_nombre() {
        let lf = parse_lockfile("Raro:Nombre:7:1234:pw:https").unwrap();
        assert_eq!(lf.nombre, "Raro:Nombre");
        assert_eq!(lf.pid, 7);
        assert_eq!(lf.cred.puerto, 1234);
    }

    #[test]
    fn lockfiles_rotos() {
        for malo in [
            "",
            "LeagueClient",
            "LeagueClient:1:2:pw",                   // falta el protocolo
            "LeagueClient:1:50097:pw:http",          // solo https
            "LeagueClient:1:0:pw:https",             // puerto 0
            "LeagueClient:1:70000:pw:https",         // fuera de rango
            "LeagueClient:x:50097:pw:https",         // pid no numérico
            "LeagueClient:1:50097::https",           // sin contraseña
            "LeagueClient:1:50097:p w:https",        // contraseña con blancos
            ":1:50097:pw:https",                     // sin nombre
        ] {
            assert!(parse_lockfile(malo).is_none(), "debería rechazar {malo:?}");
        }
    }

    /// Recorte con la forma real de la línea de comandos (2026-10-19), con los
    /// argumentos del Riot Client que se parecen a los buenos.
    #[test]
    fn linea_de_comandos_de_league_client_ux() {
        let cmd = r#""C:/Riot Games/League of Legends/LeagueClientUx.exe" "--riotclient-auth-token=NOesEste" "--riotclient-app-port=56342" "--no-rads" "--region=LA1" "--remoting-auth-token=EsteSiQueEs_-12345678" "--respawn-display-name=League of Legends" "--app-port=50097" "--install-directory=C:\Riot Games\League of Legends" "--app-pid=15164""#;
        let c = parse_linea_de_comandos(cmd).unwrap();
        assert_eq!(c.puerto, 50097);
        assert_eq!(c.password, "EsteSiQueEs_-12345678");
    }

    #[test]
    fn linea_de_comandos_incompleta() {
        assert!(parse_linea_de_comandos(r#""x.exe" "--app-port=50097""#).is_none());
        assert!(parse_linea_de_comandos(r#""x.exe" "--remoting-auth-token=pw""#).is_none());
        assert!(parse_linea_de_comandos(r#""x.exe" "--riotclient-app-port=1" "--riotclient-auth-token=pw""#).is_none());
        assert!(parse_linea_de_comandos(r#""x.exe" "--app-port=" "--remoting-auth-token=pw""#).is_none());
    }

    #[test]
    fn el_debug_no_ensena_la_contrasena() {
        let c = Credenciales { puerto: 1, password: "secreta".into() };
        let lf = Lockfile { nombre: "LeagueClient".into(), pid: 1, cred: c.clone() };
        assert!(!format!("{c:?}").contains("secreta"));
        assert!(!format!("{lf:?}").contains("secreta"));
    }

    #[test]
    fn carpetas_de_riot_client_installs() {
        let json = r#"{
            "associated_client": {
                "C:/Riot Games/League of Legends/": "C:/Riot Games/Riot Client/RiotClientServices.exe",
                "D:/Juegos/VALORANT/live/": "C:/Riot Games/Riot Client/RiotClientServices.exe"
            },
            "rc_default": "C:/Riot Games/Riot Client/RiotClientServices.exe"
        }"#;
        let mut v = carpetas_de_installs(json);
        v.sort();
        assert_eq!(
            v,
            vec![
                PathBuf::from("C:/Riot Games/League of Legends/"),
                PathBuf::from("D:/Juegos/VALORANT/live/"),
            ]
        );
        assert!(carpetas_de_installs("no es json").is_empty());
        assert!(carpetas_de_installs("{}").is_empty());
    }

    #[test]
    fn sesion_de_gameflow() {
        let s = serde_json::json!({
            "phase": "InProgress",
            "gameData": { "gameId": 1746460303i64, "queue": { "id": 420, "gameMode": "CLASSIC" } }
        });
        assert_eq!(parse_sesion(&s), (Some(1746460303), Some(420)));
        // Selección de campeón: aún sin partida.
        let s = serde_json::json!({ "gameData": { "gameId": 0, "queue": { "id": 420 } } });
        assert_eq!(parse_sesion(&s), (None, Some(420)));
        // Personalizada.
        let s = serde_json::json!({ "gameData": { "gameId": 5, "queue": { "id": -1 } } });
        assert_eq!(parse_sesion(&s), (Some(5), None));
        assert_eq!(parse_sesion(&serde_json::json!({})), (None, None));
    }

    #[test]
    fn solo_hay_partida_en_fase_de_partida() {
        let mut st = LcuStatus {
            connected: true,
            phase: Some("InProgress".into()),
            game_id: Some(42),
            queue_id: Some(420),
            platform_id: Some("LA1".into()),
        };
        assert_eq!(partida_de(&st).map(|p| p.game_id), Some(42));
        st.phase = Some("ChampSelect".into());
        assert!(partida_de(&st).is_none());
        st.phase = Some("InProgress".into());
        st.game_id = None;
        assert!(partida_de(&st).is_none());
        st.game_id = Some(42);
        st.connected = false;
        assert!(partida_de(&st).is_none());
    }

    #[test]
    fn fin_de_partida_por_la_fase() {
        let con = |fase: &str| LcuStatus {
            connected: true,
            phase: Some(fase.into()),
            ..Default::default()
        };
        // Lo de iTero (de partida a None o Lobby) y las pantallas de fin.
        for fin in ["PreEndOfGame", "EndOfGame", "None", "Lobby", "Matchmaking", "ChampSelect"] {
            assert_eq!(terminada(&con(fin)), Some(true), "{fin}");
        }
        // Juego abierto, juego caído con la partida viva, o estadísticas sin llegar.
        for sigue in ["GameStart", "InProgress", "Reconnect", "WaitingForStats"] {
            assert_eq!(terminada(&con(sigue)), Some(false), "{sigue}");
        }
        // Sin cliente no se sabe: manda la API del juego.
        assert_eq!(terminada(&LcuStatus::default()), None);
        assert_eq!(terminada(&LcuStatus { connected: true, ..Default::default() }), None);
    }

    #[test]
    fn la_ca_de_riot_se_carga() {
        let ders = rustls_pemfile::certs(&mut RIOT_CA_PEM.as_bytes()).unwrap();
        assert_eq!(ders.len(), 1);
        let mut raices = rustls::RootCertStore::empty();
        // Es un X.509 v1: webpki lo acepta como raíz de confianza.
        assert_eq!(raices.add_parsable_certificates(&ders), (1, 0));
        assert!(cliente_http().is_ok());
    }

    /// Contra el cliente de verdad: `LCU_EN_VIVO=1 cargo test --lib lcu::tests::en_vivo -- --nocapture`.
    /// Prueba que el TLS valida contra la CA de Riot sin aceptar nada inválido.
    #[test]
    fn en_vivo() {
        if std::env::var("LCU_EN_VIVO").is_err() {
            return;
        }
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let mut lcu = Lcu::new().unwrap();
            let fase = lcu.get("/lol-gameflow/v1/gameflow-phase").await;
            println!("fase: {fase:?}");
            assert!(matches!(fase, Ok(Some(Value::String(_)))), "{fase:?}");
            let mut plataforma = None;
            let st = sondear(&mut lcu, &mut plataforma, &LcuStatus::default()).await;
            println!("estado: {st:?}");
            assert!(st.connected);
            // La otra vía (sin lockfile) tiene que entrar también. La contraseña
            // NO es la del lockfile (medido: el UX tiene su propio token y el
            // servidor acepta los dos), así que se prueba que autentique.
            let por_linea = crate::winsys::process_command_line(EXE_UX)
                .and_then(|l| parse_linea_de_comandos(&l))
                .expect("sin credenciales en la línea de comandos");
            assert_eq!(Some(por_linea.puerto), lcu.cred.as_ref().map(|c| c.puerto));
            let r = lcu.pedir(&por_linea, "/lol-gameflow/v1/gameflow-phase").await;
            assert!(matches!(r, Ok(Some(Value::String(_)))), "el token de la línea de comandos no entra");
            // El mismo puerto con un cliente que confía en las raíces públicas
            // tiene que fallar: si no, no estaríamos verificando nada.
            let Some(c) = lcu.cred.clone() else { panic!("sin credenciales") };
            let publico = reqwest::Client::builder().no_proxy().build().unwrap();
            let r = publico
                .get(format!("https://127.0.0.1:{}/lol-gameflow/v1/gameflow-phase", c.puerto))
                .send()
                .await;
            assert!(r.is_err(), "un cliente sin la CA de Riot no debería conectar");
        });
    }

    #[test]
    fn se_espera_al_juego_caido_de_la_misma_partida() {
        let s = Duration::from_secs;
        let partida = Some(4_321_000_123);
        // El juego se cayó y el cliente ofrece reconectar.
        assert!(seguir_esperando(Some("Reconnect"), partida, partida, s(4)));
        assert!(seguir_esperando(Some("Reconnect"), partida, partida, s(299)));
        // Los primeros segundos el cliente aún dice InProgress; y tras pulsar
        // «Reconectar», GameStart o InProgress mientras el juego carga.
        for fase in ["InProgress", "GameStart"] {
            assert!(seguir_esperando(Some(fase), partida, partida, s(3)), "{fase}");
            assert!(seguir_esperando(Some(fase), partida, partida, s(150)), "{fase}");
        }
    }

    #[test]
    fn no_se_espera_mas_de_cinco_minutos() {
        let partida = Some(7);
        assert!(!seguir_esperando(Some("Reconnect"), partida, partida, MAX_ESPERA_RECONEXION));
        assert!(!seguir_esperando(Some("Reconnect"), partida, partida, Duration::from_secs(3600)));
    }

    #[test]
    fn no_se_espera_por_otra_partida_ni_sin_gameid() {
        let s = Duration::from_secs(5);
        // El cliente habla de otra partida: la nuestra ya no va a volver.
        assert!(!seguir_esperando(Some("Reconnect"), Some(8), Some(7), s));
        // La sesión no llegó a saber su gameId: no hay con qué comparar.
        assert!(!seguir_esperando(Some("Reconnect"), Some(7), None, s));
        assert!(!seguir_esperando(Some("Reconnect"), None, None, s));
        // El cliente no dio gameId en la fase de reconexión.
        assert!(!seguir_esperando(Some("Reconnect"), None, Some(7), s));
    }

    #[test]
    fn no_se_espera_si_la_partida_acabo_o_no_hay_cliente() {
        let s = Duration::from_secs(5);
        let partida = Some(7);
        for fase in ["WaitingForStats", "PreEndOfGame", "EndOfGame", "None", "Lobby", "ChampSelect"] {
            assert!(!seguir_esperando(Some(fase), partida, partida, s), "{fase}");
        }
        assert!(!seguir_esperando(None, partida, partida, s));
    }
}
