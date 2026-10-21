//! El coach de macro: dónde se te va la partida.
//!
//! Convierte las jugadas con su ΔWP (`crate::winprob`) y las muertes con precio
//! (`crate::muertes`) en **categorías de pérdida** por **tramo** de partida, las
//! compara con un baremo y elige un **foco**. Es §2.2 y §2.3 de
//! `docs/coach-de-macro-diseno.md`.
//!
//! iTero da notas por tramo sobre estadísticas agregadas («tu daño recibido
//! está en el 9.º decil»). Aquí la unidad es la jugada: cada una lleva lo que
//! costó en probabilidad de victoria, entra en las categorías que explican por
//! qué, y la lista de las peores es la evidencia en vídeo.
//!
//! # Qué cuenta y cuánto
//!
//! Cada muerte carga **su precio entero** (la muerte más su parte del objetivo
//! rival de después, como el chip de «Tus muertes») en cada etiqueta que lleva.
//! Las categorías se solapan a propósito: son lentes, no un reparto. Una muerte
//! al jungla antes del dragón está en «jungla» y en «antes de objetivo».
//!
//! Tres que no salen de una etiqueta de `muertes`:
//! - **Antes de objetivo:** sólo la parte del objetivo (`wpa_objective`). Mide
//!   lo que el rival convirtió gracias a tus muertes; la muerte en sí ya está
//!   en las otras.
//! - **Ausente del objetivo:** un monstruo épico rival con tu icono lejos del
//!   foso, en base o muerto. Se reparte a partes iguales entre los aliados que
//!   faltaban, por la misma razón que en `muertes::precios`: si no, el dragón
//!   se cobraría cinco veces. Si tu muerte de los 60 s anteriores ya lo pagó,
//!   no se cobra otra vez aquí.
//! - **Tirada:** una muerte con tu equipo en [`UMBRAL_TIRADA`] o más.
//!
//! # Baremos
//!
//! Las que salen de la API se miden igual sobre el corpus, por franja de rango
//! × rol × tramo (`coach_baremos.rs`, generado por
//! `tests::baremos_del_coach`). Las dos que sólo existen en el vídeo —sin
//! mirar el mapa y la niebla— se comparan con **tu propia media**: lo que
//! habrían costado tus muertes si la condición se diera con la frecuencia de
//! siempre. Es un *lift*: con `sin_mirar_mapa` en el 92 % de tus muertes, el
//! conteo no dice nada; lo que dice algo es si antes de morir estás a ciegas
//! más a menudo que en un instante cualquiera de la misma partida.
//!
//! Atakhan no se valora: no existe en los datos de esta temporada (ver
//! `winprob`), así que no hay jugada que cobrar.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::minimap::Fix;
use crate::muertes::{self, Precio};
use crate::pressure_value::Vivos;
use crate::riot_api::{ParticipantDto, TimelineDto};
use crate::winprob::Play;

pub const ANTES_DE_OBJETIVO: &str = "antes_de_objetivo";
pub const AUSENTE: &str = "ausente_objetivo";
pub const TIRADA: &str = "tirada";

/// Todas, en el orden en que se enseñan.
pub const CATEGORIAS: [&str; 9] = [
    muertes::JUNGLA,
    muertes::FUERA_DE_ZONA,
    muertes::BAJO_TORRE,
    muertes::POCO_DANO,
    muertes::SIN_MIRAR,
    muertes::DESDE_NIEBLA,
    ANTES_DE_OBJETIVO,
    AUSENTE,
    TIRADA,
];

/// 0-7, 7-14, 14-21, 21-28 y 28+ (`muertes::CORTES_TRAMO`).
pub const TRAMOS: usize = 5;

/// Con tu equipo a esta probabilidad o más, morir es tirar la partida (§2.2).
pub const UMBRAL_TIRADA: f64 = 0.65;

/// Partidas que tiene que tener una combinación para poder ser el foco. Es el
/// mínimo de iTero; con menos de 15, `confidenceOf` (`patterns.ts`) lo llama
/// «indicio».
pub const FOCO_MIN_PARTIDAS: usize = 10;

/// Peores jugadas que se guardan por fila: las de la lista de reproducción.
const PEORES: usize = 5;

/// Muestra mínima de una celda (franja × rol × tramo) del corpus. Con menos se
/// usa la del rol sobre el corpus entero.
const MUESTRA_MIN: u32 = 100;

/// Las que no existen en el corpus: salen del vídeo y se comparan con tu propia
/// media.
pub fn de_video(cat: &str) -> bool {
    cat == muertes::SIN_MIRAR || cat == muertes::DESDE_NIEBLA
}

/// ¿Existe la categoría en ese tramo? Las dos de la fase de líneas acaban en el
/// 14:00, que es justo el corte entre el tramo 1 y el 2.
pub fn existe(cat: &str, tramo: usize) -> bool {
    !(matches!(cat, muertes::FUERA_DE_ZONA | muertes::BAJO_TORRE) && tramo >= 2)
}

/// ¿Llegó la partida al tramo? Una que acaba en el 25 no tiene 28+, y contarla
/// con 0 rebajaría la media de ese tramo.
pub fn llega(duracion: f64, tramo: usize) -> bool {
    tramo == 0 || duracion > muertes::CORTES_TRAMO[tramo - 1] * 60.0
}

fn tramo_de(sec: f64) -> usize {
    muertes::tramo(sec / 60.0)
}

// ------------------------------------------------------------ ausencias

/// A más de esto del foso, con tu posición del vídeo, no estabas en el
/// objetivo.
///
/// Medido en tus 26 partidas (`tests::radio_del_foso_en_mis_partidas`): en los
/// 81 objetivos que remataste o asististe, tu rastro estaba a p50 290 u del
/// foso y a p95 780. El margen hasta 2.000 es para quien está en la pelea sin
/// tocar al monstruo (haciendo de muro, persiguiendo).
const RADIO_FOSO_VIDEO: f64 = 2000.0;

/// Lo mismo con la posición por minuto de la API, interpolada: sin vídeo (y en
/// todo el corpus) es lo único que hay.
///
/// Medido contra tu rastro del vídeo en 201 objetivos épicos contigo vivo
/// (`tests::estimador_por_minuto_en_mis_partidas`): a 3.000 acierta el 79 %, y
/// sus dos errores casi se anulan (da «lejos» a 18 que estaban y «cerca» a 24
/// que no: 104 ausencias donde el vídeo dice 110). Eso es lo que importa para
/// un baremo, que es una suma: el del corpus, medido así, se puede comparar con
/// tu cifra medida con el vídeo. A 2.500 acierta un punto más pero sobra un
/// 11 % de ausencias. Probados y peores: el minuto más próximo y el más cercano
/// al foso de los dos que rodean al objetivo.
const RADIO_FOSO_MINUTO: f64 = 3000.0;

/// A menos de esto del punto de aparición estás en base.
const RADIO_FUENTE: f64 = 2500.0;

/// Una tanda de compras dice que estabas en base desde un poco antes de la
/// primera hasta un rato después de la última: de la fuente al foso se tarda
/// más de 20 s andando.
const ANTES_DE_COMPRAR: f64 = 10.0;
const TRAS_COMPRAR: f64 = 20.0;

/// Dónde estabas cuando el rival hizo un objetivo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Estado {
    Presente,
    Lejos,
    Base,
    Muerto,
    /// Tu muerte de los 60 s anteriores ya lo paga (`muertes::precios`).
    Cobrado,
    /// Sin posición: no se cobra.
    Desconocido,
}

impl Estado {
    fn ausente(self) -> bool {
        matches!(self, Estado::Lejos | Estado::Base | Estado::Muerto)
    }

    fn clave(self) -> &'static str {
        match self {
            Estado::Base => "base",
            Estado::Muerto => "dead",
            _ => "far",
        }
    }
}

/// Un monstruo épico y lo que valió para quien lo hizo.
#[derive(Debug, Clone)]
struct Objetivo {
    time: f64,
    team: i32,
    kind: String,
    x: f64,
    y: f64,
    wpa: f64,
}

// ------------------------------------------------------------ jugadas

/// Una jugada que te costó, ya en sus categorías.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Jugada {
    /// Segundos de partida.
    pub time: f64,
    /// `"death"` o `"objective"` (un objetivo rival sin ti).
    pub kind: String,
    /// El campeón que te mató.
    #[serde(default)]
    pub killer: Option<String>,
    /// En una muerte, el objetivo rival que más pesó de los de después. En un
    /// objetivo, cuál fue (`Play::kind`).
    #[serde(default)]
    pub objective: Option<String>,
    /// En un objetivo: `"far"`, `"base"` o `"dead"`.
    #[serde(default)]
    pub state: Option<String>,
    /// Lo que costó, en probabilidad de victoria (0-1), ≥ 0.
    pub lost: f64,
    /// Lo que carga en cada categoría en la que entra, ≥ 0.
    pub charges: Vec<(String, f64)>,
    /// Categorías de vídeo en las que esta muerte cuenta para tu media, con la
    /// probabilidad de la condición en un momento cualquiera de su tramo.
    #[serde(default)]
    pub expected: Vec<(String, f64)>,
}

impl Jugada {
    pub fn cargo(&self, cat: &str) -> Option<f64> {
        self.charges.iter().find(|(c, _)| c == cat).map(|(_, v)| *v)
    }
}

/// Todo lo que el coach necesita de una partida, una vez por partida: los diez
/// jugadores salen de la misma pasada (el corpus la usa así).
pub struct Analisis<'a> {
    ps: &'a [ParticipantDto],
    plays: &'a [Play],
    precios: Vec<Precio>,
    vivos: Vivos,
    /// Por participante (índice `pid - 1`).
    anclas: Vec<Vec<(f64, f64, f64)>>,
    fuentes: Vec<Option<(f64, f64)>>,
    tiendas: Vec<Vec<(f64, f64)>>,
    asesinos: HashMap<(i32, i64), i32>,
    objetivos: Vec<Objetivo>,
    pub duracion: f64,
}

fn rol(p: &ParticipantDto) -> &str {
    if p.teamPosition.is_empty() {
        &p.individualPosition
    } else {
        &p.teamPosition
    }
}

/// Tu posición en el rastro del vídeo, si hay una muestra a menos de 2 s.
fn en_pista(pista: &[Fix], sec: f64) -> Option<(f64, f64)> {
    let i = pista.partition_point(|f| f.sec < sec);
    [i.checked_sub(1), Some(i)]
        .into_iter()
        .flatten()
        .filter_map(|j| pista.get(j))
        .filter(|f| (f.sec - sec).abs() <= 2.0)
        .min_by(|a, b| (a.sec - sec).abs().total_cmp(&(b.sec - sec).abs()))
        .map(|f| (f.x, f.y))
}

