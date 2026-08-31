use reqwest::Client;
use serde::Deserialize;
use std::time::Duration;

pub struct RiotApiClient {
    client: Client,
    api_key: String,
    region: String, // e.g. "americas"
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

impl RiotApiClient {
    pub fn new(api_key: String) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| Client::new());
        Self {
            client,
            api_key,
            region: "americas".to_string(), // Para LAN (LA1) se usa "americas" en Account y Match V5
        }
    }

    /// Comprueba si la clave sirve, sin necesitar saber quién es el jugador.
    ///
    /// Pregunta a propósito por una cuenta que no existe: con clave válida Riot
    /// responde 404 (no la encuentro) y con clave inválida 401/403 (ni te
    /// contesto). Así vale para cualquier región sin pedirle nada al usuario.
    pub async fn check_key(&self) -> Result<(), String> {
        let url = format!(
            "https://{}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/{}/{}",
            self.region, "leaguerecorder-key-check", "0000"
        );
        let resp = self
            .client
            .get(&url)
            .header("X-Riot-Token", &self.api_key)
            .send()
            .await
            .map_err(|e| format!("No se pudo contactar con Riot: {}", e))?;
        match resp.status().as_u16() {
            401 | 403 => Err("La clave no es válida o ha caducado".to_string()),
            429 => Err("Riot está limitando las peticiones; inténtalo en un minuto".to_string()),
            _ => Ok(()),
        }
    }

    /// Tramo de rango de un jugador en clasificatoria solo/dúo.
    ///
    /// Se agrupa en tres y no en diez porque el baremo es (tramo x rol): con
    /// diez rangos harían falta 50 celdas con muestra suficiente.
    pub async fn tier_bucket(&self, plataforma: &str, puuid: &str) -> Option<String> {
        let url = format!(
            "https://{}.api.riotgames.com/lol/league/v4/entries/by-puuid/{}",
            plataforma, puuid
        );
        let resp = self
            .client
            .get(&url)
            .header("X-Riot-Token", &self.api_key)
            .send()
            .await
            .ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let entradas: Vec<serde_json::Value> = resp.json().await.ok()?;
        let tier = entradas
            .iter()
            .find(|e| e["queueType"] == "RANKED_SOLO_5x5")?
            .get("tier")?
            .as_str()?
            .to_string();
        Some(
            match tier.as_str() {
                "IRON" | "BRONZE" | "SILVER" => "bajo",
                "GOLD" | "PLATINUM" | "EMERALD" => "medio",
                _ => "alto",
            }
            .to_string(),
        )
    }

    /// Obtiene el PUUID del jugador usando su Riot ID (GameName y TagLine)
    pub async fn get_puuid_by_riot_id(
        &self,
        game_name: &str,
        tag_line: &str,
    ) -> Result<String, String> {
        let url = format!(
            "https://{}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/{}/{}",
            self.region,
            urlencoding::encode(game_name),
            urlencoding::encode(tag_line)
        );

        let resp = self
            .client
            .get(&url)
            .header("X-Riot-Token", &self.api_key)
            .send()
            .await
            .map_err(|e| format!("Error en petición HTTP: {}", e))?;

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
        let url = format!(
            "https://{}.api.riotgames.com/lol/match/v5/matches/by-puuid/{}/ids?start=0&count={}",
            self.region, puuid, count
        );

        let resp = self
            .client
            .get(&url)
            .header("X-Riot-Token", &self.api_key)
            .send()
            .await
            .map_err(|e| format!("Error en petición HTTP: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!("Riot API Error (MatchList): {}", resp.status()));
        }

        let match_ids: Vec<String> = resp.json().await.map_err(|e| e.to_string())?;
        Ok(match_ids)
    }

    /// Obtiene los detalles de un Match ID. Devuelve el JSON crudo para poder
    /// cachearlo (ver `details_for`).
    pub async fn get_match_details_raw(&self, match_id: &str) -> Result<String, String> {
        let url = format!(
            "https://{}.api.riotgames.com/lol/match/v5/matches/{}",
            self.region, match_id
        );

        let resp = self
            .client
            .get(&url)
            .header("X-Riot-Token", &self.api_key)
            .send()
            .await
            .map_err(|e| format!("Error en petición HTTP: {}", e))?;

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
        let url = format!(
            "https://{}.api.riotgames.com/lol/match/v5/matches/{}/timeline",
            self.region, match_id
        );
        let resp = self
            .client
            .get(&url)
            .header("X-Riot-Token", &self.api_key)
            .send()
            .await
            .map_err(|e| format!("Error en petición HTTP: {}", e))?;
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
    if config.riot_api_key.is_empty() {
        return Err("Configura tu Riot API Key en Ajustes".to_string());
    }
    let api = RiotApiClient::new(config.riot_api_key);

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

/// Rellena el puesto de impacto de las partidas viejas, sin tocar la API.
///
/// La columna de impacto de la biblioteca sólo se llenaba al abrir la pestaña de
/// esa partida, así que quien tenía veinte partidas veía diecinueve rayas. Aquí
/// se calcula al arrancar, **sólo con lo que ya está en disco**: si a una
/// partida le falta el `riot_match.json` o el `riot_timeline.json`, se salta —
/// pedirlos gastaría cuota de la API sin que nadie lo haya pedido.
pub fn spawn_impact_backfill() {
    std::thread::spawn(|| {
        let pendientes: Vec<crate::storage::MatchMetadata> = crate::storage::load_all_matches()
            .into_iter()
            .filter(|m| {
                (m.impact_rank.is_none()
                    || m.patch.is_none()
                    || m.participants.iter().any(|p| p.spells.is_empty()))
                    && !m.participants.is_empty()
            })
            .collect();
        if pendientes.is_empty() {
            return;
        }
        let mut hechas = 0;
        for m in pendientes {
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
            // `impacto` guarda el metadata si el puesto cambia.
            let mut meta = m;
            impacto(&mut meta, &tl, &details.info);
            hechas += 1;
        }
        if hechas > 0 {
            log::info!("impacto: puesto calculado para {hechas} partidas que no lo tenían");
        }
    });
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

#[tauri::command]
pub async fn get_pressure_summary() -> PressureSummary {
    let mut sum = PressureSummary { games: 0, windows: 0, wpa: 0.0, towers: 0, gold: 0.0 };
    for m in crate::storage::load_all_matches() {
        if m.is_vod || m.riot_match_id.is_none() {
            continue;
        }
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
        let Some(idx) = m.participants.iter().position(|p| p.is_self) else { continue };
        let yo = (idx + 1) as i32;
        let ventanas = crate::pressure::detect(&tl, &details.info.participants);
        let mias = ventanas.iter().filter(|w| w.participant_id == yo);
        let mut alguna = false;
        for w in mias {
            alguna = true;
            sum.windows += 1;
            sum.wpa += w.wpa_elsewhere.max(0.0);
            sum.towers += w.towers_elsewhere as i64;
            sum.gold += w.gold_elsewhere;
        }
        if alguna {
            sum.games += 1;
        }
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
    if config.riot_api_key.is_empty() {
        return Err("Configura tu Riot API Key en Ajustes".to_string());
    }
    let api = RiotApiClient::new(config.riot_api_key);
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

    // Encuentra el rival directo (mismo rol o equipo enemigo)
    let opp_participant_id = participants
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
        });

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
    let frame_15 = tl
        .info
        .frames
        .iter()
        .find(|f| f.timestamp >= 870_000 && f.timestamp <= 930_000)
        .or_else(|| tl.info.frames.get(15))
        .or_else(|| tl.info.frames.last());

    let (gold_diff_15, xp_diff_15, jungle_cs_diff_15) = if let Some(frame) = frame_15 {
        let self_pf = frame.participantFrames.get(&self_pid_str);
        let opp_pf = frame.participantFrames.get(&opp_pid_str);

        if let (Some(spf), Some(opf)) = (self_pf, opp_pf) {
            let gdiff = spf.totalGold - opf.totalGold;
            let xdiff = spf.xp - opf.xp;
            let jcdiff = spf.jungleMinionsKilled - opf.jungleMinionsKilled;
            (Some(gdiff), Some(xdiff), Some(jcdiff))
        } else {
            (None, None, None)
        }
    } else {
        (None, None, None)
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
        damage: p.totalDamageDealtToChampions,
        vision_score: p.visionScore,
        wards_placed: p.wardsPlaced,
    }
}

/// Rellena los `participants` de una partida YA sincronizada (riot_match_id conocido), usando ese ID
/// directamente (sin necesidad del riot id del jugador). Marca is_self por campeón. Para backfill de
/// partidas antiguas que se sincronizaron antes de existir el scoreboard.
pub async fn backfill_participants(
    match_id: &str,
) -> Result<crate::storage::MatchMetadata, String> {
    let config = crate::storage::load_config();
    if config.riot_api_key.is_empty() {
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
    let api = RiotApiClient::new(config.riot_api_key);
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
    if config.riot_api_key.is_empty() {
        return Err("No Riot API Key configured".to_string());
    }

    let mut metadata = crate::storage::get_match_metadata(match_id)
        .map_err(|e| format!("Error loading metadata: {}", e))?;

    if metadata.riot_match_id.is_some() {
        return Ok(metadata); // Ya está sincronizado
    }

    let parts: Vec<&str> = active_player.split('#').collect();
    let game_name = parts[0];
    let tag_line = if parts.len() > 1 { parts[1] } else { "LAN" };

    let api = RiotApiClient::new(config.riot_api_key);

    let puuid = api.get_puuid_by_riot_id(game_name, tag_line).await?;

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
        if metadata.tier_bucket.is_none() {
            let plataforma = riot_id.split('_').next().unwrap_or("la1").to_lowercase();
            metadata.tier_bucket = api.tier_bucket(&plataforma, &puuid).await;
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
