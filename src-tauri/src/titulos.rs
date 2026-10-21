//! Un título para cada uno de los diez del marcador: la métrica en la que más
//! se salió de lo normal. Fila 3.6 de `docs/coach-de-macro-diseno.md`.
//!
//! El marcador dice cuánto hizo cada uno (KDA, CS, oro), pero no qué tuvo de
//! raro su partida. El título sale de los mismos deciles que «Frente a tu
//! rango» (`crate::benchmarks`, por puesto y franja de rango), más una métrica
//! que el baremo no tiene y el coach sí mira: las muertes con el jungla rival
//! encima (`MUERTES_AL_JUNGLA`, de `titulos_baremos.rs`).
//!
//! Dos reglas:
//! - Sólo cuenta un extremo de verdad: percentil 90 o más, o 10 o menos. Quien
//!   no tiene ninguno se queda sin título (`metric: None`, «Sin
//!   estridencias»), que también dice algo.
//! - No se repite título en la partida. Si dos salen «El banquero», se lo
//!   queda el más extremo y el otro pasa a su siguiente métrica.
//!
//! El texto de cada título vive en la UI (`core/titles.ts`), con su traducción:
//! aquí sólo se elige la métrica y el lado.

use serde::Serialize;

use crate::benchmarks::{self, METRICAS};

/// La métrica que no está en `benchmarks`: muertes en las que el jungla rival
/// mató o asistió. No se mide a los junglas: para ellos el jungla rival es su
/// rival de línea, y eso ya lo dicen las diferencias al 15.
pub const JUNGLA: &str = "jungler_deaths";

/// Percentil a partir del cual una métrica es un extremo.
const EXTREMO: f64 = 10.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Lado {
    High,
    Low,
}
use Lado::{High, Low};

/// Los títulos posibles: (métrica, lado). El orden desempata: con dos
/// métricas igual de extremas (las dos en el percentil 100, por ejemplo) gana
/// la que va antes. Van primero las que dicen algo de cómo se jugó, y al final
/// las que sólo cuentan cuánto.
///
/// Faltan a propósito algunos lados bajos: no haber hecho solo kills, ni
/// daño a torres, ni centinelas de control es lo normal en varios puestos y no
/// distingue a nadie.
pub const TITULOS: &[(&str, Lado)] = &[
    ("kill_participation", Low),
    (JUNGLA, High),
    ("deaths_per_game", High),
    ("deaths_per_game", Low),
    ("gold_diff_15", High),
    ("gold_diff_15", Low),
    ("damage_share", High),
    ("kill_participation", High),
    ("vision_score_per_min", High),
    ("vision_score_per_min", Low),
    ("solo_kills", High),
    ("turret_damage_per_min", High),
    ("cs_per_min", High),
    ("cs_per_min", Low),
    ("damage_per_min", High),
    ("damage_per_min", Low),
    ("kda", High),
    ("kda", Low),
    ("xp_diff_15", High),
    ("xp_diff_15", Low),
    ("cs_diff_15", High),
    ("cs_diff_15", Low),
    ("gold_per_min", High),
    ("gold_per_min", Low),
    ("kills_per_game", High),
    ("assists_per_game", High),
    ("wards_per_min", High),
    ("control_wards", High),
    ("damage_share", Low),
];

