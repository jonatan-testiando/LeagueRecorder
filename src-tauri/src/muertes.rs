//! Muertes con precio.
//!
//! Cada muerte cuesta lo que movió la probabilidad de victoria de tu equipo
//! (`crate::winprob`) más su parte de lo que el rival convirtió justo después:
//! un dragón, una torre, un barón. Y lleva etiquetas que dicen **por qué** fue
//! cara, todas sacadas de datos que ya existen. Es la base del coach de macro
//! (`docs/coach-de-macro-diseno.md`, §2.1 y 3.1): sin un precio por jugada no
//! hay forma de señalar qué momento te costó la partida.
//!
//! Las cuatro primeras etiquetas son sólo-API y valen para los diez jugadores.
//! Las dos últimas salen de lo grabado y sólo existen para quien grabó.

use std::collections::HashMap;

use crate::attribution::DeathCost;
use crate::riot_api::{ParticipantDto, TimelineDto, TimelineEvent};
use crate::winprob::Play;

/// El jungla rival te mató o asistió.
pub const JUNGLA: &str = "jungla";
/// Caíste a más de [`crate::camera_input::RADIO_CARRIL`] del eje de tu carril.
pub const FUERA_DE_ZONA: &str = "fuera_de_zona";
/// Moriste en una torre (tuya o suya) antes del 14:00.
pub const BAJO_TORRE: &str = "bajo_torre_pre14";
/// Lo que devolviste antes de morir está en el decil bajo de tu rol y tramo.
pub const POCO_DANO: &str = "poco_dano_devuelto";
/// Ninguna mirada al mapa en los [`MIRADAS_ANTES`] segundos previos.
pub const SIN_MIRAR: &str = "sin_mirar_mapa";
/// La pelea que te mató te la abrieron sin ningún rival a la vista.
pub const DESDE_NIEBLA: &str = "desde_niebla";

/// Un objetivo rival hasta este tiempo después de tu muerte cuenta como
/// convertido gracias a ella. Es la ventana de §2.2 del diseño.
pub const VENTANA_OBJETIVO: f64 = 60.0;

/// Fin de la fase de líneas: a las 14:00 caen las placas y los carriles se
/// rompen. Una torre antes de eso es un diveo o un exceso; después, una pelea
/// de asedio normal.
const FIN_DE_LINEAS: f64 = 14.0 * 60.0;

/// A esta distancia de una torre en pie, la muerte es "en la torre".
///
/// Medido en el corpus (12.974 partidas), en las 76.353 muertes en las que una
/// torre te pegó: la mitad caen a menos de 1.012 unidades de ella, el p90 a
/// 1.856. La cola larga son muertes huyendo, y esas ya las recoge el daño de
/// torre (ver `bajo_torre`); un radio de 1.900 metería el río entero.
const RADIO_TORRE: f64 = 1000.0;

/// Las 22 torres de la Grieta, sin inhibidores ni nexo: las mismas coordenadas
/// que `oleadas::ESTRUCTURAS`. Las de `BUILDING_KILL` coinciden al punto
/// (medido: distancia 0 en el p99), así que saber cuáles cayeron es exacto.
const TORRES: [(f64, f64); 22] = [
    (981.0, 10441.0), (1512.0, 6699.0), (1169.0, 4287.0),
    (5846.0, 6396.0), (5048.0, 4812.0), (3651.0, 3696.0),
    (10504.0, 1029.0), (6919.0, 1483.0), (4281.0, 1253.0),
    (1748.0, 2270.0), (2177.0, 1807.0),
    (4318.0, 13875.0), (7943.0, 13411.0), (10481.0, 13650.0),
    (8955.0, 8510.0), (9767.0, 10113.0), (11134.0, 11207.0),
    (13866.0, 4505.0), (13327.0, 8226.0), (13624.0, 10572.0),
    (12611.0, 13084.0), (13052.0, 12612.0),
];

/// La misma ventana que la cola de revisión (`BLIND_LOOKBACK_S`) y "Tus
/// muertes": si contaran distinto, la etiqueta y la frase dirían cosas
/// distintas de la misma muerte.
pub const MIRADAS_ANTES: f64 = 10.0;

/// Cortes de los tramos, en minutos: 0-7, 7-14, 14-21, 21-28 y 28+. Los del
/// coach (§2.3), que son los de iTero.
const CORTES_TRAMO: [f64; 4] = [7.0, 14.0, 21.0, 28.0];

