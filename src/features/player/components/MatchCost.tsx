import React, { useMemo } from "react";
import { Play as PlayIcon } from "lucide-react";
import type { MatchMetadata } from "../../../types";
import type { CoachMatch, DeathTag, MatchPlays, PlayerCredit } from "../../../core/tauri-ipc";
import { formatDecimal } from "../../../core/benchmarkFormat";
import { mmss } from "../../../core/time";
import { useT } from "../../../core/LanguageProvider";
import { categoryHelp } from "../../../core/coach";
import { useDelayedLoading } from "../../../core/useDelayedLoading";
import { useAppStore } from "../../../store/useAppStore";
import { Button } from "../../../components/ui/Button";
import { Chip } from "../../../components/ui/Chip";
import { Skeleton } from "../../../components/ui/Skeleton";
import { useMatchCoach, useMatchPlays } from "../useMatchData";
import type { MapFocus, OpenMap } from "../mapFocus";
import { costText, deathFocus, deathParts, deathTitle, useDeathRows, type DeathRow } from "./DeathsSection";
import { formatSigned } from "./pressureFormat";
import "./ImpactTab.css";

/**
 * «Lo que te costó esta partida», arriba de Impacto (plan 4.4).
 *
 * Las muertes que más probabilidad de victoria te quitaron, con la categoría
 * del coach que explica por qué (`coach.rs`): la del título es la que más
 * dice de esa muerte y las demás van en chips. Es la misma cuenta que el coach
 * hace sobre todas tus partidas, contada en una sola.
 *
 * Todo sale de datos que ya existen, sin inventar nada:
 *  - el precio y las etiquetas de cada muerte, del reparto (`muertes.rs`);
 *  - «antes de objetivo», de la parte del objetivo rival de después
 *    (`wpa_objective`), y los segundos hasta él, de las jugadas;
 *  - «tirada», de la probabilidad de tu equipo justo antes de morir (la
 *    jugada que la mató), con el mismo umbral que el coach.
 *
 * Entre ellas, en el orden de la partida, los objetivos rivales que se
 * hicieron sin ti («ausente del objetivo»): los cobra el coach con tu posición
 * en cada uno (`get_match_coach`), y aquí salen con tu parte, dónde estabas y
 * entre cuántos se repartió. No se cuentan dos veces: un objetivo que ya pagó
 * una muerte tuya de los 60 s anteriores no es una ausencia.
 */

/** Las que se enseñan: más, y la pestaña vuelve a ser un rollo. Las demás
 *  están en Partida → Muertes. */
const MAX_JUGADAS = 3;
/** Objetivos sin ti que se enseñan, los más caros. En tus 26 partidas hay de
 *  0 a 9, pero pasados los dos primeros casi todos se quedan en décimas. */
const MAX_OBJETIVOS = 2;
/** Monstruos del mismo tipo con menos de esto entre uno y el siguiente son
 *  una tanda: las tres larvas de una aparición caen en unos 10 s. */
const TANDA_S = 90;
/** Con tu equipo a esta probabilidad o más, morir es tirarla (`coach::UMBRAL_TIRADA`). */
const UMBRAL_TIRADA = 0.65;
/** Lo que el rival tomó después cuenta si cae en este tramo (`muertes::VENTANA_OBJETIVO`). */
const VENTANA_OBJETIVO_S = 60;
/** Al pulsar una jugada el vídeo empieza antes de la muerte, para ver cómo se
 *  llega a ella: lo mismo que la lista de reproducción (3 + los 5 que retrocede
 *  el reproductor). */
const ANTES_DE_LA_MUERTE_S = 8;
/** En un objetivo, desde antes: la pelea del foso empieza mucho antes del
 *  remate, y lo que hay que ver es dónde estabas tú mientras tanto. */
const ANTES_DEL_OBJETIVO_S = 15;
/** Misma muerte en la jugada de Riot y en la fila: misma hora ±3 s. */
const MISMA_MUERTE_S = 3;
/** Mismo monstruo en el coach y en las jugadas: los dos llevan la hora del
 *  evento de Riot. */
const MISMO_OBJETIVO_S = 1;

type Cat = DeathTag | "antes_de_objetivo" | "tirada";

/** Qué categoría da el título cuando una muerte entra en varias: de la que
 *  más dice del error a la que menos. «Sin mirar el mapa» va al final porque
 *  se da en casi todas tus muertes (92 %) y por sí sola no distingue nada. */
