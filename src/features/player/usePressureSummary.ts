import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { getPressureSummary, type PressureSummary } from "../../core/tauri-ipc";
import { useLibraryKey } from "../../store/useAppStore";

/** Refresh cached evidence on return, sync and completed video processing. */
export function usePressureSummary(path: string) {
  const { pathname: raw } = useLocation();
  // En la app real Hoy vive en "/" (ruta por defecto) y solo el arnés usa
  // "/home": comparando a pelo, Hoy nunca pedía el resumen y decía "nada
  // medido" con 26 partidas analizadas.
  const pathname = raw === "/" ? "/home" : raw;
  // Firma y no el array: el refresco periódico trae un array nuevo con lo mismo,
  // y cada petición recorre la biblioteca entera en el backend.
  const biblioteca = useLibraryKey();
  const [data, setData] = useState<PressureSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (pathname !== path || biblioteca === null) return;
    let alive = true;
    let sequence = 0;
    const refresh = async () => {
      const request = ++sequence;
      try {
        const result = await getPressureSummary();
        if (alive && request === sequence) { setData(result); setError(null); }
      } catch (e) {
        if (alive && request === sequence) { setData(null); setError(String(e)); }
      }
    };
    void refresh();
    const stop = listen<[string, number]>("minimap_progress", e => { if (e.payload[1] >= 100) void refresh(); });
    return () => { alive = false; void stop.then(f => f()).catch(() => {}); };
  }, [pathname, path, biblioteca, attempt]);
  return { data, error, retry: () => setAttempt(n => n + 1) };
}