impl<'a> Analisis<'a> {
    pub fn new(tl: &'a TimelineDto, ps: &'a [ParticipantDto], plays: &'a [Play]) -> Self {
        let precios = muertes::precios(tl, ps, plays);
        let anclas: Vec<_> = (1..=10).map(|pid| crate::minimap::anclas_de(tl, pid)).collect();
        // La fuente es donde estaba cada uno en el fotograma 0: la exacta de
        // esta partida, sin coordenadas escritas a mano.
        let fuentes = anclas
            .iter()
            .map(|a| a.first().filter(|(t, _, _)| *t < 1.0).map(|(_, x, y)| (*x, *y)))
            .collect();
        let tiendas = (1..=10)
            .map(|pid| {
                let muertos = crate::jungle_route::muertes(tl, pid);
                crate::jungle_route::visitas_a_base(tl, pid, &muertos)
                    .into_iter()
                    .map(|(a, b, _)| (a, b))
                    .collect()
            })
            .collect();
        let mut asesinos = HashMap::new();
        let mut objetivos = Vec::new();
        for ev in tl.info.frames.iter().flat_map(|f| f.events.iter()) {
            match ev.event_type.as_str() {
                "CHAMPION_KILL" => {
                    asesinos.insert((ev.victimId, ev.timestamp), ev.killerId);
                }
                "ELITE_MONSTER_KILL" => {
                    let Some(pos) = ev.position.as_ref() else { continue };
                    let sec = ev.timestamp as f64 / 1000.0;
                    // La jugada que lo valoró. Sin ella (Atakhan) no hay nada
                    // que cobrar.
                    let Some(p) = plays.iter().find(|p| {
                        (p.time - sec).abs() < 1e-6 && matches!(p.kind.as_str(), "dragon" | "baron" | "herald" | "grubs")
                    }) else {
                        continue;
                    };
                    objetivos.push(Objetivo {
                        time: sec,
                        team: p.team_id,
                        kind: p.kind.clone(),
                        x: pos.x as f64,
                        y: pos.y as f64,
                        wpa: p.wpa.max(0.0),
                    });
                }
                _ => {}
            }
        }
        let duracion = tl.info.frames.last().map(|f| f.timestamp as f64 / 1000.0).unwrap_or(0.0);
        Analisis {
            ps,
            plays,
            precios,
            vivos: Vivos::build(tl),
            anclas,
            fuentes,
            tiendas,
            asesinos,
            objetivos,
            duracion,
        }
    }

    fn equipo(&self, pid: i32) -> Option<i32> {
        self.ps.get((pid - 1) as usize).map(|p| p.teamId)
    }

    /// Sólo la usa el baremo del corpus, de ahí el `cfg(test)`.
    #[cfg(test)]
    pub fn rol(&self, pid: i32) -> Option<&str> {
        self.ps.get((pid - 1) as usize).map(rol)
    }

    fn estado(&self, pid: i32, o: &Objetivo, pista: Option<&[Fix]>) -> Estado {
        let cobrado = self
            .precios
            .iter()
            .any(|d| d.victim == pid && d.time <= o.time && d.time >= o.time - muertes::VENTANA_OBJETIVO);
        if cobrado {
            return Estado::Cobrado;
        }
        if !self.vivos.alive(pid, o.time) {
            return Estado::Muerto;
        }
        let i = (pid - 1) as usize;
        if self.tiendas[i].iter().any(|(a, b)| o.time >= a - ANTES_DE_COMPRAR && o.time <= b + TRAS_COMPRAR) {
            return Estado::Base;
        }
        let (pos, radio) = match pista.and_then(|p| en_pista(p, o.time)) {
            Some(p) => (Some(p), RADIO_FOSO_VIDEO),
            None => (crate::minimap::interpolar(&self.anclas[i], o.time), RADIO_FOSO_MINUTO),
        };
        let Some((x, y)) = pos else { return Estado::Desconocido };
        if self.fuentes[i].is_some_and(|(fx, fy)| (fx - x).hypot(fy - y) < RADIO_FUENTE) {
            return Estado::Base;
        }
        if (o.x - x).hypot(o.y - y) > radio {
            Estado::Lejos
        } else {
            Estado::Presente
        }
    }

    /// Los objetivos épicos que el rival de `pid` hizo sin él, con su parte.
    ///
    /// `pista` es tu rastro del vídeo, y sólo vale para `pid`: para los
    /// aliados (que cuentan para repartir) se usa siempre la posición por
    /// minuto.
    fn ausencias(&self, pid: i32, pista: Option<&[Fix]>) -> Vec<Jugada> {
        let Some(equipo) = self.equipo(pid) else { return Vec::new() };
        let mut out = Vec::new();
        for o in self.objetivos.iter().filter(|o| o.team != equipo && o.wpa > 0.0) {
            let mio = self.estado(pid, o, pista);
            if !mio.ausente() {
                continue;
            }
            let faltaban = (1..=10)
                .filter(|q| *q != pid && self.equipo(*q) == Some(equipo))
                .filter(|q| self.estado(*q, o, None).ausente())
                .count()
                + 1;
            let parte = o.wpa / faltaban as f64;
            out.push(Jugada {
                time: o.time,
                kind: "objective".into(),
                objective: Some(o.kind.clone()),
                state: Some(mio.clave().into()),
                lost: parte,
                charges: vec![(AUSENTE.into(), parte)],
                ..Default::default()
            });
        }
        out
    }

    /// Las jugadas que le costaron a `pid`, sólo con la API: sus muertes con
    /// las etiquetas de `muertes` y los objetivos que el rival hizo sin él.
    pub fn jugadas(&self, pid: i32, pista: Option<&[Fix]>) -> Vec<Jugada> {
        let mut out = Vec::new();
        for d in self.precios.iter().filter(|d| d.victim == pid) {
            let lost = -(d.wpa_death + d.wpa_objective).min(0.0);
            let mut charges: Vec<(String, f64)> = d
                .tags
                .iter()
                .filter(|t| CATEGORIAS.contains(&t.as_str()) && !de_video(t))
                .map(|t| (t.clone(), lost))
                .collect();
            if d.objective.is_some() && d.wpa_objective < 0.0 {
                charges.push((ANTES_DE_OBJETIVO.into(), -d.wpa_objective));
            }
            // La probabilidad de tu equipo justo antes: la jugada va desde la
            // óptica de quien mató.
            let antes = self
                .plays
                .iter()
                .find(|p| p.victim == Some(pid) && (p.time - d.time).abs() < 1e-6)
                .map(|p| 1.0 - p.before);
            if antes.is_some_and(|p| p >= UMBRAL_TIRADA) {
                charges.push((TIRADA.into(), lost));
            }
            let ms = (d.time * 1000.0).round() as i64;
            let killer = self
                .asesinos
                .get(&(pid, ms))
                .and_then(|k| self.ps.get((*k - 1) as usize))
                .map(|p| p.championName.clone());
            out.push(Jugada {
                time: d.time,
                kind: "death".into(),
                killer,
                objective: d.objective.clone(),
                lost,
                charges,
                ..Default::default()
            });
        }
        out.extend(self.ausencias(pid, pista));
        out.sort_by(|a, b| a.time.total_cmp(&b.time));
        out
    }

    /// Tu WPA en cada tramo: lo mismo que `winprob::per_player_breakdown`,
    /// partido por el instante de cada jugada.
    pub fn wpa_por_tramo(&self, pid: i32) -> [f64; TRAMOS] {
        let mut v = [0.0; TRAMOS];
        for p in self.plays {
            let t = tramo_de(p.time);
            for (q, f) in &p.shares {
                if *q == pid {
                    v[t] += p.wpa * f;
                }
            }
            if p.victim == Some(pid) {
                v[t] -= p.wpa;
            }
        }
        v
    }
}

/// Lo que cada categoría te cobró en cada tramo. La app lo agrega en
/// `resumen`; esto es para el baremo y los tests.
#[cfg(test)]
pub fn por_tramo(jugadas: &[Jugada]) -> HashMap<String, [f64; TRAMOS]> {
    let mut out: HashMap<String, [f64; TRAMOS]> = HashMap::new();
    for j in jugadas {
        let t = tramo_de(j.time);
        for (c, v) in &j.charges {
            out.entry(c.clone()).or_default()[t] += v;
        }
    }
    out
}

// ------------------------------------------------------------ vídeo

/// Desde cuándo cuenta un instante para tu media de «sin mirar»: el primer
/// minuto y medio se va en llegar a la línea, y nadie mira el mapa en la fuente.
const SIN_MIRAR_DESDE: f64 = 90.0;

/// Las dos categorías de vídeo, con su media propia.
///
/// `miradas` son tus miradas al mapa en segundos de vídeo
/// (`muertes::miradas`); `aperturas`, las peleas que te empezaron, como
/// `(t_game, died, from_fog)`. Cada una vacía apaga su categoría: sin miradas
/// grabadas, «no miraste» sería mentira.
///
/// Devuelve, por categoría medida, la tasa de la condición en cada tramo.
pub fn con_video(
    jugadas: &mut [Jugada],
    duracion: f64,
    miradas: &[f64],
    video_offset: Option<f64>,
    aperturas: &[(f64, bool, bool)],
    vivo: impl Fn(f64) -> bool,
) -> HashMap<String, [Option<f64>; TRAMOS]> {
    let mut tasas = HashMap::new();

    if let (false, Some(off)) = (miradas.is_empty(), video_offset) {
        // Un instante por segundo, vivo: ¿llevabas 10 s sin mirar?
        let mut cuenta = [(0usize, 0usize); TRAMOS];
        let mut s = SIN_MIRAR_DESDE;
        while s < duracion {
            if vivo(s) {
                let c = &mut cuenta[tramo_de(s)];
                c.0 += 1;
                c.1 += muertes::sin_mirar(miradas, s + off) as usize;
            }
            s += 1.0;
        }
        let tasa = cuenta.map(|(n, k)| (n > 0).then(|| k as f64 / n as f64));
        for j in jugadas.iter_mut().filter(|j| j.kind == "death") {
            let Some(p) = tasa[tramo_de(j.time)] else { continue };
            j.expected.push((muertes::SIN_MIRAR.into(), p));
            if muertes::sin_mirar(miradas, j.time + off) {
                j.charges.push((muertes::SIN_MIRAR.into(), j.lost));
            }
        }
        tasas.insert(muertes::SIN_MIRAR.to_string(), tasa);
    }

    if !aperturas.is_empty() {
        // De todas las peleas que te empezaron, cuántas desde la niebla. Si un
        // tramo no tiene ninguna, la de toda la partida.
        let mut cuenta = [(0usize, 0usize); TRAMOS];
        for (t, _, niebla) in aperturas {
            let c = &mut cuenta[tramo_de(*t)];
            c.0 += 1;
            c.1 += *niebla as usize;
        }
        let (n, k) = cuenta.iter().fold((0, 0), |a, c| (a.0 + c.0, a.1 + c.1));
        let global = k as f64 / n as f64;
        let tasa = cuenta.map(|(n, k)| Some(if n > 0 { k as f64 / n as f64 } else { global }));
        for j in jugadas.iter_mut().filter(|j| j.kind == "death") {
            // Sólo las muertes con la pelea leída: de las otras no se sabe.
            let Some(niebla) = muertes::apertura_mortal(aperturas.iter().copied(), j.time) else { continue };
            j.expected.push((muertes::DESDE_NIEBLA.into(), tasa[tramo_de(j.time)].unwrap_or(global)));
            if niebla {
                j.charges.push((muertes::DESDE_NIEBLA.into(), j.lost));
            }
        }
        tasas.insert(muertes::DESDE_NIEBLA.to_string(), tasa);
    }
    tasas
}