const ORDEN: Cat[] = [
  "jungla",
  "desde_niebla",
  "tirada",
  "fuera_de_zona",
  "bajo_torre_pre14",
  "poco_dano_devuelto",
  "antes_de_objetivo",
  "sin_mirar_mapa",
];

const TITULO: Record<Cat, string> = {
  jungla: "Death to the enemy jungler",
  desde_niebla: "Caught from the fog",
  tirada: "Thrown while ahead",
  fuera_de_zona: "Caught away from your lane",
  bajo_torre_pre14: "Death at a tower",
  poco_dano_devuelto: "Died without trading back",
  antes_de_objetivo: "Death before an enemy objective",
  sin_mirar_mapa: "Death without looking at the map",
};

/** Las de muerte, con el mismo texto que sus etiquetas en Partida → Muertes. */
const CHIP: Record<Cat, string> = {
  jungla: "enemy jungler",
  desde_niebla: "from the fog",
  tirada: "thrown (team ≥ 65%)",
  fuera_de_zona: "away from your lane",
  bajo_torre_pre14: "at a tower before 14:00",
  poco_dano_devuelto: "little damage back",
  antes_de_objetivo: "before an enemy objective",
  sin_mirar_mapa: "no look at the map",
};

/** El objetivo dentro de la frase, con su artículo: en español el género
 *  cambia ("el dragón", "una torre", "las larvas"). */
const OBJETIVO: Record<string, string> = {
  dragon: "the dragon",
  baron: "the Baron",
  herald: "the Rift Herald",
  grubs: "the Void Grubs",
  tower: "a tower",
  inhibitor: "an inhibitor",
  plate: "a plate",
};

/** El monstruo en el título de un objetivo sin ti: "Dragón sin ti". */
const MONSTRUO: Record<string, string> = {
  dragon: "Dragon",
  baron: "Baron Nashor",
  herald: "Rift Herald",
  grubs: "Void Grubs",
};

/** Dónde estabas cuando el rival lo hizo, con los textos del coach. */
const DONDE: Record<string, string> = {
  far: "far from the pit",
  base: "in base",
  dead: "dead",
};

interface Jugada {
  fila: DeathRow;
  /** Lo que costó (0-1), en positivo. */
  coste: number;
  cats: Cat[];
  titulo: string;
  nota: string | null;
}

/** Un objetivo rival que se hizo sin ti o, con las larvas, la tanda entera:
 *  sueltas serían tres tarjetas de 0,01 % que no dicen nada. */
interface Ausencia {
  /** Segundos de partida, del primero. */
  t: number;
  objective: string;
  /** Monstruos de la tanda. */
  n: number;
  /** Tu parte (0-1), en positivo. */
  coste: number;
  /** Dónde estabas ("far", "base", "dead"), sin repetir. */
  donde: string[];
  /** Lo que ganó el rival con la tanda; null si falta alguna de sus jugadas. */
  ganado: number | null;
  /** Entre cuántos de tu equipo se repartió; null si cambia dentro de la tanda. */
  faltaban: number | null;
}

/** Lo que se pinta, sea una muerte o un objetivo. */
interface Tarjeta {
  key: string;
  /** Segundos de partida y de vídeo. */
  t: number;
  tVideo: number;
  /** Segundos antes de `t` desde los que se abre. */
  lead: number;
  coste: number;
  titulo: string;
  chips: { text: string; help: string }[];
  nota: string | null;
  foco: MapFocus;
}

/**
 * Los objetivos sin ti del coach, en tandas y en orden. Lo que ganó el rival
 * sale de la jugada de ese monstruo (`get_match_plays`): tu parte es eso entre
 * los aliados que faltaban (`coach::Analisis::ausencias`), así que el cociente
 * dice entre cuántos se repartió.
 */
function ausenciasDe(coach: CoachMatch | null | undefined, plays: MatchPlays | null | undefined, miEquipo: number | null): Ausencia[] {
  const out: Ausencia[] = [];
  let ultimo = -Infinity;
  const suyos = (coach?.plays ?? []).filter((p) => p.kind === "objective" && p.objective).sort((a, b) => a.time - b.time);
  for (const j of suyos) {
    const jugada = plays?.plays.find(
      (p) => p.kind === j.objective && p.team_id !== miEquipo && Math.abs(p.time - j.time) <= MISMO_OBJETIVO_S
    );
    const faltaban = jugada && j.lost > 0 ? Math.round(jugada.wpa / j.lost) : null;
    const previa = out[out.length - 1];
    if (previa && previa.objective === j.objective && j.time - ultimo <= TANDA_S) {
      previa.n += 1;
      previa.coste += j.lost;
      if (j.state && !previa.donde.includes(j.state)) previa.donde.push(j.state);
      previa.ganado = previa.ganado != null && jugada ? previa.ganado + jugada.wpa : null;
      if (previa.faltaban !== faltaban) previa.faltaban = null;
    } else {
      out.push({
        t: j.time,
        objective: j.objective as string,
        n: 1,
        coste: j.lost,
        donde: j.state ? [j.state] : [],
        ganado: jugada ? jugada.wpa : null,
        faltaban,
      });
    }
    ultimo = j.time;
  }
  return out;
}

