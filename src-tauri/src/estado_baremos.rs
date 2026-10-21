//! Líneas del corpus para `crate::estado_partida`: los terciles del oro al
//! 14 por rol, cuánto se gana en cada estado, la tasa de vuelco y cuánto se
//! gana por tramo de nota.
//!
//! GENERADO por `estado_partida::tests::baremos_del_estado` sobre `D:/lol-corpus`
//! (12912 partidas de 15 minutos o más). No editar a mano: con `ESTADO_ESCRIBIR=1`
//! el test lo reescribe, y sin él comprueba que sigue cuadrando con el corpus.
//!
//!     CORPUS_DIR=D:/lol-corpus ESTADO_ESCRIBIR=1 cargo test --release --lib estado_partida::tests::baremos_del_estado -- --nocapture

/// Rol → [corte bajo, corte alto] del oro con tu rival al 14: por debajo del
/// primero vas por detrás, por encima del segundo por delante.
pub(crate) const TERCILES_ORO_14: &[(&str, [f64; 2])] = &[
    ("TOP", [-666.0, 666.0]),   // n=25798
    ("JUNGLE", [-491.0, 489.0]),   // n=25802
    ("MIDDLE", [-567.0, 567.0]),   // n=25806
    ("BOTTOM", [-658.0, 658.0]),   // n=25800
    ("UTILITY", [-349.0, 349.0]),   // n=25802
];

/// Rol → victorias (0-1) por delante, igualado y por detrás.
pub(crate) const GANA_POR_ESTADO: &[(&str, [f64; 3])] = &[
    ("TOP", [0.6353, 0.5000, 0.3647]),
    ("JUNGLE", [0.6575, 0.5000, 0.3423]),
    ("MIDDLE", [0.6538, 0.5000, 0.3460]),
    ("BOTTOM", [0.6680, 0.5000, 0.3320]),
    ("UTILITY", [0.6340, 0.5000, 0.3660]),
];

/// Franja → de los equipos que llegaron al 65 %, cuántos perdieron (que es
/// también cuántos ganaron de los que cayeron al 35 %). `""` es el corpus entero.
pub(crate) const VUELCO: &[(&str, f64)] = &[
    ("", 0.3010),   // n=18228
    ("bajo", 0.2997),   // n=11444
    ("medio", 0.3007),   // n=908
    ("alto", 0.3034),   // n=5821
];

/// Victorias (0-1) por tramo de nota: 0-20, 20-40, 40-60, 60-80 y 80-100.
pub(crate) const GANA_POR_NOTA: [f64; 5] = [0.2397, 0.3613, 0.5569, 0.6538, 0.6868];

/// Victorias (0-1) del MVP de la partida: el mejor percentil de los diez.
pub(crate) const GANA_MVP: f64 = 0.8171;
