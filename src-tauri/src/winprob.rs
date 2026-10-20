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
    pub const SESGO: f64 = -0.03795;
    pub const MINUTO: f64 = 0.00973;
    pub const MINUTO2: f64 = 0.00090;
    pub const ORO_DIF: f64 = 0.15686;
    pub const ORO_DIF_X_MINUTO: f64 = 0.02574;
    pub const XP_DIF: f64 = 0.08164;
    pub const TORRES_DIF: f64 = 0.08517;
    pub const INHIBS_ABIERTOS_DIF: f64 = 0.26964;
    pub const DRAGONES_DIF: f64 = 0.23844;
    pub const ALMA_DIF: f64 = 0.26584;
    pub const ANCESTRAL: f64 = 0.03747;
    pub const BARON_ACTIVO: f64 = 0.05991;
    pub const KILLS_DIF: f64 = 0.02253;
}

/// Cuánto dura la mejora del barón, en minutos.
const BARON_DURA: f64 = 3.0;

/// Cuánto dura el dragón ancestral.
const ELDER_DURA: f64 = 2.5;

/// Cuánto tarda un inhibidor en reaparecer.
const INHIB_RESPAWN: f64 = 5.0;

/// El oro de un asesinato reparte más que su `bounty`: las asistencias cobran
/// aparte. El factor sale de la misma regresión que midió los objetivos, donde
/// el coeficiente del oro de asesinatos da 1,5 de forma estable en muestras muy
/// distintas (18 partidas y 1.250).
const FACTOR_ASISTENCIAS: f64 = 1.5;

/// Estado de la partida visto desde el equipo 100.
#[derive(Debug, Clone, Default)]
pub struct State {
    pub minute: f64,
    /// En miles de oro, equipo 100 menos equipo 200.
    pub gold_diff: f64,
    pub xp_diff: f64,
    pub towers_diff: f64,
    /// Minutos en que cayó cada inhibidor de cada equipo. Se guardan los
    /// instantes y no un contador porque un inhibidor **reaparece a los 5
    /// minutos**: lo que mueve la probabilidad es cuántos están abiertos ahora,
    /// no cuántos han caído en toda la partida. Con el contador acumulado, el
    /// modelo mezclaba dos cosas distintas y el coeficiente salía pequeño.
    pub inhibs_100: Vec<f64>,
    pub inhibs_200: Vec<f64>,
    pub dragons_diff: f64,
    /// El equipo tiene el alma (4 dragones). Permanente, y de las variables con
    /// más peso del modelo.
    pub soul_100: f64,
    pub soul_200: f64,
    /// Minuto en que se tomó el dragón ancestral.
    pub elder_100: f64,
    pub elder_200: f64,
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
        let abiertos = |v: &[f64]| {
            v.iter().filter(|t| self.minute - **t < INHIB_RESPAWN).count() as f64
        };
        // Los abiertos DEL RIVAL son buenos para el 100, de ahí el orden.
        let inhibs = abiertos(&self.inhibs_200) - abiertos(&self.inhibs_100);
        let ancestral = if self.minute - self.elder_100 <= ELDER_DURA {
            1.0
        } else if self.minute - self.elder_200 <= ELDER_DURA {
            -1.0
        } else {
            0.0
        };

        let z = coef::SESGO
            + coef::MINUTO * m
            + coef::MINUTO2 * m * m
            + coef::ORO_DIF * self.gold_diff
            + coef::ORO_DIF_X_MINUTO * self.gold_diff * m
            + coef::XP_DIF * self.xp_diff
            + coef::TORRES_DIF * self.towers_diff
            + coef::INHIBS_ABIERTOS_DIF * inhibs
            + coef::DRAGONES_DIF * self.dragons_diff
            + coef::ALMA_DIF * (self.soul_100 - self.soul_200)
            + coef::ANCESTRAL * ancestral
            + coef::BARON_ACTIVO * baron
            + coef::KILLS_DIF * self.kills_diff;
        calibrar(z)
    }
}

