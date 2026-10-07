//! El recorrido completo de una partida, para dibujarlo sobre el minimapa.
//!
//! Inspirado en el «Minimap Recorder» que se compartió por Discord el
//! 2026-10-07: ver al jugador moverse por el mapa toda la partida, y el dibujo
//! que va dejando. Aquí no se captura nada nuevo: todo sale de lo que ya hay.
//!   - Tu posición: `Positions::follow`, dos veces por segundo (el mismo rastro
//!     de la presión y de la ruta de jungla).
//!   - Los demás: los iconos del minimapa, aliados siempre y rivales cuando
//!     estaban a la vista. Una vez por segundo basta para pintarlos.
//!   - Muertes (posición exacta de la API), vueltas a base (compras) y, si
//!     jugaste de jungla, los campamentos de `jungle_route`.
//!
//! Tiempos en segundos de PARTIDA; el vídeo va `video_offset` por delante.

use crate::minimap::Positions;
use crate::riot_api::{MatchDto, TimelineDto};
use serde::Serialize;

/// A menos de esto de tu posición, un icono aliado eres tú: no se repite.
const RADIO_PROPIO: f64 = 400.0;

#[derive(Serialize)]
pub struct OthersFrame {
    pub t: f32,
    /// Aliados `[x, y]`.
    pub a: Vec<[i32; 2]>,
    /// Rivales a la vista `[x, y]`.
    pub e: Vec<[i32; 2]>,
}

#[derive(Serialize)]
pub struct TrackDeath {
    pub t: f64,
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize)]
pub struct Track {
    pub video_offset: f64,
    pub duration: f64,
    pub champion: String,
    /// Tu rastro: `[t, x, y]`.
    pub me: Vec<[f32; 3]>,
    pub others: Vec<OthersFrame>,
    pub clears: Vec<crate::jungle_route::CampClear>,
    pub deaths: Vec<TrackDeath>,
    pub recalls: Vec<f64>,
}

#[derive(Serialize)]
pub struct TrackResponse {
    /// "ok", "no_minimap", "no_riot" o "no_track".
    pub status: String,
    pub track: Option<Track>,
}

