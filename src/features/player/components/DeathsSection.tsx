import React, { useMemo } from "react";
import type { TimelineMarker } from "../../../types";
import { mmss } from "../../../core/time";
import { useT } from "../../../core/LanguageProvider";
import { champLabel } from "../../../core/matchEvents";
import { JUNGLE_AGREEMENT_MIN } from "../../../core/tauri-ipc";
import { activityLabel } from "../jungleRoute";
import { useGoldReport, useJungleRoute, useSpellAutopsy } from "../useMatchData";
import type { MapFocus, OpenMap } from "../mapFocus";
import { formatGold } from "./pressureFormat";
import { BLIND_LOOKBACK_S as ANTES_S } from "./ReviewQueue";
import { HelpDot } from "./HelpDot";
import { wstyles } from "./videoPlayerStyles";
import "./DeathsSection.css";
import "./MatchTab.css";

/**
 * Tus muertes, una por una, con todo lo que se sabe de cada una.
 *
 * Antes eran tres secciones que no se podían cruzar: "Atención al mapa antes
 * de morir" (miraste o no), "Lo que te comes" (qué te mató y cómo movías el
 * ratón) y, desde la ruta de jungla, qué estabas haciendo. Aquí cada muerte
 * es una fila: quién te mató y, en una frase, qué hacías, si miraste el mapa,
 * si ibas en línea recta y el oro sin gastar si la partida lo grabó. La fila
 * abre el Mapa en el sitio donde caíste.
 */

/** Más que esto sin gastar al morir es oro que no llegó a pelear. */
export const SIN_GASTAR = 1000;
/** Marca de la timeline y autopsia de la misma muerte: misma hora ±3 s. */
const MISMA_MUERTE_S = 3;

type T = ReturnType<typeof useT>;

function ranura(slot: number, basic: boolean): string {
  if (basic) return "AA";
  return ["Q", "W", "E", "R"][slot] ?? "";
}

export interface DeathRow {
  tVideo: number;
  tGame: number;
  /** Campeón (nombre de Riot, "MonkeyKing") que más daño te hizo. */
  quien: string | null;
  golpe: { key: string; damage: number } | null;
  recta: boolean | null;
  /** Miradas al mapa antes de morir. null: la partida no tiene miradas
   *  grabadas, y entonces "no miraste" sería mentira (igual que ReviewQueue). */
  miradas: number | null;
  actividad: string | null;
  oro: number | null;
  /** Dónde caíste (coordenadas de juego, de la timeline de Riot). */
  x: number | null;
  y: number | null;
}

/**
 * Las filas, compartidas con "Lo que decidió la partida": las dos cuentan las
 * muertes a ciegas con el mismo criterio, o dirían cifras distintas.
 */
export function useDeathRows(
  matchId: string,
  markers: TimelineMarker[] | undefined,
  cameraSnaps: number[],
  videoOffset: number
): { filas: DeathRow[]; cargando: boolean } {
  const autopsia = useSpellAutopsy(matchId);
  const ruta = useJungleRoute(matchId);
  const oro = useGoldReport(matchId);

  const filas = useMemo<DeathRow[]>(() => {
    const r = ruta?.route && ruta.route.agreement >= JUNGLE_AGREEMENT_MIN ? ruta.route : null;
    const g = oro?.status === "ok" ? oro.report : null;
    const marcas = (markers ?? []).filter((m) => m.event_type === "death");
    const base =
      autopsia && autopsia.autopsies.length > 0
        ? autopsia.autopsies.map((a) => ({
            tVideo: a.t_video,
            tGame: a.t_game,
            quien: a.top[0]?.champion || a.killer || null,
            golpe: a.top[0] ? { key: ranura(a.top[0].slot, a.top[0].basic), damage: a.top[0].damage } : null,
            recta: a.hand ? a.hand.straight : null,
          }))
        : marcas.map((m) => ({ tVideo: m.time, tGame: m.time - videoOffset, quien: null, golpe: null, recta: null }));
    return base.map((b) => {
      const marca = marcas.find((m) => Math.abs(m.time - b.tVideo) <= MISMA_MUERTE_S);
      return {
        ...b,
        miradas:
          cameraSnaps.length > 0 ? cameraSnaps.filter((s) => s >= b.tVideo - ANTES_S && s <= b.tVideo).length : null,
        actividad: r?.deaths.find((d) => Math.abs(d.time - b.tGame) <= MISMA_MUERTE_S)?.activity ?? null,
        oro: g?.deaths.find((d) => Math.abs(d.time - b.tGame) <= MISMA_MUERTE_S)?.unspent ?? null,
        x: marca?.position_x ?? null,
        y: marca?.position_y ?? null,
      };
    });
  }, [autopsia, ruta, oro, markers, cameraSnaps, videoOffset]);

  return { filas, cargando: autopsia === undefined };
}

