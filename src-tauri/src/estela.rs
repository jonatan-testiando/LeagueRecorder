//! La estela del ratón de una partida, en su propio fichero binario.
//!
//! Era el 99 % del metadata (`{id}.json`): decenas de miles de objetos
//! `{t,x,y,evt}` que todo lo que listaba la biblioteca tenía que tokenizar para
//! tirarlos, y que el reproductor recibía como 2 MB de JSON. Ahora vive en
//! `estela.bin`, al lado del metadata, y solo la leen quienes la usan (el
//! reproductor, manos, golpes, barras y miradas).
//!
//! Formato (little-endian), pensado para leerse sin copiar desde JS
//! (`Float64Array` sobre el `ArrayBuffer`) y desde Python (`np.frombuffer`):
//!
//! ```text
//! "WDES"            4 bytes, firma
//! version  u32      = 1
//! n_tipos  u32      tipos de evento distintos ("move", "right_click", "key_q"…)
//!   n_tipos × (u8 longitud, bytes UTF-8)
//! n        u32      número de puntos
//! relleno  0-7 bytes hasta múltiplo de 8 desde el principio del fichero
//! t        f64 × n  segundos de vídeo
//! x        f64 × n  coordenadas del escritorio (ver `mouse_space_w/h`)
//! y        f64 × n
//! evt      u8  × n  índice en la tabla de tipos
//! ```
//!
//! Todo en `f64` a propósito: es lo mismo que guardaba el JSON, así que pasar
//! de uno a otro no cambia ni un bit de lo que ven los análisis. El tamaño da
//! igual al lado del vídeo (unos 0,9 MB frente a los 3-5 MB de antes).

use crate::storage::MouseEventData;
use std::path::{Path, PathBuf};

pub const FICHERO: &str = "estela.bin";
const FIRMA: &[u8; 4] = b"WDES";
const VERSION: u32 = 1;

/// Dónde vive la estela de la partida cuya carpeta es `dir`.
pub fn ruta(dir: &Path) -> PathBuf {
    dir.join(FICHERO)
}

pub fn codificar(puntos: &[MouseEventData]) -> Vec<u8> {
    let mut tipos: Vec<&str> = Vec::new();
    let mut indices: Vec<u8> = Vec::with_capacity(puntos.len());
    for p in puntos {
        let i = match tipos.iter().position(|t| *t == p.evt) {
            Some(i) => i,
            None => {
                tipos.push(&p.evt);
                tipos.len() - 1
            }
        };
        // Más de 255 tipos distintos no existe (hoy son una docena): si algún
        // día pasa, los que sobran se quedan con el último índice antes que
        // romper el guardado.
        indices.push(i.min(255) as u8);
    }

    let mut out = Vec::with_capacity(64 + puntos.len() * 25);
    out.extend_from_slice(FIRMA);
    out.extend_from_slice(&VERSION.to_le_bytes());
    out.extend_from_slice(&(tipos.len().min(256) as u32).to_le_bytes());
    for t in tipos.iter().take(256) {
        let b = t.as_bytes();
        let n = b.len().min(255);
        out.push(n as u8);
        out.extend_from_slice(&b[..n]);
    }
    out.extend_from_slice(&(puntos.len() as u32).to_le_bytes());
    while out.len() % 8 != 0 {
        out.push(0);
    }
    for p in puntos {
        out.extend_from_slice(&p.t.to_le_bytes());
    }
    for p in puntos {
        out.extend_from_slice(&p.x.to_le_bytes());
    }
    for p in puntos {
        out.extend_from_slice(&p.y.to_le_bytes());
    }
    out.extend_from_slice(&indices);
    out
}

struct Lector<'a> {
    datos: &'a [u8],
    pos: usize,
}

impl<'a> Lector<'a> {
    fn tomar(&mut self, n: usize) -> Result<&'a [u8], String> {
        let fin = self.pos.checked_add(n).filter(|f| *f <= self.datos.len()).ok_or("estela cortada")?;
        let trozo = &self.datos[self.pos..fin];
        self.pos = fin;
        Ok(trozo)
    }

    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(self.tomar(4)?.try_into().expect("4 bytes")))
    }

    fn f64s(&mut self, n: usize) -> Result<Vec<f64>, String> {
        let b = self.tomar(n.checked_mul(8).ok_or("estela cortada")?)?;
        Ok(b.chunks_exact(8).map(|c| f64::from_le_bytes(c.try_into().expect("8 bytes"))).collect())
    }
}

