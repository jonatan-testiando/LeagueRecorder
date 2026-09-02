use reqwest::Client;
use serde::Deserialize;
use std::time::Duration;
use tauri::Emitter;

/// Las plataformas de Riot, tal cual las escribe la API en el prefijo del id de
/// partida ("EUW1_7412…"). El orden es el que ve el usuario en Ajustes.
pub const PLATFORMS: [&str; 17] = [
    "la1", "la2", "na1", "br1", "euw1", "eun1", "tr1", "ru", "kr", "jp1", "oc1", "ph2", "sg2",
    "th2", "tw2", "vn2", "me1",
];

/// Las cuatro rutas regionales, en el orden en que se sondean con "auto".
/// Americas primero porque es de donde vino la app (LAN).
pub const ROUTES: [&str; 4] = ["americas", "europe", "asia", "sea"];

/// Plataforma → ruta regional. account-v1 y match-v5 viven en la regional
/// (`americas.api.riotgames.com`); league-v4 vive en la de plataforma
/// (`euw1.api.riotgames.com`). Confundirlas devuelve 404 sin más explicación.
///
/// Una plataforma desconocida cae a "americas": es una ruta válida, así que el
/// fallo sale como "esa cuenta no existe aquí" y no como una URL rota.
pub fn regional_route(platform: &str) -> &'static str {
    match platform.trim().to_ascii_lowercase().as_str() {
        "la1" | "la2" | "na1" | "br1" => "americas",
        "euw1" | "eun1" | "tr1" | "ru" | "me1" => "europe",
        "kr" | "jp1" => "asia",
        "oc1" | "ph2" | "sg2" | "th2" | "tw2" | "vn2" => "sea",
        _ => "americas",
    }
}

/// Plataforma sacada del id de partida ("EUW1_7412…" → "euw1"). `None` si el
/// prefijo no es una plataforma conocida: así una cadena rara no se cuela como
/// host y produce una URL que no existe.
pub fn platform_from_match_id(match_id: &str) -> Option<String> {
    let prefijo = match_id.split('_').next()?.trim().to_ascii_lowercase();
    PLATFORMS.contains(&prefijo.as_str()).then_some(prefijo)
}

/// La plataforma si es una de las conocidas, `None` si es "auto", está vacía o
/// no la reconocemos.
pub fn platform_conocida(platform: &str) -> Option<String> {
    let p = platform.trim().to_ascii_lowercase();
    PLATFORMS.contains(&p.as_str()).then_some(p)
}

/// ¿No hay con qué llamar a Riot? Con un proxy configurado la clave la pone el
/// servidor, así que exigirla aquí dejaría el proxy inservible: todos los
/// caminos se cortaban antes de llegar a pedir nada.
fn sin_credencial(cfg: &crate::storage::AppConfig) -> bool {
    cfg.riot_api_key.trim().is_empty() && cfg.riot_proxy_url.trim().is_empty()
}

/// Estado de la clave de Riot que se le cuenta a la interfaz.
#[derive(serde::Serialize, Clone)]
pub struct KeyStatus {
    /// "ok" | "invalid" | "expired" | "missing"
    pub status: String,
    pub message: String,
}

/// El `AppHandle` para poder emitir desde funciones que no lo reciben (el
/// cliente HTTP se construye en sitios muy dentro). Lo pone `check_riot_key`,
/// que la UI llama al arrancar.
static APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();
/// Último estado emitido y cuándo, para no repetir el mismo cada segundo.
static ULTIMO: std::sync::Mutex<Option<(String, std::time::Instant)>> =
    std::sync::Mutex::new(None);
/// Ventana de silencio para un estado que ya se emitió.
const KEY_STATUS_COOLDOWN: Duration = Duration::from_secs(60);

pub fn set_app_handle(app: tauri::AppHandle) {
    let _ = APP.set(app);
}

/// Emite `riot_key_status` si toca. Un estado distinto del último sale al
/// momento; el mismo, como mucho una vez por minuto: una sincronización dispara
/// decenas de peticiones y todas fallarían igual.
pub fn emit_key_status(status: &str, message: &str) {
    {
        let Ok(mut ultimo) = ULTIMO.lock() else { return };
        if let Some((prev, cuando)) = ultimo.as_ref() {
            if prev == status && cuando.elapsed() < KEY_STATUS_COOLDOWN {
                return;
            }
        }
        *ultimo = Some((status.to_string(), std::time::Instant::now()));
    }
    if let Some(app) = APP.get() {
        let _ = app.emit(
            "riot_key_status",
            KeyStatus { status: status.to_string(), message: message.to_string() },
        );
    }
}

/// Tras un fallo, el primer acierto tiene que devolver la UI a la normalidad.
/// Si nunca se emitió un fallo no se emite nada: sin banner que quitar, avisar
/// de que todo va bien es ruido.
fn emit_key_ok_si_venia_de_fallo() {
    let venia_mal = ULTIMO
        .lock()
        .ok()
        .and_then(|u| u.as_ref().map(|(s, _)| s != "ok"))
        .unwrap_or(false);
    if venia_mal {
        emit_key_status("ok", "");
    }
}

/// Traduce el código HTTP de cualquier respuesta a estado de la clave.
///
/// 401 = la cabecera no vale (clave mal escrita o ausente); 403 = Riot la
/// conoce y la rechaza, que en la práctica es "caducó" — es lo que devuelve una
/// clave de desarrollo pasadas sus 24 h.
fn avisa_del_estado_de_la_clave(codigo: u16) {
    match codigo {
        401 => emit_key_status("invalid", "La clave de Riot no es válida"),
        403 => emit_key_status("expired", "La clave de Riot ha caducado"),
        c if (200..300).contains(&c) => emit_key_ok_si_venia_de_fallo(),
        _ => {}
    }
}

pub struct RiotApiClient {
    client: Client,
    api_key: String,
    /// Ruta regional para account-v1 y match-v5: "americas", "europe"…
    region: String,
    /// Plataforma para league-v4: "la1", "euw1"… Vacía mientras no se sepa.
    platform: String,
    /// Proxy propio que pone la clave por el usuario. Vacío = directo a Riot.
    proxy: String,
}

#[derive(Deserialize, Debug, Clone)]
#[allow(non_snake_case)]
pub struct AccountDto {
    pub puuid: String,
    pub gameName: Option<String>,
    pub tagLine: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct MatchDto {
    pub info: MatchInfo,
}

#[derive(Deserialize, Debug, Clone)]
#[allow(non_snake_case)]
pub struct MatchInfo {
    pub gameDuration: i64,
    #[serde(default)]
    pub gameVersion: String,
    #[serde(default)]
    pub gameEndTimestamp: i64,
    pub participants: Vec<ParticipantDto>,
    #[serde(default)]
    pub teams: Vec<TeamDto>,
    #[serde(default)]
    pub queueId: i32,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[allow(non_snake_case)]
pub struct TeamDto {
    #[serde(default)]
    pub teamId: i32,
    #[serde(default)]
    pub win: bool,
    #[serde(default)]
    pub objectives: ObjectivesDto,
}

#[derive(Deserialize, Debug, Clone, Default)]
// Los nombres replican el JSON de Riot tal cual (igual que ObjCount más abajo): renombrarlos
// obligaría a un #[serde(rename)] por campo sin ganar nada.
#[allow(non_snake_case)]
pub struct ObjectivesDto {
    #[serde(default)]
    pub baron: ObjCount,
    #[serde(default)]
    pub dragon: ObjCount,
    #[serde(default)]
    pub tower: ObjCount,
    #[serde(default)]
    pub riftHerald: ObjCount,
    #[serde(default)]
    pub inhibitor: ObjCount,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[allow(non_snake_case)]
pub struct ObjCount {
    #[serde(default)]
    pub kills: i32,
}

// --- Timeline (Match-V5 /timeline) para análisis completo estilo YOUR.GG ---
#[derive(Deserialize, Debug, Clone)]
pub struct TimelineDto {
    pub info: TimelineInfo,
}

#[derive(Deserialize, Debug, Clone)]
pub struct TimelineInfo {
    #[serde(default)]
    pub frames: Vec<TimelineFrame>,
}

#[derive(Deserialize, Debug, Clone)]
#[allow(non_snake_case)]
pub struct TimelineFrame {
    #[serde(default)]
    pub timestamp: i64,
    #[serde(default)]
    pub events: Vec<TimelineEvent>,
    #[serde(default)]
    pub participantFrames: std::collections::HashMap<String, ParticipantFrameDto>,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[allow(non_snake_case)]
pub struct ParticipantFrameDto {
    #[serde(default)]
    pub participantId: i32,
    #[serde(default)]
    pub totalGold: i32,
    #[serde(default)]
    pub currentGold: i32,
    #[serde(default)]
    pub xp: i32,
    #[serde(default)]
    pub level: i32,
    #[serde(default)]
    pub minionsKilled: i32,
    #[serde(default)]
    pub jungleMinionsKilled: i32,
    #[serde(default)]
    pub timeEnemySpentControlled: i32,
    #[serde(default)]
    pub position: Option<PositionDto>,
    /// Estado del campeón en ese minuto. `movementSpeed` es la pieza clave para
    /// acotar hasta dónde pudo desplazarse entre dos frames (ver el estimador de
    /// ocupación del mapa); el resto sirve para valorar peleas.
    #[serde(default)]
    pub championStats: ChampionStatsDto,
    /// Daño acumulado hasta ese minuto, desglosado. Restando frames consecutivos
    /// se obtiene el daño *de ese minuto*, que es lo que interesa.
    #[serde(default)]
    pub damageStats: DamageStatsDto,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[allow(non_snake_case)]
pub struct ChampionStatsDto {
    #[serde(default)]
    pub movementSpeed: i32,
    #[serde(default)]
    pub health: i32,
    #[serde(default)]
    pub healthMax: i32,
    #[serde(default)]
    pub armor: i32,
    #[serde(default)]
    pub magicResist: i32,
    #[serde(default)]
    pub attackDamage: i32,
    #[serde(default)]
    pub abilityPower: i32,
    #[serde(default)]
    pub attackSpeed: i32,
    #[serde(default)]
    pub abilityHaste: i32,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[allow(non_snake_case)]
pub struct DamageStatsDto {
    #[serde(default)]
    pub totalDamageDone: i32,
    #[serde(default)]
    pub totalDamageDoneToChampions: i32,
    #[serde(default)]
    pub totalDamageTaken: i32,
    #[serde(default)]
    pub physicalDamageDoneToChampions: i32,
    #[serde(default)]
    pub magicDamageDoneToChampions: i32,
    #[serde(default)]
    pub trueDamageDoneToChampions: i32,
}

#[derive(Deserialize, Debug, Clone, Default)]
pub struct PositionDto {
    #[serde(default)]
    pub x: i32,
    #[serde(default)]
    pub y: i32,
}

#[derive(Deserialize, Debug, Clone)]
#[allow(non_snake_case)]
pub struct TimelineEvent {
    #[serde(rename = "type", default)]
    pub event_type: String,
    #[serde(default)]
    pub timestamp: i64, // ms desde el inicio de la partida
    #[serde(default)]
    pub participantId: i32,
    #[serde(default)]
    pub killerId: i32,
    #[serde(default)]
    pub victimId: i32,
    #[serde(default)]
    pub assistingParticipantIds: Vec<i32>,
    #[serde(default)]
    pub itemId: i32,
    #[serde(default)]
    pub monsterType: Option<String>,
    #[serde(default)]
    pub monsterSubType: Option<String>,
    #[serde(default)]
    pub buildingType: Option<String>,
    #[serde(default)]
    pub towerType: Option<String>,
    #[serde(default)]
    pub laneType: Option<String>,
    #[serde(default)]
    pub wardType: Option<String>,
    #[serde(default)]
    pub creatorId: i32,
    #[serde(default)]
    pub killerTeamId: i32,
    #[serde(default)]
    pub teamId: i32,
    /// Oro base del asesinato. Deja de contar kills a pelo y permite pesarlos por
    /// lo que valieron de verdad.
    #[serde(default)]
    pub bounty: i32,
    #[serde(default)]
    pub shutdownBounty: i32,
    #[serde(default)]
    pub goldGain: i32,
    #[serde(default)]
    pub killStreakLength: i32,
    #[serde(default)]
    pub multiKillLength: i32,
    #[serde(default)]
    pub level: i32,
    #[serde(default)]
    pub skillSlot: i32,
    /// Todo el daño que la víctima repartió antes de morir, por fuente.
    #[serde(default)]
    pub victimDamageDealt: Vec<VictimDamageDto>,
    /// Todo el daño que la víctima recibió, atribuido a cada `participantId` y
    /// hechizo. Es la pieza que permite saber quién hizo el trabajo en un kill
    /// en vez de quién se llevó el último golpe.
    #[serde(default)]
    pub victimDamageReceived: Vec<VictimDamageDto>,
    /// Lo mismo que los dos anteriores pero con la ventana de la pelea entera,
    /// no sólo la secuencia que remató. Riot los envía siempre; en peleas cortas
    /// coinciden con `victimDamage*`, en peleas largas recogen más contexto.
    #[serde(default)]
    pub victimTeamfightDamageDealt: Vec<VictimDamageDto>,
    #[serde(default)]
    pub victimTeamfightDamageReceived: Vec<VictimDamageDto>,
    #[serde(default)]
    pub position: Option<PositionDto>,
}

/// Una instancia de daño dentro de un `CHAMPION_KILL`.
///
/// Dos trampas comprobadas contra respuestas reales de la API:
///
/// - **`participantId == 0` significa "no fue un jugador"** (esbirro, torre). Es
///   el único filtro fiable para quedarse con el daño de campeones; `source_type`
///   NO sirve: todo el daño de campeón llega como `"OTHER"`, y sólo el de
///   esbirros y torres trae `"MINION"` / `"TOWER"`.
/// - **`name` es la *unidad* que pegó, no siempre el campeón dueño.** El daño de
///   mascotas y invocaciones sale con el nombre de la unidad (la Pix de Lulu
///   pegada a un aliado aparece con el nombre del aliado), mientras que
///   `participantId` sí apunta al jugador al que hay que darle el crédito.
///   Medido: ~16% de las instancias no coinciden.
///
/// Para repartir crédito: agrupar por `participantId`, descartando el 0.
#[derive(Deserialize, Debug, Clone, Default)]
#[allow(non_snake_case)]
pub struct VictimDamageDto {
    /// El jugador al que atribuir el daño. 0 = no fue un jugador.
    #[serde(default)]
    pub participantId: i32,
    /// Unidad de origen. Ver la nota del struct: puede ser una mascota.
    #[serde(default)]
    pub name: String,
    #[serde(rename = "type", default)]
    pub source_type: String,
    #[serde(default)]
    pub spellName: String,
    #[serde(default)]
    pub spellSlot: i32,
    #[serde(default)]
    pub basic: bool,
    #[serde(default)]
    pub physicalDamage: i32,
    #[serde(default)]
    pub magicDamage: i32,
    #[serde(default)]
    pub trueDamage: i32,
}

impl VictimDamageDto {
    pub fn total(&self) -> i32 {
        self.physicalDamage + self.magicDamage + self.trueDamage
    }