/// Curva que convierte la puntuación del modelo en probabilidad de verdad.
///
/// La logística sola no vale aquí. Con ella el modelo salía **sesgado en forma
/// de S**: en el centro acertaba, pero decía 64,7% donde se ganaba el 70,7%, y
/// 85% donde se ganaba el 83%. Un factor de escala no arregla eso, porque lo que
/// sobra en un tramo falta en otro; sólo estira la curva entera.
///
/// Esta tabla es una regresión isotónica: no supone ninguna forma, sólo que a
/// más puntuación, más probabilidad. Medido **fuera de muestra**, el desvío
/// medio de calibración baja de 2,49 puntos a 1,21.
///
/// Importa más de lo que parece: el WPA es una **diferencia** de probabilidades,
/// así que un sesgo que se coma seis puntos en la zona del 65% desfigura el
/// valor de todas las jugadas que ocurren ahí, que son muchas.
///
/// La sale de `tools/corpus/fit_winprob2.py`, indexada por la misma puntuación
/// que calcula `prob()` — con la escala ya dentro de los coeficientes.
pub const CALIBRACION: [(f64, f64); 24] = [
    (-9.73428, 0.00000),
    (-3.63299, 0.03025),
    (-2.60228, 0.10040),
    (-1.91401, 0.19197),
    (-1.39437, 0.20507),
    (-0.99446, 0.25800),
    (-0.70784, 0.28682),
    (-0.49754, 0.35439),
    (-0.32732, 0.38102),
    (-0.20463, 0.42081),
    (-0.11297, 0.48087),
    (-0.04443, 0.48159),
    (-0.03697, 0.49659),
    (0.00828, 0.53000),
    (0.09479, 0.56625),
    (0.20215, 0.57466),
    (0.34086, 0.67442),
    (0.54068, 0.70033),
    (0.80461, 0.74286),
    (1.16183, 0.77997),
    (1.63882, 0.82879),
    (2.30868, 0.88312),
    (3.30458, 0.95077),
    (9.36018, 1.00000),
];

/// Interpola la tabla. Fuera de sus extremos devuelve el valor del extremo: no
/// hay datos más allá y extrapolar una isotónica es inventar.
pub fn calibrar(z: f64) -> f64 {
    let t = &CALIBRACION;
    if z <= t[0].0 {
        return t[0].1;
    }
    if z >= t[t.len() - 1].0 {
        return t[t.len() - 1].1;
    }
    let i = t.partition_point(|(zz, _)| *zz <= z).max(1);
    let (z0, p0) = t[i - 1];
    let (z1, p1) = t[i];
    if (z1 - z0).abs() < 1e-9 {
        return p1;
    }
    p0 + (p1 - p0) * (z - z0) / (z1 - z0)
}

/// Lo que una jugada movió la probabilidad de victoria.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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

/// Probabilidad de victoria en un fotograma de minuto.
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct WpPoint {
    /// Segundos de partida: el `timestamp` del fotograma.
    pub time: f64,
    /// Probabilidad de que gane el equipo 100. La del 200 es `1 - p100`.
    pub p100: f64,
}

/// Recorre la partida y valora cada jugada por lo que movió la probabilidad.
///
/// El WPA se calcula aislando el efecto de la jugada: se toma el estado justo
/// antes y se le aplica **sólo** lo que esa jugada cambia. Restar estados de
/// minutos consecutivos mezclaría todo lo que pasó en ese minuto.
pub fn plays(tl: &TimelineDto, participants: &[ParticipantDto]) -> Vec<Play> {
    plays_and_curve(tl, participants).0
}

