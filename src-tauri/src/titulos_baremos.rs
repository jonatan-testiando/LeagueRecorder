//! Deciles de las métricas de los títulos (`crate::titulos`) que no están en
//! `crate::benchmarks`.
//!
//! GENERADO por `titulos::tests::baremos_de_los_titulos` sobre `D:/lol-corpus`
//! (12888 partidas de 15 minutos o más). No editar a mano: con
//! `TITULOS_ESCRIBIR=1` el test lo reescribe, y sin él comprueba que sigue
//! cuadrando con el corpus.
//!
//!     CORPUS_DIR=D:/lol-corpus TITULOS_ESCRIBIR=1 cargo test --release --lib titulos::tests::baremos_de_los_titulos -- --nocapture

/// Puesto → deciles (10 % … 90 %) de las muertes con el jungla rival como
/// asesino o asistente. Sin los junglas.
pub(crate) const MUERTES_AL_JUNGLA: &[(&str, [f64; 9])] = &[
    ("TOP", [0.0, 1.0, 2.0, 2.0, 3.0, 3.0, 4.0, 5.0, 6.0]),   // n=25752
    ("MIDDLE", [0.0, 1.0, 2.0, 2.0, 3.0, 3.0, 4.0, 5.0, 6.0]),   // n=25756
    ("BOTTOM", [0.0, 1.0, 1.0, 2.0, 2.0, 3.0, 3.0, 4.0, 5.0]),   // n=25753
    ("UTILITY", [0.0, 1.0, 2.0, 2.0, 3.0, 3.0, 4.0, 5.0, 6.0]),   // n=25755
];
