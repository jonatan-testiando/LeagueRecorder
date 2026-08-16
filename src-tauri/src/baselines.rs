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
    ("TOP", [-0.058, -0.029, -0.007, 0.014, 0.036, 0.057, 0.080, 0.112, 0.164]),
    ("JUNGLE", [-0.039, -0.012, 0.013, 0.036, 0.058, 0.083, 0.105, 0.135, 0.184]),
    ("MIDDLE", [-0.048, -0.020, 0.004, 0.025, 0.046, 0.067, 0.092, 0.125, 0.170]),
    ("BOTTOM", [-0.050, -0.023, -0.003, 0.017, 0.038, 0.059, 0.085, 0.119, 0.167]),
    ("UTILITY", [-0.063, -0.045, -0.031, -0.019, -0.005, 0.009, 0.026, 0.045, 0.072]),
];

/// Tramos de rango, de menor a mayor.
pub const TRAMOS: [&str; 3] = ["bajo", "medio", "alto"];

/// Deciles por (tramo, rol). Vacío hasta que el etiquetado de rangos avance lo
/// suficiente; mientras tanto `percentil` cae al baremo por rol a secas, que ya
/// corrige el sesgo grande (el techo del support).
const DECILES_POR_TRAMO: &[(&str, &str, [f64; 9])] = &[];

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
