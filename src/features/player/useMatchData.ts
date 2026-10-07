import { useEffect, useState } from "react";
import {
  getGoldReport,
  getJungleRoute,
  getMatchTrack,
  getSpellAutopsy,
  type GoldResponse,
  type JungleRouteResponse,
  type MatchTrackResponse,
  type SpellReport,
} from "../../core/tauri-ipc";

/**
 * Datos de una partida que leen varias secciones a la vez.
 *
 * "Tus muertes", la ruta, el oro y el recorrido cruzan las mismas tres fuentes;
 * sin esto cada sección pediría lo suyo y el backend parsearía la misma
 * timeline cuatro veces al abrir la pestaña. Se guarda la PROMESA por partida:
 * dos secciones que montan a la vez comparten la misma petición. Un fallo se
 * olvida, para que volver a abrir la partida lo reintente.
 */
const cache = new Map<string, Promise<unknown>>();

function cached<T>(key: string, fetch: () => Promise<T>): Promise<T> {
  let p = cache.get(key) as Promise<T> | undefined;
  if (!p) {
    p = fetch();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}

/** `undefined` = cargando, `null` = falló. */
function useCached<T>(key: string | null, fetch: () => Promise<T>): T | null | undefined {
  const [v, setV] = useState<T | null | undefined>(undefined);
  useEffect(() => {
    if (!key) return;
    let vivo = true;
    setV(undefined);
    cached(key, fetch)
      .then((r) => vivo && setV(r))
      .catch((e) => {
        console.error(key, e);
        if (vivo) setV(null);
      });
    return () => { vivo = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return v;
}

export const useJungleRoute = (matchId: string | null) =>
  useCached<JungleRouteResponse>(matchId && `route:${matchId}`, () => getJungleRoute(matchId as string));

export const useGoldReport = (matchId: string | null) =>
  useCached<GoldResponse>(matchId && `gold:${matchId}`, () => getGoldReport(matchId as string));

export const useSpellAutopsy = (matchId: string | null) =>
  useCached<SpellReport>(matchId && `autopsy:${matchId}`, () => getSpellAutopsy(matchId as string));

export const useMatchTrack = (matchId: string | null) =>
  useCached<MatchTrackResponse>(matchId && `track:${matchId}`, () => getMatchTrack(matchId as string));
