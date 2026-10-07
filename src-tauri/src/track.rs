//! El recorrido completo de una partida, para dibujarlo sobre el minimapa.
//!
//! Inspirado en el «Minimap Recorder» que se compartió por Discord el
//! 2026-10-07: ver al jugador moverse por el mapa toda la partida, y el dibujo
//! que va dejando. Aquí no se captura nada nuevo: todo sale de lo que ya hay.
//!   - Tu posición: `Positions::follow`, dos veces por segundo (el mismo rastro
//!     de la presión y de la ruta de jungla).
//!   - Los demás: los iconos del minimapa, aliados siempre y rivales cuando
//!     estaban a la vista. Una vez por segundo basta para pintarlos.
//!   - Muertes (posición exacta de la API), vueltas a base (compras) y, si
//!     jugaste de jungla, los campamentos de `jungle_route`.
//!
//! Tiempos en segundos de PARTIDA; el vídeo va `video_offset` por delante.

use crate::minimap::Positions;
use crate::riot_api::{MatchDto, TimelineDto};
use serde::Serialize;

/// A menos de esto de tu posición, un icono aliado eres tú: no se repite.
const RADIO_PROPIO: f64 = 400.0;

#[derive(Serialize)]
pub struct OthersFrame {
    pub t: f32,
    /// Aliados `[x, y]`.
    pub a: Vec<[i32; 2]>,
    /// Rivales a la vista `[x, y]`.
    pub e: Vec<[i32; 2]>,
}

#[derive(Serialize)]
pub struct TrackDeath {
    pub t: f64,
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize)]
pub struct Track {
    pub video_offset: f64,
    pub duration: f64,
    pub champion: String,
    /// Tu rastro: `[t, x, y]`.
    pub me: Vec<[f32; 3]>,
    pub others: Vec<OthersFrame>,
    pub clears: Vec<crate::jungle_route::CampClear>,
    pub deaths: Vec<TrackDeath>,
    pub recalls: Vec<f64>,
}

#[derive(Serialize)]
pub struct TrackResponse {
    /// "ok", "no_minimap", "no_riot" o "no_track".
    pub status: String,
    pub track: Option<Track>,
}

pub fn build(tl: &TimelineDto, m: &MatchDto, pos: &Positions) -> Option<Track> {
    let pid = pos.self_participant_id;
    let yo = m.info.participants.get((pid - 1) as usize)?;
    let anclas = crate::minimap::anclas_de(tl, pid);
    let pista = pos.follow(&anclas);
    if pista.is_empty() {
        return None;
    }

    // Los demás, una muestra por segundo, sin tu propio icono.
    let paso = (pos.fps.round() as usize).max(1);
    let mut others = Vec::new();
    for s in pos.samples.iter().step_by(paso) {
        let sec = s.t - pos.video_offset;
        if sec < 0.0 {
            continue;
        }
        let mio = pista
            .get(pista.partition_point(|f| f.sec < sec - 0.3))
            .filter(|f| (f.sec - sec).abs() <= 0.3);
        let mut a = Vec::new();
        let mut e = Vec::new();
        for i in &s.icons {
            match i.team {
                Some(t) if t == pos.self_team_id => {
                    if mio.is_some_and(|f| (f.x - i.x).hypot(f.y - i.y) < RADIO_PROPIO) {
                        continue;
                    }
                    a.push([i.x as i32, i.y as i32]);
                }
                Some(_) => e.push([i.x as i32, i.y as i32]),
                None => {}
            }
        }
        others.push(OthersFrame { t: sec as f32, a, e });
    }

    let muertos = crate::jungle_route::muertes(tl, pid);
    let recalls = crate::jungle_route::visitas_a_base(tl, pid, &muertos)
        .into_iter()
        .filter(|v| !v.2)
        .map(|v| v.0)
        .collect();
    let deaths = muertos
        .iter()
        .filter_map(|(t, _, p)| {
            // Sin posición en el evento, la del rastro en ese instante.
            let (x, y) = p.or_else(|| {
                let f = pista.get(pista.partition_point(|f| f.sec < t - 2.0))?;
                ((f.sec - t).abs() <= 3.0).then_some((f.x, f.y))
            })?;
            Some(TrackDeath { t: *t, x, y })
        })
        .collect();
    let clears = if crate::jungle_route::es_jungla(&m.info.participants, pid) {
        crate::jungle_route::build(tl, &m.info.participants, pos)
            .filter(|r| r.agreement >= crate::jungle_route::ACUERDO_MIN)
            .map(|r| r.clears)
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    Some(Track {
        video_offset: pos.video_offset,
        duration: tl.info.frames.last()?.timestamp as f64 / 1000.0,
        champion: yo.championName.clone(),
        me: pista.iter().map(|f| [f.sec as f32, f.x as f32, f.y as f32]).collect(),
        others,
        clears,
        deaths,
        recalls,
    })
}

/// El recorrido de una partida, si su minimapa está medido.
#[tauri::command]
pub async fn get_match_track(match_id: String) -> TrackResponse {
    tokio::task::spawn_blocking(move || {
        let resp = |s: &str, t| TrackResponse { status: s.to_string(), track: t };
        let (Some(raw), Some(raw_tl)) = (
            crate::storage::load_raw_match(&match_id),
            crate::storage::load_raw_timeline(&match_id),
        ) else {
            return resp("no_riot", None);
        };
        let Some(pos) = Positions::load(&match_id) else { return resp("no_minimap", None) };
        let (Ok(m), Ok(tl)) = (serde_json::from_str::<MatchDto>(&raw), serde_json::from_str::<TimelineDto>(&raw_tl)) else {
            return resp("no_riot", None);
        };
        match build(&tl, &m, &pos) {
            Some(t) => resp("ok", Some(t)),
            None => resp("no_track", None),
        }
    })
    .await
    .unwrap_or(TrackResponse { status: "no_riot".into(), track: None })
}

#[cfg(test)]
mod tests {
    /// `MIS_PARTIDAS_DIR=... cargo test --lib recorrido_en_mis_partidas -- --nocapture`
    #[test]
    fn recorrido_en_mis_partidas() {
        let Ok(dir) = std::env::var("MIS_PARTIDAS_DIR") else { return };
        for d in std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).take(40) {
            let (Ok(raw), Ok(rtl), Ok(rp)) = (
                std::fs::read_to_string(d.join("riot_match.json")),
                std::fs::read_to_string(d.join("riot_timeline.json")),
                std::fs::read_to_string(d.join("minimap_positions.json")),
            ) else { continue };
            let m: super::MatchDto = serde_json::from_str(&raw).unwrap();
            let tl: super::TimelineDto = serde_json::from_str(&rtl).unwrap();
            let pos = super::Positions::from_json(&rp).unwrap();
            let Some(t) = super::build(&tl, &m, &pos) else { continue };
            let json = serde_json::to_string(&t).unwrap();
            let rivales: usize = t.others.iter().map(|o| o.e.len()).sum();
            let aliados: usize = t.others.iter().map(|o| o.a.len()).sum();
            println!(
                "{} {} · {} puntos tuyos · {} s de otros (aliados {:.1}/s, rivales {:.1}/s) · {} muertes · {} bases · {} campamentos · {} KB",
                d.file_name().unwrap().to_string_lossy(), t.champion, t.me.len(), t.others.len(),
                aliados as f64 / t.others.len() as f64, rivales as f64 / t.others.len() as f64,
                t.deaths.len(), t.recalls.len(), t.clears.len(), json.len() / 1024
            );
        }
    }
}
