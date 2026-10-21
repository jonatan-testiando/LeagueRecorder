//! Preguntas a Win32 que necesitaban varios módulos a la vez.
//!
//! Vive aparte porque tres sitios distintos querían lo mismo y ninguno lo tenía:
//!   - la grabadora, para poner el lienzo a la resolución REAL del cliente de
//!     League en vez de un 1920×1080 fijo;
//!   - la estela del ratón (`ultimate::mouse_coordinate_space`), que escalaba
//!     contra el monitor primario aunque se jugara en el secundario;
//!   - el almacenamiento, que no miraba el disco físico en ningún momento;
//!   - los ajustes del juego (`ajustes_juego`), que necesitan saber en qué
//!     carpeta está instalado el League que se está jugando;
//!   - la conexión al cliente de League (`lcu.rs`), que lee la línea de comandos
//!     de `LeagueClientUx.exe` cuando no encuentra el lockfile;
//!   - la selección de campeón (`champ_select.rs`), que pone la ventana delante
//!     sin quitarle el foco a nadie.
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
    use std::path::{Path, PathBuf};
    use windows_sys::Win32::Foundation::{CloseHandle, HWND, RECT};
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows_sys::Win32::Media::Audio::waveOutGetNumDevs;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        FindWindowW, GetClientRect, GetWindowThreadProcessId,
    };

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

    /// Ruta del ejecutable dueño de una ventana, buscada por título.
    ///
    /// Se pide sólo `PROCESS_QUERY_LIMITED_INFORMATION`, el permiso mínimo (el
    /// que usa el Administrador de tareas para enseñar la ruta): un antitrampas
    /// puede negar más, y aun así el llamante tiene a dónde caer.
    pub fn window_process_path(title: &str) -> Option<PathBuf> {
        let hwnd = find_window(title)?;
        let mut pid: u32 = 0;
        // SAFETY: hwnd válido y `pid` es nuestro.
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        if pid == 0 {
            return None;
        }
        // SAFETY: sin punteros; el handle se cierra antes de salir.
        let proceso = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if proceso.is_null() {
            return None;
        }
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        // SAFETY: `buf` tiene `len` u16 reservados y el handle está abierto.
        let ok = unsafe {
            QueryFullProcessImageNameW(proceso, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len)
        };
        // SAFETY: handle abierto arriba, se cierra una sola vez.
        unsafe { CloseHandle(proceso) };
        if ok == 0 || len == 0 {
            return None;
        }
        Some(PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])))
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

    /// PID del primer proceso cuyo ejecutable se llama `exe` (sin distinguir
    /// mayúsculas), o `None` si no hay ninguno.
    fn find_process(exe: &str) -> Option<u32> {
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };
        // SAFETY: sin punteros; el handle se cierra abajo.
        let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snap == INVALID_HANDLE_VALUE || snap.is_null() {
            return None;
        }
        let mut pe = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut found = None;
        // SAFETY: `snap` es válido y `pe` es nuestro, con `dwSize` puesto.
        let mut ok = unsafe { Process32FirstW(snap, &mut pe) };
        while ok != 0 {
            let len = pe.szExeFile.iter().position(|&c| c == 0).unwrap_or(pe.szExeFile.len());
            if String::from_utf16_lossy(&pe.szExeFile[..len]).eq_ignore_ascii_case(exe) {
                found = Some(pe.th32ProcessID);
                break;
            }
            // SAFETY: igual que arriba.
            ok = unsafe { Process32NextW(snap, &mut pe) };
        }
        // SAFETY: handle abierto por nosotros.
        unsafe { CloseHandle(snap) };
        found
    }

    /// Línea de comandos completa de un proceso en marcha, por nombre de ejecutable.
    ///
    /// Sale de `NtQueryInformationProcess(ProcessCommandLineInformation)`, que
    /// solo pide `PROCESS_QUERY_LIMITED_INFORMATION`: basta con que el proceso sea
    /// del mismo usuario, sin elevar. Es lo que evita lanzar PowerShell o WMI
    /// (un segundo de proceso hijo) para leer dos argumentos.
    ///
    /// OJO: puede traer secretos (el LCU pasa ahí su contraseña). Quien la pida
    /// no la escribe en ningún log.
    pub fn process_command_line(exe: &str) -> Option<String> {
        use windows_sys::Wdk::System::Threading::{
            NtQueryInformationProcess, ProcessCommandLineInformation,
        };
        use windows_sys::Win32::Foundation::{CloseHandle, UNICODE_STRING};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };

        let pid = find_process(exe)?;
        // SAFETY: sin punteros; el handle se cierra abajo.
        let h = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if h.is_null() {
            return None;
        }
        let leer = || -> Option<String> {
            // Primera llamada sin búfer: falla con LENGTH_MISMATCH y dice cuánto hace falta.
            let mut needed: u32 = 0;
            // SAFETY: búfer nulo con longitud 0; `needed` es nuestro.
            unsafe {
                NtQueryInformationProcess(
                    h,
                    ProcessCommandLineInformation,
                    std::ptr::null_mut(),
                    0,
                    &mut needed,
                )
            };
            if needed == 0 || needed > 1 << 20 {
                return None;
            }
            // `u64` para que el UNICODE_STRING del principio quede alineado.
            let mut buf = vec![0u64; (needed as usize).div_ceil(8)];
            // SAFETY: `buf` mide al menos `needed` bytes y vive durante la llamada.
            let status = unsafe {
                NtQueryInformationProcess(
                    h,
                    ProcessCommandLineInformation,
                    buf.as_mut_ptr().cast(),
                    (buf.len() * 8) as u32,
                    &mut needed,
                )
            };
            if status < 0 {
                return None;
            }
            // SAFETY: con éxito, el búfer empieza por un UNICODE_STRING cuyo
            // `Buffer` apunta dentro del propio `buf` (el texto va detrás).
            let us = unsafe { &*(buf.as_ptr() as *const UNICODE_STRING) };
            if us.Buffer.is_null() {
                return None;
            }
            // SAFETY: `Length` son bytes válidos a partir de `Buffer`, dentro de `buf`.
            let chars = unsafe { std::slice::from_raw_parts(us.Buffer, us.Length as usize / 2) };
            Some(String::from_utf16_lossy(chars))
        };
        let r = leer();
        // SAFETY: handle abierto por nosotros.
        unsafe { CloseHandle(h) };
        r
    }

    /// Lo que tapa la ventana de delante para que no cuente como «en uso»: el
    /// escritorio y la barra de tareas ocupan la pantalla entera.
    const SIN_USO: [&str; 3] = ["Progman", "WorkerW", "Shell_TrayWnd"];

    /// Una ventana que cubre más que esto de la que estás usando la tapa.
    const TAPA: f64 = 0.15;

    /// Pone `hwnd` encima de las demás SIN activarla: no le quita el teclado
    /// ni el ratón a nadie. Si está minimizada, la restaura igual.
    ///
    /// No lo hace si taparía la ventana que estás usando (más del 15 % de
    /// ella): en la selección esa es el cliente, y con un solo monitor
    /// subirse encima le taparía el reloj de la elección. Ahí basta con el
    /// parpadeo en la barra de tareas, que pide la interfaz.
    ///
    /// Devuelve "front" (ya lo estaba), "raised", "covers" o "failed".
    ///
    /// El truco de TOPMOST y vuelta a NOTOPMOST es lo que deja a un proceso de
    /// fondo subir en el orden de ventanas: el bloqueo de Windows es para
    /// activar (`SetForegroundWindow`), no para eso.
    pub fn subir_sin_foco(hwnd: HWND) -> &'static str {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetAncestor, GetClassNameW, GetForegroundWindow, GetWindowPlacement, GetWindowRect,
            IsIconic, SetWindowPos, ShowWindow, GA_ROOTOWNER, HWND_NOTOPMOST, HWND_TOPMOST,
            SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_SHOWNOACTIVATE, WINDOWPLACEMENT,
        };
        if hwnd.is_null() {
            return "failed";
        }
        let rect = |h: HWND| -> Option<(i32, i32, i32, i32)> {
            let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
            // SAFETY: h es una ventana (puede haber muerto: entonces devuelve 0).
            (unsafe { GetWindowRect(h, &mut r) } != 0).then_some((r.left, r.top, r.right, r.bottom))
        };
        // SAFETY: sin punteros salvo los de las estructuras locales.
        unsafe {
            let fg = GetForegroundWindow();
            if !fg.is_null() && GetAncestor(fg, GA_ROOTOWNER) == hwnd {
                return "front";
            }
            let minimizada = IsIconic(hwnd) != 0;
            // Minimizada, GetWindowRect da -32000: lo que tapará es donde
            // volverá a estar.
            let mia = if minimizada {
                let mut wp: WINDOWPLACEMENT = std::mem::zeroed();
                wp.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
                if GetWindowPlacement(hwnd, &mut wp) == 0 {
                    return "failed";
                }
                let r = wp.rcNormalPosition;
                Some((r.left, r.top, r.right, r.bottom))
            } else {
                rect(hwnd)
            };
            let Some(mia) = mia else { return "failed" };
            if !fg.is_null() {
                let mut clase = [0u16; 64];
                let n = GetClassNameW(fg, clase.as_mut_ptr(), clase.len() as i32).max(0) as usize;
                let clase = String::from_utf16_lossy(&clase[..n]);
                let en_uso = !SIN_USO.contains(&clase.as_str());
                if en_uso && rect(fg).is_some_and(|r| crate::champ_select::solape(mia, r) > TAPA) {
                    return "covers";
                }
            }
            if minimizada {
                ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            }
            let flags = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE;
            let ok = SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, flags) != 0;
            SetWindowPos(hwnd, HWND_NOTOPMOST, 0, 0, 0, 0, flags);
            if ok {
                "raised"
            } else {
                "failed"
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::MonitorRect;
    use std::path::{Path, PathBuf};

    pub fn window_process_path(_title: &str) -> Option<PathBuf> {
        None
    }
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
    pub fn process_command_line(_exe: &str) -> Option<String> {
        None
    }
}

pub use imp::{
    disk_space, has_playback_device, monitor_of_window, process_command_line, window_client_size,
    window_process_path,
};
#[cfg(target_os = "windows")]
pub use imp::subir_sin_foco;