/// Percentil 10 del daño a campeones que devolvió quien murió
/// (`victimDamageDealt`), por rol y tramo. Medido sobre el corpus (12.974
/// partidas, 879.063 muertes; marca el 10,4%) con
/// `tests::baremos_de_muertes_en_el_corpus`, que además comprueba que siguen
/// marcando ~10% de las muertes.
///
/// Por tramo y no por rol solo, porque el daño crece con la partida: una
/// mediana de 390 en el 0-7 y de 1.483 en el 28+ (top). Con un solo corte por
/// rol casi todas las muertes tempranas saldrían como "poco daño".
///
/// Entre un 9 y un 12% de las muertes de cada celda son con 0 de daño, así que
/// el p10 cae justo en esa frontera y salta entre 0 y unas decenas. Da igual:
/// en las dos versiones marca un ~10% de las muertes, que es lo que se pide.
const DANO_P10: [(&str, [i32; 5]); 5] = [
    ("TOP", [25, 64, 107, 153, 136]),
    ("JUNGLE", [2, 52, 56, 80, 63]),
    ("MIDDLE", [0, 0, 20, 59, 0]),
    ("BOTTOM", [47, 0, 0, 0, 0]),
    ("UTILITY", [17, 0, 0, 0, 0]),
];

/// Lo que se sabe de una muerte, sin el vídeo.
#[derive(Debug, Clone, Default)]
pub struct Precio {
    /// Segundos de partida.
    pub time: f64,
    pub victim: i32,
    /// ΔWP de la muerte para el equipo de quien murió. ≤ 0.
    pub wpa_death: f64,
    /// Su parte de los objetivos que el rival tomó en los
    /// [`VENTANA_OBJETIVO`] segundos siguientes. ≤ 0.
    pub wpa_objective: f64,
    /// El objetivo que más pesó de esos, como lo nombra `Play::kind`.
    pub objective: Option<String>,
    pub tags: Vec<String>,
}

fn rol(p: &ParticipantDto) -> &str {
    if p.teamPosition.is_empty() {
        &p.individualPosition
    } else {
        &p.teamPosition
    }
}

fn tramo(minuto: f64) -> usize {
    CORTES_TRAMO.iter().take_while(|c| minuto >= **c).count()
}

fn umbral_dano(rol: &str, minuto: f64) -> Option<i32> {
    DANO_P10.iter().find(|(r, _)| *r == rol).map(|(_, v)| v[tramo(minuto)])
}

/// Daño a campeones rivales que hizo quien murió en su secuencia de muerte.
///
/// Mismas trampas que `victimDamageReceived` (ver `riot_api::VictimDamageDto`):
/// `participantId == 0` es un esbirro o una torre y es el único filtro fiable;
/// `type` no distingue (el daño a campeones sale como "OTHER"). Aquí el
/// `participantId` es a quién pegó, y se exige además que sea rival.
fn dano_devuelto(ev: &TimelineEvent, es_rival: impl Fn(i32) -> bool) -> i32 {
    ev.victimDamageDealt
        .iter()
        .filter(|d| d.from_player() && es_rival(d.participantId))
        .map(|d| d.total())
        .sum()
}

fn torre_en(x: f64, y: f64) -> Option<usize> {
    TORRES.iter().position(|(tx, ty)| (tx - x).hypot(ty - y) < 50.0)
}

/// Las etiquetas sólo-API de una muerte.
fn etiquetas(
    ev: &TimelineEvent,
    participants: &[ParticipantDto],
    caidas: &[bool; 22],
) -> Vec<String> {
    let mut tags = Vec::new();
    let Some(victima) = participants.get((ev.victimId - 1) as usize) else {
        return tags;
    };
    let equipo = victima.teamId;
    let team_of = |pid: i32| participants.get((pid - 1) as usize).map(|p| p.teamId);
    let sec = ev.timestamp as f64 / 1000.0;
    let pos = ev.position.as_ref().map(|p| (p.x as f64, p.y as f64));

    let jungla_rival = participants
        .iter()
        .enumerate()
        .filter(|(_, p)| p.teamId != equipo && rol(p) == "JUNGLE")
        .any(|(i, _)| {
            let pid = i as i32 + 1;
            ev.killerId == pid || ev.assistingParticipantIds.contains(&pid)
        });
    if jungla_rival {
        tags.push(JUNGLA.to_string());
    }

    // Sin carril (jungla, o un modo sin puestos) no hay "tu zona".
    if let (Some(carril), Some((x, y))) = (crate::gank::lane_of_role(rol(victima)), pos) {
        if carril.distance(x, y) > crate::camera_input::RADIO_CARRIL {
            tags.push(FUERA_DE_ZONA.to_string());
        }
    }

    if sec < FIN_DE_LINEAS {
        // Te pegó su torre: es la prueba directa, y recoge a quien muere
        // huyendo ya fuera del radio. La tuya no te pega, así que para un
        // diveo bajo tu torre sólo queda la distancia.
        let le_pego = ev
            .victimDamageReceived
            .iter()
            .any(|d| !d.from_player() && d.source_type == "TOWER");
        let cerca = pos.is_some_and(|(x, y)| {
            TORRES
                .iter()
                .zip(caidas.iter())
                .any(|((tx, ty), caida)| !caida && (tx - x).hypot(ty - y) <= RADIO_TORRE)
        });
        if le_pego || cerca {
            tags.push(BAJO_TORRE.to_string());
        }
    }

    if let Some(umbral) = umbral_dano(rol(victima), sec / 60.0) {
        let es_rival = |pid: i32| team_of(pid).is_some_and(|t| t != equipo);
        if dano_devuelto(ev, es_rival) <= umbral {
            tags.push(POCO_DANO.to_string());
        }
    }
    tags
}

