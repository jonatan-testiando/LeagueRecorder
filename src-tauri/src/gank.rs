//! Detección de ganks sobre la Timeline v5 de Riot.
//!
//! La versión anterior clasificaba el carril con tres cajas (`x < 4500`,
//! `x > 10500`, y el cuadrado central) cuya unión era el mapa entero: bases,
//! río y ambas junglas incluidas. «Estar en un carril» era siempre cierto, así
//! que salía un gank por cada minuto sin kill ni muerte. Aquí:
//!
//! 1. el carril es una polilínea con anchura real, anclada a las torres de SR;
//! 2. un gank exige que haya un rival *de esa línea* cerca de ti — los otros
//!    nueve jugadores están en `participantFrames` y antes no se miraban;
//! 3. el instante no se redondea al minuto: los ganks con resultado se sellan
//!    con el timestamp exacto del `CHAMPION_KILL` (milisegundos), y los que no
//!    lo tienen se interpolan entre fotogramas buscando cuándo entraste en el
//!    carril.
//!
//! Nota sobre el anclaje por centinelas: `WARD_PLACED` trae timestamp exacto
//! pero **no trae posición**, así que no hay forma de saber si esa ward era de
//! este carril o de la otra punta del mapa. La interpolación entre fotogramas
//! da una estimación mejor y sin ese riesgo.

use std::collections::HashMap;

use crate::riot_api::{ParticipantDto, TimelineDto};

/// Anchura a cada lado del eje del carril, en unidades de mapa (SR es
/// ~14 870 × 14 870). Fuera de esta banda estás en jungla, río o base.
const LANE_HALF_WIDTH: f64 = 1300.0;
/// Las peleas se desplazan al río y a los arbustos, así que un kill cuenta como
/// «de línea» algo más lejos del eje que una posición de fotograma.
const KILL_LANE_WIDTH: f64 = 2100.0;
/// Distancia máxima al rival de esa línea para aceptar que fuiste a por él.
const ENEMY_NEAR: f64 = 2200.0;
/// Rival encima: sube la confianza.
const ENEMY_CLOSE: f64 = 1500.0;
/// Aliado de la línea presente (gank a dos).
const ALLY_NEAR: f64 = 2600.0;
/// Fase temprana: es la ventana que analiza el widget.
pub const EARLY_GAME_END: f64 = 900.0;
/// Dos candidatos del mismo carril más juntos que esto son el mismo gank.
const MERGE_WINDOW: f64 = 75.0;
/// Por debajo de esto no se emite marcador.
const MIN_CONFIDENCE: f64 = 0.40;

#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub enum Lane {
    Top,
    Mid,
    Bot,
}

#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub enum Outcome {
    Success,
    Neutral,
    Failed,
}

#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub enum Approach {
    /// Entraste por detrás del rival: estás más cerca de su base que él, le
    /// cortas la retirada.
    Flank,
    /// Entrada frontal, desde su lado del carril hacia tu torre.
    Front,
}

/// Un gank detectado, en tiempo de partida (el desplazamiento al eje del vídeo
/// lo aplica quien construye los marcadores).
#[derive(Clone, Debug)]
pub struct Gank {
    /// Segundos de partida del momento en que llegas al carril (o del kill).
    pub time: f64,
    /// Incertidumbre en segundos. 0 = anclado a un evento con milisegundos.
    pub precision: f64,
    pub lane: Lane,
    pub outcome: Outcome,
    /// 0..1. Los que llegan con resultado van por encima de 0,85.
    pub confidence: f64,
    pub x: i32,
    pub y: i32,
    pub approach: Option<Approach>,
}

impl Lane {
    pub const ALL: [Lane; 3] = [Lane::Top, Lane::Mid, Lane::Bot];

