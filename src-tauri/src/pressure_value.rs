//! Lo que vale en oro un episodio de presión absorbida.
//!
//! La pregunta del jugador es concreta: *"me vienen a por mí varios; ¿cuánto
//! tiempo les hago gastar, y cuánto oro vale esa jugada?"*. La versión anterior
//! no la contestaba:
//!
//! - Solo convertía a oro los asesinatos; torres, placas y dragones se
//!   contaban pero no se sumaban, así que "6,1 k de oro" era una parte.
//! - Contaba como coste **cualquier** cosa que el rival sacara en toda la
//!   partida durante el tramo, incluidas las muertes de tus aliados en una
//!   pelea 5 contra 5. Sobre 94 episodios del usuario salían 52 "coste sin
//!   beneficio" y uno solo "beneficio sin coste": la métrica castigaba justo
//!   lo que quería premiar.
//! - No medía el tiempo de los rivales, que es la mitad del valor: mientras te
//!   persiguen, no farmean.
//! - No premiaba ganar la pelea: *"si estoy fuerte, puedo contra todos"* no
//!   sumaba nada porque lo local se descartaba entero.
//!
//! Aquí el valor tiene cuatro partes, todas en oro y todas trazables a eventos
//! o fotogramas concretos:
//!
//! 1. **Farmeo que les quitas**: los segundos que cada rival pasó encima de ti,
//!    por el ritmo de farmeo que ese rival llevaba a esa altura de la partida,
//!    por lo que vale cada súbdito o monstruo en ese minuto.
//! 2. **Lo que saca tu equipo lejos de ti** (más de `OTRA_ZONA`) mientras dura y
//!    hasta `COLA` segundos después: asesinatos, placas, torres y objetivos,
//!    valorados con los pesos medidos de `attribution`.
//! 3. **El resultado en el sitio**: asesinatos de tu equipo a menos de
//!    `RADIO_LOCAL` suman; tu muerte y las de tus aliados allí restan.
//! 4. **Tu propio farmeo perdido**: tú tampoco farmeas mientras te persiguen.
//!    Se resta con la misma vara que el de ellos.
//!
//! Lo que el rival saque lejos mientras tanto se enseña aparte (`enemy_elsewhere`)
//! y **no se resta**: con la ventaja numérica de tu lado, que el rival gane algo
//! en otra zona es de quien estaba allí, no de quien los atrajo.
//!
//! No cuenta el viaje de ida y vuelta de los rivales ni la experiencia: el
//! valor es una cota por abajo, y se dice así en la interfaz.

use std::collections::HashMap;

use crate::occupancy::Occupancy;
use crate::riot_api::{ParticipantDto, TimelineDto, TimelineEvent};

/// Oro por súbdito: `a + b · minuto`.
///
/// Medido, no tabulado (Riot cambió estos valores en 2026 y los volverá a
/// cambiar). Regresión sobre 58.005 minutos-jugador de 1.500 partidas
/// clasificatorias del corpus (`D:/lol-corpus`), excluyendo supports y los
/// minutos con asesinatos, asistencias u objetivos: el oro del minuto se explica
/// por renta pasiva + súbditos + monstruos de jungla, cada uno con pendiente por
/// minuto. R² 0,87. La renta pasiva sale en 127 de oro/min, que es la del juego
/// (≈2 por segundo): el ajuste reconoce lo que ya se sabe, que es la validación.
const ORO_SUBDITO: (f64, f64) = (16.729, 0.257);
/// Oro por monstruo de jungla (mismo ajuste).
const ORO_JUNGLA: (f64, f64) = (21.663, 0.178);

/// Qué cuenta como "donde estabas tú" para el resultado local. Algo más que el
/// radio de presión de la API (2.200) para no perder el remate de la pelea, y
/// bastante menos que `OTRA_ZONA` para no mezclarlo con lo de lejos.
pub const RADIO_LOCAL: f64 = 2500.0;

/// Minutos a cada lado para medir el ritmo de farmeo "normal" de un jugador.
const VENTANA_RITMO: usize = 3;

/// A partir de cuánto oro neto un episodio es bueno o malo. Media muerte
/// temprana: por debajo, el resultado está dentro del ruido de la estimación.
const UMBRAL_VEREDICTO: f64 = 150.0;

