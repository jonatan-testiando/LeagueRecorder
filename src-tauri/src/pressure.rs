//! Presión absorbida: cuándo tiraste de rivales hacia ti y qué sacó tu equipo
//! mientras tanto.
//!
//! Es el caso que ningún marcador recoge: *"me vienen a matar 4, pero gracias a
//! eso mi equipo tumba dos torres"*. En el KDA eso es una muerte y punto.
//!
//! **Esto mide, no puntúa**, y sigue siendo así aunque ya exista el modelo de
//! probabilidad de victoria. El modelo da la moneda común —`wpa_elsewhere` está
//! en probabilidad de victoria, no en oro— pero no responde la pregunta que
//! haría falta para repartir: *¿qué habría pasado si esos rivales no hubieran
//! ido a por ti?*. Eso es un contrafactual, y el modelo sólo evalúa estados que
//! sí ocurrieron.
//!
//! Sumar `wpa_elsewhere` al WPA directo de un jugador contaría dos veces el
//! mismo valor: los que ejecutaron ya lo tienen. Así que se da al lado, no
//! dentro. Es honesto y sigue siendo la información que ningún marcador enseña.

use crate::occupancy::Occupancy;
use std::collections::HashMap;
use crate::riot_api::{ParticipantDto, TimelineDto};

/// A qué distancia se considera que un rival "está encima". Es el mismo umbral
/// que usa `gank::ENEMY_NEAR`, que ya está afinado contra partidas reales.
const RIVAL_ENCIMA: f64 = 2200.0;

/// Cuántos rivales hacen falta para hablar de presión. Se cuentan **enteros**,
/// no sumando confianzas: cinco rivales al 0,45 sumaban 2,25 y disparaban el
/// detector sin que se supiera dónde estaba ninguno. Eso hacía que los tramos
/// empezaran hasta medio minuto antes de que la presión existiera de verdad.
const MINIMO_RIVALES: usize = 2;

/// Confianza mínima para dar por hecho que un rival estaba encima.
const CERTEZA: f64 = 0.5;

/// Daño A CAMPEONES infligido en el minuto para dar por hecho que hubo combate
/// y no sólo cercanía.
///
/// Se mira el daño **infligido**, no el recibido, y eso es deliberado: la
/// timeline desglosa por objetivo lo que repartes (`totalDamageDoneToChampions`)
/// pero no lo que encajas — `totalDamageTaken` mezcla campeones, esbirros,
/// torres y campamentos de jungla. Con el recibido, un jungla farmeando pasaba
/// la verja todo el rato y el detector lo confundía con estar aguantando gente.
const DANO_MINIMO: i32 = 200;

/// Daño recibido en el minuto que, si no estabas farmeando jungla, cuenta como
/// combate aunque no repartieras tú.
const ENCAJADO_MINIMO: i32 = 300;

/// Monstruos de jungla matados en el minuto por encima de los cuales se asume
/// que el daño recibido viene del campamento y no de un rival.
const JUNGLA_SOSPECHOSA: i32 = 2;

/// Cuánto tiene que durar un tramo para contar. Por debajo de esto es un cruce
/// fortuito, no presión sostenida.
const MINIMO_SEGUNDOS: f64 = 15.0;

/// Un tramo se corta si la presión se interrumpe más de esto. Sin este corte,
/// dos episodios distintos separados por minutos se fundían en uno solo de 280 s.
const CORTE: f64 = 15.0;

/// A partir de qué distancia lo que pasa "es en otra zona". Un cuarto del ancho
/// del mapa: lo bastante lejos como para que no pudieras estar en las dos cosas.
const OTRA_ZONA: f64 = 5000.0;

/// Cada cuántos segundos se muestrea la ocupación.
const PASO: f64 = 5.0;

/// Cuánto se sigue mirando tras el final de la presión. Tirar una torre lleva
/// su tiempo: el provecho no es instantáneo.
const COLA: f64 = 20.0;