    /// Si esta instancia de daño es atribuible a un jugador.
    pub fn from_player(&self) -> bool {
        self.participantId > 0
    }
}

/// Reparte el daño de un kill entre los jugadores que lo causaron, en unidades
/// de daño. Ignora esbirros y torres.
///
/// Es la respuesta a "¿quién hizo el trabajo?": el `killerId` sólo dice quién dio
/// el último golpe, y `assistingParticipantIds` no distingue entre quien hizo el
/// 80% del daño y quien pasó por ahí.
pub fn damage_shares(damage: &[VictimDamageDto]) -> std::collections::HashMap<i32, i32> {
    let mut by_player = std::collections::HashMap::new();
    for d in damage.iter().filter(|d| d.from_player()) {
        *by_player.entry(d.participantId).or_insert(0) += d.total();
    }
    by_player
}

#[derive(Deserialize, Debug, Clone)]
#[allow(non_snake_case)]
pub struct ParticipantDto {
    pub puuid: String,
    pub kills: i32,
    pub deaths: i32,
    pub assists: i32,
    pub goldEarned: i32,
    pub totalDamageDealtToChampions: i32,
    pub win: bool,
    #[serde(default)]
    pub championName: String,
    #[serde(default)]
    pub champLevel: i32,
    #[serde(default)]
    pub totalMinionsKilled: i32,
    #[serde(default)]
    pub neutralMinionsKilled: i32,
    #[serde(default)]
    pub teamId: i32,
    #[serde(default)]
    pub teamPosition: String,
    #[serde(default)]
    pub individualPosition: String,
    #[serde(default)]
    pub riotIdGameName: String,
    #[serde(default)]
    pub summonerName: String,
    #[serde(default)]
    pub item0: i32,
    #[serde(default)]
    pub item1: i32,
    #[serde(default)]
    pub item2: i32,
    #[serde(default)]
    pub item3: i32,
    #[serde(default)]
    pub item4: i32,
    #[serde(default)]
    pub item5: i32,
    #[serde(default)]
    pub item6: i32,
    #[serde(default)]
    pub visionScore: i32,
    #[serde(default)]
    pub wardsPlaced: i32,
    #[serde(default)]
    pub summoner1Id: i32,
    #[serde(default)]
    pub summoner2Id: i32,
    #[serde(default)]
    pub riotIdTagline: String,
    // --- Aguante, utilidad y objetivos: lo que un KDA no ve ---
    #[serde(default)]
    pub totalDamageTaken: i32,
    #[serde(default)]
    pub damageSelfMitigated: i32,
    #[serde(default)]
    pub totalHeal: i32,
    #[serde(default)]
    pub totalHealsOnTeammates: i32,
    #[serde(default)]
    pub totalDamageShieldedOnTeammates: i32,
    #[serde(default)]
    pub timeCCingOthers: i32,
    /// Segundos que pasaste muerto. El coste real de morir, no el contador de muertes.
    #[serde(default)]
    pub totalTimeSpentDead: i32,
    #[serde(default)]
    pub longestTimeSpentLiving: i32,
    #[serde(default)]
    pub damageDealtToObjectives: i32,
    #[serde(default)]
    pub damageDealtToTurrets: i32,
    #[serde(default)]
    pub turretTakedowns: i32,
    #[serde(default)]
    pub objectivesStolen: i32,
    #[serde(default)]
    pub firstBloodKill: bool,
    #[serde(default)]
    pub firstTowerKill: bool,
    #[serde(default)]
    pub gameEndedInSurrender: bool,
    #[serde(default)]
    pub teamEarlySurrendered: bool,
    // --- Contrajungla: quién comió en la jungla de quién ---
    #[serde(default)]
    pub totalAllyJungleMinionsKilled: i32,
    #[serde(default)]
    pub totalEnemyJungleMinionsKilled: i32,
    // --- Pings. Es lo más cerca que da la API de medir comunicación de macro:
    // un "MIA" o un "voy en camino" antes de una rotación son shotcalling. ---
    #[serde(default)]
    pub enemyMissingPings: i32,
    #[serde(default)]
    pub onMyWayPings: i32,
    #[serde(default)]
    pub dangerPings: i32,
    #[serde(default)]
    pub getBackPings: i32,
    #[serde(default)]
    pub pushPings: i32,
    #[serde(default)]
    pub holdPings: i32,
    #[serde(default)]
    pub allInPings: i32,
    #[serde(default)]
    pub assistMePings: i32,
    #[serde(default)]
    pub needVisionPings: i32,
    #[serde(default)]
    pub enemyVisionPings: i32,
    #[serde(default)]
    pub visionClearedPings: i32,
    #[serde(default)]
    pub baitPings: i32,
    #[serde(default)]
    pub commandPings: i32,
    #[serde(default)]
    pub basicPings: i32,
    /// El bloque `challenges` de Riot: ~150 métricas ya calculadas
    /// (`teamDamagePercentage`, `killParticipation`, `effectiveHealAndShielding`,
    /// `soloKills`, `hadAfkTeammate`…). Se guarda tal cual en vez de tipar campo a
    /// campo: Riot añade y quita métricas por parche, y así llegan solas.
    #[serde(default)]
    pub challenges: Option<serde_json::Value>,
}

impl ParticipantDto {
    /// Lee un número del bloque `challenges`. Devuelve `None` si el parche actual
    /// no trae esa métrica.
    pub fn challenge(&self, key: &str) -> Option<f64> {
        self.challenges.as_ref()?.get(key)?.as_f64()
    }
}

/// Tope a la espera que pide `Retry-After`: por encima de esto es mejor rendirse
/// y dejar que el que llamó decida (la caché parcial ya está guardada) que tener
/// un comando dormido minutos con la UI esperando.
const MAX_RETRY_AFTER_SECS: u64 = 30;
/// Reintentos ante un 429, además de la petición original.
const MAX_429_RETRIES: u32 = 3;

impl RiotApiClient {
    /// Cliente con la región que diga la configuración guardada.
    pub fn new(api_key: String) -> Self {
        Self::with_config(api_key, &crate::storage::load_config())
    }

    /// Igual, pero con una config ya cargada (que es lo que tienen en la mano
    /// casi todos los llamadores).
    pub fn with_config(api_key: String, cfg: &crate::storage::AppConfig) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| Client::new());
        // La fijada a mano manda; si está en "auto" vale la ya sondeada.
        let platform = platform_conocida(&cfg.riot_platform)
            .or_else(|| platform_conocida(&cfg.riot_platform_detected))
            .unwrap_or_default();
        Self {
            region: regional_route(&platform).to_string(),
            platform,
            proxy: cfg.riot_proxy_url.trim().trim_end_matches('/').to_string(),
            client,
            api_key,
        }
    }

    /// Fuerza la plataforma (y con ella la ruta regional). La usan quienes ya
    /// saben de dónde es la partida por el prefijo de su id.
    pub fn set_platform(&mut self, platform: &str) {
        if let Some(p) = platform_conocida(platform) {
            self.region = regional_route(&p).to_string();
            self.platform = p;
        }
    }

    /// La plataforma con la que trabaja ahora mismo (vacía si aún no se sabe).
    pub fn platform(&self) -> &str {
        &self.platform
    }

    /// URL final de una petición.
    ///
    /// Con proxy configurado se manda a `{proxy}/{host}/{ruta}` y sin cabecera
    /// de clave: el host viaja en la ruta para que el proxy sepa a qué región
    /// reenviar, y la clave la pone él. Ver `server/riot-proxy`.
    fn url(&self, host: &str, path: &str) -> String {
        let path = path.trim_start_matches('/');
        if self.proxy.is_empty() {
            format!("https://{}/{}", host, path)
        } else {
            format!("{}/{}/{}", self.proxy, host, path)
        }
    }