/// Paso del muestreo para contar cuánto tiempo pasó cada rival encima.
const PASO_ATADO: f64 = 1.0;

/// Confianza mínima para contar que un rival estaba encima en un instante.
const CERTEZA_ATADO: f64 = 0.5;

/// Un rival que tuviste atado, y lo que le costó.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct EnemyTie {
    pub participant_id: i32,
    pub champion: String,
    /// Segundos que pasó encima de ti dentro del episodio.
    pub seconds: f64,
    /// Oro de farmeo que dejó de hacer en ese tiempo.
    pub farm_gold: f64,
}

/// El valor del episodio, desglosado. Todo en oro.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct PressureValue {
    /// Suma de los segundos de cada rival atado ("2 min 06 s de rival").
    pub enemy_seconds: f64,
    pub farm_denied: f64,
    pub own_farm_lost: f64,
    /// Lo que no farmeas mientras estás muerto, si el episodio acabó en tu
    /// muerte: temporizador de muerte por tu ritmo de farmeo.
    #[serde(default)]
    pub death_farm_lost: f64,
    /// Asesinatos de tu equipo en el sitio menos muertes de tu equipo en el sitio.
    pub local_gold: f64,
    pub team_elsewhere: f64,
    /// Contexto, no se resta: ver la nota del módulo.
    pub enemy_elsewhere: f64,
    pub net: f64,
    /// "good" | "even" | "bad".
    pub verdict: String,
}

/// Quién estaba vivo en cada instante.
///
/// La detección anterior contaba a los muertos como si siguieran en el mapa. En
/// la parte final de una pelea que se pierde, con dos aliados ya muertos, el
/// que queda vivo "tenía más rivales que aliados" y salía como presión
/// absorbida, cuando lo que había era una pelea perdida.
pub struct Vivos {
    muerto: HashMap<i32, Vec<(f64, f64)>>,
}

impl Vivos {
    pub fn build(tl: &TimelineDto) -> Self {
        let mut muerto: HashMap<i32, Vec<(f64, f64)>> = HashMap::new();
        for (mi, frame) in tl.info.frames.iter().enumerate() {
            for ev in &frame.events {
                if ev.event_type != "CHAMPION_KILL" || ev.victimId <= 0 {
                    continue;
                }
                let sec = ev.timestamp as f64 / 1000.0;
                // Nivel de la víctima: el del fotograma que abre el minuto en
                // el que cae el evento (los eventos del fotograma n van de n a n+1).
                let nivel = tl.info.frames[mi]
                    .participantFrames
                    .get(&ev.victimId.to_string())
                    .map(|p| p.level)
                    .filter(|l| *l > 0)
                    .unwrap_or(1);
                let dura = crate::attribution::death_timer(nivel, sec / 60.0);
                muerto.entry(ev.victimId).or_default().push((sec, sec + dura));
            }
        }
        Vivos { muerto }
    }

    pub fn alive(&self, pid: i32, sec: f64) -> bool {
        self.muerto
            .get(&pid)
            .is_none_or(|v| !v.iter().any(|(a, b)| sec >= *a && sec < *b))
    }
}

/// Qué es un evento y cuánto oro vale para el equipo que lo consigue.
///
/// Un único sitio para valorar, compartido con la evidencia del episodio: si
/// la lista de eventos y la cifra no salen de la misma función, acaban
/// contando cosas distintas.
pub fn valor_evento(ev: &TimelineEvent) -> Option<(&'static str, f64)> {
    match ev.event_type.as_str() {
        "CHAMPION_KILL" => Some(("kill", (ev.bounty + ev.shutdownBounty).max(0) as f64)),
        "BUILDING_KILL" if ev.buildingType.as_deref() == Some("INHIBITOR_BUILDING") => Some((
            "inhibitor",
            crate::attribution::peso_estructura(ev.buildingType.as_deref(), ev.towerType.as_deref()),
        )),
        "BUILDING_KILL" => Some((
            "tower",
            crate::attribution::peso_estructura(ev.buildingType.as_deref(), ev.towerType.as_deref()),
        )),
        "TURRET_PLATE_DESTROYED" => Some(("plate", crate::attribution::PESO_PLACA)),
        "ELITE_MONSTER_KILL" => Some((
            "epic",
            match ev.monsterType.as_deref() {
                Some("DRAGON") => crate::attribution::PESO_DRAGON,
                Some("BARON_NASHOR") => crate::attribution::PESO_BARON,
                Some("RIFTHERALD") => crate::attribution::PESO_HERALDO,
                Some("HORDE") => crate::attribution::PESO_GRUBS,
                _ => 0.0,
            },
        )),
        _ => None,
    }
}

