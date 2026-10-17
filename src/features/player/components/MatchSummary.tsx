import React, { useMemo } from "react";
import { ArrowDown, Map as MapIcon } from "lucide-react";
import type { MatchMetadata } from "../../../types";
import { mmss } from "../../../core/time";
import { useT } from "../../../core/LanguageProvider";
import { useGoldReport } from "../useMatchData";
import type { MapFocus, OpenMap } from "../mapFocus";
import { formatGold } from "./pressureFormat";
import { deathFocus, SIN_GASTAR, useDeathRows, type DeathRow } from "./DeathsSection";
import { CLEAR_COMO_SIEMPRE_S, firstClearFocus } from "./JungleRouteWidget";
import { VUELTA_CORTA } from "./GoldPurchases";
import { invadeTally, moveFocus, useFirstClearMedian, useMoves, type GankMove, type InvadeMove } from "./matchMoves";
import { LANE_LABEL } from "./WavesSection";
import { campLabel } from "../jungleRoute";
import { HelpDot } from "./HelpDot";
import "./MatchTab.css";

/**
 * "Lo que decidió la partida": como mucho tres frases, arriba del todo.
 *
 * La pestaña tenía diez secciones al mismo peso y el usuario no sabía por
 * dónde empezar. Esto elige, entre lo que ya se mide en las secciones de
 * abajo, lo que más se apartó de lo normal en ESTA partida, y lo dice con la
 * cifra dentro. Cada frase lleva al sitio: abre el Mapa si habla de un
 * momento, o al bloque si habla de varios.
 *
 * # El peso
 *
 * Nadie sabe cuánto te costó de verdad cada cosa (una muerte a ciegas puede
 * no costar nada y otra perder la partida), así que el peso NO es eso. Es una
 * escala a ojo de 0 a 1, una por tipo de dato, donde 1 es "de lo más grande
 * que se ve en una partida normal" de esa cifra respecto a su referencia (tu
 * rival al 15, tu mediana, cero). Sirve para ordenar, no para comparar en
 * serio; por eso cada constante dice qué la ancla.
 *
 * Reglas de elección: una frase por tema (muertes, invasiones…), las que pesen
 * menos de `PESO_MIN` no se dicen, y si hay una buena y una mala entran las
 * dos: tres reproches seguidos no se leen, se sufren. Sin datos, menos frases.
 * La frase dice lo medido, nunca el porqué.
 */

export type BlockId = "match-lead" | "match-deaths" | "match-jungle" | "match-gold";

type T = ReturnType<typeof useT>;
type Tone = "good" | "bad" | "neutral";

interface Frase {
  /** Tema: una frase por tema. */
  area: string;
  tone: Tone;
  /** 0..1, ver la cabecera. */
  weight: number;
  text: string;
  go: { map: MapFocus } | { block: BlockId };
}

/** Por debajo no se dice: es ruido de una partida normal. */
const PESO_MIN = 0.15;
const MAX_FRASES = 3;
const MAX_MALAS = 2;

/** ±300 al 15 es una línea igualada: no decidió nada. */
const ORO15_IGUALADO = 300;
/** +1.500 al 15 ya es una línea ganada del todo (≈ cinco kills de ventaja). */
const ORO15_TOPE = 1500;

/** El vuelco de oro del equipo se mira en ventanas de 3 min (las peleas y
 *  los objetivos que lo mueven caben en eso). */
const VUELCO_VENTANA_MIN = 3;
/** Menos de 1.500 en 3 min se mueve en cualquier partida. */
const VUELCO_MIN = 1500;
/** 4.000 en 3 min es una pelea perdida con objetivo detrás: de lo más grande. */
const VUELCO_TOPE = 4000;

/** Una muerte sin mirar el mapa ≈ 300 de recompensa y 20-40 s fuera: cuatro
 *  pesan como una línea perdida por ~1.300. */