// ------------------------------------------------------------ una partida

/// Lo que el coach guarda de una partida tuya.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PartidaCoach {
    pub match_id: String,
    pub date: String,
    pub champion: String,
    pub role: String,
    /// Franja de rango al jugarla: "bajo", "medio" o "alto".
    pub band: Option<String>,
    /// Segundos de partida.
    pub duration: f64,
    /// `None` si no hay vídeo que abrir.
    pub video_offset: Option<f64>,
    /// De dónde sale tu posición en los objetivos: `"video"` o `"minute"`.
    pub positions: String,
    pub plays: Vec<Jugada>,
    pub wpa_tramo: [f64; TRAMOS],
    /// Las categorías de vídeo medidas en esta partida, con la tasa de la
    /// condición en cada tramo.
    pub own_rate: HashMap<String, [Option<f64>; TRAMOS]>,
}

/// Caché en la carpeta de la partida. Cualquier cambio en las reglas exige
/// subir el número.
pub const FICHERO: &str = "coach_v1.json";

/// Los ficheros de los que sale el análisis. Si alguno es más nuevo que la
/// caché, se rehace.
fn fuentes_de(id: &str) -> Vec<std::path::PathBuf> {
    let dir = crate::storage::get_match_dir(id);
    [
        "riot_match.json".to_string(),
        "riot_timeline.json".to_string(),
        "minimap_positions.json".to_string(),
        "camera_snaps.json".to_string(),
        "hud_vida.json".to_string(),
        "barras.json".to_string(),
        format!("{id}.json"),
    ]
    .into_iter()
    .map(|f| dir.join(f))
    .collect()
}

/// Analiza una partida tuya ya sincronizada. Sólo lee.
pub fn analizar(meta: &crate::storage::MatchMetadata) -> Option<PartidaCoach> {
    let id = &meta.id;
    let pid = meta.participants.iter().position(|p| p.is_self)? as i32 + 1;
    let m: crate::riot_api::MatchDto = serde_json::from_str(&crate::storage::load_raw_match(id)?).ok()?;
    let tl: TimelineDto = serde_json::from_str(&crate::storage::load_raw_timeline(id)?).ok()?;
    let ps = &m.info.participants;
    let yo = ps.get((pid - 1) as usize)?;
    let plays = crate::winprob::plays(&tl, ps);
    let an = Analisis::new(&tl, ps, &plays);

    let pista = crate::minimap::Positions::load(id)
        .filter(|p| p.self_participant_id == pid)
        .map(|p| p.follow(&crate::minimap::anclas_de(&tl, pid)))
        .filter(|p| !p.is_empty());
    let mut jugadas = an.jugadas(pid, pista.as_deref());

    let con_video_grabado = !meta.video_path.is_empty();
    let miradas = muertes::miradas(id, &meta.camera_snaps);
    let aperturas: Vec<(f64, bool, bool)> =
        crate::golpes::aperturas_de(id).iter().map(|a| (a.t_game, a.died, a.from_fog)).collect();
    let own_rate = con_video(&mut jugadas, an.duracion, &miradas, meta.video_offset, &aperturas, |s| {
        an.vivos.alive(pid, s)
    });

    Some(PartidaCoach {
        match_id: id.clone(),
        date: meta.date.clone(),
        champion: yo.championName.clone(),
        role: rol(yo).to_string(),
        band: meta.tier_bucket.clone(),
        duration: an.duracion,
        video_offset: if con_video_grabado { meta.video_offset } else { None },
        positions: if pista.is_some() { "video" } else { "minute" }.into(),
        wpa_tramo: an.wpa_por_tramo(pid),
        plays: jugadas,
        own_rate,
    })
}

/// Colas de la Grieta del Invocador contra jugadores. En ARAM, Arena o URF no
/// hay jungla ni tramos de partida que comparar con un baremo sacado de
/// clasificatorias: una muerte que no existe contaría como una partida limpia.
const COLAS_DE_LA_GRIETA: [i32; 7] = [400, 420, 430, 440, 480, 490, 700];

/// ¿Entra la partida en el coach? Sincronizada, grabada (no un VOD importado) y
/// de la Grieta. Las antiguas sin cola guardada entran: son de antes de que se
/// guardara, no de otro modo de juego.
pub fn cuenta(meta: &crate::storage::MatchMetadata) -> bool {
    !meta.is_vod && meta.riot_match_id.is_some() && meta.queue.is_none_or(|q| COLAS_DE_LA_GRIETA.contains(&q))
}

/// Las partidas del coach con su análisis, de la más reciente a la más antigua.
pub fn tus_partidas() -> Vec<PartidaCoach> {
    crate::storage::load_all_matches().iter().filter(|m| cuenta(m)).filter_map(cacheada).collect()
}

pub(crate) fn cacheada(meta: &crate::storage::MatchMetadata) -> Option<PartidaCoach> {
    let cache = crate::storage::get_match_dir(&meta.id).join(FICHERO);
    let mtime = |p: &std::path::Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
    if let Some(c) = mtime(&cache) {
        let fresca = fuentes_de(&meta.id).iter().filter_map(|f| mtime(f)).all(|t| t <= c);
        if fresca {
            if let Some(v) = std::fs::read_to_string(&cache).ok().and_then(|r| serde_json::from_str(&r).ok()) {
                return Some(v);
            }
        }
    }
    let p = analizar(meta)?;
    if let Ok(texto) = serde_json::to_string(&p) {
        let _ = std::fs::write(&cache, texto);
    }
    Some(p)
}

// ------------------------------------------------------------ baremos

/// ¿Tiene la celda (franja, rol, tramo) muestra suficiente en el corpus? La
/// franja `""` es el corpus entero.
fn con_muestra(band: &str, role: &str, tramo: usize) -> bool {
    crate::coach_baremos::MUESTRA
        .iter()
        .find(|(b, r, _)| *b == band && *r == role)
        .is_some_and(|f| f.2[tramo] >= MUESTRA_MIN)
}

/// La franja con la que se compara: la tuya si tiene muestra, y si no el rol
/// sobre el corpus entero.
fn franja_util<'b>(band: Option<&'b str>, role: &str, tramo: usize) -> Option<&'b str> {
    band.filter(|b| con_muestra(b, role, tramo))
        .or_else(|| con_muestra("", role, tramo).then_some(""))
}

/// Pérdida media por partida de una categoría en el corpus.
pub fn baremo(band: Option<&str>, role: &str, cat: &str, tramo: usize) -> Option<f64> {
    let b = franja_util(band, role, tramo)?;
    crate::coach_baremos::PERDIDA
        .iter()
        .find(|(bb, r, c, _)| *bb == b && *r == role && *c == cat)
        .map(|f| f.3[tramo])
}

/// Percentil (0-100) de tu WPA en un tramo frente a tu rol y franja.
pub fn percentil_tramo(band: Option<&str>, role: &str, tramo: usize, wpa: f64) -> Option<f64> {
    let b = franja_util(band, role, tramo)?;
    let cortes = crate::coach_baremos::WPA_DECILES.iter().find(|(bb, r, _)| *bb == b && *r == role)?.2[tramo];
    Some(crate::benchmarks::interpolar(&cortes, wpa))
}

// ------------------------------------------------------------ el resumen

/// Una de las peores jugadas de una fila, lista para la lista de reproducción.
#[derive(Debug, Clone, Serialize)]
pub struct JugadaRef {
    pub match_id: String,
    pub champion: String,
    pub date: String,
    /// Segundos de partida.
    pub time: f64,
    /// Segundos de vídeo, si la partida conserva su vídeo.
    pub video_time: Option<f64>,
    /// Lo que cargó en esta categoría.
    pub lost: f64,
    pub kind: String,
    pub killer: Option<String>,
    pub objective: Option<String>,
    pub state: Option<String>,
}

/// Una categoría en un tramo (o en toda la partida, `tramo: None`).
#[derive(Debug, Clone, Serialize)]
pub struct Fila {
    pub category: String,
    pub tramo: Option<usize>,
    /// Partidas en que se pudo medir.
    pub games: usize,
    /// Jugadas que cargó.
    pub plays: usize,
    /// Lo que te cuesta por partida (0-1).
    pub user: f64,
    /// Lo mismo según el baremo. `None` sin baremo.
    pub base: Option<f64>,
    /// `user - base`: positivo es perder más de lo normal.
    pub excess: Option<f64>,
    /// `"corpus"` o `"own"` (tu propia media, para las de vídeo).
    pub baseline: Option<String>,
    /// Sólo las de vídeo: en qué fracción de tus muertes medidas se dio la
    /// condición, y en qué fracción se habría dado con tu media. Su cociente
    /// es el lift.
    pub rate_deaths: Option<f64>,
    pub rate_any: Option<f64>,
    pub worst: Vec<JugadaRef>,
}

