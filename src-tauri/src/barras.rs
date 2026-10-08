//! Las barras de vida sobre los campeones: dónde está cada uno en pantalla.
//!
//! Las lee `python_scripts/barras.py` en ventanas cortas del vídeo (ver su
//! docstring) y quedan en `barras.json`. Se usan para dos cosas:
//!
//! - **La línea de fuego** de cada pelea que te empiezan ([`crate::golpes`]):
//!   hacia dónde te movías respecto al rival más cercano cuando te llegó el
//!   primer golpe. Una habilidad lineal se esquiva saliendo de su línea, en
//!   lateral; huir o acercarte por la misma línea es lo que la hace fácil de
//!   acertar. La dirección se mide desde TU campeón en pantalla, no desde el
//!   centro: la cámara del usuario va suelta y el centro no es él.
//! - **La puntería**: en cada pulsación de Q/W/E/R (grabadas desde el
//!   2026-10-07), a quién apuntabas, si apuntaste adonde estaba o adonde iba,
//!   y si perdió vida después. Sin teclas grabadas no hay nada que medir.
//!
//! Todo en píxeles del VÍDEO. Los clics se guardan en píxeles del escritorio y
//! se escalan con `mouse_space_w/h`, asumiendo el juego a pantalla completa
//! (como en todas las grabaciones del usuario).

use serde::{Deserialize, Serialize};

use crate::storage::MatchMetadata;

pub const FICHERO: &str = "barras.json";

/// Por debajo de este ángulo entre tu movimiento y la línea de fuego, te
/// movías por la línea (huyendo o acercándote): 30° es un tercio del giro
/// hasta el lateral puro.
const EN_LINEA_GRADOS: f64 = 30.0;
/// Un rival "apuntado" está a menos de esto de la dirección del cursor.
const OBJETIVO_GRADOS: f64 = 25.0;
/// Dentro de esto, apuntaste a donde estaba.
const DIRECTO_GRADOS: f64 = 3.0;
/// Pérdida de vida del objetivo que cuenta como acierto.
const ACIERTO: f64 = 0.03;

#[derive(Deserialize, Clone, Debug)]
pub struct Bar {
    pub team: String,
    pub x: f64,
    pub y: f64,
    pub hp: f64,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Frame {
    pub t: f64,
    pub bars: Vec<Bar>,
}

#[derive(Deserialize, Debug)]
pub struct Barras {
    pub width: f64,
    pub height: f64,
    pub frames: Vec<Frame>,
}

impl Barras {
    pub fn from_json(raw: &str) -> Option<Self> {
        let mut b: Self = serde_json::from_str(raw).ok()?;
        b.frames.sort_by(|a, c| a.t.total_cmp(&c.t));
        Some(b)
    }

    pub fn load(match_id: &str) -> Option<Self> {
        Self::from_json(&std::fs::read_to_string(ruta(match_id)).ok()?)
    }