const POR_MUERTE_CIEGA = 0.22;
/** En línea recta pesa menos: es un indicio de no esquivar, no una certeza. */
const POR_MUERTE_RECTA = 0.15;
/** Oro sin gastar sumado entre muertes: 2.500 son dos objetos que no pelearon. */
const SIN_GASTAR_TOPE = 2500;
/** Partida entera sin morir (si duró al menos 15 min). */
const SIN_MUERTES = 0.5;

/** Morir invadiendo regala tu tiempo y el campamento: como una muerte y algo. */
const POR_INVASION_MUERTA = 0.35;
/** Invadir sin los dos carriles empujados: la regla de oleadas.rs incumplida.
 *  Pesa poco por invasión porque casi nunca se castiga. */
const POR_INVASION_SIN = 0.12;
const POR_INVASION_CON = 0.1;

/** Un gank que sale es una kill o un flash y una oleada: más que una muerte
 *  a ciegas. Uno que acaba en tu muerte, igual de caro al revés. */
const POR_GANK_BUENO = 0.3;
const POR_GANK_MUERTO = 0.35;
/** Ganks sin resultado (ni kill ni muerte): tiempo invertido, poco más. */
const POR_GANK_SECO = 0.08;

/** 45 s de diferencia con tu mediana en el primer clear es de lo más grande. */
const CLEAR_TOPE_S = 45;
/** Como tu mediana: se dice si sobra sitio, como referencia. */
const CLEAR_IGUAL = 0.15;

/** Cada vuelta a base sin oro para un componente. */
const POR_VUELTA_CORTA = 0.12;

const laneName = (l: string, t: T) => t(LANE_LABEL[l] ?? l);

