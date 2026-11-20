//! Que WebView2 se entere de cuándo la ventana principal no se ve.
//!
//! wry solo le dice a WebView2 si está visible al crearla: minimizada,
//! escondida en la bandeja o tapada por el juego, la página seguía creyéndose
//! a la vista y todo lo que se anima seguía a la frecuencia del monitor.
//! Medido el 2026-11-20 en una pantalla de 240 Hz: el punto pulsante de
//! «Grabando» costaba un 22 % de un núcleo y un 6 % de la GPU durante toda la
//! partida, y el Mapa del reproductor seguía dibujando 240 veces por segundo
//! con la ventana minimizada. Con `IsVisible = false` la página pasa a
//! `document.hidden`: no pinta ni anima, y sus temporizadores van al ralentí,
//! como una pestaña de fondo. Lo que importa durante la partida (grabar, los
//! atajos, el monitor de partida) vive en Rust y no se entera.
//!
//! No se ve si está minimizada, escondida, o si la ventana activa es de otro
//! programa, está por encima y la tapa entera (el juego sin bordes delante).
//! Tapada a medias, o en otro monitor, se sigue viendo y sigue viva.
//!
//! Se mira en el acto cada vez que cambia la ventana activa de Windows o se
//! minimiza o restaura la nuestra (`SetWinEventHook`), con los eventos de la
//! ventana de Tauri, y cada `CADA_MS` por si algo la tapa sin cambiar la
//! activa. Volver a ella no puede esperar a un sondeo: con la página aún
//! oculta, Windows enseñaba la ventana vacía (un rectángulo blanco) hasta
//! 400 ms. Y el evento de foco de Tauri no basta: al volver, el foco va directo
//! a WebView2 y la ventana principal a veces no se entera (medido).

use std::sync::atomic::{AtomicIsize, AtomicU8, Ordering};
use std::sync::OnceLock;

use tauri::{AppHandle, Manager};

/// El respaldo: algo que la tape sin cambiar la ventana activa.
const CADA_MS: u32 = 400;

static APP: OnceLock<AppHandle> = OnceLock::new();
/// 0 = sin decidir, 1 = se ve, 2 = no se ve. Lo último que se le dijo a WebView2.
static ESTADO: AtomicU8 = AtomicU8::new(0);
/// La ventana principal (HWND como entero: un puntero no viaja entre hilos).
static VENTANA: AtomicIsize = AtomicIsize::new(0);

/// Empieza a vigilar la ventana principal. Se llama una vez, en el `setup`.
pub fn vigilar(app: AppHandle) {
    // Para medir lo que gasta la página «a la vista» con la ventana tapada
    // (otra ventana delante mientras se prueba), igual que antes de esto.
    if std::env::var_os("WARDLINE_SIN_VISIBILIDAD").is_some() {
        return;
    }
    let Some(w) = app.get_webview_window("main") else { return };
    match w.hwnd() {
        Ok(h) => VENTANA.store(h.0 as isize, Ordering::Relaxed),
        Err(e) => {
            eprintln!("Visibilidad: sin HWND de la ventana principal: {e}");
            return;
        }
    }
    if APP.set(app).is_err() {
        return;
    }
    let _ = std::thread::Builder::new().name("visibilidad".into()).spawn(imp::escuchar);
}

/// La ventana acaba de recibir el foco: se ve, sin más preguntas.
pub fn al_enfocar(app: &AppHandle) {
    if VENTANA.load(Ordering::Relaxed) != 0 {
        aplicar(app, true);
    }
}

/// Mira si la ventana se ve y, si cambió, se lo dice a WebView2.
pub fn revisar(app: &AppHandle) {
    let hwnd = VENTANA.load(Ordering::Relaxed);
    if hwnd == 0 {
        return;
    }
    aplicar(app, imp::se_ve(hwnd));
}