    /// El fotograma leído más cercano a `t`, a menos de `tol` segundos.
    fn en(&self, t: f64, tol: f64) -> Option<&Frame> {
        let i = self.frames.partition_point(|f| f.t < t);
        [i.checked_sub(1), Some(i)]
            .into_iter()
            .flatten()
            .filter_map(|j| self.frames.get(j))
            .filter(|f| (f.t - t).abs() <= tol)
            .min_by(|a, b| (a.t - t).abs().total_cmp(&(b.t - t).abs()))
    }
}

pub fn ruta(match_id: &str) -> std::path::PathBuf {
    crate::storage::get_match_dir(match_id).join(FICHERO)
}

fn yo(f: &Frame) -> Option<&Bar> {
    f.bars.iter().find(|b| b.team == "self")
}

/// Ángulo sin signo entre dos vectores, en grados.
fn angulo(a: (f64, f64), b: (f64, f64)) -> f64 {
    let (na, nb) = (a.0.hypot(a.1), b.0.hypot(b.1));
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    ((a.0 * b.0 + a.1 * b.1) / (na * nb)).clamp(-1.0, 1.0).acos().to_degrees()
}

/// Ángulo con signo de `a` a `b`, en grados (-180..180).
fn angulo_signo(a: (f64, f64), b: (f64, f64)) -> f64 {
    let c = a.0 * b.1 - a.1 * b.0;
    let d = a.0 * b.0 + a.1 * b.1;
    c.atan2(d).to_degrees()
}

/// Escala del escritorio (donde están los clics) al vídeo.
fn escala(b: &Barras, m: &MatchMetadata) -> Option<(f64, f64)> {
    (m.mouse_space_w > 0 && m.mouse_space_h > 0)
        .then(|| (b.width / m.mouse_space_w as f64, b.height / m.mouse_space_h as f64))
}

/// Hacia dónde te movías respecto al rival más cercano en pantalla cuando te
/// llegó el golpe de `tv` (segundos de vídeo): "lateral", "away" (huyendo por
/// su línea), "toward" (hacia él) u "offscreen" (ningún rival en pantalla).
/// `None` si no hay lectura o no diste ninguna orden de movimiento.
pub fn linea_de_fuego(b: &Barras, m: &MatchMetadata, tv: f64) -> Option<&'static str> {
    let f = b.en(tv, 0.25)?;
    let s = yo(f)?;
    let rival = f
        .bars
        .iter()
        .filter(|x| x.team == "enemy")
        .min_by(|a, c| (a.x - s.x).hypot(a.y - s.y).total_cmp(&(c.x - s.x).hypot(c.y - s.y)));
    let Some(e) = rival else { return Some("offscreen") };
    let (sx, sy) = escala(b, m)?;
    let clic = m
        .mouse_events
        .iter()
        .filter(|ev| ev.evt == "right_click" && ev.t <= tv && ev.t >= tv - 1.5)
        .last()?;
    let mov = (clic.x * sx - s.x, clic.y * sy - s.y);
    if mov.0.hypot(mov.1) < 0.02 * b.height {
        return None;
    }
    let fuego = (s.x - e.x, s.y - e.y);
    let a = angulo(mov, fuego);
    Some(if a <= EN_LINEA_GRADOS {
        "away"
    } else if a >= 180.0 - EN_LINEA_GRADOS {
        "toward"
    } else {
        "lateral"
    })
}

/// Ventanas que leer: alrededor de cada apertura de pelea y de cada pulsación
/// de habilidad. Se funden las que se solapan.
pub fn ventanas(aperturas: &[f64], m: &MatchMetadata) -> Vec<[f64; 2]> {
    let mut v: Vec<[f64; 2]> = aperturas.iter().map(|t| [t - 0.6, t + 0.1]).collect();
    v.extend(
        m.mouse_events
            .iter()
            .filter(|e| matches!(e.evt.as_str(), "key_q" | "key_w" | "key_e" | "key_r"))
            .map(|e| [e.t - 0.3, e.t + 1.0]),
    );
    v.sort_by(|a, b| a[0].total_cmp(&b[0]));
    let mut out: Vec<[f64; 2]> = Vec::new();
    for w in v {
        let w = [w[0].max(0.0), w[1]];
        match out.last_mut() {
            Some(u) if w[0] <= u[1] + 0.1 => u[1] = u[1].max(w[1]),
            _ => out.push(w),
        }
    }
    out
}

#[derive(Debug, Clone, Serialize)]
pub struct Tiro {
    pub t_video: f64,
    /// "Q", "W", "E" o "R".
    pub key: String,
    /// "direct" (adonde estaba), "lead" (adonde iba), "behind" (por detrás de
    /// su movimiento) o "still" (el objetivo estaba quieto).
    pub aim: &'static str,
    /// Grados entre donde apuntaste y donde estaba.
    pub offset_deg: f64,
    /// Si perdió vida en el segundo siguiente. `None` si se le perdió de vista.
    pub hit: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct AimReport {
    /// "ok", "no_keys" (partida sin teclas grabadas), "no_bars", "no_match".
    pub status: String,
    pub matches: usize,
    /// Pulsaciones de habilidad con tu campeón en pantalla.
    pub presses: usize,
    /// De ellas, con un rival en la dirección del cursor.
    pub aimed: usize,
    pub by_aim: Vec<AimBucket>,
    pub by_key: Vec<AimBucket>,
    pub list: Vec<Tiro>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct AimBucket {
    pub key: String,
    pub n: usize,
    /// Con acierto conocido.
    pub known: usize,
    pub hits: usize,
}

fn cubo(v: &mut Vec<AimBucket>, key: &str, hit: Option<bool>) {
    let c = match v.iter_mut().position(|c| c.key == key) {
        Some(i) => &mut v[i],
        None => {
            v.push(AimBucket { key: key.to_string(), ..Default::default() });
            v.last_mut().unwrap()
        }
    };
    c.n += 1;
    if let Some(h) = hit {
        c.known += 1;
        c.hits += h as usize;
    }
}

/// El rival de `f` que mejor sigue a `pos` (mismo campeón un instante después).
fn seguir<'a>(f: &'a Frame, pos: (f64, f64), radio: f64) -> Option<&'a Bar> {
    f.bars
        .iter()
        .filter(|b| b.team == "enemy")
        .map(|b| (b, (b.x - pos.0).hypot(b.y - pos.1)))
        .filter(|(_, d)| *d < radio)
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(b, _)| b)
}