function frases(input: {
  match: MatchMetadata;
  isJungler: boolean;
  enemyTeam: number;
  filas: DeathRow[];
  hayMuertes: boolean;
  invades: InvadeMove[];
  ganks: GankMove[];
  route: ReturnType<typeof useMoves>["route"];
  doubtful: boolean;
  mediana: number | null;
  recalls: { gold: number }[] | null;
}, t: T): Frase[] {
  const { match, isJungler, enemyTeam, filas, invades, ganks, route, doubtful, mediana, recalls } = input;
  const out: Frase[] = [];

  // ---- tu línea al 15: la misma cifra que "Al minuto 15" del bloque Ventaja.
  const g15 = match.gold_diff_15;
  if (g15 != null && Math.abs(g15) >= ORO15_IGUALADO) {
    const g = formatGold(Math.abs(g15));
    out.push({
      area: "lane",
      tone: g15 > 0 ? "good" : "bad",
      weight: Math.min(1, Math.abs(g15) / ORO15_TOPE),
      text: isJungler
        ? g15 > 0
          ? t("At minute 15 you were {g} gold ahead of the enemy jungler", { g })
          : t("At minute 15 you were {g} gold behind the enemy jungler", { g })
        : g15 > 0
          ? t("You came out of lane {g} gold ahead", { g })
          : t("You came out of lane {g} gold behind", { g }),
      go: { block: "match-lead" },
    });
  }

  // ---- el mayor vuelco de oro del equipo, de la curva de Riot.
  const fr = match.minute_frames ?? [];
  let vuelco: { i: number; d: number } | null = null;
  for (let i = 0; i + VUELCO_VENTANA_MIN < fr.length; i++) {
    const d = fr[i + VUELCO_VENTANA_MIN].team_gold_diff - fr[i].team_gold_diff;
    if (!vuelco || Math.abs(d) > Math.abs(vuelco.d)) vuelco = { i, d };
  }
  if (vuelco && Math.abs(vuelco.d) >= VUELCO_MIN) {
    const a = fr[vuelco.i].minute * 60;
    const b = fr[vuelco.i + VUELCO_VENTANA_MIN].minute * 60;
    const vars = { a: mmss(a), b: mmss(b), g: formatGold(Math.abs(vuelco.d)) };
    const text = vuelco.d < 0
      ? t("Between {a} and {b} your team lost {g} gold against theirs", vars)
      : t("Between {a} and {b} your team gained {g} gold on theirs", vars);
    const tone: Tone = vuelco.d < 0 ? "bad" : "good";
    out.push({
      area: "team",
      tone,
      weight: Math.min(1, Math.abs(vuelco.d) / VUELCO_TOPE),
      text,
      go: { map: { kind: "moment", t: a, until: b, title: t("Gold swing"), detail: text, tone } },
    });
  }

  // ---- muertes: las mismas filas que el bloque Muertes.
  if (input.hayMuertes) {
    const total = filas.length;
    if (total === 0 && match.game_duration >= 15 * 60) {
      out.push({ area: "deaths", tone: "good", weight: SIN_MUERTES, text: t("You didn't die in the whole game"), go: { block: "match-deaths" } });
    }
    const ciegas = filas.filter((f) => f.miradas === 0);
    if (ciegas.length > 0) {
      out.push({
        area: "deaths",
        tone: "bad",
        weight: Math.min(1, ciegas.length * POR_MUERTE_CIEGA),
        text: total === 1
          ? t("You died once, without a look at the map")
          : ciegas.length === total
            ? t("None of your {m} deaths had a look at the map before", { m: total })
            : t("{n} of your {m} deaths without a look at the map", { n: ciegas.length, m: total }),
        go: ciegas.length === 1 ? { map: deathFocus(ciegas[0], t) } : { block: "match-deaths" },
      });
    }
    const caras = filas.filter((f) => (f.oro ?? 0) >= SIN_GASTAR);
    if (caras.length > 0) {
      const suma = caras.reduce((a, f) => a + (f.oro ?? 0), 0);
      out.push({
        area: "deaths",
        tone: "bad",
        weight: Math.min(1, suma / SIN_GASTAR_TOPE),
        text: caras.length === 1
          ? t("You died at {time} with {g} gold unspent", { time: mmss(caras[0].tGame), g: formatGold(caras[0].oro ?? 0) })
          : t("You died {n} times with {g}+ gold unspent", { n: caras.length, g: formatGold(SIN_GASTAR) }),
        go: caras.length === 1 ? { map: deathFocus(caras[0], t) } : { block: "match-deaths" },
      });
    }
    const rectas = filas.filter((f) => f.recta === true);
    if (rectas.length >= 2) {
      out.push({
        area: "deaths",
        tone: "bad",
        weight: Math.min(1, rectas.length * POR_MUERTE_RECTA),
        text: t("{n} of your {m} deaths moving in a straight line", { n: rectas.length, m: total }),
        go: { block: "match-deaths" },
      });
    }
  }

  // ---- invasiones (la lista del bloque Jungla). Con la ruta dudosa no se
  // dice nada: no se decide una partida sobre un boceto.
  if (!doubtful && invades.length > 0) {
    const n = invades.length;
    const juzgadas = invades.filter((i) => i.lanes && i.verdict !== "early" && i.verdict !== "unknown");
    const ambos = juzgadas.filter((i) => i.verdict === "prio").length;
    const sin = juzgadas.filter((i) => i.verdict === "half" || i.verdict === "none").length;
    const muertas = invades.filter((i) => i.died);
    if (muertas.length > 0) {
      out.push({
        area: "invades",
        tone: "bad",
        weight: Math.min(1, muertas.length * POR_INVASION_MUERTA),
        text: muertas.length === 1
          ? t("You died invading at {time} ({camp})", { time: mmss(muertas[0].t), camp: campLabel(muertas[0].camp, t) })
          : t("You died in {d} of your {n} invades", { d: muertas.length, n }),
        go: muertas.length === 1 ? { map: moveFocus(muertas[0], t, enemyTeam) } : { block: "match-jungle" },
      });
    }
    // La misma frase que el bloque Jungla, con todos los grupos nombrados:
    // la cifra es la de la ruta y no se le quita ninguna.
    if (sin >= 2 && sin >= ambos) {
      out.push({
        area: "invades",
        tone: "bad",
        weight: Math.min(1, sin * POR_INVASION_SIN),
        text: invadeTally(invades, t),
        go: { block: "match-jungle" },
      });
    }
    if (ambos >= 2 && ambos > sin) {
      out.push({
        area: "invades",
        tone: "good",
        weight: Math.min(1, ambos * POR_INVASION_CON),
        text: invadeTally(invades, t),
        go: { block: "match-jungle" },
      });
    }
  }

  // ---- ganks
  if (ganks.length > 0) {
    const n = ganks.length;
    const ok = ganks.filter((g) => g.outcome === "success");
    const muertos = ganks.filter((g) => g.outcome === "failed");
    if (ok.length > 0) {
      out.push({
        area: "ganks",
        tone: "good",
        weight: Math.min(1, ok.length * POR_GANK_BUENO),
        text: n === 1
          ? t("Your gank in {lane} at {time} worked", { lane: laneName(ok[0].lane, t), time: mmss(ok[0].t) })
          : ok.length === n
            ? t("All {n} of your ganks worked", { n })
            : t("{m} of your {n} ganks worked", { m: ok.length, n }),
        go: ok.length === 1 ? { map: moveFocus(ok[0], t, enemyTeam) } : { block: "match-jungle" },
      });
    }
    if (muertos.length > 0) {
      out.push({
        area: "ganks",
        tone: "bad",
        weight: Math.min(1, muertos.length * POR_GANK_MUERTO),
        text: muertos.length === 1
          ? t("You died ganking {lane} at {time}", { lane: laneName(muertos[0].lane, t), time: mmss(muertos[0].t) })
          : t("You died in {m} of your {n} ganks", { m: muertos.length, n }),
        go: muertos.length === 1 ? { map: moveFocus(muertos[0], t, enemyTeam) } : { block: "match-jungle" },
      });
    }
    if (ok.length === 0 && muertos.length === 0 && n >= 2) {
      out.push({
        area: "ganks",
        tone: "neutral",
        weight: Math.min(1, n * POR_GANK_SECO),
        text: t("None of your {n} ganks ended in a kill", { n }),
        go: { block: "match-jungle" },
      });
    }
  }

  // ---- primer clear contra tu mediana
  if (isJungler && route && !doubtful && route.first_clear_end != null && mediana != null) {
    const fc = route.first_clear_end;
    const delta = fc - mediana;
    const vars = { t: mmss(fc), s: Math.round(Math.abs(delta)), m: mmss(mediana) };
    const text = Math.abs(delta) <= CLEAR_COMO_SIEMPRE_S
      ? t("Your first clear ended at {t}, like your median", vars)
      : delta < 0
        ? t("Your first clear ended at {t}, {s} s faster than your median", vars)
        : t("Your first clear ended at {t}, {s} s slower than your median ({m})", vars);
    const foco = firstClearFocus(route, text, t);
    if (foco) {
      out.push({
        area: "clear",
        tone: Math.abs(delta) <= CLEAR_COMO_SIEMPRE_S ? "neutral" : delta < 0 ? "good" : "bad",
        weight: Math.abs(delta) <= CLEAR_COMO_SIEMPRE_S ? CLEAR_IGUAL : Math.min(1, Math.abs(delta) / CLEAR_TOPE_S),
        text,
        go: { map: foco },
      });
    }
  }

  // ---- vueltas a base sin oro para nada
  if (recalls && recalls.length > 0) {
    const cortas = recalls.filter((r) => r.gold < VUELTA_CORTA).length;
    if (cortas >= 2) {
      out.push({
        area: "gold",
        tone: "bad",
        weight: Math.min(1, cortas * POR_VUELTA_CORTA),
        text: t("{n} of your {m} recalls with less than {g} gold", { n: cortas, m: recalls.length, g: VUELTA_CORTA }),
        go: { block: "match-gold" },
      });
    }
  }

  return out;
}