/// Equipo que se lleva el evento. En estructuras, `teamId` es el DUEÑO (y el
/// asesino puede ser un súbdito, `killerId == 0`), así que se invierte.
pub fn equipo_del_evento(ev: &TimelineEvent, participants: &[ParticipantDto]) -> Option<i32> {
    let team_of = |pid: i32| participants.get(pid.checked_sub(1)? as usize).map(|p| p.teamId);
    let estructura = matches!(ev.event_type.as_str(), "BUILDING_KILL" | "TURRET_PLATE_DESTROYED");
    if estructura && matches!(ev.teamId, 100 | 200) {
        Some(300 - ev.teamId)
    } else if matches!(ev.killerTeamId, 100 | 200) {
        Some(ev.killerTeamId)
    } else {
        team_of(ev.killerId)
    }
}

fn oro_subdito(minuto: f64) -> f64 {
    ORO_SUBDITO.0 + ORO_SUBDITO.1 * minuto
}

fn oro_jungla(minuto: f64) -> f64 {
    ORO_JUNGLA.0 + ORO_JUNGLA.1 * minuto
}

/// Ritmo de farmeo de un jugador alrededor de un minuto, en oro por segundo.
///
/// Se toma el CS de `VENTANA_RITMO` minutos a cada lado, no el del minuto del
/// episodio: en ese minuto precisamente no farmeó, y medirlo ahí daría cero.
pub fn ritmo_de_farmeo(tl: &TimelineDto, pid: i32, minuto: f64) -> f64 {
    let frames = &tl.info.frames;
    if frames.len() < 2 {
        return 0.0;
    }
    let m = (minuto.floor() as usize).min(frames.len() - 1);
    let a = m.saturating_sub(VENTANA_RITMO);
    let b = (m + VENTANA_RITMO + 1).min(frames.len() - 1);
    if b <= a {
        return 0.0;
    }
    let key = pid.to_string();
    let (Some(fa), Some(fb)) = (frames[a].participantFrames.get(&key), frames[b].participantFrames.get(&key)) else {
        return 0.0;
    };
    let span_s = (frames[b].timestamp - frames[a].timestamp) as f64 / 1000.0;
    if span_s <= 0.0 {
        return 0.0;
    }
    let subditos = (fb.minionsKilled - fa.minionsKilled).max(0) as f64;
    let jungla = (fb.jungleMinionsKilled - fa.jungleMinionsKilled).max(0) as f64;
    (subditos * oro_subdito(minuto) + jungla * oro_jungla(minuto)) / span_s
}

