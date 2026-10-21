import React, { useMemo } from "react";
import { Play as PlayIcon } from "lucide-react";
import type { MatchMetadata } from "../../../types";
import type { DeathTag, PlayerCredit } from "../../../core/tauri-ipc";
import { mmss } from "../../../core/time";
import { useT } from "../../../core/LanguageProvider";
import { categoryHelp } from "../../../core/coach";
import { useDelayedLoading } from "../../../core/useDelayedLoading";
import { useAppStore } from "../../../store/useAppStore";
import { Button } from "../../../components/ui/Button";
import { Chip } from "../../../components/ui/Chip";
import { Skeleton } from "../../../components/ui/Skeleton";
import { useMatchPlays } from "../useMatchData";
import type { OpenMap } from "../mapFocus";
import { costText, deathFocus, deathParts, deathTitle, useDeathRows, type DeathRow } from "./DeathsSection";
import { formatSigned } from "./pressureFormat";
import "./ImpactTab.css";

import { withPercent } from "../../../core/benchmarkFormat";
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
 * Lo que el coach cobra y aquí NO sale: los objetivos rivales que se hicieron
 * sin ti («ausente del objetivo»). Necesitan tu posición en cada objetivo y
 * eso lo calcula el backend; no hay comando que lo dé por partida.
 */

/** Las que se enseñan: más, y la pestaña vuelve a ser un rollo. Las demás
 *  están en Partida → Muertes. */
const MAX_JUGADAS = 3;
/** Con tu equipo a esta probabilidad o más, morir es tirarla (`coach::UMBRAL_TIRADA`). */
const UMBRAL_TIRADA = 0.65;
/** Lo que el rival tomó después cuenta si cae en este tramo (`muertes::VENTANA_OBJETIVO`). */
const VENTANA_OBJETIVO_S = 60;
/** Al pulsar una jugada el vídeo empieza antes de la muerte, para ver cómo se
 *  llega a ella: lo mismo que la lista de reproducción (3 + los 5 que retrocede
 *  el reproductor). */
const ANTES_DE_LA_MUERTE_S = 8;
/** Misma muerte en la jugada de Riot y en la fila: misma hora ±3 s. */
const MISMA_MUERTE_S = 3;

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

interface Jugada {
  fila: DeathRow;
  /** Lo que costó (0-1), en positivo. */
  coste: number;
  cats: Cat[];
  titulo: string;
  nota: string | null;
}

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

  // Las que más costaron, contadas en el orden de la partida.
  const elegidas = useMemo(
    () =>
      [...jugadas]
        .sort((a, b) => b.coste - a.coste)
        .slice(0, MAX_JUGADAS)
        .sort((a, b) => a.fila.tGame - b.fila.tGame),
    [jugadas]
  );

  // Se esperan también las jugadas: si llegaran después, la «tirada» saldría
  // de golpe y una tarjeta cambiaría de título delante del usuario.
  const esperando = cargando || plays === undefined || credit === undefined;
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

  const total = conPrecio.reduce((s, f) => s + (f.precio?.wpa ?? 0), 0);

  if (elegidas.length === 0) {
    // Solo se dice que no moriste si Riot lo dice: sin precio de ninguna
    // muerte puede ser que falten datos, y entonces el bloque no sale.
    if (credit?.deaths !== 0) return null;
    return (
      <section className="imc">
        <div className="imc__head">
          <h3 className="imc__title">{t("What this game cost you")}</h3>
        </div>
        <p className="imc__none">{t("You didn't die this game.")}</p>
      </section>
    );
  }

  const resto = conPrecio.length - elegidas.length;
  const restoCoste = total - elegidas.reduce((s, j) => s - j.coste, 0);
  const titulo = t("What this game cost you");
  const conVideo = !!onSeekVideo;

  const abrir = (j: Jugada) => {
    if (onSeekVideo) onSeekVideo(Math.max(0, j.fila.tVideo - ANTES_DE_LA_MUERTE_S));
    else onOpenMap(deathFocus(j.fila, t));
  };

  const verSeguidas = () =>
    startPlaylist(
      titulo,
      elegidas.map((j) => ({
        matchId: match.id,
        time: j.fila.tVideo,
        label: `${j.titulo} · ${withPercent(formatSigned(-j.coste * 100))}`,
      }))
    );

  return (
    <section className="imc">
      <div className="imc__head">
        <h3 className="imc__title">{titulo}</h3>
        <span
          className="imc__total"
          title={t("What all your deaths cost your team in win probability, with their share of what the enemy took right after.")}
        >
          {costText(total, t)}
        </span>
      </div>

      {elegidas.map((j) => (
        <button
          key={j.fila.tGame}
          type="button"
          className="imc__play"
          onClick={() => abrir(j)}
          title={conVideo ? t("Watch it in the video") : t("Open the map at this moment")}
        >
          <span className="imc__line">
            <span className="imc__time u-time">{mmss(Math.max(0, j.fila.tGame))}</span>
            <span className="imc__name">{j.titulo}</span>
            <Chip tone="loss">{withPercent(formatSigned(-j.coste * 100))}</Chip>
          </span>
          {j.cats.length > 0 && (
            <span className="imc__tags">
              {j.cats.map((c) => (
                <Chip key={c} tone="outline" title={categoryHelp(c, t)}>
                  {t(CHIP[c])}
                </Chip>
              ))}
            </span>
          )}
          {j.nota && <span className="imc__note">{j.nota}</span>}
        </button>
      ))}

      {(conVideo && elegidas.length > 1) || resto > 0 ? (
        <div className="imc__foot">
          {conVideo && elegidas.length > 1 && (
            <Button size="sm" icon={<PlayIcon size={14} />} onClick={verSeguidas}>
              {t("Watch the {n} in a row", { n: elegidas.length })}
            </Button>
          )}
          {resto > 0 && (
            <span className="imc__rest">
              {resto === 1
                ? t("One more death: {cost}", { cost: costText(restoCoste, t) })
                : t("{n} more deaths: {cost}", { n: resto, cost: costText(restoCoste, t) })}
            </span>
          )}
        </div>
      ) : null}
    </section>
  );
};

/** Estable entre renders: un array nuevo en cada uno rehacía las filas. */
const SIN_MIRADAS: number[] = [];
