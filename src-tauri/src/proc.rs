/// Windows abre una consola negra por cada proceso hijo que lanzamos (ffmpeg,
/// ffprobe, python, taskkill...). `CREATE_NO_WINDOW` la suprime. En el resto de
/// plataformas esta función no hace nada.
///
/// Devuelve el mismo `Command` para poder encadenar:
/// `hide_console(Command::new("ffmpeg").args(&[...])).output()`
pub fn hide_console(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

#[cfg(target_os = "windows")]
const FFMPEG_REL: &str = "bin/ffmpeg.exe";
#[cfg(not(target_os = "windows"))]
const FFMPEG_REL: &str = "bin/ffmpeg";

/// Ruta del ffmpeg EMPAQUETADO. Si no aparece, cae al `ffmpeg` del PATH.
///
/// Resolverlo explícitamente importa: al migrar la grabación a libobs se eliminó
/// `recorder::ffmpeg_path` y las llamadas se quedaron invocando "ffmpeg" a pelo.
/// El binario se seguía empaquetando pero no lo usaba nadie, así que exportar
/// clips solo funcionaba en máquinas que ya tuvieran ffmpeg instalado.
pub fn ffmpeg(app: &tauri::AppHandle) -> String {
    crate::cv_analyzer::resolve_resource(app, FFMPEG_REL)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "ffmpeg".to_string())
}

/// Resolución del primer stream de vídeo, leyendo la cabecera que `ffmpeg -i`
/// escribe en stderr.
///
/// Se hace así a propósito para no depender de un segundo binario: `ffprobe` no
/// se empaqueta, así que la llamada anterior solo funcionaba si el usuario lo
/// tenía en el PATH. `ffmpeg -i` sin salida termina con código 1; es lo esperado,
/// solo nos interesa stderr.
pub fn video_dimensions(ffmpeg_exe: &str, path: &str) -> Option<(f64, f64)> {
    video_info(ffmpeg_exe, path).map(|(w, h, _)| (w, h))
}

/// Resolución y duración de una sola pasada.
///
/// La cabecera trae las dos cosas, así que preguntarlas por separado costaba
/// dos lecturas del fichero. La duración es `Option` porque hay contenedores
/// que no la declaran; la resolución, si falta, es que no hay vídeo que leer.
pub fn video_info(ffmpeg_exe: &str, path: &str) -> Option<(f64, f64, Option<f64>)> {
    let out = hide_console(std::process::Command::new(ffmpeg_exe).args(["-hide_banner", "-i", path]))
        .output()
        .ok()?;
    let texto = String::from_utf8_lossy(&out.stderr);
    let (w, h) = parse_dimensions(&texto)?;
    Some((w, h, parse_duration(&texto)))
}

/// Segundos de la línea `Duration: HH:MM:SS.cc` de la cabecera.
fn parse_duration(text: &str) -> Option<f64> {
    let resto = text.split("Duration:").nth(1)?.trim_start();
    let reloj = resto.split(',').next()?.trim();
    if reloj.starts_with("N/A") {
        return None;
    }
    let mut partes = reloj.split(':');
    let h: f64 = partes.next()?.trim().parse().ok()?;
    let m: f64 = partes.next()?.trim().parse().ok()?;
    let s: f64 = partes.next()?.trim().parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

fn parse_dimensions(text: &str) -> Option<(f64, f64)> {
    for line in text.lines() {
        if !line.contains("Stream #") || !line.contains("Video:") {
            continue;
        }
        // La línea trae varios campos separados por comas; buscamos el "ANCHOxALTO".
        // El tag de códec ("0x31637661") también parte por 'x', pero da ancho 0 y
        // lo descarta el rango.
        for tok in line.split([' ', ',']) {
            if let Some((w, h)) = tok.trim().split_once('x') {
                if let (Ok(w), Ok(h)) = (w.parse::<f64>(), h.parse::<f64>()) {
                    if (16.0..=16384.0).contains(&w) && (16.0..=16384.0).contains(&h) {
                        return Some((w, h));
                    }
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{parse_dimensions, parse_duration};

    // Salida real de `ffmpeg -i` sobre una grabación de la app y sobre un VOD
    // importado. Lo delicado es que el tag de códec ("0x31637661") y el índice de
    // stream ("#0:0[0x1]") también contienen una 'x'.
    const REC_1440P: &str = "  Duration: 00:00:25.38, start: 0.000000, bitrate: 8076 kb/s\n  Stream #0:0[0x1](und): Video: h264 (Main) (avc1 / 0x31637661), yuv420p(progressive), 2560x1440 [SAR 1:1 DAR 16:9], 8073 kb/s, 60 fps, 60 tbr, 60k tbn (default)";
    const VOD_1080P: &str = "  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 5451 kb/s, 60 fps, 60 tbr, 15360 tbn (default)";

    #[test]
    fn lee_la_resolucion_ignorando_el_tag_de_codec() {
        assert_eq!(parse_dimensions(REC_1440P), Some((2560.0, 1440.0)));
        assert_eq!(parse_dimensions(VOD_1080P), Some((1920.0, 1080.0)));
    }

    #[test]
    fn lee_la_duracion_de_la_cabecera() {
        assert_eq!(parse_duration(REC_1440P), Some(25.38));
        // Un VOD sin línea de duración no debe inventarse una.
        assert_eq!(parse_duration(VOD_1080P), None);
        assert_eq!(parse_duration("  Duration: N/A, bitrate: N/A"), None);
    }

    #[test]
    fn sin_stream_de_video_no_inventa_nada() {
        assert_eq!(parse_dimensions(""), None);
        assert_eq!(
            parse_dimensions("  Stream #0:0: Audio: aac (LC), 48000 Hz, stereo, fltp, 160 kb/s"),
            None
        );
    }
}
