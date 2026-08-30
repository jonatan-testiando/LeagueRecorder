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


//// En qué punto está el procesado del vídeo de una partida.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Estado {
    /// Ya hay posiciones densas: los tramos de presión salen medidos.
    Hecha,
    /// Se está procesando ahora mismo.
    EnCurso,
    /// Se puede procesar, pero nadie lo ha pedido.
    Falta,
    /// No hay con qué: falta el vídeo, los datos de Riot con los que situarlo,
    /// o el detector (script y modelo) en esta instalación.
    NoDisponible,
}

/// Una pasada en marcha.
#[derive(Default)]
struct Trabajo {
    /// PID del Python. 0 mientras se está lanzando.
    pid: u32,
    /// Lo paró el usuario. Sin esto, cancelar se veía igual que fallar: el
    /// proceso muere con código de error y el aviso decía "el análisis falló".
    cancelado: bool,
}

/// Partidas que se están procesando ahora mismo.
///
/// Existe porque el guardia de "¿ya está el JSON?" no basta: el fichero no
/// aparece hasta el final, así que entrar y salir de la pestaña dos veces
/// lanzaba dos pasadas sobre el mismo vídeo de 4 GB.
fn en_curso() -> &'static std::sync::Mutex<std::collections::HashMap<String, Trabajo>> {
    static M: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Trabajo>>> =
        std::sync::OnceLock::new();
    M.get_or_init(Default::default)
}

/// Rutas del script y del modelo, o `None` si esta instalación no los trae.
fn recursos(app: &tauri::AppHandle) -> Option<(std::path::PathBuf, std::path::PathBuf)> {
    // El modelo y el script viajan como recursos empaquetados; la ruta relativa
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
    (script.exists() && modelo.exists()).then_some((script, modelo))
}

/// Ruta del JSON de posiciones densas de una partida.
pub fn ruta(match_id: &str) -> std::path::PathBuf {
    crate::storage::get_match_dir(match_id).join("minimap_positions.json")
}

/// Ruta del volcado a medias, que es lo que permite reanudar.
fn ruta_parcial(match_id: &str) -> std::path::PathBuf {
    crate::storage::get_match_dir(match_id).join("minimap_positions.json.part")
}

pub fn estado(app: &tauri::AppHandle, match_id: &str) -> Estado {
    if ruta(match_id).exists() {
        return Estado::Hecha;
    }
    if en_curso()
        .lock()
        .map(|m| m.contains_key(match_id))
        .unwrap_or(false)
    {
        return Estado::EnCurso;
    }
    if hay_con_que(match_id) && recursos(app).is_some() {
        Estado::Falta
    } else {
        Estado::NoDisponible
    }
}

/// Si esta partida tiene lo que el script necesita: el vídeo, los dos ficheros
/// de Riot y el desplazamiento del vídeo.
///
/// Se comprueba entero a propósito. Antes bastaba con que existiera el vídeo, y
/// eso ofrecía el botón en partidas sin sincronizar donde el script muere en la
/// primera línea: el usuario pulsaba, esperaba, y recibía "el análisis falló".
fn hay_con_que(match_id: &str) -> bool {
    let Ok(meta) = crate::storage::get_match_metadata(match_id) else {
        return false;
    };
    meta.video_offset.is_some()
        && Path::new(&meta.video_path).exists()
        && crate::storage::get_raw_match_path(match_id).exists()
        && crate::storage::get_timeline_path(match_id).exists()
}

/// Cuánto se avanzó en pasadas anteriores, en tanto por ciento.
///
/// Sirve para que la barra no arranque de cero cuando el trabajo viene de
/// antes: lo que hay guardado no se repite.
pub fn avance_guardado(match_id: &str) -> Option<f64> {
    let raw = std::fs::read_to_string(ruta_parcial(match_id)).ok()?;
    let p: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let ultimo = p.get("samples")?.as_array()?.last()?.get("t")?.as_f64()?;
    let meta = crate::storage::get_match_metadata(match_id).ok()?;
    let dur = meta.game_duration as f64 + meta.video_offset.unwrap_or(0.0);
    (dur > 0.0).then(|| (ultimo / dur * 100.0).clamp(0.0, 99.0))
}

