//! Las jugadas de una partida con lo que movió cada una la probabilidad de
//! victoria, y la curva de esa probabilidad minuto a minuto.
//!
//! `winprob::plays` ya lo calculaba para repartir el WPA y lo tiraba. Es la
//! materia prima del coach de macro (`docs/coach-de-macro-diseno.md`, §2.1):
//! una jugada concreta con su ΔWP, en vez de una estadística agregada.
//!
//! Sólo lee lo que ya está en disco (`riot_match.json` y `riot_timeline.json`):
//! no gasta cuota de la API.

use serde::{Deserialize, Serialize};

use crate::riot_api::{MatchDto, TimelineDto};
use crate::winprob::{Play, WpPoint};

/// Caché en la carpeta de la partida. Cualquier cambio en el modelo de
/// victoria o en este formato exige subir el número: un fichero viejo no se
/// distingue de uno bueno.
pub const FICHERO: &str = "plays_v2.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatchPlays {
    /// Participante (1-10) de quien grabó, si el metadata lo sabe.
    pub self_participant_id: Option<i32>,
    /// Una por evento valorado, en orden. `wpa` va desde la óptica de
    /// `team_id`; la muerte la paga `victim`.
    pub plays: Vec<Play>,
    /// Un punto por fotograma de minuto, desde la óptica del equipo 100.
    pub curve: Vec<WpPoint>,
}

/// ¿La caché es posterior a la timeline? Si se resincroniza la partida (otra
/// timeline), la caché vieja ya no vale.
fn fresca(cache: &std::path::Path, timeline: &std::path::Path) -> bool {
    let mtime = |p: &std::path::Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    matches!((mtime(cache), mtime(timeline)), (Some(c), Some(t)) if c >= t)
}

fn cargar_o_calcular(match_id: &str) -> Result<MatchPlays, String> {
    // El metadata primero: sin él la partida no existe, y `get_match_dir`
    // crearía una carpeta vacía con ese nombre.
    let meta = crate::storage::get_match_metadata(match_id)?;
    de_partida(&meta)
}

/// Lo mismo con el metadata ya leído. Quien recorre la biblioteca entera
/// (`estado_partida`) lo tiene de `load_all_matches`, sin la estela del ratón:
/// volver a leerlo con `get_match_metadata` multiplicaba el tiempo por diez.
pub(crate) fn de_partida(meta: &crate::storage::MatchMetadata) -> Result<MatchPlays, String> {
    let match_id = meta.id.as_str();
    let cache = crate::storage::get_match_dir(match_id).join(FICHERO);
    if fresca(&cache, &crate::storage::get_timeline_path(match_id)) {
        if let Some(v) = std::fs::read_to_string(&cache).ok().and_then(|r| serde_json::from_str(&r).ok()) {
            return Ok(v);
        }
    }

    let (Some(raw), Some(raw_tl)) = (
        crate::storage::load_raw_match(match_id),
        crate::storage::load_raw_timeline(match_id),
    ) else {
        return Err("Esta partida aún no está sincronizada con Riot".to_string());
    };
    let m: MatchDto = serde_json::from_str(&raw).map_err(|e| format!("riot_match.json ilegible: {e}"))?;
    let tl: TimelineDto = serde_json::from_str(&raw_tl).map_err(|e| format!("riot_timeline.json ilegible: {e}"))?;

    let (plays, curve) = crate::winprob::plays_and_curve(&tl, &m.info.participants);
    let out = MatchPlays {
        self_participant_id: meta.participants.iter().position(|p| p.is_self).map(|i| i as i32 + 1),
        plays,
        curve,
    };
    if let Ok(texto) = serde_json::to_string(&out) {
        let _ = std::fs::write(&cache, texto);
    }
    Ok(out)
}

/// Jugadas y curva de probabilidad de una partida ya sincronizada.
#[tauri::command]
pub async fn get_match_plays(match_id: String) -> Result<MatchPlays, String> {
    tokio::task::spawn_blocking(move || cargar_o_calcular(&match_id))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::winprob::fixtures::{diez, kill, partida};

    /// La caché tiene que devolver exactamente lo calculado: si al leerla se
    /// perdiera un campo, la segunda apertura de la partida diría otra cosa
    /// que la primera.
    #[test]
    fn la_cache_devuelve_lo_mismo_que_se_calculo() {
        let ps = diez();
        let tl = partida(5, vec![kill(130_000, 1, 6, &[2], 7000, 7000), kill(200_000, 0, 3, &[], 7000, 7000)]);
        let (plays, curve) = crate::winprob::plays_and_curve(&tl, &ps);
        let antes = MatchPlays { self_participant_id: Some(3), plays, curve };
        let despues: MatchPlays = serde_json::from_str(&serde_json::to_string(&antes).unwrap()).unwrap();
        // `serde_json` no garantiza releer el último bit de un f64: se compara
        // con tolerancia, que para probabilidades sobra.
        let cerca = |a: f64, b: f64| (a - b).abs() < 1e-12;
        assert_eq!(despues.self_participant_id, Some(3));
        assert_eq!(despues.plays.len(), antes.plays.len());
        for (a, b) in antes.plays.iter().zip(despues.plays.iter()) {
            assert_eq!((a.kind.as_str(), a.team_id, a.victim, a.shares.len()), (b.kind.as_str(), b.team_id, b.victim, b.shares.len()));
            assert!(cerca(a.time, b.time) && cerca(a.before, b.before) && cerca(a.after, b.after) && cerca(a.wpa, b.wpa));
        }
        assert_eq!(despues.plays[1].kind, "execution");
        assert_eq!(despues.curve.len(), 6);
        for (a, b) in antes.curve.iter().zip(despues.curve.iter()) {
            assert!(cerca(a.time, b.time) && cerca(a.p100, b.p100));
        }
    }
}
