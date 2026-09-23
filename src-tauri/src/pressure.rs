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

/// A qué distancia está un rival "encima" cuando lo dice el **vídeo**.
///
/// Más apretado que `RIVAL_ENCIMA` a propósito, y medido: en el segundo exacto
/// en que te matan —el único instante en que la respuesta no admite discusión—
/// el rival más cercano está a 434 unidades de mediana y el segundo a 1.491
/// (72 muertes, 17 partidas).
///
/// El valor final sale de barrer el radio (`barrido_de_radios_del_video`): entre
/// 900 y 1.200 todo se comporta igual —misma duración, y el vídeo cubre la
/// muerte por sí solo en 4 de 7 tramos sin que haya que estirar nada— y a partir
/// de 1.300 empeora, a 3 de 7 y 5 segundos de estirón. 1.200 es el punto más
/// apretado en el que apretar más ya no aporta.
///
/// `RIVAL_ENCIMA` vale 2.200 porque tiene que absorber la incertidumbre de
/// estimar posiciones entre fotogramas de minuto. El vídeo no estima: ve el
/// icono o no lo ve. Con el mismo radio holgado, el tramo se abría en cuanto
/// alguien entraba en la zona, que es varios segundos antes de tenerlo encima.
const RIVAL_ENCIMA_VIDEO: f64 = 1200.0;

/// A qué distancia se da por hecho que el rival **se fue**.
///
/// Más holgado que el de abrir, a propósito: un rival oscilando alrededor del
/// umbral no debe trocear el episodio. Pero no tanto como `RIVAL_ENCIMA`, que
/// en línea se cumple todo el rato y devolvía el tramo entero sin recortar.
const RIVAL_SE_FUE: f64 = 1600.0;

/// Fracción del tramo original que el vídeo tiene que haberte visto para que se
/// le deje mover los bordes.
///
/// El seguimiento cubre el 74% del tiempo, no el 100%. Sin esta comprobación,
/// un hueco en el rastro se leía como "no había rivales" en vez de "no se sabe",
/// y salían tramos de 0 y 2 segundos con cinco rivales encima.
const COBERTURA_MINIMA: f64 = 0.5;