pub fn decodificar(datos: &[u8]) -> Result<Vec<MouseEventData>, String> {
    let mut l = Lector { datos, pos: 0 };
    if l.tomar(4)? != FIRMA {
        return Err("no es un fichero de estela".into());
    }
    let version = l.u32()?;
    if version != VERSION {
        return Err(format!("versión de estela desconocida: {version}"));
    }
    let n_tipos = l.u32()? as usize;
    let mut tipos = Vec::with_capacity(n_tipos.min(256));
    for _ in 0..n_tipos {
        let n = l.tomar(1)?[0] as usize;
        tipos.push(String::from_utf8_lossy(l.tomar(n)?).into_owned());
    }
    let n = l.u32()? as usize;
    let relleno = (8 - l.pos % 8) % 8;
    l.tomar(relleno)?;
    let t = l.f64s(n)?;
    let x = l.f64s(n)?;
    let y = l.f64s(n)?;
    let evt = l.tomar(n)?;

    Ok((0..n)
        .map(|i| MouseEventData {
            t: t[i],
            x: x[i],
            y: y[i],
            evt: tipos.get(evt[i] as usize).cloned().unwrap_or_default(),
        })
        .collect())
}

/// Los bytes del fichero, tal cual: lo que se manda al reproductor.
pub fn bytes(dir: &Path) -> Option<Vec<u8>> {
    std::fs::read(ruta(dir)).ok()
}

/// La estela de la partida, o `None` si no hay fichero (partida aún sin
/// migrar, o sin estela) o está dañado.
pub fn cargar(dir: &Path) -> Option<Vec<MouseEventData>> {
    let datos = bytes(dir)?;
    match decodificar(&datos) {
        Ok(v) => Some(v),
        Err(e) => {
            eprintln!("estela: {} no se puede leer: {e}", ruta(dir).display());
            None
        }
    }
}

/// Guarda la estela. Si el fichero ya tiene exactamente estos bytes no se toca:
/// varias cachés se dan por frescas mirando su fecha, y reescribir lo mismo las
/// invalidaría sin motivo.
pub fn guardar(dir: &Path, puntos: &[MouseEventData]) -> std::io::Result<()> {
    let datos = codificar(puntos);
    let destino = ruta(dir);
    if std::fs::read(&destino).map(|prev| prev == datos).unwrap_or(false) {
        return Ok(());
    }
    crate::storage::escribir_atomico(&destino, &datos)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(t: f64, x: f64, y: f64, evt: &str) -> MouseEventData {
        MouseEventData { t, x, y, evt: evt.into() }
    }

    fn iguales(a: &[MouseEventData], b: &[MouseEventData]) {
        assert_eq!(a.len(), b.len());
        for (u, v) in a.iter().zip(b) {
            assert_eq!(u.t.to_bits(), v.t.to_bits());
            assert_eq!(u.x.to_bits(), v.x.to_bits());
            assert_eq!(u.y.to_bits(), v.y.to_bits());
            assert_eq!(u.evt, v.evt);
        }
    }

    #[test]
    fn ida_y_vuelta_sin_perder_un_bit() {
        let v = vec![
            p(0.0, 1403.0, 1287.0, "move"),
            p(0.123456789012345, 1399.5, 1306.25, "right_click"),
            p(12.000000000000002, -3.0, 0.1, "key_q"),
            p(3600.5, 2559.0, 1439.0, "move"),
            p(f64::MAX, 1e-300, -0.0, "click_attack"),
        ];
        let datos = codificar(&v);
        iguales(&decodificar(&datos).unwrap(), &v);
    }

    #[test]
    fn vacia() {
        let datos = codificar(&[]);
        assert!(decodificar(&datos).unwrap().is_empty());
    }

    #[test]
    fn columnas_alineadas_a_8() {
        // JS crea `Float64Array` encima del ArrayBuffer: exige múltiplo de 8.
        for tipos in [vec!["move"], vec!["move", "right_click", "key_r"], vec!["a"; 1]] {
            let v: Vec<_> = tipos.iter().enumerate().map(|(i, e)| p(i as f64, 1.0, 2.0, e)).collect();
            let datos = codificar(&v);
            let n = v.len();
            let inicio_t = datos.len() - n * 25;
            assert_eq!(inicio_t % 8, 0);
        }
    }

    #[test]
    fn rechaza_lo_que_no_es_estela() {
        assert!(decodificar(b"").is_err());
        assert!(decodificar(b"XXXX\x01\0\0\0").is_err());
        let mut datos = codificar(&[p(1.0, 2.0, 3.0, "move")]);
        datos.truncate(datos.len() - 3);
        assert!(decodificar(&datos).is_err());
    }

    #[test]
    fn guardar_no_reescribe_lo_mismo() {
        let dir = std::env::temp_dir().join(format!("estela-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let v = vec![p(1.0, 2.0, 3.0, "move")];
        guardar(&dir, &v).unwrap();
        let antes = std::fs::metadata(ruta(&dir)).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        guardar(&dir, &v).unwrap();
        let despues = std::fs::metadata(ruta(&dir)).unwrap().modified().unwrap();
        assert_eq!(antes, despues);
        iguales(&cargar(&dir).unwrap(), &v);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