/// Las jugadas y, con el mismo recorrido, la probabilidad en cada fotograma.
///
/// La curva sale del mismo `State` que valora las jugadas, así que un salto en
/// ella es la suma de las jugadas de ese minuto más lo que movieron el oro y la
/// experiencia. Riot mete en el fotograma *i* los eventos ocurridos **antes**
/// de su `timestamp`; por eso cada punto se toma después de aplicarlos.
pub fn plays_and_curve(tl: &TimelineDto, participants: &[ParticipantDto]) -> (Vec<Play>, Vec<WpPoint>) {
    let team_of = |pid: i32| participants.get((pid - 1) as usize).map(|p| p.teamId);
    let mut st = State {
        baron_100: -99.0,
        baron_200: -99.0,
        elder_100: -99.0,
        elder_200: -99.0,
        ..Default::default()
    };
    let mut out = Vec::new();
    let mut curve = Vec::with_capacity(tl.info.frames.len());
    let punto = |st: &State, sec: f64| -> WpPoint {
        let (oro, xp) = diffs_at(tl, participants, sec);
        let s = State { minute: sec / 60.0, gold_diff: oro, xp_diff: xp, ..st.clone() };
        WpPoint { time: sec, p100: s.win_prob() }
    };

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
                    if let Some(eq) = team_of(ev.killerId) {
                        let mut s = st.clone();
                        s.kills_diff += if eq == 100 { 1.0 } else { -1.0 };
                        let g = (ev.bounty + ev.shutdownBounty) as f64 * FACTOR_ASISTENCIAS / 1000.0;
                        (eq, "kill", g, s)
                    } else {
                        // Ejecución: te mata una torre, un esbirro o un monstruo
                        // (killerId 0). Riot no paga recompensa, pero el tiempo
                        // muerto es el mismo, y eso es lo que mide `KILLS_DIF` con
                        // el oro y la experiencia fijos. Antes costaban 0.
                        //
                        // Aproximación consciente: el modelo se entrenó contando
                        // sólo kills con killerId de campeón (`fit_winprob2.py`),
                        // así que las ejecuciones nunca entraron en `kills_dif`.
                        // Afinarlo exigiría reentrenar con muertes en vez de kills.
                        let Some(victima) = team_of(ev.victimId) else { continue };
                        let eq = if victima == 100 { 200 } else { 100 };
                        let mut s = st.clone();
                        s.kills_diff += if eq == 100 { 1.0 } else { -1.0 };
                        (eq, "execution", 0.0, s)
                    }
                }
                "BUILDING_KILL" => {
                    let Some(eq) = team_of(ev.killerId) else { continue };
                    let signo = if eq == 100 { 1.0 } else { -1.0 };
                    let mut s = st.clone();
                    let inhib = ev.buildingType.as_deref() == Some("INHIBITOR_BUILDING");
                    if inhib {
                        // Cae el inhibidor DEL RIVAL de quien lo tira.
                        if eq == 100 { s.inhibs_200.push(st.minute) } else { s.inhibs_100.push(st.minute) }
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
                    (eq, "plate", crate::attribution::PESO_PLACA / 1000.0, st.clone())
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
                    let mut s = st.clone();
                    let (kind, g) = match ev.monsterType.as_deref() {
                        Some("DRAGON") => {
                            if ev.monsterSubType.as_deref() == Some("ELDER_DRAGON") {
                                if eq == 100 { s.elder_100 = st.minute } else { s.elder_200 = st.minute }
                            } else {
                                s.dragons_diff += signo;
                                // El cuarto dragón da el alma, que es permanente
                                // y de lo que más pesa en el modelo.
                                let propios = if eq == 100 {
                                    s.dragons_diff.max(0.0)
                                } else {
                                    (-s.dragons_diff).max(0.0)
                                };
                                if propios >= 4.0 {
                                    if eq == 100 { s.soul_100 = 1.0 } else { s.soul_200 = 1.0 }
                                }
                            }
                            ("dragon", crate::attribution::PESO_DRAGON)
                        }
                        Some("BARON_NASHOR") => {
                            if eq == 100 { s.baron_100 = st.minute } else { s.baron_200 = st.minute }
                            ("baron", crate::attribution::PESO_BARON)
                        }
                        Some("RIFTHERALD") => ("herald", crate::attribution::PESO_HERALDO),
                        Some("HORDE") => ("grubs", crate::attribution::PESO_GRUBS),
                        // Atakhan se queda sin valorar A PROPÓSITO. No sale en
                        // los datos de esta temporada: 0 de 618 partidas
                        // muestreadas del corpus (parches 16.14-16.16) y 0 de
                        // las 26 grabadas tienen un ELITE_MONSTER_KILL suyo.
                        // Valorarlo exige medirlo, como el resto de objetivos
                        // (un peso en oro de la regresión de `attribution`, o
                        // una variable del modelo y reentrenar), y sin partidas
                        // con Atakhan cualquier número sería inventado.
                        Some("ATAKHAN") => continue,
                        _ => continue,
                    };
                    (eq, kind, g / 1000.0, s)
                }
                _ => continue,
            };

            despues.gold_diff += if equipo == 100 { oro_extra } else { -oro_extra };

            // Desde la óptica de quien la hizo.
            let despues_p_calc = despues.win_prob();
            let (antes_p, despues_p) = if equipo == 100 {
                (st.win_prob(), despues_p_calc)
            } else {
                (1.0 - st.win_prob(), 1.0 - despues_p_calc)
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
        curve.push(punto(&st, frame.timestamp as f64 / 1000.0));
    }
    (out, curve)
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
    // Objetivos y estructuras.
    let mut quienes: Vec<i32> = Vec::new();
    if (1..=10).contains(&ev.killerId) {
        quienes.push(ev.killerId);
    }
    quienes.extend(ev.assistingParticipantIds.iter().copied().filter(|p| (1..=10).contains(p)));
    quienes.sort_unstable();
    quienes.dedup();
    if quienes.is_empty() {
        return Vec::new();
    }

    // Para ESTRUCTURAS se pesa por el daño que cada uno hizo a torres en la
    // partida, igual que hace el reparto en oro de `attribution`. A partes
    // iguales, quien deja una torre al 10% y se va no cobra nada y quien pasa a
    // rematarla cobra lo mismo que quien la tiró — el mismo problema del último
    // golpe en un asesinato.
    //
    // No es tan fino como el de los asesinatos: la timeline no dice quién pegó a
    // ESTA torre, sólo el total de la partida. Pero corrige el sesgo grande.
    //
    // Para monstruos épicos se queda a partes iguales: ahí
    // `damageDealtToObjectives` mezcla jungla neutral con épicos y no discrimina.
    let estructura = matches!(
        ev.event_type.as_str(),
        "BUILDING_KILL" | "TURRET_PLATE_DESTROYED"
    );
    let pesos: Vec<f64> = quienes
        .iter()
        .map(|pid| {
            if !estructura {
                return 1.0;
            }
            participants
                .get((*pid - 1) as usize)
                .map(|p| p.damageDealtToTurrets as f64)
                .unwrap_or(0.0)
        })
        .collect();
    let total: f64 = pesos.iter().sum();
    let n = quienes.len() as f64;
    quienes
        .iter()
        .zip(pesos.iter())
        .map(|(pid, peso)| {
            let frac = if total > 0.0 { peso / total } else { 1.0 / n };
            (*pid, frac)
        })
        .collect()
}

