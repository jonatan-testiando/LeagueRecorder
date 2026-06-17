use reqwest::Client;
use std::time::Duration;
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct LolEvent {
    #[serde(rename = "EventID")]
    pub event_id: i32,
    #[serde(rename = "EventName")]
    pub event_name: String,
    #[serde(rename = "EventTime")]
    pub event_time: f64,
    #[serde(rename = "KillerName")]
    pub killer_name: Option<String>,
    #[serde(rename = "VictimName")]
    pub victim_name: Option<String>,
    #[serde(rename = "Assisters")]
    pub assisters: Option<Vec<String>>,
    // Campos adicionales según el tipo de evento
    #[serde(rename = "Recipient")]
    pub recipient: Option<String>,          // FirstBlood
    #[serde(rename = "DragonType")]
    pub dragon_type: Option<String>,        // DragonKill: Fire/Water/Air/Earth/Hextech/Chemtech/Elder
    #[serde(rename = "Stolen")]
    pub stolen: Option<String>,             // "True"/"False" en objetivos
    #[serde(rename = "TurretKilled")]
    pub turret_killed: Option<String>,      // p.ej. "Turret_T1_C_07_A"
    #[serde(rename = "InhibKilled")]
    pub inhib_killed: Option<String>,       // p.ej. "Barracks_T2_L1"
    #[serde(rename = "KillStreak")]
    pub kill_streak: Option<i32>,           // Multikill
    #[serde(rename = "Acer")]
    pub acer: Option<String>,               // Ace
    #[serde(rename = "Result")]
    pub result: Option<String>,             // GameEnd: "Win"/"Lose"
}

/// Devuelve el nombre de juego de un objeto jugador (activePlayer o entrada de allPlayers),
/// priorizando riotIdGameName y cayendo a summonerName o al riotId sin el #TAG.
fn player_game_name(obj: Option<&serde_json::Value>) -> Option<String> {
    let o = obj?;
    let pick = |k: &str| o.get(k).and_then(|v| v.as_str()).filter(|s| !s.is_empty());
    
    if let (Some(n), Some(t)) = (pick("riotIdGameName"), pick("riotIdTagLine")) {
        return Some(format!("{}#{}", n, t));
    }
    if let Some(n) = pick("riotIdGameName") {
        return Some(n.to_string());
    }
    if let Some(n) = pick("riotId") {
        return Some(n.to_string());
    }
    if let Some(n) = pick("summonerName") {
        return Some(n.to_string());
    }
    None
}

/// Normaliza un nombre para comparación: quita el #TAG y pasa a minúsculas.
/// Imprescindible porque los eventos pueden traer "Nombre" o "Nombre#TAG".
pub fn strip_tag(name: &str) -> String {
    name.split('#').next().unwrap_or(name).trim().to_lowercase()
}

/// Contexto de la partida: jugador activo, su campeón, su equipo y el mapa de equipos.
#[derive(Debug, Clone)]
pub struct GameContext {
    pub active_player: String,
    pub champion: String,
    pub team: String,                       // "ORDER" o "CHAOS"
    pub players: Vec<(String, String)>,     // (summonerName, team)
}

#[derive(Debug, Deserialize)]
pub struct LolEventResponse {
    #[serde(rename = "Events")]
    pub events: Vec<LolEvent>,
}

pub struct LolApiClient {
    client: Client,
    base_url: String,
}

impl Default for LolApiClient {
    fn default() -> Self {
        Self::new()
    }
}

impl LolApiClient {
    pub fn new() -> Self {
        let client = Client::builder()
            .danger_accept_invalid_certs(true)
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap_or_else(|_| Client::new());
        Self {
            client,
            base_url: "https://127.0.0.1:2999/liveclientdata".to_string(),
        }
    }

    /// Obtiene el contexto completo de la partida: jugador activo, campeón, su equipo y
    /// el mapa de equipos de todos los jugadores (para clasificar objetivos como aliados/enemigos).
    pub async fn get_game_context(&self) -> Result<GameContext, String> {
        let url = format!("{}/allgamedata", self.base_url);
        let resp = self.client.get(&url).send().await
            .map_err(|e| format!("Fallo al conectar con la API de LoL: {}", e))?;

        let all_data: serde_json::Value = resp.json().await
            .map_err(|e| format!("Error parseando allgamedata: {}", e))?;

        // Riot deprecó `summonerName` (ahora usa Riot IDs "Nombre#TAG"). Identificamos al
        // jugador por riotIdGameName y comparamos siempre por el nombre SIN el #TAG.
        let active_player_name = player_game_name(all_data.get("activePlayer"))
            .ok_or("No se encontró activePlayer en los datos de la partida")?;
        let active_norm = strip_tag(&active_player_name);

        let mut champion_name = "Unknown".to_string();
        let mut team = "ORDER".to_string();
        let mut players: Vec<(String, String)> = Vec::new();

        if let Some(all_players) = all_data.get("allPlayers").and_then(|p| p.as_array()) {
            for player in all_players {
                let name = match player_game_name(Some(player)) {
                    Some(n) => n,
                    None => continue,
                };
                let p_team = player.get("team").and_then(|v| v.as_str()).unwrap_or("ORDER").to_string();
                players.push((name.clone(), p_team.clone()));
                if strip_tag(&name) == active_norm {
                    if let Some(champ) = player.get("championName").and_then(|v| v.as_str()) {
                        champion_name = champ.to_string();
                    }
                    team = p_team;
                }
            }
        }

        Ok(GameContext { active_player: active_player_name, champion: champion_name, team, players })
    }

    /// Devuelve (tiempo de juego en segundos, nivel de la ultimate R) en una sola llamada.
    /// Se usa para alinear los eventos de ultimate y comprobar si la R ya está disponible.
    pub async fn get_live_state(&self) -> Result<(f64, i32), String> {
        let url = format!("{}/allgamedata", self.base_url);
        let resp = self.client.get(&url).send().await
            .map_err(|e| format!("Fallo al conectar con la API de LoL: {}", e))?;
        let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

        let game_time = v.get("gameData")
            .and_then(|g| g.get("gameTime"))
            .and_then(|t| t.as_f64())
            .unwrap_or(0.0);
        let r_level = v.get("activePlayer")
            .and_then(|a| a.get("abilities"))
            .and_then(|ab| ab.get("R"))
            .and_then(|r| r.get("abilityLevel"))
            .and_then(|l| l.as_i64())
            .unwrap_or(0) as i32;
        Ok((game_time, r_level))
    }

    pub async fn get_events(&self) -> Result<Vec<LolEvent>, String> {
        let url = format!("{}/eventdata", self.base_url);
        let resp = self.client.get(&url).send().await
            .map_err(|e| format!("Fallo al conectar con la API de LoL: {}", e))?;
        let data: LolEventResponse = resp.json().await.map_err(|e| e.to_string())?;
        Ok(data.events)
    }
}
