//! Normalización por rol: convertir "aportaste +12%" en "aportaste más que el
//! 85% de los supports".
//!
//! Un WPA en bruto no sirve para comparar jugadores: el techo de un support es
//! estructuralmente más bajo que el de un carry, porque el modelo valora lo que
//! mueve la probabilidad de victoria y el support mueve menos cosas *él solo*.
//! Sin normalizar, cualquier ranking premia al carry por serlo — que es
//! exactamente el defecto que tienen todos los scores públicos.
//!
//! La solución es el percentil dentro del rol: no "cuánto aportaste" sino
//! "cuánto aportaste comparado con quien juega tu puesto".
//!
//! La otra mitad es el elo: un MVP en Hierro no es un MVP en Máster. El rango se
//! etiqueta aparte (`tools/corpus/fetch_tiers.py`, una petición por partida
//! aprovechando que el emparejamiento junta rangos parecidos) y se agrupa en
//! tres tramos. Tres y no diez porque cada celda del baremo es (tramo x rol):
//! con diez harían falta 50 celdas con muestra suficiente.

/// Los cinco puestos, tal y como los nombra Riot en `teamPosition`.
pub const ROLES: [&str; 5] = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];

/// Deciles de WPA por rol, medidos sobre el corpus con
/// `tests::calcular_percentiles_por_rol`. Cada fila son los cortes del 10% al
/// 90% para ese rol.
///
/// Se rellenan con datos, no a ojo: la prueba los imprime listos para pegar y
/// además comprueba que los que hay aquí sigan cuadrando con el corpus.
const DECILES: [(&str, [f64; 9]); 5] = [
    ("TOP", [-0.082, -0.039, -0.008, 0.021, 0.051, 0.082, 0.120, 0.174, 0.260]),   // n=18502
    ("JUNGLE", [-0.057, -0.021, 0.007, 0.033, 0.057, 0.085, 0.117, 0.162, 0.242]),   // n=18516
    ("MIDDLE", [-0.067, -0.027, 0.002, 0.031, 0.059, 0.089, 0.125, 0.176, 0.260]),   // n=18508
    ("BOTTOM", [-0.067, -0.029, -0.002, 0.024, 0.050, 0.079, 0.113, 0.159, 0.245]),   // n=18503
    ("UTILITY", [-0.092, -0.058, -0.035, -0.016, 0.002, 0.022, 0.043, 0.070, 0.115]),   // n=18505
];

/// Tramos de rango, de menor a mayor.
pub const TRAMOS: [&str; 3] = ["bajo", "medio", "alto"];

/// Deciles por (tramo, rol), medidos sobre 9.219 partidas con rango conocido.
///
/// **El efecto del rango es modesto y depende del rol**, al revés de lo que
/// cabría esperar. Medianas de WPA por tramo (bajo / medio / alto):
///
/// ```text
///   JUNGLA    0.048  0.060  0.070   sube con el rango
///   MEDIO     0.047  0.044  0.047   plano
///   TIRADOR   0.036  0.042  0.037   plano
///   TOP       0.039  0.040  0.028   BAJA
///   SUPPORT  -0.000 -0.007 -0.012   BAJA
/// ```
///
/// Sólo la jungla gana peso al subir de nivel; top y support lo pierden. Sea
/// cual sea la explicación, la consecuencia práctica es que esta corrección es
/// mucho más pequeña que la del rol (support −0,006 frente a tirador +0,038),
/// y conviene no venderla como más de lo que es.
const DECILES_POR_TRAMO: &[(&str, &str, [f64; 9])] = &[
    ("bajo", "TOP", [-0.082, -0.039, -0.007, 0.022, 0.051, 0.082, 0.122, 0.176, 0.263]),   // n=16277
    ("bajo", "JUNGLE", [-0.058, -0.022, 0.005, 0.031, 0.055, 0.082, 0.115, 0.160, 0.242]),   // n=16290
    ("bajo", "MIDDLE", [-0.067, -0.026, 0.003, 0.031, 0.059, 0.089, 0.126, 0.178, 0.262]),   // n=16281
    ("bajo", "BOTTOM", [-0.068, -0.030, -0.003, 0.023, 0.050, 0.079, 0.113, 0.159, 0.245]),   // n=16277
    ("bajo", "UTILITY", [-0.091, -0.057, -0.034, -0.015, 0.004, 0.023, 0.045, 0.072, 0.118]),   // n=16279
    ("medio", "TOP", [-0.071, -0.036, -0.005, 0.022, 0.051, 0.083, 0.116, 0.162, 0.256]),   // n=1295
    ("medio", "JUNGLE", [-0.051, -0.014, 0.015, 0.043, 0.068, 0.096, 0.132, 0.168, 0.235]),   // n=1296
    ("medio", "MIDDLE", [-0.072, -0.031, -0.002, 0.027, 0.054, 0.085, 0.120, 0.160, 0.230]),   // n=1297
    ("medio", "BOTTOM", [-0.060, -0.022, 0.004, 0.029, 0.054, 0.082, 0.118, 0.166, 0.251]),   // n=1296
    ("medio", "UTILITY", [-0.092, -0.061, -0.039, -0.019, -0.003, 0.014, 0.033, 0.059, 0.096]),   // n=1296
    ("alto", "TOP", [-0.084, -0.043, -0.015, 0.012, 0.038, 0.071, 0.105, 0.154, 0.215]),   // n=852
    ("alto", "JUNGLE", [-0.045, -0.007, 0.022, 0.056, 0.082, 0.116, 0.144, 0.190, 0.257]),   // n=852
    ("alto", "MIDDLE", [-0.063, -0.025, 0.004, 0.030, 0.061, 0.096, 0.130, 0.180, 0.266]),   // n=852
    ("alto", "BOTTOM", [-0.060, -0.025, 0.003, 0.029, 0.053, 0.080, 0.115, 0.163, 0.232]),   // n=852
    ("alto", "UTILITY", [-0.098, -0.065, -0.045, -0.029, -0.012, 0.004, 0.027, 0.047, 0.077]),   // n=852
];