    pub fn key(self) -> &'static str {
        match self {
            Lane::Top => "top",
            Lane::Mid => "mid",
            Lane::Bot => "bot",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Lane::Top => "Top",
            Lane::Mid => "Mid",
            Lane::Bot => "Bot",
        }
    }

    /// Eje del carril, de la base azul a la base roja. Los vértices son las
    /// torres reales de Grieta del Invocador, con un punto extra en cada codo.
    fn path(self) -> &'static [(f64, f64)] {
        match self {
            Lane::Top => &[
                (1169.0, 4287.0),
                (1512.0, 6699.0),
                (981.0, 10441.0),
                (2300.0, 12700.0),
                (4318.0, 13875.0),
                (7943.0, 13411.0),
                (10481.0, 13650.0),
            ],
            Lane::Mid => &[
                (3651.0, 3696.0),
                (5048.0, 4812.0),
                (5846.0, 6396.0),
                (7450.0, 7450.0),
                (8955.0, 8510.0),
                (9767.0, 10113.0),
                (11134.0, 11207.0),
            ],
            Lane::Bot => &[
                (4281.0, 1253.0),
                (6919.0, 1483.0),
                (10504.0, 1029.0),
                (12700.0, 2300.0),
                (13866.0, 4505.0),
                (13327.0, 8226.0),
                (13624.0, 10572.0),
            ],
        }
    }
}

impl Lane {
    /// Carril al que pertenece un punto del mapa, o `None` si está lejos de los
    /// tres (jungla profunda, bases).
    ///
    /// Lo usa el recuento de miradas al minimapa: un clic en el foso del dragón
    /// habla de la parte de abajo, y uno en tu base no habla de ningún carril.
    pub fn nearest_within(x: f64, y: f64, max_dist: f64) -> Option<Lane> {
        Lane::ALL
            .into_iter()
            .map(|l| (l, project(l, x, y).0))
            .filter(|(_, d)| *d <= max_dist)
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(l, _)| l)
    }
}

impl Outcome {
    pub fn key(self) -> &'static str {
        match self {
            Outcome::Success => "success",
            Outcome::Neutral => "neutral",
            Outcome::Failed => "failed",
        }
    }
}

impl Approach {
    pub fn key(self) -> &'static str {
        match self {
            Approach::Flank => "flank",
            Approach::Front => "front",
        }
    }
}

