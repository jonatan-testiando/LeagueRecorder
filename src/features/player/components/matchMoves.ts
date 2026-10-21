import { useEffect, useMemo, useState } from "react";
import type { TimelineMarker } from "../../../types";
import {
  getJungleRoutes,
  getWaves,
  JUNGLE_AGREEMENT_MIN,
  type JungleRoute,
  type JungleRouteGame,
  type LanePush,
  type WavesReport,
} from "../../../core/tauri-ipc";
import { useJungleRoute } from "../useMatchData";
import { campLabel } from "../jungleRoute";
import type { MapFocus, MapTone } from "../mapFocus";
import { LANE_LABEL } from "./WavesSection";

/**
 * Tus movimientos por el mapa en una partida: invasiones y ganks en UNA lista.
 *
 * Antes había tres sitios que hablaban de lo mismo: la ruta de jungla decía 14
 * invasiones, "Oleadas y macro" "6 de 13" (quitaba del total las que no tenían
 * dato) y los ganks salían dos veces, una en reloj de partida (oleadas) y otra
 * en reloj de vídeo (los marcadores), así que el mismo gank parecía dos: 9:13
 * y 10:11. Aquí cada cosa tiene UNA fuente principal y la otra sólo la completa:
 *
 *  - Invasiones: los campamentos de la ruta en la jungla rival (lo mismo que
 *    cuenta `JungleRoute.invades`). Las oleadas sólo añaden cómo estaban los
 *    dos carriles de al lado; una invasión que sólo vieran ellas no entra.
 *  - Ganks: los marcadores `gank_attempt` (carril, entrada, confianza y
 *    resultado). Las oleadas añaden dónde estaba la oleada de ese carril. Sólo
 *    si no hay marcadores con carril (partida sin resincronizar) mandan ellas.
 *
 * Todos los tiempos en segundos de PARTIDA.
 */

type T = (k: string, v?: Record<string, string | number>) => string;

export type Lane = "top" | "mid" | "bot";
export type InvadeVerdict = WavesReport["invades"][number]["verdict"];
export type GankSetup = WavesReport["ganks"][number]["setup"];
export type GankOutcome = "success" | "neutral" | "failed";

export interface InvadeMove {
  kind: "invade";
  t: number;
  /** Fin del campamento (partida). null si la invasión vino sólo de oleadas. */
  until: number | null;
  camp: string;
  /** Los dos carriles de al lado. null: las oleadas no se leyeron. */
  lanes: LanePush[] | null;
  verdict: InvadeVerdict | null;
  died: boolean;
}

export interface GankMove {
  kind: "gank";
  t: number;
  lane: Lane;
  /** Dónde estaba la oleada de ese carril: 0 = tu base, 1 = la suya. */
  push: number | null;
  setup: GankSetup | null;
  outcome: GankOutcome;
  approach: "flank" | "front" | null;
  confidence: number | null;
  /** Incertidumbre del instante (s). 0 = anclado a un evento. */
  precision: number;
  x: number | null;
  y: number | null;
}

export type Move = InvadeMove | GankMove;

/** Por encima, el choque está en su mitad (= `EMPUJADO` en oleadas.rs). */
const A_FAVOR = 0.5;
/** Oleadas usa el inicio exacto del campamento de la ruta; el margen es sólo
 *  por redondeos. */
const MISMA_INVASION_S = 5;
/** Marcador y oleadas salen del mismo detector (`gank::detect`): el instante
 *  debería coincidir; 10 s cubre marcadores de una sincronización anterior. */
const MISMO_GANK_S = 10;
/** Moriste "en" la invasión: la misma ventana que `oleadas.rs`. */
const MUERTE_ANTES_S = 2;
const MUERTE_DESPUES_S = 15;
/** Por debajo, el detector de ganks no está seguro (= CONFIDENT del widget
 *  de ganks que había antes). */
const CONFIANZA_FIRME = 0.75;

// ------------------------------------------------------------ campamentos

/**
 * Centro de cada campamento en coordenadas de juego, copiado de `CAMPS` en
 * `src-tauri/src/jungle_route.rs` (si cambia allí, hay que cambiarlo aquí).
 * Por equipo dueño: 100 = azul (abajo a la izquierda), 200 = rojo. Sirve para
 * señalar en el Mapa el campamento de una invasión.
 */