/// Igual que `percentil` pero teniendo en cuenta el rango en que se jugó.
///
/// Es lo que separa "aportaste más que el 85% de los supports" de "…más que el
/// 85% de los supports **de tu rango**", que es la comparación que de verdad
/// significa algo.
pub fn percentil_en_tramo(tramo: &str, rol: &str, wpa: f64) -> f64 {
    if let Some((_, _, cortes)) = DECILES_POR_TRAMO
        .iter()
        .find(|(t, r, _)| *t == tramo && *r == rol)
    {
        return interpolar(cortes, wpa);
    }
    percentil(rol, wpa)
}

/// En qué percentil (0..100) cae un WPA para un rol dado.
///
/// Interpola linealmente entre deciles, así que el resultado es continuo y no
/// da saltos de diez en diez.
pub fn percentil(rol: &str, wpa: f64) -> f64 {
    let cortes = DECILES
        .iter()
        .find(|(r, _)| *r == rol)
        .map(|(_, c)| c)
        // Un rol desconocido (partidas raras, `teamPosition` vacío) cae al
        // reparto del carril central, que es el más parecido a la media.
        .unwrap_or(&DECILES[2].1);

    interpolar(cortes, wpa)
}

fn interpolar(cortes: &[f64; 9], wpa: f64) -> f64 {
    if wpa <= cortes[0] {
        return 10.0 * (wpa / cortes[0]).clamp(0.0, 1.0);
    }
    for i in 0..cortes.len() - 1 {
        if wpa < cortes[i + 1] {
            let f = (wpa - cortes[i]) / (cortes[i + 1] - cortes[i]);
            return 10.0 * (i as f64 + 1.0 + f);
        }
    }
    // Por encima del decil 9: se estira hasta 100 con el último tramo.
    let ultimo = cortes[8];
    let paso = cortes[8] - cortes[7];
    (90.0 + 10.0 * ((wpa - ultimo) / paso.max(1e-6)).min(1.0)).min(100.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::riot_api::{ParticipantDto, TimelineDto};
    use std::io::Read;

    /// Igual que el de por rol, pero cruzando con el rango en que se jugó.
    ///
    /// El rango sale de `tiers.json`, que genera `tools/corpus/fetch_tiers.py`
    /// pidiendo el rango de un participante por partida (el emparejamiento junta
    /// rangos parecidos, así que etiqueta la partida entera).
    #[test]
    fn calcular_percentiles_por_tramo() {
        let Ok(corpus) = std::env::var("CORPUS_DIR") else {
            return;
        };
        let Ok(raw) = std::fs::read_to_string(format!("{corpus}/tiers.json")) else {
            println!("sin tiers.json: hay que correr fetch_tiers.py primero");
            return;
        };
        let tramos: std::collections::HashMap<String, String> =
            serde_json::from_str(&raw).unwrap();

        let mut datos: std::collections::HashMap<(String, String), Vec<f64>> = Default::default();
        let Ok(sub) = std::fs::read_dir(format!("{corpus}/partidas")) else { return };
        let mut n = 0usize;
        for dir in sub.flatten() {
            let Ok(ficheros) = std::fs::read_dir(dir.path()) else { continue };
            for f in ficheros.flatten() {
                let id = f
                    .file_name()
                    .to_str()
                    .and_then(|s| s.strip_suffix(".json.gz"))
                    .map(str::to_string);
                let Some(id) = id else { continue };
                let Some(tramo) = tramos.get(&id) else { continue };
                if tramo == "sin" {
                    continue;
                }
                let Ok(bytes) = std::fs::read(f.path()) else { continue };
                let mut texto = String::new();
                if flate2::read::GzDecoder::new(&bytes[..])
                    .read_to_string(&mut texto)
                    .is_err()
                {
                    continue;
                }
                let Ok(d) = serde_json::from_str::<serde_json::Value>(&texto) else { continue };
                let Ok(ps) = serde_json::from_value::<Vec<ParticipantDto>>(
                    d["match"]["info"]["participants"].clone(),
                ) else {
                    continue;
                };
                let Ok(tl) = serde_json::from_value::<TimelineDto>(d["timeline"].clone()) else {
                    continue;
                };
                let wpa = crate::winprob::per_player(&crate::winprob::plays(&tl, &ps));
                for (i, p) in ps.iter().enumerate() {
                    let rol = if p.teamPosition.is_empty() {
                        p.individualPosition.clone()
                    } else {
                        p.teamPosition.clone()
                    };
                    if !ROLES.contains(&rol.as_str()) {
                        continue;
                    }
                    datos
                        .entry((tramo.clone(), rol))
                        .or_default()
                        .push(wpa.get(&((i + 1) as i32)).copied().unwrap_or(0.0));
                }
                n += 1;
            }
        }

        println!("
{n} partidas con rango conocido
");
        println!("const DECILES_POR_TRAMO: &[(&str, &str, [f64; 9])] = &[");
        for tramo in TRAMOS {
            for rol in ROLES {
                let Some(v) = datos.get_mut(&(tramo.to_string(), rol.to_string())) else {
                    continue;
                };
                if v.len() < 200 {
                    println!("    // {tramo}/{rol}: sólo {} muestras, se omite", v.len());
                    continue;
                }
                v.sort_by(f64::total_cmp);
                let d: Vec<String> = (1..=9)
                    .map(|q| format!("{:.3}", v[(v.len() as f64 * q as f64 / 10.0) as usize]))
                    .collect();
                println!("    (\"{tramo}\", \"{rol}\", [{}]),   // n={}", d.join(", "), v.len());
            }
        }
        println!("];");

        // La mediana debería subir con el rango: en partidas de más nivel el
        // mismo rol mueve más la probabilidad de victoria. Si no se cumpliera,
        // separar por tramos no aportaría nada.
        for rol in ROLES {
            let m: Vec<String> = TRAMOS
                .iter()
                .filter_map(|t| datos.get(&(t.to_string(), rol.to_string())))
                .map(|v| {
                    let mut v = v.clone();
                    v.sort_by(f64::total_cmp);
                    format!("{:.4}", v[v.len() / 2])
                })
                .collect();
            println!("  mediana {rol:8}: {}", m.join("  "));
        }
    }

    /// Recorre el corpus comprimido y saca la distribución de WPA por rol.
    ///
    /// Imprime los deciles listos para pegar en `DECILES`, y comprueba que los
    /// que ya están no se hayan quedado obsoletos: el corpus crece, y unos
    /// baremos viejos convertirían percentiles en mentiras.
    #[test]
    fn calcular_percentiles_por_rol() {
        let Ok(corpus) = std::env::var("CORPUS_DIR") else {
            return;
        };
        let mut por_rol: std::collections::HashMap<String, Vec<f64>> = Default::default();
        let mut partidas = 0usize;

        let sub = std::fs::read_dir(format!("{corpus}/partidas"));
        let Ok(sub) = sub else { return };
        for dir in sub.flatten() {
            let Ok(ficheros) = std::fs::read_dir(dir.path()) else { continue };
            for f in ficheros.flatten() {
                let Ok(bytes) = std::fs::read(f.path()) else { continue };
                let mut texto = String::new();
                if flate2::read::GzDecoder::new(&bytes[..])
                    .read_to_string(&mut texto)
                    .is_err()
                {
                    continue; // el rastreador puede estar escribiéndolo ahora
                }
                let Ok(d) = serde_json::from_str::<serde_json::Value>(&texto) else { continue };
                let Ok(ps) = serde_json::from_value::<Vec<ParticipantDto>>(
                    d["match"]["info"]["participants"].clone(),
                ) else {
                    continue;
                };
                let Ok(tl) = serde_json::from_value::<TimelineDto>(d["timeline"].clone()) else {
                    continue;
                };
                let wpa = crate::winprob::per_player(&crate::winprob::plays(&tl, &ps));
                for (i, p) in ps.iter().enumerate() {
                    let rol = if p.teamPosition.is_empty() {
                        p.individualPosition.clone()
                    } else {
                        p.teamPosition.clone()
                    };
                    if !ROLES.contains(&rol.as_str()) {
                        continue;
                    }
                    por_rol
                        .entry(rol)
                        .or_default()
                        .push(wpa.get(&((i + 1) as i32)).copied().unwrap_or(0.0));
                }
                partidas += 1;
            }
        }
        if partidas < 50 {
            println!("corpus demasiado pequeño ({partidas} partidas), no se comprueba");
            return;
        }

        println!("\n{partidas} partidas del corpus\n");
        println!("const DECILES: [(&str, [f64; 9]); 5] = [");
        let mut desviados = Vec::new();
        for rol in ROLES {
            let Some(v) = por_rol.get_mut(rol) else { continue };
            v.sort_by(f64::total_cmp);
            let d: Vec<f64> = (1..=9)
                .map(|q| v[(v.len() as f64 * q as f64 / 10.0) as usize])
                .collect();
            let fila: Vec<String> = d.iter().map(|x| format!("{x:.3}")).collect();
            println!("    (\"{rol}\", [{}]),   // n={}", fila.join(", "), v.len());

            // Contraste con lo que está compilado ahora mismo.
            if let Some((_, actuales)) = DECILES.iter().find(|(r, _)| *r == rol) {
                let peor = d
                    .iter()
                    .zip(actuales.iter())
                    .map(|(a, b)| (a - b).abs())
                    .fold(0.0f64, f64::max);
                if peor > 0.03 {
                    desviados.push(format!("{rol} (hasta {peor:.3})"));
                }
            }
        }
        println!("];");

        // La mediana del support tiene que ser más baja que la del carry: si no,
        // no habría nada que normalizar y el módulo entero sobraría.
        let mediana = |rol: &str| -> f64 {
            let v = &por_rol[rol];
            v[v.len() / 2]
        };
        println!(
            "\nmediana de WPA — support {:.4} vs tirador {:.4}",
            mediana("UTILITY"),
            mediana("BOTTOM")
        );

        assert!(
            desviados.is_empty(),
            "los deciles compilados se han quedado desfasados: {}. \
             Copia los de arriba.",
            desviados.join(", ")
        );
    }

    #[test]
    fn el_percentil_es_monotono_y_esta_acotado() {
        for rol in ROLES {
            let mut anterior = -1.0;
            for paso in -30..=30 {
                let p = percentil(rol, paso as f64 / 100.0);
                assert!((0.0..=100.0).contains(&p), "{rol}: percentil fuera de rango: {p}");
                assert!(p >= anterior - 1e-9, "{rol}: el percentil baja al subir el WPA");
                anterior = p;
            }
        }
    }

    #[test]
    fn el_mismo_wpa_vale_mas_para_un_support() {
        // Aportar +0,05 de probabilidad es más excepcional en el puesto con el
        // techo más bajo. Si esto dejara de cumplirse, la normalización no
        // estaría haciendo nada.
        let sup = percentil("UTILITY", 0.05);
        let adc = percentil("BOTTOM", 0.05);
        assert!(sup > adc, "support {sup:.1} deberia superar a tirador {adc:.1}");
    }
}
