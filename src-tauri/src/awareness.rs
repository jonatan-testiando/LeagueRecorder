//! Quiz de awareness: mide si la información llegó a tu cabeza, no cuántas veces
//! pulsaste la tecla.
//!
//! Durante la partida muestreamos el estado de los 10 jugadores desde la Live Client
//! Data API (endpoint local y oficial de Riot). Al terminar, generamos preguntas
//! ancladas a momentos concretos ("en el 12:30, ¿cuánto CS llevaba tu jungla?") cuya
//! respuesta correcta conocemos con certeza, así que se corrigen solas.
//!
//! Las respuestas correctas NUNCA se envían al frontend: se generan aquí, se guardan
//! en disco junto al quiz pendiente y la corrección ocurre en el backend.

use rand::seq::SliceRandom;
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use crate::training::awareness_dir;

// ---------------------------------------------------------------------------
// Modelo de datos
// ---------------------------------------------------------------------------

/// Estado de un jugador en un instante concreto de la partida.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerSnapshot {
    pub name: String,
    pub champion: String,
    /// "ORDER" | "CHAOS"
    pub team: String,
    /// Posición según la API: TOP / JUNGLE / MIDDLE / BOTTOM / UTILITY (puede venir vacía).
    pub position: String,
    pub level: i32,
    pub kills: i32,
    pub deaths: i32,
    pub assists: i32,
    pub cs: i32,
    pub is_dead: bool,
    pub respawn: f64,
    pub items: Vec<i32>,
    pub is_self: bool,
}

/// Foto completa de la partida en el segundo `t`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameSnapshot {
    pub t: f64,
    pub players: Vec<PlayerSnapshot>,
}

/// Una pulsación de tecla de cámara registrada en vivo.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CameraPress {
    /// Segundo de partida.
    pub t: f64,
    pub role: String,
}

/// Resultado de un aviso del metrónomo: te lo pidió y respondiste (o no).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetronomeResult {
    /// Segundo de partida en que se lanzó el aviso.
    pub t: f64,
    pub role: String,
    pub responded: bool,
    /// Milisegundos hasta la pulsación correcta (0 si no respondiste).
    pub latency_ms: f64,
}

/// Pregunta con su respuesta: uso interno y persistencia, nunca sale al frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuizQuestion {
    pub id: String,
    pub prompt: String,
    pub options: Vec<String>,
    pub answer: String,
    pub subject: String,
    pub at_seconds: f64,
}

/// La misma pregunta sin la respuesta: esto sí viaja a la UI.
#[derive(Debug, Clone, Serialize)]
pub struct QuizQuestionPublic {
    pub id: String,
    pub prompt: String,
    pub options: Vec<String>,
    pub subject: String,
    pub at_seconds: f64,
}

