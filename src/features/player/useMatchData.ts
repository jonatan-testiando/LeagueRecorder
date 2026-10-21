import { useEffect, useState } from "react";
import {
  getGoldReport,
  getJungleRoute,
  getMatchAttribution,
  getMatchCoach,
  getMatchPlays,
  getMatchTrack,
  getSpellAutopsy,
  type CoachMatch,
  type GoldResponse,
  type JungleRouteResponse,
  type MatchPlays,
  type MatchTrackResponse,
  type PlayerCredit,
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

/** Reparto de crédito de los 10: lo usan "Tus muertes" (el precio de cada una)
 *  y "Lo que decidió la partida", que comparten filas. */
export const useAttribution = (matchId: string | null) =>
  useCached<PlayerCredit[]>(matchId && `attribution:${matchId}`, () => getMatchAttribution(matchId as string));

/** La misma petición del reparto, para quien necesita el MOTIVO de un fallo:
 *  Impacto distingue "sin clave de Riot" de "falló la API", y el hook se lo
 *  come. Comparte la promesa con `useAttribution`, así que no se pide dos
 *  veces; como un fallo se olvida, volver a llamarla es reintentar. */
export const fetchAttribution = (matchId: string): Promise<PlayerCredit[]> =>
  cached(`attribution:${matchId}`, () => getMatchAttribution(matchId));

/** Las jugadas con su ΔWP y la curva de probabilidad (`winprob.rs`). */
export const useMatchPlays = (matchId: string | null) =>
  useCached<MatchPlays>(matchId && `plays:${matchId}`, () => getMatchPlays(matchId as string));

/** Lo que el coach cobró en la partida (`coach.rs`). Llega `null` también si
 *  la partida no entra en el coach: no hay que distinguirlo de un fallo. */
export const useMatchCoach = (matchId: string | null) =>
  useCached<CoachMatch | null>(matchId && `coach:${matchId}`, () => getMatchCoach(matchId as string));

export const useMatchTrack = (matchId: string | null) =>
  useCached<MatchTrackResponse>(matchId && `track:${matchId}`, () => getMatchTrack(matchId as string));