/// Detiene el procesado de una partida, si lo hay. Lo ya calculado se conserva:
/// el parcial sigue en disco y la próxima pasada lo retoma.
pub fn cancelar(match_id: &str) {
    let pid = en_curso().lock().ok().and_then(|mut m| {
        let t = m.get_mut(match_id)?;
        t.cancelado = true;
        Some(t.pid)
    });
    let Some(pid) = pid.filter(|p| *p != 0) else {
        return;
    };
    // El árbol entero: de Python cuelga un ffmpeg que si no queda huérfano
    // leyendo un vídeo de 4 GB.
    let _ = crate::proc::hide_console(std::process::Command::new("taskkill").args([
        "/F",
        "/T",
        "/PID",
        &pid.to_string(),
    ]))
    .output();
}

/// Para todo lo que esté procesándose. Se llama al salir de la app.
///
/// Sin esto, ocultar la consola del hijo (que es lo que arregla la ventana
/// negra) tenía un efecto feo de propina: al cerrar la app quedaba un Python
/// invisible leyendo un vídeo de 4 GB, sin ventana que cerrar ni botón que
/// pulsar. Matarlo aquí cuesta como mucho el último tramo sin volcar —el
/// parcial se conserva y la siguiente pasada lo retoma.
pub fn cancelar_todo() {
    let ids: Vec<String> = en_curso()
        .lock()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    for id in ids {
        cancelar(&id);
    }
}

/// Lanza el procesado del vídeo de una partida para extraer posiciones densas.
///
/// Tarda ~2 minutos por partida (medido: 2m09s sobre una de 28 min con el
/// runtime de CPU), así que va en un hilo aparte y avisa del avance por el
/// evento `minimap_progress`.
///
/// **Ya no se dispara solo.** Antes lo lanzaba el abrir la pestaña de Impacto, y
/// como el proceso salía con consola propia, cerrar esa ventana negra mataba el
/// trabajo justo antes de que escribiera nada: a la visita siguiente vuelta a
/// empezar, y otra ventana. Ahora lo pide el usuario, se ve avanzar, se puede
/// parar y lo hecho no se pierde.
pub fn spawn_processing(app: &tauri::AppHandle, match_id: &str) -> Result<(), String> {
    let dir = crate::storage::get_match_dir(match_id);
    if ruta(match_id).exists() {
        return Ok(()); // ya procesada
    }
    {
        let mut curso = en_curso().lock().map_err(|_| "estado interno corrupto")?;
        if curso.contains_key(match_id) {
            return Ok(()); // ya se está haciendo
        }
        // El hueco se reserva ANTES de lanzar nada: si dos peticiones llegan a la
        // vez, la segunda ve la reserva de la primera. El PID se rellena luego.
        curso.insert(match_id.to_string(), Trabajo::default());
    }

    let soltar = |id: &str| {
        if let Ok(mut c) = en_curso().lock() {
            c.remove(id);
        }
    };

    let Some((script, modelo)) = recursos(app) else {
        soltar(match_id);
        return Err("Esta instalación no trae el detector de minimapa.".into());
    };
    let Ok(meta) = crate::storage::get_match_metadata(match_id) else {
        soltar(match_id);
        return Err("No se encuentra la partida.".into());
    };
    if !Path::new(&meta.video_path).exists() {
        soltar(match_id);
        return Err("El vídeo de esta partida ya no está.".into());
    }
    if !hay_con_que(match_id) {
        soltar(match_id);
        return Err(
            "Esta partida no está sincronizada con Riot: sin sus datos no se puede situar lo que se ve en el minimapa."
                .into(),
        );
    }

    // El ffmpeg EMPAQUETADO, no el del PATH. El script llamaba a `ffmpeg` y
    // `ffprobe` por su nombre: aquí funcionaba porque están instalados a mano y
    // en cualquier otra máquina moría en el primer segundo. `ffprobe` además ni
    // se empaqueta, así que la resolución se lee de la cabecera —que es para lo
    // que existe `proc::video_info`— y se le pasa hecha.
    let ffmpeg = crate::proc::ffmpeg(app);
    let (w, h, dur) =
        crate::proc::video_info(&ffmpeg, &meta.video_path).unwrap_or((1920.0, 1080.0, None));
    let duracion = dur.unwrap_or(meta.game_duration as f64 + meta.video_offset.unwrap_or(0.0));

    let (py, cuda_dll) = python(app);
    let dir_s = dir.to_string_lossy().to_string();
    let id = match_id.to_string();
    let app = app.clone();
    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        use tauri::Emitter;

        log::info!("minimapa: procesando el vídeo de {id} con {py}");
        let mut cmd = std::process::Command::new(&py);
        cmd.arg(script)
            .arg("--match")
            .arg(&dir_s)
            .arg("--modelo")
            .arg(modelo)
            .arg("--ffmpeg")
            .arg(&ffmpeg)
            .arg("--wh")
            .arg(format!("{}x{}", w as i64, h as i64))
            .arg("--duracion")
            .arg(format!("{duracion:.2}"))
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if let Some(dll) = &cuda_dll {
            cmd.env("VOD_CUDA_DLL_DIR", dll);
        }
        // Sin esto Windows le abre una consola propia al hijo. Era LA ventana
        // negra que aparecía al entrar en Impacto, y cerrarla mataba el análisis.
        crate::proc::hide_console(&mut cmd);

        let mut hijo = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                log::warn!("minimapa: no se pudo lanzar para {id}: {e}");
                if let Ok(mut c) = en_curso().lock() {
                    c.remove(&id);
                }
                let _ = app.emit("minimap_progress", (id.clone(), -1.0));
                return;
            }
        };
        if let Ok(mut c) = en_curso().lock() {
            if let Some(t) = c.get_mut(&id) {
                t.pid = hijo.id();
            }
        }

        // Progreso por stderr (`PROGRESS:<0-100>`), el mismo formato que el
        // analizador de VOD y el de saltos de cámara.
        if let Some(err) = hijo.stderr.take() {
            let app = app.clone();
            let id = id.clone();
            std::thread::spawn(move || {
                for linea in BufReader::new(err).lines().map_while(Result::ok) {
                    match linea
                        .strip_prefix("PROGRESS:")
                        .and_then(|v| v.trim().parse::<f64>().ok())
                    {
                        Some(pct) => {
                            let _ = app.emit("minimap_progress", (id.clone(), pct));
                        }
                        None if !linea.trim().is_empty() => log::info!("minimapa[{id}]: {linea}"),
                        None => {}
                    }
                }
            });
        }

        let salida = hijo.wait_with_output();
        let cancelado = en_curso()
            .lock()
            .ok()
            .and_then(|mut c| c.remove(&id))
            .map(|t| t.cancelado)
            .unwrap_or(false);
        if cancelado {
            // Parada pedida: no es un fallo y no se avisa como tal. Lo calculado
            // sigue en el parcial y la próxima pasada lo retoma.
            log::info!("minimapa: {id} parada por el usuario");
            return;
        }
        let ok = match salida {
            Ok(o) if o.status.success() => {
                log::info!("minimapa: {id} lista");
                true
            }
            Ok(o) => {
                log::warn!(
                    "minimapa: falló {id}: {}",
                    String::from_utf8_lossy(&o.stdout).lines().last().unwrap_or("")
                );
                false
            }
            Err(e) => {
                log::warn!("minimapa: se perdió el proceso de {id}: {e}");
                false
            }
        };
        // -1 = terminó mal. La interfaz lo distingue de "voy por el 40%" para no
        // dejar una barra congelada como único aviso de que algo se rompió.
        let _ = app.emit(
            "minimap_progress",
            (id.clone(), if ok { 100.0 } else { -1.0 }),
        );
    });
    Ok(())
}