/// Un tramo en el que un jugador tuvo rivales encima, con lo que su equipo sacó
/// lejos de allí mientras tanto.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PressureWindow {
    pub participant_id: i32,
    pub champion: String,
    /// Segundos de partida en que empieza y acaba la presión **confirmada**.
    ///
    /// Es una cota inferior, no la duración real. La API da una posición por
    /// minuto, así que entre anclas la incertidumbre es de miles de unidades y
    /// el detector deja de poder afirmar nada — aunque la presión siguiera. Un
    /// tramo real de 36 s puede aparecer como 10 s si sólo hay anclas al
    /// principio. Medido contra un caso que el usuario reconoció: el arranque
    /// acierta dentro del intervalo de muestreo, el final se queda corto.
    pub start: f64,
    pub end: f64,
    /// Máximo de rivales comprometidos a la vez (suma de confianzas, así que
    /// puede ser 3,4 en vez de 3: la posición no se conoce con certeza).
    pub max_enemies: f64,
    /// Dónde estabas, en coordenadas de mapa.
    pub x: f64,
    pub y: f64,
    /// Acabó contigo muerto. No lo invalida: morir aguantando a cuatro mientras
    /// tu equipo saca dos torres es un buen intercambio.
    pub died: bool,
    /// Oro de asesinatos que tu equipo hizo lejos de ti durante el tramo.
    pub gold_elsewhere: f64,
    /// Probabilidad de victoria que tu equipo ganó lejos de ti durante el tramo.
    ///
    /// **Se mide, no se te suma.** Repartir esto entre quien aguantó y quien
    /// ejecutó exige saber qué fracción del mérito es de cada uno, y eso sólo
    /// sale de un modelo contrafactual ("¿qué habría pasado si esos rivales no
    /// hubieran ido a por ti?") que todavía no existe. Sumarlo sin más contaría
    /// dos veces el mismo valor: los ejecutores ya lo tienen en su WPA directo.
    pub wpa_elsewhere: f64,
    /// Objetivos que tu equipo tomó lejos de ti durante el tramo. Contados, no
    /// convertidos a oro: ver la nota del módulo.
    pub towers_elsewhere: i32,
    pub inhibs_elsewhere: i32,
    pub plates_elsewhere: i32,
    pub epics_elsewhere: i32,
}

impl PressureWindow {
    /// Si el tramo produjo algo aprovechable en otra parte.
    pub fn paid_off(&self) -> bool {
        self.gold_elsewhere > 0.0
            || self.towers_elsewhere > 0
            || self.inhibs_elsewhere > 0
            || self.plates_elsewhere > 0
            || self.epics_elsewhere > 0
    }
}

/// Algo de valor que ocurrió en un punto y un instante.
struct Valor {
    sec: f64,
    x: f64,
    y: f64,
    team: i32,
    gold: f64,
    torre: i32,
    inhib: i32,
    placa: i32,
    epico: i32,
}

fn valores(tl: &TimelineDto, participants: &[ParticipantDto]) -> Vec<Valor> {
    let team_of = |pid: i32| participants.get((pid - 1) as usize).map(|p| p.teamId);
    let mut out = Vec::new();
    for frame in &tl.info.frames {
        for ev in &frame.events {
            let sec = ev.timestamp as f64 / 1000.0;
            let Some(p) = &ev.position else { continue };
            let (x, y) = (p.x as f64, p.y as f64);
            let mut v = Valor { sec, x, y, team: 0, gold: 0.0, torre: 0, inhib: 0, placa: 0, epico: 0 };
            match ev.event_type.as_str() {
                "CHAMPION_KILL" => {
                    let Some(t) = team_of(ev.killerId) else { continue };
                    v.team = t;
                    v.gold = (ev.bounty + ev.shutdownBounty) as f64;
                }
                "BUILDING_KILL" => {
                    let Some(t) = team_of(ev.killerId) else { continue };
                    v.team = t;
                    // `BUILDING_KILL` cubre torres e inhibidores; contarlos
                    // juntos inflaba el recuento de torres en los cierres de
                    // partida, donde caen varios seguidos.
                    if ev.buildingType.as_deref() == Some("INHIBITOR_BUILDING") {
                        v.inhib = 1;
                    } else {
                        v.torre = 1;
                    }
                }
                "TURRET_PLATE_DESTROYED" => {
                    let Some(t) = team_of(ev.killerId) else { continue };
                    v.team = t;
                    v.placa = 1;
                }
                "ELITE_MONSTER_KILL" => {
                    v.team = if ev.killerTeamId != 0 {
                        ev.killerTeamId
                    } else {
                        match team_of(ev.killerId) {
                            Some(t) => t,
                            None => continue,
                        }
                    };
                    v.epico = 1;
                }
                _ => continue,
            }
            out.push(v);
        }
    }
    out
}