const CAMPS: Record<string, Record<number, [number, number]>> = {
  blue: { 100: [3800, 7900], 200: [11000, 6950] },
  gromp: { 100: [2100, 8450], 200: [12700, 6400] },
  wolves: { 100: [3800, 6500], 200: [11000, 8400] },
  raptors: { 100: [6950, 5450], 200: [7850, 9500] },
  red: { 100: [7750, 4050], 200: [7100, 10850] },
  krugs: { 100: [8400, 2700], 200: [6400, 12250] },
};
const SCUTTLES: Record<string, [number, number]> = {
  scuttle_top: [4400, 9650],
  scuttle_bot: [10450, 5150],
};

export function campPosition(camp: string, owner: number): [number, number] | null {
  return SCUTTLES[camp] ?? CAMPS[camp]?.[owner] ?? null;
}

// ------------------------------------------------------------ datos

/**
 * Promesas por partida, como `useMatchData.ts`: el resumen y el bloque de
 * jungla piden las mismas oleadas y la misma mediana, y `getWaves` puede leer
 * el vídeo (segundos). Vive aquí y no en `useMatchData.ts` sólo porque esta
 * pestaña se rehízo sin tocar ese fichero; su sitio natural es aquel.
 */
const cache = new Map<string, Promise<unknown>>();