/// El precio y las etiquetas sólo-API de cada muerte de la partida, en orden.
///
/// `plays` son las de `winprob::plays` sobre la misma partida: de ahí sale lo
/// que costó cada muerte y lo que valió cada objetivo.
///
/// Un objetivo rival se reparte **a partes iguales entre las muertes que lo
/// precedieron** en la ventana, una por jugador (la última de cada uno). Si se
/// cargara entero a cada una, perder cuatro y luego el barón diría que cada
/// muerte costó el barón, y sumarlas contaría el barón cuatro veces.
pub fn precios(tl: &TimelineDto, participants: &[ParticipantDto], plays: &[Play]) -> Vec<Precio> {
    let team_of = |pid: i32| participants.get((pid - 1) as usize).map(|p| p.teamId);
    let mut caidas = [false; 22];
    let mut out: Vec<Precio> = Vec::new();

    for ev in tl.info.frames.iter().flat_map(|f| f.events.iter()) {
        match ev.event_type.as_str() {
            "BUILDING_KILL" if ev.buildingType.as_deref() == Some("TOWER_BUILDING") => {
                if let Some(i) = ev.position.as_ref().and_then(|p| torre_en(p.x as f64, p.y as f64)) {
                    caidas[i] = true;
                }
            }
            "CHAMPION_KILL" => {
                if team_of(ev.victimId).is_none() {
                    continue;
                }
                let time = ev.timestamp as f64 / 1000.0;
                let wpa_death = plays
                    .iter()
                    .find(|p| p.victim == Some(ev.victimId) && (p.time - time).abs() < 1e-6)
                    .map(|p| -p.wpa)
                    .unwrap_or(0.0);
                out.push(Precio {
                    time,
                    victim: ev.victimId,
                    wpa_death,
                    tags: etiquetas(ev, participants, &caidas),
                    ..Default::default()
                });
            }
            _ => {}
        }
    }

    let mut mayor = vec![0.0f64; out.len()];
    for o in plays.iter().filter(|p| !matches!(p.kind.as_str(), "kill" | "execution")) {
        // `out` va en orden de tiempo: la última que se inserta de cada
        // jugador es su muerte más reciente antes del objetivo.
        let mut ultima: HashMap<i32, usize> = HashMap::new();
        for (i, d) in out.iter().enumerate() {
            if d.time <= o.time
                && d.time >= o.time - VENTANA_OBJETIVO
                && team_of(d.victim).is_some_and(|t| t != o.team_id)
            {
                ultima.insert(d.victim, i);
            }
        }
        if ultima.is_empty() {
            continue;
        }
        let parte = o.wpa / ultima.len() as f64;
        for i in ultima.into_values() {
            out[i].wpa_objective -= parte;
            if parte.abs() > mayor[i] {
                mayor[i] = parte.abs();
                out[i].objective = Some(o.kind.clone());
            }
        }
    }
    out
}

/// Todas tus miradas al mapa, en segundos de vídeo: los saltos de cámara del
/// metadata más los del informe por clics. Son casi siempre los mismos, así
/// que se unen por décima, igual que hace `VideoPlayer` (`allLooks`).
fn miradas(match_id: &str, camera_snaps: &[f64]) -> Vec<f64> {
    let informe = crate::camera_snaps::load_report(match_id).map(|r| r.snaps).unwrap_or_default();
    let mut vistos = std::collections::HashSet::new();
    let mut out: Vec<f64> = camera_snaps
        .iter()
        .copied()
        .chain(informe.iter().map(|s| s.t))
        .filter(|t| vistos.insert((t * 10.0).round() as i64))
        .collect();
    out.sort_by(f64::total_cmp);
    out
}