/// Encuentra los tramos de presión de todos los jugadores.
pub fn detect(tl: &TimelineDto, participants: &[ParticipantDto]) -> Vec<PressureWindow> {
    detect_with(tl, participants, RIVAL_ENCIMA)
}

/// Igual que `detect` pero con el radio de "estar encima" configurable, para
/// poder barrerlo en las pruebas contra momentos que el usuario reconoce.
pub fn detect_with(
    tl: &TimelineDto,
    participants: &[ParticipantDto],
    radio: f64,
) -> Vec<PressureWindow> {
    let occ = Occupancy::build(tl, participants);
    let vals = valores(tl, participants);
    let jugadas = crate::winprob::plays(tl, participants);

    // Daño a campeones que cada jugador repartió en cada minuto.
    //
    // Sin una señal de combate, el detector confundía "tener rivales cerca" con
    // "estar absorbiendo presión": en línea tienes rivales a 2000 unidades todo
    // el rato y eso no es aguantar a nadie.
    //
    // Limitación que queda: viene por minutos, así que acota el tramo con esa
    // granularidad y no al segundo.
    // `true` si en ese minuto hubo pelea contra campeones.
    //
    // Ninguna señal sola vale, y ambas fallan de forma opuesta:
    //
    // - El daño **infligido** a campeones es inequívoco (un campamento no lo
    //   dispara) pero se pierde justo el caso que buscamos: si te saltan cuatro
    //   encima y te persiguen, no repartes nada.
    // - El daño **recibido** sí capta eso, pero `totalDamageTaken` mezcla
    //   campeones con esbirros, torres y campamentos de jungla, porque la
    //   timeline no lo desglosa por origen. Un jungla farmeando pasaba la verja
    //   todo el rato.
    //
    // Así que se aceptan las dos, descartando el daño recibido cuando en ese
    // mismo minuto se estaba limpiando jungla — que es de dónde venía.
    let mut combate: HashMap<(i32, usize), bool> = HashMap::new();
    for (minute, frame) in tl.info.frames.iter().enumerate().skip(1) {
        let prev = &tl.info.frames[minute - 1];
        for (key, pf) in &frame.participantFrames {
            let Ok(pid) = key.parse::<i32>() else { continue };
            let ant = prev.participantFrames.get(key);
            let d = |f: fn(&crate::riot_api::ParticipantFrameDto) -> i32| {
                f(pf) - ant.map(f).unwrap_or(0)
            };
            let repartido = d(|p| p.damageStats.totalDamageDoneToChampions);
            let encajado = d(|p| p.damageStats.totalDamageTaken);
            let jungla = d(|p| p.jungleMinionsKilled);
            combate.insert(
                (pid, minute),
                repartido >= DANO_MINIMO
                    || (encajado >= ENCAJADO_MINIMO && jungla <= JUNGLA_SOSPECHOSA),
            );
        }
    }
    let fin = tl
        .info
        .frames
        .last()
        .map(|f| f.timestamp as f64 / 1000.0)
        .unwrap_or(0.0);

    // Muertes por jugador, para marcar los tramos que acabaron contigo muerto.
    let muertes: Vec<(i32, f64)> = tl
        .info
        .frames
        .iter()
        .flat_map(|f| f.events.iter())
        .filter(|e| e.event_type == "CHAMPION_KILL")
        .map(|e| (e.victimId, e.timestamp as f64 / 1000.0))
        .collect();

    let mut out = Vec::new();
    for (idx, p) in participants.iter().enumerate() {
        let pid = (idx + 1) as i32;
        let rival = if p.teamId == 100 { 200 } else { 100 };

        // Recorre la partida marcando en qué instantes había presión, y agrupa
        // los consecutivos en tramos.
        let mut abierto: Option<PressureWindow> = None;
        let mut sec = 0.0;
        while sec <= fin {
            let (enemigos, seguros, aliados, pos) = match occ.estimate(pid, sec) {
                Some(e) => (
                    occ.committed(participants, rival, sec, e.x, e.y, radio),
                    occ.committed_sure(participants, rival, sec, e.x, e.y, radio, CERTEZA),
                    // Incluye al propio jugador, que siempre suma 1 en su
                    // posición: es justo lo que interesa contar.
                    occ.committed(participants, p.teamId, sec, e.x, e.y, radio),
                    (e.x, e.y),
                ),
                None => (0.0, 0, 0.0, (0.0, 0.0)),
            };

            // La condición que define el fenómeno, y que faltaba: no basta con
            // tener rivales encima, hay que tener MÁS rivales que aliados. Si
            // hay 4 y 4, eso es una pelea; el equipo no gana nada en otra zona.
            // Con `enemigos > aliados`, los que quedan sueltos por el mapa son
            // menos que los tuyos: ahí es donde nace la ventaja.
            //
            // Sin esto salían 70 tramos por partida —básicamente toda la fase
            // final, donde todo el mundo va junto— en vez de los episodios
            // reales de tirar de gente.
            // Además de estar en inferioridad, tiene que haber combate contra
            // campeones: sin esto, estar cerca de rivales contaba como aguantarlos.
            // OJO con el índice: `dano` guarda cada intervalo bajo la clave del
            // fotograma que lo CIERRA, así que el daño del minuto que contiene
            // `sec` está en la clave siguiente. Consultarlo sin el +1 miraba el
            // minuto anterior, y la verja de combate abría hasta un minuto
            // antes de tiempo — el desfase sistemático que se veía en el
            // reproductor.
            let hubo_combate = combate
                .get(&(pid, (sec / 60.0) as usize + 1))
                .copied()
                .unwrap_or(false);
            let hay_presion =
                seguros >= MINIMO_RIVALES && enemigos > aliados && hubo_combate;

            // Un hueco corto no rompe el tramo (te sueltan un segundo y vuelven),
            // pero uno largo sí: son dos episodios distintos, y fundirlos daba
            // tramos absurdos de 280 s.
            if let Some(w) = &abierto {
                if sec - w.end > CORTE {
                    let mut cerrada = abierto.take().unwrap();
                    cerrar(&mut cerrada, &vals, &jugadas, &muertes, p.teamId);
                    out.push(cerrada);
                }
            }

            if hay_presion {
                match &mut abierto {
                    Some(w) => {
                        w.end = sec;
                        if enemigos > w.max_enemies {
                            w.max_enemies = enemigos;
                            w.x = pos.0;
                            w.y = pos.1;
                        }
                    }
                    None => {
                        abierto = Some(PressureWindow {
                            participant_id: pid,
                            champion: p.championName.clone(),
                            start: sec,
                            end: sec,
                            max_enemies: enemigos,
                            x: pos.0,
                            y: pos.1,
                            died: false,
                            gold_elsewhere: 0.0,
                            wpa_elsewhere: 0.0,
                            towers_elsewhere: 0,
                            inhibs_elsewhere: 0,
                            plates_elsewhere: 0,
                            epics_elsewhere: 0,
                        });
                    }
                }
            }
            sec += PASO;
        }
        if let Some(mut w) = abierto.take() {
            cerrar(&mut w, &vals, &jugadas, &muertes, p.teamId);
            out.push(w);
        }
    }

    out.retain(|w| w.end - w.start >= MINIMO_SEGUNDOS && w.paid_off());
    out.sort_by(|a, b| a.start.total_cmp(&b.start));
    out
}

