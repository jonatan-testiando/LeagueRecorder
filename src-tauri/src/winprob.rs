//! Probabilidad de victoria y valor de cada jugada (WPA).
//!
//! Es la pieza que da una moneda común a todo lo demás. Hasta aquí el valor se
//! medía en oro, y el oro no sabe cotizar aguantar daño, poner visión ni atraer
//! a cuatro rivales a tu carril. La probabilidad de victoria sí: **lo que la
//! mueve vale, y lo que no la mueve no**.
//!
//! El valor de una jugada es cuánto movió esa probabilidad — *Win Probability
//! Added*, el estándar en analítica de baloncesto y hockey. Y resuelve el
//! problema de raíz de este proyecto: **la API de Riot no expone ninguna
//! etiqueta de MVP**, pero sí expone quién ganó cada partida, que es todo lo que
//! hace falta para entrenar esto.
//!
//! Consecuencia útil: un jugador del equipo perdedor puede acumular WPA alto.
//! Eso es el ACE bien definido, no un premio de consolación.

use crate::riot_api::{ParticipantDto, TimelineDto};

/// Coeficientes de la regresión logística, ajustados con
/// `tools/corpus/fit_winprob.py` sobre el corpus de partidas.
///
/// Todo va desde la óptica del **equipo 100**: las diferencias son equipo 100
/// menos equipo 200, y el resultado es la probabilidad de que gane el 100.
///
/// Rendimiento medido sobre partidas que no se usaron para entrenar (la
/// separación es por partida, no por estado: dos minutos de la misma partida
/// comparten resultado y mezclarlos inflaría el acierto):
/// AUC 0,797 y pérdida 0,535 frente a 0,693 de una moneda al aire. La
/// calibración, que es lo que de verdad importa para atribuir, es buena: cuando
/// dice 25% gana el 26%, cuando dice 95% gana el 97%.
///
/// El ajuste usa regularización alta a propósito. Ver la nota de `entrenar` en
/// el script: con poca, torres y barón salen con coeficiente **negativo** por
/// colinealidad con el oro. Para predecir da igual; para atribuir convertiría
/// tirar una torre en un demérito.
mod coef {
    pub const SESGO: f64 = -0.04457;
    pub const MINUTO: f64 = 0.00423;
    pub const ORO_DIF: f64 = 0.11582;
    pub const ORO_DIF_X_MINUTO: f64 = 0.02214;
    pub const XP_DIF: f64 = 0.06288;
    pub const TORRES_DIF: f64 = 0.02332;
    pub const INHIBS_DIF: f64 = 0.03879;
    pub const DRAGONES_DIF: f64 = 0.18035;
    pub const BARON_ACTIVO: f64 = -0.02849;
    pub const KILLS_DIF: f64 = 0.02122;
}

/// Cuánto dura la mejora del barón, en minutos.
const BARON_DURA: f64 = 3.0;

/// El oro de un asesinato reparte más que su `bounty`: las asistencias cobran
/// aparte. El factor sale de la misma regresión que midió los objetivos, donde
/// el coeficiente del oro de asesinatos da 1,5 de forma estable en muestras muy
/// distintas (18 partidas y 1.250).
const FACTOR_ASISTENCIAS: f64 = 1.5;

/// Estado de la partida visto desde el equipo 100.
#[derive(Debug, Clone, Copy, Default)]
pub struct State {
    pub minute: f64,
    /// En miles de oro, equipo 100 menos equipo 200.
    pub gold_diff: f64,
    pub xp_diff: f64,
    pub towers_diff: f64,
    pub inhibs_diff: f64,
    pub dragons_diff: f64,
    /// Minuto en que el equipo 100 tomó barón (negativo si ninguno).
    pub baron_100: f64,
    pub baron_200: f64,
    pub kills_diff: f64,
}

impl State {
    /// Probabilidad de que gane el equipo 100.
    pub fn win_prob(&self) -> f64 {
        let m = self.minute / 10.0;
        let baron = if self.minute - self.baron_100 <= BARON_DURA {
            1.0
        } else if self.minute - self.baron_200 <= BARON_DURA {
            -1.0
        } else {
            0.0
        };
        let z = coef::SESGO
            + coef::MINUTO * m
            + coef::ORO_DIF * self.gold_diff
            + coef::ORO_DIF_X_MINUTO * self.gold_diff * m
            + coef::XP_DIF * self.xp_diff
            + coef::TORRES_DIF * self.towers_diff
            + coef::INHIBS_DIF * self.inhibs_diff
            + coef::DRAGONES_DIF * self.dragons_diff
            + coef::BARON_ACTIVO * baron
            + coef::KILLS_DIF * self.kills_diff;
        1.0 / (1.0 + (-z).exp())
    }
}