/// Hueco que se tolera dentro de un tramo sin darlo por terminado. El detector
/// ve el 75% de los iconos, así que cortar al primer fotograma sin rival
/// partiría en trozos un mismo episodio.
const HUECO_VIDEO: f64 = 4.0;

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
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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
    /// Maximum count of individually located enemies passing CERTEZA.
    #[serde(default)]
    pub enemy_count: usize,
    /// Dónde estabas, en coordenadas de mapa.
    pub x: f64,
    pub y: f64,
    /// Carril en el que te sujetaron ("top", "mid", "bot"), o `None` si el tramo
    /// cae lejos de los tres (jungla profunda, base). Sale de la misma geometría
    /// que usan los ganks y las miradas al minimapa.
    pub lane: Option<String>,
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
    /// Si los límites del tramo se afinaron con el vídeo. Cuando es `false`, la
    /// duración es una cota inferior: la API sólo da una posición por minuto.
    #[serde(default)]
    pub from_video: bool,
    /// Timeline event evidence, uniquely assigned per player after refinement.
    #[serde(default)]
    pub gains: Vec<PressureEvidence>,
    #[serde(default)]
    pub losses: Vec<PressureEvidence>,
    #[serde(default)]
    pub death_gold: f64,
    #[serde(default)]
    pub assessment: String,
    #[serde(default)]
    pub game_start: f64,
    #[serde(default)]
    pub game_end: f64,
    /// Rivales que tuviste encima y cuánto tiempo cada uno.
    #[serde(default)]
    pub ties: Vec<crate::pressure_value::EnemyTie>,
    /// Lo que valió el episodio, en oro. Ver `crate::pressure_value`.
    #[serde(default)]
    pub value: crate::pressure_value::PressureValue,
    /// Lo que el rival sacó lejos mientras tanto. Contexto, no coste tuyo.
    #[serde(default)]
    pub context: Vec<PressureEvidence>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PressureEvidence {
    pub id: String,
    pub time: f64,
    pub game_time: f64,
    pub kind: String,
    pub gold: f64,
    pub after_episode: bool,
    /// Pasó donde estabas tú (resultado de la pelea), no lejos.
    #[serde(default)]
    pub local: bool,
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

/// Ajusta los tramos de un jugador usando las posiciones densas del vídeo.
///
/// Sin esto los bordes salen de estimar entre fotogramas de minuto, y estimar
/// obliga a ser generoso: el tramo se abre en cuanto un rival entra en la zona,
/// no cuando lo tienes encima. Con dos muestras por segundo del minimapa el
/// borde se puede poner donde de verdad está.
///
/// **Recorta y estira**, no sólo estira. La versión anterior sólo podía crecer,
/// así que se tragaba entero el acercamiento del rival y un episodio de diez
/// segundos se anunciaba como de veintitrés.
///
/// Es opcional por diseño: si la partida no tiene vídeo procesado, se devuelven
/// los tramos tal cual.
#[cfg_attr(not(test), allow(dead_code))]
pub fn refinar_con_video(
    ventanas: &mut [PressureWindow],
    pos: &crate::minimap::Positions,
    tl: &TimelineDto,
    participants: &[ParticipantDto],
) {
    refinar_con_video_with(
        ventanas,
        pos,
        tl,
        participants,
        RIVAL_ENCIMA_VIDEO,
        RIVAL_SE_FUE,
        COBERTURA_MINIMA,
    );
}

/// Igual que `refinar_con_video` pero con los radios abiertos, para barrerlos
/// en las pruebas contra las muertes, que son la verja objetiva.
#[cfg_attr(not(test), allow(dead_code))]
pub fn refinar_con_video_with(
    ventanas: &mut [PressureWindow],
    pos: &crate::minimap::Positions,
    tl: &TimelineDto,
    participants: &[ParticipantDto],
    r_abre: f64,
    r_cierra: f64,
    cobertura_min: f64,
) -> Vec<AjusteVideo> {
    let mut diag = Vec::new();
    let vals = valores(tl, participants);
    let jugadas = crate::winprob::plays(tl, participants);
    let muertes = muertes_de(tl);
    // Anclas exactas de la API para el jugador grabado, que es a quien sigue el
    // vídeo. Los tramos de los demás no se tocan.
    let yo = pos.self_participant_id;
    let anclas: Vec<(f64, f64, f64)> = tl
        .info
        .frames
        .iter()
        .filter_map(|f| {
            let pf = f.participantFrames.get(&yo.to_string())?;
            let p = pf.position.as_ref()?;
            Some((f.timestamp as f64 / 1000.0, p.x as f64, p.y as f64))
        })
        .collect();
    let pista = pos.follow(&anclas);
    if pista.is_empty() {
        return diag;
    }

    for w in ventanas.iter_mut().filter(|w| w.participant_id == yo) {
        // ¿Te ha visto el vídeo lo bastante como para opinar sobre este tramo?
        let vistos = pista
            .iter()
            .filter(|f| f.sec >= w.start && f.sec <= w.end)
            .count() as f64;
        let esperados = ((w.end - w.start) * pos.fps).max(1.0);
        if std::env::var("PRESION_TRAZA").is_ok() {
            let t = w.start + pos.video_offset;
            println!(
                "    tramo vídeo {:.0}:{:02.0}  cobertura {:.2} ({} de {:.0}){}",
                (t / 60.0).floor(),
                t % 60.0,
                vistos / esperados,
                vistos as i64,
                esperados,
                if vistos / esperados < cobertura_min { "   DESCARTADO" } else { "" }
            );
            for f in pista
                .iter()
                .filter(|f| f.sec >= w.start - 15.0 && f.sec <= w.end + 15.0)
            {
                let tv = f.sec + pos.video_offset;
                println!(
                    "      {:.0}:{:02.0}  encima={:?} zona={:?} {}",
                    (tv / 60.0).floor(),
                    tv % 60.0,
                    pos.enemies_near(f.sec, f.x, f.y, r_abre),
                    pos.enemies_near(f.sec, f.x, f.y, r_cierra),
                    if f.anchored { "[ancla]" } else { "" }
                );
            }
        }
        if vistos / esperados < cobertura_min {
            continue; // rastro demasiado pobre: se deja lo que decía la API
        }

        // Rivales encima (apretado) y en la zona (holgado) en cada instante.
        //
        // Dos radios, no uno. Un tramo **se abre** cuando te tienen encima de
        // verdad —eso es lo que arregla que empezara mientras aún se acercaban—
        // pero **no se cierra** hasta que se van de la zona. Con un único radio,
        // un rival oscilando entre 1.400 y 1.600 troceaba el episodio en pedazos
        // de dos segundos.
        let mut encima: Vec<(f64, usize, usize)> = pista
            .iter()
            .filter(|f| f.sec >= w.start - 60.0 && f.sec <= w.end + 60.0)
            .filter_map(|f| {
                let cerca = pos.enemies_near(f.sec, f.x, f.y, r_abre)?;
                let zona = pos.enemies_near(f.sec, f.x, f.y, r_cierra)?;
                (zona >= 1).then_some((f.sec, cerca, zona))
            })
            .collect();
        encima.sort_by(|a, b| a.0.total_cmp(&b.0));
        if encima.is_empty() {
            continue; // el vídeo no confirma nada: se deja el tramo de la API
        }

        // De todos los tramos continuos, el que solapa con lo que detectó la
        // API. Buscar el más largo elegiría cualquier otra pelea cercana.
        let mut mejor: Option<(f64, f64)> = None;
        let (mut ini, mut prev) = (encima[0].0, encima[0].0);
        let mut abrio = encima[0].1 >= MINIMO_RIVALES;
        let fin_falso = (f64::MAX, 0usize, 0usize);
        for &(sec, cerca, _) in encima.iter().skip(1).chain(std::iter::once(&fin_falso)) {
            if sec - prev <= HUECO_VIDEO {
                prev = sec;
                abrio |= cerca >= MINIMO_RIVALES;
                continue;
            }
            // Sólo cuenta si en algún momento te tuvieron encima de verdad: un
            // rival cruzando la zona no es presión.
            //
            // No se exige que solape con el tramo de la API, sólo que esté
            // cerca. La API estima la posición entre fotogramas de minuto, así
            // que su tramo puede estar **desplazado**, no sólo ser más largo:
            // hay un caso medido en el que anunciaba 7:58–8:13 y el vídeo no ve
            // un solo rival en esos quince segundos porque la pelea fue de
            // 7:50 a 7:57. Exigiendo solape, ese tramo se quedaba sin corregir.
            let cerca_del_tramo = ini <= w.end + CORTE && prev >= w.start - CORTE;
            if abrio && cerca_del_tramo {
                // Se prefiere el que más solape; entre los que no solapan, el
                // más cercano.
                let punt = (prev.min(w.end) - ini.max(w.start)).max(-CORTE);
                if mejor.is_none_or(|(a, b): (f64, f64)| {
                    punt > (b.min(w.end) - a.max(w.start)).max(-CORTE)
                }) {
                    mejor = Some((ini, prev));
                }
            }
            ini = sec;
            prev = sec;
            abrio = cerca >= MINIMO_RIVALES;
        }

        let Some((mut ini, mut fin)) = mejor else { continue };

        // Una muerte tuya dentro del tramo es información más fuerte que el
        // vídeo: si moriste, te tenían encima, y no hay recorte que valga.
        //
        // Hace falta decirlo explícitamente porque en la pelea es cuando el
        // vídeo peor ve —los iconos se amontonan y el detector se pierde— así
        // que el tramo continuo más limpio suele ser el de *antes*. Sin esto,
        // tres de cada cuatro tramos con muerte se recortaban justo hasta
        // quedarse con el acercamiento y cortar antes de la pelea.
        let (crudo_ini, crudo_fin) = (ini, fin);
        for (pid, sec) in muertes.iter() {
            if *pid != w.participant_id || *sec < w.start || *sec > w.end + PASO {
                continue;
            }
            ini = ini.min(*sec);
            fin = fin.max(*sec);
        }
        diag.push(AjusteVideo {
            murio: muertes.iter().any(|(pid, sec)| {
                *pid == w.participant_id && *sec >= w.start && *sec <= w.end + PASO
            }),
            estiron: (crudo_ini - ini) + (fin - crudo_fin),
        });
        // Aquí NO se aplica `MINIMO_SEGUNDOS`. Ese mínimo existe porque la API
        // muestrea cada cinco segundos y estima entre minutos: por debajo de
        // quince segundos no puede distinguir presión de un cruce. El vídeo sí,
        // y descartar lo que mide sería volver al problema que esto arregla —
        // un episodio real de diez segundos anunciado como de veintitrés.
        w.start = ini;
        w.end = fin;
        w.from_video = true;

        // El valor se calculó sobre `[start, end + COLA]` con los límites
        // viejos. Si no se recalcula, se enseña la duración nueva con el
        // crédito de la vieja.
        w.wpa_elsewhere = 0.0;
        w.gold_elsewhere = 0.0;
        w.towers_elsewhere = 0;
        w.inhibs_elsewhere = 0;
        w.plates_elsewhere = 0;
        w.epics_elsewhere = 0;
        let team = participants
            .get(w.participant_id as usize - 1)
            .map(|p| p.teamId)
            .unwrap_or(0);
        cerrar(w, &vals, &jugadas, &muertes, team);
    }
    diag
}

/// Qué hizo el vídeo por su cuenta en un tramo, antes de anclarlo a la muerte.
///
/// Sirve para elegir el radio con un número: si el vídeo por sí solo ya cubre la
/// muerte, el radio está bien; si hay que estirarlo mucho, se está quedando
/// fuera la pelea y el radio es demasiado apretado.
pub struct AjusteVideo {
    /// Los dos siguientes son el instrumento del barrido de radios: se
    /// escriben siempre y sólo los lee ese test, que es quien fijó el 1200.
    #[cfg_attr(not(test), allow(dead_code))]
    pub murio: bool,
    /// Segundos que hubo que añadir para que la muerte cupiera.
    #[cfg_attr(not(test), allow(dead_code))]
    pub estiron: f64,
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

    let muertes = muertes_de(tl);
    let vivos = crate::pressure_value::Vivos::build(tl);

    let mut out = Vec::new();
    for (idx, p) in participants.iter().enumerate() {
        let pid = (idx + 1) as i32;
        let rival = if p.teamId == 100 { 200 } else { 100 };

        // Recorre la partida marcando en qué instantes había presión, y agrupa
        // los consecutivos en tramos.
        let mut abierto: Option<PressureWindow> = None;
        let mut sec = 0.0;
        while sec <= fin {
            // Solo cuentan los VIVOS. Un muerto no está sujeto a nadie ni
            // sujeta a nadie, y contarlo convertía el final de una pelea
            // perdida en "presión absorbida".
            let estimado = occ.estimate(pid, sec).filter(|_| vivos.alive(pid, sec));
            let (enemigos, seguros, aliados, pos) = match estimado {
                Some(e) => {
                    let (mut enemigos, mut seguros) = (0.0, 0usize);
                    // Incluye al propio jugador, que siempre suma 1 en su
                    // posición: es justo lo que interesa contar.
                    let mut aliados = 1.0;
                    for (j, q) in participants.iter().enumerate() {
                        let qid = (j + 1) as i32;
                        if qid == pid || !vivos.alive(qid, sec) {
                            continue;
                        }
                        let c = occ.presence(qid, sec, e.x, e.y, radio);
                        if q.teamId == rival {
                            enemigos += c;
                            seguros += usize::from(c >= CERTEZA);
                        } else {
                            aliados += c;
                        }
                    }
                    (enemigos, seguros, aliados, (e.x, e.y))
                }
                None => (0.0, 0, 0.0, (0.0, 0.0)),
            };

            // La condición que define el fenómeno: no basta con tener rivales
            // encima, hay que tener MÁS rivales que aliados. Si hay 4 y 4, eso
            // es una pelea; el equipo no gana nada en otra zona. Con
            // `enemigos > aliados`, los que quedan sueltos por el mapa son
            // menos que los tuyos: ahí es donde nace la ventaja.
            //
            // Contando solo a los VIVOS (2026-09-23). Se probaron, medidas
            // contra el vídeo en 14 partidas con minimapa (`verdad_de_video`),
            // dos condiciones más estrictas: un tope de un aliado contigo y
            // exigir ventaja numérica fuera. Ninguna subió la precisión (56-60 %
            // en todas) y las dos hundían la cobertura. La API no ve lo bastante
            // bien a los aliados cercanos como para decidir con ellos; donde hay
            // vídeo, manda el vídeo (`detectar_con_video`).
            // Además tiene que haber combate contra campeones: sin esto, estar
            // cerca de rivales contaba como aguantarlos.
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
                        w.enemy_count = w.enemy_count.max(seguros);
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
                            enemy_count: seguros,
                            // Se rellena al cerrar el tramo: `x`/`y` se mueven al
                            // punto de máxima presión mientras sigue abierto.
                            lane: None,
                            x: pos.0,
                            y: pos.1,
                            died: false,
                            gold_elsewhere: 0.0,
                            wpa_elsewhere: 0.0,
                            towers_elsewhere: 0,
                            inhibs_elsewhere: 0,
                            plates_elsewhere: 0,
                            epics_elsewhere: 0,
                            from_video: false,
                            gains: Vec::new(),
                            losses: Vec::new(),
                            death_gold: 0.0,
                            assessment: String::new(),
                            game_start: sec,
                            game_end: sec,
                            ties: Vec::new(),
                            value: Default::default(),
                            context: Vec::new(),
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

    out.retain(|w| w.end - w.start >= MINIMO_SEGUNDOS);
    // El carril, una vez cerrado el tramo: `x`/`y` ya apuntan al punto de máxima
    // presión, que es donde te tenían sujeto. Misma geometría que los ganks y
    // que las miradas al minimapa, con el mismo radio.
    for w in out.iter_mut() {
        w.lane = crate::gank::Lane::nearest_within(w.x, w.y, crate::camera_input::RADIO_CARRIL)
            .map(|l| l.key().to_string());
    }
    out.sort_by(|a, b| a.start.total_cmp(&b.start));
    out
}

/// Muertes por jugador, para marcar los tramos que acabaron contigo muerto.
fn muertes_de(tl: &TimelineDto) -> Vec<(i32, f64)> {
    tl.info
        .frames
        .iter()
        .flat_map(|f| f.events.iter())
        .filter(|e| e.event_type == "CHAMPION_KILL")
        .map(|e| (e.victimId, e.timestamp as f64 / 1000.0))
        .collect()
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

/// Single production pipeline. Evidence is assigned only AFTER video has moved
/// boundaries, so cached summaries and player details describe the same events.
pub fn analyse(
    tl: &TimelineDto,
    participants: &[ParticipantDto],
    video: Option<&crate::minimap::Positions>,
) -> Vec<PressureWindow> {
    let mut windows = detect(tl, participants);
    if let Some(pos) = video {
        // Donde el vídeo te vio, manda el vídeo: sus episodios sustituyen a los
        // de la API para el jugador grabado. Donde no te vio (rastro pobre),
        // se conservan los de la API que no pisen ninguno del vídeo.
        let yo = pos.self_participant_id;
        let (propios, pista) = detectar_con_video(pos, tl, participants);
        if !pista.is_empty() {
            windows.retain(|w| {
                if w.participant_id != yo {
                    return true;
                }
                let vistos = pista.iter().filter(|f| f.sec >= w.start && f.sec <= w.end).count() as f64;
                let esperados = ((w.end - w.start) * pos.fps).max(1.0);
                let solapa = propios.iter().any(|p| p.start <= w.end + CORTE && p.end >= w.start - CORTE);
                vistos / esperados < COBERTURA_MINIMA && !solapa
            });
            windows.extend(propios);
        }
    }
    finalize(&mut windows, tl, participants);
    valorar(&mut windows, tl, participants);
    windows
}

/// Lo mínimo que tiene que durar un episodio visto en el vídeo. El vídeo no
/// necesita el margen de `MINIMO_SEGUNDOS` (que existe por estimar entre
/// minutos): cuatro segundos seguidos con dos rivales encima ya no son un cruce.
const MINIMO_VIDEO: f64 = 4.0;

/// Hueco que une dos trozos del vídeo en un mismo episodio. Más largo que
/// `HUECO_VIDEO`: el icono parpadea (el detector ve el 75 %) y un rival puede
/// salir un momento del radio, pero sigue siendo la misma persecución. Con 4 s
/// salían cuatro episodios de 5 s en el mismo minuto.
const UNE_VIDEO: f64 = 10.0;

/// Cuánto se mira hacia atrás para saber si el episodio nació de una pelea de
/// equipo. Si justo antes tenías a dos aliados contigo, quedarte solo contra
/// tres no es que vinieran a por ti: es el final de una pelea que se perdió.
const ANTES_DE_PELEA: f64 = 8.0;

/// Episodios del jugador grabado sacados directamente del minimapa.
///
/// Por qué no basta con ajustar los de la API: medido en 14 partidas con
/// minimapa (`verdad_de_video`), el vídeo ve 61 episodios en los que tenías dos
/// o más rivales encima y más rivales que aliados; el detector de la API solo
/// solapaba con 9–17 de ellos, y la mitad de sus tramos caían donde el vídeo no
/// ve presión ninguna. Ajustar bordes no arregla un tramo que no existe ni
/// crea uno que falta.
///
/// Mismo criterio que la API, contado con iconos: 2+ rivales a menos de
/// `RIVAL_ENCIMA_VIDEO` y más rivales que tú más los aliados que te
/// acompañan. Tu muerte cercana ancla el final, como en el ajuste.
pub fn detectar_con_video(
    pos: &crate::minimap::Positions,
    tl: &TimelineDto,
    participants: &[ParticipantDto],
) -> (Vec<PressureWindow>, Vec<crate::minimap::Fix>) {
    let yo = pos.self_participant_id;
    let Some(p) = participants.get((yo - 1).max(0) as usize) else { return (Vec::new(), Vec::new()) };
    let anclas: Vec<(f64, f64, f64)> = tl
        .info
        .frames
        .iter()
        .filter_map(|f| {
            let q = f.participantFrames.get(&yo.to_string())?.position.as_ref()?;
            Some((f.timestamp as f64 / 1000.0, q.x as f64, q.y as f64))
        })
        .collect();
    let pista = pos.follow(&anclas);
    let vivos = crate::pressure_value::Vivos::build(tl);
    let occ = Occupancy::build(tl, participants);
    let muertes = muertes_de(tl);

    let mut instantes: Vec<(f64, f64, f64, usize)> = Vec::new();
    for f in &pista {
        if !vivos.alive(yo, f.sec) {
            continue;
        }
        let (Some(e), Some(a)) = (
            pos.enemies_near(f.sec, f.x, f.y, RIVAL_ENCIMA_VIDEO),
            pos.allies_near(f.sec, f.x, f.y, RIVAL_ENCIMA_VIDEO),
        ) else {
            continue;
        };
        let otros = a.saturating_sub(1); // tu propio icono
        if e >= MINIMO_RIVALES && e > otros + 1 {
            instantes.push((f.sec, f.x, f.y, e));
        }
    }

    let mut grupos: Vec<Vec<(f64, f64, f64, usize)>> = Vec::new();
    for i in instantes {
        match grupos.last_mut() {
            Some(g) if i.0 - g.last().unwrap().0 <= UNE_VIDEO => g.push(i),
            _ => grupos.push(vec![i]),
        }
    }
    // Fuera los que nacen de una pelea de equipo: dos o más aliados contigo
    // en los segundos de antes.
    grupos.retain(|g| {
        let t0 = g[0].0;
        !pista.iter().filter(|f| f.sec >= t0 - ANTES_DE_PELEA && f.sec <= t0 + 1.0).any(|f| {
            pos.allies_near(f.sec, f.x, f.y, RIVAL_SE_FUE).is_some_and(|a| a.saturating_sub(1) >= 2)
        })
    });

    let mut out = Vec::new();
    for g in grupos {
        let (mut start, mut end) = (g[0].0, g.last().unwrap().0);
        let murio = muertes
            .iter()
            .find(|(pid, s)| *pid == yo && *s >= start - HUECO_VIDEO && *s <= end + PASO)
            .map(|(_, s)| *s);
        if let Some(s) = murio {
            start = start.min(s);
            end = end.max(s);
        }
        // Si acabó en tu muerte basta con menos: te pillaron. Pero no con
        // nada: un instante suelto antes de morir no es un episodio.
        if end - start < if murio.is_some() { 2.0 } else { MINIMO_VIDEO } {
            continue;
        }
        let pico = g.iter().max_by_key(|i| i.3).copied().unwrap();
        let ties = crate::pressure_value::atados_video(&occ, &vivos, participants, yo, &g, RIVAL_ENCIMA);
        out.push(PressureWindow {
            participant_id: yo,
            champion: p.championName.clone(),
            start,
            end,
            max_enemies: pico.3 as f64,
            enemy_count: pico.3,
            x: pico.1,
            y: pico.2,
            lane: crate::gank::Lane::nearest_within(pico.1, pico.2, crate::camera_input::RADIO_CARRIL)
                .map(|l| l.key().to_string()),
            died: false,
            gold_elsewhere: 0.0,
            wpa_elsewhere: 0.0,
            towers_elsewhere: 0,
            inhibs_elsewhere: 0,
            plates_elsewhere: 0,
            epics_elsewhere: 0,
            from_video: true,
            gains: Vec::new(),
            losses: Vec::new(),
            death_gold: 0.0,
            assessment: String::new(),
            game_start: start,
            game_end: end,
            ties,
            value: Default::default(),
            context: Vec::new(),
        });
    }
    (out, pista)
}

/// Cierra el valor en oro de cada episodio: a quién ataste y cuánto tiempo,
/// cuánto farmeo les costó y el neto. La evidencia (lo del sitio y lo de lejos)
/// ya la ha repartido `finalize`. Ver `crate::pressure_value`.
fn valorar(windows: &mut [PressureWindow], tl: &TimelineDto, participants: &[ParticipantDto]) {
    let occ = Occupancy::build(tl, participants);
    let vivos = crate::pressure_value::Vivos::build(tl);
    for w in windows.iter_mut() {
        // Los episodios del vídeo ya traen a quién ataste, contado con iconos.
        let mut ties = if w.ties.is_empty() {
            crate::pressure_value::atados(
                &occ, &vivos, participants, w.participant_id, w.start, w.end, RIVAL_ENCIMA, w.enemy_count,
            )
        } else {
            std::mem::take(&mut w.ties)
        };
        let muerte = w.losses.iter().find(|l| l.kind == "death").map(|l| l.game_time);
        crate::pressure_value::cerrar_valor(&mut w.value, &mut ties, tl, w.participant_id, w.start, w.end, muerte);
        w.ties = ties;
        w.assessment = w.value.verdict.clone();
    }
}

fn finalize(windows: &mut Vec<PressureWindow>, tl: &TimelineDto, participants: &[ParticipantDto]) {
    // Refinement can move two API candidates onto the same actual fight.
    windows.sort_by(|a, b| a.participant_id.cmp(&b.participant_id).then(a.start.total_cmp(&b.start)));
    let mut merged: Vec<PressureWindow> = Vec::new();
    for w in windows.drain(..) {
        if let Some(last) = merged.last_mut() {
            if last.participant_id == w.participant_id && w.start <= last.end {
                last.end = last.end.max(w.end);
                last.enemy_count = last.enemy_count.max(w.enemy_count);
                if w.max_enemies > last.max_enemies {
                    last.max_enemies = w.max_enemies;
                    last.x = w.x;
                    last.y = w.y;
                    last.lane = w.lane.clone();
                }
                last.from_video &= w.from_video;
                continue;
            }
        }
        merged.push(w);
    }
    *windows = merged;
    for w in windows.iter_mut() {
        w.game_start = w.start;
        w.game_end = w.end;
        w.gains.clear();
        w.losses.clear();
        w.context.clear();
        w.value = Default::default();
        w.death_gold = 0.0;
        w.died = false;
        // Legacy model credit is not spatially attributable; never expose it
        // as a player's reward, or mix it into the observed exchange.
        w.wpa_elsewhere = 0.0;
        w.gold_elsewhere = 0.0;
        w.towers_elsewhere = 0;
        w.inhibs_elsewhere = 0;
        w.plates_elsewhere = 0;
        w.epics_elsewhere = 0;
    }
    // Cada evento se clasifica, para cada jugador con un episodio abierto, en
    // una de tres cajas, según DÓNDE pasó respecto a él:
    //
    // - **En el sitio** (a menos de `RADIO_LOCAL`, durante el episodio): es el
    //   resultado de la pelea. Lo que gana tu equipo suma —también si lo haces
    //   tú: "si estoy fuerte puedo contra todos"— y lo que pierde resta.
    // - **Lejos** (a más de `OTRA_ZONA`, durante el episodio y `COLA` después):
    //   lo que tu equipo saca de la ventaja numérica. Sin tu participación.
    // - Lo que el rival saca **lejos** se guarda como contexto, no como coste.
    //
    // Entre `RADIO_LOCAL` y `OTRA_ZONA` no se atribuye a nada: no se sabe si
    // es tu pelea o la de otro. Tu propia muerte cuenta siempre como del sitio
    // aunque te persigan lejos.
    //
    // Antes, cualquier cosa del rival en todo el mapa era un coste tuyo. En una
    // pelea 5 contra 5 eso metía como "pérdida" la muerte de cada aliado.
    let team_of = |pid: i32| participants.get(pid.checked_sub(1)? as usize).map(|p| p.teamId);
    for (fi, frame) in tl.info.frames.iter().enumerate() {
        for (ei, ev) in frame.events.iter().enumerate() {
            let sec = ev.timestamp as f64 / 1000.0;
            let Some((kind, gold)) = crate::pressure_value::valor_evento(ev) else { continue };
            let event_team = crate::pressure_value::equipo_del_evento(ev, participants);
            let victim_team = if kind == "kill" { team_of(ev.victimId) } else { None };
            let pos = ev.position.as_ref().map(|p| (p.x as f64, p.y as f64));
            for pid in 1..=participants.len() as i32 {
                let Some(team) = team_of(pid) else { continue };
                let own_death = kind == "kill" && ev.victimId == pid;
                let participo = ev.killerId == pid || ev.assistingParticipantIds.contains(&pid);
                // Exactly one owner per event and player. Prefer an episode
                // still in progress, then the nearest preceding episode.
                let mut mejor: Option<(usize, &'static str)> = None;
                let mut clave_mejor = (true, f64::MAX, f64::MAX);
                for (i, w) in windows.iter().enumerate() {
                    if w.participant_id != pid || sec < w.start {
                        continue;
                    }
                    let d = pos.map(|(x, y)| ((x - w.x).powi(2) + (y - w.y).powi(2)).sqrt());
                    let en_episodio = sec <= w.end + PASO;
                    let caja = if own_death && en_episodio {
                        "loss"
                    } else if en_episodio && d.is_some_and(|d| d < crate::pressure_value::RADIO_LOCAL) {
                        if event_team == Some(team) {
                            "local_gain"
                        } else if victim_team == Some(team) || (kind != "kill" && event_team.is_some()) {
                            "loss"
                        } else {
                            continue;
                        }
                    } else if sec <= w.end + COLA && d.is_some_and(|d| d >= OTRA_ZONA) {
                        if event_team == Some(team) && !participo {
                            "gain"
                        } else if event_team.is_some_and(|t| t != team) {
                            "context"
                        } else {
                            continue;
                        }
                    } else {
                        continue;
                    };
                    let clave = (sec > w.end, (sec - w.end).abs(), w.start);
                    if mejor.is_none() || clave < clave_mejor {
                        mejor = Some((i, caja));
                        clave_mejor = clave;
                    }
                }
                let Some((i, caja)) = mejor else { continue };
                let w = &mut windows[i];
                let evidence = PressureEvidence {
                    id: format!("{fi}:{ei}"), time: sec, game_time: sec,
                    kind: if own_death { "death".into() } else { kind.into() },
                    gold, after_episode: sec > w.end, local: matches!(caja, "local_gain" | "loss"),
                };
                match caja {
                    "gain" => {
                        if kind == "kill" {
                            w.gold_elsewhere += gold;
                        }
                        match kind {
                            "tower" => w.towers_elsewhere += 1,
                            "inhibitor" => w.inhibs_elsewhere += 1,
                            "plate" => w.plates_elsewhere += 1,
                            "epic" => w.epics_elsewhere += 1,
                            _ => (),
                        }
                        w.value.team_elsewhere += gold;
                        w.gains.push(evidence);
                    }
                    "local_gain" => {
                        w.value.local_gold += gold;
                        w.gains.push(evidence);
                    }
                    "loss" => {
                        if own_death {
                            w.died = true;
                            w.death_gold += gold;
                        }
                        w.value.local_gold -= gold;
                        w.losses.push(evidence);
                    }
                    _ => {
                        w.value.enemy_elsewhere += gold;
                        w.context.push(evidence);
                    }
                }
            }
        }
    }
    for w in windows.iter_mut() {
        w.assessment = match (w.gains.is_empty(), w.losses.is_empty()) {
            (true, true) => "no_gain",
            (true, false) => "cost_without_gain",
            (false, true) => "gain_without_observed_cost",
            (false, false) => "mixed",
        }.into();
    }
    windows.sort_by(|a, b| a.start.total_cmp(&b.start).then(a.participant_id.cmp(&b.participant_id)));
}

#[cfg(test)]
mod regression {
    use super::*;
    use serde_json::json;

    fn players() -> Vec<ParticipantDto> {
        [100, 200].iter().map(|team| serde_json::from_value(json!({
            "puuid": "test", "teamId": team, "championName": "Test", "kills": 0,
            "deaths": 0, "assists": 0, "goldEarned": 0,
            "totalDamageDealtToChampions": 0, "win": false
        })).unwrap()).collect()
    }
    fn window(start: f64, end: f64) -> PressureWindow {
        PressureWindow { participant_id: 1, champion: "Test".into(), start, end,
            max_enemies: 2.5, enemy_count: 2, x: 1000.0, y: 1000.0, lane: Some("top".into()),
            died: false, gold_elsewhere: 0.0, wpa_elsewhere: 0.0, towers_elsewhere: 0,
            inhibs_elsewhere: 0, plates_elsewhere: 0, epics_elsewhere: 0,
            from_video: false, gains: vec![], losses: vec![], death_gold: 0.0,
            assessment: String::new(), game_start: start, game_end: end,
            ties: vec![], value: Default::default(), context: vec![] }
    }
    fn timeline(events: serde_json::Value) -> TimelineDto {
        serde_json::from_value(json!({"info": {"frames": [{"timestamp": 180000, "events": events}]}})).unwrap()
    }
    fn tower(time: i64) -> serde_json::Value {
        json!({"type": "BUILDING_KILL", "timestamp": time * 1000, "killerId": 0,
            "teamId": 200, "buildingType": "TOWER_BUILDING", "towerType": "OUTER_TURRET", "position": {"x": 10000, "y": 10000}})
    }

    #[test]
    fn no_reward_is_retained_and_death_cost_is_not_a_positive_trade() {
        let mut ws = vec![window(100.0, 120.0), window(150.0, 170.0)];
        let tl = timeline(json!([{"type":"CHAMPION_KILL", "timestamp":115000,
            "killerId":2,"victimId":1,"bounty":300,"shutdownBounty":450}]));
        finalize(&mut ws, &tl, &players());
        assert_eq!(ws.len(), 2);
        assert_eq!(ws[0].death_gold, 750.0);
        assert!(ws[0].died);
        assert_eq!(ws[0].assessment, "cost_without_gain");
        assert_eq!(ws[1].assessment, "no_gain");
        assert!(!ws[1].died);
    }

    #[test]
    fn overlapping_reward_tails_assign_each_event_once_and_prefer_active_episode() {
        let mut ws = vec![window(100.0, 120.0), window(130.0, 150.0)];
        finalize(&mut ws, &timeline(json!([tower(135)])), &players());
        assert_eq!(ws.iter().map(|w| w.towers_elsewhere).sum::<i32>(), 1);
        assert!(ws[0].gains.is_empty());
        assert_eq!(ws[1].gains.len(), 1);
        assert!(!ws[1].gains[0].after_episode);
    }

    #[test]
    fn video_overlap_merges_before_evidence_and_preserves_short_confirmed_episodes() {
        let mut a = window(100.0, 105.0);
        a.from_video = true;
        let mut b = window(103.0, 109.0);
        b.from_video = true;
        let mut ws = vec![a, b];
        finalize(&mut ws, &timeline(json!([tower(108)])), &players());
        assert_eq!(ws.len(), 1);
        assert_eq!((ws[0].start, ws[0].end), (100.0, 109.0));
        assert!(ws[0].from_video);
        assert_eq!(ws[0].towers_elsewhere, 1);
    }

    #[test]
    fn gains_and_death_are_mixed_even_when_tower_was_taken() {
        let mut ws = vec![window(100.0, 120.0)];
        finalize(&mut ws, &timeline(json!([tower(118),
            {"type":"CHAMPION_KILL","timestamp":120000,"killerId":2,"victimId":1,"bounty":300}
        ])), &players());
        assert_eq!(ws[0].assessment, "mixed");
        assert_eq!(ws[0].gains[0].kind, "tower");
        assert_eq!(ws[0].losses[0].kind, "death");
        assert_eq!(ws[0].wpa_elsewhere, 0.0);
    }

    #[test]
    fn local_result_counts_direct_elsewhere_does_not_and_tail_is_bounded() {
        // Lo del sitio es el resultado de la pelea: cuenta aunque lo hagas tú.
        let mut local = tower(110);
        local["position"] = json!({"x":1000,"y":1000});
        // Lejos y con tu participación: es trabajo directo, no fruto de la presión.
        let mut direct = tower(111);
        direct["killerId"] = json!(1);
        let mut ws = vec![window(100.0, 120.0)];
        finalize(&mut ws, &timeline(json!([local, direct, tower(140), tower(141)])), &players());
        let lejos: Vec<_> = ws[0].gains.iter().filter(|g| !g.local).collect();
        assert_eq!(lejos.len(), 1);
        assert_eq!(lejos[0].time, 140.0);
        assert!(lejos[0].after_episode);
        assert_eq!(ws[0].gains.iter().filter(|g| g.local).count(), 1);
        assert!(ws[0].value.local_gold > 0.0 && ws[0].value.team_elsewhere > 0.0);
    }

    #[test]
    fn enemy_gains_elsewhere_are_context_not_your_cost() {
        let mut enemy = tower(115);
        enemy["teamId"] = json!(100);
        let mut ws = vec![window(100.0, 120.0)];
        finalize(&mut ws, &timeline(json!([enemy])), &players());
        assert!(ws[0].losses.is_empty());
        assert_eq!(ws[0].context.len(), 1);
        assert!(ws[0].value.enemy_elsewhere > 0.0);
        assert_eq!(ws[0].value.local_gold, 0.0);
        assert!(!ws[0].died);
        assert_eq!(ws[0].death_gold, 0.0);
    }

    /// El cálculo entero sobre las partidas grabadas del usuario, con su vídeo
    /// cuando lo hay. `MIS_PARTIDAS_DIR` = carpeta de grabaciones.
    #[test]
    fn valor_en_mis_partidas() {
        let Ok(dir) = std::env::var("MIS_PARTIDAS_DIR") else { return };
        let mut ids: Vec<String> = std::fs::read_dir(&dir).unwrap().flatten()
            .filter_map(|e| e.file_name().to_str().filter(|n| n.starts_with("match_")).map(str::to_string))
            .collect();
        ids.sort();
        let (mut eps, mut buenas, mut malas, mut neto, mut atado) = (0usize, 0usize, 0usize, 0.0, 0.0);
        let mut comp = [0.0f64; 7]; // farmeo rival, propio, muerto, sitio, lejos, rival lejos, muertes
        let mut partidas = 0usize;
        for id in ids {
            let base = format!("{dir}/{id}");
            let (Ok(m), Ok(t), Ok(meta)) = (
                std::fs::read_to_string(format!("{base}/riot_match.json")),
                std::fs::read_to_string(format!("{base}/riot_timeline.json")),
                std::fs::read_to_string(format!("{base}/{id}.json")),
            ) else { continue };
            let m: serde_json::Value = serde_json::from_str(&m).unwrap();
            let tl: TimelineDto = serde_json::from_str(&t).unwrap();
            let meta: serde_json::Value = serde_json::from_str(&meta).unwrap();
            let ps: Vec<ParticipantDto> = serde_json::from_value(m["info"]["participants"].clone()).unwrap();
            let champ = meta["champion"].as_str().unwrap_or("");
            let Some(idx) = ps.iter().position(|p| p.championName == champ) else { continue };
            let pid = (idx + 1) as i32;
            let video = crate::minimap::Positions::load(&id);
            let ws = analyse(&tl, &ps, video.as_ref());
            partidas += 1;
            println!("\n{id}  {champ}{}", if video.is_some() { "  [vídeo]" } else { "" });
            for w in ws.iter().filter(|w| w.participant_id == pid) {
                eps += 1;
                let v = &w.value;
                neto += v.net;
                comp[0] += v.farm_denied; comp[1] += v.own_farm_lost; comp[2] += v.death_farm_lost;
                comp[3] += v.local_gold; comp[4] += v.team_elsewhere; comp[5] += v.enemy_elsewhere;
                comp[6] += if w.died { 1.0 } else { 0.0 };
                atado += v.enemy_seconds;
                buenas += usize::from(v.verdict == "good");
                malas += usize::from(v.verdict == "bad");
                let quien: Vec<String> = w.ties.iter().map(|t| format!("{} {:.0}s", t.champion, t.seconds)).collect();
                println!(
                    "  {:>2}:{:02} +{:>3.0}s {:<5} rivales[{}] farmeo−rival {:>4.0} propio −{:>3.0} muerto −{:>3.0} sitio {:>+5.0} lejos {:>+5.0} (rival lejos {:>4.0}) = {:>+5.0}{}",
                    (w.start / 60.0) as i64, (w.start % 60.0) as i64, w.end - w.start, v.verdict,
                    quien.join(", "), v.farm_denied, v.own_farm_lost, v.death_farm_lost, v.local_gold, v.team_elsewhere,
                    v.enemy_elsewhere, v.net, if w.died { "  †" } else { "" }
                );
            }
        }
        println!(
            "\n{partidas} partidas · {eps} episodios · buenos {buenas} · malos {malas} · neto total {neto:+.0} · rival atado {:.0} min",
            atado / 60.0
        );
        println!("componentes: farmeo rival {:.0} · propio {:.0} · muerto {:.0} · sitio {:.0} · lejos {:.0} · rival lejos {:.0} · muertes {:.0}",
            comp[0], comp[1], comp[2], comp[3], comp[4], comp[5], comp[6]);
    }

    /// Verdad de campo del vídeo para elegir la condición de detección.
    ///
    /// En las partidas con minimapa procesado, cada medio segundo se sabe
    /// cuántos rivales y aliados tienes alrededor. Un instante es de **presión**
    /// si hay 2+ rivales y más rivales que aliados contigo más uno, y de
    /// **pelea** si además hay 2+ aliados contigo. Se agrupan en episodios y se
    /// mide, para cada variante del detector de la API, cuántos de sus tramos
    /// caen sobre presión real (precisión) y cuántos episodios reales pilla
    /// (cobertura). También se evalúa lo que había en caché (detector viejo).
    #[test]
    fn verdad_de_video() {
        let Ok(dir) = std::env::var("MIS_PARTIDAS_DIR") else { return };
        let r = RIVAL_ENCIMA_VIDEO;
        let mut ids: Vec<String> = std::fs::read_dir(&dir).unwrap().flatten()
            .filter_map(|e| e.file_name().to_str().filter(|n| n.starts_with("match_")).map(str::to_string))
            .collect();
        ids.sort();
        let (mut reales, mut reales_pillados) = (0usize, 0usize);
        let (mut tramos, mut sobre_presion, mut sobre_pelea, mut sobre_nada) = (0usize, 0usize, 0usize, 0usize);
        let (mut v_tramos, mut v_presion, mut v_pelea, mut v_nada) = (0usize, 0usize, 0usize, 0usize);
        for id in ids {
            let base = format!("{dir}/{id}");
            let Some(pos) = crate::minimap::Positions::load(&id) else { continue };
            let (Ok(m), Ok(t)) = (
                std::fs::read_to_string(format!("{base}/riot_match.json")),
                std::fs::read_to_string(format!("{base}/riot_timeline.json")),
            ) else { continue };
            let m: serde_json::Value = serde_json::from_str(&m).unwrap();
            let tl: TimelineDto = serde_json::from_str(&t).unwrap();
            let ps: Vec<ParticipantDto> = serde_json::from_value(m["info"]["participants"].clone()).unwrap();
            let yo = pos.self_participant_id;
            let anclas: Vec<(f64, f64, f64)> = tl.info.frames.iter().filter_map(|f| {
                let p = f.participantFrames.get(&yo.to_string())?.position.as_ref()?;
                Some((f.timestamp as f64 / 1000.0, p.x as f64, p.y as f64))
            }).collect();
            let pista = pos.follow(&anclas);
            // Instantes clasificados.
            let mut presion: Vec<f64> = Vec::new();
            let mut pelea: Vec<f64> = Vec::new();
            for f in &pista {
                let (Some(e), Some(a)) = (pos.enemies_near(f.sec, f.x, f.y, r), pos.allies_near(f.sec, f.x, f.y, r)) else { continue };
                let otros = a.saturating_sub(1);
                if e >= 2 && otros >= 2 { pelea.push(f.sec); } else if e >= 2 && e > otros + 1 { presion.push(f.sec); }
            }
            // Episodios reales: presión continua (huecos ≤ 4 s) de 4 s o más.
            let mut eps: Vec<(f64, f64)> = Vec::new();
            for &s in &presion {
                match eps.last_mut() { Some(e) if s - e.1 <= HUECO_VIDEO => e.1 = s, _ => eps.push((s, s)) }
            }
            eps.retain(|e| e.1 - e.0 >= 4.0);
            let cae = |a: f64, b: f64, v: &[f64]| v.iter().filter(|s| **s >= a && **s <= b).count();
            let ws = analyse(&tl, &ps, Some(&pos));
            let mios: Vec<&PressureWindow> = ws.iter().filter(|w| w.participant_id == yo).collect();
            for e in &eps {
                reales += 1;
                if mios.iter().any(|w| w.start <= e.1 + 5.0 && w.end >= e.0 - 5.0) { reales_pillados += 1; }
            }
            for w in &mios {
                tramos += 1;
                let (p, q) = (cae(w.start, w.end, &presion), cae(w.start, w.end, &pelea));
                if p >= 2 && p >= q { sobre_presion += 1 } else if q > p { sobre_pelea += 1 } else { sobre_nada += 1 }
            }
            // Lo que había en caché (detector anterior), si sigue en disco.
            if let Ok(c) = std::fs::read_to_string(format!("{base}/pressure_v1.json")) {
                let c: serde_json::Value = serde_json::from_str(&c).unwrap();
                if c["v"] == 2 {
                    for w in c["episodes"].as_array().unwrap().iter().filter(|w| w["participant_id"] == yo) {
                        let (a, b) = (w["start"].as_f64().unwrap(), w["end"].as_f64().unwrap());
                        v_tramos += 1;
                        let (p, q) = (cae(a, b, &presion), cae(a, b, &pelea));
                        if p >= 2 && p >= q { v_presion += 1 } else if q > p { v_pelea += 1 } else { v_nada += 1 }
                    }
                }
            }
        }
        println!("  episodios reales (vídeo): {reales} · pillados {reales_pillados}");
        println!("  tramos detector: {tramos} · sobre presión {sobre_presion} · sobre pelea {sobre_pelea} · sobre nada {sobre_nada}");
        println!("  detector viejo (caché v2): {v_tramos} · sobre presión {v_presion} · sobre pelea {v_pelea} · sobre nada {v_nada}");
    }

    #[test]
    fn an_ally_dying_next_to_you_is_a_local_loss_but_far_away_is_not() {
        let mut ps = players();
        ps.push(ps[0].clone()); // pid 3, equipo azul
        let kill = |t: i64, x: i32| json!({"type":"CHAMPION_KILL","timestamp":t*1000,
            "killerId":2,"victimId":3,"bounty":300,"position":{"x":x,"y":1000}});
        let mut ws = vec![window(100.0, 120.0)];
        finalize(&mut ws, &timeline(json!([kill(110, 1500), kill(112, 12000)])), &ps);
        assert_eq!(ws[0].losses.len(), 1);
        assert_eq!(ws[0].value.local_gold, -300.0);
        assert_eq!(ws[0].context.len(), 1);
    }
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

#[cfg(test)]
mod comparativa {
    use super::*;

    /// Barrido de los radios del refinado contra la única verja objetiva que
    /// hay: si el tramo acabó contigo muerto, la muerte tiene que seguir
    /// dentro. Se busca el punto que más recorta sin perder ninguna.
    #[test]
    fn barrido_de_radios_del_video() {
        let Ok(dir) = std::env::var("VIDEOS_DIR") else {
            return;
        };
        let Ok(entradas) = std::fs::read_dir(&dir) else { return };
        let mut partidas = Vec::new();
        for e in entradas.flatten() {
            let d = e.path();
            let (pos_p, tl_p, mt_p) = (
                d.join("minimap_positions.json"),
                d.join("riot_timeline.json"),
                d.join("riot_match.json"),
            );
            if !(pos_p.exists() && tl_p.exists() && mt_p.exists()) {
                continue;
            }
            let Ok(tl) = std::fs::read_to_string(&tl_p) else { continue };
            let Ok(tl) = serde_json::from_str::<TimelineDto>(&tl) else { continue };
            let Ok(mt) = std::fs::read_to_string(&mt_p) else { continue };
            let Ok(mt) = serde_json::from_str::<serde_json::Value>(&mt) else { continue };
            let Ok(ps) =
                serde_json::from_value::<Vec<ParticipantDto>>(mt["info"]["participants"].clone())
            else {
                continue;
            };
            let Ok(raw) = std::fs::read_to_string(&pos_p) else { continue };
            let Ok(pos) = serde_json::from_str::<crate::minimap::Positions>(&raw) else {
                continue;
            };
            partidas.push((tl, ps, pos));
        }
        if partidas.is_empty() {
            println!("sin partidas con vídeo procesado");
            return;
        }

        // Tres cifras. La duración dice cuánto recorta; el estirón dice si se
        // está pasando: es lo que hay que añadirle al tramo para que la muerte
        // quepa, y sólo hace falta cuando el vídeo se ha dejado fuera la pelea.
        println!(
            "{:>7} {:>7} {:>9} {:>9} {:>14} {:>12}",
            "abre", "cierra", "mediana", "media", "sin estirar", "estirón med"
        );
        for &r_abre in &[900.0f64, 1100.0, 1200.0, 1300.0, 1500.0, 1800.0] {
            let r_cierra = (r_abre + 400.0).max(1500.0);
            let mut durs = Vec::new();
            let (mut con_muerte, mut limpias, mut estirones) = (0, 0, Vec::new());
            for (tl, ps, pos) in &partidas {
                let base = detect(tl, ps);
                let mut ref_ = base.clone();
                let diag = refinar_con_video_with(
                    &mut ref_, pos, tl, ps, r_abre, r_cierra, COBERTURA_MINIMA,
                );
                let yo = pos.self_participant_id;
                for (a, b) in base
                    .iter()
                    .zip(ref_.iter())
                    .filter(|(a, _)| a.participant_id == yo)
                {
                    let _ = a;
                    durs.push(b.end - b.start);
                }
                for d in diag.iter().filter(|d| d.murio) {
                    con_muerte += 1;
                    if d.estiron < 0.5 {
                        limpias += 1;
                    }
                    estirones.push(d.estiron);
                }
            }
            durs.sort_by(f64::total_cmp);
            estirones.sort_by(f64::total_cmp);
            let media = durs.iter().sum::<f64>() / durs.len() as f64;
            println!(
                "{:>7.0} {:>7.0} {:>8.0}s {:>8.0}s {:>9}/{:<4} {:>10.0}s",
                r_abre,
                r_cierra,
                durs[durs.len() / 2],
                media,
                limpias,
                con_muerte,
                estirones.get(estirones.len() / 2).copied().unwrap_or(0.0)
            );
        }
    }

    /// Compara los tramos con y sin las posiciones densas del vídeo, sobre las
    /// partidas grabadas del usuario. Es la única forma de saber cuánto aporta
    /// de verdad el detector, más allá de sus métricas de detección.
    #[test]
    fn con_video_frente_a_solo_api() {
        let Ok(dir) = std::env::var("VIDEOS_DIR") else {
            return;
        };
        let Ok(entradas) = std::fs::read_dir(&dir) else { return };

        let (mut n_part, mut n_tramos) = (0usize, 0usize);
        let (mut dur_antes, mut dur_despues) = (Vec::new(), Vec::new());
        let mut ajustes: Vec<(PressureWindow, PressureWindow)> = Vec::new();

        for e in entradas.flatten() {
            let d = e.path();
            let pos_p = d.join("minimap_positions.json");
            let tl_p = d.join("riot_timeline.json");
            let mt_p = d.join("riot_match.json");
            if !(pos_p.exists() && tl_p.exists() && mt_p.exists()) {
                continue;
            }
            let Ok(tl) = std::fs::read_to_string(&tl_p) else { continue };
            let Ok(tl) = serde_json::from_str::<TimelineDto>(&tl) else { continue };
            let Ok(mt) = std::fs::read_to_string(&mt_p) else { continue };
            let Ok(mt) = serde_json::from_str::<serde_json::Value>(&mt) else { continue };
            let Ok(ps) = serde_json::from_value::<Vec<ParticipantDto>>(
                mt["info"]["participants"].clone(),
            ) else {
                continue;
            };
            let Ok(raw) = std::fs::read_to_string(&pos_p) else { continue };
            let Ok(pos) = serde_json::from_str::<crate::minimap::Positions>(&raw) else {
                continue;
            };

            let base = detect(&tl, &ps);
            let mut refinado = base.clone();
            refinar_con_video(&mut refinado, &pos, &tl, &ps);
            println!("{}", d.file_name().unwrap().to_string_lossy());

            let yo = pos.self_participant_id;
            for (a, b) in base.iter().zip(refinado.iter()).filter(|(a, _)| a.participant_id == yo)
            {
                n_tramos += 1;
                dur_antes.push(a.end - a.start);
                dur_despues.push(b.end - b.start);
                ajustes.push((a.clone(), b.clone()));
                let off = pos.video_offset;
                let mmss = |t: f64| format!("{}:{:02}", (t as i64) / 60, (t as i64) % 60);
                println!(
                    "  vídeo {}..{} ({:>3.0}s)  ->  {}..{} ({:>3.0}s)   {:.0} rivales",
                    mmss(a.start + off), mmss(a.end + off), a.end - a.start,
                    mmss(b.start + off), mmss(b.end + off), b.end - b.start,
                    b.max_enemies
                );
            }
            n_part += 1;
        }

        if n_tramos == 0 {
            println!("sin tramos que comparar");
            return;
        }
        let media = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
        let mediana = |v: &mut Vec<f64>| {
            v.sort_by(f64::total_cmp);
            v[v.len() / 2]
        };
        let crecidos = dur_antes
            .iter()
            .zip(dur_despues.iter())
            .filter(|(a, b)| **b > **a + 0.1)
            .count();

        println!("\n{n_part} partidas, {n_tramos} tramos tuyos");
        println!(
            "duración  antes (solo API): mediana {:.0}s | media {:.0}s",
            mediana(&mut dur_antes.clone()),
            media(&dur_antes)
        );
        println!(
            "duración  después (vídeo) : mediana {:.0}s | media {:.0}s",
            mediana(&mut dur_despues.clone()),
            media(&dur_despues)
        );
        println!(
            "tramos que se alargaron   : {crecidos}/{n_tramos} ({:.0}%)",
            100.0 * crecidos as f64 / n_tramos as f64
        );
        let recortados = ajustes
            .iter()
            .filter(|(a, b)| (b.end - b.start) < (a.end - a.start) - 0.1)
            .count();
        println!(
            "tramos que se acortaron   : {}/{} ({:.0}%)",
            recortados,
            n_tramos,
            100.0 * recortados as f64 / n_tramos as f64
        );
        println!(
            "segundos ganados de media : {:+.0}s por tramo",
            media(&dur_despues) - media(&dur_antes)
        );

        // Las muertes son la verja: si el tramo acabó contigo muerto, esa
        // muerte tiene que seguir cayendo dentro. Es lo que distingue "recortar
        // el acercamiento" de "recortar la pelea".
        let (mut con_muerte, mut muerte_dentro) = (0, 0);
        for (a, b) in ajustes.iter() {
            if !a.died {
                continue;
            }
            con_muerte += 1;
            if b.died {
                muerte_dentro += 1;
            } else {
                println!(
                    "  muerte fuera: tramo {:.0}..{:.0} -> {:.0}..{:.0}",
                    a.start, a.end, b.start, b.end
                );
            }
        }
        if con_muerte > 0 {
            println!(
                "muertes que siguen dentro : {}/{} ({:.0}%)",
                muerte_dentro,
                con_muerte,
                100.0 * muerte_dentro as f64 / con_muerte as f64
            );
        }

        // Antes se exigía aquí que un tramo nunca se acortara. Eso daba por
        // bueno el fallo que el usuario reportó: la ventana se tragaba el
        // acercamiento del rival y anunciaba veintitrés segundos de presión
        // donde había diez. Acortar es el trabajo del refinado, no un error.
        //
        // Lo que sí tiene que seguir cumpliéndose: el tramo ajustado cae dentro
        // de lo que la API vio, más el margen que el vídeo puede estirar.
        for (a, b) in ajustes.iter() {
            assert!(
                b.start >= a.start - 30.0 && b.end <= a.end + 30.0,
                "el vídeo movió un tramo fuera de su margen:                  {:.0}..{:.0} -> {:.0}..{:.0}",
                a.start, a.end, b.start, b.end
            );
        }
    }
}
