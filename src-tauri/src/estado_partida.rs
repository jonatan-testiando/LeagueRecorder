//! Por delante, igualada o por detrás; las tiradas y las remontadas; y si tu
//! nota de impacto dice algo del resultado. Filas 3.3 y 3.4 de
//! `docs/coach-de-macro-diseno.md`.
//!
//! # El estado al 14
//!
//! Una partida se juega distinto según cómo se sale de la fase de líneas, y un
//! agregado que mezcla las que ibas ganando con las que ibas perdiendo dice
//! poco de ninguna. El corte es el oro con tu rival de línea en el fotograma
//! del minuto 14 (`minute_frames`, el último con placas en las torres),
//! partido por los **terciles del corpus para tu rol**: un tercio de los de tu
//! puesto sale de líneas por delante, otro igualado y otro por detrás. El rol
//! importa: 600 de oro es mucha ventaja para un support y poca para un top.
//!
//! # Tiradas y remontadas
//!
//! Con la curva de `get_match_plays` —los fotogramas de minuto y el «después»
//! de cada jugada— vista desde tu equipo:
//! - **tirada**: llegaste a [`crate::coach::UMBRAL_TIRADA`] (65 %) y perdiste;
//! - **remontada**: caíste a [`UMBRAL_REMONTADA`] (35 %) y ganaste.
//!
//! La tasa es sobre las partidas en que se dio la condición: de las que
//! tuviste de cara, cuántas perdiste. En el corpus las dos tasas son la misma
//! cifra por construcción (que un equipo llegue al 65 % es que el otro caiga
//! al 35 % en ese instante, y que uno pierda es que el otro gane), así que hay
//! una sola línea de referencia: `VUELCO`.
//!
//! # La nota frente al resultado
//!
//! `impact_percentile` es el percentil de tu WPA dentro de tu rol. Si mide
//! algo, quien sale con nota alta debería ganar más. Se cuenta tu winrate por
//! tramos de nota, y el corpus, que sí tiene el resultado de los diez, da la
//! línea con la que compararlo.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::winprob::{Play, WpPoint};

/// Con tu equipo a esta probabilidad o menos, ganar es remontar. Es el espejo
/// de `coach::UMBRAL_TIRADA`.
pub const UMBRAL_REMONTADA: f64 = 0.35;

/// El fotograma del que sale el estado.
pub const MINUTO_ESTADO: i32 = 14;

/// Las partidas que no llegan a este fotograma no cuentan: son remakes y
/// rendiciones tempranas, igual que en `benchmarks` (900 s).
pub const MINUTO_MINIMO: i32 = 15;

/// Tramos de nota: 0-20, 20-40, 40-60, 60-80 y 80-100.
pub const TRAMOS_NOTA: usize = 5;

/// Cómo saliste de la fase de líneas.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Estado {
    Ahead,
    Even,
    Behind,
}

impl Estado {
    /// La posición en las filas de `GANA_POR_ESTADO`.
    pub fn indice(self) -> usize {
        match self {
            Estado::Ahead => 0,
            Estado::Even => 1,
            Estado::Behind => 2,
        }
    }
}

/// El estado de un rol con esa ventaja de oro al 14. `None` para un rol que no
/// está en el corpus (partidas sin `teamPosition`).
pub fn estado(rol: &str, oro_14: f64) -> Option<Estado> {
    let (_, [bajo, alto]) = crate::estado_baremos::TERCILES_ORO_14.iter().find(|(r, _)| *r == rol)?;
    Some(if oro_14 > *alto {
        Estado::Ahead
    } else if oro_14 < *bajo {
        Estado::Behind
    } else {
        Estado::Even
    })
}

/// El tramo de nota de un percentil (0-100).
pub fn tramo_nota(pct: f64) -> usize {
    ((pct / 100.0 * TRAMOS_NOTA as f64).floor().max(0.0) as usize).min(TRAMOS_NOTA - 1)
}

/// Por dónde fue la probabilidad de victoria de tu equipo.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Rumbo {
    /// Lo más arriba que estuvo (0-1) y en qué segundo de partida.
    pub max: f64,
    pub max_time: f64,
    /// Lo más abajo.
    pub min: f64,
    pub min_time: f64,
    /// Llegó a `UMBRAL_TIRADA`, y lo perdió.
    pub had_lead: bool,
    pub thrown: bool,
    /// Cayó a `UMBRAL_REMONTADA`, y lo ganó.
    pub was_behind: bool,
    pub comeback: bool,
}

