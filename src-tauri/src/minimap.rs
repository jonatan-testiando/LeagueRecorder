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
//! para responder "cuántos rivales tenía encima". Ojo: el aro dice ALIADO
//! (azul) o RIVAL (rojo), no lado del mapa; ver [`Positions::from_json`].
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
    /// Recuadro de la cámara `[x_min, y_min, x_max, y_max]` en coordenadas de
    /// juego, si el detector lo encontró. Sólo en ficheros medidos desde el
    /// 2026-10-07 (`camera: 1` en la cabecera); ver `camara_de` en
    /// `minimap_positions.py`.
    #[serde(default)]
    pub cam: Option<[f64; 4]>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Positions {
    pub fps: f64,
    pub video_offset: f64,
    pub self_participant_id: i32,
    pub self_team_id: i32,
    pub samples: Vec<Sample>,
    /// Cómo se escribió `team`. `"ally_ring"`: ya traducido a 100/200 sabiendo
    /// que el aro azul es tu equipo. Ausente: ficheros anteriores al
    /// 2026-10-07, que ponían azul = 100 a secas.
    #[serde(default)]
    pub team_from: Option<String>,
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

/// Parámetros del camino entre anclajes, medidos escondiendo minutos de la
/// API (`seguimiento_en_mis_partidas`).
///
/// Muestras que se pueden saltar sin ver tu icono (15 s a 2 Hz): al salir de
/// la fuente el detector llega a pasar más de 4 s sin ver a nadie, y con un
/// límite de 4 s tu camino real quedaba cortado.
const SALTO_MAX: usize = 30;
/// Coste por muestra saltada.
const PENALIZA_HUECO: f64 = 300.0;
/// Velocidad de andar normal (u/s). Lo que la supere se cobra `PESO_EXCESO`
/// veces: sin esto el camino se quedaba en un compañero y "saltaba" de vuelta.
const ANDAR: f64 = 500.0;
const PESO_EXCESO: f64 = 20.0;
/// Recargo por cada 1.000 u que separan un icono del centro de la cámara (con
/// tope en `CAMARA_TOPE`). Suave a propósito: el usuario mira otras partes del
/// mapa ~9 veces por minuto y durante ese segundo la cámara no está sobre él.
///
/// Medido (2026-10-07, 16 partidas re-medidas con el recuadro): minutos de la
/// API escondidos con el rastro en otro icono 41 % → 3,5 %; en tus muertes
/// 19 % → 0 %. Con 150 la precisión es igual y la cobertura baja (67 % frente
/// a 72 %); con 75 suben los fallos (6,8 %); con 1.000 el camino se salta
/// casi todo cuando miras a otra parte.
const PESO_CAMARA: f64 = 100.0;
const CAMARA_TOPE: f64 = 4000.0;
fn clave_ms(sec: f64) -> i64 {
    (sec * 1000.0).round() as i64
}

/// Las posiciones exactas de un participante, una por minuto.
pub fn anclas_de(tl: &crate::riot_api::TimelineDto, pid: i32) -> Vec<(f64, f64, f64)> {
    let k = pid.to_string();
    tl.info
        .frames
        .iter()
        .filter_map(|f| {
            let p = f.participantFrames.get(&k)?.position.as_ref()?;
            Some((f.timestamp as f64 / 1000.0, p.x as f64, p.y as f64))
        })
        .collect()
}

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
        Self::from_json(&raw)
    }

    /// Parsea un `minimap_positions.json` dejando `team` en teamId de verdad.
    ///
    /// En el minimapa el aro azul es SIEMPRE tu equipo y el rojo el rival,
    /// juegues en el lado que juegues. El detector anterior traducía azul = 100
    /// sin más, así que en las partidas de lado rojo (14 de 26 el 2026-10-07)
    /// el rastro seguía a un rival como si fueras tú —a 3.000-5.000 u de tu
    /// posición exacta de la API, frente a 89 en lado azul— y la presión
    /// contaba aliados como rivales. Los ficheros viejos se corrigen aquí, al
    /// leerlos, sin reprocesar el vídeo.
    pub fn from_json(raw: &str) -> Option<Self> {
        let mut p: Self = serde_json::from_str(raw).ok()?;
        if p.team_from.is_none() && p.self_team_id == 200 {
            for i in p.samples.iter_mut().flat_map(|s| s.icons.iter_mut()) {
                i.team = i.team.map(|t| if t == 100 { 200 } else { 100 });
            }
        }
        p.team_from = Some("ally_ring".into());
        Some(p)
    }

    /// Sigue al jugador grabado a lo largo de la partida.
    ///
    /// Entre cada dos minutos exactos de la API se busca el CAMINO de iconos
    /// aliados que une las dos posiciones con movimientos posibles (camino
    /// mínimo en un grafo de muestras). Lo de antes —propagar por continuidad
    /// desde el último minuto— se enganchaba a un compañero cuando salíais
    /// juntos y no se soltaba: medido escondiendo minutos de la API, en el
    /// 49 % de ellos el rastro estaba sobre otro icono. Un compañero que sale
    /// contigo no acaba donde la API dice que estabas un minuto después, así
    /// que su camino no conecta y se descarta solo.
    ///
    /// Donde no hay camino (iconos perdidos demasiado tiempo), o pasado el
    /// último minuto, se usa la pasada por continuidad de siempre.
    ///
    /// Medido (2026-10-07, 26 partidas): escondiendo la mitad de los minutos
    /// de la API, el rastro caía sobre otro icono en el 49 % de ellos con lo
    /// de antes y en el 38 % con esto (error típico 1.382 → 158 u); con todos
    /// los minutos y tus muertes como verdad, 31 % → 24 %. Lo que queda son
    /// sobre todo peleas en grupo: sin saber qué icono eres tú, el camino
    /// más corto a veces pasa por el grupo. Probado y DESCARTADO: seguir
    /// también a los 4 compañeros con sus minutos de la API y penalizar los
    /// iconos "suyos" — empeora (46-62 %), porque sus rastros fallan igual y
    /// te roban tu icono. Lo que lo arreglaría de verdad es saber qué icono
    /// eres (el recuadro blanco de la cámara, o el retrato), y eso exige
    /// volver a medir los vídeos.
    pub fn follow(&self, anclas: &[(f64, f64, f64)]) -> Vec<Fix> {
        self.follow_con(anclas)
    }

    /// Centro de la cámara en cada muestra que lo tiene, por tiempo (ms).
    ///
    /// Junto al borde del mapa el recuadro sale cortado y su centro aparente
    /// se va hacia dentro: se reconstruye desde el lado que sí se ve con el
    /// tamaño típico del recuadro en ESTA partida (la mediana de los que no
    /// tocan el borde; depende de la resolución y del zoom).
    fn centros_de_camara(&self) -> std::collections::HashMap<i64, (f64, f64)> {
        const MARGEN: f64 = 150.0;
        const MAPA: f64 = 14870.0;
        let enteras: Vec<[f64; 4]> = self
            .samples
            .iter()
            .filter_map(|s| s.cam)
            .filter(|c| c[0] > MARGEN && c[1] > MARGEN && c[2] < MAPA - MARGEN && c[3] < MAPA - MARGEN)
            .collect();
        if enteras.len() < 10 {
            return Default::default();
        }
        let mediana = |mut v: Vec<f64>| {
            v.sort_by(|a, b| a.total_cmp(b));
            v[v.len() / 2]
        };
        let ancho = mediana(enteras.iter().map(|c| c[2] - c[0]).collect());
        let alto = mediana(enteras.iter().map(|c| c[3] - c[1]).collect());
        let eje = |lo: f64, hi: f64, lado: f64| {
            if lo <= MARGEN && hi - lo < lado * 0.9 {
                hi - lado / 2.0
            } else if hi >= MAPA - MARGEN && hi - lo < lado * 0.9 {
                lo + lado / 2.0
            } else {
                (lo + hi) / 2.0
            }
        };
        self.samples
            .iter()
            .filter_map(|s| {
                let c = s.cam?;
                Some((clave_ms(s.t - self.video_offset), (eje(c[0], c[2], ancho), eje(c[1], c[3], alto))))
            })
            .collect()
    }

    fn follow_con(&self, anclas: &[(f64, f64, f64)]) -> Vec<Fix> {
        let mut anclas: Vec<(f64, f64, f64)> = anclas.to_vec();
        anclas.sort_by(|a, b| a.0.total_cmp(&b.0));
        let respaldo = self.follow_pass(&anclas, false);
        let mut out: Vec<Fix> = Vec::new();
        let cubierto = |a: f64, b: f64, out: &mut Vec<Fix>, tramo: Option<Vec<Fix>>| {
            match tramo {
                Some(t) => out.extend(t),
                None => out.extend(respaldo.iter().filter(|f| f.sec > a && f.sec < b).copied()),
            }
        };
        let camaras = self.centros_de_camara();
        let primera = anclas.first().map(|a| a.0).unwrap_or(f64::INFINITY);
        cubierto(f64::NEG_INFINITY, primera, &mut out, None);
        for par in anclas.windows(2) {
            let tramo = self.camino(par[0], par[1], &camaras);
            cubierto(par[0].0, par[1].0, &mut out, tramo);
        }
        if let Some(ultima) = anclas.last() {
            // El propio instante del anclaje y lo que venga después.
            out.extend(respaldo.iter().filter(|f| f.sec >= ultima.0 - 0.5).copied());
        }
        out.sort_by(|a, b| a.sec.total_cmp(&b.sec));
        out.dedup_by(|a, b| (a.sec - b.sec).abs() < 1e-6);
        out
    }

    /// Camino mínimo de iconos aliados entre dos anclajes exactos de la API.
    ///
    /// Nodos: (muestra, icono aliado). Aristas hacia los iconos de las
    /// `SALTO_MAX` muestras siguientes cuyo salto cabe en la velocidad máxima
    /// (o que caen en tu fuente: volver a base o reaparecer es un salto
    /// legítimo). Coste: la distancia recorrida más una penalización por cada
    /// muestra en la que tu icono no se vio. Incluye el instante de los dos
    /// anclajes. `None` si no hay camino.
    fn camino(
        &self,
        a: (f64, f64, f64),
        b: (f64, f64, f64),
        camaras: &std::collections::HashMap<i64, (f64, f64)>,
    ) -> Option<Vec<Fix>> {
        let (salto_max, penaliza_hueco, andar, peso_exceso) = (SALTO_MAX, PENALIZA_HUECO, ANDAR, PESO_EXCESO);
        let peso_camara = PESO_CAMARA;
        let holgura = 300.0;
        let fuente = if self.self_team_id == 100 { (400.0, 400.0) } else { (14400.0, 14450.0) };
        let en_fuente = |x: f64, y: f64| (x - fuente.0).hypot(y - fuente.1) <= 1800.0;

        // Muestras del tramo con sus iconos aliados. Las de los extremos se
        // sustituyen por la posición exacta de la API: el camino tiene que
        // salir y llegar ahí.
        let mut capas: Vec<(f64, Vec<(f64, f64)>)> = vec![(a.0, vec![(a.1, a.2)])];
        // Recargo de cada icono por estar lejos de donde mira la cámara.
        let mut recargo: Vec<Vec<f64>> = vec![vec![0.0]];

        for s in &self.samples {
            let sec = s.t - self.video_offset;
            if sec <= a.0 + 0.25 || sec >= b.0 - 0.25 {
                continue;
            }
            let ic: Vec<(f64, f64)> = s
                .icons
                .iter()
                .filter(|i| i.team == Some(self.self_team_id))
                .map(|i| (i.x, i.y))
                .collect();
            let cam = camaras.get(&clave_ms(sec));
            recargo.push(
                ic.iter()
                    .map(|(x, y)| {
                        cam.map(|(cx, cy)| peso_camara * (cx - x).hypot(cy - y).min(CAMARA_TOPE) / 1000.0)
                            .unwrap_or(0.0)
                    })
                    .collect(),
            );
            capas.push((sec, ic));
        }
        capas.push((b.0, vec![(b.1, b.2)]));
        recargo.push(vec![0.0]);

        let n = capas.len();
        // coste[i][k], previo[i][k] = (capa, icono)
        let mut coste: Vec<Vec<f64>> = capas.iter().map(|c| vec![f64::INFINITY; c.1.len()]).collect();
        let mut previo: Vec<Vec<Option<(usize, usize)>>> = capas.iter().map(|c| vec![None; c.1.len()]).collect();
        coste[0][0] = 0.0;
        for i in 0..n {
            for k in 0..capas[i].1.len() {
                let c0 = coste[i][k];
                if !c0.is_finite() {
                    continue;
                }
                let (t0, (x0, y0)) = (capas[i].0, capas[i].1[k]);
                for j in (i + 1)..(i + 1 + salto_max).min(n) {
                    let dt = capas[j].0 - t0;
                    for (q, &(x1, y1)) in capas[j].1.iter().enumerate() {
                        let d = (x1 - x0).hypot(y1 - y0);
                        let fuente_ok = en_fuente(x1, y1);
                        if d > VELOCIDAD_MAX * dt + holgura && !fuente_ok {
                            continue;
                        }
                        let exceso = if fuente_ok { 0.0 } else { (d - andar * dt - holgura).max(0.0) };
                        let c = c0 + d.min(3000.0) + peso_exceso * exceso + penaliza_hueco * (j - i - 1) as f64 + recargo[j][q];
                        if c < coste[j][q] {
                            coste[j][q] = c;
                            previo[j][q] = Some((i, k));
                        }
                    }
                }
            }
        }
        if !coste[n - 1][0].is_finite() {
            return None;
        }
        let mut camino = Vec::new();
        let mut cur = Some((n - 1, 0usize));
        while let Some((i, k)) = cur {
            let (x, y) = capas[i].1[k];
            camino.push(Fix { sec: capas[i].0, x, y, anchored: i == 0 || i == n - 1 });
            cur = previo[i][k];
        }
        camino.reverse();
        // El extremo final es el principio del tramo siguiente: no se repite.
        camino.pop();
        Some(camino)
    }

    /// Una pasada del seguimiento: hacia delante o (`atras`) desde el final.
    fn follow_pass(&self, anclas: &[(f64, f64, f64)], atras: bool) -> Vec<Fix> {
        let mut out = Vec::new();
        let mut actual: Option<(f64, f64)> = None;
        let mut visto = if atras { f64::INFINITY } else { 0.0f64 };
        let muestras: Box<dyn Iterator<Item = &Sample>> =
            if atras { Box::new(self.samples.iter().rev()) } else { Box::new(self.samples.iter()) };

        for s in muestras {
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

            let dt = (sec - visto).abs();
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
        if atras {
            out.reverse();
        }
        out
    }

    /// Aliados dentro del radio en ese instante, contados del vídeo. Incluye
    /// tu propio icono si está en el radio: quien llama lo descuenta.
    pub fn allies_near(&self, sec: f64, x: f64, y: f64, radio: f64) -> Option<usize> {
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
                .filter(|i| i.team == Some(self.self_team_id))
                .filter(|i| ((i.x - x).powi(2) + (i.y - y).powi(2)).sqrt() <= radio)
                .count(),
        )
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

/// ¿Se midió con el detector actual (el que guarda el recuadro de la cámara)?
///
/// Los ficheros de antes del 2026-10-07 no lo traen, y sin él el rastro cae en
/// otro icono ~40 % de las veces frente a ~3 % (ver `PESO_CAMARA`). Siguen
/// valiendo —todo funciona con ellos—, pero el lote los vuelve a medir. La
/// cabecera va al principio del JSON (el script la escribe antes que las
/// muestras): basta leer un trozo, no varios megas.
pub fn es_actual(match_id: &str) -> bool {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(ruta(match_id)) else { return false };
    let mut buf = [0u8; 1024];
    let n = f.read(&mut buf).unwrap_or(0);
    String::from_utf8_lossy(&buf[..n]).contains("\"camera\"")
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

/// Un lote de partidas procesándose una detrás de otra.
///
/// Existe porque la presión absorbida solo se MIDE en las partidas con
/// minimapa procesado; en el resto se estima con la API, que medido contra el
/// vídeo solo acierta la mitad de los episodios. Procesar de una en una desde el
/// reproductor (unos 4 min cada una en AV1) dejaba 12 de 26 partidas del usuario sin
/// medir. El lote las encadena: una a la vez, porque dos pasadas en paralelo se
/// pelean por la misma GPU y el mismo disco sin terminar antes.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct Lote {
    pub total: usize,
    pub hechas: usize,
    pub fallidas: usize,
    /// La que se está procesando ahora.
    pub actual: Option<String>,
    pub activo: bool,
}

fn lote() -> &'static std::sync::Mutex<Option<Lote>> {
    static L: std::sync::OnceLock<std::sync::Mutex<Option<Lote>>> = std::sync::OnceLock::new();
    L.get_or_init(Default::default)
}