pub fn punteria(b: &Barras, m: &MatchMetadata) -> AimReport {
    let mut r = AimReport { status: "ok".into(), matches: 1, ..Default::default() };
    let teclas: Vec<_> = m
        .mouse_events
        .iter()
        .filter(|e| matches!(e.evt.as_str(), "key_q" | "key_w" | "key_e" | "key_r"))
        .collect();
    if teclas.is_empty() {
        r.status = "no_keys".into();
        return r;
    }
    let Some((sx, sy)) = escala(b, m) else {
        r.status = "no_keys".into();
        return r;
    };
    let h = b.height;
    for ev in teclas {
        let Some(f0) = b.en(ev.t, 0.12) else { continue };
        let Some(s) = yo(f0) else { continue };
        let apunte = (ev.x * sx - s.x, ev.y * sy - s.y);
        // Sobre ti mismo: no es un tiro (escudos, autolanzadas).
        if apunte.0.hypot(apunte.1) < 0.05 * h {
            continue;
        }
        r.presses += 1;
        let objetivo = f0
            .bars
            .iter()
            .filter(|x| x.team == "enemy")
            .map(|x| (x, angulo(apunte, (x.x - s.x, x.y - s.y))))
            .filter(|(x, a)| *a < OBJETIVO_GRADOS && (x.x - s.x).hypot(x.y - s.y) < 0.6 * h)
            .min_by(|a, c| a.1.total_cmp(&c.1))
            .map(|(x, _)| x);
        let Some(e) = objetivo else { continue };
        r.aimed += 1;

        // Hacia dónde iba: su posición 0,3 s antes, respecto a ti (así se
        // descuenta en parte que la cámara se moviera).
        let rel = (e.x - s.x, e.y - s.y);
        let previo = b.en(ev.t - 0.3, 0.12).and_then(|fp| {
            let sp = yo(fp)?;
            let ep = seguir(fp, (e.x, e.y), 0.12 * h)?;
            Some((ep.x - sp.x, ep.y - sp.y))
        });
        let desvio = angulo_signo(rel, apunte);
        let aim = match previo {
            None => "still",
            Some(p) => {
                let mov = (rel.0 - p.0, rel.1 - p.1);
                // Lo que se mueve de lado respecto a tu línea hacia él.
                let n = rel.0.hypot(rel.1).max(1.0);
                let lateral = (rel.0 * mov.1 - rel.1 * mov.0) / n;
                if lateral.abs() < 0.01 * h {
                    "still"
                } else if desvio.abs() <= DIRECTO_GRADOS {
                    "direct"
                } else if desvio.signum() == lateral.signum() {
                    "lead"
                } else {
                    "behind"
                }
            }
        };

        // ¿Perdió vida en el segundo siguiente?
        let mut pos = (e.x, e.y);
        let mut minimo = e.hp;
        let mut visto = false;
        for f in b.frames.iter().filter(|f| f.t > ev.t && f.t <= ev.t + 1.0) {
            if let Some(x) = seguir(f, pos, 0.12 * h) {
                pos = (x.x, x.y);
                minimo = minimo.min(x.hp);
                visto = true;
            }
        }
        let hit = visto.then_some(e.hp - minimo >= ACIERTO);
        let key = ev.evt.trim_start_matches("key_").to_uppercase();
        cubo(&mut r.by_aim, aim, hit);
        cubo(&mut r.by_key, &key, hit);
        r.list.push(Tiro {
            t_video: ev.t,
            key,
            aim,
            offset_deg: (desvio * 10.0).round() / 10.0,
            hit,
        });
    }
    r
}

