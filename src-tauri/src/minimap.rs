//! Posiciones densas leídas del minimapa del vídeo.
//!
//! La API de Riot da **una posición por minuto**. Esto da **dos por segundo**,
//! detectadas con un modelo entrenado sobre el propio minimapa
//! (`python_scripts/minimap_positions.py`). Es la única fuente que puede decir
//! qué pasó *entre* minutos, y por eso arregla lo que quedaba cojo: la duración
//! de los tramos de presión, que sin esto era sólo una cota inferior.
//!
//! Rendimiento medido sobre partidas que no se usaron para entrenar: ve el 75%
//! de los iconos, y de lo que señala el 99% es real. El equipo sale del color
//! del aro (96% de los iconos) — no hace falta saber qué campeón es cada uno
//! para responder "cuántos rivales tenía encima".
//!
//! Es **opcional**: si el fichero no existe, todo sigue funcionando con la
//! estimación a partir de la API. Nunca debe ser un requisito, porque depende de
//! tener el vídeo.

use serde::Deserialize;
use std::path::Path;

/// Un icono detectado, ya en coordenadas de juego.
#[derive(Debug, Clone, Deserialize)]
pub struct Icon {
    pub x: f64,
    pub y: f64,
    /// 100 o 200. `None` si el aro no se pudo leer con confianza.
    pub team: Option<i32>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Sample {
    /// Segundos de **vídeo**.
    pub t: f64,
    pub icons: Vec<Icon>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Positions {
    pub fps: f64,
    pub video_offset: f64,
    pub self_participant_id: i32,
    pub self_team_id: i32,
    pub samples: Vec<Sample>,
}

/// Cuánto puede moverse alguien por segundo sin romper la física del juego.
/// Velocidad base ~400, más margen para destellos y desplazamientos.
const VELOCIDAD_MAX: f64 = 1800.0;

/// Cuánto se aguanta sin ver el icono antes de dar el rastro por perdido.
/// El detector ve el 75%, así que uno de cada cuatro fotogramas no trae el tuyo;
/// abandonar al primer fallo dejaba el seguimiento en la mitad de las muestras.
const HUECO_MAX: f64 = 3.0;

/// A qué distancia de la posición interpolada de la API se acepta un icono al
/// retomar un rastro perdido. Holgado a propósito: esa interpolación arrastra
/// ~940 unidades de error, y no hace falta acertar el punto, sólo elegir entre
/// los aliados que hay en pantalla.
const RESCATE_MAX: f64 = 2500.0;

/// Cuánto más lejos tiene que estar el segundo candidato para dar por bueno el
/// primero al retomar un rastro.
const MARGEN_RESCATE: f64 = 1200.0;

/// Dónde estaba el jugador en un instante, según el vídeo.
#[derive(Debug, Clone, Copy)]
pub struct Fix {
    /// Segundos de **partida** (ya sin el desplazamiento del vídeo).
    pub sec: f64,
    pub x: f64,
    pub y: f64,
    /// Si en ese instante coincidió con una posición exacta de la API.
    pub anchored: bool,
}

/// Dónde estaría alguien según la API, interpolando entre los dos minutos que
/// rodean el instante. `None` si cae fuera del rango con anclas.
fn interpolar(anclas: &[(f64, f64, f64)], sec: f64) -> Option<(f64, f64)> {
    let antes = anclas.iter().rev().find(|(t, _, _)| *t <= sec)?;
    let despues = anclas.iter().find(|(t, _, _)| *t >= sec)?;
    if (despues.0 - antes.0).abs() < 1e-6 {
        return Some((antes.1, antes.2));
    }
    let f = (sec - antes.0) / (despues.0 - antes.0);
    Some((
        antes.1 + (despues.1 - antes.1) * f,
        antes.2 + (despues.2 - antes.2) * f,
    ))
}

impl Positions {
    /// Carga las posiciones de una partida, si se procesó su vídeo.
    pub fn load(match_id: &str) -> Option<Self> {
        let ruta = crate::storage::get_match_dir(match_id).join("minimap_positions.json");
        let raw = std::fs::read_to_string(ruta).ok()?;
        serde_json::from_str(&raw).ok()
    }

    /// Sigue al jugador grabado a lo largo de la partida.
    ///
    /// No basta con coger el aliado más cercano a donde dice la API: entre
    /// minutos esa posición es una interpolación, y con ese criterio el rastro
    /// saltaba miles de unidades en dos segundos. Se ancla en cada minuto —donde
    /// la API es exacta— y entre medias se propaga por continuidad, aceptando
    /// sólo saltos que la velocidad permite.
    pub fn follow(&self, anclas: &[(f64, f64, f64)]) -> Vec<Fix> {
        let mut out = Vec::new();
        let mut actual: Option<(f64, f64)> = None;
        let mut visto = 0.0f64;

        for s in &self.samples {
            let sec = s.t - self.video_offset;
            let aliados: Vec<&Icon> = s
                .icons
                .iter()
                .filter(|i| i.team == Some(self.self_team_id))
                .collect();
            if aliados.is_empty() {
                continue;
            }

            // ¿Hay una posición exacta de la API para este instante? Manda ella.
            if let Some((_, ax, ay)) = anclas.iter().find(|(t, _, _)| (t - sec).abs() <= 0.5) {
                let mejor = aliados
                    .iter()
                    .min_by(|a, b| {
                        let da = (a.x - ax).powi(2) + (a.y - ay).powi(2);
                        let db = (b.x - ax).powi(2) + (b.y - ay).powi(2);
                        da.total_cmp(&db)
                    })
                    .unwrap();
                actual = Some((mejor.x, mejor.y));
                visto = sec;
                out.push(Fix { sec, x: mejor.x, y: mejor.y, anchored: true });
                continue;
            }

            let dt = sec - visto;
            if dt > HUECO_MAX {
                actual = None;
            }

            // Rescate: si se perdió el rastro, se retoma con la posición que da
            // la API interpolada entre los dos minutos que rodean el instante.
            //
            // Como POSICIÓN esa interpolación es mala (~940 unidades de error),
            // pero aquí sólo sirve para **elegir entre los iconos aliados que ya
            // están en pantalla**, y eso lo resuelve de sobra. Sin esto el
            // rastro se rompía en cada pelea y no volvía: siete de diecisiete
            // tramos de presión tenían menos de la mitad de cobertura, y tres
            // menos del 10%, así que el vídeo no podía opinar sobre ellos.
            if actual.is_none() {
                if let Some((ix, iy)) = interpolar(anclas, sec) {
                    let mut d: Vec<(f64, &&Icon)> = aliados
                        .iter()
                        .map(|a| (((a.x - ix).powi(2) + (a.y - iy).powi(2)).sqrt(), a))
                        .collect();
                    d.sort_by(|a, b| a.0.total_cmp(&b.0));
                    // El candidato tiene que ser inequívoco. En una pelea tienes
                    // compañeros al lado, y con 940 unidades de error la API no
                    // distingue entre tú y el de al lado: coger al más cercano
                    // sin más ponía "tu" posición encima de un aliado, y con
                    // ella los rivales salían lejos. Medido: las muertes que
                    // seguían cayendo dentro de su tramo bajaban de 9/9 a 5/9.
                    let claro = d[0].0 <= RESCATE_MAX
                        && d.get(1).is_none_or(|(seg, _)| seg - d[0].0 >= MARGEN_RESCATE);
                    if claro {
                        let m = d[0].1;
                        actual = Some((m.x, m.y));
                        visto = sec;
                        out.push(Fix { sec, x: m.x, y: m.y, anchored: false });
                        continue;
                    }
                }
            }

            let Some((px, py)) = actual else { continue };
            let mejor = aliados
                .iter()
                .min_by(|a, b| {
                    let da = (a.x - px).powi(2) + (a.y - py).powi(2);
                    let db = (b.x - px).powi(2) + (b.y - py).powi(2);
                    da.total_cmp(&db)
                })
                .unwrap();
            let d = ((mejor.x - px).powi(2) + (mejor.y - py).powi(2)).sqrt();
            // El radio admisible crece con el hueco: si hace dos segundos que no
            // se te ve, pudiste recorrer el doble.
            if d > VELOCIDAD_MAX * dt.max(0.5) {
                continue; // ninguno encaja: se espera, no se abandona
            }
            actual = Some((mejor.x, mejor.y));
            visto = sec;
            out.push(Fix { sec, x: mejor.x, y: mejor.y, anchored: false });
        }
        out
    }

    /// Rivales dentro del radio en ese instante, contados del vídeo.
    ///
    /// A diferencia del estimador, aquí no hay incertidumbre que ponderar: o el
    /// icono está o no está. Devuelve `None` si no hay muestra cerca de ese
    /// instante, para que quien llama sepa que tiene que caer a la estimación.
    pub fn enemies_near(&self, sec: f64, x: f64, y: f64, radio: f64) -> Option<usize> {
        let t_video = sec + self.video_offset;
        let s = self
            .samples
            .iter()
            .min_by(|a, b| (a.t - t_video).abs().total_cmp(&(b.t - t_video).abs()))?;
        if (s.t - t_video).abs() > 1.0 {
            return None;
        }
        Some(
            s.icons
                .iter()
                .filter(|i| i.team.is_some() && i.team != Some(self.self_team_id))
                .filter(|i| ((i.x - x).powi(2) + (i.y - y).powi(2)).sqrt() <= radio)
                .count(),
        )
    }
}


/// Lanza el procesado del vídeo de una partida para extraer posiciones densas.
///
/// Se dispara y se olvida: tarda ~2 minutos por partida y no debe bloquear la
/// sincronización, que es lo que el usuario está esperando.
///
/// Necesita el entorno de entreno (trae `ultralytics` y `torch`), que hoy sólo
/// existe en la máquina de desarrollo. Por eso **falla en silencio y sin
/// romper nada**: sin posiciones densas todo sigue funcionando con la
/// estimación a partir de la API.
pub fn spawn_processing(app: &tauri::AppHandle, match_id: &str) {
    let dir = crate::storage::get_match_dir(match_id);
    if dir.join("minimap_positions.json").exists() {
        return; // ya procesada
    }

    // El modelo y el script viajan como recursos empaquetados; la ruta absoluta
    // sólo se usa como último recurso en desarrollo. Este proyecto ya se ha
    // roto antes en instalaciones limpias por rutas fijas.
    let script = crate::cv_analyzer::resolve_resource(app, "python_scripts/minimap_positions.py")
        .unwrap_or_else(|| Path::new("python_scripts/minimap_positions.py").to_path_buf());
    // El modelo viaja en ONNX, no en `.pt`, y no es un detalle de formato: `.pt`
    // obliga a `ultralytics`, que arrastra torch —dos gigas— y sólo existe en el
    // entorno de entreno. En ONNX lo mueve el runtime de Python que la app ya
    // empaqueta, el mismo que usa el analizador de VOD.
    //
    // Esto estuvo apuntando a `.venv-train` y por tanto **no funcionaba para
    // nadie más que en esta máquina**: sin ese entorno se saltaba el procesado
    // en silencio y la mitad del análisis de presión no existía. Es la tercera
    // vez que este proyecto se rompe así (ffmpeg, el analizador, esto).
    let modelo = crate::cv_analyzer::resolve_resource(app, "models/minimap_icons.onnx")
        .unwrap_or_else(|| Path::new("models/minimap_icons.onnx").to_path_buf());

    let py = crate::cv_analyzer::python_command(app);
    if !script.exists() || !modelo.exists() {
        log::info!("minimapa: falta el script o el modelo, se omite");
        return;
    }

    let dir_s = dir.to_string_lossy().to_string();
    let id = match_id.to_string();
    std::thread::spawn(move || {
        log::info!("minimapa: procesando el vídeo de {id}");
        let salida = std::process::Command::new(py)
            .arg(script)
            .arg("--match")
            .arg(&dir_s)
            .arg("--modelo")
            .arg(modelo)
            .output();
        match salida {
            Ok(o) if o.status.success() => log::info!("minimapa: {id} lista"),
            Ok(o) => log::warn!(
                "minimapa: falló {id}: {}",
                String::from_utf8_lossy(&o.stderr).lines().last().unwrap_or("")
            ),
            Err(e) => log::warn!("minimapa: no se pudo lanzar para {id}: {e}"),
        }
    });
}