/// De dónde salió el WPA de un jugador.
///
/// El total solo dice "eres el cuarto". Partido, dice *por qué*: dos jugadores
/// con el mismo número pueden ser uno que aportó mucho y murió mucho, y otro que
/// no hizo ni ruido. Es la diferencia entre un puesto y algo que revisar.
///
/// Las cuatro partes suman el total exacto, sin residuo.
#[derive(Debug, Clone, Copy, Default, serde::Serialize)]
pub struct Breakdown {
    /// Su parte de los asesinatos, repartida por el daño que puso.
    pub kills: f64,
    /// Dragones, barón, heraldo y grubs.
    pub objectives: f64,
    /// Torres, inhibidores y placas.
    pub structures: f64,
    /// Lo que costaron sus muertes. Siempre ≤ 0.
    pub deaths: f64,
}

impl Breakdown {
    pub fn total(&self) -> f64 {
        self.kills + self.objectives + self.structures + self.deaths
    }
}

/// WPA por jugador, desglosado por origen.
pub fn per_player_breakdown(plays: &[Play]) -> std::collections::HashMap<i32, Breakdown> {
    let mut out: std::collections::HashMap<i32, Breakdown> = std::collections::HashMap::new();
    for p in plays {
        for (pid, frac) in &p.shares {
            let b = out.entry(*pid).or_default();
            let v = p.wpa * frac;
            match p.kind.as_str() {
                // Una ejecución casi nunca reparte (nadie del bando que cobra
                // pegó), pero si alguien pegó antes es su parte de un asesinato.
                "kill" | "execution" => b.kills += v,
                "tower" | "inhibitor" | "plate" => b.structures += v,
                _ => b.objectives += v,
            }
        }
        // Morir cuesta lo que la muerte le dio al rival. Se carga entera a quien
        // murió: es su evento, igual que el asesinato es de quien lo hizo.
        if let Some(v) = p.victim {
            out.entry(v).or_default().deaths -= p.wpa;
        }
    }
    out
}