/// Distancia de un punto a un segmento, y en qué fracción del segmento cae.
fn point_to_segment(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> (f64, f64) {
    let (dx, dy) = (bx - ax, by - ay);
    let len2 = dx * dx + dy * dy;
    let u = if len2 <= f64::EPSILON {
        0.0
    } else {
        (((px - ax) * dx + (py - ay) * dy) / len2).clamp(0.0, 1.0)
    };
    let (cx, cy) = (ax + u * dx, ay + u * dy);
    (((px - cx).powi(2) + (py - cy).powi(2)).sqrt(), u)
}

/// Distancia al eje del carril y progreso normalizado a lo largo de él
/// (0 = base azul, 1 = base roja).
fn project(lane: Lane, x: f64, y: f64) -> (f64, f64) {
    let path = lane.path();
    let total: f64 = path
        .windows(2)
        .map(|w| ((w[1].0 - w[0].0).powi(2) + (w[1].1 - w[0].1).powi(2)).sqrt())
        .sum();

    let mut best = (f64::MAX, 0.0);
    let mut acc = 0.0;
    for w in path.windows(2) {
        let seg_len = ((w[1].0 - w[0].0).powi(2) + (w[1].1 - w[0].1).powi(2)).sqrt();
        let (d, u) = point_to_segment(x, y, w[0].0, w[0].1, w[1].0, w[1].1);
        if d < best.0 {
            best = (d, if total > 0.0 { (acc + u * seg_len) / total } else { 0.0 });
        }
        acc += seg_len;
    }
    best
}

/// Carril más cercano al punto, si cae dentro de `max_dist` del eje.
/// Devuelve `(carril, distancia al eje, progreso 0..1)`.
pub fn lane_at(x: f64, y: f64, max_dist: f64) -> Option<(Lane, f64, f64)> {
    Lane::ALL
        .iter()
        .map(|&l| {
            let (d, t) = project(l, x, y);
            (l, d, t)
        })
        .filter(|&(_, d, _)| d <= max_dist)
        .min_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
}

fn lane_of_role(role: &str) -> Option<Lane> {
    match role {
        "TOP" => Some(Lane::Top),
        "MIDDLE" | "MID" => Some(Lane::Mid),
        "BOTTOM" | "BOT" | "UTILITY" | "SUPPORT" | "DUO_CARRY" | "DUO_SUPPORT" => Some(Lane::Bot),
        _ => None,
    }
}

/// Posiciones de los diez jugadores en cada fotograma de minuto.
struct Snapshot {
    sec: f64,
    pos: HashMap<i32, (f64, f64)>,
}

/// ¿Estás en la mitad del carril que pertenece al rival?
fn in_enemy_half(t: f64, blue_side: bool) -> bool {
    if blue_side {
        t > 0.55
    } else {
        t < 0.45
    }
}

/// Estás más cerca de la base del rival que él: le cortas la retirada.
fn approach_from(t_self: f64, t_enemy: f64, blue_side: bool) -> Approach {
    let cuts = if blue_side {
        t_self > t_enemy + 0.015
    } else {
        t_self < t_enemy - 0.015
    };
    if cuts {
        Approach::Flank
    } else {
        Approach::Front
    }
}

/// Instante estimado en que la trayectoria `from → to` entra en el carril.
/// Se interpola en línea recta entre los dos fotogramas: no es la ruta real,
/// pero es mucho mejor que redondear al minuto, que es lo que hacía antes.
fn enter_time(from: &Snapshot, to: &Snapshot, pid: i32, lane: Lane) -> f64 {
    interpolate(from, to, pid, lane, true).unwrap_or(to.sec)
}

/// Instante estimado en que sale del carril camino del siguiente fotograma.
fn exit_time(from: &Snapshot, to: &Snapshot, pid: i32, lane: Lane) -> f64 {
    interpolate(from, to, pid, lane, false).unwrap_or(to.sec)
}

fn interpolate(
    from: &Snapshot,
    to: &Snapshot,
    pid: i32,
    lane: Lane,
    want_inside: bool,
) -> Option<f64> {
    let a = *from.pos.get(&pid)?;
    let b = *to.pos.get(&pid)?;
    const STEPS: i32 = 30;
    for s in 0..=STEPS {
        let f = s as f64 / STEPS as f64;
        let x = a.0 + (b.0 - a.0) * f;
        let y = a.1 + (b.1 - a.1) * f;
        let inside = project(lane, x, y).0 <= LANE_HALF_WIDTH;
        if inside == want_inside {
            return Some(from.sec + (to.sec - from.sec) * f);
        }
    }
    None
}

fn dist(a: (f64, f64), b: (f64, f64)) -> f64 {
    ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt()
}

/// Detecta los ganks del jugador en la fase temprana. Tiempos en segundos de
/// partida.
pub fn detect(tl: &TimelineDto, self_pid: i32, participants: &[ParticipantDto]) -> Vec<Gank> {
    let self_team = participants
        .get((self_pid - 1) as usize)
        .map(|p| p.teamId)
        .unwrap_or(100);
    let blue_side = self_team == 100;

    // pid -> carril del rol. El jungla no tiene, y por eso puede «ganquear» los tres.
    let mut role_lane: HashMap<i32, Option<Lane>> = HashMap::new();
    let mut team_of: HashMap<i32, i32> = HashMap::new();
    for (i, p) in participants.iter().enumerate() {
        let pid = (i + 1) as i32;
        let raw = if !p.teamPosition.is_empty() {
            p.teamPosition.as_str()
        } else {
            p.individualPosition.as_str()
        };
        role_lane.insert(pid, lane_of_role(raw));
        team_of.insert(pid, p.teamId);
    }
    // Partidas personalizadas y algunas antiguas vienen sin rol: en ese caso se
    // acepta a cualquier rival que esté dentro del carril, con menos confianza.
    let roles_known = role_lane.values().filter(|l| l.is_some()).count() >= 6;
    let self_lane = role_lane.get(&self_pid).copied().flatten();

    let snapshots: Vec<Snapshot> = tl
        .info
        .frames
        .iter()
        .map(|f| Snapshot {
            sec: f.timestamp as f64 / 1000.0,
            pos: f
                .participantFrames
                .iter()
                .filter_map(|(k, pf)| {
                    let pid: i32 = k.parse().ok()?;
                    let p = pf.position.as_ref()?;
                    Some((pid, (p.x as f64, p.y as f64)))
                })
                .collect(),
        })
        .collect();

    let mut ganks = from_kills(
        tl, self_pid, self_lane, &role_lane, &team_of, roles_known, blue_side, &snapshots,
    );
    // Los candidatos por co-presencia nacen sin resultado; el segundo paso mira
    // si acabaron en kill o en muerte y los reancla al instante exacto.
    let mut framed = from_frames(
        self_pid, self_lane, self_team, &role_lane, &team_of, roles_known, blue_side, &snapshots,
    );
    resolve_outcomes(&mut framed, &my_kills(tl, self_pid));
    ganks.extend(framed);

    merge(ganks)
}

/// Ganks con resultado. Salen de los `CHAMPION_KILL`, que traen milisegundos y
/// posición exactos: aquí no hay desfase que valga.
#[allow(clippy::too_many_arguments)]
fn from_kills(
    tl: &TimelineDto,
    self_pid: i32,
    self_lane: Option<Lane>,
    role_lane: &HashMap<i32, Option<Lane>>,
    team_of: &HashMap<i32, i32>,
    roles_known: bool,
    blue_side: bool,
    snapshots: &[Snapshot],
) -> Vec<Gank> {
    let self_team = team_of.get(&self_pid).copied().unwrap_or(100);
    let mut out = Vec::new();

    for frame in &tl.info.frames {
        for ev in &frame.events {
            if ev.event_type != "CHAMPION_KILL" {
                continue;
            }
            let sec = ev.timestamp as f64 / 1000.0;
            if sec > EARLY_GAME_END {
                continue;
            }
            let Some(pos) = ev.position.as_ref() else {
                continue;
            };
            let (x, y) = (pos.x as f64, pos.y as f64);

            let i_killed =
                ev.killerId == self_pid || ev.assistingParticipantIds.contains(&self_pid);
            let i_died = ev.victimId == self_pid;
            if !i_killed && !i_died {
                continue;
            }

            let Some((lane, _, t_kill)) = lane_at(x, y, KILL_LANE_WIDTH) else {
                continue; // pelea en jungla, río o base: no es un gank de línea
            };
            if Some(lane) == self_lane {
                continue; // tu propia línea no cuenta como gank tuyo
            }

            // El otro bando tiene que incluir a alguien de esa línea; si no, es
            // un cruce de junglas que casualmente pasó cerca del carril.
            let counterpart = if i_killed {
                vec![ev.victimId]
            } else {
                let mut v = vec![ev.killerId];
                v.extend(ev.assistingParticipantIds.iter().copied());
                v
            };
            let belongs = counterpart.iter().any(|pid| {
                role_lane.get(pid).copied().flatten() == Some(lane)
                    && team_of.get(pid).copied().unwrap_or(0) != self_team
            });
            if roles_known && !belongs {
                continue;
            }

            // Ángulo de entrada: se compara con la posición del rival en el
            // fotograma más cercano, y sólo si está a menos de 30 s del kill.
            let approach = snapshots
                .iter()
                .filter(|s| (s.sec - sec).abs() <= 30.0)
                .min_by(|a, b| {
                    (a.sec - sec)
                        .abs()
                        .partial_cmp(&(b.sec - sec).abs())
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .and_then(|snap| {
                    let rival = counterpart
                        .iter()
                        .find(|pid| team_of.get(pid).copied().unwrap_or(0) != self_team)?;
                    let rp = snap.pos.get(rival)?;
                    let (_, t_enemy) = project(lane, rp.0, rp.1);
                    Some(approach_from(t_kill, t_enemy, blue_side))
                });

            out.push(Gank {
                time: sec,
                precision: 0.0,
                lane,
                outcome: if i_killed {
                    Outcome::Success
                } else {
                    Outcome::Failed
                },
                confidence: if belongs { 0.92 } else { 0.75 },
                x: pos.x,
                y: pos.y,
                approach,
            });
        }
    }
    out
}

/// Ganks sin resultado. Aquí sólo hay una posición por minuto, así que la
/// exigencia es alta: rival de esa línea cerca, y el instante interpolado.
#[allow(clippy::too_many_arguments)]
fn from_frames(
    self_pid: i32,
    self_lane: Option<Lane>,
    self_team: i32,
    role_lane: &HashMap<i32, Option<Lane>>,
    team_of: &HashMap<i32, i32>,
    roles_known: bool,
    blue_side: bool,
    snapshots: &[Snapshot],
) -> Vec<Gank> {
    let mut out = Vec::new();

    for (i, snap) in snapshots.iter().enumerate() {
        if i == 0 || snap.sec > EARLY_GAME_END {
            continue;
        }
        let Some(&me) = snap.pos.get(&self_pid) else {
            continue;
        };
        let Some((lane, _, t_self)) = lane_at(me.0, me.1, LANE_HALF_WIDTH) else {
            continue;
        };
        if Some(lane) == self_lane {
            continue;
        }

        // ¿Hay alguien de esa línea a quien ganquear? Sin esto, «pasar por el
        // carril» y «ganquear» son lo mismo, que era justo el fallo anterior.
        let mut nearest_enemy: Option<(f64, f64)> = None; // (distancia, progreso)
        for (&pid, &p) in &snap.pos {
            if team_of.get(&pid).copied().unwrap_or(0) == self_team {
                continue;
            }
            let is_of_lane = if roles_known {
                role_lane.get(&pid).copied().flatten() == Some(lane)
            } else {
                project(lane, p.0, p.1).0 <= LANE_HALF_WIDTH * 1.4
            };
            if !is_of_lane {
                continue;
            }
            let d = dist(me, p);
            if nearest_enemy.map_or(true, |(best, _)| d < best) {
                nearest_enemy = Some((d, project(lane, p.0, p.1).1));
            }
        }
        let Some((enemy_dist, t_enemy)) = nearest_enemy else {
            continue;
        };
        if enemy_dist > ENEMY_NEAR {
            continue;
        }

        let ally_near = snap.pos.iter().any(|(&pid, &p)| {
            pid != self_pid
                && team_of.get(&pid).copied().unwrap_or(0) == self_team
                && role_lane.get(&pid).copied().flatten() == Some(lane)
                && dist(me, p) <= ALLY_NEAR
        });

        // Ventana temporal: entrada interpolada desde el fotograma anterior,
        // salida hacia el siguiente.
        let entered = enter_time(&snapshots[i - 1], snap, self_pid, lane);
        let left = snapshots
            .get(i + 1)
            .map(|next| exit_time(snap, next, self_pid, lane))
            .unwrap_or(snap.sec + 30.0);
        let dwell = (left - entered).max(0.0);

        let mut confidence: f64 = 0.40;
        if enemy_dist <= ENEMY_CLOSE {
            confidence += 0.20;
        }
        if in_enemy_half(t_self, blue_side) {
            confidence += 0.15;
        }
        if ally_near {
            confidence += 0.10;
        }
        if dwell >= 25.0 {
            confidence += 0.10;
        }
        if !roles_known {
            confidence -= 0.10;
        }
        let confidence = confidence.clamp(0.0, 0.95);
        if confidence < MIN_CONFIDENCE {
            continue;
        }

        out.push(Gank {
            time: entered,
            precision: (dwell * 0.4).clamp(8.0, 25.0),
            lane,
            outcome: Outcome::Neutral,
            confidence,
            x: me.0 as i32,
            y: me.1 as i32,
            approach: Some(approach_from(t_self, t_enemy, blue_side)),
        });
    }
    out
}

/// Un kill o una muerte tuya, con su instante y su sitio exactos.
struct MyKill {
    sec: f64,
    x: i32,
    y: i32,
    i_killed: bool,
}

fn my_kills(tl: &TimelineDto, self_pid: i32) -> Vec<MyKill> {
    let mut out = Vec::new();
    for frame in &tl.info.frames {
        for ev in &frame.events {
            if ev.event_type != "CHAMPION_KILL" {
                continue;
            }
            let sec = ev.timestamp as f64 / 1000.0;
            if sec > EARLY_GAME_END {
                continue;
            }
            let Some(pos) = ev.position.as_ref() else {
                continue;
            };
            let i_killed =
                ev.killerId == self_pid || ev.assistingParticipantIds.contains(&self_pid);
            if i_killed || ev.victimId == self_pid {
                out.push(MyKill {
                    sec,
                    x: pos.x,
                    y: pos.y,
                    i_killed,
                });
            }
        }
    }
    out
}

/// Un candidato «sin resultado» que tenga un kill o una muerte tuya dentro de su
/// ventana y pegado a ese carril no está sin resultado: eso *es* su desenlace.
///
/// Da igual quién apretara el gatillo. Medido contra una partida real: Gwen baja
/// al top rival, la mata el jungla enemigo, y como entre los matadores no había
/// nadie «de esa línea» el gank salía como presencia sin resultado. La
/// co-presencia ya estableció que había un gank en marcha; la muerte es cómo
/// acabó. De paso el marcador se reancla al milisegundo del evento.
fn resolve_outcomes(cands: &mut [Gank], kills: &[MyKill]) {
    for g in cands.iter_mut() {
        if g.outcome != Outcome::Neutral {
            continue;
        }
        let (from, to) = (g.time - 25.0, g.time + 60.0);
        let best = kills
            .iter()
            .filter(|k| k.sec >= from && k.sec <= to)
            .filter(|k| project(g.lane, k.x as f64, k.y as f64).0 <= KILL_LANE_WIDTH)
            .min_by(|a, b| {
                (a.sec - g.time)
                    .abs()
                    .partial_cmp(&(b.sec - g.time).abs())
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
        if let Some(k) = best {
            g.outcome = if k.i_killed {
                Outcome::Success
            } else {
                Outcome::Failed
            };
            g.time = k.sec;
            g.precision = 0.0;
            g.x = k.x;
            g.y = k.y;
            g.confidence = g.confidence.max(0.90);
        }
    }
}

/// Prioridad al fusionar: gana el que trae resultado (y hora exacta).
fn rank(g: &Gank) -> (u8, i64) {
    let with_result = u8::from(g.outcome != Outcome::Neutral);
    (with_result, (g.confidence * 1000.0) as i64)
}

fn merge(mut ganks: Vec<Gank>) -> Vec<Gank> {
    ganks.sort_by(|a, b| {
        a.time
            .partial_cmp(&b.time)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut out: Vec<Gank> = Vec::new();
    for g in ganks {
        let hit = out
            .iter()
            .rposition(|p| p.lane == g.lane && (g.time - p.time).abs() <= MERGE_WINDOW);
        match hit {
            Some(i) => {
                if rank(&g) > rank(&out[i]) {
                    let inherited = out[i].approach;
                    let conf = out[i].confidence.max(g.confidence);
                    out[i] = g;
                    out[i].approach = out[i].approach.or(inherited);
                    out[i].confidence = conf;
                } else {
                    out[i].confidence = out[i].confidence.max(g.confidence);
                }
            }
            None => out.push(g),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn las_bases_y_la_jungla_no_son_carril() {
        // El fallo de la versión anterior: estos puntos caían todos en «Mid».
        for (x, y) in [
            (1500.0, 1500.0),  // base azul
            (13300.0, 13300.0), // base roja
            (7000.0, 4500.0),  // jungla inferior del lado azul
            (4500.0, 8000.0),  // jungla superior del lado azul
            (10500.0, 6500.0), // jungla del lado rojo
        ] {
            assert!(
                lane_at(x, y, LANE_HALF_WIDTH).is_none(),
                "({x}, {y}) no debería ser carril"
            );
        }
    }

    #[test]
    fn las_torres_caen_en_su_carril() {
        let casos = [
            (981.0, 10441.0, Lane::Top),
            (7943.0, 13411.0, Lane::Top),
            (5846.0, 6396.0, Lane::Mid),
            (9767.0, 10113.0, Lane::Mid),
            (10504.0, 1029.0, Lane::Bot),
            (13327.0, 8226.0, Lane::Bot),
        ];
        for (x, y, esperado) in casos {
            let (lane, _, _) = lane_at(x, y, LANE_HALF_WIDTH).expect("debería ser carril");
            assert_eq!(lane, esperado, "({x}, {y})");
        }
    }

    #[test]
    fn el_progreso_va_de_base_azul_a_base_roja() {
        for lane in Lane::ALL {
            let inicio = lane.path()[0];
            let fin = lane.path()[lane.path().len() - 1];
            let (_, t0) = project(lane, inicio.0, inicio.1);
            let (_, t1) = project(lane, fin.0, fin.1);
            assert!(t0 < 0.05, "{:?} empieza en {t0}", lane);
            assert!(t1 > 0.95, "{:?} acaba en {t1}", lane);
        }
    }

    /// Diez participantes con roles estándar; el 1 es el jungla azul.
    fn participantes() -> Vec<ParticipantDto> {
        let roles = ["JUNGLE", "TOP", "MIDDLE", "BOTTOM", "UTILITY"];
        serde_json::from_value(serde_json::json!((0..10)
            .map(|i| {
                serde_json::json!({
                    "puuid": format!("p{i}"),
                    "kills": 0, "deaths": 0, "assists": 0,
                    "goldEarned": 0, "totalDamageDealtToChampions": 0, "win": true,
                    "teamId": if i < 5 { 100 } else { 200 },
                    "teamPosition": roles[i % 5],
                })
            })
            .collect::<Vec<_>>()))
        .expect("participantes de prueba")
    }

    /// Timeline de tres fotogramas: en el minuto 6 el jungla azul está en su
    /// jungla y en el 7 aparece en la mitad enemiga de bot. `eventos` se cuelga
    /// del fotograma del minuto 7.
    fn timeline_con(enemigo_en_bot: bool, eventos: serde_json::Value) -> TimelineDto {
        let lejos = [13000, 13000]; // base roja, para aparcar a quien no importa
        let adc = if enemigo_en_bot { [12900, 3600] } else { lejos };
        let frame = |t: i64, jungla: [i32; 2], evs: serde_json::Value| {
            let mut pf = serde_json::Map::new();
            for pid in 1..=10 {
                let p = match pid {
                    1 => jungla,
                    9 => adc, // ADC rojo
                    _ => lejos,
                };
                pf.insert(
                    pid.to_string(),
                    serde_json::json!({ "participantId": pid, "position": { "x": p[0], "y": p[1] } }),
                );
            }
            serde_json::json!({ "timestamp": t, "events": evs, "participantFrames": pf })
        };
        let vacio = serde_json::json!([]);
        serde_json::from_value(serde_json::json!({
            "info": { "frames": [
                frame(360_000, [8300, 4300], vacio.clone()), // jungla del lado rojo, fuera de carril
                frame(420_000, [12800, 3900], eventos),      // dentro de bot, mitad enemiga
                frame(480_000, [8300, 4300], vacio),         // de vuelta a la jungla
            ]}
        }))
        .expect("timeline de prueba")
    }

    fn timeline(enemigo_en_bot: bool) -> TimelineDto {
        timeline_con(enemigo_en_bot, serde_json::json!([]))
    }

    #[test]
    fn pasar_por_el_carril_sin_nadie_delante_no_es_gank() {
        let ganks = detect(&timeline(false), 1, &participantes());
        assert!(ganks.is_empty(), "no había rival de esa línea: {ganks:?}");
    }

    #[test]
    fn con_el_rival_de_la_linea_delante_si_es_gank() {
        let ganks = detect(&timeline(true), 1, &participantes());
        assert_eq!(ganks.len(), 1, "{ganks:?}");
        let g = &ganks[0];
        assert_eq!(g.lane, Lane::Bot);
        assert_eq!(g.outcome, Outcome::Neutral);
        // Lo importante: NO se sella en el minuto 7 clavado. La llegada se
        // interpola entre el fotograma 6 y el 7, así que cae dentro del minuto.
        assert!(
            g.time > 360.0 && g.time < 420.0,
            "el instante debería estar interpolado, no ser el minuto: {}",
            g.time
        );
        assert!(g.precision > 0.0, "sin ancla exacta debe declarar incertidumbre");
        assert!(g.confidence >= MIN_CONFIDENCE, "confianza {}", g.confidence);
    }

    #[test]
    fn morir_en_el_carril_ganqueado_es_gank_fallido_lo_mate_quien_lo_mate() {
        // Caso real (LA1_1740789339): Gwen baja al top rival y la mata el jungla
        // enemigo, no el de la línea. Antes salía como «presencia sin resultado».
        let muerte = serde_json::json!([{
            "type": "CHAMPION_KILL",
            "timestamp": 405_000,
            "killerId": 7,          // jungla rojo: no es «de la línea» de bot
            "victimId": 1,
            "assistingParticipantIds": [],
            "position": { "x": 12850, "y": 3750 },
        }]);
        let ganks = detect(&timeline_con(true, muerte), 1, &participantes());
        assert_eq!(ganks.len(), 1, "{ganks:?}");
        assert_eq!(ganks[0].outcome, Outcome::Failed);
        // Y se reancla al instante exacto del evento, sin incertidumbre.
        assert_eq!(ganks[0].time, 405.0);
        assert_eq!(ganks[0].precision, 0.0);
    }

    /// Corre el detector contra una partida real descargada de la API. No entra
    /// en la suite normal porque necesita ficheros de fuera del repositorio.
    ///
    /// ```text
    /// GANK_TIMELINE=<match>.timeline.json GANK_MATCH=<match>.match.json \
    ///   cargo test --lib gank::tests::contra_una_partida_real -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "necesita ficheros de la API de Riot; ver la documentación del test"]
    fn contra_una_partida_real() {
        let (Ok(tl_path), Ok(m_path)) = (
            std::env::var("GANK_TIMELINE"),
            std::env::var("GANK_MATCH"),
        ) else {
            panic!("faltan GANK_TIMELINE y GANK_MATCH");
        };
        let tl: TimelineDto =
            serde_json::from_str(&std::fs::read_to_string(tl_path).expect("timeline")).unwrap();
        let detalles: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(m_path).expect("match")).unwrap();
        let participants: Vec<ParticipantDto> =
            serde_json::from_value(detalles["info"]["participants"].clone()).unwrap();

        let yo = std::env::var("GANK_CHAMPION").unwrap_or_else(|_| "Gwen".to_string());
        let pid = participants
            .iter()
            .position(|p| p.championName == yo)
            .map(|i| i as i32 + 1)
            .unwrap_or_else(|| panic!("{yo} no juega esta partida"));

        let ganks = detect(&tl, pid, &participants);
        println!(
            "\n{yo} (participante {pid}, {}) — {} ganks en los primeros 15 min\n",
            participants[(pid - 1) as usize].teamPosition,
            ganks.len()
        );
        for g in &ganks {
            println!(
                "  {:>5.1}s ±{:<4.0} {:<4} {:<8} conf {:.2}  {:?}",
                g.time,
                g.precision,
                g.lane.key(),
                g.outcome.key(),
                g.confidence,
                g.approach
            );
        }
    }

    #[test]
    fn el_flanqueo_depende_del_lado() {
        // Azul ganqueando mid: si está más adelantado que el rival, le corta.
        assert_eq!(approach_from(0.7, 0.6, true), Approach::Flank);
        assert_eq!(approach_from(0.5, 0.6, true), Approach::Front);
        // Rojo: el eje va al revés.
        assert_eq!(approach_from(0.3, 0.4, false), Approach::Flank);
        assert_eq!(approach_from(0.5, 0.4, false), Approach::Front);
    }
}
