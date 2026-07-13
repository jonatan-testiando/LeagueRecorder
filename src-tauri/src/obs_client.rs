//! Cliente del servidor de grabación `leaguerec-obs` (proceso C++ headless sobre libobs).
//!
//! Lanza el proceso servidor y le habla por un **named pipe** de Windows con un protocolo
//! de mensajes JSON delimitados por '\n' (ver `leaguerec-obs/src/main.cpp`):
//!   -> {"cmd":"start", ...}   <- {"ok":true,"file":"..."}
//!   -> {"cmd":"stop"}         <- {"ok":true,"file":"..."}
//!   -> {"cmd":"status"}       <- {"ok":true,"active":bool}
//!   -> {"cmd":"shutdown"}     <- {"ok":true}
//!
//! Fase 2: cliente aislado y verificable. La Fase 3 lo enchufa dentro de `recorder.rs`.

use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Configuración de una grabación (se serializa al comando `start`).
#[derive(Serialize, Clone, Debug)]
pub struct StartConfig {
    pub source: String, // "game" | "monitor"
    #[serde(skip_serializing_if = "String::is_empty")]
    pub window: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub exe: String,
    pub out: String,
    pub fps: i32,
    pub bitrate: i32,
}

impl Default for StartConfig {
    fn default() -> Self {
        Self {
            source: "game".into(),
            window: String::new(),
            exe: String::new(),
            out: String::new(),
            fps: 60,
            bitrate: 12000,
        }
    }
}

#[derive(Deserialize, Default)]
struct Resp {
    ok: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    file: Option<String>,
    #[serde(default)]
    active: Option<bool>,
}

/// Cliente conectado al servidor de grabación.
pub struct ObsClient {
    child: Option<Child>,
    reader: BufReader<File>,
    writer: File,
}

impl ObsClient {
    /// Lanza el servidor (`exe --pipe <pipe>`) con el entorno correcto y conecta al pipe.
    ///
    /// - `exe`: ruta a leaguerec-obs.exe (debe estar en el `bin/64bit` de OBS, junto a obs.dll,
    ///   porque libobs busca `data/` relativa al ejecutable).
    /// - `deps_bin`: dir con las DLLs de ffmpeg (`.deps/obs-deps-*/bin`), que van en el PATH.
    pub fn spawn_and_connect(
        exe: &Path,
        rundir: &Path,
        deps_bin: &Path,
        pipe: &str,
    ) -> Result<Self, String> {
        let bin_dir = exe.parent().ok_or("el exe no tiene directorio padre")?;
        let base_path = std::env::var("PATH").unwrap_or_default();
        let new_path = format!("{};{};{}", bin_dir.display(), deps_bin.display(), base_path);

        // El stderr del server (logs de libobs) va a un archivo para diagnóstico.
        let log_path: PathBuf = std::env::temp_dir().join("leaguerec-obs-server.log");
        let mut cmd = Command::new(exe);
        cmd.arg("--pipe")
            .arg(pipe)
            .current_dir(bin_dir)
            .env("OBS_RUNDIR", rundir)
            .env("PATH", new_path)
            .stdout(Stdio::null());
        if let Ok(f) = File::create(&log_path) {
            cmd.stderr(Stdio::from(f));
        }
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

        let mut child = cmd.spawn().map_err(|e| format!("no se pudo lanzar el server: {e}"))?;

        match Self::open_pipe(pipe, Duration::from_secs(10)) {
            Ok((reader, writer)) => Ok(Self {
                child: Some(child),
                reader,
                writer,
            }),
            Err(e) => {
                // No dejar el proceso huérfano, y adjuntar el motivo real del fallo.
                let _ = child.kill();
                let status = child.wait().ok();
                let log = std::fs::read_to_string(&log_path).unwrap_or_default();
                let tail: Vec<&str> = log.lines().rev().take(10).collect();
                let tail: String = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
                Err(format!(
                    "{e}\n  server exit: {status:?}\n  server log (cola):\n{tail}"
                ))
            }
        }
    }

    /// Conecta a un servidor ya lanzado (sin gestionar su ciclo de vida).
    pub fn connect(pipe: &str) -> Result<Self, String> {
        let (reader, writer) = Self::open_pipe(pipe, Duration::from_secs(10))?;
        Ok(Self {
            child: None,
            reader,
            writer,
        })
    }