/// Cuánto tiempo pasó cada rival encima del jugador durante el episodio.
pub fn atados(
    occ: &Occupancy,
    vivos: &Vivos,
    participants: &[ParticipantDto],
    pid: i32,
    start: f64,
    end: f64,
    radio: f64,
    enemy_count: usize,
) -> Vec<EnemyTie> {
    let Some(yo) = participants.get((pid - 1) as usize) else { return Vec::new() };
    let rival = 300 - yo.teamId;
    let rivales: Vec<(i32, &ParticipantDto)> = participants
        .iter()
        .enumerate()
        .filter(|(_, p)| p.teamId == rival)
        .map(|(i, p)| ((i + 1) as i32, p))
        .collect();
    let mut segundos: HashMap<i32, f64> = HashMap::new();
    let mut presencia: HashMap<i32, f64> = HashMap::new();
    let mut sec = start;
    while sec <= end + 1e-6 {
        if let Some(e) = occ.estimate(pid, sec) {
            for (rid, _) in &rivales {
                if !vivos.alive(*rid, sec) {
                    continue;
                }
                let c = occ.presence(*rid, sec, e.x, e.y, radio);
                *presencia.entry(*rid).or_default() += c;
                if c >= CERTEZA_ATADO {
                    *segundos.entry(*rid).or_default() += PASO_ATADO;
                }
            }
        }
        sec += PASO_ATADO;
    }
    let dur = (end - start).max(PASO_ATADO);
    // Tramos cortos confirmados por el vídeo pueden quedarse sin ningún
    // instante por encima del umbral con la posición estimada de la API. El
    // vídeo sí vio a `enemy_count` rivales: se reparten entre los más probables,
    // con el tiempo del episodio escalado por su presencia media.
    if segundos.is_empty() && enemy_count > 0 {
        let mut orden: Vec<(i32, f64)> = presencia.into_iter().collect();
        orden.sort_by(|a, b| b.1.total_cmp(&a.1));
        let pasos = (dur / PASO_ATADO).max(1.0);
        for (rid, p) in orden.into_iter().take(enemy_count) {
            segundos.insert(rid, (p / pasos).clamp(0.5, 1.0) * dur);
        }
    }
    let mut out: Vec<EnemyTie> = rivales
        .iter()
        .filter_map(|(rid, p)| {
            let s = segundos.get(rid).copied()?.min(dur);
            (s > 0.0).then(|| EnemyTie {
                participant_id: *rid,
                champion: p.championName.clone(),
                seconds: s,
                farm_gold: 0.0,
            })
        })
        .collect();
    out.sort_by(|a, b| b.seconds.total_cmp(&a.seconds));
    out
}

/// Rivales atados según el vídeo.
///
/// El vídeo dice CUÁNTOS rivales tenías encima en cada instante, pero no
/// quiénes: los iconos llevan el color del equipo, no el campeón. Quiénes lo
/// dice la API: en cada instante se toman los `n` rivales vivos con más
/// presencia alrededor de tu posición del vídeo. Así la suma de segundos cuadra
/// con lo que se ve, y los nombres con lo que es probable.
///
/// `instantes`: (segundo de partida, x, y, rivales encima según el vídeo).
pub fn atados_video(
    occ: &Occupancy,
    vivos: &Vivos,
    participants: &[ParticipantDto],
    pid: i32,
    instantes: &[(f64, f64, f64, usize)],
    radio: f64,
) -> Vec<EnemyTie> {
    let Some(yo) = participants.get((pid - 1) as usize) else { return Vec::new() };
    let rival = 300 - yo.teamId;
    let mut segundos: HashMap<i32, f64> = HashMap::new();
    for (k, &(sec, x, y, n)) in instantes.iter().enumerate() {
        let dt = instantes
            .get(k + 1)
            .map(|s| (s.0 - sec).clamp(0.0, PASO_ATADO))
            .unwrap_or(0.5);
        let mut cand: Vec<(i32, f64)> = participants
            .iter()
            .enumerate()
            .filter(|(_, p)| p.teamId == rival)
            .map(|(i, _)| (i + 1) as i32)
            .filter(|rid| vivos.alive(*rid, sec))
            .map(|rid| (rid, occ.presence(rid, sec, x, y, radio)))
            .collect();
        cand.sort_by(|a, b| b.1.total_cmp(&a.1));
        for (rid, _) in cand.into_iter().take(n) {
            *segundos.entry(rid).or_default() += dt;
        }
    }
    let mut out: Vec<EnemyTie> = segundos
        .into_iter()
        .filter(|(_, s)| *s > 0.0)
        .filter_map(|(rid, s)| {
            Some(EnemyTie {
                participant_id: rid,
                champion: participants.get((rid - 1) as usize)?.championName.clone(),
                seconds: s,
                farm_gold: 0.0,
            })
        })
        .collect();
    out.sort_by(|a, b| b.seconds.total_cmp(&a.seconds));
    out
}

/// Veredicto a partir del neto.
pub fn veredicto(net: f64) -> &'static str {
    if net >= UMBRAL_VEREDICTO {
        "good"
    } else if net <= -UMBRAL_VEREDICTO {
        "bad"
    } else {
        "even"
    }
}

