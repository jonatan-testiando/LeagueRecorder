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

/**
 * El último rango que se enseñó, para el arranque. Hasta que contestan Riot y
 * la biblioteca no hay rango que dar, y el rail decía «Sin clasificar» a quien
 * es Maestro. Mientras tanto se sirve el de la última vez; en cuanto hay
 * respuesta, manda la respuesta (también si es que no tienes rango).
 */
const LAST_KEY = "lr-rank";

function leerUltimo(): RankNow | null {
  try {
    const raw = window.localStorage.getItem(LAST_KEY);
    const v = raw ? (JSON.parse(raw) as RankNow) : null;
    return v && typeof v.tier === "string" ? v : null;
  } catch {
    return null;
  }
}

function guardarUltimo(r: RankNow): void {
  try {
    window.localStorage.setItem(LAST_KEY, JSON.stringify(r));
  } catch {
    // Sin almacenamiento, el próximo arranque espera a la respuesta.
  }
}

/**
 * `null` es «sin rango» (ya contestaron Riot y la biblioteca y no hay); y
 * `undefined`, «aún no se sabe»: la primera vez, sin rango de la última vez
 * que enseñar. Quien pinta pone un hueco, no «Sin clasificar».
 */
export function useCurrentRank(): RankNow | null | undefined {
  const matches = useAppStore((s) => s.matches);
  const loaded = useAppStore((s) => s.matchesLoaded);
  const [live, setLive] = useState<CurrentRank | null>(ultimo?.value ?? null);
  // Si Riot ya contestó (aunque sea con null). Hasta entonces, `live` a null
  // no quiere decir «sin rango».
  const [asked, setAsked] = useState(ultimo != null);

  // Se vuelve a preguntar cuando llega una partida nueva: es cuando cambia.
  useEffect(() => {
    let vivo = true;
    pedir().then((r) => {
      if (!vivo) return;
      setLive(r);
      setAsked(true);
    });
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

  const enVivo = useMemo<RankNow | null>(
    () => (live ? { tier: live.tier.toUpperCase(), division: live.division, lp: live.lp, live: true } : null),
    [live]
  );
  const ultimoVisto = useMemo(leerUltimo, []);

  // La respuesta, cuando la hay: Riot en vivo o, sin él, la última grabada.
  const respuesta = asked ? enVivo ?? guardado : null;
  useEffect(() => {
    if (respuesta) guardarUltimo(respuesta);
  }, [respuesta]);

  if (respuesta) return respuesta;
  // Riot aún no ha contestado: el de la última vez antes que el de una
  // partida grabada que puede tener semanas.
  if (!asked) return ultimoVisto ?? guardado ?? undefined;
  return loaded ? null : ultimoVisto ?? undefined;
}