/// Qué Python usar, y con qué DLL de CUDA a mano.
///
/// El runtime empaquetado sólo trae `onnxruntime` de CPU. Si en esta máquina
/// existe el entorno de entreno (`onnxruntime-gpu`), se usa ese y se le pasa el
/// directorio de DLL de torch en `VOD_CUDA_DLL_DIR` — **sin eso el proveedor
/// CUDA no carga y todo sigue por CPU en silencio**, que es justo lo que
/// invalidó la primera medición de esto.
///
/// Lo que se gana, medido sobre el mismo vídeo por partes:
///
/// | | CPU | CUDA |
/// |---|---|---|
/// | modelo (320 fotogramas) | 4,21 s | 0,20 s |
/// | todo menos descodificar | 5,98 s | 1,81 s |
///
/// El modelo va 21× más rápido, pero el total de una pasada sólo baja de ~2m28 a
/// ~1m50: **descodificar el vídeo son 1m32 y eso no lo toca nadie** (probado
/// también `-hwaccel cuda` y `d3d11va`: 1m41 y 1m48, peor que por software,
/// porque hay que traerse cada fotograma de vuelta a memoria).
///
/// En cualquier instalación normal no hay venv, así que se usa el empaquetado y
/// el resultado es idéntico — sólo cambia el reloj.
fn python(app: &tauri::AppHandle) -> (String, Option<std::path::PathBuf>) {
    match crate::cv_analyzer::gpu_python() {
        Some(py) => {
            let dll = crate::cv_analyzer::torch_lib_dir();
            (
                py.to_string_lossy().to_string(),
                dll.is_dir().then_some(dll),
            )
        }
        None => (crate::cv_analyzer::python_command(app), None),
    }
}