/** Una por tema, la mala y la buena más pesadas si las hay, y hasta tres. */
function elegir(todas: Frase[]): Frase[] {
  const porTema = new Map<string, Frase>();
  for (const f of todas) {
    if (f.weight < PESO_MIN) continue;
    const ya = porTema.get(f.area);
    if (!ya || f.weight > ya.weight) porTema.set(f.area, f);
  }
  const lista = [...porTema.values()].sort((a, b) => b.weight - a.weight);
  const out: Frase[] = [];
  const mala = lista.find((f) => f.tone === "bad");
  const buena = lista.find((f) => f.tone === "good");
  if (mala) out.push(mala);
  if (buena) out.push(buena);
  for (const f of lista) {
    if (out.length >= MAX_FRASES) break;
    if (out.includes(f)) continue;
    if (f.tone === "bad" && out.filter((x) => x.tone === "bad").length >= MAX_MALAS) continue;
    out.push(f);
  }
  return out.sort((a, b) => b.weight - a.weight);
}

interface Props {
  match: MatchMetadata;
  isJungler: boolean;
  /** Pedir ruta y oleadas (jungla, o con emboscadas detectadas). */
  wantsMoves: boolean;
  enemyTeam: number;
  /** Miradas al mapa, en tiempo de VÍDEO. */
  cameraSnaps: number[];
  onOpenMap: OpenMap;
  onReveal: (block: BlockId) => void;
}