pub fn build(tl: &TimelineDto, m: &MatchDto, pos: &Positions) -> Option<Track> {
    let pid = pos.self_participant_id;
    let yo = m.info.participants.get((pid - 1) as usize)?;
    let anclas = crate::minimap::anclas_de(tl, pid);
    let pista = pos.follow(&anclas);
    if pista.is_empty() {
        return None;
    }

    // Los demás, una muestra por segundo, sin tu propio icono.
    let paso = (pos.fps.round() as usize).max(1);
    let mut others = Vec::new();
    for s in pos.samples.iter().step_by(paso) {
        let sec = s.t - pos.video_offset;
        if sec < 0.0 {
            continue;
        }
        let mio = pista
            .get(pista.partition_point(|f| f.sec < sec - 0.3))
            .filter(|f| (f.sec - sec).abs() <= 0.3);
        let mut a = Vec::new();
        let mut e = Vec::new();
        for i in &s.icons {
            match i.team {
                Some(t) if t == pos.self_team_id => {
                    if mio.is_some_and(|f| (f.x - i.x).hypot(f.y - i.y) < RADIO_PROPIO) {
                        continue;
                    }
                    a.push([i.x as i32, i.y as i32]);
                }
                Some(_) => e.push([i.x as i32, i.y as i32]),
                None => {}
            }
        }
        others.push(OthersFrame { t: sec as f32, a, e });
    }

    let muertos = crate::jungle_route::muertes(tl, pid);
    let recalls = crate::jungle_route::visitas_a_base(tl, pid, &muertos)
        .into_iter()
        .filter(|v| !v.2)
        .map(|v| v.0)
        .collect();
    let deaths = muertos
        .iter()
        .filter_map(|(t, _, p)| {
            // Sin posición en el evento, la del rastro en ese instante.
            let (x, y) = p.or_else(|| {
                let f = pista.get(pista.partition_point(|f| f.sec < t - 2.0))?;
                ((f.sec - t).abs() <= 3.0).then_some((f.x, f.y))
            })?;
            Some(TrackDeath { t: *t, x, y })
        })
        .collect();
    let clears = if crate::jungle_route::es_jungla(&m.info.participants, pid) {
        crate::jungle_route::build(tl, &m.info.participants, pos)
            .filter(|r| r.agreement >= crate::jungle_route::ACUERDO_MIN)
            .map(|r| r.clears)
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    Some(Track {
        video_offset: pos.video_offset,
        duration: tl.info.frames.last()?.timestamp as f64 / 1000.0,
        champion: yo.championName.clone(),
        me: pista.iter().map(|f| [f.sec as f32, f.x as f32, f.y as f32]).collect(),
        others,
        clears,
        deaths,
        recalls,
    })
}

/// El recorrido de una partida, si su minimapa está medido.
#[tauri::command]
pub async fn get_match_track(match_id: String) -> TrackResponse {
    tokio::task::spawn_blocking(move || {
        let resp = |s: &str, t| TrackResponse { status: s.to_string(), track: t };
        let (Some(raw), Some(raw_tl)) = (
            crate::storage::load_raw_match(&match_id),
            crate::storage::load_raw_timeline(&match_id),
        ) else {
            return resp("no_riot", None);
        };
        let Some(pos) = Positions::load(&match_id) else { return resp("no_minimap", None) };
        let (Ok(m), Ok(tl)) = (serde_json::from_str::<MatchDto>(&raw), serde_json::from_str::<TimelineDto>(&raw_tl)) else {
            return resp("no_riot", None);
        };
        match build(&tl, &m, &pos) {
            Some(t) => resp("ok", Some(t)),
            None => resp("no_track", None),
        }
    })
    .await
    .unwrap_or(TrackResponse { status: "no_riot".into(), track: None })
}

#[cfg(test)]
mod tests {
    /// `MIS_PARTIDAS_DIR=... cargo test --lib recorrido_en_mis_partidas -- --nocapture`
    #[test]
    fn recorrido_en_mis_partidas() {
        let Ok(dir) = std::env::var("MIS_PARTIDAS_DIR") else { return };
        for d in std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).take(40) {
            let (Ok(raw), Ok(rtl), Ok(rp)) = (
                std::fs::read_to_string(d.join("riot_match.json")),
                std::fs::read_to_string(d.join("riot_timeline.json")),
                std::fs::read_to_string(d.join("minimap_positions.json")),
            ) else { continue };
            let m: super::MatchDto = serde_json::from_str(&raw).unwrap();
            let tl: super::TimelineDto = serde_json::from_str(&rtl).unwrap();
            let pos = super::Positions::from_json(&rp).unwrap();
            let Some(t) = super::build(&tl, &m, &pos) else { continue };
            let json = serde_json::to_string(&t).unwrap();
            let rivales: usize = t.others.iter().map(|o| o.e.len()).sum();
            let aliados: usize = t.others.iter().map(|o| o.a.len()).sum();
            println!(
                "{} {} · {} puntos tuyos · {} s de otros (aliados {:.1}/s, rivales {:.1}/s) · {} muertes · {} bases · {} campamentos · {} KB",
                d.file_name().unwrap().to_string_lossy(), t.champion, t.me.len(), t.others.len(),
                aliados as f64 / t.others.len() as f64, rivales as f64 / t.others.len() as f64,
                t.deaths.len(), t.recalls.len(), t.clears.len(), json.len() / 1024
            );
        }
    }
}

// ------------------------------------------------------------ descarga