/// Tu WPA en un tramo, frente al corpus.
#[derive(Debug, Clone, Serialize)]
pub struct NotaTramo {
    pub tramo: usize,
    pub games: usize,
    /// WPA medio por partida.
    pub wpa: f64,
    /// Media de tus percentiles de cada partida frente a tu rol y franja.
    pub percentile: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Resumen {
    pub games: usize,
    /// La franja más frecuente de tus partidas: la que dice «en tu rango».
    pub band: Option<String>,
    /// Si todas tus partidas son de esa franja.
    pub band_uniform: bool,
    pub min_games: usize,
    pub rows: Vec<Fila>,
    /// La categoría × tramo con más pérdida por encima de su baremo, con al
    /// menos [`FOCO_MIN_PARTIDAS`].
    pub focus: Option<Fila>,
    pub tramos: Vec<NotaTramo>,
}

/// Lo que una partida aporta a una fila: (tú, baremo, jugadas, en la condición
/// y esperadas). `None` si en esa partida la fila no se puede medir.
fn aporte(p: &PartidaCoach, cat: &str, tramos: &[usize]) -> Option<(f64, Option<f64>, usize, f64, f64)> {
    let medibles: Vec<usize> = tramos.iter().copied().filter(|t| llega(p.duration, *t) && existe(cat, *t)).collect();
    if medibles.is_empty() || (de_video(cat) && !p.own_rate.contains_key(cat)) {
        return None;
    }
    let en = |j: &Jugada| medibles.contains(&tramo_de(j.time));
    let mut user = 0.0;
    let mut n = 0;
    for j in p.plays.iter().filter(|j| en(j)) {
        if let Some(v) = j.cargo(cat) {
            user += v;
            n += 1;
        }
    }
    let (mut esperado, mut si, mut cuenta) = (0.0, 0.0, 0.0);
    let base = if de_video(cat) {
        for j in p.plays.iter().filter(|j| en(j)) {
            if let Some((_, q)) = j.expected.iter().find(|(c, _)| c == cat) {
                esperado += j.lost * q;
                cuenta += q;
                si += j.cargo(cat).is_some() as u8 as f64;
            }
        }
        Some(esperado)
    } else {
        medibles
            .iter()
            .map(|t| baremo(p.band.as_deref(), &p.role, cat, *t))
            .sum::<Option<f64>>()
    };
    Some((user, base, n, si, cuenta))
}

/// Lo que te costó una categoría en un tramo de una partida: (pérdida, su
/// baremo, jugadas que cargaron). `None` si en esa partida no se puede medir.
pub fn coste(p: &PartidaCoach, cat: &str, tramo: usize) -> Option<(f64, Option<f64>, usize)> {
    aporte(p, cat, &[tramo]).map(|(user, base, n, _, _)| (user, base, n))
}

fn fila(partidas: &[PartidaCoach], cat: &str, tramo: Option<usize>) -> Fila {
    let tramos: Vec<usize> = match tramo {
        Some(t) => vec![t],
        None => (0..TRAMOS).collect(),
    };
    let (mut games, mut plays, mut user, mut base, mut con_base) = (0usize, 0usize, 0.0, 0.0, 0usize);
    let (mut si, mut esperadas, mut muertes_medidas) = (0.0, 0.0, 0usize);
    let mut peores: Vec<JugadaRef> = Vec::new();
    for p in partidas {
        let Some((u, b, n, s, e)) = aporte(p, cat, &tramos) else { continue };
        games += 1;
        plays += n;
        user += u;
        if let Some(b) = b {
            base += b;
            con_base += 1;
        }
        si += s;
        esperadas += e;
        muertes_medidas += p
            .plays
            .iter()
            .filter(|j| tramos.contains(&tramo_de(j.time)) && j.expected.iter().any(|(c, _)| c == cat))
            .count();
        for j in p.plays.iter().filter(|j| tramos.contains(&tramo_de(j.time))) {
            let Some(v) = j.cargo(cat) else { continue };
            peores.push(JugadaRef {
                match_id: p.match_id.clone(),
                champion: p.champion.clone(),
                date: p.date.clone(),
                time: j.time,
                video_time: p.video_offset.map(|o| j.time + o),
                lost: v,
                kind: j.kind.clone(),
                killer: j.killer.clone(),
                objective: j.objective.clone(),
                state: j.state.clone(),
            });
        }
    }
    peores.sort_by(|a, b| b.lost.total_cmp(&a.lost));
    peores.truncate(PEORES);
    let media = |x: f64| if games > 0 { x / games as f64 } else { 0.0 };
    // Un baremo a medias (alguna partida sin fila en la tabla) no se compara.
    let base = (games > 0 && con_base == games).then(|| media(base));
    let video = de_video(cat);
    Fila {
        category: cat.to_string(),
        tramo,
        games,
        plays,
        user: media(user),
        base,
        excess: base.map(|b| media(user) - b),
        baseline: base.map(|_| if video { "own" } else { "corpus" }.to_string()),
        rate_deaths: (video && muertes_medidas > 0).then(|| si / muertes_medidas as f64),
        rate_any: (video && muertes_medidas > 0).then(|| esperadas / muertes_medidas as f64),
        worst: peores,
    }
}

/// Las filas que pueden ser foco (con tramo, con muestra y por encima de su
/// baremo), de la que más pierdes por encima de él a la que menos.
pub fn candidatos(rows: &[Fila]) -> Vec<&Fila> {
    let mut c: Vec<&Fila> = rows
        .iter()
        .filter(|f| f.tramo.is_some() && f.games >= FOCO_MIN_PARTIDAS && f.excess.is_some_and(|e| e > 0.0))
        .collect();
    c.sort_by(|a, b| b.excess.unwrap_or(0.0).total_cmp(&a.excess.unwrap_or(0.0)));
    c
}

/// El foco: la fila con más pérdida por encima de su baremo, con muestra.
fn foco(rows: &[Fila]) -> Option<Fila> {
    candidatos(rows).first().map(|f| (*f).clone())
}

pub fn resumen(partidas: &[PartidaCoach]) -> Resumen {
    let mut rows = Vec::new();
    for cat in CATEGORIAS {
        rows.push(fila(partidas, cat, None));
        for t in (0..TRAMOS).filter(|t| existe(cat, *t)) {
            rows.push(fila(partidas, cat, Some(t)));
        }
    }
    let tramos = (0..TRAMOS)
        .map(|t| {
            let en: Vec<&PartidaCoach> = partidas.iter().filter(|p| llega(p.duration, t)).collect();
            let pcts: Vec<f64> =
                en.iter().filter_map(|p| percentil_tramo(p.band.as_deref(), &p.role, t, p.wpa_tramo[t])).collect();
            NotaTramo {
                tramo: t,
                games: en.len(),
                wpa: if en.is_empty() { 0.0 } else { en.iter().map(|p| p.wpa_tramo[t]).sum::<f64>() / en.len() as f64 },
                percentile: (!pcts.is_empty() && pcts.len() == en.len())
                    .then(|| pcts.iter().sum::<f64>() / pcts.len() as f64),
            }
        })
        .collect();
    let mut franjas: HashMap<&str, usize> = HashMap::new();
    for p in partidas {
        *franjas.entry(p.band.as_deref().unwrap_or("")).or_default() += 1;
    }
    let mayor = franjas.iter().max_by_key(|(b, n)| (**n, b.to_string())).map(|(b, _)| b.to_string());
    Resumen {
        games: partidas.len(),
        band: mayor.clone().filter(|b| !b.is_empty()),
        band_uniform: franjas.len() == 1,
        min_games: FOCO_MIN_PARTIDAS,
        focus: foco(&rows),
        rows,
        tramos,
    }
}

/// Las categorías, los tramos y el foco sobre todas tus partidas grabadas.
#[tauri::command]
pub async fn get_coach_summary() -> Resumen {
    tokio::task::spawn_blocking(|| resumen(&tus_partidas())).await.unwrap_or_else(|_| resumen(&[]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::riot_api::PositionDto;
    use crate::winprob::fixtures::{diez, kill, monstruo, partida};
    use serde_json::json;

    const MID: (i32, i32) = (7450, 7450);
    const FOSO_DRAGON: (i32, i32) = (9866, 4414);
    /// Arriba a la izquierda: lejos de los dos fosos y de las dos fuentes.
    const LEJOS: (i32, i32) = (1500, 13000);

    fn fuente(pid: i32) -> (i32, i32) {
        if pid <= 5 { (500, 500) } else { (14300, 14300) }
    }

    /// Pone a cada jugador en `pos(pid, minuto)` en cada fotograma; en el 0,
    /// en su fuente.
    fn colocar(tl: &mut TimelineDto, pos: impl Fn(i32, usize) -> (i32, i32)) {
        for (m, f) in tl.info.frames.iter_mut().enumerate() {
            for (k, pf) in f.participantFrames.iter_mut() {
                let pid: i32 = k.parse().unwrap();
                let (x, y) = if m == 0 { fuente(pid) } else { pos(pid, m) };
                pf.position = Some(PositionDto { x, y });
            }
        }
    }

    fn dragon(ts: i64, team: i32) -> serde_json::Value {
        let mut e = monstruo(ts, team, "DRAGON");
        e["position"] = json!({ "x": FOSO_DRAGON.0, "y": FOSO_DRAGON.1 });
        e
    }

    fn compra(ts: i64, pid: i32) -> serde_json::Value {
        json!({ "type": "ITEM_PURCHASED", "timestamp": ts, "participantId": pid, "itemId": 1001 })
    }

    fn jugadas_de(tl: &TimelineDto, pid: i32, pista: Option<&[Fix]>) -> Vec<Jugada> {
        let ps = diez();
        let plays = crate::winprob::plays(tl, &ps);
        Analisis::new(tl, &ps, &plays).jugadas(pid, pista)
    }

    fn muertes_de(js: &[Jugada]) -> Vec<&Jugada> {
        js.iter().filter(|j| j.kind == "death").collect()
    }

    fn objetivos_de(js: &[Jugada]) -> Vec<&Jugada> {
        js.iter().filter(|j| j.kind == "objective").collect()
    }

    /// Lo que valió el dragón para quien lo hizo.
    fn valor_del_dragon(tl: &TimelineDto) -> f64 {
        crate::winprob::plays(tl, &diez()).iter().find(|p| p.kind == "dragon").unwrap().wpa
    }

    #[test]
    fn el_corte_de_las_lineas_es_el_de_los_tramos() {
        // `existe` da por hecho que el 14:00 de `muertes` cae justo entre el
        // tramo 1 y el 2.
        assert_eq!(muertes::CORTES_TRAMO[1] * 60.0, muertes::FIN_DE_LINEAS);
        for cat in [muertes::FUERA_DE_ZONA, muertes::BAJO_TORRE] {
            assert!(existe(cat, 0) && existe(cat, 1) && !existe(cat, 2) && !existe(cat, 4));
        }
        assert!(existe(muertes::JUNGLA, 4) && existe(TIRADA, 4));
    }

    #[test]
    fn una_partida_corta_no_cuenta_en_los_tramos_que_no_jugo() {
        assert!(llega(100.0, 0));
        assert!(llega(25.0 * 60.0, 3) && !llega(25.0 * 60.0, 4));
        assert!(!llega(28.0 * 60.0, 4), "acabar justo en el 28:00 no es jugar el 28+");
    }

    /// Cada etiqueta de `muertes` carga el precio entero de la muerte, y en el
    /// tramo en que ocurrió.
    #[test]
    fn las_etiquetas_de_muerte_cargan_su_precio() {
        // 7 es el jungla del 200. El medio (3) muere en el centro sin devolver
        // daño: jungla y poco daño. En el 16:40, ya fuera de las líneas.
        let tl = partida(30, vec![kill(300_000, 7, 3, &[], MID.0, MID.1), kill(1_000_000, 8, 3, &[], MID.0, MID.1)]);
        let js = jugadas_de(&tl, 3, None);
        let m = muertes_de(&js);
        assert_eq!(m.len(), 2);
        assert!(m[0].lost > 0.0);
        assert_eq!(m[0].cargo(muertes::JUNGLA), Some(m[0].lost));
        assert_eq!(m[0].cargo(muertes::POCO_DANO), Some(m[0].lost));
        assert_eq!(m[1].cargo(muertes::JUNGLA), None, "le mató el medio");
        assert_eq!(m[0].killer.as_deref(), Some("Campeon7"));
        let t = por_tramo(&js);
        assert_eq!(t[muertes::JUNGLA][0], m[0].lost);
        assert_eq!(t[muertes::JUNGLA][2], 0.0);
    }

    #[test]
    fn fuera_de_zona_solo_en_la_fase_de_lineas() {
        // El top (1) en el centro del mapa, en el 6:40 y en el 16:40.
        let tl = partida(30, vec![kill(400_000, 6, 1, &[], MID.0, MID.1), kill(1_000_000, 6, 1, &[], MID.0, MID.1)]);
        let m = jugadas_de(&tl, 1, None);
        let m = muertes_de(&m);
        assert!(m[0].cargo(muertes::FUERA_DE_ZONA).is_some());
        assert!(m[1].cargo(muertes::FUERA_DE_ZONA).is_none());
    }

    /// Morir y que el rival haga el dragón: el dragón va a «antes de
    /// objetivo» (sólo él) y entra en el precio de la muerte para las demás.
    /// Y no se cobra otra vez como ausencia.
    #[test]
    fn antes_de_objetivo_carga_solo_el_objetivo() {
        let mut tl = partida(30, vec![kill(600_000, 8, 3, &[], MID.0, MID.1), dragon(630_000, 200)]);
        colocar(&mut tl, |_, _| FOSO_DRAGON);
        let ps = diez();
        let plays = crate::winprob::plays(&tl, &ps);
        let precio = &muertes::precios(&tl, &ps, &plays)[0];
        let js = jugadas_de(&tl, 3, None);
        let m = muertes_de(&js);
        assert!(precio.wpa_objective < 0.0);
        assert_eq!(m[0].cargo(ANTES_DE_OBJETIVO), Some(-precio.wpa_objective));
        assert!((m[0].lost + precio.wpa_death + precio.wpa_objective).abs() < 1e-12);
        assert_eq!(m[0].objective.as_deref(), Some("dragon"));
        assert!(objetivos_de(&js).is_empty(), "tu muerte ya pagó ese dragón");
    }

    #[test]
    fn ausente_del_objetivo_si_estabas_lejos() {
        // Todos en el foso menos el medio (3), arriba a la izquierda.
        let mut tl = partida(20, vec![dragon(630_000, 200)]);
        colocar(&mut tl, |pid, _| if pid == 3 { LEJOS } else { FOSO_DRAGON });
        let valor = valor_del_dragon(&tl);
        let js = jugadas_de(&tl, 3, None);
        let o = objetivos_de(&js);
        assert_eq!(o.len(), 1);
        assert_eq!(o[0].state.as_deref(), Some("far"));
        assert_eq!(o[0].objective.as_deref(), Some("dragon"));
        assert!((o[0].cargo(AUSENTE).unwrap() - valor).abs() < 1e-12, "faltaba solo él: lo paga entero");

        // Quien estaba en el foso no paga nada.
        assert!(objetivos_de(&jugadas_de(&tl, 4, None)).is_empty());
        // Un dragón tuyo no es una ausencia.
        let mut propio = partida(20, vec![dragon(630_000, 100)]);
        colocar(&mut propio, |pid, _| if pid == 3 { LEJOS } else { FOSO_DRAGON });
        assert!(objetivos_de(&jugadas_de(&propio, 3, None)).is_empty());
    }

    #[test]
    fn un_objetivo_se_reparte_entre_los_que_faltaban() {
        let mut tl = partida(20, vec![dragon(630_000, 200)]);
        colocar(&mut tl, |pid, _| if pid == 3 || pid == 1 { LEJOS } else { FOSO_DRAGON });
        let valor = valor_del_dragon(&tl);
        for pid in [1, 3] {
            let js = jugadas_de(&tl, pid, None);
            assert!((objetivos_de(&js)[0].lost - valor / 2.0).abs() < 1e-12);
        }
    }

    #[test]
    fn ausente_en_base_por_las_compras_o_por_la_fuente() {
        // Comprando a los 10:25 y 10:28: en base aunque el minuto diga foso.
        let mut tl = partida(20, vec![compra(625_000, 3), compra(628_000, 3), dragon(630_000, 200)]);
        colocar(&mut tl, |_, _| FOSO_DRAGON);
        assert_eq!(objetivos_de(&jugadas_de(&tl, 3, None))[0].state.as_deref(), Some("base"));

        // En la fuente en los dos minutos de alrededor.
        let mut tl = partida(20, vec![dragon(630_000, 200)]);
        colocar(&mut tl, |pid, _| if pid == 3 { fuente(3) } else { FOSO_DRAGON });
        assert_eq!(objetivos_de(&jugadas_de(&tl, 3, None))[0].state.as_deref(), Some("base"));
    }

    /// Muerto en el objetivo por una muerte de hace más de un minuto: ausente.
    /// La de dentro del minuto ya la cubre «antes de objetivo».
    #[test]
    fn ausente_si_seguias_muerto() {
        let (muerte, objetivo) = (2_640_000, 2_702_000);
        let timer = crate::attribution::death_timer(18, muerte as f64 / 60_000.0);
        assert!(
            timer > (objetivo - muerte) as f64 / 1000.0 && objetivo - muerte > 60_000,
            "la prueba necesita seguir muerto pasado el minuto ({timer} s)"
        );
        let mut tl = partida(50, vec![kill(muerte, 8, 3, &[], MID.0, MID.1), dragon(objetivo, 200)]);
        colocar(&mut tl, |_, _| FOSO_DRAGON);
        for f in tl.info.frames.iter_mut() {
            f.participantFrames.get_mut("3").unwrap().level = 18;
        }
        let js = jugadas_de(&tl, 3, None);
        assert_eq!(objetivos_de(&js)[0].state.as_deref(), Some("dead"));
        assert!(muertes_de(&js)[0].cargo(ANTES_DE_OBJETIVO).is_none(), "fuera de la ventana de 60 s");
    }

    /// Con el rastro del vídeo manda tu posición de verdad, no la del minuto.
    #[test]
    fn el_rastro_del_video_manda_sobre_el_minuto() {
        let mut tl = partida(20, vec![dragon(630_000, 200)]);
        colocar(&mut tl, |pid, _| if pid == 3 { LEJOS } else { FOSO_DRAGON });
        let en_foso = [Fix { sec: 629.5, x: FOSO_DRAGON.0 as f64 + 800.0, y: FOSO_DRAGON.1 as f64, anchored: false }];
        assert!(objetivos_de(&jugadas_de(&tl, 3, Some(&en_foso))).is_empty());

        let mut tl = partida(20, vec![dragon(630_000, 200)]);
        colocar(&mut tl, |_, _| FOSO_DRAGON);
        let lejos = [Fix { sec: 630.5, x: LEJOS.0 as f64, y: LEJOS.1 as f64, anchored: false }];
        assert_eq!(objetivos_de(&jugadas_de(&tl, 3, Some(&lejos)))[0].state.as_deref(), Some("far"));
        // Una muestra a más de 2 s no vale: se vuelve al minuto (en el foso).
        let vieja = [Fix { sec: 620.0, x: LEJOS.0 as f64, y: LEJOS.1 as f64, anchored: false }];
        assert!(objetivos_de(&jugadas_de(&tl, 3, Some(&vieja))).is_empty());
    }

    /// Diez jugadores con el oro de un equipo creciendo 60 por minuto y cabeza.
    fn con_ventaja(eventos: Vec<serde_json::Value>, delante: i32) -> TimelineDto {
        let mut tl = partida(30, eventos);
        for (m, f) in tl.info.frames.iter_mut().enumerate() {
            for (k, pf) in f.participantFrames.iter_mut() {
                let pid: i32 = k.parse().unwrap();
                let equipo = if pid <= 5 { 100 } else { 200 };
                if equipo == delante {
                    pf.totalGold = 500 + 60 * m as i32;
                }
            }
        }
        tl
    }

    #[test]
    fn tirada_es_morir_con_la_partida_de_cara() {
        let muerte = |v| kill(1_200_000, 8, v, &[], MID.0, MID.1);
        let tl = con_ventaja(vec![muerte(3)], 100);
        let ps = diez();
        let antes = crate::winprob::plays(&tl, &ps)[0].before;
        assert!(1.0 - antes >= UMBRAL_TIRADA, "la prueba necesita al 100 por delante ({:.2})", 1.0 - antes);
        let m = jugadas_de(&tl, 3, None);
        let m = muertes_de(&m);
        assert_eq!(m[0].cargo(TIRADA), Some(m[0].lost));

        // Por detrás no se tira nada.
        let tl = con_ventaja(vec![muerte(3)], 200);
        assert!(muertes_de(&jugadas_de(&tl, 3, None))[0].cargo(TIRADA).is_none());
    }

    #[test]
    fn sin_mirar_se_compara_con_tu_tasa_de_siempre() {
        // Miradas cada 5 s de vídeo salvo un hueco entre 290 y 320. Con 10 s
        // de desfase, a ciegas los instantes de partida 291-309.
        let off = 10.0;
        let miradas: Vec<f64> = (0..=400).map(|i| i as f64 * 5.0).filter(|t| *t <= 290.0 || *t >= 320.0).collect();
        let mut js = vec![
            Jugada { time: 300.0, kind: "death".into(), lost: 0.05, ..Default::default() },
            Jugada { time: 600.0, kind: "death".into(), lost: 0.03, ..Default::default() },
        ];
        // Muerto entre 600 y 620: esos instantes no cuentan.
        let tasas = con_video(&mut js, 1500.0, &miradas, Some(off), &[], |s| !(600.0..620.0).contains(&s));
        let tasa = tasas[muertes::SIN_MIRAR];
        let esperada = 19.0 / (420.0 - SIN_MIRAR_DESDE);
        assert!((tasa[0].unwrap() - esperada).abs() < 1e-9, "{:?}", tasa[0]);
        assert_eq!(tasa[1], Some(0.0));
        assert_eq!(js[0].cargo(muertes::SIN_MIRAR), Some(0.05));
        assert_eq!(js[1].cargo(muertes::SIN_MIRAR), None);
        assert_eq!(js[0].expected, vec![(muertes::SIN_MIRAR.to_string(), tasa[0].unwrap())]);
        assert!(!tasas.contains_key(muertes::DESDE_NIEBLA), "sin peleas leídas no hay niebla");

        // Sin miradas grabadas no se dice nada.
        let mut js2 = js.clone();
        js2.iter_mut().for_each(|j| j.charges.clear());
        assert!(con_video(&mut js2, 1500.0, &[], Some(off), &[], |_| true).is_empty());
        assert!(js2.iter().all(|j| j.charges.is_empty()));
    }

    #[test]
    fn la_niebla_se_compara_con_tus_peleas() {
        // (t_game, died, from_fog). Tramo 0: 2 de 3 desde la niebla; tramo 1: 0 de 1.
        let aperturas = [(100.0, false, true), (200.0, false, false), (290.0, true, true), (500.0, true, false)];
        let muerte = |t| Jugada { time: t, kind: "death".into(), lost: 0.04, ..Default::default() };
        let mut js = vec![muerte(296.0), muerte(505.0), muerte(1000.0)];
        let tasas = con_video(&mut js, 1500.0, &[], None, &aperturas, |_| true);
        let tasa = tasas[muertes::DESDE_NIEBLA];
        assert_eq!(tasa[0], Some(2.0 / 3.0));
        assert_eq!(tasa[1], Some(0.0));
        assert_eq!(tasa[3], Some(0.5), "un tramo sin peleas usa la tasa de la partida");
        assert_eq!(js[0].cargo(muertes::DESDE_NIEBLA), Some(0.04));
        assert_eq!(js[1].cargo(muertes::DESDE_NIEBLA), None);
        assert_eq!(js[1].expected, vec![(muertes::DESDE_NIEBLA.to_string(), 0.0)]);
        assert!(js[2].expected.is_empty(), "sin la pelea leída no cuenta ni para tu media");
    }

    #[test]
    fn el_wpa_por_tramo_suma_el_de_la_partida() {
        let tl = partida(
            35,
            vec![
                kill(300_000, 7, 3, &[8], MID.0, MID.1),
                dragon(630_000, 200),
                kill(1_000_000, 3, 8, &[2], MID.0, MID.1),
                kill(1_900_000, 0, 1, &[], MID.0, MID.1),
            ],
        );
        let ps = diez();
        let plays = crate::winprob::plays(&tl, &ps);
        let an = Analisis::new(&tl, &ps, &plays);
        let total = crate::winprob::per_player(&plays);
        for pid in 1..=10 {
            let suma: f64 = an.wpa_por_tramo(pid).iter().sum();
            assert!((suma - total.get(&pid).copied().unwrap_or(0.0)).abs() < 1e-12, "{pid}");
        }
    }

    /// Diez partidas iguales con una muerte a ciegas en el 5:00, y tu tasa de
    /// siempre a la mitad: pierdes el doble de lo que dice tu media.
    fn partida_a_ciegas(i: usize) -> PartidaCoach {
        let mut tasa = HashMap::new();
        tasa.insert(muertes::SIN_MIRAR.to_string(), [Some(0.5); TRAMOS]);
        PartidaCoach {
            match_id: format!("m{i}"),
            role: "MIDDLE".into(),
            duration: 1500.0,
            video_offset: Some(30.0),
            plays: vec![Jugada {
                time: 300.0 + i as f64,
                kind: "death".into(),
                lost: 0.1 + i as f64 / 1000.0,
                charges: vec![(muertes::SIN_MIRAR.into(), 0.1 + i as f64 / 1000.0)],
                expected: vec![(muertes::SIN_MIRAR.into(), 0.5)],
                ..Default::default()
            }],
            own_rate: tasa,
            ..Default::default()
        }
    }

    #[test]
    fn el_foco_es_lo_que_mas_pierdes_por_encima_del_baremo() {
        let partidas: Vec<PartidaCoach> = (0..FOCO_MIN_PARTIDAS).map(partida_a_ciegas).collect();
        let r = resumen(&partidas);
        let f = r.focus.expect("con diez partidas hay foco");
        assert_eq!((f.category.as_str(), f.tramo), (muertes::SIN_MIRAR, Some(0)));
        assert_eq!(f.baseline.as_deref(), Some("own"));
        assert_eq!(f.games, FOCO_MIN_PARTIDAS);
        assert!((f.excess.unwrap() - f.user / 2.0).abs() < 1e-12);
        assert_eq!((f.rate_deaths, f.rate_any), (Some(1.0), Some(0.5)), "el lift es 2");
        // Las cinco peores, de la más cara a la más barata, con su segundo de vídeo.
        assert_eq!(f.worst.len(), 5);
        assert_eq!(f.worst[0].match_id, "m9");
        assert_eq!(f.worst[0].video_time, Some(309.0 + 30.0));
        assert!(f.worst.windows(2).all(|w| w[0].lost >= w[1].lost));

        let pocas = resumen(&partidas[..FOCO_MIN_PARTIDAS - 1]);
        assert!(pocas.focus.is_none(), "con nueve partidas no hay muestra");
        assert!(pocas.rows.iter().any(|f| f.category == muertes::SIN_MIRAR && f.excess.is_some_and(|e| e > 0.0)));
    }

    /// Una partida sin las miradas grabadas no entra en la media de «sin
    /// mirar», ni con cero.
    #[test]
    fn una_categoria_de_video_sin_datos_no_cuenta() {
        let mut partidas: Vec<PartidaCoach> = (0..3).map(partida_a_ciegas).collect();
        let mut sin = partida_a_ciegas(3);
        sin.own_rate.clear();
        partidas.push(sin);
        let f = resumen(&partidas).rows.into_iter().find(|f| f.category == muertes::SIN_MIRAR && f.tramo == Some(0)).unwrap();
        assert_eq!(f.games, 3);
    }

    /// Si al leer la caché se perdiera un campo, la segunda vez el coach diría
    /// otra cosa. `serde_json` no garantiza releer el último bit de un f64
    /// (igual que en `jugadas`), así que se compara con tolerancia.
    #[test]
    fn la_cache_devuelve_lo_mismo_que_se_calculo() {
        let mut antes = partida_a_ciegas(4);
        antes.band = Some("alto".into());
        antes.plays[0].killer = Some("Zed".into());
        antes.wpa_tramo = [0.01, -0.02, 0.0, 0.03, 0.0];
        let despues: PartidaCoach = serde_json::from_str(&serde_json::to_string(&antes).unwrap()).unwrap();
        let cerca = |a: f64, b: f64| (a - b).abs() < 1e-12;
        assert_eq!((&despues.match_id, &despues.band, &despues.role), (&antes.match_id, &antes.band, &antes.role));
        assert_eq!(despues.own_rate, antes.own_rate);
        assert!(antes.wpa_tramo.iter().zip(despues.wpa_tramo.iter()).all(|(a, b)| cerca(*a, *b)));
        let (a, b) = (&antes.plays[0], &despues.plays[0]);
        assert_eq!((&a.kind, &a.killer, a.charges.len(), a.expected.len()), (&b.kind, &b.killer, b.charges.len(), b.expected.len()));
        assert!(cerca(a.time, b.time) && cerca(a.lost, b.lost) && cerca(a.charges[0].1, b.charges[0].1));
    }

    #[test]
    fn el_percentil_por_tramo_es_monotono() {
        for rol in ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"] {
            for t in 0..TRAMOS {
                let mut antes = -1.0;
                for paso in -30..=30 {
                    let Some(p) = percentil_tramo(Some("alto"), rol, t, paso as f64 / 200.0) else { continue };
                    assert!((0.0..=100.0).contains(&p), "{rol}/{t}: {p}");
                    assert!(p >= antes - 1e-9, "{rol}/{t}: baja al subir el WPA");
                    antes = p;
                }
            }
        }
    }

    // -------------------------------------------------------- datos reales

    fn pts(x: f64) -> String {
        format!("{:+.1}", 100.0 * x)
    }

    const NOMBRE_TRAMO: [&str; TRAMOS] = ["0-7", "7-14", "14-21", "21-28", "28+"];

    /// Categorías, baremos y foco sobre tus partidas grabadas. Sólo lee: no
    /// escribe la caché en la biblioteca.
    ///
    /// `LR_REAL=1 cargo test --lib coach::tests::coach_en_mis_partidas -- --nocapture`
    #[test]
    fn coach_en_mis_partidas() {
        if std::env::var("LR_REAL").is_err() {
            return;
        }
        let mut partidas = Vec::new();
        // Lo que te cobra «ausente» con tu rastro del vídeo y con el minuto de
        // la API: el baremo del corpus se midió con el minuto.
        let (mut con_video, mut con_minuto) = (0.0, 0.0);
        for meta in crate::storage::load_all_matches() {
            if meta.is_vod || meta.riot_match_id.is_none() {
                continue;
            }
            let t0 = std::time::Instant::now();
            let Some(p) = analizar(&meta) else { continue };
            let muertes: Vec<&Jugada> = p.plays.iter().filter(|j| j.kind == "death").collect();

            // Las muertes valen lo mismo que en «Tus muertes».
            let m: crate::riot_api::MatchDto =
                serde_json::from_str(&crate::storage::load_raw_match(&meta.id).unwrap()).unwrap();
            let tl: TimelineDto = serde_json::from_str(&crate::storage::load_raw_timeline(&meta.id).unwrap()).unwrap();
            let yo = meta.participants.iter().position(|q| q.is_self).unwrap() as i32 + 1;
            let fila = crate::attribution::analyze(&tl, &m.info.participants).into_iter().find(|c| c.participant_id == yo).unwrap();
            let precio: f64 = fila.deaths_detail.iter().map(|d| -d.wpa).sum();
            let nuestro: f64 = muertes.iter().map(|j| j.lost).sum();
            assert!((precio - nuestro).abs() < 1e-9, "{}: {precio} frente a {nuestro}", meta.id);
            assert!(p.plays.iter().all(|j| j.lost >= 0.0 && j.charges.iter().all(|(_, v)| *v >= 0.0)));
            let plays = crate::winprob::plays(&tl, &m.info.participants);
            let an = Analisis::new(&tl, &m.info.participants, &plays);
            con_minuto += an.jugadas(yo, None).iter().filter_map(|j| j.cargo(AUSENTE)).sum::<f64>();
            con_video += p.plays.iter().filter_map(|j| j.cargo(AUSENTE)).sum::<f64>();

            let cats = por_tramo(&p.plays);
            let mut linea: Vec<String> = CATEGORIAS
                .iter()
                .filter_map(|c| cats.get(*c).map(|v| format!("{c} {:.1}", 100.0 * v.iter().sum::<f64>())))
                .collect();
            linea.sort();
            println!(
                "{} {:9} {:7} {:5} pos:{:6} {}m · {} muertes · {} objetivos sin ti · {:?}\n      {}",
                meta.id,
                p.champion,
                p.role,
                p.band.as_deref().unwrap_or("?"),
                p.positions,
                (p.duration / 60.0) as i64,
                muertes.len(),
                p.plays.len() - muertes.len(),
                t0.elapsed(),
                linea.join(" · ")
            );
            partidas.push(p);
        }
        if partidas.is_empty() {
            return;
        }
        let r = resumen(&partidas);
        println!(
            "\n{} partidas · franja {:?} (uniforme: {}) · ausente con el vídeo {:.1} pts por partida, con el minuto {:.1}",
            r.games,
            r.band,
            r.band_uniform,
            100.0 * con_video / r.games as f64,
            100.0 * con_minuto / r.games as f64
        );
        println!("pérdida por partida en pts de victoria; exceso positivo = pierdes más que el baremo\n");
        println!("{:18} {:6} {:>5} {:>6} {:>7} {:>7} {:>7}  baremo  lift", "categoría", "tramo", "part.", "jug.", "tú", "baremo", "exceso");
        for f in &r.rows {
            let lift = match (f.rate_deaths, f.rate_any) {
                (Some(a), Some(b)) if b > 0.0 => format!("{:.0}% vs {:.0}% = {:.2}", 100.0 * a, 100.0 * b, a / b),
                _ => String::new(),
            };
            println!(
                "{:18} {:6} {:>5} {:>6} {:>7} {:>7} {:>7}  {:6}  {}",
                f.category,
                f.tramo.map(|t| NOMBRE_TRAMO[t]).unwrap_or("todo"),
                f.games,
                f.plays,
                format!("{:.1}", 100.0 * f.user),
                f.base.map(|b| format!("{:.1}", 100.0 * b)).unwrap_or_default(),
                f.excess.map(pts).unwrap_or_default(),
                f.baseline.as_deref().unwrap_or("-"),
                lift
            );
        }
        println!("\nnota por tramo:");
        for n in &r.tramos {
            println!(
                "  {:6} {:2} partidas · WPA {} · percentil {}",
                NOMBRE_TRAMO[n.tramo],
                n.games,
                pts(n.wpa),
                n.percentile.map(|p| format!("{p:.0}")).unwrap_or("-".into())
            );
        }
        match &r.focus {
            None => println!("\nsin foco"),
            Some(f) => {
                println!(
                    "\nFOCO: {} en {} · {} partidas · te cuesta {:.1} pts por partida, el baremo {:.1} ({})",
                    f.category,
                    NOMBRE_TRAMO[f.tramo.unwrap()],
                    f.games,
                    100.0 * f.user,
                    100.0 * f.base.unwrap(),
                    f.baseline.as_deref().unwrap()
                );
                for w in &f.worst {
                    println!(
                        "  {} {} {:02}:{:02} {} {} {}",
                        pts(-w.lost),
                        w.match_id,
                        (w.time / 60.0) as i64,
                        (w.time % 60.0) as i64,
                        w.killer.as_deref().unwrap_or(""),
                        w.objective.as_deref().unwrap_or(""),
                        w.video_time.map(|v| format!("vídeo {v:.0}s")).unwrap_or_default()
                    );
                }
            }
        }
    }

    fn cuantiles(v: &mut [f64]) -> String {
        if v.is_empty() {
            return "sin datos".into();
        }
        v.sort_by(f64::total_cmp);
        let q = |p: f64| v[((v.len() - 1) as f64 * p) as usize];
        format!("n={} p50 {:.0} p75 {:.0} p90 {:.0} p95 {:.0}", v.len(), q(0.5), q(0.75), q(0.9), q(0.95))
    }

    /// Cerca del foso estaban quienes remataron o asistieron el objetivo. Su
    /// distancia al foso según tu rastro del vídeo (y según el minuto, para
    /// comparar) da el radio de «estabas ahí».
    ///
    /// `LR_REAL=1 cargo test --lib coach::tests::radio_del_foso_en_mis_partidas -- --nocapture`
    #[test]
    fn radio_del_foso_en_mis_partidas() {
        if std::env::var("LR_REAL").is_err() {
            return;
        }
        let (mut video, mut minuto, mut minuto_ausentes) = (Vec::new(), Vec::new(), Vec::new());
        for meta in crate::storage::load_all_matches() {
            if meta.is_vod || meta.riot_match_id.is_none() {
                continue;
            }
            let Some(yo) = meta.participants.iter().position(|q| q.is_self).map(|i| i as i32 + 1) else { continue };
            let (Some(raw), Some(rtl)) = (crate::storage::load_raw_match(&meta.id), crate::storage::load_raw_timeline(&meta.id)) else {
                continue;
            };
            let m: crate::riot_api::MatchDto = serde_json::from_str(&raw).unwrap();
            let tl: TimelineDto = serde_json::from_str(&rtl).unwrap();
            let Some(pos) = crate::minimap::Positions::load(&meta.id).filter(|p| p.self_participant_id == yo) else { continue };
            let anclas = crate::minimap::anclas_de(&tl, yo);
            let pista = pos.follow(&anclas);
            let mi_equipo = m.info.participants[(yo - 1) as usize].teamId;
            for ev in tl.info.frames.iter().flat_map(|f| f.events.iter()) {
                let (true, Some(p)) = (ev.event_type == "ELITE_MONSTER_KILL", ev.position.as_ref()) else { continue };
                let sec = ev.timestamp as f64 / 1000.0;
                let estuvo = ev.killerId == yo || ev.assistingParticipantIds.contains(&yo);
                let d = |(x, y): (f64, f64)| (x - p.x as f64).hypot(y - p.y as f64);
                if estuvo {
                    if let Some(q) = en_pista(&pista, sec) {
                        video.push(d(q));
                    }
                    if let Some(q) = crate::minimap::interpolar(&anclas, sec) {
                        minuto.push(d(q));
                    }
                } else if ev.killerTeamId != mi_equipo {
                    if let Some(q) = en_pista(&pista, sec) {
                        minuto_ausentes.push(d(q));
                    }
                }
            }
        }
        println!("objetivos en los que estabas, distancia al foso:");
        println!("  con tu rastro del vídeo: {}", cuantiles(&mut video));
        println!("  con el minuto de la API: {}", cuantiles(&mut minuto));
        println!("objetivos rivales, con tu rastro: {}", cuantiles(&mut minuto_ausentes));
        for r in [1500.0, 2000.0, 2500.0, 3000.0, 3500.0] {
            let fuera = minuto_ausentes.iter().filter(|d| **d > r).count();
            println!("  a más de {r}: {fuera} de {}", minuto_ausentes.len());
        }
    }

    /// Sin vídeo, ¿qué estimador por minuto acierta más «estabas o no»? La
    /// verdad es tu rastro del vídeo (lejos = a más de [`RADIO_FOSO_VIDEO`]),
    /// en todos los objetivos épicos con los dos datos y tú vivo.
    ///
    /// `LR_REAL=1 cargo test --lib coach::tests::estimador_por_minuto_en_mis_partidas -- --nocapture`
    #[test]
    fn estimador_por_minuto_en_mis_partidas() {
        if std::env::var("LR_REAL").is_err() {
            return;
        }
        // (verdad: lejos, interpolada, la más cercana de los dos minutos, el minuto más próximo)
        let mut casos: Vec<(bool, f64, f64, f64)> = Vec::new();
        for meta in crate::storage::load_all_matches() {
            if meta.is_vod || meta.riot_match_id.is_none() {
                continue;
            }
            let Some(yo) = meta.participants.iter().position(|q| q.is_self).map(|i| i as i32 + 1) else { continue };
            let Some(rtl) = crate::storage::load_raw_timeline(&meta.id) else { continue };
            let tl: TimelineDto = serde_json::from_str(&rtl).unwrap();
            let Some(pos) = crate::minimap::Positions::load(&meta.id).filter(|p| p.self_participant_id == yo) else { continue };
            let anclas = crate::minimap::anclas_de(&tl, yo);
            let pista = pos.follow(&anclas);
            let vivos = Vivos::build(&tl);
            for ev in tl.info.frames.iter().flat_map(|f| f.events.iter()) {
                let (true, Some(p)) = (ev.event_type == "ELITE_MONSTER_KILL", ev.position.as_ref()) else { continue };
                let sec = ev.timestamp as f64 / 1000.0;
                if !vivos.alive(yo, sec) {
                    continue;
                }
                let d = |(x, y): (f64, f64)| (x - p.x as f64).hypot(y - p.y as f64);
                let (Some(v), Some(i)) = (en_pista(&pista, sec), crate::minimap::interpolar(&anclas, sec)) else { continue };
                let antes = anclas.iter().rev().find(|a| a.0 <= sec);
                let despues = anclas.iter().find(|a| a.0 >= sec);
                let (Some(a), Some(b)) = (antes, despues) else { continue };
                let (da, db) = (d((a.1, a.2)), d((b.1, b.2)));
                let proximo = if sec - a.0 <= b.0 - sec { da } else { db };
                casos.push((d(v) > RADIO_FOSO_VIDEO, d(i), da.min(db), proximo));
            }
        }
        let lejos = casos.iter().filter(|c| c.0).count();
        println!("{} objetivos contigo vivo; lejos según el vídeo: {lejos}", casos.len());
        for (nombre, k) in [("interpolada", 1usize), ("el minuto más cerca del foso", 2), ("el minuto más próximo", 3)] {
            for r in [2000.0, 2500.0, 3000.0, 3500.0, 4000.0, 5000.0] {
                let est = |c: &(bool, f64, f64, f64)| [c.1, c.2, c.3][k - 1] > r;
                let acierto = casos.iter().filter(|c| est(c) == c.0).count();
                let falso_lejos = casos.iter().filter(|c| est(c) && !c.0).count();
                let falso_cerca = casos.iter().filter(|c| !est(c) && c.0).count();
                println!(
                    "  {nombre:30} radio {r:4}: acierta {:.0}% · da lejos a {falso_lejos} que estaban · da cerca a {falso_cerca} que no",
                    100.0 * acierto as f64 / casos.len().max(1) as f64
                );
            }
        }
    }

    // -------------------------------------------------------------- corpus

    /// Los ficheros del corpus, en orden, uno de cada `paso`.
    fn ficheros_del_corpus(corpus: &str, paso: usize) -> Vec<std::path::PathBuf> {
        let mut v: Vec<std::path::PathBuf> = std::fs::read_dir(format!("{corpus}/partidas"))
            .into_iter()
            .flatten()
            .flatten()
            .flat_map(|d| std::fs::read_dir(d.path()).into_iter().flatten().flatten().map(|f| f.path()))
            .collect();
        v.sort();
        v.into_iter().step_by(paso.max(1)).collect()
    }

    fn leer_del_corpus(f: &std::path::Path) -> Option<(String, Vec<ParticipantDto>, TimelineDto)> {
        use std::io::Read;
        let id = f.file_name()?.to_str()?.strip_suffix(".json.gz")?.to_string();
        let bytes = std::fs::read(f).ok()?;
        let mut texto = String::new();
        flate2::read::GzDecoder::new(&bytes[..]).read_to_string(&mut texto).ok()?;
        let mut d: serde_json::Value = serde_json::from_str(&texto).ok()?;
        let ps = serde_json::from_value(d["match"]["info"]["participants"].take()).ok()?;
        let tl = serde_json::from_value(d["timeline"].take()).ok()?;
        Some((id, ps, tl))
    }

    /// El radio de «estabas en el foso» con la posición por minuto: la
    /// distancia de quienes remataron o asistieron. Una de cada diez partidas.
    ///
    /// `CORPUS_DIR=D:/lol-corpus cargo test --release --lib coach::tests::radio_del_foso_en_el_corpus -- --nocapture`
    #[test]
    fn radio_del_foso_en_el_corpus() {
        let Ok(corpus) = std::env::var("CORPUS_DIR") else { return };
        let (mut estuvo, mut no) = (Vec::new(), Vec::new());
        let mut partidas = 0;
        for f in ficheros_del_corpus(&corpus, 10) {
            let Some((_, ps, tl)) = leer_del_corpus(&f) else { continue };
            partidas += 1;
            let anclas: Vec<_> = (1..=10).map(|pid| crate::minimap::anclas_de(&tl, pid)).collect();
            let vivos = Vivos::build(&tl);
            for ev in tl.info.frames.iter().flat_map(|f| f.events.iter()) {
                let (true, Some(p)) = (ev.event_type == "ELITE_MONSTER_KILL", ev.position.as_ref()) else { continue };
                let sec = ev.timestamp as f64 / 1000.0;
                for pid in 1..=10 {
                    if ps.get((pid - 1) as usize).map(|q| q.teamId) != Some(ev.killerTeamId) || !vivos.alive(pid, sec) {
                        continue;
                    }
                    let Some((x, y)) = crate::minimap::interpolar(&anclas[(pid - 1) as usize], sec) else { continue };
                    let d = (x - p.x as f64).hypot(y - p.y as f64);
                    if ev.killerId == pid || ev.assistingParticipantIds.contains(&pid) { estuvo.push(d) } else { no.push(d) }
                }
            }
        }
        println!("{partidas} partidas");
        println!("remataron o asistieron: {}", cuantiles(&mut estuvo));
        println!("su equipo, vivos y sin asistir: {}", cuantiles(&mut no));
        for r in [2500.0, 3000.0, 3500.0, 4000.0] {
            let a = estuvo.iter().filter(|d| **d > r).count() as f64 / estuvo.len().max(1) as f64;
            let b = no.iter().filter(|d| **d > r).count() as f64 / no.len().max(1) as f64;
            println!("  radio {r}: fuera el {:.1}% de los que estaban y el {:.1}% de los que no", 100.0 * a, 100.0 * b);
        }
    }

    #[derive(Default)]
    struct Acumulado {
        partidas: usize,
        /// (franja, rol, categoría) → suma por tramo.
        suma: HashMap<(String, String, String), [f64; TRAMOS]>,
        /// (franja, rol) → jugadores que llegaron a cada tramo.
        n: HashMap<(String, String), [u32; TRAMOS]>,
        wpa: HashMap<(String, String), [Vec<f64>; TRAMOS]>,
        /// Muertes, y cuántas en cada categoría (para ver que marcan algo).
        muertes: usize,
        por_cat: HashMap<String, usize>,
        /// Objetivos rivales cobrados como ausencia, por estado.
        ausencias: HashMap<String, usize>,
    }

    impl Acumulado {
        fn sumar(&mut self, otro: Acumulado) {
            self.partidas += otro.partidas;
            self.muertes += otro.muertes;
            for (k, v) in otro.suma {
                let e = self.suma.entry(k).or_default();
                (0..TRAMOS).for_each(|t| e[t] += v[t]);
            }
            for (k, v) in otro.n {
                let e = self.n.entry(k).or_default();
                (0..TRAMOS).for_each(|t| e[t] += v[t]);
            }
            for (k, v) in otro.wpa {
                let e = self.wpa.entry(k).or_default();
                for (t, w) in v.into_iter().enumerate() {
                    e[t].extend(w);
                }
            }
            for (k, v) in otro.por_cat {
                *self.por_cat.entry(k).or_default() += v;
            }
            for (k, v) in otro.ausencias {
                *self.ausencias.entry(k).or_default() += v;
            }
        }

        fn partida(&mut self, ps: &[ParticipantDto], tl: &TimelineDto, franja: Option<&str>) {
            let plays = crate::winprob::plays(tl, ps);
            let an = Analisis::new(tl, ps, &plays);
            self.partidas += 1;
            for pid in 1..=10 {
                let Some(rol) = an.rol(pid).map(str::to_string) else { continue };
                if !crate::baselines::ROLES.contains(&rol.as_str()) {
                    continue;
                }
                let js = an.jugadas(pid, None);
                let cats = por_tramo(&js);
                let wpa = an.wpa_por_tramo(pid);
                for j in &js {
                    if j.kind == "death" {
                        self.muertes += 1;
                        for (c, _) in &j.charges {
                            *self.por_cat.entry(c.clone()).or_default() += 1;
                        }
                    } else {
                        *self.ausencias.entry(j.state.clone().unwrap_or_default()).or_default() += 1;
                    }
                }
                for b in [Some(""), franja].into_iter().flatten() {
                    let n = self.n.entry((b.into(), rol.clone())).or_default();
                    let w = self.wpa.entry((b.into(), rol.clone())).or_default();
                    for t in (0..TRAMOS).filter(|t| llega(an.duracion, *t)) {
                        n[t] += 1;
                        w[t].push(wpa[t]);
                    }
                    for cat in CATEGORIAS.iter().filter(|c| !de_video(c)) {
                        let s = self.suma.entry((b.into(), rol.clone(), cat.to_string())).or_default();
                        if let Some(v) = cats.get(*cat) {
                            for t in (0..TRAMOS).filter(|t| llega(an.duracion, *t)) {
                                s[t] += v[t];
                            }
                        }
                    }
                }
            }
        }
    }

    const FRANJAS: [&str; 4] = ["", "bajo", "medio", "alto"];

    fn deciles(v: &mut [f64]) -> [f64; 9] {
        v.sort_by(f64::total_cmp);
        std::array::from_fn(|q| v.get(v.len() * (q + 1) / 10).copied().unwrap_or(0.0))
    }

    fn generar(a: &mut Acumulado, corpus: &str) -> String {
        let roles = crate::baselines::ROLES;
        let mut s = String::new();
        s.push_str(&format!(
            "//! Baremos del coach (`crate::coach`): lo que pierde cada rol, en cada franja\n\
             //! de rango y en cada tramo, por categoría; y los deciles de su WPA por tramo.\n\
             //!\n\
             //! GENERADO por `coach::tests::baremos_del_coach` sobre `{corpus}`\n\
             //! ({} partidas). No editar a mano: con `COACH_ESCRIBIR=1` el test lo reescribe,\n\
             //! y sin él comprueba que sigue cuadrando con el corpus.\n\
             //!\n\
             //!     CORPUS_DIR=D:/lol-corpus COACH_ESCRIBIR=1 cargo test --release --lib coach::tests::baremos_del_coach -- --nocapture\n\
             //!\n\
             //! La franja \"\" es el corpus entero, con y sin rango conocido.\n\n",
            a.partidas
        ));
        s.push_str("/// (franja, rol, categoría) → pérdida media por partida en cada tramo, en\n/// probabilidad de victoria (0-1), sobre las partidas que llegaron al tramo.\n");
        s.push_str("pub(crate) const PERDIDA: &[(&str, &str, &str, [f64; 5])] = &[\n");
        for b in FRANJAS {
            for r in roles {
                let n = a.n.get(&(b.into(), r.into())).copied().unwrap_or_default();
                for cat in CATEGORIAS.iter().filter(|c| !de_video(c)) {
                    let suma = a.suma.get(&(b.into(), r.into(), cat.to_string())).copied().unwrap_or_default();
                    let v: Vec<String> =
                        (0..TRAMOS).map(|t| format!("{:.5}", if n[t] > 0 { suma[t] / n[t] as f64 } else { 0.0 })).collect();
                    s.push_str(&format!("    (\"{b}\", \"{r}\", \"{cat}\", [{}]),\n", v.join(", ")));
                }
            }
        }
        s.push_str("];\n\n/// (franja, rol) → jugadores que llegaron a cada tramo.\npub(crate) const MUESTRA: &[(&str, &str, [u32; 5])] = &[\n");
        for b in FRANJAS {
            for r in roles {
                let n = a.n.get(&(b.into(), r.into())).copied().unwrap_or_default();
                let v: Vec<String> = n.iter().map(|x| x.to_string()).collect();
                s.push_str(&format!("    (\"{b}\", \"{r}\", [{}]),\n", v.join(", ")));
            }
        }
        s.push_str("];\n\n/// (franja, rol) → deciles (10 % … 90 %) de su WPA en cada tramo.\npub(crate) const WPA_DECILES: &[(&str, &str, [[f64; 9]; 5])] = &[\n");
        for b in FRANJAS {
            for r in roles {
                let Some(w) = a.wpa.get_mut(&(b.into(), r.into())) else { continue };
                let filas: Vec<String> = w
                    .iter_mut()
                    .map(|v| format!("[{}]", deciles(v).iter().map(|x| format!("{x:.4}")).collect::<Vec<_>>().join(", ")))
                    .collect();
                s.push_str(&format!("    (\"{b}\", \"{r}\", [\n        {},\n    ]),\n", filas.join(",\n        ")));
            }
        }
        s.push_str("];\n");
        s
    }

    /// Mide las categorías sobre el corpus y genera `coach_baremos.rs`, o
    /// comprueba que el compilado siga cuadrando.
    ///
    /// `CORPUS_DIR=D:/lol-corpus [COACH_ESCRIBIR=1] cargo test --release --lib coach::tests::baremos_del_coach -- --nocapture`
    #[test]
    fn baremos_del_coach() {
        let Ok(corpus) = std::env::var("CORPUS_DIR") else { return };
        let franjas: HashMap<String, String> = std::fs::read_to_string(format!("{corpus}/tiers.json"))
            .ok()
            .and_then(|r| serde_json::from_str(&r).ok())
            .unwrap_or_default();
        let ficheros = ficheros_del_corpus(&corpus, 1);
        let hilos = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        let t0 = std::time::Instant::now();
        let mut total = Acumulado::default();
        std::thread::scope(|s| {
            let trozos: Vec<_> = ficheros
                .chunks(ficheros.len().div_ceil(hilos).max(1))
                .map(|trozo| {
                    let franjas = &franjas;
                    s.spawn(move || {
                        let mut a = Acumulado::default();
                        for f in trozo {
                            let Some((id, ps, tl)) = leer_del_corpus(f) else { continue };
                            let franja = franjas.get(&id).map(String::as_str).filter(|b| *b != "sin");
                            a.partida(&ps, &tl, franja);
                        }
                        a
                    })
                })
                .collect();
            for h in trozos {
                total.sumar(h.join().unwrap());
            }
        });
        if total.partidas < 50 {
            println!("corpus demasiado pequeño ({} partidas), no se comprueba", total.partidas);
            return;
        }
        println!("\n{} partidas en {:?}\n", total.partidas, t0.elapsed());

        println!("{} muertes; qué parte entra en cada categoría:", total.muertes);
        let mut cats: Vec<_> = total.por_cat.iter().collect();
        cats.sort();
        for (c, n) in cats {
            println!("  {c:20} {:.1}%", 100.0 * *n as f64 / total.muertes as f64);
        }
        println!("objetivos rivales sin ti, por dónde estabas: {:?}", total.ausencias);
        println!("\npérdida por partida, toda la partida, corpus entero (pts):");
        for r in crate::baselines::ROLES {
            let n = total.n[&("".into(), r.into())];
            let fila: Vec<String> = CATEGORIAS
                .iter()
                .filter(|c| !de_video(c))
                .map(|c| {
                    let s = total.suma.get(&("".into(), r.into(), c.to_string())).copied().unwrap_or_default();
                    let v: f64 = (0..TRAMOS).map(|t| if n[t] > 0 { s[t] / n[t] as f64 } else { 0.0 }).sum();
                    format!("{c} {:.1}", 100.0 * v)
                })
                .collect();
            println!("  {r:8} {}", fila.join(" · "));
        }

        let texto = generar(&mut total, &corpus);
        if std::env::var("COACH_ESCRIBIR").is_ok() {
            let ruta = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/coach_baremos.rs");
            std::fs::write(&ruta, &texto).unwrap();
            println!("\nescrito {}", ruta.display());
            return;
        }

        // Contraste con lo compilado: medias a 0,2 pts y deciles a 1 pt.
        let mut desviados = Vec::new();
        for (b, r, c, v) in crate::coach_baremos::PERDIDA {
            let n = total.n.get(&(b.to_string(), r.to_string())).copied().unwrap_or_default();
            let s = total.suma.get(&(b.to_string(), r.to_string(), c.to_string())).copied().unwrap_or_default();
            for t in 0..TRAMOS {
                let nuevo = if n[t] > 0 { s[t] / n[t] as f64 } else { 0.0 };
                if (nuevo - v[t]).abs() > 0.002 {
                    desviados.push(format!("{b}/{r}/{c}/{t}: {:.4} → {nuevo:.4}", v[t]));
                }
            }
        }
        for (b, r, d) in crate::coach_baremos::WPA_DECILES {
            let Some(w) = total.wpa.get_mut(&(b.to_string(), r.to_string())) else { continue };
            for t in 0..TRAMOS {
                let nuevo = deciles(&mut w[t]);
                let peor = nuevo.iter().zip(d[t].iter()).map(|(a, b)| (a - b).abs()).fold(0.0, f64::max);
                if peor > 0.01 {
                    desviados.push(format!("deciles {b}/{r}/{t}: hasta {peor:.3}"));
                }
            }
        }
        assert!(!crate::coach_baremos::PERDIDA.is_empty(), "coach_baremos.rs está sin generar: COACH_ESCRIBIR=1");
        assert!(desviados.is_empty(), "los baremos del coach se han quedado desfasados:\n{}", desviados.join("\n"));
    }
}