    fn open_pipe(pipe: &str, timeout: Duration) -> Result<(BufReader<File>, File), String> {
        let path = format!(r"\\.\pipe\{}", pipe);
        let start = Instant::now();
        loop {
            match OpenOptions::new().read(true).write(true).open(&path) {
                Ok(f) => {
                    let writer = f.try_clone().map_err(|e| format!("try_clone: {e}"))?;
                    return Ok((BufReader::new(f), writer));
                }
                Err(e) => {
                    if start.elapsed() > timeout {
                        return Err(format!("no se pudo abrir el pipe {path}: {e}"));
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
            }
        }
    }

    fn request(&mut self, json: &str) -> Result<Resp, String> {
        self.writer
            .write_all(json.as_bytes())
            .and_then(|_| self.writer.write_all(b"\n"))
            .and_then(|_| self.writer.flush())
            .map_err(|e| format!("escribir comando: {e}"))?;

        let mut line = String::new();
        let n = self
            .reader
            .read_line(&mut line)
            .map_err(|e| format!("leer respuesta: {e}"))?;
        if n == 0 {
            return Err("el servidor cerró la conexión".into());
        }
        serde_json::from_str(line.trim())
            .map_err(|e| format!("respuesta no-JSON ({e}): {}", line.trim()))
    }

    /// Inicia una grabación. Devuelve la ruta del archivo destino.
    pub fn start(&mut self, cfg: &StartConfig) -> Result<String, String> {
        let mut v = serde_json::to_value(cfg).map_err(|e| e.to_string())?;
        v["cmd"] = serde_json::Value::String("start".into());
        let r = self.request(&v.to_string())?;
        if r.ok {
            Ok(r.file.unwrap_or_default())
        } else {
            Err(r.error.unwrap_or_else(|| "start falló".into()))
        }
    }

    /// Detiene la grabación. Devuelve la ruta del archivo grabado.
    pub fn stop(&mut self) -> Result<String, String> {
        let r = self.request(r#"{"cmd":"stop"}"#)?;
        if r.ok {
            Ok(r.file.unwrap_or_default())
        } else {
            Err(r.error.unwrap_or_else(|| "stop falló".into()))
        }
    }

    /// Arranca el replay buffer (mantiene los últimos `buffer_seconds` en memoria). Puede correr
    /// a la vez que una grabación (comparten encoders). `cfg.out` define el directorio de los clips.
    pub fn start_replay(&mut self, cfg: &StartConfig, buffer_seconds: i32) -> Result<(), String> {
        let mut v = serde_json::to_value(cfg).map_err(|e| e.to_string())?;
        v["cmd"] = serde_json::Value::String("start_replay".into());
        v["buffer_seconds"] = serde_json::Value::from(buffer_seconds);
        let r = self.request(&v.to_string())?;
        if r.ok {
            Ok(())
        } else {
            Err(r.error.unwrap_or_else(|| "start_replay falló".into()))
        }
    }

    /// Guarda los últimos N segundos del replay buffer. Devuelve la ruta del clip.
    pub fn save_replay(&mut self) -> Result<String, String> {
        let r = self.request(r#"{"cmd":"save_replay"}"#)?;
        if r.ok {
            Ok(r.file.unwrap_or_default())
        } else {
            Err(r.error.unwrap_or_else(|| "save_replay falló".into()))
        }
    }

    /// ¿Hay una grabación activa?
    pub fn status(&mut self) -> Result<bool, String> {
        let r = self.request(r#"{"cmd":"status"}"#)?;
        Ok(r.active.unwrap_or(false))
    }

    /// Ordena al servidor apagarse y espera a que el proceso termine.
    pub fn shutdown(&mut self) -> Result<(), String> {
        let _ = self.request(r#"{"cmd":"shutdown"}"#);
        if let Some(mut c) = self.child.take() {
            let _ = c.wait();
        }
        Ok(())
    }
}

impl Drop for ObsClient {
    fn drop(&mut self) {
        // Si el proceso sigue vivo (p.ej. panic antes de shutdown), no lo dejamos huérfano.
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}