    /// Host regional (account-v1, match-v5).
    fn regional_host(&self) -> String {
        format!("{}.api.riotgames.com", self.region)
    }

    /// Host de plataforma (league-v4).
    fn platform_host(platform: &str) -> String {
        format!("{}.api.riotgames.com", platform)
    }

    /// GET listo para enviar: con la clave si vamos directos, sin ella si hay
    /// proxy (es el proxy quien la tiene).
    fn peticion(&self, url: &str) -> reqwest::RequestBuilder {
        let req = self.client.get(url);
        if self.proxy.is_empty() {
            req.header("X-Riot-Token", &self.api_key)
        } else {
            req
        }
    }

    /// GET con la clave puesta y reintentos ante el rate limit de Riot.
    ///
    /// Un 429 no es un error: es "espera y repite". Se respeta la cabecera
    /// `Retry-After` (con tope) y, si no viene, un backoff exponencial corto.
    /// Tras agotar los reintentos se devuelve la última respuesta tal cual,
    /// para que cada llamador siga informando del estado como hasta ahora.
    ///
    /// De paso vigila la clave: las de desarrollo caducan cada 24 h y el 403
    /// que llega entonces se traducía en "no hay partidas", que no dice nada.
    async fn get_with_retry(&self, url: &str) -> Result<reqwest::Response, String> {
        let mut intento: u32 = 0;
        loop {
            let resp = self
                .peticion(url)
                .send()
                .await
                .map_err(|e| format!("Error en petición HTTP: {}", e))?;
            avisa_del_estado_de_la_clave(resp.status().as_u16());
            if resp.status().as_u16() != 429 || intento >= MAX_429_RETRIES {
                return Ok(resp);
            }
            let espera = resp
                .headers()
                .get("Retry-After")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.trim().parse::<u64>().ok())
                .unwrap_or(1u64 << intento) // sin cabecera: 1 s, 2 s, 4 s
                .min(MAX_RETRY_AFTER_SECS)
                .max(1);
            log::info!("Riot 429 en {url}: reintento {} tras {espera}s", intento + 1);
            tokio::time::sleep(Duration::from_secs(espera)).await;
            intento += 1;
        }
    }

    /// Comprueba si la clave sirve, sin necesitar saber quién es el jugador.
    ///
    /// Pregunta a propósito por una cuenta que no existe: con clave válida Riot
    /// responde 404 (no la encuentro) y con clave inválida 401/403 (ni te
    /// contesto). Así vale para cualquier región sin pedirle nada al usuario.
    pub async fn check_key(&self) -> Result<(), String> {
        let url = self.url(
            &self.regional_host(),
            "riot/account/v1/accounts/by-riot-id/leaguerecorder-key-check/0000",
        );
        let resp = self
            .peticion(&url)
            .send()
            .await
            .map_err(|e| format!("No se pudo contactar con Riot: {}", e))?;
        let codigo = resp.status().as_u16();
        avisa_del_estado_de_la_clave(codigo);
        match codigo {
            401 => Err("La clave no es válida".to_string()),
            403 => Err("La clave ha caducado".to_string()),
            429 => Err("Riot está limitando las peticiones; inténtalo en un minuto".to_string()),
            _ => Ok(()),
        }
    }

    /// Deja el cliente apuntando a la región del jugador y devuelve su
    /// plataforma.
    ///
    /// Con una plataforma fijada (o ya sondeada antes) esto no cuesta ninguna
    /// petición. Con "auto" y sin nada guardado se prueba match-v5 en las
    /// cuatro rutas: la que devuelva partidas es la buena, y el prefijo de la
    /// primera dice la plataforma exacta ("EUW1_…" → euw1). Se guarda en la
    /// config para que el sondeo pase una sola vez en la vida.
    pub async fn resolve_platform(&mut self, puuid: &str) -> Option<String> {
        if !self.platform.is_empty() {
            return Some(self.platform.clone());
        }
        for ruta in ROUTES {
            self.region = ruta.to_string();
            let Ok(ids) = self.match_ids(puuid, 1, None).await else {
                continue;
            };
            let Some(plataforma) = ids.first().and_then(|id| platform_from_match_id(id)) else {
                continue;
            };
            self.set_platform(&plataforma);
            let mut cfg = crate::storage::load_config();
            if cfg.riot_platform_detected != plataforma {
                cfg.riot_platform_detected = plataforma.clone();
                if let Err(e) = crate::storage::save_config(&cfg) {
                    log::warn!("región: no se pudo recordar la plataforma detectada: {e}");
                }
            }
            log::info!("región: plataforma detectada {plataforma} (ruta {ruta})");
            return Some(plataforma);
        }
        // Ninguna ruta contestó con partidas: se deja como estaba para que el
        // error que dé la llamada real sea el de Riot y no una URL inventada.
        self.region = regional_route("").to_string();
        None
    }

    /// Tramo de rango de un jugador en clasificatoria solo/dúo.
    ///
    /// Se agrupa en tres y no en diez porque el baremo es (tramo x rol): con
    /// diez rangos harían falta 50 celdas con muestra suficiente.
    pub async fn tier_bucket(&self, plataforma: &str, puuid: &str) -> Option<String> {
        let (tier, _, _) = self.rango_solo(plataforma, puuid).await?;
        Self::tramo_de(&tier)
    }

    /// "MASTER" → "alto", etc. El baremo de WPA agrupa en tres tramos.
    ///
    /// Delega en [`crate::benchmarks::band_for_tier`], que es la copia de la
    /// tabla de `tools/corpus/fetch_tiers.py` con la que se etiquetó el corpus:
    /// tener aquí una segunda tabla escrita a mano era pedir que se separaran.
    ///
    /// Antes esto tenía un `_ => "alto"`: un rango desconocido (o vacío, o sin
    /// clasificar) se colaba en el tramo más alto y el jugador se comparaba
    /// contra Diamante+ sin que nada lo dijera. Ahora un rango que no está en la
    /// tabla devuelve `None`, que es "sin tramo": los baremos caen entonces al
    /// del puesto sobre el corpus entero, que es la comparación honesta.
    fn tramo_de(tier: &str) -> Option<String> {
        let tramo = crate::benchmarks::band_for_tier(tier);
        (!tramo.is_empty()).then(|| tramo.to_string())
    }

    /// La entrada de solo/dúo entera: (tier, división, LP). Pedida al
    /// sincronizar — justo tras la partida — para que la resta de LP entre
    /// partidas consecutivas sea lo que dio o quitó cada una.
    pub async fn rango_solo(
        &self,
        plataforma: &str,
        puuid: &str,
    ) -> Option<(String, String, i32)> {
        // league-v4 vive en el host de PLATAFORMA, no en el regional.
        let url = self.url(
            &Self::platform_host(&platform_conocida(plataforma)?),
            &format!("lol/league/v4/entries/by-puuid/{}", puuid),
        );
        let resp = self.get_with_retry(&url).await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let entradas: Vec<serde_json::Value> = resp.json().await.ok()?;
        let e = entradas.iter().find(|e| e["queueType"] == "RANKED_SOLO_5x5")?;
        Some((
            e.get("tier")?.as_str()?.to_string(),
            e.get("rank").and_then(|r| r.as_str()).unwrap_or("I").to_string(),
            e.get("leaguePoints").and_then(|l| l.as_i64()).unwrap_or(0) as i32,
        ))
    }

    /// Obtiene el PUUID del jugador usando su Riot ID (GameName y TagLine)
    pub async fn get_puuid_by_riot_id(
        &self,
        game_name: &str,
        tag_line: &str,
    ) -> Result<String, String> {
        let url = self.url(
            &self.regional_host(),
            &format!(
                "riot/account/v1/accounts/by-riot-id/{}/{}",
                urlencoding::encode(game_name),
                urlencoding::encode(tag_line)
            ),
        );

        let resp = self.get_with_retry(&url).await?;

        if !resp.status().is_success() {
            return Err(format!("Riot API Error (Account): {}", resp.status()));
        }

        let account: AccountDto = resp.json().await.map_err(|e| e.to_string())?;
        Ok(account.puuid)
    }

    /// Obtiene los últimos Match IDs de un PUUID
    pub async fn get_match_ids_by_puuid(
        &self,
        puuid: &str,
        count: i32,
    ) -> Result<Vec<String>, String> {
        self.match_ids(puuid, count, None).await
    }

    /// Como `get_match_ids_by_puuid` pero con filtro de cola (420 = solo/dúo).
    pub async fn match_ids(
        &self,
        puuid: &str,
        count: i32,
        queue: Option<i32>,
    ) -> Result<Vec<String>, String> {
        let cola = queue.map(|q| format!("&queue={}", q)).unwrap_or_default();
        let url = self.url(
            &self.regional_host(),
            &format!(
                "lol/match/v5/matches/by-puuid/{}/ids?start=0&count={}{}",
                puuid, count, cola
            ),
        );

        let resp = self.get_with_retry(&url).await?;

        if !resp.status().is_success() {
            return Err(format!("Riot API Error (MatchList): {}", resp.status()));
        }

        let match_ids: Vec<String> = resp.json().await.map_err(|e| e.to_string())?;
        Ok(match_ids)
    }

    /// Obtiene los detalles de un Match ID. Devuelve el JSON crudo para poder
    /// cachearlo (ver `details_for`).
    pub async fn get_match_details_raw(&self, match_id: &str) -> Result<String, String> {
        let url = self.url(
            &self.regional_host(),
            &format!("lol/match/v5/matches/{}", match_id),
        );

        let resp = self.get_with_retry(&url).await?;

        if !resp.status().is_success() {
            return Err(format!("Riot API Error (MatchDetails): {}", resp.status()));
        }

        resp.text().await.map_err(|e| e.to_string())
    }

    pub async fn get_match_details(&self, match_id: &str) -> Result<MatchDto, String> {
        let raw = self.get_match_details_raw(match_id).await?;
        serde_json::from_str(&raw).map_err(|e| e.to_string())
    }

    /// Obtiene la timeline de una partida (eventos minuto a minuto, incl. compras de items).
    /// Devuelve también el JSON crudo para poder cachearlo (ver `timeline_for`).
    pub async fn get_match_timeline_raw(&self, match_id: &str) -> Result<String, String> {
        let url = self.url(
            &self.regional_host(),
            &format!("lol/match/v5/matches/{}/timeline", match_id),
        );
        let resp = self.get_with_retry(&url).await?;
        if !resp.status().is_success() {
            return Err(format!("Riot API Error (Timeline): {}", resp.status()));
        }
        resp.text().await.map_err(|e| e.to_string())
    }