static LOTE_PARAR: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Partidas propias y sincronizadas que se pueden procesar y aún no lo están,
/// de la más nueva a la más vieja.
pub fn pendientes(app: &tauri::AppHandle) -> Vec<String> {
    let mut ms: Vec<crate::storage::MatchMetadata> = crate::storage::load_all_matches()
        .into_iter()
        .filter(|m| !m.is_vod && m.riot_match_id.is_some())
        .collect();
    ms.sort_by(|a, b| b.date.cmp(&a.date));
    ms.into_iter()
        .filter(|m| estado(app, &m.id) == Estado::Falta)
        .map(|m| m.id)
        .collect()
}

/// Partidas ya medidas con el detector anterior (sin el recuadro de la
/// cámara) que se pueden volver a medir, de la más nueva a la más vieja.
pub fn desactualizadas(app: &tauri::AppHandle) -> Vec<String> {
    if recursos(app).is_none() {
        return Vec::new();
    }
    let mut ms: Vec<crate::storage::MatchMetadata> = crate::storage::load_all_matches()
        .into_iter()
        .filter(|m| !m.is_vod && m.riot_match_id.is_some())
        .collect();
    ms.sort_by(|a, b| b.date.cmp(&a.date));
    ms.into_iter()
        .filter(|m| ruta(&m.id).exists() && !es_actual(&m.id) && hay_con_que(&m.id))
        .map(|m| m.id)
        .collect()
}

