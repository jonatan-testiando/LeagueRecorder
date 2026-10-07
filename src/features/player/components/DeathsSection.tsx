import React, { useMemo } from "react";
import type { TimelineMarker } from "../../../types";
import { mmss } from "../../../core/time";
import { useT } from "../../../core/LanguageProvider";
import { JUNGLE_AGREEMENT_MIN } from "../../../core/tauri-ipc";
import { activityLabel } from "../jungleRoute";
import { useGoldReport, useJungleRoute, useSpellAutopsy } from "../useMatchData";
import { formatGold } from "./pressureFormat";
import { BLIND_LOOKBACK_S as ANTES_S } from "./ReviewQueue";
import { wstyles } from "./videoPlayerStyles";
import "./DeathsSection.css";

/**
 * Tus muertes, una por una, con todo lo que se sabe de cada una.
 *
 * Antes eran tres secciones que no se podían cruzar: "Atención al mapa antes
 * de morir" (miraste o no), "Lo que te comes" (qué te mató y cómo movías el
 * ratón) y, desde la ruta de jungla, qué estabas haciendo. Aquí cada muerte
 * lleva las cuatro cosas en una fila, más el oro sin gastar si la partida se
 * grabó con la captura de oro.
 */

/** Más que esto sin gastar al morir es oro que no llegó a pelear. */
const SIN_GASTAR = 1000;

function ranura(slot: number, basic: boolean): string {
  if (basic) return "AA";
  return ["Q", "W", "E", "R"][slot] ?? "";
}

interface Props {
  matchId: string;
  /** Marcas de la timeline (tiempo de VÍDEO). Respaldo si no hay autopsia. */
  markers?: TimelineMarker[];
  /** Miradas al mapa, en tiempo de VÍDEO. */
  cameraSnaps: number[];
  videoOffset: number;
  onSeek: (videoSeconds: number) => void;
}

interface Fila {
  tVideo: number;
  quien: string | null;
  golpe: string | null;
  recta: boolean | null;
  miradas: number;
  actividad: string | null;
  oro: number | null;
}

export const DeathsSection: React.FC<Props> = ({ matchId, markers, cameraSnaps, videoOffset, onSeek }) => {
  const t = useT();
  const autopsia = useSpellAutopsy(matchId);
  const ruta = useJungleRoute(matchId);
  const oro = useGoldReport(matchId);

  const filas = useMemo<Fila[]>(() => {
    const r = ruta?.route && ruta.route.agreement >= JUNGLE_AGREEMENT_MIN ? ruta.route : null;
    const g = oro?.status === "ok" ? oro.report : null;
    const base: { tVideo: number; tGame: number; quien: string | null; golpe: string | null; recta: boolean | null }[] =
      autopsia && autopsia.autopsies.length > 0
        ? autopsia.autopsies.map((a) => ({
            tVideo: a.t_video,
            tGame: a.t_game,
            quien: a.top[0]?.champion || a.killer || null,
            golpe: a.top[0]
              ? `${ranura(a.top[0].slot, a.top[0].basic)} · ${a.top[0].damage.toLocaleString()}`.replace(/^ · /, "")
              : null,
            recta: a.hand ? a.hand.straight : null,
          }))
        : (markers ?? [])
            .filter((m) => m.event_type === "death")
            .map((m) => ({ tVideo: m.time, tGame: m.time - videoOffset, quien: null, golpe: null, recta: null }));
    return base.map((b) => ({
      ...b,
      miradas: cameraSnaps.filter((s) => s >= b.tVideo - ANTES_S && s <= b.tVideo).length,
      actividad: r?.deaths.find((d) => Math.abs(d.time - b.tGame) <= 3)?.activity ?? null,
      oro: g?.deaths.find((d) => Math.abs(d.time - b.tGame) <= 3)?.unspent ?? null,
    }));
  }, [autopsia, ruta, oro, markers, cameraSnaps, videoOffset]);

  if (autopsia === undefined) return <div className="ds-loading"><div className="spinner" /></div>;
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
      {partes.length > 0 && <p className="ds-summary">{partes.join(" · ")}</p>}
      <div className="ds-list">
        {filas.map((f, i) => (
          <button key={i} type="button" className="ds-row" onClick={() => onSeek(Math.max(0, f.tVideo - 5))} title={t("Jump to this moment")}>
            <span className="u-time ds-time">{mmss(Math.max(0, f.tVideo - videoOffset))}</span>
            <span className="ds-body">
              <span className="ds-who">
                {f.quien ? t("Killed by {champion}", { champion: f.quien }) : t("Death")}
                {f.golpe && <span className="ds-soft"> · {f.golpe}</span>}
              </span>
              <span className="ds-tags">
                {f.actividad && <span className="ds-tag">{activityLabel(f.actividad, t)}</span>}
                <span className={f.miradas === 0 ? "ds-tag ds-tag--bad" : "ds-tag"}>
                  {f.miradas === 0
                    ? t("no look at the map")
                    : t("{n} looks at the map", { n: f.miradas })}
                </span>
                {f.recta === true && <span className="ds-tag ds-tag--bad">{t("straight line")}</span>}
                {f.oro != null && (
                  <span className={f.oro >= SIN_GASTAR ? "ds-tag ds-tag--bad" : "ds-tag"}>
                    {t("{g} unspent", { g: formatGold(f.oro) })}
                  </span>
                )}
              </span>
            </span>
          </button>
        ))}
      </div>
      <p className="note" style={{ margin: 0 }}>
        {t("Looks: minimap clicks and ally camera keys in the {n} s before dying. Straight line: your course never turned 45° in the last 3 s.", { n: ANTES_S })}
      </p>
    </div>
  );
};