fn sin_mirar(miradas: &[f64], t_video: f64) -> bool {
    !miradas.iter().any(|t| *t >= t_video - MIRADAS_ANTES && *t <= t_video)
}

/// ¿La pelea que te mató te la abrieron desde la niebla?
///
/// `aperturas` son `(t_game, died, from_fog)` de `golpes::Apertura`. La de esta
/// muerte es la última que acabó contigo y empezó antes de ella. `golpes`
/// marca `died` si mueres hasta 10 s después del primer golpe o antes de que
/// la pelea se corte, así que se mira hasta 60 s atrás.
fn desde_niebla(aperturas: impl Iterator<Item = (f64, bool, bool)>, t_game: f64) -> bool {
    aperturas
        .filter(|(t, died, _)| *died && *t <= t_game + 0.5 && *t >= t_game - 60.0)
        .max_by(|a, b| a.0.total_cmp(&b.0))
        .is_some_and(|(_, _, niebla)| niebla)
}

/// Añade las etiquetas que salen de lo grabado a las muertes de quien grabó.
///
/// `camera_snaps` y `video_offset` son los del metadata de la partida. Sin
/// miradas grabadas no se pone `sin_mirar_mapa`: "no miraste" sería mentira
/// (igual que en `DeathsSection`). Sin HUD leído no hay aperturas y no se pone
/// `desde_niebla`.
pub fn etiquetar_video(match_id: &str, camera_snaps: &[f64], video_offset: Option<f64>, muertes: &mut [DeathCost]) {
    if muertes.is_empty() {
        return;
    }
    if let Some(off) = video_offset {
        let vistas = miradas(match_id, camera_snaps);
        if !vistas.is_empty() {
            for d in muertes.iter_mut() {
                if sin_mirar(&vistas, d.minute * 60.0 + off) {
                    d.tags.push(SIN_MIRAR.to_string());
                }
            }
        }
    }
    let aperturas = crate::golpes::aperturas_de(match_id);
    if aperturas.is_empty() {
        return;
    }
    for d in muertes.iter_mut() {
        let it = aperturas.iter().map(|a| (a.t_game, a.died, a.from_fog));
        if desde_niebla(it, d.minute * 60.0) {
            d.tags.push(DESDE_NIEBLA.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::winprob::fixtures::{diez, kill, monstruo, partida};

    fn precios_de(eventos: Vec<serde_json::Value>) -> Vec<Precio> {
        let ps = diez();
        let tl = partida(30, eventos);
        precios(&tl, &ps, &crate::winprob::plays(&tl, &ps))
    }

    fn tiene(p: &Precio, tag: &str) -> bool {
        p.tags.iter().any(|t| t == tag)
    }

    /// Lo que devolviste antes de morir: `participantId` es a quién pegaste.
    fn con_dano(mut ev: serde_json::Value, dado: &[(i32, i32)]) -> serde_json::Value {
        ev["victimDamageDealt"] = dado
            .iter()
            .map(|(pid, d)| serde_json::json!({ "participantId": pid, "physicalDamage": d, "type": "OTHER" }))
            .collect();
        ev
    }

    // Puntos del mapa: el eje del carril central, lejos de cualquier torre.
    const MID: (i32, i32) = (7450, 7450);

    #[test]
    fn la_muerte_cuesta_lo_que_gano_el_rival() {
        let ps = diez();
        let tl = partida(30, vec![kill(600_000, 8, 3, &[], MID.0, MID.1)]);
        let jugadas = crate::winprob::plays(&tl, &ps);
        let p = &precios(&tl, &ps, &jugadas)[0];
        assert_eq!(p.victim, 3);
        assert!(p.wpa_death < 0.0);
        assert!((p.wpa_death + jugadas[0].wpa).abs() < 1e-12);
        assert_eq!(p.wpa_objective, 0.0);
        assert_eq!(p.objective, None);
    }

    /// Moriste y el rival hizo el dragón: el dragón entra en el precio. Pasado
    /// el minuto, ya no es tuyo.
    #[test]
    fn el_objetivo_rival_de_despues_se_suma_a_la_muerte() {
        let ps = diez();
        let tl = partida(30, vec![kill(600_000, 8, 3, &[], MID.0, MID.1), monstruo(650_000, 200, "DRAGON")]);
        let jugadas = crate::winprob::plays(&tl, &ps);
        let dragon = jugadas.iter().find(|j| j.kind == "dragon").unwrap();
        let p = &precios(&tl, &ps, &jugadas)[0];
        assert!((p.wpa_objective + dragon.wpa).abs() < 1e-12);
        assert_eq!(p.objective.as_deref(), Some("dragon"));

        let tarde = precios_de(vec![kill(600_000, 8, 3, &[], MID.0, MID.1), monstruo(661_000, 200, "DRAGON")]);
        assert_eq!(tarde[0].wpa_objective, 0.0, "61 s después ya no cuenta");

        let propio = precios_de(vec![kill(600_000, 8, 3, &[], MID.0, MID.1), monstruo(650_000, 100, "DRAGON")]);
        assert_eq!(propio[0].wpa_objective, 0.0, "un dragón de tu equipo no te cuesta");
    }

    /// Cuatro muertes y el barón: cada una carga un cuarto, no el barón entero.
    #[test]
    fn un_objetivo_se_reparte_entre_las_muertes_que_lo_abrieron() {
        let ps = diez();
        let mut ev: Vec<serde_json::Value> =
            (1..=4).map(|v| kill(1_500_000 + v as i64 * 1000, 6, v, &[], MID.0, MID.1)).collect();
        ev.push(monstruo(1_540_000, 200, "BARON_NASHOR"));
        let tl = partida(30, ev);
        let jugadas = crate::winprob::plays(&tl, &ps);
        let baron = jugadas.iter().find(|j| j.kind == "baron").unwrap().wpa;
        let v = precios(&tl, &ps, &jugadas);
        for p in &v {
            assert!((p.wpa_objective + baron / 4.0).abs() < 1e-12, "{}", p.wpa_objective);
        }
    }

    #[test]
    fn jungla_si_el_jungla_rival_mata_o_asiste() {
        // 7 es el jungla del 200; 8 su medio.
        let v = precios_de(vec![
            kill(300_000, 7, 1, &[], MID.0, MID.1),
            kill(400_000, 8, 2, &[7], MID.0, MID.1),
            kill(500_000, 8, 3, &[9], MID.0, MID.1),
            // El jungla del 100 (2) muriendo contra el del 200: también.
            kill(550_000, 7, 2, &[], MID.0, MID.1),
        ]);
        assert!(tiene(&v[0], JUNGLA));
        assert!(tiene(&v[1], JUNGLA));
        assert!(!tiene(&v[2], JUNGLA));
        assert!(tiene(&v[3], JUNGLA));
    }

    #[test]
    fn fuera_de_zona_lejos_de_tu_carril() {
        let v = precios_de(vec![
            // El top (1) en mitad de su carril, y luego en el centro del mapa.
            kill(1_000_000, 6, 1, &[], 1512, 9000),
            kill(1_100_000, 6, 1, &[], MID.0, MID.1),
            // El jungla (2) no tiene carril: nunca está fuera de zona.
            kill(1_200_000, 6, 2, &[], 13000, 13000),
            // El support (5) en el carril de abajo.
            kill(1_300_000, 6, 5, &[], 9000, 1300),
        ]);
        assert!(!tiene(&v[0], FUERA_DE_ZONA));
        assert!(tiene(&v[1], FUERA_DE_ZONA));
        assert!(!tiene(&v[2], FUERA_DE_ZONA));
        assert!(!tiene(&v[3], FUERA_DE_ZONA));
    }

    #[test]
    fn bajo_torre_antes_del_14() {
        let torre_mid_azul = (5846, 6396);
        let mut pego_su_torre = kill(500_000, 8, 3, &[], 7000, 7400);
        pego_su_torre["victimDamageReceived"] = serde_json::json!([
            { "participantId": 0, "name": "Turret", "type": "TOWER", "physicalDamage": 300 }
        ]);
        let v = precios_de(vec![
            kill(300_000, 8, 3, &[], torre_mid_azul.0 + 300, torre_mid_azul.1),
            pego_su_torre,
            kill(600_000, 8, 3, &[], MID.0, MID.1),
            // Lo mismo, pasado el 14:00.
            kill(900_000, 8, 3, &[], torre_mid_azul.0 + 300, torre_mid_azul.1),
        ]);
        assert!(tiene(&v[0], BAJO_TORRE), "a 300 de tu torre");
        assert!(tiene(&v[1], BAJO_TORRE), "te pegó su torre aunque murieras lejos");
        assert!(!tiene(&v[2], BAJO_TORRE), "en el río, sin torre");
        assert!(!tiene(&v[3], BAJO_TORRE), "después del 14 no cuenta");
    }

    /// Una torre que ya cayó no es una torre: morir donde estaba no es un
    /// diveo.
    #[test]
    fn una_torre_caida_no_cuenta() {
        let torre_mid_azul = (5846, 6396);
        let v = precios_de(vec![
            serde_json::json!({
                "type": "BUILDING_KILL", "timestamp": 400_000, "killerId": 8,
                "buildingType": "TOWER_BUILDING", "towerType": "OUTER_TURRET", "teamId": 100,
                "position": { "x": torre_mid_azul.0, "y": torre_mid_azul.1 },
            }),
            kill(500_000, 8, 3, &[], torre_mid_azul.0 + 300, torre_mid_azul.1),
        ]);
        assert!(!tiene(&v[0], BAJO_TORRE));
    }

    #[test]
    fn poco_dano_devuelto_frente_a_tu_rol_y_tramo() {
        // Los cortes se leen de la tabla: cambian cada vez que se mide el corpus.
        let medio = umbral_dano("MIDDLE", 5.0).unwrap();
        let top = umbral_dano("TOP", 24.0).unwrap();
        assert_ne!(umbral_dano("TOP", 5.0), umbral_dano("TOP", 30.0), "el corte tiene que depender del tramo");
        let v = precios_de(vec![
            // Medio (3) en el 0-7: justo en el corte es poco; uno más, no.
            con_dano(kill(300_000, 8, 3, &[], MID.0, MID.1), &[(8, medio)]),
            con_dano(kill(320_000, 8, 3, &[], MID.0, MID.1), &[(8, medio + 1)]),
            // Top (1) en el 21-28, contra su propio corte.
            con_dano(kill(1_440_000, 6, 1, &[], 1512, 9000), &[(6, top)]),
            con_dano(kill(1_450_000, 6, 1, &[], 1512, 9000), &[(6, top + 1)]),
            // Mucho daño, pero a un esbirro (participantId 0) y a un aliado.
            con_dano(kill(1_460_000, 6, 1, &[], 1512, 9000), &[(0, 5000), (2, 5000)]),
        ]);
        assert!(tiene(&v[0], POCO_DANO));
        assert!(!tiene(&v[1], POCO_DANO));
        assert!(tiene(&v[2], POCO_DANO));
        assert!(!tiene(&v[3], POCO_DANO));
        assert!(tiene(&v[4], POCO_DANO), "el daño a esbirros o aliados no es daño devuelto");
    }

    #[test]
    fn sin_mirar_en_los_diez_segundos_previos() {
        let miradas = [100.0, 150.0];
        assert!(!sin_mirar(&miradas, 105.0));
        assert!(!sin_mirar(&miradas, 160.0), "justo a 10 s todavía cuenta");
        assert!(sin_mirar(&miradas, 161.0));
        assert!(sin_mirar(&miradas, 99.0), "una mirada después de morir no vale");
    }

    #[test]
    fn desde_niebla_es_la_pelea_que_te_mato() {
        // (t_game, died, from_fog)
        let aperturas = [(80.0, false, true), (95.0, true, false), (290.0, true, true)];
        assert!(!desde_niebla(aperturas.iter().copied(), 100.0), "la de 80 no te mató");
        assert!(desde_niebla(aperturas.iter().copied(), 296.0));
        assert!(!desde_niebla(aperturas.iter().copied(), 500.0), "ninguna pelea cerca");
    }

    /// Tus muertes, una por una, con su precio y sus etiquetas, sobre las
    /// partidas grabadas. Comprueba que la suma de las muertes solas es lo que
    /// Impacto llama "lo que costaron tus muertes".
    ///
    /// `MIS_PARTIDAS_DIR=C:/Users/Alejandro/Videos/LeagueRecorder cargo test --lib muertes_en_mis_partidas -- --nocapture`
    #[test]
    fn muertes_en_mis_partidas() {
        let Ok(dir) = std::env::var("MIS_PARTIDAS_DIR") else { return };
        let mut por_tag: HashMap<String, usize> = HashMap::new();
        let (mut n, mut suma, mut suma_obj, mut con_obj) = (0usize, 0.0f64, 0.0f64, 0usize);
        let mut caras: Vec<(f64, String, String)> = Vec::new();
        let mut ids: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).collect();
        ids.sort();
        for d in ids {
            let id = d.file_name().unwrap().to_string_lossy().to_string();
            let (Ok(raw), Ok(rtl), Ok(rm)) = (
                std::fs::read_to_string(d.join("riot_match.json")),
                std::fs::read_to_string(d.join("riot_timeline.json")),
                std::fs::read_to_string(d.join(format!("{id}.json"))),
            ) else {
                continue;
            };
            let m: crate::riot_api::MatchDto = serde_json::from_str(&raw).unwrap();
            let tl: TimelineDto = serde_json::from_str(&rtl).unwrap();
            let meta: crate::storage::MatchMetadata = serde_json::from_str(&rm).unwrap();
            let Some(yo) = meta.participants.iter().position(|p| p.is_self).map(|i| i as i32 + 1) else { continue };
            let t0 = std::time::Instant::now();
            let filas = crate::attribution::analyze(&tl, &m.info.participants);
            let c = filas.iter().find(|c| c.participant_id == yo).unwrap();
            let mut muertes = c.deaths_detail.clone();
            etiquetar_video(&id, &meta.camera_snaps, meta.video_offset, &mut muertes);
            let solas: f64 = muertes.iter().map(|d| d.wpa_death).sum();
            assert!(
                (solas - c.wpa_deaths).abs() < 1e-9,
                "{id}: las muertes suman {solas} y el desglose dice {}",
                c.wpa_deaths
            );
            let gano = m.info.participants[(yo - 1) as usize].win;
            println!(
                "\n{id} {} ({}) {} · {} muertes · {:+.1} pts · {:?}",
                c.champion,
                c.role,
                if gano { "victoria" } else { "derrota" },
                muertes.len(),
                100.0 * muertes.iter().map(|d| d.wpa).sum::<f64>(),
                t0.elapsed()
            );
            for d in &muertes {
                let s = d.minute * 60.0;
                println!(
                    "   {:02}:{:02}  {:+5.1}  (muerte {:+4.1}, objetivo {:+4.1} {:9})  {}",
                    (s / 60.0) as i64,
                    (s % 60.0) as i64,
                    100.0 * d.wpa,
                    100.0 * d.wpa_death,
                    100.0 * d.wpa_objective,
                    d.objective.as_deref().unwrap_or(""),
                    d.tags.join(" ")
                );
                n += 1;
                suma += d.wpa;
                suma_obj += d.wpa_objective;
                con_obj += d.objective.is_some() as usize;
                for t in &d.tags {
                    *por_tag.entry(t.clone()).or_default() += 1;
                }
                caras.push((d.wpa, id.clone(), format!("{:02}:{:02}", (s / 60.0) as i64, (s % 60.0) as i64)));
            }
        }
        if n == 0 {
            return;
        }
        println!(
            "\n{n} muertes · precio medio {:+.2} pts (de ello objetivo {:+.2}) · {:.0}% con objetivo detrás",
            100.0 * suma / n as f64,
            100.0 * suma_obj / n as f64,
            100.0 * con_obj as f64 / n as f64
        );
        let mut tags: Vec<_> = por_tag.into_iter().collect();
        tags.sort();
        for (t, k) in tags {
            println!("  {t:20} {k:3} ({:.0}%)", 100.0 * k as f64 / n as f64);
        }
        caras.sort_by(|a, b| a.0.total_cmp(&b.0));
        println!("las cinco más caras:");
        for (w, id, t) in caras.iter().take(5) {
            println!("  {:+.1} pts  {id} {t}", 100.0 * w);
        }
    }

    /// Recorre el corpus y saca el p10 de daño devuelto por rol y tramo, la
    /// distancia a la torre de las muertes en las que una torre pegó, y cuánto
    /// marca cada etiqueta. Comprueba que los cortes compilados siguen
    /// marcando ~10% de las muertes de cada celda.
    ///
    /// `CORPUS_DIR=D:/lol-corpus cargo test --release --lib baremos_de_muertes -- --nocapture`
    #[test]
    fn baremos_de_muertes_en_el_corpus() {
        use std::io::Read;
        let Ok(corpus) = std::env::var("CORPUS_DIR") else {
            return;
        };
        let roles = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
        let mut dano: HashMap<(String, usize), Vec<i32>> = HashMap::new();
        let mut marcadas: HashMap<(String, usize), (usize, usize)> = HashMap::new();
        let mut dist_torre: Vec<f64> = Vec::new();
        let mut por_tag: HashMap<String, usize> = HashMap::new();
        let (mut muertes, mut partidas, mut con_objetivo) = (0usize, 0usize, 0usize);
        let (mut suma_muerte, mut suma_objetivo) = (0.0f64, 0.0f64);

        let Ok(sub) = std::fs::read_dir(format!("{corpus}/partidas")) else { return };
        for dir in sub.flatten() {
            let Ok(ficheros) = std::fs::read_dir(dir.path()) else { continue };
            for f in ficheros.flatten() {
                let Ok(bytes) = std::fs::read(f.path()) else { continue };
                let mut texto = String::new();
                if flate2::read::GzDecoder::new(&bytes[..]).read_to_string(&mut texto).is_err() {
                    continue;
                }
                let Ok(d) = serde_json::from_str::<serde_json::Value>(&texto) else { continue };
                let Ok(ps) =
                    serde_json::from_value::<Vec<ParticipantDto>>(d["match"]["info"]["participants"].clone())
                else {
                    continue;
                };
                let Ok(tl) = serde_json::from_value::<TimelineDto>(d["timeline"].clone()) else { continue };
                partidas += 1;
                let jugadas = crate::winprob::plays(&tl, &ps);
                let precios = precios(&tl, &ps, &jugadas);
                let mut i = 0;
                for ev in tl.info.frames.iter().flat_map(|f| f.events.iter()) {
                    if ev.event_type != "CHAMPION_KILL" {
                        continue;
                    }
                    let Some(v) = ps.get((ev.victimId - 1) as usize) else { continue };
                    let p = &precios[i];
                    i += 1;
                    muertes += 1;
                    suma_muerte += p.wpa_death;
                    suma_objetivo += p.wpa_objective;
                    con_objetivo += p.objective.is_some() as usize;
                    for t in &p.tags {
                        *por_tag.entry(t.clone()).or_default() += 1;
                    }
                    let r = rol(v).to_string();
                    let celda = (r.clone(), tramo(ev.timestamp as f64 / 60_000.0));
                    let equipo = v.teamId;
                    let dd = dano_devuelto(ev, |pid| ps.get((pid - 1) as usize).is_some_and(|q| q.teamId != equipo));
                    dano.entry(celda.clone()).or_default().push(dd);
                    let m = marcadas.entry(celda).or_default();
                    m.0 += 1;
                    m.1 += p.tags.iter().any(|t| t == POCO_DANO) as usize;

                    let pego = ev.victimDamageReceived.iter().any(|d| !d.from_player() && d.source_type == "TOWER");
                    if let (true, Some(pos)) = (pego, ev.position.as_ref()) {
                        let (x, y) = (pos.x as f64, pos.y as f64);
                        let cerca = TORRES.iter().map(|(tx, ty)| (tx - x).hypot(ty - y)).fold(f64::MAX, f64::min);
                        dist_torre.push(cerca);
                    }
                }
            }
        }
        if partidas < 50 {
            println!("corpus demasiado pequeño ({partidas} partidas), no se comprueba");
            return;
        }

        println!("\n{partidas} partidas, {muertes} muertes\n");
        println!("const DANO_P10: [(&str, [i32; 5]); 5] = [");
        let mut fuera = Vec::new();
        for r in roles {
            let fila: Vec<String> = (0..5)
                .map(|t| {
                    let mut v = dano.get(&(r.to_string(), t)).cloned().unwrap_or_default();
                    v.sort_unstable();
                    v.get(v.len() / 10).map(|x| x.to_string()).unwrap_or_else(|| "0".into())
                })
                .collect();
            println!("    (\"{r}\", [{}]),", fila.join(", "));
            for t in 0..5 {
                if let Some((n, k)) = marcadas.get(&(r.to_string(), t)) {
                    let frac = *k as f64 / *n as f64;
                    if !(0.05..=0.20).contains(&frac) {
                        fuera.push(format!("{r}/{t}: {:.0}%", frac * 100.0));
                    }
                }
            }
        }
        println!("];");

        dist_torre.sort_by(f64::total_cmp);
        let q = |p: f64| dist_torre[((dist_torre.len() - 1) as f64 * p) as usize];
        println!(
            "\nmuertes con daño de torre: {} · distancia a la torre p50 {:.0} p75 {:.0} p90 {:.0}",
            dist_torre.len(),
            q(0.5),
            q(0.75),
            q(0.9)
        );
        println!(
            "\nprecio medio: muerte {:+.2} pts, objetivo de después {:+.2} pts; {:.0}% de las muertes con objetivo",
            100.0 * suma_muerte / muertes as f64,
            100.0 * suma_objetivo / muertes as f64,
            100.0 * con_objetivo as f64 / muertes as f64
        );
        let mut tags: Vec<_> = por_tag.into_iter().collect();
        tags.sort();
        for (t, n) in tags {
            println!("  {t:20} {:.1}% de las muertes", 100.0 * n as f64 / muertes as f64);
        }

        assert!(fuera.is_empty(), "el corte de daño ya no marca ~10%: {}", fuera.join(", "));
        assert!(
            (q(0.5) - RADIO_TORRE).abs() < 150.0,
            "RADIO_TORRE ({RADIO_TORRE}) se ha separado de la mediana medida ({:.0})",
            q(0.5)
        );
    }
}