export const MatchSummary: React.FC<Props> = ({ match, isJungler, wantsMoves, enemyTeam, cameraSnaps, onOpenMap, onReveal }) => {
  const t = useT();
  const off = match.video_offset ?? 0;
  const { filas, cargando } = useDeathRows(match.id, match.timeline_markers, cameraSnaps, off);
  const mv = useMoves(match.id, match.timeline_markers, off, wantsMoves);
  const mediana = useFirstClearMedian(isJungler ? match.id : null);
  const oro = useGoldReport(match.id);

  // Se espera a todo lo pedido: si las frases salieran según llegan los datos,
  // se reordenarían delante del usuario.
  const cargandoAlgo = cargando || mv.loading || oro === undefined || (isJungler && mediana === undefined);

  const elegidas = useMemo(() => {
    if (cargandoAlgo) return [];
    return elegir(
      frases(
        {
          match,
          isJungler,
          enemyTeam,
          filas,
          // Sin marcas de la timeline no se sabe si moriste: "no moriste"
          // sería mentira en una partida sin sincronizar.
          hayMuertes: (match.timeline_markers ?? []).length > 0,
          invades: mv.moves.filter((m): m is InvadeMove => m.kind === "invade"),
          ganks: mv.moves.filter((m): m is GankMove => m.kind === "gank"),
          route: mv.route,
          doubtful: mv.doubtful,
          mediana: mediana ?? null,
          recalls: oro?.status === "ok" && oro.report ? oro.report.recalls : null,
        },
        t
      )
    );
  }, [cargandoAlgo, match, isJungler, enemyTeam, filas, mv.moves, mv.route, mv.doubtful, mediana, oro, t]);

  if (!cargandoAlgo && elegidas.length === 0) return null;

  return (
    <section>
      <div className="sect__head">
        <span className="u-label">{t("What decided the game")}</span>
        <HelpDot
          text={t("Up to three things from this game: the ones furthest from normal (an even lane at 15, your usual first clear, zero deaths without looking), one good and one bad when there are both. They say what was measured, not why.")}
        />
        <i className="sect__rule" />
      </div>
      {cargandoAlgo ? (
        <p className="mt-sum__wait" role="status">
          <span className="spinner" />
          {t("Reading the game…")}
        </p>
      ) : (
        <div className="mt-sum">
          {elegidas.map((f) => {
            const alMapa = "map" in f.go;
            return (
              <button
                key={f.area}
                type="button"
                className="mt-sum__item"
                onClick={() => ("map" in f.go ? onOpenMap(f.go.map) : onReveal(f.go.block))}
                title={alMapa ? t("Open the map at this moment") : t("Go to the section")}
              >
                <i className="mt-sum__dot" data-tone={f.tone} aria-hidden="true" />
                <span>{f.text}</span>
                {alMapa
                  ? <MapIcon size={13} className="mt-sum__go" aria-hidden="true" />
                  : <ArrowDown size={13} className="mt-sum__go" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
};