/// Lo que una jugada movió la probabilidad de victoria.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Play {
    /// Segundos de partida.
    pub time: f64,
    pub kind: String,
    /// Equipo que la hizo.
    pub team_id: i32,
    /// Probabilidad de victoria de ese equipo antes y después.
    pub before: f64,
    pub after: f64,
    /// `after - before`, siempre desde la óptica de quien la hizo. Positivo es
    /// bueno para él.
    pub wpa: f64,
    /// Reparto entre jugadores: `(participant_id, fracción)`. Para asesinatos
    /// sale del daño real; para objetivos, a partes iguales entre quien remató
    /// y quienes asistieron.
    pub shares: Vec<(i32, f64)>,
    /// Quién lo pagó. Sin esto el WPA sólo sumaba: cada jugador acumulaba lo
    /// bueno que hacía y morir no restaba nada, así que hasta quien alimentaba
    /// sin parar salía en positivo. Los objetivos no llevan víctima — nadie
    /// pierde una torre a título individual.
    pub victim: Option<i32>,
}

/// Interpola oro y XP entre los fotogramas de minuto.
fn diffs_at(tl: &TimelineDto, participants: &[ParticipantDto], sec: f64) -> (f64, f64) {
    let sumar = |frame: &crate::riot_api::TimelineFrame| -> (f64, f64) {
        let (mut oro, mut xp) = (0.0, 0.0);
        for (key, pf) in &frame.participantFrames {
            let Ok(pid) = key.parse::<i32>() else { continue };
            let signo = match participants.get((pid - 1) as usize) {
                Some(p) if p.teamId == 100 => 1.0,
                Some(_) => -1.0,
                None => continue,
            };
            oro += signo * pf.totalGold as f64;
            xp += signo * pf.xp as f64;
        }
        (oro / 1000.0, xp / 1000.0)
    };
    let idx = (sec / 60.0).floor() as usize;
    let a = tl.info.frames.get(idx.min(tl.info.frames.len().saturating_sub(1)));
    let b = tl.info.frames.get(idx + 1);
    match (a, b) {
        (Some(a), Some(b)) => {
            let (oa, xa) = sumar(a);
            let (ob, xb) = sumar(b);
            let f = ((sec - a.timestamp as f64 / 1000.0) / 60.0).clamp(0.0, 1.0);
            (oa + (ob - oa) * f, xa + (xb - xa) * f)
        }
        (Some(a), None) => sumar(a),
        _ => (0.0, 0.0),
    }
}

