import { useEffect, useMemo, useState } from "react";
import { getCurrentRank, type CurrentRank } from "./tauri-ipc";
import { useAppStore } from "../store/useAppStore";

/**
 * Tu rango, el mismo en toda la app.
 *
 * Antes cada pantalla lo sacaba de un sitio: el rail y Hoy, de la última
 * partida GRABADA; la escalada de Patrones, de Riot en vivo. Con datos reales
 * salían "Maestro 16 LP" y "Diamante I 75 LP" a la vez (dos semanas de
 * partidas sin grabar entre medias). Ahora manda el de Riot en vivo; si no
 * hay conexión o clave, el de la última partida grabada, CON SU FECHA, para
 * que se sepa que puede estar viejo.
 */
export interface RankNow {
  tier: string;
  division: string | null;
  lp: number | null;
  /** true = league-v4 ahora mismo; false = guardado en una partida. */
  live: boolean;
  /** Fecha de la partida de la que sale, si no es en vivo. */
  date?: string;
}

// Una sola petición compartida por el rail y Hoy. El backend además la guarda
// 5 minutos.
let enVuelo: Promise<CurrentRank | null> | null = null;
let ultimo: { at: number; value: CurrentRank | null } | null = null;

function pedir(): Promise<CurrentRank | null> {
  if (ultimo && Date.now() - ultimo.at < 5 * 60_000) return Promise.resolve(ultimo.value);
  if (!enVuelo) {
    enVuelo = getCurrentRank()
      .then((r) => {
        ultimo = { at: Date.now(), value: r };
        return r;
      })
      .catch(() => null)
      .finally(() => {
        enVuelo = null;
      });
  }
  return enVuelo;
}

export function useCurrentRank(): RankNow | null {
  const matches = useAppStore((s) => s.matches);
  const [live, setLive] = useState<CurrentRank | null>(ultimo?.value ?? null);

  // Se vuelve a preguntar cuando llega una partida nueva: es cuando cambia.
  useEffect(() => {
    let vivo = true;
    pedir().then((r) => vivo && setLive(r));
    return () => {
      vivo = false;
    };
  }, [matches.length]);

  const guardado = useMemo(() => {
    const m = matches
      .filter((x) => !x.is_vod && x.rank_tier)
      .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    return m
      ? { tier: m.rank_tier!.toUpperCase(), division: m.rank_division ?? null, lp: m.rank_lp ?? null, live: false, date: m.date }
      : null;
  }, [matches]);

  if (live) return { tier: live.tier.toUpperCase(), division: live.division, lp: live.lp, live: true };
  return guardado;
}