    pub async fn get_match_timeline(&self, match_id: &str) -> Result<TimelineDto, String> {
        let raw = self.get_match_timeline_raw(match_id).await?;
        serde_json::from_str(&raw).map_err(|e| e.to_string())
    }
}

/// Timeline de una partida, del disco si ya está cacheada y de la API si no.
/// `local_id` es el id de la grabación (la carpeta donde vive el caché);
/// `riot_match_id` el de Riot.
async fn timeline_for(
    api: &RiotApiClient,
    local_id: &str,
    riot_match_id: &str,
) -> Result<TimelineDto, String> {
    if let Some(raw) = crate::storage::load_raw_timeline(local_id) {
        if let Ok(dto) = serde_json::from_str::<TimelineDto>(&raw) {
            return Ok(dto);
        }
        // Caché corrupto o truncado: se vuelve a pedir y se sobrescribe.
    }
    let raw = api.get_match_timeline_raw(riot_match_id).await?;
    let dto: TimelineDto = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let _ = crate::storage::save_raw_timeline(local_id, &raw);
    Ok(dto)
}

/// Igual que `timeline_for` pero con el detalle de la partida.
async fn details_for(
    api: &RiotApiClient,
    local_id: &str,
    riot_match_id: &str,
) -> Result<MatchDto, String> {
    if let Some(raw) = crate::storage::load_raw_match(local_id) {
        if let Ok(dto) = serde_json::from_str::<MatchDto>(&raw) {
            return Ok(dto);
        }
    }
    let raw = api.get_match_details_raw(riot_match_id).await?;
    let dto: MatchDto = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let _ = crate::storage::save_raw_match(local_id, &raw);
    Ok(dto)
}

/// Reparto de crédito de una partida ya sincronizada, para los 10 jugadores.
///
/// Tira del caché en disco, así que después de la primera vez no gasta cuota:
/// se puede recalcular tantas veces como cambie el análisis.
pub async fn attribution_for(
    match_id: &str,
) -> Result<Vec<crate::attribution::PlayerCredit>, String> {
    let mut metadata = crate::storage::get_match_metadata(match_id)
        .map_err(|e| format!("Error cargando metadata: {}", e))?;
    let rid = metadata
        .riot_match_id
        .clone()
        .ok_or_else(|| "Esta partida aún no está sincronizada con Riot".to_string())?;

    let config = crate::storage::load_config();
    if sin_credencial(&config) {
        return Err("Configura tu Riot API Key en Ajustes".to_string());
    }
    // La región sale del propio id de partida: "EUW1_…" solo se puede pedir en
    // europe. Es más fiable que cualquier ajuste, así que no hace falta sondear.
    let mut api = RiotApiClient::with_config(config.riot_api_key.clone(), &config);
    if let Some(p) = platform_from_match_id(&rid) {
        api.set_platform(&p);
    }

    let details = details_for(&api, match_id, &rid).await?;
    let tl = timeline_for(&api, match_id, &rid).await?;
    Ok(impacto(&mut metadata, &tl, &details.info))
}

/// Reparto de crédito de los 10, con el puesto del jugador ya guardado.
///
/// Se comparte entre pedir el análisis y sincronizar: la sincronización ya tiene
/// en la mano el `details` y la `timeline` que esto necesita, así que calcularlo
/// allí sale gratis y **llena la columna de impacto de la biblioteca sin que
/// haya que entrar partida por partida**, que era lo que la dejaba en "—".
/// "16.13.688.1234" → "16.13". Vacío si Riot no lo mandó.
fn parche_de(game_version: &str) -> Option<String> {
    let corto: Vec<&str> = game_version.split('.').take(2).collect();
    (corto.len() == 2).then(|| corto.join("."))
}

fn impacto(
    metadata: &mut crate::storage::MatchMetadata,
    tl: &TimelineDto,
    info: &MatchInfo,
) -> Vec<crate::attribution::PlayerCredit> {
    let participants = &info.participants;
    let mut filas = crate::attribution::analyze(tl, participants);

    // Con el rango conocido, el percentil se compara contra el baremo de ese
    // nivel en vez del general. Si no se sabe, `percentil_en_tramo` cae solo al
    // baremo por rol.
    if let Some(tramo) = metadata.tier_bucket.as_deref() {
        for c in filas.iter_mut() {
            c.role_percentile = crate::baselines::percentil_en_tramo(tramo, &c.role, c.wpa);
        }
    }

    // Se persiste el puesto para que la lista de partidas pueda enseñarlo sin
    // recalcular: eso exigiría la timeline de cada partida, que es justo lo que
    // no se puede hacer al pintar una lista.
    if let Some(idx) = metadata.participants.iter().position(|p| p.is_self) {
        let yo = (idx + 1) as i32;
        let mut orden: Vec<&crate::attribution::PlayerCredit> = filas.iter().collect();
        orden.sort_by(|a, b| b.role_percentile.total_cmp(&a.role_percentile));
        if let Some(pos) = orden.iter().position(|c| c.participant_id == yo) {
            let nuevo_rank = Some(pos as i32 + 1);
            let nuevo_pct = orden.get(pos).map(|c| (c.role_percentile * 10.0).round() / 10.0);
            let nuevo_parche = parche_de(&info.gameVersion).or(metadata.patch.clone());
            // Los hechizos de invocador no existían cuando se guardaron las
            // partidas viejas; el DTO cacheado los trae, así que se reponen aquí.
            let mut spells_repuestos = false;
            if metadata.participants.len() == participants.len() {
                for (mp, dto) in metadata.participants.iter_mut().zip(participants.iter()) {
                    if mp.spells.is_empty() && (dto.summoner1Id != 0 || dto.summoner2Id != 0) {
                        mp.spells = vec![dto.summoner1Id, dto.summoner2Id];
                        spells_repuestos = true;
                    }
                    if mp.tag.is_empty() && !dto.riotIdTagline.is_empty() {
                        mp.tag = dto.riotIdTagline.clone();
                        spells_repuestos = true;
                    }
                    // El puesto tampoco existía en las partidas viejas; el DTO
                    // cacheado lo trae, así que se repone por el mismo camino.
                    let rol = rol_de(dto);
                    if mp.role.is_empty() && !rol.is_empty() {
                        mp.role = rol;
                        spells_repuestos = true;
                    }
                }
            }
            if metadata.impact_rank != nuevo_rank
                || metadata.impact_percentile != nuevo_pct
                || metadata.patch != nuevo_parche
                || spells_repuestos
            {
                metadata.impact_rank = nuevo_rank;
                metadata.impact_percentile = nuevo_pct;
                metadata.patch = nuevo_parche;
                let _ = crate::storage::save_match_metadata(metadata);
            }
        }
    }
    filas
}

/// Versión del barrido de impacto. Subirlo lo obliga a repasar la biblioteca.
pub const IMPACT_BACKFILL_V: u32 = 1;

/// Rellena el puesto de impacto de las partidas viejas, sin tocar la API.
///
/// La columna de impacto de la biblioteca sólo se llenaba al abrir la pestaña de
/// esa partida, así que quien tenía veinte partidas veía diecinueve rayas. Aquí
/// se calcula al arrancar, **sólo con lo que ya está en disco**: si a una
/// partida le falta el `riot_match.json` o el `riot_timeline.json`, se salta —
/// pedirlos gastaría cuota de la API sin que nadie lo haya pedido.
///
/// Va dentro de la tarea única de mantenimiento (`lib.rs`), la última de las
/// tres: es la más cara (dos JSON de varios megas por partida) y la menos
/// urgente. Cada partida repasada queda sellada con `impact_backfill_v`, así
/// que el segundo arranque no abre ni un fichero.
pub async fn impact_backfill(app: &tauri::AppHandle) {
    let pendientes: Vec<crate::storage::MatchMetadata> = crate::storage::load_all_matches()
        .into_iter()
        .filter(|m| !m.participants.is_empty() && m.impact_backfill_v < IMPACT_BACKFILL_V)
        .collect();

    let total = pendientes.len();
    crate::commands::emit_maintenance(app, "impact", 0, total);
    let mut hechas = 0;
    for (i, m) in pendientes.into_iter().enumerate() {
        crate::commands::emit_maintenance(app, "impact", i + 1, total);
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;

        let (Some(raw), Some(raw_tl)) = (
            crate::storage::load_raw_match(&m.id),
            crate::storage::load_raw_timeline(&m.id),
        ) else {
            continue;
        };
        let (Ok(details), Ok(tl)) = (
            serde_json::from_str::<MatchDto>(&raw),
            serde_json::from_str::<TimelineDto>(&raw_tl),
        ) else {
            continue;
        };
        // El sello va puesto ANTES para que viaje en el guardado que hace
        // `impacto` si algo cambia; si no cambió nada, `impacto` no guarda y el
        // sello se escribe aquí. Son una o dos escrituras la primera vez y
        // ninguna a partir de entonces, que es lo que se quería.
        let mut meta = m;
        meta.impact_backfill_v = IMPACT_BACKFILL_V;
        impacto(&mut meta, &tl, &details.info);
        let _ = crate::storage::save_match_metadata(&meta);
        hechas += 1;
    }
    if hechas > 0 {
        log::info!("impacto: puesto calculado para {hechas} partidas que no lo tenían");
    }

    // OJO: nada de returns tempranos por encima de esta línea que no sean
    // de verdad terminales — este estampado tiene que correr aunque el
    // impacto no tuviera nada pendiente (así se perdió la primera vez).
    // El rango con LP no existía cuando se guardaron las partidas viejas y
    // league-v4 solo da el actual: se estampa el de hoy una vez (una sola
    // llamada) para que la ficha tenga rango que enseñar, y la cuenta de LP
    // por partida arranca de aquí — el histórico anterior no se puede
    // recuperar de la API.
    let config = crate::storage::load_config();
    if sin_credencial(&config) {
        return;
    }
    let sin_rango: Vec<crate::storage::MatchMetadata> = crate::storage::load_all_matches()
        .into_iter()
        .filter(|m| m.rank_lp.is_none() && m.riot_match_id.is_some() && !m.participants.is_empty())
        .collect();
    if sin_rango.is_empty() {
        return;
    }
    // El puuid propio sale del DTO cacheado: mismo orden que los
    // participants guardados, así que el índice de is_self vale.
    let Some((puuid, plataforma)) = puuid_propio(&sin_rango) else {
        return;
    };
    let mut api = RiotApiClient::with_config(config.riot_api_key.clone(), &config);
    api.set_platform(&plataforma);
    // Antes esto era un `block_on` dentro de un `std::thread` suelto: bloquear
    // un hilo ajeno al runtime para esperar una petición HTTP es justo lo que
    // `async` existe para no hacer, y dependía de que hubiera un runtime que
    // prestar. Ahora la tarea entera es asíncrona y esto es un `await`.
    let Some((tier, division, lp)) = api.rango_solo(&plataforma, &puuid).await else {
        return;
    };
    let cuantas = sin_rango.len();
    for mut m in sin_rango {
        if m.tier_bucket.is_none() {
            m.tier_bucket = RiotApiClient::tramo_de(&tier);
        }
        m.rank_tier = Some(tier.clone());
        m.rank_division = Some(division.clone());
        m.rank_lp = Some(lp);
        let _ = crate::storage::save_match_metadata(&m);
    }
    log::info!("rango: {tier} {division} ({lp} LP) estampado en {cuantas} partidas sin rango");
}

/// Nota de rendimiento 0–100 de un jugador dentro de SU partida, estilo
/// AI-Score: cinco métricas (KDA, daño a campeones, cs/min, visión/min y
/// participación en kills), cada una convertida a rango entre los 10 del
/// lobby, ponderadas, y el compuesto vuelto percentil. Comparar dentro del
/// lobby la hace robusta a duración, parche y elo: ser el mejor de tu partida
/// vale lo mismo en Hierro que en Master.
fn nota_en_partida(yo_idx: usize, jugadores: &[ParticipantDto], dur_s: i64) -> f64 {
    if jugadores.len() < 2 || yo_idx >= jugadores.len() {
        return 50.0;
    }
    let min = (dur_s.max(60) as f64) / 60.0;
    let kills_de_equipo = |team: i32| -> i32 {
        jugadores.iter().filter(|p| p.teamId == team).map(|p| p.kills).sum()
    };
    // (métrica, peso): daño y KDA mandan, como en cualquier report card.
    let metricas: Vec<(Vec<f64>, f64)> = vec![
        (
            jugadores.iter().map(|p| (p.kills + p.assists) as f64 / p.deaths.max(1) as f64).collect(),
            0.25,
        ),
        (
            jugadores.iter().map(|p| p.totalDamageDealtToChampions as f64 / min).collect(),
            0.25,
        ),
        (
            jugadores.iter().map(|p| (p.totalMinionsKilled + p.neutralMinionsKilled) as f64 / min).collect(),
            0.15,
        ),
        (
            jugadores.iter().map(|p| p.visionScore as f64 / min).collect(),
            0.15,
        ),
        (
            jugadores
                .iter()
                .map(|p| (p.kills + p.assists) as f64 / kills_de_equipo(p.teamId).max(1) as f64)
                .collect(),
            0.20,
        ),
    ];
    let n = jugadores.len();
    // rango de cada jugador en cada métrica (0 = peor, n-1 = mejor)
    let compuesto: Vec<f64> = (0..n)
        .map(|j| {
            metricas
                .iter()
                .map(|(vals, peso)| {
                    let rango = vals.iter().filter(|&&v| v < vals[j]).count() as f64
                        + vals.iter().filter(|&&v| v == vals[j]).count() as f64 / 2.0
                        - 0.5;
                    peso * rango / (n - 1) as f64
                })
                .sum()
        })
        .collect();
    let mejores = compuesto.iter().filter(|&&c| c < compuesto[yo_idx]).count() as f64
        + compuesto.iter().filter(|&&c| c == compuesto[yo_idx]).count() as f64 / 2.0
        - 0.5;
    (mejores / (n - 1) as f64 * 100.0).clamp(0.0, 100.0)
}

/// El puuid del jugador y su plataforma ("la1"), sacados de cualquier partida
/// sincronizada con su DTO cacheado: los participants guardados van en el
/// mismo orden que los del DTO, así que el índice de is_self vale.
fn puuid_propio(partidas: &[crate::storage::MatchMetadata]) -> Option<(String, String)> {
    partidas.iter().find_map(|m| {
        let raw = crate::storage::load_raw_match(&m.id)?;
        let details = serde_json::from_str::<MatchDto>(&raw).ok()?;
        let idx = m.participants.iter().position(|p| p.is_self)?;
        let puuid = details.info.participants.get(idx)?.puuid.clone();
        let plataforma = platform_from_match_id(m.riot_match_id.as_deref()?)?;
        Some((puuid, plataforma))
    })
}

/// La forma reciente de la CUENTA: últimos ranked de la temporada (grabados o
/// no), rango actual y lo que suelen dar/quitar tus partidas según los deltas
/// de LP ya guardados. Todo lo que la predicción de rango necesita.
#[derive(serde::Serialize)]
pub struct SeasonForm {
    /// Recientes primero.
    pub games: Vec<crate::storage::SeasonGame>,
    pub tier: Option<String>,
    pub division: Option<String>,
    pub lp: Option<i32>,
    /// Media de LP que GANA una victoria, de tus deltas reales (None si aún
    /// no hay muestra: el frontend usa ±25 por defecto).
    pub avg_gain: Option<f64>,
    /// Media de LP que QUITA una derrota, en positivo.
    pub avg_loss: Option<f64>,
}

/// Clasifica un error de la API en un código estable (`código: detalle`) que el
/// frontend pueda distinguir sin parsear frases en castellano.
fn clasifica_error_riot(e: &str) -> String {
    if e.contains("429") {
        format!("rate_limited: {e}")
    } else if e.contains("401") || e.contains("403") {
        format!("key_invalid: {e}")
    } else {
        e.to_string()
    }
}

#[tauri::command]
pub async fn get_season_form() -> Result<SeasonForm, String> {
    let config = crate::storage::load_config();
    if sin_credencial(&config) {
        return Err("no_key: Configura tu Riot API Key en Ajustes".to_string());
    }
    let todas = crate::storage::load_all_matches();
    let Some((puuid, plataforma)) = puuid_propio(&todas) else {
        return Err("no_account: Sincroniza al menos una partida para saber tu cuenta".to_string());
    };

    let mut api = RiotApiClient::with_config(config.riot_api_key.clone(), &config);
    api.set_platform(&plataforma);
    let ids = api
        .match_ids(&puuid, 20, Some(420))
        .await
        .map_err(|e| clasifica_error_riot(&e))?;

    // Caché primero: cada detalle son ~200 KB de API que se resumen en 6
    // campos; repedirlos en cada apertura de Patrones quemaría la cuota.
    let mut cache = crate::storage::load_season_form_cache();
    let mut games: Vec<crate::storage::SeasonGame> = Vec::new();
    let mut nuevos = 0;
    for id in &ids {
        if let Some(g) = cache.iter().find(|g| &g.riot_match_id == id) {
            games.push(g.clone());
            continue;
        }
        let details = match api.get_match_details(id).await {
            Ok(d) => d,
            // Rate limit que sobrevivió a los reintentos: parar de insistir.
            // Lo ya bajado se cachea igual y la próxima apertura retoma aquí.
            Err(e) if e.contains("429") => {
                log::warn!(
                    "season form: rate limit persistente tras {} de {} detalles",
                    games.len(),
                    ids.len()
                );
                break;
            }
            Err(_) => continue, // red o partida rara: mejor 18 de 20 que un error total
        };
        let Some(yo_idx) = details.info.participants.iter().position(|p| p.puuid == puuid) else {
            continue;
        };
        let p = &details.info.participants[yo_idx];
        let g = crate::storage::SeasonGame {
            riot_match_id: id.clone(),
            win: p.win,
            champion: p.championName.clone(),
            kills: p.kills,
            deaths: p.deaths,
            assists: p.assists,
            game_end_ms: details.info.gameEndTimestamp,
            score: nota_en_partida(yo_idx, &details.info.participants, details.info.gameDuration),
        };
        cache.push(g.clone());
        games.push(g);
        nuevos += 1;
        // Ritmo suave: la cuota de desarrollo es 20 peticiones / segundo.
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
    }
    if nuevos > 0 {
        // La caché no crece sin límite: con 60 sobra para una ventana de 20.
        cache.sort_by_key(|g| -g.game_end_ms);
        cache.truncate(60);
        crate::storage::save_season_form_cache(&cache);
    }
    games.sort_by_key(|g| -g.game_end_ms);

    let rango = api.rango_solo(&plataforma, &puuid).await;

    // Lo que dan/quitan TUS partidas, medido: deltas de LP entre ranked
    // consecutivas del mismo rango y división (mismo criterio que la ficha).
    let mut con_lp: Vec<&crate::storage::MatchMetadata> =
        todas.iter().filter(|m| m.rank_lp.is_some()).collect();
    con_lp.sort_by(|a, b| a.date.cmp(&b.date));
    let (mut ganes, mut pierdes): (Vec<f64>, Vec<f64>) = (Vec::new(), Vec::new());
    for par in con_lp.windows(2) {
        if par[0].rank_tier == par[1].rank_tier && par[0].rank_division == par[1].rank_division {
            let d = (par[1].rank_lp.unwrap() - par[0].rank_lp.unwrap()) as f64;
            if d > 0.0 {
                ganes.push(d);
            } else if d < 0.0 {
                pierdes.push(-d);
            }
        }
    }
    let media = |xs: &[f64]| (!xs.is_empty()).then(|| xs.iter().sum::<f64>() / xs.len() as f64);

    Ok(SeasonForm {
        games,
        tier: rango.as_ref().map(|r| r.0.clone()),
        division: rango.as_ref().map(|r| r.1.clone()),
        lp: rango.as_ref().map(|r| r.2),
        avg_gain: media(&ganes),
        avg_loss: media(&pierdes),
    })
}

/// Lo que compró tu presencia, sumado entre partidas.
///
/// SOLO ficheros ya cacheados en disco: un agregado que se pinta al abrir una
/// pestaña no justifica gastar cuota de la API. Una partida sin caché
/// simplemente no cuenta (y `games` dice cuántas sí).
#[derive(serde::Serialize)]
pub struct PressureSummary {
    /// Partidas con datos que entraron en la suma.
    pub games: usize,
    /// Tramos tuyos en los que tu equipo sacó algo lejos de ti.
    pub windows: usize,
    /// Probabilidad de victoria total que tu equipo ganó lejos mientras te
    /// sujetaban (suma de `wpa_elsewhere`).
    pub wpa: f64,
    pub towers: i64,
    pub gold: f64,
}

/// Formato de `pressure_v1.json`. Subir el número invalida todas las cachés de
/// golpe, que es lo que hay que hacer cuando cambia el detector de presión: los
/// resúmenes viejos serían de un algoritmo que ya no existe.
const PRESSURE_CACHE_V: u32 = 1;

/// Lo que aporta UNA partida al resumen de presión, ya reducido.
///
/// Se guarda en la carpeta de la partida porque calcularlo cuesta parsear dos
/// JSON de varios megas y correr `pressure::detect` entero. El resumen de
/// Patrones lo hacía **en cada apertura y para cada partida de la biblioteca**:
/// con veinte partidas eso son ~80 MB de parseo por pulsación de pestaña, y la
/// cuenta sube con la biblioteca. Lo que se cachea son cinco números.
#[derive(serde::Serialize, serde::Deserialize)]
struct PressureCache {
    v: u32,
    /// Huella de las fuentes con las que se calculó. Ver `huella_de_fuentes`.
    stamp: u64,
    /// 1 si la partida tuvo algún tramo tuyo, 0 si no.
    games: usize,
    windows: usize,
    wpa: f64,
    towers: i64,
    gold: f64,
}

fn pressure_cache_path(id: &str) -> std::path::PathBuf {
    crate::storage::get_match_dir(id).join("pressure_v1.json")
}

/// Mezcla de las fechas de modificación de todo lo que entra en el cálculo.
///
/// Si a una partida le llega la timeline (o se reprocesa su vídeo y aparecen
/// las posiciones del minimapa), la huella cambia y la caché se rehace sola. Un
/// fichero que no existe cuenta como 0, así que "aún no hay minimapa" y "ya lo
/// hay" son huellas distintas.
fn huella_de_fuentes(id: &str) -> u64 {
    let dir = crate::storage::get_match_dir(id);
    let mtime = |p: std::path::PathBuf| -> u64 {
        std::fs::metadata(&p)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0)
    };
    let mut h: u64 = 1469598103934665603; // FNV-1a de 64 bits
    for p in [
        dir.join("riot_timeline.json"),
        dir.join("riot_match.json"),
        dir.join("minimap_positions.json"),
    ] {
        h ^= mtime(p);
        h = h.wrapping_mul(1099511628211);
    }
    h
}

/// El aporte de una partida al resumen, de la caché o recalculado y cacheado.
fn pressure_de_partida(m: &crate::storage::MatchMetadata) -> Option<PressureCache> {
    let stamp = huella_de_fuentes(&m.id);
    let ruta = pressure_cache_path(&m.id);
    if let Ok(c) = std::fs::read_to_string(&ruta) {
        if let Ok(c) = serde_json::from_str::<PressureCache>(&c) {
            if c.v == PRESSURE_CACHE_V && c.stamp == stamp {
                return Some(c);
            }
        }
    }

    let (raw, raw_tl) = (
        crate::storage::load_raw_match(&m.id)?,
        crate::storage::load_raw_timeline(&m.id)?,
    );
    let (Ok(details), Ok(tl)) = (
        serde_json::from_str::<MatchDto>(&raw),
        serde_json::from_str::<TimelineDto>(&raw_tl),
    ) else {
        return None;
    };
    let idx = m.participants.iter().position(|p| p.is_self)?;
    let yo = (idx + 1) as i32;

    let mut c = PressureCache {
        v: PRESSURE_CACHE_V,
        stamp,
        games: 0,
        windows: 0,
        wpa: 0.0,
        towers: 0,
        gold: 0.0,
    };
    for w in crate::pressure::detect(&tl, &details.info.participants)
        .iter()
        .filter(|w| w.participant_id == yo)
    {
        c.games = 1;
        c.windows += 1;
        c.wpa += w.wpa_elsewhere.max(0.0);
        c.towers += w.towers_elsewhere as i64;
        c.gold += w.gold_elsewhere;
    }
    if let Ok(s) = serde_json::to_string(&c) {
        let _ = std::fs::write(&ruta, s);
    }
    Some(c)
}

#[tauri::command]
pub async fn get_pressure_summary() -> PressureSummary {
    let mut sum = PressureSummary { games: 0, windows: 0, wpa: 0.0, towers: 0, gold: 0.0 };
    for m in crate::storage::load_all_matches() {
        if m.is_vod || m.riot_match_id.is_none() {
            continue;
        }
        let Some(c) = pressure_de_partida(&m) else { continue };
        sum.games += c.games;
        sum.windows += c.windows;
        sum.wpa += c.wpa;
        sum.towers += c.towers;
        sum.gold += c.gold;
    }
    sum
}

/// Tramos de presión absorbida de una partida ya sincronizada.
///
/// Los tiempos salen **en el eje del vídeo**, no en tiempo de partida, para que
/// la UI pueda saltar directamente al momento (igual que `timeline_markers`).
pub async fn pressure_for(
    match_id: &str,
) -> Result<Vec<crate::pressure::PressureWindow>, String> {
    let mut metadata = crate::storage::get_match_metadata(match_id)
        .map_err(|e| format!("Error cargando metadata: {}", e))?;
    let rid = metadata
        .riot_match_id
        .clone()
        .ok_or_else(|| "Esta partida aún no está sincronizada con Riot".to_string())?;

    let config = crate::storage::load_config();
    if sin_credencial(&config) {
        return Err("Configura tu Riot API Key en Ajustes".to_string());
    }
    let mut api = RiotApiClient::with_config(config.riot_api_key.clone(), &config);
    if let Some(p) = platform_from_match_id(&rid) {
        api.set_platform(&p);
    }
    let details = details_for(&api, match_id, &rid).await?;
    let tl = timeline_for(&api, match_id, &rid).await?;

    let offset = resolve_video_offset(&mut metadata, details.info.gameDuration);
    let mut windows = crate::pressure::detect(&tl, &details.info.participants);

    // Si el vídeo de esta partida ya se procesó, sus posiciones (dos por
    // segundo) afinan los límites de los tramos. Sin ellas la duración es una
    // cota inferior, porque entre fotogramas de minuto la API no dice nada.
    if let Some(pos) = crate::minimap::Positions::load(match_id) {
        crate::pressure::refinar_con_video(
            &mut windows,
            &pos,
            &tl,
            &details.info.participants,
        );
    }
    for w in windows.iter_mut() {
        w.start = (w.start + offset).max(0.0);
        w.end = (w.end + offset).max(0.0);
    }
    Ok(windows)
}

/// Extrae del `MatchInfo` los objetivos por equipo (para el panel Objectives).
fn objectives_from(info: &MatchInfo) -> Vec<crate::storage::TeamObjectives> {
    info.teams
        .iter()
        .map(|t| crate::storage::TeamObjectives {
            team_id: t.teamId,
            win: t.win,
            dragons: t.objectives.dragon.kills,
            barons: t.objectives.baron.kills,
            towers: t.objectives.tower.kills,
            heralds: t.objectives.riftHerald.kills,
            inhibitors: t.objectives.inhibitor.kills,
        })
        .collect()
}

pub struct FullTimelineAnalysis {
    pub item_purchases: Vec<crate::storage::ItemPurchase>,
    pub timeline_markers: Vec<crate::storage::TimelineMarker>,
    pub minute_frames: Vec<crate::storage::MinuteFrameDto>,
    pub gold_diff_15: Option<i32>,
    pub xp_diff_15: Option<i32>,
    pub jungle_cs_diff_15: Option<i32>,
    /// CS (súbditos + jungla) propio menos el del rival de línea a minuto 15.
    pub cs_diff_15: Option<i32>,
    pub gank_impact_15: Option<f64>,
    pub lane_result: Option<String>,
}

/// Segundos de vídeo previos al 0:00 de la partida, para colocar los datos de Riot
/// —que vienen en tiempo de partida— sobre la línea de tiempo del vídeo.
///
/// Las grabaciones nuevas lo traen medido en `video_offset`. Para las antiguas se estima
/// comparando la duración del vídeo con la duración real de la partida según Riot: la
/// diferencia es justo la pantalla de carga que quedó grabada al principio.
fn resolve_video_offset(metadata: &mut crate::storage::MatchMetadata, riot_game_duration: i64) -> f64 {
    if let Some(offset) = metadata.video_offset {
        return offset;
    }
    // `gameDuration` va en segundos desde el parche 11.20, en milisegundos en partidas
    // más antiguas (Riot lo cambió sin renombrar el campo).
    let riot_secs = if riot_game_duration > 20_000 {
        riot_game_duration as f64 / 1000.0
    } else {
        riot_game_duration as f64
    };
    let estimate = metadata.game_duration - riot_secs;
    let offset = if estimate.is_finite() && estimate.abs() <= 600.0 {
        estimate
    } else {
        0.0
    };
    metadata.video_offset = Some(offset);
    offset
}

/// Marcador corriente de la línea de tiempo. Los campos de gank (`lane`,
/// `outcome`, `confidence`…) sólo los rellenan los marcadores `gank_attempt`.
fn marker(
    time: f64,
    event_type: &str,
    description: &str,
    position_x: Option<i32>,
    position_y: Option<i32>,
) -> crate::storage::TimelineMarker {
    crate::storage::TimelineMarker {
        time,
        event_type: event_type.to_string(),
        description: description.to_string(),
        position_x,
        position_y,
        ..Default::default()
    }
}

/// El rival directo: el del MISMO puesto en el otro equipo.
///
/// Estaba escrito dentro de `process_timeline_full`, pero es el emparejamiento
/// del que dependen las tres métricas de minuto 15 (oro, XP y CS), y
/// `cs_diff_15_de` tiene que resolverlo igual para las partidas viejas: dos
/// copias del criterio acabarían dando dos rivales distintos.
///
/// Respaldo cuando el puesto no encaja (lobbies con roles repetidos, partidas
/// sin `teamPosition`): el del mismo hueco en el otro equipo.
fn rival_de_linea(participants: &[ParticipantDto], self_participant_id: i32) -> i32 {
    let self_participant = participants.get((self_participant_id - 1) as usize);
    let self_team_id = self_participant.map(|p| p.teamId).unwrap_or(100);
    let self_pos = self_participant.map(rol_de).unwrap_or_default();
    let is_jungle = self_pos == "JUNGLE"
        || self_participant
            .map(|p| p.neutralMinionsKilled > p.totalMinionsKilled)
            .unwrap_or(false);

    participants
        .iter()
        .enumerate()
        .find(|(_i, p)| {
            p.teamId != self_team_id
                && ((!self_pos.is_empty()
                    && (p.teamPosition == self_pos || p.individualPosition == self_pos))
                    || (is_jungle && p.neutralMinionsKilled > 20))
        })
        .map(|(i, _)| (i + 1) as i32)
        .unwrap_or_else(|| {
            if self_participant_id <= 5 {
                self_participant_id + 5
            } else {
                self_participant_id - 5
            }
        })
}

/// El fotograma de minuto 15, con el mismo criterio en toda la casa: la ventana
/// de 870.000–930.000 ms, y si la timeline no llega hasta ahí, el que haya.
fn frame_15(tl: &TimelineDto) -> Option<&TimelineFrame> {
    tl.info
        .frames
        .iter()
        .find(|f| f.timestamp >= 870_000 && f.timestamp <= 930_000)
        .or_else(|| tl.info.frames.get(15))
        .or_else(|| tl.info.frames.last())
}

/// CS propio menos el del rival de línea en el fotograma de minuto 15.
///
/// Es la única de las tres métricas de minuto 15 que no se guardaba: el
/// metadata tenía `jungle_cs_diff_15`, que es sólo la parte de jungla, y
/// `MinuteFrameDto` no lleva súbditos. El baremo de `crate::benchmarks` mide
/// `minionsKilled + jungleMinionsKilled`, que es lo que se calcula aquí.
///
/// Público porque las partidas sincronizadas antes de existir el campo lo
/// rellenan a posteriori desde su timeline cacheada.
pub fn cs_diff_15_de(
    tl: &TimelineDto,
    self_participant_id: i32,
    participants: &[ParticipantDto],
) -> Option<i32> {
    let opp = rival_de_linea(participants, self_participant_id);
    let frame = frame_15(tl)?;
    let mio = frame.participantFrames.get(&self_participant_id.to_string())?;
    let suyo = frame.participantFrames.get(&opp.to_string())?;
    Some(
        (mio.minionsKilled + mio.jungleMinionsKilled)
            - (suyo.minionsKilled + suyo.jungleMinionsKilled),
    )
}

/// Procesa la timeline completa de Riot (v5) para extraer compras de items,
/// marcadores de eventos (Kills, Dragones, Torres) y métricas de línea/jungla a min 15.
///
/// `video_offset` desplaza los tiempos resultantes al eje del vídeo (ver
/// `MatchMetadata::video_offset`); el análisis interno se hace en tiempo de partida.
fn process_timeline_full(
    tl: &TimelineDto,
    self_participant_id: i32,
    participants: &[ParticipantDto],
    video_offset: f64,
) -> FullTimelineAnalysis {
    let mut item_purchases = Vec::new();
    let mut timeline_markers = Vec::new();

    let self_participant = participants.get((self_participant_id - 1) as usize);

    let self_team_id = self_participant.map(|p| p.teamId).unwrap_or(100);
    let self_pos = self_participant
        .map(|p| {
            if !p.teamPosition.is_empty() {
                p.teamPosition.clone()
            } else {
                p.individualPosition.clone()
            }
        })
        .unwrap_or_default();

    let is_jungle = self_pos == "JUNGLE"
        || self_participant
            .map(|p| p.neutralMinionsKilled > p.totalMinionsKilled)
            .unwrap_or(false);

    let opp_participant_id = rival_de_linea(participants, self_participant_id);

    let mut kills_at_15 = 0;
    let mut assists_at_15 = 0;
    let mut total_team_kills_at_15 = 0;

    for frame in &tl.info.frames {
        for ev in &frame.events {
            let sec = ev.timestamp as f64 / 1000.0;
            if sec <= 900.0 && ev.event_type == "CHAMPION_KILL" {
                let killer_team = participants
                    .get((ev.killerId - 1) as usize)
                    .map(|p| p.teamId)
                    .unwrap_or(0);
                if killer_team == self_team_id {
                    total_team_kills_at_15 += 1;
                }
                if ev.killerId == self_participant_id {
                    kills_at_15 += 1;
                } else if ev.assistingParticipantIds.contains(&self_participant_id) {
                    assists_at_15 += 1;
                }
            }

            match ev.event_type.as_str() {
                "ITEM_PURCHASED" => {
                    if ev.participantId == self_participant_id && ev.itemId > 0 {
                        item_purchases.push(crate::storage::ItemPurchase {
                            time: sec,
                            item_id: ev.itemId,
                        });
                    }
                }
                "CHAMPION_KILL" => {
                    let pos_x = ev.position.as_ref().map(|p| p.x);
                    let pos_y = ev.position.as_ref().map(|p| p.y);
                    if ev.killerId == self_participant_id {
                        timeline_markers.push(marker(sec, "kill", "Asesinato", pos_x, pos_y));
                    } else if ev.victimId == self_participant_id {
                        timeline_markers.push(marker(sec, "death", "Muerte", pos_x, pos_y));
                    } else if ev.assistingParticipantIds.contains(&self_participant_id) {
                        timeline_markers.push(marker(sec, "assist", "Asistencia", pos_x, pos_y));
                    }
                }
                "ELITE_MONSTER_KILL" => {
                    if ev.killerId == self_participant_id
                        || ev.assistingParticipantIds.contains(&self_participant_id)
                    {
                        let pos_x = ev.position.as_ref().map(|p| p.x);
                        let pos_y = ev.position.as_ref().map(|p| p.y);
                        let mtype = ev.monsterType.as_deref().unwrap_or("Objetivo");
                        let (etype, desc) = match mtype {
                            "DRAGON" => ("dragon", "Dragón abatido"),
                            "RIFTHERALD" | "HERALD" => ("herald", "Heraldo del Vacío"),
                            "BARON_NASHOR" => ("herald", "Barón Nashor"),
                            _ => ("dragon", "Objetivo épico"),
                        };
                        timeline_markers.push(marker(sec, etype, desc, pos_x, pos_y));
                    }
                }
                "BUILDING_KILL" => {
                    if ev.killerId == self_participant_id
                        || ev.assistingParticipantIds.contains(&self_participant_id)
                    {
                        let pos_x = ev.position.as_ref().map(|p| p.x);
                        let pos_y = ev.position.as_ref().map(|p| p.y);
                        let btype = ev.buildingType.as_deref().unwrap_or("");
                        let (etype, desc) = if btype == "TOWER_BUILDING" {
                            ("tower", "Torre destruida")
                        } else {
                            ("plate", "Estructura abatida")
                        };
                        timeline_markers.push(marker(sec, etype, desc, pos_x, pos_y));
                    }
                }
                "TURRET_PLATE_DESTROYED" => {
                    if ev.killerId == self_participant_id {
                        let pos_x = ev.position.as_ref().map(|p| p.x);
                        let pos_y = ev.position.as_ref().map(|p| p.y);
                        timeline_markers.push(marker(
                            sec,
                            "plate",
                            "Placa de torre obtenida",
                            pos_x,
                            pos_y,
                        ));
                    }
                }
                _ => {}
            }
        }
    }

    // Detección de ganks: carril por geometría real, rival de esa línea exigido
    // y el instante interpolado en vez de redondeado al minuto. Ver `crate::gank`.
    for g in crate::gank::detect(tl, self_participant_id, participants) {
        let description = match g.outcome {
            crate::gank::Outcome::Success => format!("Gank efectivo en {}", g.lane.label()),
            crate::gank::Outcome::Failed => format!("Gank fallido en {} (muerte)", g.lane.label()),
            crate::gank::Outcome::Neutral => {
                format!("Presencia sin resultado en {}", g.lane.label())
            }
        };
        timeline_markers.push(crate::storage::TimelineMarker {
            time: g.time,
            event_type: "gank_attempt".to_string(),
            description,
            position_x: Some(g.x),
            position_y: Some(g.y),
            lane: Some(g.lane.key().to_string()),
            outcome: Some(g.outcome.key().to_string()),
            confidence: Some((g.confidence * 100.0).round() / 100.0),
            time_precision: Some(g.precision),
            approach: g.approach.map(|a| a.key().to_string()),
        });
    }

    // Construcción de la serie minuto a minuto para la gráfica de oro/XP
    let mut minute_frames = Vec::new();
    let self_pid_str = self_participant_id.to_string();
    let opp_pid_str = opp_participant_id.to_string();

    for (minute, frame) in tl.info.frames.iter().enumerate() {
        let self_pf = frame.participantFrames.get(&self_pid_str);
        let opp_pf = frame.participantFrames.get(&opp_pid_str);

        let mut t100_gold = 0;
        let mut t200_gold = 0;
        for (i, p_dto) in participants.iter().enumerate() {
            let pid_key = (i + 1).to_string();
            if let Some(pf) = frame.participantFrames.get(&pid_key) {
                if p_dto.teamId == 100 {
                    t100_gold += pf.totalGold;
                } else {
                    t200_gold += pf.totalGold;
                }
            }
        }
        let team_gold_diff = if self_team_id == 100 {
            t100_gold - t200_gold
        } else {
            t200_gold - t100_gold
        };

        if let (Some(spf), Some(opf)) = (self_pf, opp_pf) {
            minute_frames.push(crate::storage::MinuteFrameDto {
                minute: minute as i32,
                team_gold_diff,
                self_gold_diff: spf.totalGold - opf.totalGold,
                self_xp_diff: spf.xp - opf.xp,
                self_jungle_cs_diff: spf.jungleMinionsKilled - opf.jungleMinionsKilled,
            });
        }
    }

    // Análisis del frame a minuto 15
    let (gold_diff_15, xp_diff_15, jungle_cs_diff_15, cs_diff_15) =
        if let Some(frame) = frame_15(tl) {
            let self_pf = frame.participantFrames.get(&self_pid_str);
            let opp_pf = frame.participantFrames.get(&opp_pid_str);

            if let (Some(spf), Some(opf)) = (self_pf, opp_pf) {
                let gdiff = spf.totalGold - opf.totalGold;
                let xdiff = spf.xp - opf.xp;
                let jcdiff = spf.jungleMinionsKilled - opf.jungleMinionsKilled;
                // Súbditos + jungla, que es lo que mide el baremo de población
                // (`crate::benchmarks`); `jungle_cs_diff_15` sólo cuenta la jungla.
                let csdiff = (spf.minionsKilled + spf.jungleMinionsKilled)
                    - (opf.minionsKilled + opf.jungleMinionsKilled);
                (Some(gdiff), Some(xdiff), Some(jcdiff), Some(csdiff))
            } else {
                (None, None, None, None)
            }
        } else {
            (None, None, None, None)
        };

    let gank_impact_15 = if is_jungle && total_team_kills_at_15 > 0 {
        let impact = ((kills_at_15 + assists_at_15) as f64 / total_team_kills_at_15 as f64) * 100.0;
        Some((impact * 10.0).round() / 10.0)
    } else {
        None
    };

    let lane_result = gold_diff_15.map(|g| {
        if g >= 300 {
            "Win".to_string()
        } else if g <= -300 {
            "Loss".to_string()
        } else {
            "Even".to_string()
        }
    });

    // Último paso, ya con todo calculado en tiempo de partida: al eje del vídeo.
    for ip in item_purchases.iter_mut() {
        ip.time = (ip.time + video_offset).max(0.0);
    }
    for mk in timeline_markers.iter_mut() {
        mk.time = (mk.time + video_offset).max(0.0);
    }

    FullTimelineAnalysis {
        item_purchases,
        timeline_markers,
        minute_frames,
        gold_diff_15,
        xp_diff_15,
        jungle_cs_diff_15,
        cs_diff_15,
        gank_impact_15,
        lane_result,
    }
}

/// Convierte un participante de la API de Riot a nuestro modelo del scoreboard.
fn to_participant(p: &ParticipantDto, is_self: bool) -> crate::storage::Participant {
    crate::storage::Participant {
        champion: p.championName.clone(),
        name: if !p.riotIdGameName.is_empty() {
            p.riotIdGameName.clone()
        } else {
            p.summonerName.clone()
        },
        team_id: p.teamId,
        win: p.win,
        level: p.champLevel,
        kills: p.kills,
        deaths: p.deaths,
        assists: p.assists,
        cs: p.totalMinionsKilled + p.neutralMinionsKilled,
        gold: p.goldEarned,
        is_self,
        items: vec![
            p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6,
        ],
        spells: vec![p.summoner1Id, p.summoner2Id],
        tag: p.riotIdTagline.clone(),
        damage: p.totalDamageDealtToChampions,
        vision_score: p.visionScore,
        wards_placed: p.wardsPlaced,
        role: rol_de(p),
    }
}

/// El puesto de un jugador, con el mismo criterio que el resto del análisis:
/// `teamPosition` manda y `individualPosition` es el respaldo (ver baselines.rs).
fn rol_de(p: &ParticipantDto) -> String {
    if !p.teamPosition.is_empty() {
        p.teamPosition.clone()
    } else {
        p.individualPosition.clone()
    }
}

/// Rellena los `participants` de una partida YA sincronizada (riot_match_id conocido), usando ese ID
/// directamente (sin necesidad del riot id del jugador). Marca is_self por campeón. Para backfill de
/// partidas antiguas que se sincronizaron antes de existir el scoreboard.
pub async fn backfill_participants(
    match_id: &str,
) -> Result<crate::storage::MatchMetadata, String> {
    let config = crate::storage::load_config();
    if sin_credencial(&config) {
        return Err("Configura tu Riot API Key en Ajustes".to_string());
    }
    let mut metadata = crate::storage::get_match_metadata(match_id)
        .map_err(|e| format!("Error cargando metadata: {}", e))?;
    if !metadata.participants.is_empty() && !metadata.minute_frames.is_empty() {
        return Ok(metadata);
    }
    let rid = metadata.riot_match_id.clone().ok_or_else(|| {
        "Esta partida aún no está sincronizada con Riot (graba una nueva o espera la sincronización automática de ~60s tras la partida)".to_string()
    })?;
    // Igual que en `attribution_for`: la región la dicta el id de la partida.
    let mut api = RiotApiClient::with_config(config.riot_api_key.clone(), &config);
    if let Some(p) = platform_from_match_id(&rid) {
        api.set_platform(&p);
    }
    let details = details_for(&api, match_id, &rid).await?;
    let self_idx = details
        .info
        .participants
        .iter()
        .position(|p| p.championName == metadata.champion);
    metadata.participants = details
        .info
        .participants
        .iter()
        .enumerate()
        .map(|(i, p)| to_participant(p, Some(i) == self_idx))
        .collect();
    metadata.objectives = objectives_from(&details.info);
    metadata.queue = Some(details.info.queueId);
    if let Some(idx) = self_idx {
        if let Ok(tl) = timeline_for(&api, match_id, &rid).await {
            let video_offset = resolve_video_offset(&mut metadata, details.info.gameDuration);
            let analysis = process_timeline_full(&tl, (idx as i32) + 1, &details.info.participants, video_offset);
            metadata.item_purchases = analysis.item_purchases;
            metadata.timeline_markers = analysis.timeline_markers;
            metadata.minute_frames = analysis.minute_frames;
            metadata.gold_diff_15 = analysis.gold_diff_15;
            metadata.xp_diff_15 = analysis.xp_diff_15;
            metadata.jungle_cs_diff_15 = analysis.jungle_cs_diff_15;
            metadata.cs_diff_15 = analysis.cs_diff_15;
            metadata.gank_impact_15 = analysis.gank_impact_15;
            metadata.lane_result = analysis.lane_result;
            impacto(&mut metadata, &tl, &details.info);
        }
    }
    let _ = crate::storage::save_match_metadata(&metadata);
    Ok(metadata)
}

pub async fn sync_riot_data(
    match_id: &str,
    active_player: &str,
) -> Result<crate::storage::MatchMetadata, String> {
    let config = crate::storage::load_config();
    if sin_credencial(&config) {
        return Err("No Riot API Key configured".to_string());
    }

    let mut metadata = crate::storage::get_match_metadata(match_id)
        .map_err(|e| format!("Error loading metadata: {}", e))?;

    if metadata.riot_match_id.is_some() {
        return Ok(metadata); // Ya está sincronizado
    }

    // El Riot ID SIEMPRE trae etiqueta. Antes, si faltaba, se inventaba "LAN":
    // fuera de Latinoamérica eso resolvía a otra cuenta o a ninguna, y el error
    // que llegaba era "no recent matches", que no señala el problema.
    let parts: Vec<&str> = active_player.split('#').collect();
    let game_name = parts[0];
    let Some(tag_line) = parts.get(1).map(|t| t.trim()).filter(|t| !t.is_empty()) else {
        return Err(format!(
            "no_tag: el Riot ID «{active_player}» no trae etiqueta (#EUW, #LAN…)"
        ));
    };

    let mut api = RiotApiClient::with_config(config.riot_api_key.clone(), &config);

    // account-v1 contesta desde cualquier ruta regional, así que el puuid se
    // consigue antes de saber la región.
    let puuid = api.get_puuid_by_riot_id(game_name, tag_line).await?;
    // Y con el puuid ya se puede averiguar dónde juega (una vez en la vida).
    api.resolve_platform(&puuid).await;

    let recent_matches = api.get_match_ids_by_puuid(&puuid, 5).await?;

    if recent_matches.is_empty() {
        return Err("No recent matches found".to_string());
    }

    let mut found_match = None;
    for r_match_id in recent_matches {
        // Se pide en crudo para poder cachear la que resulte ser la nuestra: el
        // análisis de atribución necesita el DTO completo, no el recorte que va
        // al metadata.
        let Ok(raw) = api.get_match_details_raw(&r_match_id).await else {
            continue;
        };
        let Ok(details) = serde_json::from_str::<MatchDto>(&raw) else {
            continue;
        };
        let duration_diff = (details.info.gameDuration as f64 - metadata.game_duration).abs();
        if duration_diff <= 180.0 {
            if let Some(participant) = details.info.participants.iter().find(|p| p.puuid == puuid) {
                found_match = Some((r_match_id, participant.clone(), details.info.clone(), raw));
                break;
            }
        }
    }

    if let Some((riot_id, participant, info, raw)) = found_match {
        let _ = crate::storage::save_raw_match(match_id, &raw);
        // El rango se pide aquí y se guarda: después puede cambiar, y lo que
        // vale para comparar es el que tenías al jugar esta partida.
        if metadata.tier_bucket.is_none() || metadata.rank_lp.is_none() {
            // La plataforma sale del id de la partida ("EUW1_…"); si el prefijo
            // no se reconoce se usa la ya resuelta, y si no hay, no se pide el
            // rango: mejor sin rango que pidiéndoselo a la región equivocada.
            let plataforma = platform_from_match_id(&riot_id)
                .unwrap_or_else(|| api.platform().to_string());
            if let Some((tier, division, lp)) = api.rango_solo(&plataforma, &puuid).await {
                metadata.tier_bucket = RiotApiClient::tramo_de(&tier);
                metadata.rank_tier = Some(tier);
                metadata.rank_division = Some(division);
                metadata.rank_lp = Some(lp);
            }
        }
        metadata.riot_match_id = Some(riot_id.clone());
        metadata.kda = Some(format!(
            "{}/{}/{}",
            participant.kills, participant.deaths, participant.assists
        ));
        metadata.gold_earned = Some(participant.goldEarned);
        metadata.damage_dealt = Some(participant.totalDamageDealtToChampions);
        metadata.participants = info
            .participants
            .iter()
            .map(|p| to_participant(p, p.puuid == puuid))
            .collect();
        metadata.objectives = objectives_from(&info);
        metadata.queue = Some(info.queueId);
        if let Some(idx) = info.participants.iter().position(|p| p.puuid == puuid) {
            if let Ok(tl) = timeline_for(&api, match_id, &riot_id).await {
                let video_offset = resolve_video_offset(&mut metadata, info.gameDuration);
                let analysis = process_timeline_full(&tl, (idx as i32) + 1, &info.participants, video_offset);
                metadata.item_purchases = analysis.item_purchases;
                metadata.timeline_markers = analysis.timeline_markers;
                metadata.minute_frames = analysis.minute_frames;
                metadata.gold_diff_15 = analysis.gold_diff_15;
                metadata.xp_diff_15 = analysis.xp_diff_15;
                metadata.jungle_cs_diff_15 = analysis.jungle_cs_diff_15;
                metadata.cs_diff_15 = analysis.cs_diff_15;
                metadata.gank_impact_15 = analysis.gank_impact_15;
                metadata.lane_result = analysis.lane_result;
                impacto(&mut metadata, &tl, &info);
            }
        }

        metadata.result = if participant.win {
            "Victory".to_string()
        } else {
            "Defeat".to_string()
        };

        let _ = crate::storage::save_match_metadata(&metadata);
    }

    Ok(metadata)
}

#[cfg(test)]
mod tests_nota {
    use super::*;

