//! Preguntas a Win32 que necesitaban varios módulos a la vez.
//!
//! Vive aparte porque tres sitios distintos querían lo mismo y ninguno lo tenía:
//!   - la grabadora, para poner el lienzo a la resolución REAL del cliente de
//!     League en vez de un 1920×1080 fijo;
//!   - la estela del ratón (`ultimate::mouse_coordinate_space`), que escalaba
//!     contra el monitor primario aunque se jugara en el secundario;
//!   - el almacenamiento, que no miraba el disco físico en ningún momento.
//!
//! Todo lo de aquí devuelve `Option`: no saber la respuesta es un resultado
//! válido y cada llamante tiene su propio plan B.

/// Rectángulo de un monitor en coordenadas del escritorio virtual.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MonitorRect {
    pub left: i32,
    pub top: i32,
    pub width: u32,
    pub height: u32,
}

#[cfg(target_os = "windows")]
mod imp {
    use super::MonitorRect;
    use std::path::Path;
    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows_sys::Win32::Media::Audio::waveOutGetNumDevs;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{FindWindowW, GetClientRect};

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn find_window(title: &str) -> Option<HWND> {
        let t = wide(title);
        // SAFETY: `t` es una cadena UTF-16 terminada en NUL viva durante la llamada.
        let hwnd = unsafe { FindWindowW(std::ptr::null(), t.as_ptr()) };
        if hwnd.is_null() {
            None
        } else {
            Some(hwnd)
        }
    }

    /// Tamaño del área cliente de una ventana por título (sin bordes ni barra).
    pub fn window_client_size(title: &str) -> Option<(u32, u32)> {
        let hwnd = find_window(title)?;
        let mut rc = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        // SAFETY: `hwnd` lo acaba de devolver FindWindowW y `rc` es nuestro.
        if unsafe { GetClientRect(hwnd, &mut rc) } == 0 {
            return None;
        }
        let w = (rc.right - rc.left).max(0) as u32;
        let h = (rc.bottom - rc.top).max(0) as u32;
        // Minimizada: GetClientRect da 0×0. No es una resolución, es "no lo sé".
        if w == 0 || h == 0 {
            return None;
        }
        Some((w, h))
    }

    /// Rectángulo del monitor que contiene esa ventana.
    pub fn monitor_of_window(title: &str) -> Option<MonitorRect> {
        let hwnd = find_window(title)?;
        // SAFETY: hwnd válido; MONITORINFO se rellena con su cbSize puesto.
        unsafe {
            let hmon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            if hmon.is_null() {
                return None;
            }
            let mut mi: MONITORINFO = std::mem::zeroed();
            mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
            if GetMonitorInfoW(hmon, &mut mi) == 0 {
                return None;
            }
            Some(MonitorRect {
                left: mi.rcMonitor.left,
                top: mi.rcMonitor.top,
                width: (mi.rcMonitor.right - mi.rcMonitor.left).max(0) as u32,
                height: (mi.rcMonitor.bottom - mi.rcMonitor.top).max(0) as u32,
            })
        }
    }

    /// (bytes libres para este usuario, capacidad total) del volumen de `path`.
    ///
    /// Se le pasa el directorio tal cual: `GetDiskFreeSpaceExW` acepta cualquier
    /// ruta del volumen, no hace falta quedarse con la letra de unidad. Si el
    /// directorio aún no existe se sube por los padres hasta uno que sí.
    pub fn disk_space(path: &Path) -> Option<(u64, u64)> {
        let mut dir = path;
        while !dir.exists() {
            dir = dir.parent()?;
        }
        let mut wide_path = wide(&dir.to_string_lossy());
        // GetDiskFreeSpaceExW quiere un directorio; una barra final no molesta y
        // evita el caso de "C:" a secas (que significa "el cwd de la unidad C").
        if wide_path.len() >= 2 && wide_path[wide_path.len() - 2] != b'\\' as u16 {
            wide_path.pop();
            wide_path.push(b'\\' as u16);
            wide_path.push(0);
        }
        let mut free_for_caller: u64 = 0;
        let mut total: u64 = 0;
        let mut total_free: u64 = 0;
        // SAFETY: los tres punteros son a locales vivos durante la llamada.
        let ok = unsafe {
            GetDiskFreeSpaceExW(
                wide_path.as_ptr(),
                &mut free_for_caller,
                &mut total,
                &mut total_free,
            )
        };
        if ok == 0 {
            return None;
        }
        // El primero (y no `total_free`) es el bueno: con cuotas de disco activas
        // es lo que este usuario puede escribir de verdad.
        Some((free_for_caller, total))
    }

    /// ¿Hay algún dispositivo de reproducción en el sistema?
    ///
    /// Es la precondición de `wasapi_output_capture`: sin salida de audio no hay
    /// loopback que capturar. `waveOutGetNumDevs` es la forma más barata de
    /// preguntarlo (una llamada a winmm, sin COM ni enumeración de endpoints).
    pub fn has_playback_device() -> bool {
        // SAFETY: sin argumentos ni punteros.
        unsafe { waveOutGetNumDevs() > 0 }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::MonitorRect;
    use std::path::Path;

    pub fn window_client_size(_title: &str) -> Option<(u32, u32)> {
        None
    }
    pub fn monitor_of_window(_title: &str) -> Option<MonitorRect> {
        None
    }
    pub fn disk_space(_path: &Path) -> Option<(u64, u64)> {
        None
    }
    pub fn has_playback_device() -> bool {
        false
    }
}

pub use imp::{disk_space, has_playback_device, monitor_of_window, window_client_size};