/// El rumbo de una partida para un equipo. `None` si no hay curva o la partida
/// no llega a [`MINUTO_MINIMO`].
pub fn rumbo(plays: &[Play], curve: &[WpPoint], team: i32, win: bool) -> Option<Rumbo> {
    if curve.last()?.time < MINUTO_MINIMO as f64 * 60.0 {
        return None;
    }
    let tuya = |p: f64| if team == 100 { p } else { 1.0 - p };
    // `after` va desde quien hizo la jugada. Se pasa a la óptica del 100 con
    // la regla de `winprob` (lo que no es del 100 es del 200), así los dos
    // equipos leen exactamente la misma curva al revés.
    let puntos = curve
        .iter()
        .map(|c| (c.time, tuya(c.p100)))
        .chain(plays.iter().map(|j| (j.time, tuya(if j.team_id == 100 { j.after } else { 1.0 - j.after }))));
    let mut r = Rumbo { max: f64::MIN, min: f64::MAX, ..Default::default() };
    for (t, p) in puntos {
        if p > r.max {
            (r.max, r.max_time) = (p, t);
        }
        if p < r.min {
            (r.min, r.min_time) = (p, t);
        }
    }
    r.had_lead = r.max >= crate::coach::UMBRAL_TIRADA;
    r.thrown = r.had_lead && !win;
    r.was_behind = r.min <= UMBRAL_REMONTADA;
    r.comeback = r.was_behind && win;
    Some(r)
}

/// Lo que se sabe de una partida tuya.
#[derive(Debug, Clone, Serialize)]
pub struct PartidaEstado {
    pub match_id: String,
    pub role: String,
    pub win: bool,
    /// Tu oro menos el de tu rival de línea en el minuto 14.
    pub gold_diff_14: Option<i32>,
    pub state: Option<Estado>,
    /// `None` sin jugadas guardadas o en una partida corta.
    pub course: Option<Rumbo>,
}

/// El estado de una partida tuya ya sincronizada. Sólo lee.
pub fn de_partida(meta: &crate::storage::MatchMetadata) -> Option<PartidaEstado> {
    let yo = meta.participants.iter().find(|p| p.is_self)?;
    let llega = meta.minute_frames.iter().any(|f| f.minute >= MINUTO_MINIMO);
    let gold_diff_14 = meta
        .minute_frames
        .iter()
        .find(|f| f.minute == MINUTO_ESTADO)
        .filter(|_| llega)
        .map(|f| f.self_gold_diff);
    // Sin riot_match.json no hay jugadas, y sin ellas tampoco carpeta que
    // tocar: `jugadas` no crea nada si no puede calcular.
    let course = (meta.riot_match_id.is_some())
        .then(|| crate::jugadas::de_partida(meta).ok())
        .flatten()
        .and_then(|j| rumbo(&j.plays, &j.curve, yo.team_id, yo.win));
    Some(PartidaEstado {
        match_id: meta.id.clone(),
        role: yo.role.clone(),
        win: yo.win,
        gold_diff_14,
        state: gold_diff_14.and_then(|d| estado(&yo.role, d as f64)),
        course,
    })
}

/// Las líneas del corpus con las que se comparan tus partidas.
#[derive(Debug, Clone, Serialize)]
pub struct LineaCorpus {
    /// Rol → [corte bajo, corte alto] del oro al 14.
    pub cuts: BTreeMap<String, [f64; 2]>,
    /// Rol → cuánto se gana por delante, igualado y por detrás (0-1).
    pub win_by_state: BTreeMap<String, [f64; 3]>,
    /// Franja de rango (`""` es el corpus entero) → tasa de vuelco: de las
    /// partidas con un equipo al 65 %, cuántas acaban del otro lado.
    pub flip: BTreeMap<String, f64>,
    /// Victorias por tramo de nota, todos los roles.
    pub win_by_score: [f64; TRAMOS_NOTA],
    /// Cuánto gana el MVP de la partida (el mejor percentil de los diez).
    pub mvp_win: f64,
}

