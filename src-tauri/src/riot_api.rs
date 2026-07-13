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
    if !metadata.participants.is_empty() {
        return Ok(metadata);
    }
    let rid = metadata.riot_match_id.clone().ok_or_else(|| {
        "Esta partida aún no está sincronizada con Riot (graba una nueva o espera la sincronización automática de ~60s tras la partida)".to_string()
    })?;
    let api = RiotApiClient::new(config.riot_api_key);
    let details = api.get_match_details(&rid).await?;
    metadata.participants = details
        .info
        .participants
        .iter()
        .map(|p| to_participant(p, p.championName == metadata.champion))
        .collect();
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

    // El active_player viene como "GameName#TagLine" o "GameName"
    let parts: Vec<&str> = active_player.split('#').collect();
    let game_name = parts[0];
    let tag_line = if parts.len() > 1 { parts[1] } else { "LAN" };

    let api = RiotApiClient::new(config.riot_api_key);

    // 1. Obtener PUUID
    let puuid = api.get_puuid_by_riot_id(game_name, tag_line).await?;

    // 2. Obtener últimas 5 partidas (puede que no sea la ultimísima si es muy reciente, pero revisamos)
    let recent_matches = api.get_match_ids_by_puuid(&puuid, 5).await?;

    if recent_matches.is_empty() {
        return Err("No recent matches found".to_string());
    }

    // Buscamos la partida que coincida con el campeón y resultado aproximado.
    let mut found_match = None;
    for r_match_id in recent_matches {
        if let Ok(details) = api.get_match_details(&r_match_id).await {
            let duration_diff = (details.info.gameDuration as f64 - metadata.game_duration).abs();
            // Comparamos si la duración de la partida difiere por menos de 180 segundos (3 minutos)
            if duration_diff <= 180.0 {
                if let Some(participant) = details.info.participants.iter().find(|p| p.puuid == puuid) {
                    found_match = Some((r_match_id, participant.clone(), details.info.participants.clone()));
                    break;
                }
            }
        }
    }

    if let Some((riot_id, participant, all_participants)) = found_match {
        metadata.riot_match_id = Some(riot_id);
        metadata.kda = Some(format!(
            "{}/{}/{}",
            participant.kills, participant.deaths, participant.assists
        ));
        metadata.gold_earned = Some(participant.goldEarned);
        metadata.damage_dealt = Some(participant.totalDamageDealtToChampions);
        // Guardamos los 10 jugadores para el scoreboard estilo Ascent.
        metadata.participants = all_participants
            .iter()
            .map(|p| to_participant(p, p.puuid == puuid))
            .collect();

        // Actualizamos el result usando Riot's truth
        metadata.result = if participant.win {
            "Victory".to_string()
        } else {
            "Defeat".to_string()
        };

        let _ = crate::storage::save_match_metadata(&metadata);
    }

    Ok(metadata)
}