pub fn estado_lote() -> Option<Lote> {
    lote().lock().ok().and_then(|l| l.clone())
}

/// Lanza el lote con todas las pendientes. Si ya hay uno en marcha, lo devuelve.
pub fn lanzar_lote(app: &tauri::AppHandle) -> Result<Lote, String> {
    use tauri::Emitter;
    {
        let l = lote().lock().map_err(|_| "estado interno corrupto")?;
        if let Some(l) = l.as_ref().filter(|l| l.activo) {
            return Ok(l.clone());
        }
    }
    // Primero las que no tienen nada medido; luego las del detector anterior;
    // luego las que sólo esperan a que se lea su HUD (ver `crate::hud`).
    let mut ids = pendientes(app);
    ids.extend(desactualizadas(app));
    for id in crate::hud::pendientes(app) {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    let inicial = Lote { total: ids.len(), activo: !ids.is_empty(), ..Default::default() };
    *lote().lock().map_err(|_| "estado interno corrupto")? = Some(inicial.clone());
    if ids.is_empty() {
        return Ok(inicial);
    }
    LOTE_PARAR.store(false, std::sync::atomic::Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        let publicar = |app: &tauri::AppHandle| {
            if let Some(l) = estado_lote() {
                let _ = app.emit("minimap_batch", l);
            }
        };
        for id in ids {
            if LOTE_PARAR.load(std::sync::atomic::Ordering::SeqCst) {
                break;
            }
            if let Ok(mut l) = lote().lock() {
                if let Some(l) = l.as_mut() {
                    l.actual = Some(id.clone());
                }
            }
            publicar(&app);
            if !(ruta(&id).exists() && es_actual(&id)) {
                let lanzado = spawn_processing(&app, &id).is_ok();
                // Espera a que termine (el hilo de `spawn_processing` se quita del
                // registro al acabar, bien o mal).
                while lanzado
                    && en_curso().lock().map(|m| m.contains_key(&id)).unwrap_or(false)
                {
                    std::thread::sleep(std::time::Duration::from_millis(1000));
                }
            }
            // La vida y los efectos, del mismo vídeo (bloquea hasta acabar).
            if !LOTE_PARAR.load(std::sync::atomic::Ordering::SeqCst) && crate::hud::falta(&app, &id) {
                if let Err(e) = crate::hud::procesar(&app, &id) {
                    log::warn!("lote: HUD de {id}: {e}");
                }
            }
            let parado = LOTE_PARAR.load(std::sync::atomic::Ordering::SeqCst);
            if let Ok(mut l) = lote().lock() {
                if let Some(l) = l.as_mut() {
                    if es_actual(&id) && !crate::hud::falta(&app, &id) {
                        l.hechas += 1;
                    } else if !parado {
                        l.fallidas += 1;
                    }
                }
            }
            publicar(&app);
        }
        if let Ok(mut l) = lote().lock() {
            if let Some(l) = l.as_mut() {
                l.activo = false;
                l.actual = None;
            }
        }
        publicar(&app);
    });
    Ok(inicial)
}