fn aplicar(app: &AppHandle, ve: bool) {
    let nuevo = if ve { 1 } else { 2 };
    if ESTADO.swap(nuevo, Ordering::Relaxed) == nuevo {
        return;
    }
    let Some(w) = app.get_webview_window("main") else { return };
    let r = w.with_webview(move |pw| {
        #[cfg(windows)]
        unsafe {
            if let Err(e) = pw.controller().SetIsVisible(ve) {
                eprintln!("Visibilidad: WebView2 no aceptó IsVisible={ve}: {e}");
            }
        }
        #[cfg(not(windows))]
        let _ = (pw, ve);
    });
    if let Err(e) = r {
        // Se reintenta en el siguiente aviso.
        ESTADO.store(0, Ordering::Relaxed);
        eprintln!("Visibilidad: no se pudo despachar el cambio: {e}");
    }
}

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;
    use windows_sys::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetForegroundWindow, GetMessageW, GetWindow, GetWindowRect,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetTimer, TranslateMessage,
        EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_MINIMIZEEND, EVENT_SYSTEM_MINIMIZESTART, GW_HWNDPREV,
        MSG, WINEVENT_OUTOFCONTEXT, WM_TIMER,
    };

    unsafe extern "system" fn al_evento(
        _hook: HWINEVENTHOOK,
        _evento: u32,
        _hwnd: HWND,
        _objeto: i32,
        _hijo: i32,
        _hilo: u32,
        _ms: u32,
    ) {
        if let Some(app) = super::APP.get() {
            super::revisar(app);
        }
    }

    /// El hilo de la visibilidad: los avisos de Windows (cambia la ventana
    /// activa; se minimiza o restaura la nuestra) y un temporizador de
    /// respaldo, con su bucle de mensajes. Los avisos `OUTOFCONTEXT` llegan a
    /// este mismo hilo mientras espera en `GetMessageW`.
    pub fn escuchar() {
        unsafe {
            let propio = GetCurrentProcessId();
            let activa = SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                std::ptr::null_mut(),
                Some(al_evento),
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            );
            let minimizar = SetWinEventHook(
                EVENT_SYSTEM_MINIMIZESTART,
                EVENT_SYSTEM_MINIMIZEEND,
                std::ptr::null_mut(),
                Some(al_evento),
                propio,
                0,
                WINEVENT_OUTOFCONTEXT,
            );
            if activa.is_null() || minimizar.is_null() {
                eprintln!("Visibilidad: sin avisos de Windows; queda el sondeo.");
            }
            SetTimer(std::ptr::null_mut(), 0, super::CADA_MS, None);
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                if msg.message == WM_TIMER && msg.hwnd.is_null() {
                    if let Some(app) = super::APP.get() {
                        super::revisar(app);
                    }
                    continue;
                }
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }

    /// El rectángulo que se ve de una ventana: sin los bordes invisibles de
    /// redimensionar que Windows 10/11 cuenta en `GetWindowRect` (7 px a cada
    /// lado; con ellos, una ventana maximizada nunca cabría dentro del juego).
    unsafe fn marco(h: HWND) -> Option<RECT> {
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        let ok = DwmGetWindowAttribute(
            h,
            DWMWA_EXTENDED_FRAME_BOUNDS as u32,
            &mut r as *mut RECT as *mut _,
            std::mem::size_of::<RECT>() as u32,
        ) == 0;
        if ok || GetWindowRect(h, &mut r) != 0 {
            Some(r)
        } else {
            None
        }
    }

    /// `otra` está por encima de `mia` en el orden de las ventanas. La activa
    /// no siempre lo está: con un clic en el escritorio, la activa es el
    /// escritorio, que ocupa toda la pantalla y está debajo de todo.
    unsafe fn encima(mia: HWND, otra: HWND) -> bool {
        let mut h = GetWindow(mia, GW_HWNDPREV);
        for _ in 0..2000 {
            if h.is_null() {
                return false;
            }
            if h == otra {
                return true;
            }
            h = GetWindow(h, GW_HWNDPREV);
        }
        false
    }

    pub fn se_ve(hwnd: isize) -> bool {
        let mia = hwnd as HWND;
        unsafe {
            if IsWindowVisible(mia) == 0 || IsIconic(mia) != 0 {
                return false;
            }
            let fg = GetForegroundWindow();
            if fg.is_null() || fg == mia {
                return true;
            }
            // Otra ventana de la app (el overlay, un diálogo) no la esconde.
            let mut pid = 0u32;
            GetWindowThreadProcessId(fg, &mut pid);
            if pid == GetCurrentProcessId() {
                return true;
            }
            let (Some(m), Some(o)) = (marco(mia), marco(fg)) else { return true };
            let tapa = o.left <= m.left && o.top <= m.top && o.right >= m.right && o.bottom >= m.bottom;
            !(tapa && encima(mia, fg))
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn se_ve(_hwnd: isize) -> bool {
        true
    }
    pub fn escuchar() {}
}