    fn jugador(k: i32, d: i32, a: i32, dmg: i32, cs: i32, vis: i32, team: i32) -> ParticipantDto {
        let mut p: ParticipantDto = serde_json::from_str("{\"puuid\":\"x\",\"kills\":0,\"deaths\":0,\"assists\":0,\"goldEarned\":0,\"totalDamageDealtToChampions\":0,\"win\":false}").unwrap();
        p.kills = k;
        p.deaths = d;
        p.assists = a;
        p.totalDamageDealtToChampions = dmg;
        p.totalMinionsKilled = cs;
        p.visionScore = vis;
        p.teamId = team;
        p
    }

    #[test]
    fn el_mejor_del_lobby_roza_cien_y_el_peor_cero() {
        // Diez jugadores en escalera: el i-ésimo es mejor que el anterior en todo.
        let lobby: Vec<ParticipantDto> = (0..10)
            .map(|i| jugador(i, 10 - i, i, i * 3000, i * 40, i * 5, if i < 5 { 100 } else { 200 }))
            .collect();
        let peor = nota_en_partida(0, &lobby, 1800);
        let mejor = nota_en_partida(9, &lobby, 1800);
        assert!(peor < 15.0, "el peor del lobby: {peor}");
        assert!(mejor > 85.0, "el mejor del lobby: {mejor}");
        assert!(nota_en_partida(5, &lobby, 1800) > peor);
    }

