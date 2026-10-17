//! La franja de un episodio de presión: tu vida y a quién tenías encima,
//! segundo a segundo.
//!
//! Un episodio ([`crate::pressure`]) dice «de 12:03 a 12:21 te sujetaron
//! tres». La franja enseña cómo fue por dentro: si la vida bajaba mientras los
//! tenías encima, si te quedaste solo, en qué instante caíste. No mide nada
//! nuevo; junta dos lecturas del vídeo que ya existen:
//!
//! - **La vida**, de la barra del HUD ([`crate::hud`], ocho lecturas por
//!   segundo), bajada a cuatro por segundo, que es lo que cabe en la franja.
//! - **Rivales y aliados encima**, del minimapa, con el recuento EXACTO que abre
//!   los episodios ([`crate::pressure::encima_por_instante`]): mismo radio
//!   (1.200), mismo equipo por el aro y tu icono descontado. Si la franja
//!   contara con otro criterio, enseñaría presión donde el detector no la vio.
//!
//! Todo en segundos de PARTIDA, como los episodios.

use serde::Serialize;

use crate::minimap::Positions;
use crate::riot_api::{MatchDto, TimelineDto};

/// Margen a cada lado del tramo: el acercamiento y lo que pasó justo después.
const MARGEN: f64 = 5.0;
/// Ancho de cada muestra de vida: cuatro por segundo.
const PASO_VIDA: f64 = 0.25;
/// Una lectura a 0 a menos de esto de una muerte es la barra vacía de verdad.
/// El mismo margen con el que [`crate::golpes`] da por buena una caída a 0.
const MUERTE_CERCA: f64 = 1.5;

#[derive(Debug, Clone, Serialize, Default)]
pub struct EpisodeStrip {
    /// "ok", "no_hud", "no_minimap" o "no_riot". Ver `estado_de`.
    pub status: String,
    /// `[t_partida, vida 0..1]`, unas cuatro por segundo.
    pub hp: Vec<(f64, f64)>,
    /// `[t_partida, rivales encima, aliados encima sin contarte]`, una por
    /// muestra del minimapa en que estabas vivo y localizado.
    pub near: Vec<(f64, usize, usize)>,
    /// Tus muertes en el tramo con su margen (segundos de partida).
    pub deaths: Vec<f64>,
}

/// Lo que hace falta para la franja de una partida.
pub struct Fuentes<'a> {
    pub tl: &'a TimelineDto,
    /// El jugador grabado.
    pub pid: i32,
    /// Segundo de vídeo en que empieza la partida. Sin él la vida (que va en
    /// segundos de vídeo) no se puede poner en el reloj de la partida.
    pub desfase: Option<f64>,
    /// `(fps, hp)` de [`crate::hud::vida`], si el HUD se leyó y es legible.
    pub vida: Option<(f64, &'a [i32])>,
    pub pos: Option<&'a Positions>,
}

fn redondea(v: f64, decimales: i32) -> f64 {
    let f = 10f64.powi(decimales);
    (v * f).round() / f
}

/// La vida en `[a, b]` (partida), bajada a `PASO_VIDA` con la media de cada
/// ventana.
///
/// Un 0 con vida es la barra que no está (una pantalla por encima, el arranque),
/// no que estés a cero: se descarta, igual que hace [`crate::golpes`]. Muerto
/// o rozando la muerte, el 0 sí vale, y es justo lo que se quiere ver caer.
fn vida_en(hp: &[i32], fps: f64, desfase: f64, a: f64, b: f64, muertes: &[(f64, f64, Option<(f64, f64)>)]) -> Vec<(f64, f64)> {
    if hp.is_empty() || fps <= 0.0 || b < a {
        return Vec::new();
    }
    let i0 = ((a + desfase) * fps).floor().max(0.0) as usize;
    let i1 = (((b + desfase) * fps).ceil().max(0.0) as usize).min(hp.len() - 1);
    let cero_de_verdad = |t: f64| muertes.iter().any(|(d, vuelve, _)| t >= d - MUERTE_CERCA && t <= *vuelve);
    let mut out = Vec::new();
    // (ventana, suma de instantes, suma de vida, lecturas)
    let mut actual: Option<(i64, f64, f64, usize)> = None;
    let cerrar = |v: (i64, f64, f64, usize), out: &mut Vec<(f64, f64)>| {
        let n = v.3 as f64;
        out.push((redondea(v.1 / n, 2), redondea(v.2 / n / 1000.0, 3)));
    };
    for (i, &h) in hp.iter().enumerate().take(i1 + 1).skip(i0) {
        let t = i as f64 / fps - desfase;
        if t < a || t > b || h < 0 || (h == 0 && !cero_de_verdad(t)) {
            continue;
        }
        let k = ((t - a) / PASO_VIDA).floor() as i64;
        match actual.as_mut() {
            Some(v) if v.0 == k => {
                v.1 += t;
                v.2 += h as f64;
                v.3 += 1;
            }
            _ => {
                if let Some(v) = actual.take() {
                    cerrar(v, &mut out);
                }
                actual = Some((k, t, h as f64, 1));
            }
        }
    }
    if let Some(v) = actual {
        cerrar(v, &mut out);
    }
    out
}