/// Recorte del minimapa en la grabación: las mismas fracciones que el
/// detector (`minimap_positions.py`) y que el Recorrido en la interfaz.
const MM: (f64, f64, f64, f64) = (0.787, 0.995, 0.622, 0.972);
const MAPA: f64 = 14870.0;
/// Ancho del vídeo exportado: el minimapa ampliado a algo que se vea.
const ANCHO_EXPORT: f64 = 720.0;
/// Colores de la estela (los del tema oscuro: jade al principio, oro al final).
const JADE: (u8, u8, u8) = (60, 183, 135);
const ORO: (u8, u8, u8) = (200, 170, 110);

/// Color ASS (`&HBBGGRR&`) del instante `t` en el degradado de la partida.
fn color_ass(t: f64, dur: f64) -> String {
    let f = (t / dur.max(1.0)).clamp(0.0, 1.0);
    let m = |a: u8, b: u8| (a as f64 + (b as f64 - a as f64) * f).round() as u8;
    format!("&H{:02X}{:02X}{:02X}&", m(JADE.2, ORO.2), m(JADE.1, ORO.1), m(JADE.0, ORO.0))
}

fn reloj_ass(s: f64) -> String {
    let cs = (s.max(0.0) * 100.0).round() as i64;
    format!("{}:{:02}:{:02}.{:02}", cs / 360000, (cs / 6000) % 60, (cs / 100) % 60, cs % 100)
}

/// Octágono (un círculo a efectos prácticos) como subtrazo de dibujo ASS.
///
/// Se recorre en el MISMO sentido de giro que los cuadriláteros de
/// `segmento` (ángulo decreciente con la y hacia abajo). libass rellena con
/// la regla del devanado: dos subtrazos de giro opuesto que se solapan se
/// anulan, y la estela salía punteada, con un agujero en cada codo.
fn octogono(x: f64, y: f64, r: f64) -> String {
    let mut s = String::new();
    for k in 0..8 {
        let a = -std::f64::consts::PI * 2.0 * k as f64 / 8.0;
        s.push_str(&format!("{} {:.1} {:.1} ", if k == 0 { "m" } else { "l" }, x + r * a.cos(), y + r * a.sin()));
    }
    s
}

/// Un segmento grueso (un cuadrilátero) como subtrazo de dibujo ASS.
fn segmento(a: (f64, f64), b: (f64, f64), w: f64) -> String {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let l = dx.hypot(dy).max(1e-6);
    let (nx, ny) = (-dy / l * w / 2.0, dx / l * w / 2.0);
    format!(
        "m {:.1} {:.1} l {:.1} {:.1} l {:.1} {:.1} l {:.1} {:.1} ",
        a.0 + nx, a.1 + ny, b.0 + nx, b.1 + ny, b.0 - nx, b.1 - ny, a.0 - nx, a.1 - ny
    )
}