/// Lo que se sabe de un jugador para darle título.
#[derive(Debug, Clone, Default)]
pub struct Jugador {
    /// 1-10.
    pub participant_id: i32,
    pub role: String,
    pub valores: Vec<(&'static str, f64)>,
}

impl Jugador {
    fn valor(&self, metric: &str) -> Option<f64> {
        self.valores.iter().find(|(m, _)| *m == metric).map(|(_, v)| *v)
    }
}

/// El título de un jugador.
#[derive(Debug, Clone, Serialize)]
pub struct Titulo {
    pub participant_id: i32,
    /// Puesto con el que se comparó.
    pub role: String,
    /// `None`: ninguna métrica llegó a un extremo.
    pub metric: Option<String>,
    pub side: Option<Lado>,
    pub value: Option<f64>,
    /// 0-100, entre los de su puesto (y su franja, si se sabe).
    pub percentile: Option<f64>,
}

fn deciles(metric: &str, band: Option<&str>, role: &str) -> Option<[f64; 9]> {
    if metric == JUNGLA {
        return crate::titulos_baremos::MUERTES_AL_JUNGLA.iter().find(|(r, _)| *r == role).map(|(_, d)| *d);
    }
    benchmarks::deciles(metric, band, role)
}

/// Elige un título para cada jugador. Devuelve uno por jugador, en su orden.
pub fn elegir(jugadores: &[Jugador], band: Option<&str>) -> Vec<Titulo> {
    // Todos los extremos de todos, del más extremo al menos.
    let mut candidatos: Vec<(f64, usize, usize, f64, f64)> = Vec::new();
    for (j, jug) in jugadores.iter().enumerate() {
        for (k, (metric, lado)) in TITULOS.iter().enumerate() {
            let (Some(v), Some(cortes)) = (jug.valor(metric), deciles(metric, band, &jug.role)) else { continue };
            let p = benchmarks::interpolar(&cortes, v);
            let extremo = match lado {
                High => p >= 100.0 - EXTREMO,
                Low => p <= EXTREMO,
            };
            if extremo {
                candidatos.push(((p - 50.0).abs(), k, j, v, p));
            }
        }
    }
    candidatos.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));

    let mut out: Vec<Titulo> = jugadores
        .iter()
        .map(|j| Titulo {
            participant_id: j.participant_id,
            role: j.role.clone(),
            metric: None,
            side: None,
            value: None,
            percentile: None,
        })
        .collect();
    let mut usados = vec![false; TITULOS.len()];
    for (_, k, j, v, p) in candidatos {
        if usados[k] || out[j].metric.is_some() {
            continue;
        }
        usados[k] = true;
        let (metric, lado) = TITULOS[k];
        out[j] = Titulo { metric: Some(metric.to_string()), side: Some(lado), value: Some(v), percentile: Some(p), ..out[j].clone() };
    }
    out
}

/// Muertes de cada participante (índice 0-9) con el jungla rival como asesino
/// o asistente. `None` para los junglas y si el rival no tiene un único jungla.
pub(crate) fn muertes_al_jungla(d: &serde_json::Value) -> [Option<f64>; 10] {
    let mut out = [None; 10];
    let Some(ps) = d["match"]["info"]["participants"].as_array().filter(|ps| ps.len() == 10) else { return out };
    let equipo = |i: usize| ps[i]["teamId"].as_i64().unwrap_or(0);
    let puesto = |i: usize| ps[i]["teamPosition"].as_str().unwrap_or("");
    let jungla_rival = |i: usize| -> Option<i64> {
        let js: Vec<usize> = (0..10).filter(|j| equipo(*j) != equipo(i) && puesto(*j) == "JUNGLE").collect();
        let &[j] = &js[..] else { return None };
        Some(j as i64 + 1)
    };
    let eventos: Vec<&serde_json::Value> = d["timeline"]["info"]["frames"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|f| f["events"].as_array().into_iter().flatten())
        .filter(|e| e["type"] == "CHAMPION_KILL")
        .collect();
    for (i, o) in out.iter_mut().enumerate() {
        if puesto(i) == "JUNGLE" || !benchmarks::ROLES.contains(&puesto(i)) {
            continue;
        }
        let Some(jr) = jungla_rival(i) else { continue };
        let pid = i as i64 + 1;
        let n = eventos
            .iter()
            .filter(|e| e["victimId"].as_i64() == Some(pid))
            .filter(|e| {
                e["killerId"].as_i64() == Some(jr)
                    || e["assistingParticipantIds"].as_array().is_some_and(|a| a.iter().any(|x| x.as_i64() == Some(jr)))
            })
            .count();
        *o = Some(n as f64);
    }
    out
}