function useCachedLocal<V>(key: string | null, fetch: () => Promise<V>): V | null | undefined {
  const [v, setV] = useState<V | null | undefined>(undefined);
  useEffect(() => {
    if (!key) {
      setV(undefined);
      return;
    }
    let vivo = true;
    let p = cache.get(key) as Promise<V> | undefined;
    if (!p) {
      p = fetch();
      cache.set(key, p);
      p.catch(() => cache.delete(key));
    }
    setV(undefined);
    p.then((r) => vivo && setV(r)).catch(() => vivo && setV(null));
    return () => { vivo = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return v;
}

/** Oleadas de la partida. `null` como id = no pedirlas. */
export const useWaves = (matchId: string | null) =>
  useCachedLocal<WavesReport>(matchId && `waves:${matchId}`, () => getWaves(matchId as string));

/**
 * Las rutas de jungla de todas tus partidas, una vez por sesión. El backend
 * las recorre todas en cada llamada (unos 4 s medidos en la build de
 * depuración) y las pedían la mediana del primer clear de CADA partida que
 * abrías y Patrones: «Lo que decidió la partida» se quedaba en esqueleto ese
 * rato. Si falla se olvida, para reintentar la próxima vez.
 */
let rutasSesion: Promise<JungleRouteGame[]> | null = null;
export function jungleRoutesOnce(): Promise<JungleRouteGame[]> {
  if (!rutasSesion) {
    rutasSesion = getJungleRoutes().then(
      (r) => r ?? [],
      (e) => {
        rutasSesion = null;
        throw e;
      }
    );
  }
  return rutasSesion;
}

/**
 * Tu primer clear de siempre: la mediana de tus OTRAS partidas con la vuelta
 * completa y la ruta fiable. Con menos de tres no hay referencia (`null`).
 */
export const useFirstClearMedian = (matchId: string | null): number | null | undefined =>
  // Si falla da `null`, igual que "sin referencia": la mediana es un extra y
  // no puede tumbar lo demás.
  useCachedLocal<number | null>(matchId && `fcmedian:${matchId}`, () =>
    jungleRoutesOnce().then((rs) => {
      const fc = rs
        .filter((g) => g.match_id !== matchId && g.route.full_clear && g.route.agreement >= JUNGLE_AGREEMENT_MIN)
        .map((g) => g.route.first_clear_end as number)
        .sort((a, b) => a - b);
      return fc.length >= 3 ? fc[Math.floor(fc.length / 2)] : null;
    })
  );

export function buildMoves(
  route: JungleRoute | null,
  waves: WavesReport | null,
  markers: TimelineMarker[] | undefined,
  videoOffset: number
): Move[] {
  const w = waves?.status === "ok" ? waves : null;
  const out: Move[] = [];

  // ---- invasiones
  const wInv = w?.invades ?? [];
  if (route) {
    const usadas = new Set<number>();
    for (const c of route.clears) {
      if (c.side !== "enemy") continue;
      const k = wInv.findIndex(
        (i, idx) => !usadas.has(idx) && i.camp === c.camp && Math.abs(i.t_game - c.start) <= MISMA_INVASION_S
      );
      const de = k >= 0 ? wInv[k] : null;
      if (k >= 0) usadas.add(k);
      out.push({
        kind: "invade",
        t: c.start,
        until: c.end,
        camp: c.camp,
        lanes: de?.lanes ?? null,
        verdict: de?.verdict ?? null,
        died: de
          ? de.died
          : route.deaths.some((d) => d.time >= c.start - MUERTE_ANTES_S && d.time <= c.end + MUERTE_DESPUES_S),
      });
    }
  } else {
    for (const i of wInv) {
      out.push({ kind: "invade", t: i.t_game, until: null, camp: i.camp, lanes: i.lanes, verdict: i.verdict, died: i.died });
    }
  }

  // ---- ganks
  const wG = w?.ganks ?? [];
  const marcas = (markers ?? []).filter((m) => m.event_type === "gank_attempt" && !!m.lane);
  if (marcas.length > 0) {
    const usados = new Set<number>();
    for (const m of marcas) {
      const t = m.time - videoOffset;
      const k = wG.findIndex(
        (g, idx) => !usados.has(idx) && g.lane === m.lane && Math.abs(g.t_game - t) <= MISMO_GANK_S
      );
      const de = k >= 0 ? wG[k] : null;
      if (k >= 0) usados.add(k);
      out.push({
        kind: "gank",
        t,
        lane: m.lane as Lane,
        push: de?.push ?? null,
        setup: de?.setup ?? null,
        outcome: (m.outcome ?? de?.outcome ?? "neutral") as GankOutcome,
        approach: m.approach ?? null,
        confidence: m.confidence ?? null,
        precision: m.time_precision ?? 0,
        x: m.position_x ?? null,
        y: m.position_y ?? null,
      });
    }
  } else {
    for (const g of wG) {
      out.push({
        kind: "gank", t: g.t_game, lane: g.lane, push: g.push, setup: g.setup, outcome: g.outcome,
        approach: null, confidence: null, precision: 0, x: null, y: null,
      });
    }
  }

  return out.sort((a, b) => a.t - b.t);
}

/**
 * Los movimientos de la partida, con sus fuentes. `enabled` = pedir oleadas y
 * ruta (jungla, o cualquiera con emboscadas detectadas).
 */
export function useMoves(matchId: string, markers: TimelineMarker[] | undefined, videoOffset: number, enabled: boolean) {
  const ruta = useJungleRoute(enabled ? matchId : null);
  const waves = useWaves(enabled ? matchId : null);
  const route = ruta?.status === "ok" ? ruta.route : null;
  const moves = useMemo(
    () => buildMoves(route, waves ?? null, markers, videoOffset),
    [route, waves, markers, videoOffset]
  );
  return {
    moves,
    waves: waves ?? null,
    route,
    /** Ruta con poco acuerdo con la API: sus invasiones son un boceto. */
    doubtful: !!route && route.agreement < JUNGLE_AGREEMENT_MIN,
    loading: enabled && (ruta === undefined || waves === undefined),
    /** Leyendo oleadas (puede tardar segundos) con la ruta ya lista. */
    wavesLoading: enabled && waves === undefined,
  };
}

// ------------------------------------------------------------ frases

export interface MoveText {
  title: string;
  /** Lo que se vio, sin juicio ("Top empujado, Mid no"). */
  facts: string;
  /** El juicio, que se pinta con su tono ("bien", "saliste"). */
  verdict: string;
  tone: MapTone;
  /** Una salvedad en gris ("detección dudosa"). */
  note?: string;
}

const lane = (l: string, t: T) => t(LANE_LABEL[l] ?? l);

/** Primera letra en mayúscula: una fila empieza frase aunque el trozo no. */
export const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

function pushWord(l: LanePush, t: T): string {
  if (l.push == null) return t("{lane} not seen", { lane: lane(l.lane, t) });
  return l.push >= A_FAVOR
    ? t("{lane} pushed", { lane: lane(l.lane, t) })
    : t("{lane} not pushed", { lane: lane(l.lane, t) });
}

export function invadeText(m: InvadeMove, t: T): MoveText {
  const title = t("Invade at {camp}", { camp: campLabel(m.camp, t) });
  let facts = "";
  let verdict = "";
  let tone: MapTone = "neutral";
  if (m.verdict === "early") {
    facts = t("Before the waves met");
  } else if (m.lanes) {
    facts = m.lanes.map((l) => pushWord(l, t)).join(", ");
    // La regla de oleadas.rs: los dos carriles de al lado empujados, o sus
    // laners llegan antes que los tuyos.
    if (m.verdict === "prio") { verdict = t("good"); tone = "good"; }
    else if (m.verdict === "half") verdict = t("half covered");
    else if (m.verdict === "none") { verdict = t("risky"); tone = "bad"; }
  }
  if (m.died) {
    verdict = verdict ? `${verdict} · ${t("you died")}` : t("you died");
    tone = "bad";
  }
  return { title, facts, verdict, tone };
}

export function gankText(m: GankMove, t: T): MoveText {
  const title = t("Gank {lane}", { lane: lane(m.lane, t) });
  const entrada = m.approach === "flank" ? t("cutting their retreat") : m.approach === "front" ? t("straight down the lane") : "";
  // La oleada en tu mitad = su laner lejos de su torre: el gank bueno. Bajo
  // su torre es un diveo (umbrales en oleadas.rs).
  const oleada =
    m.setup === "good" ? t("enemy far from their tower")
      : m.setup === "dive" ? t("under their tower")
      : m.setup === "even" ? t("wave in the middle")
      : m.setup === "unknown" ? t("wave not seen")
      : "";
  const verdict = m.outcome === "success" ? t("it worked") : m.outcome === "failed" ? t("you died") : t("no result");
  const tone: MapTone = m.outcome === "success" ? "good" : m.outcome === "failed" ? "bad" : "neutral";
  return {
    title,
    facts: cap([entrada, oleada].filter(Boolean).join(", ")),
    verdict,
    tone,
    note: m.confidence != null && m.confidence > 0 && m.confidence < CONFIANZA_FIRME ? t("unsure detection") : undefined,
  };
}

export const moveText = (m: Move, t: T): MoveText => (m.kind === "invade" ? invadeText(m, t) : gankText(m, t));

/**
 * "Invadiste 14 veces: 6 con los dos carriles empujados, 6 con uno, 1 sin
 * ninguno y 1 sin datos de oleadas". La cifra es SIEMPRE la de la lista (la
 * ruta), y la proporción nombra todos los grupos. Antes "Oleadas" decía "6 de
 * 13": quitaba del total las que no tenían dato, y parecía que había una
 * invasión menos que en la ruta. La usan el resumen y el bloque Jungla, para
 * que digan lo mismo con las mismas palabras.
 */
export function invadeTally(inv: InvadeMove[], t: T): string {
  const n = inv.length;
  if (inv.every((i) => i.lanes == null)) return n === 1 ? t("You invaded once") : t("You invaded {n} times", { n });
  const cuenta = (f: (i: InvadeMove) => boolean) => inv.filter(f).length;
  const grupos: [number, string][] = [
    [cuenta((i) => i.verdict === "prio"), "{n} with both nearby lanes pushed"],
    [cuenta((i) => i.verdict === "half"), "{n} with one"],
    [cuenta((i) => i.verdict === "none"), "{n} with neither"],
    [cuenta((i) => i.verdict === "early"), "{n} before the waves met"],
    [cuenta((i) => i.lanes == null || i.verdict == null || i.verdict === "unknown"), "{n} without wave data"],
  ];
  const partes = grupos.filter(([k]) => k > 0).map(([k, clave]) => t(clave, { n: k }));
  const lista = partes.length > 1
    ? t("{a} and {b}", { a: partes.slice(0, -1).join(", "), b: partes[partes.length - 1] })
    : partes[0];
  return n === 1 ? t("You invaded once: {parts}", { parts: lista }) : t("You invaded {n} times: {parts}", { n, parts: lista });
}

/** El foco del Mapa para un movimiento (contrato en `mapFocus.ts`). */
export function moveFocus(m: Move, t: T, enemyTeam: number): MapFocus {
  const txt = moveText(m, t);
  const detail = cap([txt.facts, txt.verdict].filter(Boolean).join(": ")) || undefined;
  if (m.kind === "invade") {
    const pos = campPosition(m.camp, enemyTeam);
    return {
      kind: "invade",
      t: m.t,
      until: m.until ?? undefined,
      lead: 5,
      title: txt.title,
      detail,
      tone: txt.tone,
      lanes: m.lanes ?? undefined,
      marks: pos ? [{ x: pos[0], y: pos[1], kind: "camp", label: campLabel(m.camp, t), tone: txt.tone }] : undefined,
    };
  }
  return {
    kind: "gank",
    t: m.t,
    // Interesa la entrada, no el desenlace (el widget de ganks saltaba 5 s
    // antes y oleadas 8; aquí se ve llegar).
    lead: 8,
    title: txt.title,
    detail,
    tone: txt.tone,
    lanes: [{ lane: m.lane, push: m.push }],
    marks: m.x != null && m.y != null ? [{ x: m.x, y: m.y, kind: "gank", tone: txt.tone }] : undefined,
  };
}