/// La estela como subtítulos ASS de dibujo vectorial, en el reloj del trozo
/// exportado (0 = `desde`). Cada trozo de `paso` segundos de partida es UN
/// evento con todos sus segmentos: con uno por segmento libass tendría que
/// componer miles de piezas por fotograma al final de la partida.
fn estela_ass(tr: &Track, desde: f64, hasta: f64, modo: &str, ow: f64, oh: f64, paso: f64) -> String {
    let px = |x: f64, y: f64| (x / MAPA * ow, (1.0 - y / MAPA) * oh);
    let fin_total = hasta - desde;
    let ancho = (ow / 150.0).max(2.5);
    let mut ev = String::new();
    let mut emitir = |capa: u8, ini: f64, color: &str, alfa: &str, dibujo: &str| {
        let fin = if modo == "recent" { (ini + 30.0).min(fin_total) } else { fin_total };
        if fin > ini && !dibujo.is_empty() {
            ev.push_str(&format!(
                "Dialogue: {capa},{},{},L,,0,0,0,,{{\\an7\\pos(0,0)\\bord0\\shad0\\1c{color}\\1a&H{alfa}&\\p1}}{dibujo}{{\\p0}}\n",
                reloj_ass(ini),
                reloj_ass(fin)
            ));
        }
    };

    // Trozos de la estela.
    let pts: Vec<&[f32; 3]> = tr.me.iter().filter(|p| (p[0] as f64) >= desde && (p[0] as f64) <= hasta).collect();
    let mut i = 0;
    while i + 1 < pts.len() {
        let t_ini = pts[i][0] as f64;
        let (mut halo, mut trazo) = (String::new(), String::new());
        let mut j = i;
        while j + 1 < pts.len() && (pts[j + 1][0] as f64) - t_ini <= paso {
            let (p, q) = (pts[j], pts[j + 1]);
            let roto = (q[0] - p[0]) as f64 > 8.0 || ((q[1] - p[1]) as f64).hypot((q[2] - p[2]) as f64) > 2500.0;
            if !roto {
                let (a, b) = (px(p[1] as f64, p[2] as f64), px(q[1] as f64, q[2] as f64));
                halo.push_str(&segmento(a, b, ancho * 2.0));
                halo.push_str(&octogono(b.0, b.1, ancho));
                trazo.push_str(&segmento(a, b, ancho));
                trazo.push_str(&octogono(b.0, b.1, ancho / 2.0));
            }
            j += 1;
        }
        if j == i {
            j += 1;
        }
        let t_fin = pts[j.min(pts.len() - 1)][0] as f64 - desde;
        emitir(0, t_fin, "&H18100B&", "A0", &halo);
        emitir(1, t_fin, &color_ass(pts[i][0] as f64, tr.duration), "30", &trazo);
        i = j;
    }

    // Campamentos y muertes, como en pantalla.
    let donde = |s: f64| tr.me.iter().rev().find(|p| (p[0] as f64) <= s).filter(|p| s - (p[0] as f64) < 8.0);
    for c in tr.clears.iter().filter(|c| c.start >= desde && c.start <= hasta) {
        if let Some(p) = donde((c.start + c.end) / 2.0) {
            let (x, y) = px(p[1] as f64, p[2] as f64);
            let color = match c.side.as_str() {
                "own" => "&H87B73C&",
                "enemy" => "&H7360F2&",
                _ => "&HF189A5&",
            };
            emitir(2, c.start - desde, color, "10", &octogono(x, y, ancho * 1.6));
        }
    }
    for d in tr.deaths.iter().filter(|d| d.t >= desde && d.t <= hasta) {
        let (x, y) = px(d.x, d.y);
        let r = ancho * 2.5;
        let dibujo = segmento((x - r, y - r), (x + r, y + r), ancho * 1.2) + &segmento((x + r, y - r), (x - r, y + r), ancho * 1.2);
        emitir(3, d.t - desde, "&H7360F2&", "00", &dibujo);
    }

    let cabecera = format!(
        "[Script Info]\nScriptType: v4.00+\nPlayResX: {ow:.0}\nPlayResY: {oh:.0}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n\
         [V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n\
         Style: L,Arial,20,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1\n\n\
         [Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    );
    cabecera + &ev
}

/// Exporta el minimapa de la grabación, con tu estela, acelerado `speed`
/// veces, entre los segundos de PARTIDA `from` y `to`. Devuelve la ruta del
/// MP4 (en la carpeta de la partida). Progreso en `route_export_progress`.
///
/// Todo es ffmpeg: recorte del minimapa, ampliación, la estela como
/// subtítulos ASS de dibujo (`ass`, libass va en el ffmpeg empaquetado),
/// `setpts` para acelerar y H.264. Un AV1 se decodifica por GPU (`d3d11va`),
/// como hace el detector de minimapa: por CPU iba a ~1,4× tiempo real.
#[tauri::command]
pub async fn export_route_video(
    app: tauri::AppHandle,
    match_id: String,
    speed: f64,
    from: f64,
    to: f64,
    trail: String,
) -> Result<String, String> {
    use std::io::{BufRead, BufReader};
    use tauri::Emitter;
    tokio::task::spawn_blocking(move || {
        let meta = crate::storage::get_match_metadata(&match_id)?;
        if !std::path::Path::new(&meta.video_path).exists() {
            return Err("El vídeo de esta partida ya no está.".to_string());
        }
        let offset = meta.video_offset.unwrap_or(0.0);
        let raw = crate::storage::load_raw_match(&match_id).ok_or("Falta la partida de Riot")?;
        let raw_tl = crate::storage::load_raw_timeline(&match_id).ok_or("Falta la línea de tiempo de Riot")?;
        let m: MatchDto = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        let tl: TimelineDto = serde_json::from_str(&raw_tl).map_err(|e| e.to_string())?;
        let pos = Positions::load(&match_id).ok_or("Mide antes el minimapa de esta partida con vídeo")?;
        let tr = build(&tl, &m, &pos).ok_or("No se pudo seguir tu icono en el minimapa")?;

        let ffmpeg = crate::proc::ffmpeg(&app);
        let (w, h, _) = crate::proc::video_info(&ffmpeg, &meta.video_path).ok_or("No se pudo leer el vídeo")?;
        let speed = speed.clamp(1.0, 64.0);
        let desde = from.max(0.0);
        let hasta = to.min(tr.duration);
        if hasta - desde < 5.0 {
            return Err("El tramo elegido es demasiado corto".to_string());
        }
        let x0 = (w * MM.0) as i64;
        let y0 = (h * MM.2) as i64;
        let cw = ((w * MM.1) as i64 - x0) / 2 * 2;
        let ch = ((h * MM.3) as i64 - y0) / 2 * 2;
        let ow = ANCHO_EXPORT;
        let oh = ((ow * ch as f64 / cw as f64) / 2.0).round() * 2.0;

        let dir = crate::storage::get_match_dir(&match_id);
        let nombre_ass = "recorrido_estela.ass";
        let paso = (speed / 8.0).clamp(1.0, 4.0);
        let ass = if trail == "off" { String::new() } else { estela_ass(&tr, desde, hasta, &trail, ow, oh, paso) };
        let destino = dir.join(format!(
            "{}_recorrido_{}x_{}-{}.mp4",
            match_id,
            speed as i64,
            (desde / 60.0).floor() as i64,
            (hasta / 60.0).ceil() as i64
        ));
        // `fps` lo PRIMERO: a 16× sólo hacen falta ~1,9 fotogramas por segundo
        // de partida, y recortar, escalar y pintar la estela sobre los 60 de la
        // grabación era 30 veces más trabajo (medido: >10 min frente a 2,5 min
        // en una partida de 33 min, 1080p H.264).
        let mut filtros = format!("fps={:.4},crop={cw}:{ch}:{x0}:{y0},scale={ow:.0}:{oh:.0}:flags=lanczos", 30.0 / speed);
        if !ass.is_empty() {
            std::fs::write(dir.join(nombre_ass), &ass).map_err(|e| e.to_string())?;
            filtros.push_str(&format!(",ass={nombre_ass}"));
        }
        filtros.push_str(&format!(",setpts=PTS/{speed},fps=30"));

        // ¿AV1? Entonces a la GPU, como el detector de minimapa.
        let es_av1 = crate::proc::hide_console(std::process::Command::new(&ffmpeg).args(["-hide_banner", "-i", meta.video_path.as_str()]))
            .output()
            .map(|o| String::from_utf8_lossy(&o.stderr).contains("Video: av1"))
            .unwrap_or(false);
        let mut cmd = std::process::Command::new(&ffmpeg);
        cmd.current_dir(&dir).args(["-y", "-hide_banner", "-nostats", "-progress", "pipe:1"]);
        if es_av1 {
            cmd.args(["-hwaccel", "d3d11va"]);
        }
        cmd.args(["-ss", &format!("{:.3}", desde + offset), "-to", &format!("{:.3}", hasta + offset), "-i", meta.video_path.as_str()])
            .args(["-vf", filtros.as_str(), "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart"])
            .arg(&destino)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        crate::proc::hide_console(&mut cmd);
        let mut hijo = cmd.spawn().map_err(|e| format!("No se pudo lanzar ffmpeg: {e}"))?;
        let total_us = (hasta - desde) / speed * 1e6;
        if let Some(out) = hijo.stdout.take() {
            for l in BufReader::new(out).lines().map_while(Result::ok) {
                if let Some(v) = l.strip_prefix("out_time_us=").and_then(|v| v.trim().parse::<f64>().ok()) {
                    let _ = app.emit("route_export_progress", (match_id.clone(), (100.0 * v / total_us).clamp(0.0, 99.0)));
                }
            }
        }
        let salida = hijo.wait_with_output().map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(dir.join(nombre_ass));
        if !salida.status.success() {
            let err = String::from_utf8_lossy(&salida.stderr);
            let cola: Vec<&str> = err.lines().rev().take(4).collect();
            return Err(format!("ffmpeg falló: {}", cola.into_iter().rev().collect::<Vec<_>>().join(" | ")));
        }
        let _ = app.emit("route_export_progress", (match_id.clone(), 100.0));
        Ok(destino.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests_export {
    use super::*;

    #[test]
    fn estela_ass_bien_formada() {
        let tr = Track {
            video_offset: 0.0,
            duration: 100.0,
            champion: "Gwen".into(),
            me: (0..40).map(|i| [i as f32 * 0.5, 1000.0 + i as f32 * 100.0, 2000.0]).collect(),
            others: vec![],
            clears: vec![],
            deaths: vec![TrackDeath { t: 10.0, x: 3000.0, y: 2000.0 }],
            recalls: vec![],
        };
        let ass = estela_ass(&tr, 0.0, 20.0, "sofar", 720.0, 684.0, 2.0);
        assert!(ass.starts_with("[Script Info]"));
        let eventos = ass.lines().filter(|l| l.starts_with("Dialogue:")).count();
        // 40 puntos en 19,5 s, trozos de 2 s: ~10 trozos × (halo + trazo) + 1 muerte.
        assert!((18..=24).contains(&eventos), "{eventos}");
        assert!(ass.contains("\\p1}m "));
        assert_eq!(reloj_ass(61.5), "0:01:01.50");
        assert_eq!(color_ass(0.0, 100.0), "&H87B73C&");
    }
}

#[cfg(test)]
mod tests_export_real {
    /// Escribe la estela ASS de una partida real para probar ffmpeg a mano:
    /// `RUTA_PARTIDA=<carpeta> RUTA_ASS=<fichero> cargo test --lib ass_de_verdad`
    #[test]
    fn ass_de_verdad() {
        let (Ok(d), Ok(sal)) = (std::env::var("RUTA_PARTIDA"), std::env::var("RUTA_ASS")) else { return };
        let d = std::path::Path::new(&d);
        let m: super::MatchDto = serde_json::from_str(&std::fs::read_to_string(d.join("riot_match.json")).unwrap()).unwrap();
        let tl: super::TimelineDto = serde_json::from_str(&std::fs::read_to_string(d.join("riot_timeline.json")).unwrap()).unwrap();
        let pos = super::Positions::from_json(&std::fs::read_to_string(d.join("minimap_positions.json")).unwrap()).unwrap();
        let tr = super::build(&tl, &m, &pos).unwrap();
        let ass = super::estela_ass(&tr, 0.0, tr.duration, "sofar", 720.0, 684.0, 2.0);
        std::fs::write(&sal, &ass).unwrap();
        println!("offset {} duracion {} eventos {}", pos.video_offset, tr.duration, ass.lines().filter(|l| l.starts_with("Dialogue")).count());
    }
}