/// Para el lote: la partida en curso se corta (su parcial se conserva) y no se
/// empieza ninguna más.
pub fn parar_lote() {
    LOTE_PARAR.store(true, std::sync::atomic::Ordering::SeqCst);
    if let Some(actual) = estado_lote().and_then(|l| l.actual) {
        cancelar(&actual);
        crate::hud::cancelar(&actual);
    }
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
    crate::hud::cancelar_todo();
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
    if ruta(match_id).exists() && es_actual(match_id) {
        return Ok(()); // ya procesada con el detector actual
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

#[cfg(test)]
mod tests {
    use super::*;

    fn fichero(self_team: i32, marca: &str) -> String {
        format!(
            r#"{{"fps":2.0,"video_offset":0.0,"self_participant_id":7,"self_team_id":{self_team}{marca},
               "samples":[{{"t":1.0,"icons":[{{"x":1.0,"y":1.0,"team":100}},{{"x":2.0,"y":2.0,"team":200}},{{"x":3.0,"y":3.0,"team":null}}]}}]}}"#
        )
    }

    fn equipos(p: &Positions) -> Vec<Option<i32>> {
        p.samples[0].icons.iter().map(|i| i.team).collect()
    }

    #[test]
    fn lado_rojo_viejo_se_invierte() {
        // Aro azul (= tu equipo) venía como 100 aunque jugaras en el 200.
        let p = Positions::from_json(&fichero(200, "")).unwrap();
        assert_eq!(equipos(&p), vec![Some(200), Some(100), None]);
    }

    #[test]
    fn lado_azul_viejo_no_cambia() {
        let p = Positions::from_json(&fichero(100, "")).unwrap();
        assert_eq!(equipos(&p), vec![Some(100), Some(200), None]);
    }

    #[test]
    fn fichero_nuevo_no_se_toca() {
        let p = Positions::from_json(&fichero(200, r#","team_from":"ally_ring""#)).unwrap();
        assert_eq!(equipos(&p), vec![Some(100), Some(200), None]);
    }

    /// ¿Sigue el rastro a la persona correcta? La verdad son los minutos
    /// exactos de la API: se esconden los impares, se sigue con los pares y se
    /// mira dónde quedó el rastro en los escondidos. Compara la pasada sólo
    /// hacia delante (lo de antes) con `follow` en los dos sentidos.
    /// `MIS_PARTIDAS_DIR=... cargo test --lib seguimiento_en_mis_partidas -- --nocapture`
    #[test]
    fn seguimiento_en_mis_partidas() {
        let Ok(dir) = std::env::var("MIS_PARTIDAS_DIR") else { return };
        let mut err_ida = Vec::new();
        let mut err_dos = Vec::new();
        let (mut falta_ida, mut falta_dos, mut total) = (0, 0, 0);
        for d in std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()) {
            let (Ok(rtl), Ok(rp)) = (
                std::fs::read_to_string(d.join("riot_timeline.json")),
                std::fs::read_to_string(d.join("minimap_positions.json")),
            ) else { continue };
            let Ok(tl) = serde_json::from_str::<crate::riot_api::TimelineDto>(&rtl) else { continue };
            let Some(pos) = Positions::from_json(&rp) else { continue };
            // Para comparar con/sin cámara sobre las mismas partidas.
            if std::env::var("TRK_SOLO_CAM").is_ok() && pos.samples.iter().all(|s| s.cam.is_none()) { continue }
            let k = pos.self_participant_id.to_string();
            let anclas: Vec<(f64, f64, f64)> = tl.info.frames.iter().filter_map(|f| {
                let p = f.participantFrames.get(&k)?.position.as_ref()?;
                Some((f.timestamp as f64 / 1000.0, p.x as f64, p.y as f64))
            }).collect();
            let usadas: Vec<_> = anclas.iter().enumerate().filter(|(i, _)| i % 2 == 0).map(|(_, a)| *a).collect();
            let escondidas: Vec<_> = anclas.iter().enumerate().filter(|(i, _)| i % 2 == 1).map(|(_, a)| *a).collect();
            let ida = pos.follow_pass(&usadas, false);
            let dos = pos.follow(&usadas);
            for (t, x, y) in escondidas {
                total += 1;
                let en = |r: &Vec<Fix>| r.iter().find(|f| (f.sec - t).abs() <= 0.5).map(|f| (f.x - x).hypot(f.y - y));
                match en(&ida) { Some(e) => err_ida.push(e), None => falta_ida += 1 }
                match en(&dos) { Some(e) => err_dos.push(e), None => falta_dos += 1 }
                if let Some(e) = en(&dos) {
                    if e > 1500.0 {
                        // ¿Estaba tu icono en esa muestra?
                        let m = pos.samples.iter().min_by(|p, q| ((p.t - pos.video_offset) - t).abs().total_cmp(&((q.t - pos.video_offset) - t).abs()));
                        let visto = m.is_some_and(|m| m.icons.iter().any(|i| i.team == Some(pos.self_team_id) && (i.x - x).hypot(i.y - y) < 300.0));
                        let muerto = tl.info.frames.iter().flat_map(|f| f.events.iter()).any(|e| e.event_type == "CHAMPION_KILL" && e.victimId == pos.self_participant_id && t - (e.timestamp as f64 / 1000.0) >= 0.0 && t - (e.timestamp as f64 / 1000.0) < 60.0);
                        if std::env::var("TRK_DEBUG").is_ok() {
                            println!("FALLO {} t={:.0} err={:.0} tu_icono_visible={} muerto_reciente={} verdad=({:.0},{:.0})", d.file_name().unwrap().to_string_lossy(), t, e, visto, muerto, x, y);
                        }
                    }
                }
            }
        }
        let resumen = |v: &mut Vec<f64>, falta: usize| {
            v.sort_by(|a, b| a.total_cmp(b));
            let mal = v.iter().filter(|e| **e > 1500.0).count();
            format!("con rastro {}/{} · mediana {:.0} u · p90 {:.0} u · en otro icono (>1500 u) {} ({:.1}%)",
                v.len(), v.len() + falta, v[v.len() / 2], v[v.len() * 9 / 10], mal, 100.0 * mal as f64 / v.len() as f64)
        };
        println!("{total} minutos escondidos");
        println!("solo hacia delante: {}", resumen(&mut err_ida, falta_ida));
        println!("camino entre anclajes: {}", resumen(&mut err_dos, falta_dos));
    }

    #[test]
    fn traza_un_tramo() {
        let Ok(dir) = std::env::var("TRK_TRAZA") else { return };
        let d = std::path::Path::new(&dir);
        let tl: crate::riot_api::TimelineDto = serde_json::from_str(&std::fs::read_to_string(d.join("riot_timeline.json")).unwrap()).unwrap();
        let pos = Positions::from_json(&std::fs::read_to_string(d.join("minimap_positions.json")).unwrap()).unwrap();
        let k = pos.self_participant_id.to_string();
        let anclas: Vec<(f64, f64, f64)> = tl.info.frames.iter().enumerate().filter(|(i, _)| i % 2 == 0).filter_map(|(_, f)| {
            let p = f.participantFrames.get(&k)?.position.as_ref()?;
            Some((f.timestamp as f64 / 1000.0, p.x as f64, p.y as f64))
        }).collect();
        println!("anclas {:?}", &anclas[..2]);
        let tramo = pos.camino(anclas[0], anclas[1], &pos.centros_de_camara());
        match tramo {
            None => println!("SIN CAMINO"),
            Some(t) => for f in t.iter().filter(|f| (f.sec * 2.0).round() as i64 % 10 == 0) { println!("{:.1} ({:.0},{:.0})", f.sec, f.x, f.y) },
        }
    }

    /// Exactitud con TODOS los anclajes, como en producción. La verdad son tus
    /// muertes: la API da la posición exacta al milisegundo, a mitad de minuto.
    #[test]
    fn seguimiento_en_tus_muertes() {
        let Ok(dir) = std::env::var("MIS_PARTIDAS_DIR") else { return };
        let (mut ida, mut camino, mut n) = (Vec::new(), Vec::new(), 0);
        for d in std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()) {
            let (Ok(rtl), Ok(rp)) = (
                std::fs::read_to_string(d.join("riot_timeline.json")),
                std::fs::read_to_string(d.join("minimap_positions.json")),
            ) else { continue };
            let Ok(tl) = serde_json::from_str::<crate::riot_api::TimelineDto>(&rtl) else { continue };
            let Some(pos) = Positions::from_json(&rp) else { continue };
            // Para comparar con/sin cámara sobre las mismas partidas.
            if std::env::var("TRK_SOLO_CAM").is_ok() && pos.samples.iter().all(|s| s.cam.is_none()) { continue }
            let anclas = anclas_de(&tl, pos.self_participant_id);
            let a = pos.follow_pass(&anclas, false);
            let b = pos.follow(&anclas);
            for e in tl.info.frames.iter().flat_map(|f| f.events.iter()) {
                if e.event_type != "CHAMPION_KILL" || e.victimId != pos.self_participant_id { continue }
                let Some(p) = e.position.as_ref() else { continue };
                // Justo ANTES de morir: después tu icono ya no está.
                let t = e.timestamp as f64 / 1000.0 - 1.0;
                n += 1;
                let err = |r: &Vec<Fix>| r.iter().filter(|f| f.sec <= t + 0.6 && f.sec >= t - 2.0).last().map(|f| (f.x - p.x as f64).hypot(f.y - p.y as f64));
                if let Some(x) = err(&a) { ida.push(x) }
                if let Some(x) = err(&b) { camino.push(x) }
            }
        }
        let r = |v: &mut Vec<f64>| { v.sort_by(|a, b| a.total_cmp(b)); let mal = v.iter().filter(|e| **e > 1500.0).count();
            format!("con rastro {}/{} · mediana {:.0} u · en otro icono {} ({:.0}%)", v.len(), n, v[v.len() / 2], mal, 100.0 * mal as f64 / v.len() as f64) };
        println!("{n} muertes");
        println!("antes (solo hacia delante): {}", r(&mut ida));
        println!("camino entre anclajes:      {}", r(&mut camino));
    }
}