fn linea_corpus() -> LineaCorpus {
    use crate::estado_baremos as b;
    LineaCorpus {
        cuts: b::TERCILES_ORO_14.iter().map(|(r, c)| (r.to_string(), *c)).collect(),
        win_by_state: b::GANA_POR_ESTADO.iter().map(|(r, v)| (r.to_string(), *v)).collect(),
        flip: b::VUELCO.iter().map(|(f, v)| (f.to_string(), *v)).collect(),
        win_by_score: b::GANA_POR_NOTA,
        mvp_win: b::GANA_MVP,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct EstadoPartidas {
    /// De la más reciente a la más antigua.
    pub games: Vec<PartidaEstado>,
    pub corpus: LineaCorpus,
}

/// El estado y el rumbo de todas tus partidas del coach, con las líneas del
/// corpus. Patrones agrega lo que le toque según sus filtros.
#[tauri::command]
pub async fn get_game_states() -> EstadoPartidas {
    let games = tokio::task::spawn_blocking(|| {
        crate::storage::load_all_matches()
            .iter()
            .filter(|m| crate::coach::cuenta(m))
            .filter_map(de_partida)
            .collect()
    })
    .await
    .unwrap_or_default();
    EstadoPartidas { games, corpus: linea_corpus() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::riot_api::{ParticipantDto, TimelineDto};
    use std::collections::HashMap;

    fn play(time: f64, team_id: i32, after: f64) -> Play {
        Play { time, kind: "kill".into(), team_id, before: 0.5, after, wpa: after - 0.5, shares: vec![], victim: None }
    }

    /// Una curva de partida de 20 minutos que pasa por esas probabilidades del
    /// equipo 100, una por minuto desde el 0.
    fn curva(p100: &[f64]) -> Vec<WpPoint> {
        let mut v: Vec<WpPoint> =
            p100.iter().enumerate().map(|(i, p)| WpPoint { time: i as f64 * 60.0, p100: *p }).collect();
        while v.len() <= 20 {
            let t = v.len() as f64 * 60.0;
            v.push(WpPoint { time: t, p100: v.last().unwrap().p100 });
        }
        v
    }

    /// El rol que más se juega en cada partida tiene sus dos cortes y son
    /// simétricos: cada par de rivales aporta +d y −d a la muestra.
    #[test]
    fn el_estado_sale_de_los_terciles_del_rol() {
        let t = crate::estado_baremos::TERCILES_ORO_14;
        assert_eq!(t.len(), 5, "estado_baremos.rs está sin generar: ESTADO_ESCRIBIR=1");
        for (rol, [bajo, alto]) in t {
            assert!(bajo < &0.0 && alto > &0.0, "{rol}: cortes {bajo} {alto}");
            assert!((bajo + alto).abs() <= 40.0, "{rol}: los cortes no son simétricos ({bajo}, {alto})");
            assert_eq!(estado(rol, alto + 1.0), Some(Estado::Ahead));
            assert_eq!(estado(rol, *alto), Some(Estado::Even));
            assert_eq!(estado(rol, 0.0), Some(Estado::Even));
            assert_eq!(estado(rol, bajo - 1.0), Some(Estado::Behind));
        }
        // Los mismos 500 de oro: ventaja clara para un support, igualada para
        // un top. Si no, partir por rol no aportaría nada.
        assert_eq!(estado("UTILITY", 500.0), Some(Estado::Ahead));
        assert_eq!(estado("TOP", 500.0), Some(Estado::Even));
        assert_eq!(estado("", 3000.0), None);
    }

    #[test]
    fn el_estado_sale_del_minuto_14_y_solo_si_la_partida_llega_al_15() {
        use crate::storage::{MatchMetadata, MinuteFrameDto, Participant};
        let frames = |hasta: i32, oro_14: i32| -> Vec<MinuteFrameDto> {
            (0..=hasta)
                .map(|m| MinuteFrameDto { minute: m, self_gold_diff: if m == 14 { oro_14 } else { 0 }, ..Default::default() })
                .collect()
        };
        let yo = Participant { is_self: true, role: "UTILITY".into(), team_id: 100, win: true, ..Default::default() };
        let meta = |hasta: i32, oro_14: i32| MatchMetadata {
            id: "estado_de_prueba".into(),
            participants: vec![yo.clone()],
            minute_frames: frames(hasta, oro_14),
            ..Default::default()
        };
        let p = de_partida(&meta(30, 900)).unwrap();
        assert_eq!((p.gold_diff_14, p.state), (Some(900), Some(Estado::Ahead)));
        assert_eq!(de_partida(&meta(30, -900)).unwrap().state, Some(Estado::Behind));
        // Una rendición en el 14:30 tiene fotograma 14, pero no es una partida
        // que comparar con el corpus, que descarta las de menos de 15 minutos.
        let corta = de_partida(&meta(14, 900)).unwrap();
        assert_eq!((corta.gold_diff_14, corta.state), (None, None));
    }

    #[test]
    fn tirada_es_perder_tras_llegar_al_65() {
        let c = curva(&[0.5, 0.55, 0.6, 0.62, 0.58, 0.45, 0.3]);
        // Una pelea ganada en el 3:30 lleva al equipo 100 al 68 % un momento,
        // entre dos fotogramas: también cuenta como tenerla de cara.
        let js = [play(210.0, 100, 0.68)];
        let perdida = rumbo(&js, &c, 100, false).unwrap();
        assert!(perdida.had_lead && perdida.thrown);
        assert_eq!((perdida.max, perdida.max_time), (0.68, 210.0));
        let ganada = rumbo(&js, &c, 100, true).unwrap();
        assert!(ganada.had_lead && !ganada.thrown);
        // Sin la jugada, el 62 % del fotograma no llega.
        assert!(!rumbo(&[], &c, 100, false).unwrap().had_lead);
    }

    #[test]
    fn remontada_es_ganar_tras_caer_al_35() {
        let c = curva(&[0.5, 0.4, 0.33, 0.45, 0.6, 0.8]);
        let r = rumbo(&[], &c, 100, true).unwrap();
        assert!(r.was_behind && r.comeback && !r.thrown);
        assert_eq!((r.min, r.min_time), (0.33, 120.0));
        let perdida = rumbo(&[], &c, 100, false).unwrap();
        assert!(perdida.was_behind && !perdida.comeback);
        assert!(!rumbo(&[], &curva(&[0.5, 0.36, 0.5]), 100, true).unwrap().was_behind);
    }

    /// La curva es del equipo 100; el 200 la ve al revés, y una jugada se lee
    /// desde quien la hizo.
    #[test]
    fn el_rumbo_se_lee_desde_tu_equipo() {
        let c = curva(&[0.5, 0.7, 0.5]);
        let rojo = rumbo(&[play(400.0, 200, 0.8)], &c, 200, false).unwrap();
        assert!((rojo.min - 0.3).abs() < 1e-9 && rojo.min_time == 60.0);
        assert!((rojo.max - 0.8).abs() < 1e-9 && rojo.max_time == 400.0);
        assert!(rojo.thrown && rojo.was_behind && !rojo.comeback);
        let azul = rumbo(&[play(400.0, 200, 0.8)], &c, 100, true).unwrap();
        assert!((azul.min - 0.2).abs() < 1e-9 && azul.comeback);
    }

    #[test]
    fn una_partida_corta_no_tiene_rumbo() {
        let c: Vec<WpPoint> = (0..=14).map(|i| WpPoint { time: i as f64 * 60.0, p100: 0.9 }).collect();
        assert!(rumbo(&[], &c, 100, false).is_none());
        assert!(rumbo(&[], &[], 100, false).is_none());
    }

    #[test]
    fn el_tramo_de_nota_cubre_de_0_a_100() {
        assert_eq!([0.0, 19.9, 20.0, 59.9, 80.0, 99.9, 100.0].map(tramo_nota), [0, 0, 1, 2, 4, 4, 4]);
    }

    // ------------------------------------------------------------ las tasas

    /// Las tasas de tiradas y remontadas: de las partidas en que se dio la
    /// condición, cuántas acabaron del otro lado. Patrones hace la misma
    /// cuenta con las partidas de sus filtros (`core/gameStates.ts`).
    #[derive(Debug, Clone, Copy, Default, PartialEq)]
    struct Tasas {
        con_ventaja: u32,
        tiradas: u32,
        en_desventaja: u32,
        remontadas: u32,
    }

    impl Tasas {
        fn sumar(&mut self, r: &Rumbo) {
            self.con_ventaja += r.had_lead as u32;
            self.tiradas += r.thrown as u32;
            self.en_desventaja += r.was_behind as u32;
            self.remontadas += r.comeback as u32;
        }
        fn juntar(&mut self, o: Tasas) {
            self.con_ventaja += o.con_ventaja;
            self.tiradas += o.tiradas;
            self.en_desventaja += o.en_desventaja;
            self.remontadas += o.remontadas;
        }
        fn tirada(&self) -> Option<f64> {
            (self.con_ventaja > 0).then(|| self.tiradas as f64 / self.con_ventaja as f64)
        }
        fn remontada(&self) -> Option<f64> {
            (self.en_desventaja > 0).then(|| self.remontadas as f64 / self.en_desventaja as f64)
        }
    }

    #[test]
    fn las_tasas_cuentan_sobre_las_partidas_en_que_se_dio_la_condicion() {
        let de_cara = curva(&[0.5, 0.7, 0.5]);
        let cuesta_arriba = curva(&[0.5, 0.3, 0.5]);
        let tranquila = curva(&[0.5, 0.55, 0.5]);
        let mut t = Tasas::default();
        for (c, win) in [(&de_cara, false), (&de_cara, true), (&de_cara, true), (&cuesta_arriba, true), (&tranquila, false)] {
            t.sumar(&rumbo(&[], c, 100, win).unwrap());
        }
        // Tres de cara (perdiste una) y una cuesta arriba (la ganaste); la
        // tranquila no entra en ninguna de las dos.
        assert_eq!(t, Tasas { con_ventaja: 3, tiradas: 1, en_desventaja: 1, remontadas: 1 });
        assert!((t.tirada().unwrap() - 1.0 / 3.0).abs() < 1e-9);
        assert_eq!(t.remontada(), Some(1.0));
        assert_eq!(Tasas::default().tirada(), None);
    }

    /// En una misma partida, la tirada de un equipo es la remontada del otro:
    /// por eso el corpus tiene una sola tasa de vuelco.
    #[test]
    fn la_tirada_de_un_equipo_es_la_remontada_del_otro() {
        let c = curva(&[0.5, 0.72, 0.6, 0.4, 0.2]);
        let js = [play(90.0, 100, 0.75), play(500.0, 200, 0.85)];
        let azul = rumbo(&js, &c, 100, false).unwrap();
        let rojo = rumbo(&js, &c, 200, true).unwrap();
        assert_eq!((azul.thrown, azul.had_lead), (rojo.comeback, rojo.was_behind));
        assert!((azul.max - (1.0 - rojo.min)).abs() < 1e-9 && azul.max_time == rojo.min_time);
    }

    // ------------------------------------------------------------ corpus

    fn ficheros_del_corpus(corpus: &str) -> Vec<std::path::PathBuf> {
        let mut v: Vec<std::path::PathBuf> = std::fs::read_dir(format!("{corpus}/partidas"))
            .into_iter()
            .flatten()
            .flatten()
            .flat_map(|d| std::fs::read_dir(d.path()).into_iter().flatten().flatten().map(|f| f.path()))
            .collect();
        v.sort();
        v
    }

    fn leer(f: &std::path::Path) -> Option<(String, Vec<ParticipantDto>, TimelineDto)> {
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

    fn rol(p: &ParticipantDto) -> &str {
        if p.teamPosition.is_empty() { &p.individualPosition } else { &p.teamPosition }
    }

    #[derive(Default)]
    struct Acumulado {
        partidas: usize,
        /// rol → (oro al 14, ganó).
        oro: HashMap<String, Vec<(f64, bool)>>,
        /// franja → tasas por equipo.
        tasas: HashMap<String, Tasas>,
        /// Por tramo de nota: (victorias, jugadores).
        nota: [(u32, u32); TRAMOS_NOTA],
        mvp: (u32, u32),
    }

    impl Acumulado {
        fn juntar(&mut self, o: Acumulado) {
            self.partidas += o.partidas;
            for (k, v) in o.oro {
                self.oro.entry(k).or_default().extend(v);
            }
            for (k, v) in o.tasas {
                self.tasas.entry(k).or_default().juntar(v);
            }
            for t in 0..TRAMOS_NOTA {
                self.nota[t].0 += o.nota[t].0;
                self.nota[t].1 += o.nota[t].1;
            }
            self.mvp.0 += o.mvp.0;
            self.mvp.1 += o.mvp.1;
        }

        fn partida(&mut self, ps: &[ParticipantDto], tl: &TimelineDto, franja: Option<&str>) {
            // Mismo listón que tus partidas: el fotograma del minuto 15.
            if ps.len() != 10 || tl.info.frames.len() <= MINUTO_MINIMO as usize {
                return;
            }
            self.partidas += 1;

            // El estado: contra el rival del mismo puesto, sólo si es uno.
            let f14 = &tl.info.frames[MINUTO_ESTADO as usize];
            for (i, p) in ps.iter().enumerate() {
                let r = rol(p);
                if !crate::baselines::ROLES.contains(&r) {
                    continue;
                }
                let rivales: Vec<usize> =
                    (0..10).filter(|j| ps[*j].teamId != p.teamId && rol(&ps[*j]) == r).collect();
                let &[j] = &rivales[..] else { continue };
                let oro = |k: usize| f14.participantFrames.get(&(k + 1).to_string()).map(|f| f.totalGold);
                if let (Some(a), Some(b)) = (oro(i), oro(j)) {
                    self.oro.entry(r.to_string()).or_default().push(((a - b) as f64, p.win));
                }
            }

            // El rumbo, una vez por equipo.
            let (plays, curve) = crate::winprob::plays_and_curve(tl, ps);
            for team in [100, 200] {
                let Some(win) = ps.iter().find(|p| p.teamId == team).map(|p| p.win) else { continue };
                let Some(r) = rumbo(&plays, &curve, team, win) else { continue };
                for b in [Some(""), franja].into_iter().flatten() {
                    self.tasas.entry(b.to_string()).or_default().sumar(&r);
                }
            }

            // La nota, con el mismo baremo que `riot_api::impacto` y el mismo
            // desempate que `puesto_de_impacto`.
            let wpa = crate::winprob::per_player(&plays);
            let mut notas: Vec<(f64, f64, bool)> = ps
                .iter()
                .enumerate()
                .map(|(i, p)| {
                    let w = wpa.get(&((i + 1) as i32)).copied().unwrap_or(0.0);
                    let pct = match franja {
                        Some(b) => crate::baselines::percentil_en_tramo(b, rol(p), w),
                        None => crate::baselines::percentil(rol(p), w),
                    };
                    ((pct * 10.0).round() / 10.0, w, p.win)
                })
                .collect();
            for (pct, _, win) in &notas {
                let t = tramo_nota(*pct);
                self.nota[t].0 += *win as u32;
                self.nota[t].1 += 1;
            }
            notas.sort_by(|a, b| b.0.total_cmp(&a.0).then(b.1.total_cmp(&a.1)));
            self.mvp.0 += notas[0].2 as u32;
            self.mvp.1 += 1;
        }
    }

    const FRANJAS: [&str; 4] = ["", "bajo", "medio", "alto"];

    /// Los cortes y las victorias por estado de cada rol.
    fn por_rol(a: &mut Acumulado) -> Vec<(String, [f64; 2], [f64; 3], usize)> {
        let mut out = Vec::new();
        for r in crate::baselines::ROLES {
            let Some(v) = a.oro.get_mut(r) else { continue };
            v.sort_by(|x, y| x.0.total_cmp(&y.0));
            let cortes = [v[v.len() / 3].0, v[v.len() * 2 / 3].0];
            let mut gana = [(0u32, 0u32); 3];
            for (oro, win) in v.iter() {
                let e = if *oro > cortes[1] {
                    Estado::Ahead
                } else if *oro < cortes[0] {
                    Estado::Behind
                } else {
                    Estado::Even
                };
                gana[e.indice()].0 += *win as u32;
                gana[e.indice()].1 += 1;
            }
            out.push((r.to_string(), cortes, gana.map(|(w, n)| w as f64 / n.max(1) as f64), v.len()));
        }
        out
    }

    fn generar(a: &mut Acumulado, corpus: &str) -> String {
        let filas = por_rol(a);
        let mut s = format!(
            "//! Líneas del corpus para `crate::estado_partida`: los terciles del oro al\n\
             //! 14 por rol, cuánto se gana en cada estado, la tasa de vuelco y cuánto se\n\
             //! gana por tramo de nota.\n\
             //!\n\
             //! GENERADO por `estado_partida::tests::baremos_del_estado` sobre `{corpus}`\n\
             //! ({} partidas de 15 minutos o más). No editar a mano: con `ESTADO_ESCRIBIR=1`\n\
             //! el test lo reescribe, y sin él comprueba que sigue cuadrando con el corpus.\n\
             //!\n\
             //!     CORPUS_DIR=D:/lol-corpus ESTADO_ESCRIBIR=1 cargo test --release --lib estado_partida::tests::baremos_del_estado -- --nocapture\n\n",
            a.partidas
        );
        s.push_str("/// Rol → [corte bajo, corte alto] del oro con tu rival al 14: por debajo del\n/// primero vas por detrás, por encima del segundo por delante.\n");
        s.push_str("pub(crate) const TERCILES_ORO_14: &[(&str, [f64; 2])] = &[\n");
        for (r, c, _, n) in &filas {
            s.push_str(&format!("    (\"{r}\", [{:.1}, {:.1}]),   // n={n}\n", c[0], c[1]));
        }
        s.push_str("];\n\n/// Rol → victorias (0-1) por delante, igualado y por detrás.\n");
        s.push_str("pub(crate) const GANA_POR_ESTADO: &[(&str, [f64; 3])] = &[\n");
        for (r, _, g, _) in &filas {
            s.push_str(&format!("    (\"{r}\", [{:.4}, {:.4}, {:.4}]),\n", g[0], g[1], g[2]));
        }
        s.push_str("];\n\n/// Franja → de los equipos que llegaron al 65 %, cuántos perdieron (que es\n/// también cuántos ganaron de los que cayeron al 35 %). `\"\"` es el corpus entero.\n");
        s.push_str("pub(crate) const VUELCO: &[(&str, f64)] = &[\n");
        for b in FRANJAS {
            let Some(t) = a.tasas.get(b) else { continue };
            s.push_str(&format!("    (\"{b}\", {:.4}),   // n={}\n", t.tirada().unwrap_or(0.0), t.con_ventaja));
        }
        let gana = |(w, n): (u32, u32)| w as f64 / n.max(1) as f64;
        let notas: Vec<String> = a.nota.iter().map(|x| format!("{:.4}", gana(*x))).collect();
        s.push_str(&format!(
            "];\n\n/// Victorias (0-1) por tramo de nota: 0-20, 20-40, 40-60, 60-80 y 80-100.\npub(crate) const GANA_POR_NOTA: [f64; 5] = [{}];\n\n",
            notas.join(", ")
        ));
        s.push_str(&format!(
            "/// Victorias (0-1) del MVP de la partida: el mejor percentil de los diez.\npub(crate) const GANA_MVP: f64 = {:.4};\n",
            gana(a.mvp)
        ));
        s
    }

    /// Mide las líneas sobre el corpus y genera `estado_baremos.rs`, o
    /// comprueba que el compilado siga cuadrando.
    ///
    /// `CORPUS_DIR=D:/lol-corpus [ESTADO_ESCRIBIR=1] cargo test --release --lib estado_partida::tests::baremos_del_estado -- --nocapture`
    #[test]
    fn baremos_del_estado() {
        let Ok(corpus) = std::env::var("CORPUS_DIR") else { return };
        let franjas: HashMap<String, String> = std::fs::read_to_string(format!("{corpus}/tiers.json"))
            .ok()
            .and_then(|r| serde_json::from_str(&r).ok())
            .unwrap_or_default();
        let ficheros = ficheros_del_corpus(&corpus);
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
                            let Some((id, ps, tl)) = leer(f) else { continue };
                            let franja = franjas.get(&id).map(String::as_str).filter(|b| *b != "sin");
                            a.partida(&ps, &tl, franja);
                        }
                        a
                    })
                })
                .collect();
            for h in trozos {
                total.juntar(h.join().unwrap());
            }
        });
        if total.partidas < 50 {
            println!("corpus demasiado pequeño ({} partidas), no se comprueba", total.partidas);
            return;
        }
        println!("\n{} partidas en {:?}\n", total.partidas, t0.elapsed());
        for b in FRANJAS {
            if let Some(t) = total.tasas.get(b) {
                println!(
                    "franja {b:6}: tirada {:.1}% de {} · remontada {:.1}% de {}",
                    100.0 * t.tirada().unwrap_or(0.0),
                    t.con_ventaja,
                    100.0 * t.remontada().unwrap_or(0.0),
                    t.en_desventaja
                );
                // La identidad de arriba, comprobada: si no se cumple, el
                // rumbo de un equipo no es el espejo del otro.
                assert_eq!((t.tiradas, t.con_ventaja), (t.remontadas, t.en_desventaja), "franja {b}");
            }
        }

        let texto = generar(&mut total, &corpus);
        println!("\n{texto}");
        if std::env::var("ESTADO_ESCRIBIR").is_ok() {
            let ruta = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/estado_baremos.rs");
            std::fs::write(&ruta, &texto).unwrap();
            println!("escrito {}", ruta.display());
            return;
        }

        // Contraste con lo compilado: cortes a 10 de oro, tasas a medio punto.
        let mut desviados = Vec::new();
        for (r, c, g, _) in por_rol(&mut total) {
            let Some((_, cc)) = crate::estado_baremos::TERCILES_ORO_14.iter().find(|(x, _)| *x == r) else {
                desviados.push(format!("falta {r}"));
                continue;
            };
            if (c[0] - cc[0]).abs() > 10.0 || (c[1] - cc[1]).abs() > 10.0 {
                desviados.push(format!("cortes {r}: {cc:?} → {c:?}"));
            }
            if let Some((_, gg)) = crate::estado_baremos::GANA_POR_ESTADO.iter().find(|(x, _)| *x == r) {
                if g.iter().zip(gg).any(|(a, b)| (a - b).abs() > 0.005) {
                    desviados.push(format!("victorias {r}: {gg:?} → {g:?}"));
                }
            }
        }
        for (b, v) in crate::estado_baremos::VUELCO {
            let nuevo = total.tasas.get(*b).and_then(Tasas::tirada).unwrap_or(0.0);
            if (nuevo - v).abs() > 0.005 {
                desviados.push(format!("vuelco {b}: {v:.4} → {nuevo:.4}"));
            }
        }
        assert!(desviados.is_empty(), "las líneas del estado se han quedado desfasadas:\n{}", desviados.join("\n"));
    }

    /// Tus partidas con su estado y su rumbo, y las tasas que salen.
    ///
    /// `LR_REAL=1 cargo test --release --lib estado_partida::tests::estado_en_mis_partidas -- --nocapture`
    #[test]
    fn estado_en_mis_partidas() {
        if std::env::var("LR_REAL").is_err() {
            return;
        }
        let metas = crate::storage::load_all_matches();
        let ps: Vec<PartidaEstado> = metas.iter().filter(|m| crate::coach::cuenta(m)).filter_map(de_partida).collect();
        let mut t = Tasas::default();
        let mut por_estado: HashMap<String, (u32, u32)> = HashMap::new();
        for p in &ps {
            let e = p.state.map(|e| format!("{e:?}")).unwrap_or_else(|| "sin estado".into());
            let x = por_estado.entry(e.clone()).or_default();
            x.0 += p.win as u32;
            x.1 += 1;
            if let Some(r) = &p.course {
                t.sumar(r);
            }
            println!(
                "{:28} {:8} {:5} oro14 {:>6} {:10} max {:>4.0}% @{:>5.0}s min {:>4.0}% {}{}",
                p.match_id,
                p.role,
                if p.win { "gana" } else { "pierde" },
                p.gold_diff_14.map(|d| d.to_string()).unwrap_or("—".into()),
                e,
                p.course.map(|r| 100.0 * r.max).unwrap_or(f64::NAN),
                p.course.map(|r| r.max_time).unwrap_or(f64::NAN),
                p.course.map(|r| 100.0 * r.min).unwrap_or(f64::NAN),
                if p.course.is_some_and(|r| r.thrown) { "TIRADA " } else { "" },
                if p.course.is_some_and(|r| r.comeback) { "REMONTADA" } else { "" },
            );
        }
        println!("\n{} partidas", ps.len());
        for (e, (w, n)) in &por_estado {
            println!("  {e:10} {w}/{n}");
        }
        println!(
            "tiradas {}/{} · remontadas {}/{}",
            t.tiradas, t.con_ventaja, t.remontadas, t.en_desventaja
        );
    }
}