    #[test]
    fn el_rol_prefiere_team_position_y_cae_a_individual() {
        let mut p: ParticipantDto = serde_json::from_str("{\"puuid\":\"x\",\"kills\":0,\"deaths\":0,\"assists\":0,\"goldEarned\":0,\"totalDamageDealtToChampions\":0,\"win\":false}").unwrap();
        p.teamPosition = "JUNGLE".to_string();
        p.individualPosition = "TOP".to_string();
        assert_eq!(rol_de(&p), "JUNGLE");
        p.teamPosition.clear();
        assert_eq!(rol_de(&p), "TOP");
        p.individualPosition.clear();
        assert_eq!(rol_de(&p), "");
        // Y llega al Participant que se persiste.
        p.teamPosition = "UTILITY".to_string();
        assert_eq!(to_participant(&p, true).role, "UTILITY");
    }

    #[test]
    fn los_errores_de_riot_se_clasifican_con_codigo_estable() {
        assert!(clasifica_error_riot("Riot API Error (MatchList): 429 Too Many Requests")
            .starts_with("rate_limited:"));
        assert!(clasifica_error_riot("Riot API Error (MatchList): 403 Forbidden")
            .starts_with("key_invalid:"));
        let otro = clasifica_error_riot("Error en petición HTTP: timeout");
        assert_eq!(otro, "Error en petición HTTP: timeout");
    }

