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
    pub xp: i32,
    #[serde(default)]
    pub level: i32,
    #[serde(default)]
    pub minionsKilled: i32,
    #[serde(default)]
    pub jungleMinionsKilled: i32,
    #[serde(default)]
    pub position: Option<PositionDto>,
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
    pub position: Option<PositionDto>,
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

    /// Obtiene los detalles de un Match ID
    pub async fn get_match_details(&self, match_id: &str) -> Result<MatchDto, String> {
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

        let match_dto: MatchDto = resp.json().await.map_err(|e| e.to_string())?;
        Ok(match_dto)
    }

    /// Obtiene la timeline de una partida (eventos minuto a minuto, incl. compras de items).
    pub async fn get_match_timeline(&self, match_id: &str) -> Result<TimelineDto, String> {
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
        let dto: TimelineDto = resp.json().await.map_err(|e| e.to_string())?;
        Ok(dto)
    }
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
                        timeline_markers.push(marker(sec, "kill", "Asistencia", pos_x, pos_y));
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
    let details = api.get_match_details(&rid).await?;
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
        if let Ok(tl) = api.get_match_timeline(&rid).await {
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
        if let Ok(details) = api.get_match_details(&r_match_id).await {
            let duration_diff = (details.info.gameDuration as f64 - metadata.game_duration).abs();
            if duration_diff <= 180.0 {
                if let Some(participant) = details.info.participants.iter().find(|p| p.puuid == puuid) {
                    found_match = Some((r_match_id, participant.clone(), details.info.clone()));
                    break;
                }
            }
        }
    }

    if let Some((riot_id, participant, info)) = found_match {
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
            if let Ok(tl) = api.get_match_timeline(&riot_id).await {
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
