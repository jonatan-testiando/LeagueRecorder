use sysinfo::System;

pub fn is_lol_running() -> bool {
    let mut sys = System::new_all();
    sys.refresh_all();
    
    for process in sys.processes().values() {
        let name = process.name().to_lowercase();
        // Buscar el juego 3D omitiendo .exe para máxima compatibilidad
        if name.contains("league of legends") && !name.contains("leagueclient") {
            return true;
        }
    }
    false
}
