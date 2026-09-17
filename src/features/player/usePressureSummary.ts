import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { getPressureSummary, type PressureSummary } from "../../core/tauri-ipc";
import { useAppStore } from "../../store/useAppStore";

/** Refresh cached evidence on return, sync and completed video processing. */
export function usePressureSummary(path: string) {
  const { pathname } = useLocation();
  const matches = useAppStore(s => s.matches);
  const [data, setData] = useState<PressureSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (pathname !== path) return;
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
  }, [pathname, path, matches, attempt]);
  return { data, error, retry: () => setAttempt(n => n + 1) };
}