/// Recorre la partida y valora cada jugada por lo que movió la probabilidad.
///
/// El WPA se calcula aislando el efecto de la jugada: se toma el estado justo
/// antes y se le aplica **sólo** lo que esa jugada cambia. Restar estados de
/// minutos consecutivos mezclaría todo lo que pasó en ese minuto.
pub fn plays(tl: &TimelineDto, participants: &[ParticipantDto]) -> Vec<Play> {
    let team_of = |pid: i32| participants.get((pid - 1) as usize).map(|p| p.teamId);
    let mut st = State { baron_100: -99.0, baron_200: -99.0, ..Default::default() };
    let mut out = Vec::new();

    for frame in &tl.info.frames {
        for ev in &frame.events {
            let sec = ev.timestamp as f64 / 1000.0;
            st.minute = sec / 60.0;
            let (oro, xp) = diffs_at(tl, participants, sec);
            st.gold_diff = oro;
            st.xp_diff = xp;

            // Quién la hizo y qué cambia. `signo` lleva todo a la óptica del
            // equipo 100, que es como está entrenado el modelo.
            let (equipo, kind, oro_extra, mut despues) = match ev.event_type.as_str() {
                "CHAMPION_KILL" => {
                    let Some(eq) = team_of(ev.killerId) else { continue };
                    let mut s = st;
                    s.kills_diff += if eq == 100 { 1.0 } else { -1.0 };
                    let g = (ev.bounty + ev.shutdownBounty) as f64 * FACTOR_ASISTENCIAS / 1000.0;
                    (eq, "kill", g, s)
                }
                "BUILDING_KILL" => {
                    let Some(eq) = team_of(ev.killerId) else { continue };
                    let signo = if eq == 100 { 1.0 } else { -1.0 };
                    let mut s = st;
                    let inhib = ev.buildingType.as_deref() == Some("INHIBITOR_BUILDING");
                    if inhib {
                        s.inhibs_diff += signo;
                    } else {
                        s.towers_diff += signo;
                    }
                    let g = crate::attribution::peso_estructura(
                        ev.buildingType.as_deref(),
                        ev.towerType.as_deref(),
                    ) / 1000.0;
                    (eq, if inhib { "inhibitor" } else { "tower" }, g, s)
                }
                "TURRET_PLATE_DESTROYED" => {
                    let Some(eq) = team_of(ev.killerId) else { continue };
                    (eq, "plate", crate::attribution::PESO_PLACA / 1000.0, st)
                }
                "ELITE_MONSTER_KILL" => {
                    let eq = if ev.killerTeamId != 0 {
                        ev.killerTeamId
                    } else {
                        match team_of(ev.killerId) {
                            Some(t) => t,
                            None => continue,
                        }
                    };
                    let signo = if eq == 100 { 1.0 } else { -1.0 };
                    let mut s = st;
                    let (kind, g) = match ev.monsterType.as_deref() {
                        Some("DRAGON") => {
                            s.dragons_diff += signo;
                            ("dragon", crate::attribution::PESO_DRAGON)
                        }
                        Some("BARON_NASHOR") => {
                            if eq == 100 { s.baron_100 = st.minute } else { s.baron_200 = st.minute }
                            ("baron", crate::attribution::PESO_BARON)
                        }
                        Some("RIFTHERALD") => ("herald", crate::attribution::PESO_HERALDO),
                        Some("HORDE") => ("grubs", crate::attribution::PESO_GRUBS),
                        _ => continue,
                    };
                    (eq, kind, g / 1000.0, s)
                }
                _ => continue,
            };

            despues.gold_diff += if equipo == 100 { oro_extra } else { -oro_extra };

            // Desde la óptica de quien la hizo.
            let (antes_p, despues_p) = if equipo == 100 {
                (st.win_prob(), despues.win_prob())
            } else {
                (1.0 - st.win_prob(), 1.0 - despues.win_prob())
            };

            out.push(Play {
                time: sec,
                kind: kind.to_string(),
                team_id: equipo,
                before: antes_p,
                after: despues_p,
                wpa: despues_p - antes_p,
                shares: reparto(ev, equipo, participants),
                victim: if ev.event_type == "CHAMPION_KILL" && (1..=10).contains(&ev.victimId) {
                    Some(ev.victimId)
                } else {
                    None
                },
            });

            // El estado corriente incorpora la jugada.
            st = despues;
        }
    }
    out
}

/// Quién se lleva el crédito de una jugada, y en qué proporción.
fn reparto(
    ev: &crate::riot_api::TimelineEvent,
    equipo: i32,
    participants: &[ParticipantDto],
) -> Vec<(i32, f64)> {
    if ev.event_type == "CHAMPION_KILL" {
        // Por daño real: es la única jugada de la que Riot dice quién trabajó.
        let damage = if !ev.victimTeamfightDamageReceived.is_empty() {
            &ev.victimTeamfightDamageReceived
        } else {
            &ev.victimDamageReceived
        };
        let by: std::collections::HashMap<i32, i32> = crate::riot_api::damage_shares(damage)
            .into_iter()
            .filter(|(pid, _)| {
                participants.get((*pid - 1) as usize).map(|p| p.teamId) == Some(equipo)
            })
            .collect();
        let total: i32 = by.values().sum();
        if total > 0 {
            let mut v: Vec<(i32, f64)> =
                by.into_iter().map(|(pid, d)| (pid, d as f64 / total as f64)).collect();
            v.sort_by_key(|(pid, _)| *pid);
            return v;
        }
    }
    // Objetivos y estructuras: a partes iguales entre quien remató y quienes
    // asistieron. La timeline no dice quién puso el daño a un edificio.
    let mut quienes: Vec<i32> = Vec::new();
    if (1..=10).contains(&ev.killerId) {
        quienes.push(ev.killerId);
    }
    quienes.extend(ev.assistingParticipantIds.iter().copied().filter(|p| (1..=10).contains(p)));
    quienes.sort_unstable();
    quienes.dedup();
    let n = quienes.len() as f64;
    quienes.into_iter().map(|pid| (pid, 1.0 / n)).collect()
}