/// Cierra un tramo: qué sacó el equipo lejos de allí, y si acabó en muerte.
fn cerrar(
    w: &mut PressureWindow,
    vals: &[Valor],
    jugadas: &[crate::winprob::Play],
    muertes: &[(i32, f64)],
    team: i32,
) {
    // La probabilidad de victoria que su equipo ganó lejos de aquí. Mismo
    // criterio de distancia y ventana que el oro y los objetivos.
    for j in jugadas {
        if j.team_id != team || j.time < w.start || j.time > w.end + COLA {
            continue;
        }
        // Las jugadas en las que participó el propio jugador no cuentan: eso es
        // trabajo suyo directo, no fruto de haber atraído rivales a otro sitio.
        if j.shares.iter().any(|(pid, _)| *pid == w.participant_id) {
            continue;
        }
        w.wpa_elsewhere += j.wpa;
    }

    for v in vals {
        if v.team != team || v.sec < w.start || v.sec > w.end + COLA {
            continue;
        }
        let d = ((v.x - w.x).powi(2) + (v.y - w.y).powi(2)).sqrt();
        if d < OTRA_ZONA {
            continue; // Pasó donde estabas tú: no es provecho de tu presión.
        }
        w.gold_elsewhere += v.gold;
        w.towers_elsewhere += v.torre;
        w.inhibs_elsewhere += v.inhib;
        w.plates_elsewhere += v.placa;
        w.epics_elsewhere += v.epico;
    }
    w.died = muertes
        .iter()
        .any(|(pid, sec)| *pid == w.participant_id && *sec >= w.start && *sec <= w.end + PASO);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Barrido del radio de "estar encima". El usuario reportó un tramo que
    /// empezaba ~35 s antes de lo que él recordaba, así que interesa ver cuánto
    /// se acorta el tramo al exigir que los rivales estén de verdad pegados.
    #[test]
    fn sensibilidad_al_radio() {
        let Ok(dir) = std::env::var("ATTR_CORPUS_DIR") else {
            return;
        };
        let mut ids: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter_map(|e| e.file_name().to_str()?.strip_suffix(".match.json").map(str::to_string))
            .collect();
        ids.sort();
        let partidas: Vec<_> = ids
            .iter()
            .map(|id| {
                let tl: crate::riot_api::TimelineDto = serde_json::from_str(
                    &std::fs::read_to_string(format!("{dir}/{id}.timeline.json")).unwrap(),
                )
                .unwrap();
                let m: serde_json::Value = serde_json::from_str(
                    &std::fs::read_to_string(format!("{dir}/{id}.match.json")).unwrap(),
                )
                .unwrap();
                let ps: Vec<ParticipantDto> =
                    serde_json::from_value(m["info"]["participants"].clone()).unwrap();
                (tl, ps)
            })
            .collect();

        println!("\n{:>7} {:>9} {:>12} {:>10}", "radio", "tramos", "dur.mediana", "por jugador");
        for radio in [1200.0, 1500.0, 1800.0, 2200.0] {
            let mut durs: Vec<f64> = Vec::new();
            let mut total = 0usize;
            for (tl, ps) in &partidas {
                let ws = detect_with(tl, ps, radio);
                total += ws.len();
                durs.extend(ws.iter().map(|w| w.end - w.start));
            }
            durs.sort_by(f64::total_cmp);
            let mediana = if durs.is_empty() { 0.0 } else { durs[durs.len() / 2] };
            println!(
                "{radio:>7.0} {total:>9} {mediana:>11.0}s {:>10.1}",
                total as f64 / (partidas.len() * 10) as f64
            );
        }
    }

    /// Cuántos tramos le salen a UN jugador concreto en sus propias partidas.
    /// Es lo que ve la UI, que sólo muestra los tuyos: la media global puede ser
    /// sana y aun así un jugador concreto quedarse sin ninguno.
    #[test]
    fn tramos_del_jugador_propio() {
        let (Ok(dir), Ok(mapa)) = (
            std::env::var("ATTR_CORPUS_DIR"),
            std::env::var("ATTR_MIS_CAMPEONES"),
        ) else {
            return;
        };
        let mios: std::collections::HashMap<String, String> =
            serde_json::from_str(&std::fs::read_to_string(mapa).unwrap()).unwrap();
        let mut ids: Vec<&String> = mios.keys().collect();
        ids.sort();

        let (mut con, mut sin) = (0usize, 0usize);
        for id in ids {
            let Ok(tl_raw) = std::fs::read_to_string(format!("{dir}/{id}.timeline.json")) else {
                continue;
            };
            let tl: crate::riot_api::TimelineDto = serde_json::from_str(&tl_raw).unwrap();
            let m: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(format!("{dir}/{id}.match.json")).unwrap(),
            )
            .unwrap();
            let ps: Vec<ParticipantDto> =
                serde_json::from_value(m["info"]["participants"].clone()).unwrap();
            let champ = &mios[id];
            let Some(idx) = ps.iter().position(|p| &p.championName == champ) else {
                println!("{id}: no encuentro a {champ} entre los participantes");
                continue;
            };
            let pid = (idx + 1) as i32;
            let ws = detect(&tl, &ps);
            let n = ws.iter().filter(|w| w.participant_id == pid).count();
            if n == 0 { sin += 1 } else { con += 1 }
            println!(
                "{id}  {champ:<10} pid={pid}  tramos propios: {n}  (de {} en la partida)",
                ws.len()
            );
        }
        println!("\ncon tramos: {con} | sin ninguno: {sin}");
    }

    #[test]
    fn sobre_partidas_reales() {
        let Ok(dir) = std::env::var("ATTR_CORPUS_DIR") else {
            return;
        };
        let mut ids: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter_map(|e| e.file_name().to_str()?.strip_suffix(".match.json").map(str::to_string))
            .collect();
        ids.sort();

        let (mut total, mut con_muerte, mut partidas) = (0usize, 0usize, 0usize);
        let mut mejor: Option<(String, PressureWindow)> = None;
        let mut duraciones: Vec<f64> = Vec::new();

        for id in &ids {
            let tl: crate::riot_api::TimelineDto = serde_json::from_str(
                &std::fs::read_to_string(format!("{dir}/{id}.timeline.json")).unwrap(),
            )
            .unwrap();
            let m: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(format!("{dir}/{id}.match.json")).unwrap(),
            )
            .unwrap();
            let ps: Vec<ParticipantDto> =
                serde_json::from_value(m["info"]["participants"].clone()).unwrap();

            let ws = detect(&tl, &ps);
            partidas += 1;
            total += ws.len();
            for w in &ws {
                duraciones.push(w.end - w.start);
                if w.died {
                    con_muerte += 1;
                }
                // El caso que buscamos: aguantar a varios y que el equipo saque
                // estructuras mientras tanto.
                let puntos = w.towers_elsewhere * 3 + w.plates_elsewhere + w.epics_elsewhere * 2;
                let mejor_puntos = mejor.as_ref().map_or(-1, |(_, b)| {
                    b.towers_elsewhere * 3 + b.plates_elsewhere + b.epics_elsewhere * 2
                });
                if puntos > mejor_puntos
                    || (puntos == mejor_puntos
                        && mejor.as_ref().map_or(true, |(_, b)| w.max_enemies > b.max_enemies))
                {
                    mejor = Some((id.clone(), w.clone()));
                }
            }
        }

        assert!(total > 0, "no se detectó ni un tramo de presión");

        // Cuántos le tocan a un jugador concreto: si lo normal fuera cero, la
        // sección de la UI no se pintaría casi nunca y parecería estropeada.
        let mut por_jugador: Vec<usize> = Vec::new();
        for id in &ids {
            let tl: crate::riot_api::TimelineDto = serde_json::from_str(
                &std::fs::read_to_string(format!("{dir}/{id}.timeline.json")).unwrap(),
            )
            .unwrap();
            let m: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(format!("{dir}/{id}.match.json")).unwrap(),
            )
            .unwrap();
            let ps: Vec<ParticipantDto> =
                serde_json::from_value(m["info"]["participants"].clone()).unwrap();
            let ws = detect(&tl, &ps);
            for pid in 1..=10 {
                por_jugador.push(ws.iter().filter(|w| w.participant_id == pid).count());
            }
        }
        por_jugador.sort_unstable();
        let ceros = por_jugador.iter().filter(|n| **n == 0).count();
        println!(
            "tramos por jugador y partida: mediana {} | máx {} | con cero: {} de {} ({:.0}%)",
            por_jugador[por_jugador.len() / 2],
            por_jugador.last().unwrap(),
            ceros,
            por_jugador.len(),
            100.0 * ceros as f64 / por_jugador.len() as f64
        );
        duraciones.sort_by(f64::total_cmp);
        println!(
            "\n{total} tramos de presión con provecho en {partidas} partidas \
             ({:.1} por partida)",
            total as f64 / partidas as f64
        );
        println!(
            "duración: mediana {:.0}s | p90 {:.0}s | acabaron en muerte: {con_muerte} ({:.0}%)",
            duraciones[duraciones.len() / 2],
            duraciones[(duraciones.len() as f64 * 0.9) as usize],
            100.0 * con_muerte as f64 / total as f64
        );
        if let Some((id, w)) = &mejor {
            println!(
                "\nel caso más claro — {} en {id}:\n  \
                 minuto {:.0}, {:.1} rivales encima durante {:.0}s{}\n  \
                 mientras tanto su equipo, lejos de allí: {} torres, {} inhibidores, \
                 {} placas, {} épicos, {:.0} de oro en asesinatos",
                w.champion,
                w.start / 60.0,
                w.max_enemies,
                w.end - w.start,
                if w.died { " (y muere)" } else { "" },
                w.towers_elsewhere,
                w.inhibs_elsewhere,
                w.plates_elsewhere,
                w.epics_elsewhere,
                w.gold_elsewhere
            );
        }
    }
}