/** ¿Se lee como algo más que "−0,0 %"? Lo que no, va a la línea del resto. */
const seVe = (coste: number): boolean => Math.round(coste * 1000) >= 1;

export interface MatchCostProps {
  match: MatchMetadata;
  /** Quien grabó (1-10). */
  selfPid: number;
  /** Su reparto: dice si de verdad no murió. undefined mientras llega; null
   *  si llegó sin él. */
  credit: PlayerCredit | null | undefined;
  /** Saltar en el vídeo (segundos de VÍDEO); sin vídeo, undefined. */
  onSeekVideo?: (videoSeconds: number) => void;
  onOpenMap: OpenMap;
}

export const MatchCost: React.FC<MatchCostProps> = ({ match, selfPid, credit, onSeekVideo, onOpenMap }) => {
  const t = useT();
  const startPlaylist = useAppStore((s) => s.startPlaylist);
  const offset = match.video_offset ?? 0;
  // Sin miradas: las etiquetas del reparto ya dicen «sin mirar el mapa».
  const { filas, cargando } = useDeathRows(match.id, match.timeline_markers, SIN_MIRADAS, offset, selfPid);
  const plays = useMatchPlays(match.id);
  const coach = useMatchCoach(match.id);
  const miEquipo = (match.participants ?? [])[selfPid - 1]?.team_id ?? null;

  // Solo las que traen precio de verdad: un reparto guardado por una versión
  // vieja puede no tenerlo, y entonces la muerte no entra (no se inventa).
  const conPrecio = useMemo(() => filas.filter((f) => typeof f.precio?.wpa === "number"), [filas]);

  const jugadas = useMemo<Jugada[]>(() => {
    const lista = plays?.plays ?? [];
    return conPrecio.map((f) => {
      const p = f.precio!;
      const cats = new Set<Cat>((p.tags ?? []).filter((k): k is Cat => k in TITULO));
      if (p.objective && p.wpa_objective < 0) cats.add("antes_de_objetivo");
      // La jugada que te mató va desde la óptica de quien mató: la de tu
      // equipo es la contraria.
      const muerte = lista.find((j) => j.victim === selfPid && Math.abs(j.time - f.tGame) <= MISMA_MUERTE_S);
      const tuya = muerte ? 1 - muerte.before : null;
      if (tuya != null && tuya >= UMBRAL_TIRADA) cats.add("tirada");
      const orden = ORDEN.filter((c) => cats.has(c));

      // Una línea de evidencia, la más concreta que haya.
      let nota: string | null = null;
      if (cats.has("antes_de_objetivo") && p.objective) {
        const obj = lista
          .filter((j) => j.kind === p.objective && j.team_id !== miEquipo && j.time > f.tGame && j.time <= f.tGame + VENTANA_OBJETIVO_S)
          .sort((a, b) => b.wpa - a.wpa)[0];
        const vars = { objective: t(OBJETIVO[p.objective] ?? p.objective), p: formatSigned(p.wpa_objective * 100) };
        nota = obj
          ? t("And {objective} {s} s later: {p}% more.", { ...vars, s: Math.round(obj.time - f.tGame) })
          : t("And {objective} right after: {p}% more.", vars);
      } else if (cats.has("tirada") && tuya != null) {
        nota = t("Your team had a {p}% win chance.", { p: Math.round(tuya * 100) });
      } else if (orden.length > 0 && f.quien) {
        nota = `${deathTitle(f, t)}.`;
      } else {
        const trozos = deathParts(f, t).map((x) => x.text);
        nota = trozos.length > 0 ? `${trozos.join(", ")}.` : null;
      }

      return {
        fila: f,
        coste: -p.wpa,
        // En los chips, «antes de objetivo» al final: es la que la nota explica.
        cats: orden.slice(1).sort((a, b) => Number(a === "antes_de_objetivo") - Number(b === "antes_de_objetivo")),
        titulo: orden.length > 0 ? t(TITULO[orden[0]]) : deathTitle(f, t),
        nota,
      };
    });
  }, [conPrecio, plays, selfPid, miEquipo, t]);

  // Las que más costaron.
  const elegidas = useMemo(() => [...jugadas].sort((a, b) => b.coste - a.coste).slice(0, MAX_JUGADAS), [jugadas]);

  const ausencias = useMemo(() => ausenciasDe(coach, plays, miEquipo), [coach, plays, miEquipo]);
  const ausVistas = useMemo(
    () => ausencias.filter((a) => seVe(a.coste)).sort((a, b) => b.coste - a.coste).slice(0, MAX_OBJETIVOS),
    [ausencias]
  );

  // Muertes y objetivos juntos, contados en el orden de la partida.
  const tarjetas = useMemo<Tarjeta[]>(() => {
    const muertes = elegidas.map<Tarjeta>((j) => ({
      key: `d${j.fila.tGame}`,
      t: j.fila.tGame,
      tVideo: j.fila.tVideo,
      lead: ANTES_DE_LA_MUERTE_S,
      coste: j.coste,
      titulo: j.titulo,
      chips: j.cats.map((c) => ({ text: t(CHIP[c]), help: categoryHelp(c, t) })),
      nota: j.nota,
      foco: deathFocus(j.fila, t),
    }));
    const objetivos = ausVistas.map<Tarjeta>((a) => {
      const monstruo = t(MONSTRUO[a.objective] ?? a.objective);
      const titulo =
        a.n > 1
          ? t("{n} {objective} without you", { n: a.n, objective: monstruo })
          : t("{objective} without you", { objective: monstruo });
      let nota: string | null = null;
      if (a.ganado != null) {
        const p = formatDecimal(a.ganado * 100);
        if (a.faltaban === 1) nota = t("The enemy gained {p}% and you were the only one of your team missing.", { p });
        else if (a.faltaban != null && a.faltaban > 1)
          nota = t("The enemy gained {p}%, split among the {n} of your team who were missing.", { p, n: a.faltaban });
        else nota = t("The enemy gained {p}%.", { p });
      }
      return {
        key: `o${a.t}`,
        t: a.t,
        tVideo: a.t + offset,
        lead: ANTES_DEL_OBJETIVO_S,
        coste: a.coste,
        titulo,
        chips: a.donde.map((d) => ({ text: t(DONDE[d] ?? d), help: dondeHelp(d, coach?.positions, t) })),
        nota,
        foco: { kind: "objective", t: a.t, lead: ANTES_DEL_OBJETIVO_S, title: titulo, detail: nota ?? undefined, tone: "bad" },
      };
    });
    return [...muertes, ...objetivos].sort((a, b) => a.t - b.t);
  }, [elegidas, ausVistas, offset, coach, t]);

  // Se esperan también las jugadas y el coach: si llegaran después, la
  // «tirada» o un dragón saldrían de golpe delante del usuario.
  const esperando = cargando || plays === undefined || coach === undefined || credit === undefined;
  const esqueleto = useDelayedLoading(esperando);

  if (esperando || esqueleto) {
    // El hueco se reserva desde el primer fotograma (y el esqueleto sale a
    // los 150 ms): si no, Tú contra tu rival se pinta arriba y salta cuando
    // esto llega.
    return (
      <section className="imc imc--loading" aria-busy="true">
        {esqueleto && (
          <>
            <Skeleton width="62%" height={16} />
            {Array.from({ length: MAX_JUGADAS }, (_, i) => (
              <Skeleton key={i} shape="block" height={96} />
            ))}
          </>
        )}
      </section>
    );
  }

  const titulo = t("What this game cost you");
  // Solo se dice que no moriste si Riot lo dice: sin precio de ninguna muerte
  // puede ser que falten datos.
  const sinMorir = credit?.deaths === 0;
  if (tarjetas.length === 0) {
    if (!sinMorir) return null;
    return (
      <section className="imc">
        <div className="imc__head">
          <h3 className="imc__title">{titulo}</h3>
        </div>
        <p className="imc__none">{t("You didn't die this game.")}</p>
      </section>
    );
  }

  const costeMuertes = conPrecio.reduce((s, f) => s + (f.precio?.wpa ?? 0), 0);
  const costeObjetivos = ausencias.reduce((s, a) => s + a.coste, 0);
  // Sin el precio de tus muertes, un total de solo objetivos diría que la
  // partida costó menos de lo que costó: no se pone.
  const conTotal = conPrecio.length > 0 || sinMorir;
  const resto = conPrecio.length - elegidas.length;
  const restoCoste = costeMuertes + elegidas.reduce((s, j) => s + j.coste, 0);
  const restoObj = ausencias.length - ausVistas.length;
  const restoObjCoste = costeObjetivos - ausVistas.reduce((s, a) => s + a.coste, 0);
  const restoObjTexto = seVe(restoObjCoste) ? costText(-restoObjCoste, t) : t("under 0.1% win chance");
  const conVideo = !!onSeekVideo;

  const abrir = (c: Tarjeta) => {
    if (onSeekVideo) onSeekVideo(Math.max(0, c.tVideo - c.lead));
    else onOpenMap(c.foco);
  };

  // La lista de reproducción ya retrocede ANTES_DE_LA_MUERTE_S (3 s ella y 5
  // el reproductor): a un objetivo se le adelanta lo que le falta.
  const verSeguidas = () =>
    startPlaylist(
      titulo,
      tarjetas.map((c) => ({
        matchId: match.id,
        time: Math.max(0, c.tVideo - (c.lead - ANTES_DE_LA_MUERTE_S)),
        label: `${c.titulo} · ${formatSigned(-c.coste * 100)}%`,
      }))
    );

  return (
    <section className="imc">
      <div className="imc__head">
        <h3 className="imc__title">{titulo}</h3>
        {conTotal && (
          <span
            className="imc__total"
            title={
              ausencias.length > 0
                ? t("What your deaths and the enemy objectives taken without you cost your team in win probability.")
                : t("What all your deaths cost your team in win probability, with their share of what the enemy took right after.")
            }
          >
            {costText(costeMuertes - costeObjetivos, t)}
          </span>
        )}
      </div>

      {sinMorir && <p className="imc__none">{t("You didn't die this game.")}</p>}

      {tarjetas.map((c) => (
        <button
          key={c.key}
          type="button"
          className="imc__play"
          onClick={() => abrir(c)}
          title={conVideo ? t("Watch it in the video") : t("Open the map at this moment")}
        >
          <span className="imc__line">
            <span className="imc__time u-time">{mmss(Math.max(0, c.t))}</span>
            <span className="imc__name">{c.titulo}</span>
            <Chip tone="loss">{formatSigned(-c.coste * 100)}%</Chip>
          </span>
          {c.chips.length > 0 && (
            <span className="imc__tags">
              {c.chips.map((x) => (
                <Chip key={x.text} tone="outline" title={x.help}>
                  {x.text}
                </Chip>
              ))}
            </span>
          )}
          {c.nota && <span className="imc__note">{c.nota}</span>}
        </button>
      ))}

      {(conVideo && tarjetas.length > 1) || resto > 0 || restoObj > 0 ? (
        <div className="imc__foot">
          {conVideo && tarjetas.length > 1 && (
            <Button size="sm" icon={<PlayIcon size={14} />} onClick={verSeguidas}>
              {t("Watch the {n} in a row", { n: tarjetas.length })}
            </Button>
          )}
          {resto > 0 && (
            <span className="imc__rest">
              {resto === 1
                ? t("One more death: {cost}", { cost: costText(restoCoste, t) })
                : t("{n} more deaths: {cost}", { n: resto, cost: costText(restoCoste, t) })}
            </span>
          )}
          {restoObj > 0 && (
            <span className="imc__rest">
              {restoObj === 1
                ? t("One more objective without you: {cost}", { cost: restoObjTexto })
                : t("{n} more objectives without you: {cost}", { n: restoObj, cost: restoObjTexto })}
            </span>
          )}
        </div>
      ) : null}
    </section>
  );
};

/** Cómo se sabe dónde estabas, para el `title` del chip: los radios son los
 *  de `coach::RADIO_FOSO_VIDEO` y `RADIO_FOSO_MINUTO`. */
function dondeHelp(donde: string, positions: CoachMatch["positions"] | undefined, t: (key: string) => string): string {
  if (donde === "base") return t("Buying, or next to your fountain.");
  if (donde === "dead") return t("Still dead from a death more than a minute before.");
  return positions === "video"
    ? t("More than 2,000 units from the pit, by your icon on the minimap of the video.")
    : t("More than 3,000 units from the pit, by Riot's position once a minute: right about 4 times in 5.");
}

/** Estable entre renders: un array nuevo en cada uno rehacía las filas. */
const SIN_MIRADAS: number[] = [];
