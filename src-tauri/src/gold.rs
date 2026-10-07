//! Tu oro, segundo a segundo.
//!
//! La API de Riot da el oro una vez por minuto; la Live Client API lo da en
//! cada consulta, y el bucle de la partida ya consulta `/allgamedata` una vez
//! por segundo (ver `commands.rs`). Guardar `activePlayer.currentGold` de esa
//! misma respuesta no cuesta ni una petición más. Va a `gold_series.json`, en
//! la carpeta de la partida, en tiempo de PARTIDA.
//!
//! Con eso se responde a tres cosas que el minuto a minuto no puede:
//!   - de dónde sale tu oro (pasivo, campamentos, oleadas, kills, objetivos);
//!   - con cuánto oro vuelves a base y cuánto gastas;
//!   - cuánto oro llevabas sin gastar al morir.
//!
//! Idea del «Gold Tracker» que se compartió por Discord el 2026-10-07: allí
//! infieren el campamento por la firma del oro. Aquí el campamento lo da la
//! posición (`jungle_route`) y el oro sólo dice cuánto valió cada tramo.
//!
//! Sólo existe para partidas grabadas desde la v1.2.31: las anteriores no
//! tienen el fichero y el panel lo dice.

use crate::riot_api::TimelineDto;
use serde::{Deserialize, Serialize};
use std::path::Path;

const FICHERO: &str = "gold_series.json";

/// Oro pasivo: 20,4 cada 10 s desde el 1:50 (reglas actuales de la Grieta).
/// Se descuenta de cada subida antes de buscarle origen.
const PASIVO_POR_S: f64 = 2.04;
const PASIVO_DESDE: f64 = 110.0;
/// Una subida a menos de esto de un evento se le atribuye a ese evento.
const VENTANA_EVENTO: f64 = 1.5;
/// Entre dos muestras separadas más que esto no se reparte nada (el bucle se
/// atascó o el cliente no respondió): la subida va a "otros".
const HUECO_MAX: f64 = 5.0;

#[derive(Serialize, Deserialize)]
struct Fichero {
    v: u32,
    /// (segundo de partida, oro actual)
    samples: Vec<(f64, f64)>,
}

/// Guarda la serie de la partida. Una serie vacía (la Live Client API no
/// respondió nunca) no deja fichero: "no hay datos" tiene que distinguirse de
/// "hay datos y son cero".
pub fn write(dir: &Path, samples: &[(f64, f64)]) {
    if samples.len() < 10 {
        return;
    }
    let f = Fichero { v: 1, samples: samples.to_vec() };
    if let Ok(s) = serde_json::to_string(&f) {
        if let Err(e) = std::fs::write(dir.join(FICHERO), s) {
            eprintln!("No se pudo guardar el oro de la partida: {e}");
        }
    }
}