#[cfg(test)]
mod diagnostico {
    use super::*;

    /// Traza segundo a segundo lo que ve el estimador en una ventana.
    #[test]
    fn traza_de_una_ventana() {
        let (Ok(dir), Ok(id), Ok(champ)) = (
            std::env::var("ATTR_CORPUS_DIR"),
            std::env::var("DIAG_MATCH"),
            std::env::var("DIAG_CHAMP"),
        ) else {
            return;
        };
        let (desde, hasta) = (
            std::env::var("DIAG_DESDE").ok().and_then(|v| v.parse().ok()).unwrap_or(0.0f64),
            std::env::var("DIAG_HASTA").ok().and_then(|v| v.parse().ok()).unwrap_or(0.0f64),
        );
        let tl: crate::riot_api::TimelineDto = serde_json::from_str(
            &std::fs::read_to_string(format!("{dir}/{id}.timeline.json")).unwrap(),
        ).unwrap();
        let m: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(format!("{dir}/{id}.match.json")).unwrap(),
        ).unwrap();
        let ps: Vec<ParticipantDto> = serde_json::from_value(m["info"]["participants"].clone()).unwrap();
        let idx = ps.iter().position(|p| p.championName == champ).unwrap();
        let pid = (idx + 1) as i32;
        let rival = if ps[idx].teamId == 100 { 200 } else { 100 };
        let occ = Occupancy::build(&tl, &ps);