impl From<&QuizQuestion> for QuizQuestionPublic {
    fn from(q: &QuizQuestion) -> Self {
        Self {
            id: q.id.clone(),
            prompt: q.prompt.clone(),
            options: q.options.clone(),
            subject: q.subject.clone(),
            at_seconds: q.at_seconds,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnswerResult {
    pub question_id: String,
    pub prompt: String,
    pub chosen: String,
    pub correct: String,
    pub is_correct: bool,
    pub at_seconds: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuizResult {
    pub quiz_id: String,
    pub date: String,
    pub score: u32,
    pub total: u32,
    pub answers: Vec<AnswerResult>,
}

/// Todo lo que guardamos de una partida para el entrenamiento.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AwarenessRecord {
    pub match_id: String,
    pub date: String,
    #[serde(default)]
    pub champion: String,
    /// Duración de la partida en segundos. Se guarda aparte porque las métricas de
    /// cámara la necesitan aunque el muestreo de snapshots estuviera desactivado.
    #[serde(default)]
    pub duration_secs: f64,
    #[serde(default)]
    pub snapshots: Vec<GameSnapshot>,
    #[serde(default)]
    pub camera_presses: Vec<CameraPress>,
    /// Avisos del metrónomo y si los atendiste.
    #[serde(default)]
    pub metronome: Vec<MetronomeResult>,
    /// Quiz generado y aún sin contestar.
    #[serde(default)]
    pub pending_quiz: Option<PendingQuiz>,
    /// Intentos ya corregidos.
    #[serde(default)]
    pub results: Vec<QuizResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingQuiz {
    pub quiz_id: String,
    pub questions: Vec<QuizQuestion>,
}

/// Métricas de uso de las teclas de cámara durante la partida.
#[derive(Debug, Clone, Serialize)]
pub struct CameraStats {
    pub total_presses: u32,
    pub presses_per_minute: f64,
    /// Mayor intervalo, en segundos, sin mirar a ningún aliado.
    pub longest_gap_secs: f64,
    /// Reparto de pulsaciones por rol.
    pub per_role: Vec<(String, u32)>,
    pub duration_secs: f64,
}

// ---------------------------------------------------------------------------
// Persistencia
// ---------------------------------------------------------------------------

fn record_path(match_id: &str) -> PathBuf {
    awareness_dir().join(format!("{}.json", match_id))
}

pub fn load_record(match_id: &str) -> Option<AwarenessRecord> {
    let content = fs::read_to_string(record_path(match_id)).ok()?;
    serde_json::from_str(&content).ok()
}

pub fn save_record(record: &AwarenessRecord) -> Result<(), String> {
    let content = serde_json::to_string(record)
        .map_err(|e| format!("Error serializando awareness: {}", e))?;
    fs::write(record_path(&record.match_id), content)
        .map_err(|e| format!("Error guardando awareness: {}", e))
}

/// Borra el registro de una partida (lo llama `delete_match`).
pub fn delete_record(match_id: &str) {
    let _ = fs::remove_file(record_path(match_id));
}

// ---------------------------------------------------------------------------
// Parseo de la respuesta de la Live Client Data API
// ---------------------------------------------------------------------------

/// Extrae un `GameSnapshot` de la respuesta cruda de `/allgamedata`.
///
/// Devuelve `None` si aún no hay jugadores (pantalla de carga) para no llenar el
/// registro de fotos vacías.
pub fn snapshot_from_allgamedata(
    v: &serde_json::Value,
    active_player_norm: &str,
) -> Option<GameSnapshot> {
    let t = v
        .get("gameData")
        .and_then(|g| g.get("gameTime"))
        .and_then(|x| x.as_f64())
        .unwrap_or(0.0);

    let arr = v.get("allPlayers").and_then(|p| p.as_array())?;
    if arr.is_empty() {
        return None;
    }

    let mut players = Vec::with_capacity(arr.len());
    for p in arr {
        let name = crate::api_listener::player_game_name(Some(p)).unwrap_or_default();
        let scores = p.get("scores");
        let pick_i = |k: &str| -> i32 {
            scores
                .and_then(|s| s.get(k))
                .and_then(|x| x.as_i64())
                .unwrap_or(0) as i32
        };
        let items = p
            .get("items")
            .and_then(|i| i.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|it| it.get("itemID").and_then(|x| x.as_i64()).map(|x| x as i32))
                    .collect::<Vec<i32>>()
            })
            .unwrap_or_default();

        players.push(PlayerSnapshot {
            is_self: crate::api_listener::strip_tag(&name) == active_player_norm,
            name,
            champion: p
                .get("championName")
                .and_then(|x| x.as_str())
                .unwrap_or("Unknown")
                .to_string(),
            team: p
                .get("team")
                .and_then(|x| x.as_str())
                .unwrap_or("ORDER")
                .to_string(),
            position: p
                .get("position")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            level: p.get("level").and_then(|x| x.as_i64()).unwrap_or(0) as i32,
            kills: pick_i("kills"),
            deaths: pick_i("deaths"),
            assists: pick_i("assists"),
            cs: pick_i("creepScore"),
            is_dead: p.get("isDead").and_then(|x| x.as_bool()).unwrap_or(false),
            respawn: p
                .get("respawnTimer")
                .and_then(|x| x.as_f64())
                .unwrap_or(0.0),
            items,
        });
    }

    Some(GameSnapshot { t, players })
}

// ---------------------------------------------------------------------------
// Estadísticas de uso de cámara
// ---------------------------------------------------------------------------

/// Duración de la partida, cayendo a la última foto si no se guardó explícitamente
/// (registros creados antes de que existiera el campo).
fn record_duration(rec: &AwarenessRecord) -> f64 {
    if rec.duration_secs > 0.0 {
        rec.duration_secs
    } else {
        rec.snapshots.last().map(|s| s.t).unwrap_or(0.0)
    }
}

pub fn camera_stats(presses: &[CameraPress], duration_secs: f64) -> CameraStats {
    let mut per_role: Vec<(String, u32)> = Vec::new();
    for p in presses {
        match per_role.iter_mut().find(|(r, _)| *r == p.role) {
            Some((_, n)) => *n += 1,
            None => per_role.push((p.role.clone(), 1)),
        }
    }
    per_role.sort_by(|a, b| b.1.cmp(&a.1));

    // El hueco más largo incluye el tramo inicial y el final: empezar la partida sin
    // mirar a nadie durante 6 minutos también es un hueco.
    let mut longest = 0.0_f64;
    let mut prev = 0.0_f64;
    let mut sorted: Vec<f64> = presses.iter().map(|p| p.t).collect();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    for t in &sorted {
        longest = longest.max(t - prev);
        prev = *t;
    }
    if duration_secs > prev {
        longest = longest.max(duration_secs - prev);
    }

    let minutes = (duration_secs / 60.0).max(1.0 / 60.0);
    CameraStats {
        total_presses: presses.len() as u32,
        presses_per_minute: presses.len() as f64 / minutes,
        longest_gap_secs: longest,
        per_role,
        duration_secs,
    }
}

// ---------------------------------------------------------------------------
// Generación del quiz
// ---------------------------------------------------------------------------

fn fmt_time(secs: f64) -> String {
    let s = secs.max(0.0) as i64;
    format!("{:02}:{:02}", s / 60, s % 60)
}

/// Construye 4 opciones: la correcta más distractores generados con `perturb`,
/// barajadas. Si no se consiguen suficientes distractores distintos, devuelve
/// menos opciones antes que repetir.
fn build_options(correct: String, mut candidates: Vec<String>, rng: &mut impl Rng) -> Vec<String> {
    candidates.retain(|c| *c != correct);
    candidates.dedup();
    candidates.shuffle(rng);
    candidates.truncate(3);
    let mut opts = vec![correct];
    opts.append(&mut candidates);
    opts.shuffle(rng);
    opts
}

fn spread_i32(v: i32, deltas: &[i32], min: i32, max: i32) -> Vec<String> {
    let mut out = Vec::new();
    for d in deltas {
        let x = (v + d).clamp(min, max);
        let s = x.to_string();
        if !out.contains(&s) {
            out.push(s);
        }
    }
    out
}

/// Genera `count` preguntas a partir de los snapshots.
///
/// Solo pregunta por **aliados** (que es lo que las teclas de cámara te enseñan) y
/// descarta los primeros minutos, donde todos los valores son triviales o iguales.
pub fn generate_questions(record: &AwarenessRecord, count: usize) -> Vec<QuizQuestion> {
    let mut rng = rand::thread_rng();

    // Momentos utilizables: a partir del minuto 4 y con datos de verdad.
    let usable: Vec<&GameSnapshot> = record
        .snapshots
        .iter()
        .filter(|s| s.t >= 240.0 && s.players.len() >= 2)
        .collect();
    if usable.is_empty() {
        return Vec::new();
    }

    // Repartimos los momentos a lo largo de la partida en vez de cogerlos al azar,
    // para que el quiz cubra early, mid y late en lugar de amontonarse.
    let mut chosen: Vec<&GameSnapshot> = Vec::new();
    let n = count.min(usable.len());
    for i in 0..n {
        let lo = i * usable.len() / n;
        let hi = ((i + 1) * usable.len() / n).max(lo + 1);
        let idx = rng.gen_range(lo..hi.min(usable.len()));
        chosen.push(usable[idx]);
    }

    let mut questions = Vec::new();
    for (i, snap) in chosen.iter().enumerate() {
        // Equipo del jugador. Si no sabemos quiénes somos no podemos distinguir aliados
        // de enemigos, y preguntar por un enemigo mediría otra cosa: descartamos la foto.
        let Some(my_team) = snap
            .players
            .iter()
            .find(|p| p.is_self)
            .map(|p| p.team.clone())
        else {
            continue;
        };
        let allies: Vec<&PlayerSnapshot> = snap
            .players
            .iter()
            .filter(|p| !p.is_self && p.team == my_team)
            .collect();
        if allies.is_empty() {
            continue;
        }
        let ally = allies[rng.gen_range(0..allies.len())];
        let when = fmt_time(snap.t);

        // Elegimos el tipo de pregunta según lo que ese aliado hace interesante.
        // Un support con 8 de CS no da una buena pregunta de farmeo.
        let mut kinds: Vec<u8> = vec![1, 2, 4]; // nivel, muertes, KDA siempre valen
        if ally.cs >= 30 {
            kinds.push(0); // CS
        }
        if ally.is_dead {
            kinds.push(3); // estado vivo/muerto
        }
        let kind = kinds[rng.gen_range(0..kinds.len())];

        let (prompt, answer, options) = match kind {
            0 => {
                let correct = ally.cs.to_string();
                let cands = spread_i32(ally.cs, &[-35, -20, -12, 12, 20, 35], 0, 800);
                (
                    format!("At {} — how much CS did your {} have?", when, ally.champion),
                    correct.clone(),
                    build_options(correct, cands, &mut rng),
                )
            }
            1 => {
                let correct = ally.level.to_string();
                let cands = spread_i32(ally.level, &[-3, -2, -1, 1, 2, 3], 1, 18);
                (
                    format!("At {} — what level was your {}?", when, ally.champion),
                    correct.clone(),
                    build_options(correct, cands, &mut rng),
                )
            }
            2 => {
                let correct = ally.deaths.to_string();
                let cands = spread_i32(ally.deaths, &[-2, -1, 1, 2, 3], 0, 40);
                (
                    format!(
                        "At {} — how many times had your {} died?",
                        when, ally.champion
                    ),
                    correct.clone(),
                    build_options(correct, cands, &mut rng),
                )
            }
            3 => (
                format!("At {} — was your {} alive or dead?", when, ally.champion),
                if ally.is_dead { "Dead" } else { "Alive" }.to_string(),
                vec!["Alive".to_string(), "Dead".to_string()],
            ),
            _ => {
                let correct = format!("{}/{}/{}", ally.kills, ally.deaths, ally.assists);
                let mut cands = Vec::new();
                for (dk, dd, da) in [(1, 0, 1), (-1, 1, 0), (0, 1, 2), (2, -1, -1), (0, -1, 1)] {
                    cands.push(format!(
                        "{}/{}/{}",
                        (ally.kills + dk).max(0),
                        (ally.deaths + dd).max(0),
                        (ally.assists + da).max(0)
                    ));
                }
                (
                    format!("At {} — what was your {}'s KDA?", when, ally.champion),
                    correct.clone(),
                    build_options(correct, cands, &mut rng),
                )
            }
        };

        questions.push(QuizQuestion {
            id: format!("q{}", i),
            prompt,
            options,
            answer,
            subject: ally.champion.clone(),
            at_seconds: snap.t,
        });
    }

    questions
}

// ---------------------------------------------------------------------------
// Comandos Tauri
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct QuizPayload {
    pub quiz_id: String,
    pub match_id: String,
    pub questions: Vec<QuizQuestionPublic>,
    pub camera: Option<CameraStats>,
}

/// Genera (o recupera) el quiz de una partida. Si ya había uno pendiente lo
/// devuelve tal cual, para que recargar la UI no cambie las preguntas a medias.
#[tauri::command]
pub async fn generate_awareness_quiz(
    match_id: String,
    count: Option<usize>,
    regenerate: Option<bool>,
) -> Result<QuizPayload, String> {
    let mut record = load_record(&match_id)
        .ok_or_else(|| "This match has no awareness data recorded.".to_string())?;

    let force = regenerate.unwrap_or(false);
    let questions = match (&record.pending_quiz, force) {
        (Some(p), false) => p.questions.clone(),
        _ => {
            let qs = generate_questions(&record, count.unwrap_or(5));
            if qs.is_empty() {
                return Err(
                    "Not enough match data to build questions (did the game last under 4 minutes?)."
                        .to_string(),
                );
            }
            record.pending_quiz = Some(PendingQuiz {
                quiz_id: uuid::Uuid::new_v4().to_string(),
                questions: qs.clone(),
            });
            save_record(&record)?;
            qs
        }
    };

    let duration = record_duration(&record);
    Ok(QuizPayload {
        quiz_id: record.pending_quiz.as_ref().unwrap().quiz_id.clone(),
        match_id,
        questions: questions.iter().map(QuizQuestionPublic::from).collect(),
        camera: Some(camera_stats(&record.camera_presses, duration)),
    })
}

/// Corrige el quiz en el backend y guarda el resultado.
/// `answers` es un mapa id_pregunta → opción elegida.
#[tauri::command]
pub async fn submit_awareness_quiz(
    match_id: String,
    answers: std::collections::HashMap<String, String>,
) -> Result<QuizResult, String> {
    let mut record = load_record(&match_id)
        .ok_or_else(|| "This match has no awareness data recorded.".to_string())?;
    let pending = record
        .pending_quiz
        .clone()
        .ok_or_else(|| "There is no pending quiz for this match.".to_string())?;

    let mut results = Vec::new();
    let mut score = 0;
    for q in &pending.questions {
        let chosen = answers.get(&q.id).cloned().unwrap_or_default();
        let is_correct = chosen == q.answer;
        if is_correct {
            score += 1;
        }
        results.push(AnswerResult {
            question_id: q.id.clone(),
            prompt: q.prompt.clone(),
            chosen,
            correct: q.answer.clone(),
            is_correct,
            at_seconds: q.at_seconds,
        });
    }

    let result = QuizResult {
        quiz_id: pending.quiz_id.clone(),
        date: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        score,
        total: pending.questions.len() as u32,
        answers: results,
    };

    record.results.push(result.clone());
    record.pending_quiz = None; // consumido: el próximo quiz será nuevo
    save_record(&record)?;
    Ok(result)
}

/// Resumen ligero para la pestaña de entrenamiento: qué partidas tienen quiz
/// disponible y cómo fueron las ya contestadas.
#[derive(Serialize)]
pub struct AwarenessSummary {
    pub match_id: String,
    pub date: String,
    pub champion: String,
    pub snapshots: usize,
    pub camera: CameraStats,
    pub last_score: Option<u32>,
    pub last_total: Option<u32>,
    pub answered: bool,
    /// Avisos del metrónomo atendidos / lanzados. `None` si no estaba activo.
    pub metronome: Option<(u32, u32)>,
}

#[tauri::command]
pub async fn list_awareness_records() -> Vec<AwarenessSummary> {
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(awareness_dir()) {
        for e in entries.flatten() {
            let path = e.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let Ok(content) = fs::read_to_string(&path) else {
                continue;
            };
            let Ok(rec) = serde_json::from_str::<AwarenessRecord>(&content) else {
                continue;
            };
            let duration = record_duration(&rec);
            let last = rec.results.last();
            out.push(AwarenessSummary {
                match_id: rec.match_id.clone(),
                date: rec.date.clone(),
                champion: rec.champion.clone(),
                snapshots: rec.snapshots.len(),
                camera: camera_stats(&rec.camera_presses, duration),
                last_score: last.map(|r| r.score),
                last_total: last.map(|r| r.total),
                answered: !rec.results.is_empty(),
                metronome: if rec.metronome.is_empty() {
                    None
                } else {
                    Some((
                        rec.metronome.iter().filter(|m| m.responded).count() as u32,
                        rec.metronome.len() as u32,
                    ))
                },
            });
        }
    }
    out.sort_by(|a, b| b.date.cmp(&a.date));
    out
}

/// Traduce la posición que reporta la API al rol que usa la configuración del usuario.
fn position_to_role(position: &str) -> Option<&'static str> {
    match position.to_uppercase().as_str() {
        "TOP" => Some("TOP"),
        "JUNGLE" => Some("JUNGLE"),
        "MIDDLE" | "MID" => Some("MID"),
        "BOTTOM" | "BOT" => Some("ADC"),
        "UTILITY" | "SUPPORT" => Some("SUPPORT"),
        _ => None,
    }
}

#[derive(Serialize)]
pub struct RoleChampion {
    pub role: String,
    pub champion: String,
}

/// Campeones aliados que has visto realmente en cada rol, sacados de los registros
/// de partidas. El drill de mapeo los usa para preguntarte por campeón y no solo por
/// rol, que es como funciona la cabeza en partida ("Nautilus", no "support").
#[tauri::command]
pub async fn get_champion_pool() -> Vec<RoleChampion> {
    let mut seen: Vec<(String, String)> = Vec::new();
    let Ok(entries) = fs::read_dir(awareness_dir()) else {
        return Vec::new();
    };
    for e in entries.flatten() {
        let path = e.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(rec) = serde_json::from_str::<AwarenessRecord>(&content) else {
            continue;
        };
        // Una sola foto por partida basta: la alineación no cambia.
        let Some(snap) = rec.snapshots.first() else {
            continue;
        };
        let Some(my_team) = snap.players.iter().find(|p| p.is_self).map(|p| &p.team) else {
            continue;
        };
        for p in snap.players.iter().filter(|p| !p.is_self && p.team == *my_team) {
            if let Some(role) = position_to_role(&p.position) {
                let pair = (role.to_string(), p.champion.clone());
                if !seen.contains(&pair) {
                    seen.push(pair);
                }
            }
        }
    }
    seen.into_iter()
        .map(|(role, champion)| RoleChampion { role, champion })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn player(champ: &str, team: &str, is_self: bool, cs: i32, level: i32) -> PlayerSnapshot {
        PlayerSnapshot {
            name: champ.to_string(),
            champion: champ.to_string(),
            team: team.to_string(),
            position: "".into(),
            level,
            kills: 2,
            deaths: 1,
            assists: 3,
            cs,
            is_dead: false,
            respawn: 0.0,
            items: vec![],
            is_self,
        }
    }

    fn record_with_snapshots() -> AwarenessRecord {
        let mut snapshots = Vec::new();
        for i in 0..20 {
            let t = 240.0 + i as f64 * 30.0;
            snapshots.push(GameSnapshot {
                t,
                players: vec![
                    player("Yo", "ORDER", true, 100, 10),
                    player("Garen", "ORDER", false, 80 + i, 9),
                    player("Ahri", "ORDER", false, 90 + i, 10),
                    player("Darius", "CHAOS", false, 120, 11),
                ],
            });
        }
        AwarenessRecord {
            match_id: "match_test".into(),
            date: "2026-08-04".into(),
            champion: "Yo".into(),
            snapshots,
            ..Default::default()
        }
    }

    #[test]
    fn solo_pregunta_por_aliados() {
        let rec = record_with_snapshots();
        let qs = generate_questions(&rec, 5);
        assert_eq!(qs.len(), 5);
        for q in &qs {
            assert!(
                q.subject == "Garen" || q.subject == "Ahri",
                "preguntó por {} (no es un aliado)",
                q.subject
            );
            // La respuesta correcta siempre está entre las opciones.
            assert!(q.options.contains(&q.answer), "{:?}", q);
            assert!(q.options.len() >= 2);
        }
    }

    #[test]
    fn descarta_los_primeros_minutos() {
        let mut rec = record_with_snapshots();
        rec.snapshots.retain(|s| s.t < 240.0);
        assert!(generate_questions(&rec, 5).is_empty());
    }

    #[test]
    fn opciones_sin_duplicados() {
        let rec = record_with_snapshots();
        for q in generate_questions(&rec, 8) {
            let mut seen = q.options.clone();
            seen.sort();
            let before = seen.len();
            seen.dedup();
            assert_eq!(before, seen.len(), "opciones repetidas en {:?}", q.options);
        }
    }

    #[test]
    fn hueco_mas_largo_incluye_inicio_y_final() {
        let presses = vec![
            CameraPress { t: 100.0, role: "TOP".into() },
            CameraPress { t: 110.0, role: "MID".into() },
        ];
        let st = camera_stats(&presses, 400.0);
        assert_eq!(st.total_presses, 2);
        // Tramo final 110 → 400 = 290 s, mayor que el inicial (100 s).
        assert_eq!(st.longest_gap_secs, 290.0);
    }

    #[test]
    fn stats_sin_pulsaciones_es_toda_la_partida() {
        let st = camera_stats(&[], 600.0);
        assert_eq!(st.total_presses, 0);
        assert_eq!(st.longest_gap_secs, 600.0);
        assert_eq!(st.presses_per_minute, 0.0);
    }
}