/// Los jugadores con sus métricas, de una partida con la forma del corpus
/// (`{match, timeline}`). Vacío si la partida no tiene 15 minutos.
pub(crate) fn jugadores(d: &serde_json::Value) -> Vec<Jugador> {
    let jungla = muertes_al_jungla(d);
    benchmarks::metricas_de_partida(d)
        .into_iter()
        .map(|(i, role, vals)| {
            let mut valores: Vec<(&'static str, f64)> =
                METRICAS.iter().zip(vals).filter_map(|(m, v)| Some((*m, v?))).collect();
            if let Some(n) = jungla[i] {
                valores.push((JUNGLA, n));
            }
            Jugador { participant_id: i as i32 + 1, role, valores }
        })
        .collect()
}

fn calcular(match_id: &str) -> Result<Vec<Titulo>, String> {
    let meta = crate::storage::get_match_metadata(match_id)?;
    let (Some(raw), Some(raw_tl)) =
        (crate::storage::load_raw_match(match_id), crate::storage::load_raw_timeline(match_id))
    else {
        return Err("Esta partida aún no está sincronizada con Riot".to_string());
    };
    let m: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("riot_match.json ilegible: {e}"))?;
    let tl: serde_json::Value =
        serde_json::from_str(&raw_tl).map_err(|e| format!("riot_timeline.json ilegible: {e}"))?;
    let d = serde_json::json!({ "match": m, "timeline": tl });
    Ok(elegir(&jugadores(&d), meta.tier_bucket.as_deref()))
}