        println!("
  tiempo    tu posicion      rivales(suma/ciertos)  aliados  ¿presion?");
        let mut sec = desde;
        while sec <= hasta {
            if let Some(e) = occ.estimate(pid, sec) {
                let en = occ.committed(&ps, rival, sec, e.x, e.y, RIVAL_ENCIMA);
                let seg = occ.committed_sure(&ps, rival, sec, e.x, e.y, RIVAL_ENCIMA, CERTEZA);
                let al = occ.committed(&ps, ps[idx].teamId, sec, e.x, e.y, RIVAL_ENCIMA);
                let quienes: Vec<String> = ps.iter().enumerate()
                    .filter(|(_, p)| p.teamId == rival)
                    .filter_map(|(i, p)| {
                        let c = occ.presence((i + 1) as i32, sec, e.x, e.y, RIVAL_ENCIMA);
                        (c >= 0.5).then(|| format!("{}:{:.1}", p.championName, c))
                    }).collect();
                println!("  {:.0}:{:02.0}  ({:>5.0},{:>5.0})  r={:.1}/{}  a={:.1}  {}  {}",
                    (sec/60.0).floor(), sec%60.0, e.x, e.y, en, seg, al,
                    if seg >= MINIMO_RIVALES && en > al { "SI" } else { "no" },
                    quienes.join(" "));
            }
            sec += 5.0;
        }
    }