fn script(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let s = crate::cv_analyzer::resolve_resource(app, "python_scripts/barras.py")
        .unwrap_or_else(|| std::path::Path::new("python_scripts/barras.py").to_path_buf());
    s.exists().then_some(s)
}

/// ¿Se pueden leer las barras y aún no se ha hecho? Necesita el HUD leído:
/// las ventanas salen de las peleas que te empezaron.
pub fn falta(app: &tauri::AppHandle, match_id: &str) -> bool {
    !ruta(match_id).exists()
        && script(app).is_some()
        && crate::hud::ruta(match_id).exists()
        && crate::storage::get_match_metadata(match_id)
            .map(|m| std::path::Path::new(&m.video_path).exists())
            .unwrap_or(false)
}

/// Lee las barras en las ventanas de una partida. Bloquea (1-3 min).
pub fn procesar(app: &tauri::AppHandle, match_id: &str) -> Result<(), String> {
    if ruta(match_id).exists() {
        return Ok(());
    }
    let script = script(app).ok_or("Esta instalación no trae el lector de barras.")?;
    let meta = crate::storage::get_match_metadata(match_id).map_err(|_| "No se encuentra la partida.")?;
    let aperturas = crate::golpes::aperturas(match_id);
    let v = ventanas(&aperturas, &meta);
    let dir = crate::storage::get_match_dir(match_id);
    let fich_v = dir.join("barras_ventanas.json");
    std::fs::write(&fich_v, serde_json::to_string(&v).unwrap_or_default()).map_err(|e| e.to_string())?;
    let ffmpeg = crate::proc::ffmpeg(app);
    let (w, h, _) = crate::proc::video_info(&ffmpeg, &meta.video_path).unwrap_or((1920.0, 1080.0, None));
    let mut cmd = std::process::Command::new(crate::cv_analyzer::python_command(app));
    cmd.arg(script)
        .arg("--video")
        .arg(&meta.video_path)
        .arg("--salida")
        .arg(ruta(match_id))
        .arg("--ffmpeg")
        .arg(&ffmpeg)
        .arg("--wh")
        .arg(format!("{}x{}", w as i64, h as i64))
        .arg("--ventanas")
        .arg(&fich_v);
    crate::proc::hide_console(&mut cmd);
    let salida = cmd.output();
    let _ = std::fs::remove_file(&fich_v);
    match salida {
        Ok(o) if o.status.success() && ruta(match_id).exists() => Ok(()),
        Ok(o) => {
            log::warn!("barras: falló {match_id}: {}", String::from_utf8_lossy(&o.stderr).lines().last().unwrap_or(""));
            Err("No se pudieron leer las barras de vida.".into())
        }
        Err(e) => Err(format!("No se pudo lanzar el lector de barras: {e}")),
    }
}

pub fn pendientes(app: &tauri::AppHandle) -> Vec<String> {
    if script(app).is_none() {
        return Vec::new();
    }
    crate::storage::load_all_matches()
        .into_iter()
        .filter(|m| !m.is_vod && m.riot_match_id.is_some())
        .filter(|m| falta(app, &m.id))
        .map(|m| m.id)
        .collect()
}