/// Calcula el farmeo de los atados y el propio, y cierra el neto. `local`,
/// `team_elsewhere` y `enemy_elsewhere` los rellena quien asigna la evidencia.
pub fn cerrar_valor(
    v: &mut PressureValue,
    ties: &mut [EnemyTie],
    tl: &TimelineDto,
    pid: i32,
    start: f64,
    end: f64,
    muerte: Option<f64>,
) {
    let minuto = (start + end) / 120.0;
    v.enemy_seconds = ties.iter().map(|t| t.seconds).sum();
    v.farm_denied = 0.0;
    for t in ties.iter_mut() {
        t.farm_gold = ritmo_de_farmeo(tl, t.participant_id, minuto) * t.seconds;
        v.farm_denied += t.farm_gold;
    }
    let ritmo = ritmo_de_farmeo(tl, pid, minuto);
    v.own_farm_lost = ritmo * (end - start).max(0.0);
    v.death_farm_lost = muerte
        .map(|s| {
            let m = ((s / 60.0).floor() as usize).min(tl.info.frames.len().saturating_sub(1));
            let nivel = tl.info.frames.get(m)
                .and_then(|f| f.participantFrames.get(&pid.to_string()))
                .map(|p| p.level)
                .filter(|l| *l > 0)
                .unwrap_or(1);
            crate::attribution::death_timer(nivel, s / 60.0) * ritmo
        })
        .unwrap_or(0.0);
    v.net = v.local_gold + v.farm_denied - v.own_farm_lost - v.death_farm_lost + v.team_elsewhere;
    v.verdict = veredicto(v.net).to_string();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tl(frames: serde_json::Value) -> TimelineDto {
        serde_json::from_value(json!({ "info": { "frames": frames } })).unwrap()
    }

    #[test]
    fn el_ritmo_de_farmeo_sale_de_los_minutos_de_alrededor() {
        // 8 súbditos por minuto durante 7 minutos alrededor del 10.
        let frames: Vec<serde_json::Value> = (0..20)
            .map(|m| json!({"timestamp": m * 60000, "events": [],
                "participantFrames": {"1": {"minionsKilled": m * 8, "jungleMinionsKilled": 0, "level": 9}}}))
            .collect();
        let t = tl(json!(frames));
        let r = ritmo_de_farmeo(&t, 1, 10.0);
        let esperado = 8.0 * oro_subdito(10.0) / 60.0;
        assert!((r - esperado).abs() < 1e-6, "{r} vs {esperado}");
    }

    #[test]
    fn vivos_respeta_el_temporizador_de_muerte() {
        let t = tl(json!([
            {"timestamp": 0, "events": [], "participantFrames": {"3": {"level": 6}}},
            {"timestamp": 60000, "events": [
                {"type": "CHAMPION_KILL", "timestamp": 90000, "killerId": 7, "victimId": 3}
            ], "participantFrames": {"3": {"level": 6}}}
        ]));
        let v = Vivos::build(&t);
        assert!(v.alive(3, 89.0));
        assert!(!v.alive(3, 95.0));
        // Nivel 6 antes del 15: 16 s.
        assert!(v.alive(3, 106.5));
    }

    #[test]
    fn el_veredicto_tiene_zona_muerta() {
        assert_eq!(veredicto(149.0), "even");
        assert_eq!(veredicto(-149.0), "even");
        assert_eq!(veredicto(150.0), "good");
        assert_eq!(veredicto(-400.0), "bad");
    }

    #[test]
    fn cada_objetivo_se_valora_en_oro() {
        let ev = |v: serde_json::Value| -> TimelineEvent { serde_json::from_value(v).unwrap() };
        assert_eq!(valor_evento(&ev(json!({"type": "TURRET_PLATE_DESTROYED"}))).unwrap().1, crate::attribution::PESO_PLACA);
        assert_eq!(
            valor_evento(&ev(json!({"type": "ELITE_MONSTER_KILL", "monsterType": "BARON_NASHOR"}))).unwrap().1,
            crate::attribution::PESO_BARON
        );
        assert!(valor_evento(&ev(json!({"type": "BUILDING_KILL", "buildingType": "TOWER_BUILDING", "towerType": "OUTER_TURRET"}))).unwrap().1 > 0.0);
        assert_eq!(valor_evento(&ev(json!({"type": "CHAMPION_KILL", "bounty": 300, "shutdownBounty": 150}))).unwrap().1, 450.0);
    }
}