fn load(match_id: &str) -> Option<Vec<(f64, f64)>> {
    let raw = std::fs::read_to_string(crate::storage::get_match_dir(match_id).join(FICHERO)).ok()?;
    serde_json::from_str::<Fichero>(&raw).ok().map(|f| f.samples)
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Income {
    pub passive: f64,
    /// Campamentos de jungla (sólo con ruta medida; si no, va a `farm`).
    pub camps: f64,
    /// Súbditos y monstruos sin ruta que los distinga.
    pub farm: f64,
    pub takedowns: f64,
    /// Torres, placas, dragones, Barón...: oro que se reparte al equipo.
    pub objectives: f64,
    /// Subidas que no se pudieron repartir (huecos en la serie).
    pub other: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecallGold {
    pub time: f64,
    /// Oro que llevabas al llegar.
    pub gold: f64,
    pub spent: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeathGold {
    pub time: f64,
    /// Oro sin gastar en el momento de morir.
    pub unspent: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct GoldReport {
    pub income: Income,
    pub recalls: Vec<RecallGold>,
    pub deaths: Vec<DeathGold>,
    /// Para saltar al vídeo: segundo de vídeo = de partida + esto.
    pub video_offset: f64,
    pub samples: usize,
}

/// Oro justo antes de `t` (la última muestra anterior).
fn oro_antes(serie: &[(f64, f64)], t: f64) -> Option<f64> {
    let i = serie.partition_point(|(s, _)| *s < t);
    i.checked_sub(1).map(|j| serie[j].1)
}

/// Reparte cada subida de oro entre sus posibles orígenes.
pub fn analyze(
    serie: &[(f64, f64)],
    tl: &TimelineDto,
    pid: i32,
    team: i32,
    clears: &[(f64, f64)],
    video_offset: f64,
) -> GoldReport {
    let eventos: Vec<_> = tl.info.frames.iter().flat_map(|f| f.events.iter()).collect();
    let de_mi_equipo = |id: i32| if team == 100 { (1..=5).contains(&id) } else { (6..=10).contains(&id) };
    let takedowns: Vec<f64> = eventos
        .iter()
        .filter(|e| e.event_type == "CHAMPION_KILL" && (e.killerId == pid || e.assistingParticipantIds.contains(&pid)))
        .map(|e| e.timestamp as f64 / 1000.0)
        .collect();
    let objetivos: Vec<f64> = eventos
        .iter()
        .filter(|e| match e.event_type.as_str() {
            "ELITE_MONSTER_KILL" => e.killerTeamId == team || de_mi_equipo(e.killerId),
            "BUILDING_KILL" | "TURRET_PLATE_DESTROYED" => de_mi_equipo(e.killerId) || (e.teamId != 0 && e.teamId != team),
            _ => false,
        })
        .map(|e| e.timestamp as f64 / 1000.0)
        .collect();
    let cerca = |ts: &[f64], a: f64, b: f64| ts.iter().any(|t| *t >= a - VENTANA_EVENTO && *t <= b + VENTANA_EVENTO);

    let mut income = Income::default();
    for par in serie.windows(2) {
        let ((t0, g0), (t1, g1)) = (par[0], par[1]);
        let d = g1 - g0;
        if d <= 0.0 {
            continue; // compra (o nada)
        }
        let dt = t1 - t0;
        if dt > HUECO_MAX {
            income.other += d;
            continue;
        }
        let pasivo = if t1 > PASIVO_DESDE { (PASIVO_POR_S * dt).min(d) } else { 0.0 };
        income.passive += pasivo;
        let resto = d - pasivo;
        if resto < 0.5 {
            continue;
        }
        if cerca(&takedowns, t0, t1) {
            income.takedowns += resto;
        } else if cerca(&objetivos, t0, t1) {
            income.objectives += resto;
        } else if clears.iter().any(|(a, b)| t1 >= a - 2.0 && t0 <= b + 2.0) {
            income.camps += resto;
        } else {
            income.farm += resto;
        }
    }

    let muertos = crate::jungle_route::muertes(tl, pid);
    let recalls = crate::jungle_route::visitas_a_base(tl, pid, &muertos)
        .into_iter()
        .filter(|v| !v.2)
        .filter_map(|(a, b, _)| {
            let gold = oro_antes(serie, a - 0.5)?;
            let spent: f64 = serie
                .windows(2)
                .filter(|p| p[1].0 >= a - 1.0 && p[0].0 <= b + 2.0)
                .map(|p| (p[0].1 - p[1].1).max(0.0))
                .sum();
            Some(RecallGold { time: a, gold, spent })
        })
        .collect();
    let deaths = muertos
        .iter()
        .filter_map(|(t, _, _)| Some(DeathGold { time: *t, unspent: oro_antes(serie, *t)? }))
        .collect();

    GoldReport { income, recalls, deaths, video_offset, samples: serie.len() }
}

#[derive(Serialize)]
pub struct GoldResponse {
    /// "ok", "no_series" (partida anterior a la captura) o "no_riot".
    pub status: String,
    pub report: Option<GoldReport>,
}

/// El oro de una partida, si se grabó con la captura de oro.
#[tauri::command]
pub async fn get_gold_report(match_id: String) -> GoldResponse {
    tokio::task::spawn_blocking(move || {
        let resp = |s: &str, r| GoldResponse { status: s.to_string(), report: r };
        let Some(serie) = load(&match_id) else { return resp("no_series", None) };
        let (Some(raw), Some(raw_tl)) = (
            crate::storage::load_raw_match(&match_id),
            crate::storage::load_raw_timeline(&match_id),
        ) else {
            return resp("no_riot", None);
        };
        let (Ok(m), Ok(tl)) = (
            serde_json::from_str::<crate::riot_api::MatchDto>(&raw),
            serde_json::from_str::<TimelineDto>(&raw_tl),
        ) else {
            return resp("no_riot", None);
        };
        let Ok(meta) = crate::storage::get_match_metadata(&match_id) else { return resp("no_riot", None) };
        let Some(idx) = m.info.participants.iter().position(|p| p.championName == meta.champion) else {
            return resp("no_riot", None);
        };
        let pid = idx as i32 + 1;
        let team = m.info.participants[idx].teamId;
        // Con ruta de jungla medida, los campamentos se separan de las oleadas.
        let clears: Vec<(f64, f64)> = crate::minimap::Positions::load(&match_id)
            .filter(|p| p.self_participant_id == pid)
            .and_then(|p| crate::jungle_route::build(&tl, &m.info.participants, &p))
            .filter(|r| r.agreement >= crate::jungle_route::ACUERDO_MIN)
            .map(|r| r.clears.iter().map(|c| (c.start, c.end)).collect())
            .unwrap_or_default();
        let offset = meta.video_offset.unwrap_or(0.0);
        resp("ok", Some(analyze(&serie, &tl, pid, team, &clears, offset)))
    })
    .await
    .unwrap_or(GoldResponse { status: "no_riot".into(), report: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn timeline(eventos: serde_json::Value) -> TimelineDto {
        serde_json::from_value(serde_json::json!({
            "info": { "frames": [ { "timestamp": 0, "events": eventos, "participantFrames": {} } ] }
        }))
        .unwrap()
    }

    #[test]
    fn reparte_el_oro_por_origen() {
        // Pasivo puro de 200 a 205; un kill a los 206 (+300); un campamento de
        // 210 a 214 (+100); una compra a los 217 (−500); oleada a los 220 (+60),
        // ya fuera del margen de 2 s del campamento.
        let serie = vec![
            (200.0, 1000.0), (205.0, 1010.2), (206.0, 1312.24), (207.0, 1314.28),
            (210.0, 1320.4), (214.0, 1428.56), (217.0, 934.68), (220.0, 1000.8),
        ];
        let tl = timeline(serde_json::json!([
            { "type": "CHAMPION_KILL", "timestamp": 206000, "killerId": 3, "victimId": 8 }
        ]));
        let r = analyze(&serie, &tl, 3, 100, &[(210.0, 214.0)], 0.0);
        assert!((r.income.takedowns - 300.0).abs() < 1.0, "{:?}", r.income);
        assert!((r.income.camps - 100.0).abs() < 1.0, "{:?}", r.income);
        assert!((r.income.farm - 60.0).abs() < 1.0, "{:?}", r.income);
        assert!((r.income.passive - 2.04 * 17.0).abs() < 1.0, "{:?}", r.income);
    }

    #[test]
    fn oro_al_morir_y_al_volver() {
        let serie = vec![(100.0, 400.0), (200.0, 1300.0), (201.0, 1302.0), (202.0, 300.0), (300.0, 1800.0)];
        let tl = timeline(serde_json::json!([
            { "type": "ITEM_PURCHASED", "timestamp": 201500, "participantId": 3 },
            { "type": "CHAMPION_KILL", "timestamp": 300500, "killerId": 8, "victimId": 3 }
        ]));
        let r = analyze(&serie, &tl, 3, 100, &[], 0.0);
        assert_eq!(r.recalls.len(), 1);
        // El oro con el que llegas: la última muestra antes de la primera compra.
        assert!((r.recalls[0].gold - 1300.0).abs() < 1e-9);
        assert!((r.recalls[0].spent - 1002.0).abs() < 1e-9);
        assert_eq!(r.deaths.len(), 1);
        assert!((r.deaths[0].unspent - 1800.0).abs() < 1e-9);
    }
}