/// La puntería de una partida.
#[tauri::command]
pub async fn get_aim(match_id: String) -> AimReport {
    tokio::task::spawn_blocking(move || {
        let Ok(meta) = crate::storage::get_match_metadata(&match_id) else {
            return AimReport { status: "no_match".into(), ..Default::default() };
        };
        if !meta.mouse_events.iter().any(|e| e.evt.starts_with("key_")) {
            return AimReport { status: "no_keys".into(), ..Default::default() };
        }
        match Barras::load(&match_id) {
            Some(b) => punteria(&b, &meta),
            None => AimReport { status: "no_bars".into(), ..Default::default() },
        }
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::MouseEventData;

    fn meta(evs: Vec<(f64, f64, f64, &str)>) -> MatchMetadata {
        MatchMetadata {
            mouse_space_w: 1000,
            mouse_space_h: 1000,
            mouse_events: evs.into_iter().map(|(t, x, y, e)| MouseEventData { t, x, y, evt: e.into() }).collect(),
            ..Default::default()
        }
    }

    fn bar(team: &str, x: f64, y: f64, hp: f64) -> Bar {
        Bar { team: team.into(), x, y, hp }
    }

    fn barras(frames: Vec<(f64, Vec<Bar>)>) -> Barras {
        Barras { width: 1000.0, height: 1000.0, frames: frames.into_iter().map(|(t, bars)| Frame { t, bars }).collect() }
    }

    #[test]
    fn linea_de_fuego_lateral_y_huyendo() {
        // Tú en (500,500), el rival a la derecha en (800,500).
        let b = barras(vec![(10.0, vec![bar("self", 500.0, 500.0, 1.0), bar("enemy", 800.0, 500.0, 1.0)])]);
        // Clic hacia arriba: lateral.
        assert_eq!(linea_de_fuego(&b, &meta(vec![(9.5, 500.0, 200.0, "right_click")]), 10.0), Some("lateral"));
        // Clic a la izquierda: huyendo por su línea.
        assert_eq!(linea_de_fuego(&b, &meta(vec![(9.5, 200.0, 510.0, "right_click")]), 10.0), Some("away"));
        // Clic hacia él.
        assert_eq!(linea_de_fuego(&b, &meta(vec![(9.5, 700.0, 500.0, "right_click")]), 10.0), Some("toward"));
        // Sin rival en pantalla.
        let solo = barras(vec![(10.0, vec![bar("self", 500.0, 500.0, 1.0)])]);
        assert_eq!(linea_de_fuego(&solo, &meta(vec![(9.5, 500.0, 200.0, "right_click")]), 10.0), Some("offscreen"));
    }

    #[test]
    fn punteria_adelantada_y_acierto() {
        // El rival a la derecha, bajando por la pantalla (de y=450 a y=500 en 0,3 s).
        // Apuntas por debajo de él (adonde va) y pierde un 10 % de vida.
        let b = barras(vec![
            (9.7, vec![bar("self", 500.0, 500.0, 1.0), bar("enemy", 800.0, 450.0, 0.8)]),
            (10.0, vec![bar("self", 500.0, 500.0, 1.0), bar("enemy", 800.0, 500.0, 0.8)]),
            (10.5, vec![bar("self", 500.0, 500.0, 1.0), bar("enemy", 800.0, 560.0, 0.7)]),
        ]);
        let r = punteria(&b, &meta(vec![(10.0, 800.0, 560.0, "key_r")]));
        assert_eq!(r.aimed, 1);
        assert_eq!(r.list[0].aim, "lead");
        assert_eq!(r.list[0].hit, Some(true));
        // Apuntando por detrás de su movimiento.
        let r = punteria(&b, &meta(vec![(10.0, 800.0, 440.0, "key_q")]));
        assert_eq!(r.list[0].aim, "behind");
    }

    /// Escribe `barras_ventanas.json` en cada partida con el HUD leído, para
    /// lanzar `barras.py` a mano: `BARRAS_VENTANAS=1 cargo test --lib ventanas_de_mis_partidas`
    #[test]
    fn ventanas_de_mis_partidas() {
        if std::env::var("BARRAS_VENTANAS").is_err() {
            return;
        }
        for m in crate::storage::load_all_matches() {
            if !crate::hud::ruta(&m.id).exists() {
                continue;
            }
            let Ok(meta) = crate::storage::get_match_metadata(&m.id) else { continue };
            let v = ventanas(&crate::golpes::aperturas(&m.id), &meta);
            let f = crate::storage::get_match_dir(&m.id).join("barras_ventanas.json");
            std::fs::write(&f, serde_json::to_string(&v).unwrap()).unwrap();
            println!("{} {} ventanas", m.id, v.len());
        }
    }

    #[test]
    fn ventanas_se_funden() {
        let m = meta(vec![(10.0, 0.0, 0.0, "key_q"), (10.5, 0.0, 0.0, "key_w"), (30.0, 0.0, 0.0, "key_d")]);
        let v = ventanas(&[20.0], &m);
        assert_eq!(v.len(), 2);
        assert!((v[0][0] - 9.7).abs() < 1e-9 && (v[0][1] - 11.5).abs() < 1e-9);
    }
}