    /// Imprime los tramos de un jugador en TIEMPO DE PARTIDA, sin aplicar el
    /// desplazamiento del vídeo. Sirve para separar dos causas que se confunden
    /// entre sí cuando el usuario reporta un desfase: que el detector arranque
    /// antes de tiempo, o que se esté aplicando mal el desplazamiento.
    #[test]
    fn tramos_en_tiempo_de_partida() {
        let (Ok(dir), Ok(id), Ok(champ)) = (
            std::env::var("ATTR_CORPUS_DIR"),
            std::env::var("DIAG_MATCH"),
            std::env::var("DIAG_CHAMP"),
        ) else {
            return;
        };
        let tl: crate::riot_api::TimelineDto = serde_json::from_str(
            &std::fs::read_to_string(format!("{dir}/{id}.timeline.json")).unwrap(),
        )
        .unwrap();
        let m: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(format!("{dir}/{id}.match.json")).unwrap(),
        )
        .unwrap();
        let ps: Vec<ParticipantDto> =
            serde_json::from_value(m["info"]["participants"].clone()).unwrap();
        let idx = ps.iter().position(|p| p.championName == champ).unwrap();
        let pid = (idx + 1) as i32;

        let fmt = |s: f64| format!("{:.0}:{:02.0}", (s / 60.0).floor(), s % 60.0);
        println!("\ntramos de {champ} (pid {pid}) EN TIEMPO DE PARTIDA:");
        for w in detect(&tl, &ps).iter().filter(|w| w.participant_id == pid) {
            println!(
                "  {} -> {}   ({:.1} rivales, {:.0}s){}",
                fmt(w.start),
                fmt(w.end),
                w.max_enemies,
                w.end - w.start,
                if w.died { " muere" } else { "" }
            );
        }
    }
}