    #[test]
    fn cada_plataforma_cae_en_su_ruta_regional() {
        for p in ["la1", "la2", "na1", "br1"] {
            assert_eq!(regional_route(p), "americas", "{p}");
        }
        for p in ["euw1", "eun1", "tr1", "ru", "me1"] {
            assert_eq!(regional_route(p), "europe", "{p}");
        }
        for p in ["kr", "jp1"] {
            assert_eq!(regional_route(p), "asia", "{p}");
        }
        for p in ["oc1", "ph2", "sg2", "th2", "tw2", "vn2"] {
            assert_eq!(regional_route(p), "sea", "{p}");
        }
        // Mayúsculas y espacios, que es como llegan del prefijo de un id.
        assert_eq!(regional_route(" EUW1 "), "europe");
        // Las 17 plataformas de la lista tienen ruta y ninguna se quedó fuera.
        assert_eq!(PLATFORMS.len(), 17);
        for p in PLATFORMS {
            assert!(ROUTES.contains(&regional_route(p)), "{p} sin ruta");
        }
        // Desconocida: ruta válida, no una URL rota.
        assert_eq!(regional_route("pbe1"), "americas");
    }

    #[test]
    fn la_plataforma_sale_del_prefijo_del_id_de_partida() {
        assert_eq!(platform_from_match_id("EUW1_7412345678").as_deref(), Some("euw1"));
        assert_eq!(platform_from_match_id("la1_1234").as_deref(), Some("la1"));
        assert_eq!(platform_from_match_id("KR_98765").as_deref(), Some("kr"));
        // Prefijo que no es una plataforma, o id sin prefijo: nada.
        assert_eq!(platform_from_match_id("PBE1_1"), None);
        assert_eq!(platform_from_match_id("1234"), None);
        assert_eq!(platform_from_match_id(""), None);
        // Y lo mismo para lo que llega de la config.
        assert_eq!(platform_conocida("auto"), None);
        assert_eq!(platform_conocida(""), None);
        assert_eq!(platform_conocida("EUW1").as_deref(), Some("euw1"));
    }

    #[test]
    fn lobby_identico_da_cincuenta_a_todos() {
        let lobby: Vec<ParticipantDto> = (0..10)
            .map(|i| jugador(5, 5, 5, 15000, 200, 20, if i < 5 { 100 } else { 200 }))
            .collect();
        for i in 0..10 {
            let n = nota_en_partida(i, &lobby, 1800);
            assert!((n - 50.0).abs() < 1.0, "jugador {i}: {n}");
        }
    }
}