/// WPA acumulado por jugador en toda la partida.
pub fn per_player(plays: &[Play]) -> std::collections::HashMap<i32, f64> {
    let mut out = std::collections::HashMap::new();
    for p in plays {
        for (pid, frac) in &p.shares {
            *out.entry(*pid).or_insert(0.0) += p.wpa * frac;
        }
        // Morir cuesta lo que la muerte le dio al rival. Se carga entera a quien
        // murió: es su evento, igual que el asesinato es de quien lo hizo.
        if let Some(v) = p.victim {
            *out.entry(v).or_insert(0.0) -= p.wpa;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn una_ventaja_de_oro_sube_la_probabilidad() {
        let base = State { minute: 20.0, ..Default::default() };
        let arriba = State { gold_diff: 5.0, ..base };
        let abajo = State { gold_diff: -5.0, ..base };
        assert!(arriba.win_prob() > base.win_prob());
        assert!(abajo.win_prob() < base.win_prob());
        // Y la misma ventaja pesa más cuanto más tarde.
        let tarde = State { minute: 35.0, gold_diff: 5.0, ..Default::default() };
        let pronto = State { minute: 10.0, gold_diff: 5.0, ..Default::default() };
        assert!(tarde.win_prob() > pronto.win_prob());
    }

    #[test]
    fn una_partida_igualada_ronda_el_cincuenta_por_ciento() {
        let p = State { minute: 15.0, ..Default::default() }.win_prob();
        assert!((p - 0.5).abs() < 0.06, "partida plana da {p:.3}");
    }

    #[test]
    fn wpa_sobre_partidas_reales() {
        let Ok(dir) = std::env::var("ATTR_CORPUS_DIR") else {
            return;
        };
        let mut ids: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter_map(|e| e.file_name().to_str()?.strip_suffix(".match.json").map(str::to_string))
            .collect();
        ids.sort();

        let mut por_tipo: std::collections::HashMap<String, (f64, usize)> = Default::default();
        let (mut ganadores, mut total) = (0usize, 0usize);
        let mut mejor: Option<(String, String, Play)> = None;

        for id in &ids {
            let tl: TimelineDto = serde_json::from_str(
                &std::fs::read_to_string(format!("{dir}/{id}.timeline.json")).unwrap(),
            )
            .unwrap();
            let m: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(format!("{dir}/{id}.match.json")).unwrap(),
            )
            .unwrap();
            let ps: Vec<ParticipantDto> =
                serde_json::from_value(m["info"]["participants"].clone()).unwrap();

            let jugadas = plays(&tl, &ps);
            for j in &jugadas {
                let e = por_tipo.entry(j.kind.clone()).or_insert((0.0, 0));
                e.0 += j.wpa;
                e.1 += 1;
                if mejor.as_ref().map_or(true, |(_, _, b)| j.wpa > b.wpa) {
                    let quien = j
                        .shares
                        .iter()
                        .max_by(|a, b| a.1.total_cmp(&b.1))
                        .and_then(|(pid, _)| ps.get((*pid - 1) as usize))
                        .map(|p| p.championName.clone())
                        .unwrap_or_default();
                    mejor = Some((id.clone(), quien, j.clone()));
                }
            }

            // El jugador con más WPA debería estar en el equipo ganador la
            // mayoría de las veces. No siempre: el ACE del equipo perdedor
            // existe, y que exista es justamente la gracia.
            let wpa = per_player(&jugadas);
            if let Some((pid, _)) = wpa.iter().max_by(|a, b| a.1.total_cmp(b.1)) {
                if ps.get((*pid - 1) as usize).map(|p| p.win).unwrap_or(false) {
                    ganadores += 1;
                }
            }
            total += 1;
        }

        println!("\nWPA medio por tipo de jugada:");
        let mut tipos: Vec<_> = por_tipo.into_iter().collect();
        tipos.sort_by(|a, b| (b.1 .0 / b.1 .1 as f64).total_cmp(&(a.1 .0 / a.1 .1 as f64)));
        for (k, (suma, n)) in &tipos {
            println!("  {k:10} {:+7.3} de media  (n={n})", suma / *n as f64);
        }
        println!(
            "\nel de más WPA jugaba en el equipo ganador en {ganadores} de {total} partidas"
        );
        if let Some((id, quien, j)) = &mejor {
            println!(
                "jugada de más valor: {} de {quien} en el minuto {:.0} ({id})\n  \
                 la probabilidad de su equipo pasó de {:.0}% a {:.0}%  (+{:.1} puntos)",
                j.kind,
                j.time / 60.0,
                j.before * 100.0,
                j.after * 100.0,
                j.wpa * 100.0
            );
        }

        // Todas las jugadas valoradas tienen que mover algo, y ninguna puede
        // mover más de un 100%.
        for (k, (suma, n)) in &tipos {
            let media = suma / *n as f64;
            assert!(media.abs() < 1.0, "{k} da un WPA medio imposible: {media}");
        }
    }
}