export const deathTitle = (f: DeathRow, t: T): string =>
  f.quien ? t("Killed by {champion}", { champion: champLabel(f.quien) }) : t("Death");

/** Lo que se sabe de la muerte, en trozos: los malos se pintan en rojo. */
export function deathParts(f: DeathRow, t: T): { text: string; bad: boolean }[] {
  const out: { text: string; bad: boolean }[] = [];
  if (f.actividad) out.push({ text: activityLabel(f.actividad, t), bad: false });
  if (f.miradas != null) {
    out.push(
      f.miradas === 0
        ? { text: t("no look at the map"), bad: true }
        : { text: f.miradas === 1 ? t("one look at the map") : t("{n} looks at the map", { n: f.miradas }), bad: false }
    );
  }
  if (f.recta === true) out.push({ text: t("moving in a straight line"), bad: true });
  if (f.oro != null && f.oro >= SIN_GASTAR) out.push({ text: t("{g} gold unspent", { g: formatGold(f.oro) }), bad: true });
  if (out.length > 0) out[0] = { ...out[0], text: out[0].text.charAt(0).toUpperCase() + out[0].text.slice(1) };
  return out;
}

export function deathFocus(f: DeathRow, t: T): MapFocus {
  return {
    kind: "death",
    t: f.tGame,
    // Se ve llegar la muerte: el mismo tramo en el que se miran las miradas.
    lead: ANTES_S,
    title: deathTitle(f, t),
    detail: deathParts(f, t).map((p) => p.text).join(", ") || undefined,
    tone: "bad",
    marks: f.x != null && f.y != null ? [{ x: f.x, y: f.y, kind: "death", tone: "bad" }] : undefined,
  };
}

const golpeText = (g: NonNullable<DeathRow["golpe"]>, t: T) =>
  g.key === "AA"
    ? t("basic attacks for {n}", { n: g.damage.toLocaleString() })
    : t("{key} for {n}", { key: g.key, n: g.damage.toLocaleString() });

interface Props {
  matchId: string;
  /** Marcas de la timeline (tiempo de VÍDEO): respaldo sin autopsia y posición. */
  markers?: TimelineMarker[];
  /** Miradas al mapa, en tiempo de VÍDEO. */
  cameraSnaps: number[];
  videoOffset: number;
  onOpenMap: OpenMap;
}

export const DeathsSection: React.FC<Props> = ({ matchId, markers, cameraSnaps, videoOffset, onOpenMap }) => {
  const t = useT();
  const { filas, cargando } = useDeathRows(matchId, markers, cameraSnaps, videoOffset);

  if (cargando) return <div className="ds-loading"><div className="spinner" /></div>;
  if (filas.length === 0) return <p className="note" style={{ margin: 0 }}>{t("You didn't die this game.")}</p>;

  const ciegas = filas.filter((f) => f.miradas === 0).length;
  const rectas = filas.filter((f) => f.recta === true).length;
  const caras = filas.filter((f) => (f.oro ?? 0) >= SIN_GASTAR).length;
  const partes = [
    ciegas > 0 && t("{n} without a look at the map", { n: ciegas }),
    rectas > 0 && t("{n} in a straight line", { n: rectas }),
    caras > 0 && t("{n} with {g}+ gold unspent", { n: caras, g: formatGold(SIN_GASTAR) }),
  ].filter(Boolean) as string[];

  return (
    <div style={wstyles.body}>
      <p className="ds-summary">
        {filas.length === 1 ? t("One death") : t("{n} deaths", { n: filas.length })}
        {partes.length > 0 && `: ${partes.join(" · ")}`}
        <HelpDot
          text={t("Looks: minimap clicks and ally camera keys in the {n} s before dying. Straight line: your course never turned 45° in the last 3 s.", { n: ANTES_S })}
        />
      </p>
      <div className="ds-list">
        {filas.map((f, i) => {
          const trozos = deathParts(f, t);
          return (
            <button key={i} type="button" className="ds-row" onClick={() => onOpenMap(deathFocus(f, t))} title={t("Open the map at this moment")}>
              <span className="u-time ds-time">{mmss(Math.max(0, f.tGame))}</span>
              <span className="ds-body">
                <span className="ds-who">
                  {deathTitle(f, t)}
                  {f.golpe && <span className="ds-soft"> · {golpeText(f.golpe, t)}</span>}
                </span>
                {trozos.length > 0 && (
                  <span className="mt-line">
                    {trozos.map((p, k) => (
                      <React.Fragment key={k}>
                        {k > 0 && ", "}
                        <span className={p.bad ? "mt-bad" : undefined}>{p.text}</span>
                      </React.Fragment>
                    ))}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