/// Los títulos de los diez de una partida sincronizada. Vacío en una partida
/// de menos de 15 minutos, que no se compara con el baremo.
#[tauri::command]
pub async fn get_match_titles(match_id: String) -> Result<Vec<Titulo>, String> {
    tokio::task::spawn_blocking(move || calcular(&match_id)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Un jugador con la mediana de su puesto en todo, salvo lo que se pida.
    fn mediano(pid: i32, role: &str, cambios: &[(&'static str, f64)]) -> Jugador {
        let mut valores: Vec<(&'static str, f64)> =
            METRICAS.iter().map(|m| (*m, benchmarks::median(m, None, role).unwrap())).collect();
        for (m, v) in cambios {
            match valores.iter_mut().find(|(x, _)| x == m) {
                Some(par) => par.1 = *v,
                None => valores.push((*m, *v)),
            }
        }
        Jugador { participant_id: pid, role: role.into(), valores }
    }

    #[test]
    fn el_titulo_es_la_metrica_mas_extrema() {
        // 9,5 de CS por minuto es más que el decil 9 de un mid (8,04); 0,30 de
        // participación queda en su decil 2. Sólo lo primero es un extremo.
        let t = elegir(&[mediano(3, "MIDDLE", &[("cs_per_min", 9.5), ("kill_participation", 0.30)])], None);
        assert_eq!(t[0].metric.as_deref(), Some("cs_per_min"));
        assert_eq!(t[0].side, Some(High));
        assert!(t[0].percentile.unwrap() >= 90.0);
        // Con las dos fuera, la más lejos del medio.
        let t = elegir(&[mediano(3, "MIDDLE", &[("cs_per_min", 8.2), ("kill_participation", 0.10)])], None);
        assert_eq!((t[0].metric.as_deref(), t[0].side), (Some("kill_participation"), Some(Low)));
    }

    #[test]
    fn sin_extremos_no_hay_titulo() {
        let t = elegir(&[mediano(1, "TOP", &[]), mediano(6, "TOP", &[])], None);
        assert!(t.iter().all(|x| x.metric.is_none() && x.side.is_none()));
        assert_eq!(t.iter().map(|x| x.participant_id).collect::<Vec<_>>(), [1, 6]);
    }

    #[test]
    fn el_lado_bajo_de_las_muertes_es_morir_poco() {
        let t = elegir(&[mediano(2, "JUNGLE", &[("deaths_per_game", 0.0)])], None);
        assert_eq!((t[0].metric.as_deref(), t[0].side), (Some("deaths_per_game"), Some(Low)));
        let t = elegir(&[mediano(2, "JUNGLE", &[("deaths_per_game", 15.0)])], None);
        assert_eq!((t[0].metric.as_deref(), t[0].side), (Some("deaths_per_game"), Some(High)));
    }

    #[test]
    fn no_se_repite_titulo_en_la_partida() {
        // Los dos tiradores son los que más oro hacen, pero el 4 mucho más: el
        // banquero es él, y el 9 pasa a su siguiente extremo.
        let t = elegir(
            &[
                mediano(4, "BOTTOM", &[("gold_per_min", 700.0)]),
                mediano(9, "BOTTOM", &[("gold_per_min", 600.0), ("wards_per_min", 0.6)]),
            ],
            None,
        );
        assert_eq!(t[0].metric.as_deref(), Some("gold_per_min"));
        assert_eq!(t[1].metric.as_deref(), Some("wards_per_min"));
        // Sin otro extremo, se queda sin título antes que repetir.
        let t = elegir(
            &[mediano(4, "BOTTOM", &[("gold_per_min", 700.0)]), mediano(9, "BOTTOM", &[("gold_per_min", 600.0)])],
            None,
        );
        assert_eq!((t[0].metric.as_deref(), t[1].metric.as_deref()), (Some("gold_per_min"), None));
    }

    #[test]
    fn a_igual_extremo_desempata_el_orden_del_catalogo() {
        // 100 en daño por minuto y en asesinatos: el daño va antes.
        let t = elegir(&[mediano(5, "MIDDLE", &[("damage_per_min", 3000.0), ("kills_per_game", 40.0)])], None);
        assert_eq!(t[0].metric.as_deref(), Some("damage_per_min"));
    }

    #[test]
    fn el_rango_cambia_el_baremo() {
        // 7,5 de CS por minuto es el decil 9 largo de un mid en bajo (7,13) y
        // la mediana pasada en alto (7,20): extremo en un tramo, no en el otro.
        let j = [mediano(3, "MIDDLE", &[("cs_per_min", 7.5)])];
        assert_eq!(elegir(&j, Some("bajo"))[0].metric.as_deref(), Some("cs_per_min"));
        assert_eq!(elegir(&j, Some("alto"))[0].metric, None);
    }

    #[test]
    fn cada_titulo_tiene_su_baremo_y_ninguno_se_repite() {
        for (i, (m, lado)) in TITULOS.iter().enumerate() {
            assert!(*m == JUNGLA || METRICAS.contains(m), "{m}: no está en el baremo");
            assert!(!TITULOS[..i].contains(&(*m, *lado)), "{m} {lado:?} repetido");
        }
        assert_eq!(crate::titulos_baremos::MUERTES_AL_JUNGLA.len(), 4, "titulos_baremos.rs está sin generar: TITULOS_ESCRIBIR=1");
    }

    /// Una partida de 20 minutos con el formato del corpus, sin eventos.
    fn partida(eventos: Vec<serde_json::Value>) -> serde_json::Value {
        const PUESTOS: [&str; 5] = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
        let ps: Vec<serde_json::Value> = (0..10)
            .map(|i| json!({ "teamId": if i < 5 { 100 } else { 200 }, "teamPosition": PUESTOS[i % 5], "deaths": 0 }))
            .collect();
        json!({
            "match": { "info": { "gameDuration": 1200, "participants": ps } },
            "timeline": { "info": { "frames": [{ "timestamp": 0, "events": eventos, "participantFrames": {} }] } },
        })
    }

    fn muerte(victima: i64, asesino: i64, asistentes: &[i64]) -> serde_json::Value {
        json!({ "type": "CHAMPION_KILL", "victimId": victima, "killerId": asesino, "assistingParticipantIds": asistentes })
    }

    #[test]
    fn las_muertes_al_jungla_cuentan_asesino_y_asistencias() {
        // El jungla rival del mid azul (3) es el 7. Le mata él, le mata su mid
        // con él de asistente, y le mata el mid rival solo.
        let d = partida(vec![muerte(3, 7, &[]), muerte(3, 8, &[7]), muerte(3, 8, &[]), muerte(1, 7, &[8])]);
        let n = muertes_al_jungla(&d);
        assert_eq!(n[2], Some(2.0));
        assert_eq!(n[0], Some(1.0));
        assert_eq!(n[3], Some(0.0));
        // A los junglas no se les mide.
        assert_eq!((n[1], n[6]), (None, None));
    }

    #[test]
    fn sin_un_unico_jungla_rival_no_se_mide() {
        let mut d = partida(vec![muerte(3, 7, &[])]);
        d["match"]["info"]["participants"][5]["teamPosition"] = json!("JUNGLE");
        assert_eq!(muertes_al_jungla(&d)[2], None);
    }

    #[test]
    fn una_partida_de_menos_de_15_minutos_no_tiene_jugadores() {
        let mut d = partida(vec![]);
        d["match"]["info"]["gameDuration"] = json!(840);
        assert!(jugadores(&d).is_empty());
    }

    /// Los títulos de tus últimas partidas, para mirarlos contra el marcador.
    ///
    /// `LR_REAL=1 cargo test --release --lib titulos::tests::titulos_en_mis_partidas -- --nocapture`
    #[test]
    fn titulos_en_mis_partidas() {
        if std::env::var("LR_REAL").is_err() {
            return;
        }
        for meta in crate::storage::load_all_matches().iter().filter(|m| crate::coach::cuenta(m)).take(6) {
            let Ok(ts) = calcular(&meta.id) else { continue };
            println!("\n{} ({:?})", meta.id, meta.tier_bucket);
            for t in ts {
                let p = meta.participants.get((t.participant_id - 1) as usize);
                println!(
                    "  {:2} {:12} {:8} {:24} {:>8} p{}",
                    t.participant_id,
                    p.map(|p| p.champion.as_str()).unwrap_or("?"),
                    t.role,
                    t.metric.as_deref().map(|m| format!("{m} {:?}", t.side.unwrap())).unwrap_or("—".into()),
                    t.value.map(|v| format!("{v:.2}")).unwrap_or_default(),
                    t.percentile.map(|p| format!("{p:.0}")).unwrap_or_default(),
                );
            }
        }
    }

    /// Los deciles de las muertes al jungla por puesto, sobre el corpus.
    ///
    /// `CORPUS_DIR=D:/lol-corpus [TITULOS_ESCRIBIR=1] cargo test --release --lib titulos::tests::baremos_de_los_titulos -- --nocapture`
    #[test]
    fn baremos_de_los_titulos() {
        use std::collections::HashMap;
        use std::io::Read;
        let Ok(corpus) = std::env::var("CORPUS_DIR") else { return };
        let mut ficheros: Vec<std::path::PathBuf> = std::fs::read_dir(format!("{corpus}/partidas"))
            .into_iter()
            .flatten()
            .flatten()
            .flat_map(|d| std::fs::read_dir(d.path()).into_iter().flatten().flatten().map(|f| f.path()))
            .collect();
        ficheros.sort();
        let hilos = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        // Por puesto: las muertes al jungla y, para ver qué títulos salen, el
        // título de cada jugador con la franja desconocida.
        type Acc = (HashMap<String, Vec<f64>>, HashMap<String, usize>, usize, usize);
        let (mut por_rol, titulos, partidas, jugadores_total): Acc = std::thread::scope(|s| {
            let manos: Vec<_> = ficheros
                .chunks(ficheros.len().div_ceil(hilos).max(1))
                .map(|trozo| {
                    s.spawn(move || {
                        let mut acc: Acc = Default::default();
                        for f in trozo {
                            let Ok(bytes) = std::fs::read(f) else { continue };
                            let mut texto = String::new();
                            if flate2::read::GzDecoder::new(&bytes[..]).read_to_string(&mut texto).is_err() {
                                continue;
                            }
                            let Ok(d) = serde_json::from_str::<serde_json::Value>(&texto) else { continue };
                            let js = jugadores(&d);
                            if js.is_empty() {
                                continue;
                            }
                            acc.2 += 1;
                            for j in &js {
                                if let Some(v) = j.valor(JUNGLA) {
                                    acc.0.entry(j.role.clone()).or_default().push(v);
                                }
                            }
                            for t in elegir(&js, None) {
                                acc.3 += 1;
                                let k = match (t.metric, t.side) {
                                    (Some(m), Some(l)) => format!("{m} {l:?}"),
                                    _ => "(sin título)".into(),
                                };
                                *acc.1.entry(k).or_default() += 1;
                            }
                        }
                        acc
                    })
                })
                .collect();
            let mut total: Acc = Default::default();
            for m in manos {
                let (a, b, c, d) = m.join().unwrap();
                for (k, v) in a {
                    total.0.entry(k).or_default().extend(v);
                }
                for (k, v) in b {
                    *total.1.entry(k).or_default() += v;
                }
                total.2 += c;
                total.3 += d;
            }
            total
        });
        if partidas < 50 {
            println!("corpus demasiado pequeño ({partidas} partidas), no se comprueba");
            return;
        }

        let mut texto = format!(
            "//! Deciles de las métricas de los títulos (`crate::titulos`) que no están en\n\
             //! `crate::benchmarks`.\n\
             //!\n\
             //! GENERADO por `titulos::tests::baremos_de_los_titulos` sobre `{corpus}`\n\
             //! ({partidas} partidas de 15 minutos o más). No editar a mano: con\n\
             //! `TITULOS_ESCRIBIR=1` el test lo reescribe, y sin él comprueba que sigue\n\
             //! cuadrando con el corpus.\n\
             //!\n\
             //!     CORPUS_DIR=D:/lol-corpus TITULOS_ESCRIBIR=1 cargo test --release --lib titulos::tests::baremos_de_los_titulos -- --nocapture\n\n\
             /// Puesto → deciles (10 % … 90 %) de las muertes con el jungla rival como\n\
             /// asesino o asistente. Sin los junglas.\n\
             pub(crate) const MUERTES_AL_JUNGLA: &[(&str, [f64; 9])] = &[\n"
        );
        let mut nuevos: Vec<(String, [f64; 9])> = Vec::new();
        for r in benchmarks::ROLES {
            let Some(v) = por_rol.get_mut(r) else { continue };
            v.sort_by(f64::total_cmp);
            let d: [f64; 9] = std::array::from_fn(|q| v[v.len() * (q + 1) / 10]);
            texto.push_str(&format!(
                "    (\"{r}\", [{}]),   // n={}\n",
                d.iter().map(|x| format!("{x:.1}")).collect::<Vec<_>>().join(", "),
                v.len()
            ));
            nuevos.push((r.to_string(), d));
        }
        texto.push_str("];\n");
        println!("\n{texto}");

        // Qué títulos salen y cuántos se quedan sin ninguno.
        let mut lista: Vec<(&String, &usize)> = titulos.iter().collect();
        lista.sort_by(|a, b| b.1.cmp(a.1));
        println!("{jugadores_total} jugadores:");
        for (k, n) in lista {
            println!("  {k:32} {:.1}%", 100.0 * *n as f64 / jugadores_total as f64);
        }

        if std::env::var("TITULOS_ESCRIBIR").is_ok() {
            let ruta = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/titulos_baremos.rs");
            std::fs::write(&ruta, &texto).unwrap();
            println!("escrito {}", ruta.display());
            return;
        }
        let desviados: Vec<String> = nuevos
            .iter()
            .filter(|(r, d)| crate::titulos_baremos::MUERTES_AL_JUNGLA.iter().find(|(x, _)| x == r).map(|(_, c)| c) != Some(d))
            .map(|(r, d)| format!("{r}: {d:?}"))
            .collect();
        assert!(desviados.is_empty(), "los deciles de los títulos se han quedado desfasados:\n{}", desviados.join("\n"));
    }
}