/// La franja de `[from, to]` (segundos de partida), con `MARGEN` a cada lado.
///
/// Las muertes también se buscan con el margen, no sólo dentro del tramo: la
/// vida y los rivales se dibujan con él, y una caída a 0 en el margen sin su
/// muerte al lado no se entendería. Quien quiera sólo las del tramo, las filtra.
pub fn franja(f: &Fuentes, from: f64, to: f64) -> EpisodeStrip {
    let (a, b) = (from.min(to) - MARGEN, from.max(to) + MARGEN);
    let muertes = crate::jungle_route::muertes(f.tl, f.pid);
    let deaths = muertes.iter().map(|m| m.0).filter(|t| *t >= a && *t <= b).collect();

    let hp = match (f.vida, f.desfase) {
        (Some((fps, serie)), Some(desfase)) => vida_en(serie, fps, desfase, a, b, &muertes),
        _ => Vec::new(),
    };

    let mut near = Vec::new();
    let mut hay_rastro = false;
    if let Some(pos) = f.pos {
        // El rastro se sigue con la partida entera: entre minutos busca el
        // camino que une las posiciones exactas de la API, y recortarlo antes
        // le quitaría las anclas.
        let pista = pos.follow(&crate::minimap::anclas_de(f.tl, pos.self_participant_id));
        hay_rastro = !pista.is_empty();
        let tramo: Vec<crate::minimap::Fix> = pista.into_iter().filter(|x| x.sec >= a && x.sec <= b).collect();
        let vivos = crate::pressure_value::Vivos::build(f.tl);
        near = crate::pressure::encima_por_instante(pos, &tramo, &vivos)
            .into_iter()
            .map(|(x, rivales, aliados)| (redondea(x.sec, 2), rivales, aliados))
            .collect();
    }

    let hay_vida = f.vida.is_some() && f.desfase.is_some();
    let status = estado_de(hay_vida, f.pos.is_some(), hay_rastro).to_string();
    EpisodeStrip { status, hp, near, deaths }
}

/// El estado con las fuentes que hay en la PARTIDA, no con lo que caiga en el
/// tramo: un tramo sin muestras con el minimapa leído es "ok" con `near` vacío.
///
/// Con una de las dos basta para "ok"; lo que falte llega vacío. Sin ninguna se
/// dice la que falta y aportaría algo: "no_minimap" si el minimapa no se ha
/// leído (es la fuente del episodio en sí y el primer paso del lote de vídeo,
/// que lee el HUD justo después); "no_hud" si está leído pero no te sigue en
/// esta partida, porque entonces sólo la vida puede añadir algo.
fn estado_de(hay_vida: bool, hay_minimapa: bool, hay_rastro: bool) -> &'static str {
    match (hay_vida, hay_minimapa && hay_rastro) {
        (true, _) | (_, true) => "ok",
        _ if hay_minimapa => "no_hud",
        _ => "no_minimap",
    }
}

fn estado(s: &str) -> EpisodeStrip {
    EpisodeStrip { status: s.into(), ..Default::default() }
}

fn de_partida(match_id: &str, from: f64, to: f64) -> EpisodeStrip {
    let (Some(raw), Some(raw_tl), Ok(meta)) = (
        crate::storage::load_raw_match(match_id),
        crate::storage::load_raw_timeline(match_id),
        crate::storage::get_match_metadata(match_id),
    ) else {
        return estado("no_riot");
    };
    let (Ok(m), Ok(tl)) = (serde_json::from_str::<MatchDto>(&raw), serde_json::from_str::<TimelineDto>(&raw_tl)) else {
        return estado("no_riot");
    };
    let pos = Positions::load(match_id);
    // El jugador grabado: el del minimapa si se leyó (es a quien siguen los
    // episodios del vídeo), y si no, por el campeón, como las oleadas.
    let pid = match &pos {
        Some(p) => Some(p.self_participant_id),
        None => m.info.participants.iter().position(|p| p.championName == meta.champion).map(|i| i as i32 + 1),
    };
    let Some(pid) = pid.filter(|p| *p >= 1 && (*p as usize) <= m.info.participants.len()) else {
        return estado("no_riot");
    };
    let hud = std::fs::read_to_string(crate::hud::ruta(match_id)).ok().and_then(|r| crate::hud::vida(&r));
    let desfase = meta.video_offset.or(pos.as_ref().map(|p| p.video_offset));
    let fuentes = Fuentes {
        tl: &tl,
        pid,
        desfase,
        vida: hud.as_ref().map(|(fps, hp)| (*fps, hp.as_slice())),
        pos: pos.as_ref(),
    };
    franja(&fuentes, from, to)
}