/// WPA acumulado por jugador en toda la partida.
///
/// Es la suma del desglose, y se calcula así a propósito: si se sumaran por
/// separado, cualquier retoque en uno dejaría el otro contando otra cosa.
///
/// Sólo la usan los baremos y los tests: la app pide el desglose, que trae esto
/// dentro. De ahí el `cfg(test)`.
#[cfg(test)]
pub fn per_player(plays: &[Play]) -> std::collections::HashMap<i32, f64> {
    per_player_breakdown(plays)
        .into_iter()
        .map(|(pid, b)| (pid, b.total()))
        .collect()
}

/// Partidas de mentira para los tests: diez jugadores con el oro empatado y los
/// eventos que pida cada prueba. Las comparten los tests de `muertes`.
#[cfg(test)]
pub(crate) mod fixtures {
    use crate::riot_api::{ParticipantDto, TimelineDto};

    pub const ROLES: [&str; 5] = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];

    /// 1-5 son el equipo 100 y 6-10 el 200, en el orden de `ROLES`.
    pub fn diez() -> Vec<ParticipantDto> {
        (0..10)
            .map(|i| {
                serde_json::from_value(serde_json::json!({
                    "puuid": format!("p{i}"),
                    "kills": 0, "deaths": 0, "assists": 0, "goldEarned": 0,
                    "totalDamageDealtToChampions": 0,
                    "win": i < 5,
                    "teamId": if i < 5 { 100 } else { 200 },
                    "teamPosition": ROLES[i % 5],
                    "championName": format!("Campeon{}", i + 1),
                }))
                .unwrap()
            })
            .collect()
    }

    /// Una partida de `minutos` fotogramas con todos los eventos en el que toca
    /// por su `timestamp` (Riot mete en el fotograma *i* lo ocurrido antes de
    /// él). El oro y la experiencia van empatados para que sólo cuenten los
    /// eventos.
    pub fn partida(minutos: usize, eventos: Vec<serde_json::Value>) -> TimelineDto {
        let pf: serde_json::Map<String, serde_json::Value> = (1..=10)
            .map(|p| (p.to_string(), serde_json::json!({ "participantId": p, "totalGold": 500, "xp": 0, "level": 6 })))
            .collect();
        let mut frames: Vec<serde_json::Value> = (0..=minutos)
            .map(|m| serde_json::json!({ "timestamp": m * 60_000, "events": [], "participantFrames": pf }))
            .collect();
        for e in eventos {
            let ts = e["timestamp"].as_i64().unwrap();
            let i = ((ts + 59_999) / 60_000).clamp(0, minutos as i64) as usize;
            frames[i]["events"].as_array_mut().unwrap().push(e);
        }
        serde_json::from_value(serde_json::json!({ "info": { "frames": frames } })).unwrap()
    }

    pub fn kill(ts: i64, killer: i32, victim: i32, assists: &[i32], x: i32, y: i32) -> serde_json::Value {
        serde_json::json!({
            "type": "CHAMPION_KILL", "timestamp": ts, "killerId": killer, "victimId": victim,
            "assistingParticipantIds": assists, "bounty": 0, "shutdownBounty": 0,
            "position": { "x": x, "y": y },
        })
    }

    pub fn monstruo(ts: i64, team: i32, tipo: &str) -> serde_json::Value {
        serde_json::json!({
            "type": "ELITE_MONSTER_KILL", "timestamp": ts, "killerTeamId": team,
            "killerId": if team == 100 { 2 } else { 7 }, "monsterType": tipo,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    /// Te ejecuta una torre: antes costaba 0 porque el evento no tiene
    /// killerId de campeón. Ahora vale lo mismo que un asesinato sin
    /// recompensa, y lo paga quien murió.
    #[test]
    fn una_ejecucion_cuesta_como_un_asesinato_sin_recompensa() {
        let ps = diez();
        let ejecucion = plays(&partida(10, vec![kill(300_000, 0, 1, &[], 7000, 7000)]), &ps);
        assert_eq!(ejecucion.len(), 1, "la ejecución no salió como jugada");
        let j = &ejecucion[0];
        assert_eq!(j.kind, "execution");
        assert_eq!(j.team_id, 200, "cobra el equipo rival de quien murió");
        assert_eq!(j.victim, Some(1));
        assert!(j.shares.is_empty(), "nadie pegó: nadie cobra crédito");
        assert!(j.wpa > 0.0, "una muerte del 100 tiene que subir al 200: {}", j.wpa);

        // El mismo instante, pero matado por un campeón y sin recompensa.
        let asesinato = plays(&partida(10, vec![kill(300_000, 6, 1, &[], 7000, 7000)]), &ps);
        assert!((asesinato[0].wpa - j.wpa).abs() < 1e-12, "{} vs {}", asesinato[0].wpa, j.wpa);

        let d = per_player_breakdown(&ejecucion);
        assert!((d[&1].deaths + j.wpa).abs() < 1e-12, "la ejecución no se le carga a quien murió");
    }

    /// Atakhan no existe en los datos de esta temporada (ver la nota en
    /// `plays_and_curve`): no se valora, y el heraldo de al lado sí. Si vuelve y
    /// se mide su peso, este test es el que hay que cambiar.
    #[test]
    fn atakhan_no_se_valora_sin_datos_y_el_heraldo_si() {
        let ps = diez();
        let tl = partida(25, vec![monstruo(1_200_000, 100, "ATAKHAN"), monstruo(1_260_000, 100, "RIFTHERALD")]);
        let v = plays(&tl, &ps);
        assert_eq!(v.iter().map(|p| p.kind.as_str()).collect::<Vec<_>>(), vec!["herald"]);
        assert!(v[0].wpa > 0.0);
    }

    /// Un punto por fotograma, cada uno después de los eventos que Riot metió en
    /// él: sin eso el asesinato del minuto 4 no se vería hasta el 6.
    #[test]
    fn la_curva_tiene_un_punto_por_fotograma_tras_sus_eventos() {
        let ps = diez();
        let tl = partida(10, vec![kill(230_000, 1, 6, &[], 7000, 7000), kill(230_500, 2, 7, &[], 7000, 7000)]);
        let (jugadas, curva) = plays_and_curve(&tl, &ps);
        assert_eq!(curva.len(), 11);
        assert_eq!(curva[4].time, 240.0);
        assert!((curva[3].p100 - curva[0].p100).abs() < 0.02, "antes de los asesinatos no se mueve");
        assert!(curva[4].p100 > curva[3].p100 + 0.005, "{} → {}", curva[3].p100, curva[4].p100);
        // El salto de la curva en ese minuto es el de las dos jugadas, más lo
        // poco que mueve el reloj.
        let salto: f64 = jugadas.iter().map(|j| j.wpa).sum();
        assert!((curva[4].p100 - curva[3].p100 - salto).abs() < 0.01);
    }

    fn jugada(kind: &str, wpa: f64, shares: &[(i32, f64)], victim: Option<i32>) -> Play {
        Play {
            time: 600.0,
            kind: kind.to_string(),
            team_id: 100,
            before: 0.5,
            after: 0.5 + wpa,
            wpa,
            shares: shares.to_vec(),
            victim,
        }
    }

    /// El desglose no es una vista aparte: es de donde sale el total. Si las
    /// cuatro partes dejaran de sumarlo, la cabecera de Impacto diría una cosa y
    /// las barras de debajo otra.
    #[test]
    fn las_partes_del_desglose_suman_el_total() {
        let jugadas = vec![
            jugada("kill", 0.04, &[(1, 0.7), (2, 0.3)], Some(6)),
            jugada("dragon", 0.03, &[(1, 0.5), (3, 0.5)], None),
            jugada("tower", 0.02, &[(1, 1.0)], None),
            jugada("plate", 0.01, &[(2, 1.0)], None),
            jugada("baron", 0.05, &[(3, 1.0)], None),
        ];
        let desglose = per_player_breakdown(&jugadas);
        let total = per_player(&jugadas);
        for (pid, b) in &desglose {
            assert!(
                (b.total() - total[pid]).abs() < 1e-9,
                "el desglose de {pid} no suma su total"
            );
        }

        let yo = &desglose[&1];
        assert!((yo.kills - 0.028).abs() < 1e-9, "kills: {}", yo.kills);
        assert!((yo.objectives - 0.015).abs() < 1e-9, "objetivos: {}", yo.objectives);
        assert!((yo.structures - 0.02).abs() < 1e-9, "estructuras: {}", yo.structures);
        assert_eq!(yo.deaths, 0.0, "no murió: no debe restarle nada");
    }

    /// Morir es lo único que resta, y resta entero: es el evento de quien muere,
    /// igual que el asesinato es de quien lo hace. Sin esto, quien alimentaba sin
    /// parar salía en positivo.
    #[test]
    fn morir_resta_y_se_carga_a_quien_murio() {
        let jugadas = vec![jugada("kill", 0.06, &[(1, 1.0)], Some(7))];
        let d = per_player_breakdown(&jugadas);
        assert!((d[&7].deaths + 0.06).abs() < 1e-9);
        assert_eq!(d[&7].kills, 0.0);
        assert!(d[&7].total() < 0.0);
        assert!(d[&1].total() > 0.0);
    }

    /// Las placas cuentan como estructura, no como objetivo: si cayeran en el
    /// mismo saco que el barón, "de dónde salió tu impacto" mezclaría empujar
    /// una línea con robar un objetivo.
    #[test]
    fn cada_tipo_de_jugada_cae_en_su_saco() {
        let casos = [
            ("kill", "kills"),
            ("tower", "estructuras"),
            ("inhibitor", "estructuras"),
            ("plate", "estructuras"),
            ("dragon", "objetivos"),
            ("baron", "objetivos"),
            ("herald", "objetivos"),
            ("grubs", "objetivos"),
        ];
        for (kind, saco) in casos {
            let d = per_player_breakdown(&[jugada(kind, 0.02, &[(1, 1.0)], None)]);
            let b = d[&1];
            let real = if b.kills > 0.0 {
                "kills"
            } else if b.structures > 0.0 {
                "estructuras"
            } else {
                "objetivos"
            };
            assert_eq!(real, saco, "{kind} fue a parar a {real}");
        }
    }

    #[test]
    fn una_ventaja_de_oro_sube_la_probabilidad() {
        let base = State { minute: 20.0, ..Default::default() };
        let arriba = State { gold_diff: 5.0, ..base.clone() };
        let abajo = State { gold_diff: -5.0, ..base.clone() };
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

#[cfg(test)]
mod calibracion_tests {
    use super::*;

    #[test]
    fn la_curva_calibrada_es_monotona_y_esta_acotada() {
        let mut anterior = -1.0;
        let mut z = -12.0;
        while z <= 12.0 {
            let p = calibrar(z);
            assert!((0.0..=1.0).contains(&p), "z={z}: probabilidad fuera de rango: {p}");
            assert!(p >= anterior - 1e-9, "z={z}: la probabilidad baja al subir la puntuación");
            anterior = p;
            z += 0.05;
        }
    }

    #[test]
    fn una_ventaja_clara_vale_mas_que_un_empate() {
        // Sin esto, un error de signo o de unidades en la tabla pasaría
        // desapercibido: la monotonía sola se cumple con una curva plana.
        assert!(calibrar(0.0) > 0.35 && calibrar(0.0) < 0.65, "el empate no está cerca del 50%");
        assert!(calibrar(2.0) > 0.80, "una ventaja grande debería pasar del 80%");
        assert!(calibrar(-2.0) < 0.20, "una desventaja grande debería bajar del 20%");
    }
}