/// La franja de un tramo `[from, to]` en segundos de PARTIDA.
#[tauri::command]
pub async fn get_episode_strip(match_id: String, from: f64, to: f64) -> EpisodeStrip {
    tokio::task::spawn_blocking(move || de_partida(&match_id, from, to))
        .await
        .unwrap_or_else(|_| estado("no_riot"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_vida_baja_a_cuatro_por_segundo_y_el_cero_solo_vale_al_morir() {
        // 8 lecturas por segundo, partida desde el segundo 10 del vídeo.
        let mut hp = vec![1000; 8 * 30];
        hp[8 * 15] = 0; // a los 5 s de partida: la barra que no está
        for h in hp.iter_mut().skip(8 * 25) {
            *h = 0; // muerto a los 15 s de partida
        }
        let muertes = vec![(15.0, 40.0, None)];
        let v = vida_en(&hp, 8.0, 10.0, 0.0, 19.0, &muertes);
        // 0..19 s a 4 por segundo; la lectura suelta a 0 no deja hueco porque
        // la otra lectura de su ventana la cubre.
        assert_eq!(v.len(), 4 * 19 + 1);
        assert!(v.iter().filter(|(t, _)| *t < 14.0).all(|(_, h)| *h == 1.0), "{v:?}");
        assert!(v.iter().filter(|(t, _)| *t >= 15.0).all(|(_, h)| *h == 0.0));
        // Sin muerte cerca, los ceros no salen.
        let sin = vida_en(&hp, 8.0, 10.0, 15.0, 19.0, &[]);
        assert!(sin.is_empty());
    }

    #[test]
    fn el_estado_dice_lo_que_falta() {
        assert_eq!(estado_de(true, false, false), "ok");
        assert_eq!(estado_de(false, true, true), "ok");
        assert_eq!(estado_de(false, true, false), "no_hud");
        assert_eq!(estado_de(false, false, false), "no_minimap");
    }

    fn mmss(s: f64) -> String {
        format!("{}:{:02}", (s / 60.0).floor() as i64, (s.rem_euclid(60.0)) as i64)
    }

    /// La franja de episodios de presión de verdad, para mirarla a ojo:
    /// `MIS_PARTIDAS_DIR=C:/Users/Alejandro/Videos/LeagueRecorder cargo test --lib franja_en_mis_partidas -- --nocapture`
    ///
    /// Además de pintar dos episodios, resume en todas las partidas con HUD
    /// cuánto baja la vida por segundo con 2+ rivales encima frente a sin
    /// ninguno, y a cuánto estaba la vida en cada muerte.
    #[test]
    fn franja_en_mis_partidas() {
        let Ok(dir) = std::env::var("MIS_PARTIDAS_DIR") else { return };
        let mut dirs: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).collect();
        dirs.sort();
        let mut pintados = 0;
        let (mut caida_con, mut n_con, mut caida_sin, mut n_sin) = (0.0, 0usize, 0.0, 0usize);
        let mut en_muerte: Vec<f64> = Vec::new();
        for d in dirs {
            let id = d.file_name().unwrap().to_string_lossy().to_string();
            let (Ok(raw), Ok(rtl), Ok(rmeta), Ok(rp), Ok(rh)) = (
                std::fs::read_to_string(d.join("riot_match.json")),
                std::fs::read_to_string(d.join("riot_timeline.json")),
                std::fs::read_to_string(d.join(format!("{id}.json"))),
                std::fs::read_to_string(d.join("minimap_positions.json")),
                std::fs::read_to_string(d.join(crate::hud::FICHERO)),
            ) else { continue };
            let m: MatchDto = serde_json::from_str(&raw).unwrap();
            let tl: TimelineDto = serde_json::from_str(&rtl).unwrap();
            let meta: crate::storage::MatchMetadata = serde_json::from_str(&rmeta).unwrap();
            let pos = Positions::from_json(&rp).unwrap();
            let Some((fps, hp)) = crate::hud::vida(&rh) else {
                println!("{id}: HUD ilegible");
                continue;
            };
            let yo = pos.self_participant_id;
            let f = Fuentes {
                tl: &tl,
                pid: yo,
                desfase: meta.video_offset.or(Some(pos.video_offset)),
                vida: Some((fps, &hp)),
                pos: Some(&pos),
            };
            let episodios: Vec<_> = crate::pressure::analyse(&tl, &m.info.participants, Some(&pos))
                .into_iter()
                .filter(|w| w.participant_id == yo && w.from_video)
                .collect();
            println!("{id} {} · {} episodios del vídeo", meta.champion, episodios.len());
            for w in &episodios {
                let t0 = std::time::Instant::now();
                let s = franja(&f, w.start, w.end);
                let tarda = t0.elapsed();
                // Caída de vida por segundo entre lecturas seguidas, según los
                // rivales encima en la muestra del minimapa más cercana.
                for par in s.hp.windows(2) {
                    let dt = par[1].0 - par[0].0;
                    if dt <= 0.0 || dt > 0.6 || s.deaths.iter().any(|d| (par[1].0 - d).abs() < 2.0) {
                        continue;
                    }
                    let Some(cerca) = s
                        .near
                        .iter()
                        .filter(|n| (n.0 - par[0].0).abs() <= 0.5)
                        .min_by(|x, y| (x.0 - par[0].0).abs().total_cmp(&(y.0 - par[0].0).abs()))
                    else {
                        continue;
                    };
                    let caida = (par[0].1 - par[1].1) / dt;
                    if cerca.1 >= 2 {
                        caida_con += caida;
                        n_con += 1;
                    } else if cerca.1 == 0 {
                        caida_sin += caida;
                        n_sin += 1;
                    }
                }
                for d in &s.deaths {
                    if let Some(h) = s
                        .hp
                        .iter()
                        .filter(|(t, _)| (t - d).abs() <= 0.5)
                        .map(|(_, h)| *h)
                        .min_by(f64::total_cmp)
                    {
                        en_muerte.push(h);
                    }
                }
                if pintados < 2 && (w.died || episodios.len() == 1) {
                    pintados += 1;
                    println!(
                        "  episodio {}–{} (partida) · {} rivales · muerte {} · vida {} lecturas · minimapa {} muestras · muertes {:?} · {tarda:?}",
                        mmss(w.start), mmss(w.end), w.enemy_count, w.died, s.hp.len(), s.near.len(),
                        s.deaths.iter().map(|t| mmss(*t)).collect::<Vec<_>>()
                    );
                    let mut t = w.start - MARGEN;
                    while t <= w.end + MARGEN {
                        let vida = s.hp.iter().find(|(x, _)| (x - t).abs() < 0.13).map(|(_, h)| format!("{:>4.0}%", h * 100.0));
                        let n = s.near.iter().find(|(x, _, _)| (x - t).abs() < 0.26);
                        let barra = vida.as_ref().map(|_| {
                            let h = s.hp.iter().find(|(x, _)| (x - t).abs() < 0.13).unwrap().1;
                            "#".repeat((h * 20.0).round() as usize)
                        });
                        println!(
                            "    {:>7.2} {} {:<20} rivales {} aliados {}{}",
                            t,
                            vida.unwrap_or_else(|| "   - ".into()),
                            barra.unwrap_or_default(),
                            n.map(|n| n.1.to_string()).unwrap_or("-".into()),
                            n.map(|n| n.2.to_string()).unwrap_or("-".into()),
                            if s.deaths.iter().any(|d| (d - t).abs() < 0.25) { "  ← MUERTE" } else { "" }
                        );
                        t += 0.5;
                    }
                }
            }
        }
        let media = |s: f64, n: usize| if n > 0 { s / n as f64 * 100.0 } else { f64::NAN };
        en_muerte.sort_by(f64::total_cmp);
        println!(
            "\nvida perdida por segundo: con 2+ rivales encima {:.1} %/s ({n_con} pares) · sin rivales {:.1} %/s ({n_sin} pares)",
            media(caida_con, n_con),
            media(caida_sin, n_sin)
        );
        println!(
            "vida en el segundo de cada muerte (mín. a ±0,5 s): {} muertes, {} a ≤5 %, mediana {:.0} %",
            en_muerte.len(),
            en_muerte.iter().filter(|h| **h <= 0.05).count(),
            en_muerte.get(en_muerte.len() / 2).map(|h| h * 100.0).unwrap_or(f64::NAN)
        );
    }
}
