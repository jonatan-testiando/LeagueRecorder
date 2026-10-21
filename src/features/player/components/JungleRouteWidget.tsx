import React from "react";
import { AlertTriangle } from "lucide-react";
import { JUNGLE_AGREEMENT_MIN, type JungleRoute } from "../../../core/tauri-ipc";
import { useJungleRoute } from "../useMatchData";
import { mmss } from "../../../core/time";
import { useT } from "../../../core/LanguageProvider";
import { EmptyState } from "../../../components/ui/EmptyState";
import { BUDGET_PARTS } from "../jungleRoute";
import type { MapFocus, OpenMap } from "../mapFocus";
import { useFirstClearMedian } from "./matchMoves";
import { wstyles } from "./videoPlayerStyles";
import { useDelayedLoading } from "../../../core/useDelayedLoading";
import { SkeletonLines } from "../../../components/ui/Skeleton";
import "./JungleRouteWidget.css";
import "./MatchTab.css";

/**
 * Tu ruta de jungla: tu primera vuelta, lo que tardas en volver a tus
 * campamentos, tus bases y en qué se te fue el tiempo.
 *
 * Sale del rastro del minimapa (2 veces por segundo) cruzado con los súbditos
 * de jungla que la API cuenta por minuto. El cálculo vive en
 * `src-tauri/src/jungle_route.rs`; aquí sólo se pinta.
 *
 * Desde el 2026-10-17 es más corta. Se fueron: la tira de campamentos (la
 * ruta la dibuja el Mapa, sobre el minimapa de verdad), las fichas de la
 * primera vuelta (la fila "Primer clear" abre el Mapa con ella), la caja de
 * invasiones (la cifra la da la lista de movimientos, la única) y "qué hacías
 * al morir" (lo dice cada muerte en el bloque Muertes).
 */

interface Props {
  matchId: string;
  onOpenMap: OpenMap;
}

/** Cuánto de distinto a tu mediana es "como siempre". */
export const CLEAR_COMO_SIEMPRE_S = 10;

export const JungleRouteWidget: React.FC<Props> = ({ matchId, onOpenMap }) => {
  const t = useT();
  // Compartida con "Tus muertes" y el resumen: se pide una vez.
  const resp = useJungleRoute(matchId);
  const mediana = useFirstClearMedian(matchId) ?? null;
  const esqueleto = useDelayedLoading(resp === undefined);

  if (resp === null && !esqueleto) {
    return <EmptyState title={t("Could not read the route")} text={t("Try opening the game again.")} />;
  }
  if (resp === undefined || resp === null || esqueleto) {
    return esqueleto ? <SkeletonLines lines={4} /> : null;
  }
  if (resp.status === "no_minimap") {
    return (
      <EmptyState
        title={t("Measure this game with video to see your route")}
        text={t("The route comes from your icon on the minimap. Measure it from the Impact tab, in Video analysis.")}
      />
    );
  }
  if (resp.status !== "ok" || !resp.route) {
    return (
      <EmptyState
        title={t("No route for this game")}
        text={resp.status === "no_riot"
          ? t("It needs the game synced with Riot.")
          : t("The video could not follow your icon well enough.")}
      />
    );
  }
  return <Ruta r={resp.route} mediana={mediana} onOpenMap={onOpenMap} />;
};

/** El foco del Mapa para la primera vuelta: del primer campamento al último. */
export function firstClearFocus(r: JungleRoute, detail: string | undefined, t: ReturnType<typeof useT>): MapFocus | null {
  if (r.first_clear_end == null || r.clears.length === 0) return null;
  return {
    kind: "moment",
    t: r.clears[0].start,
    until: r.first_clear_end,
    lead: 3,
    title: t("First clear"),
    detail,
  };
}

const Ruta: React.FC<{ r: JungleRoute; mediana: number | null; onOpenMap: OpenMap }> = ({ r, mediana, onOpenMap }) => {
  const t = useT();
  const totalBudget = BUDGET_PARTS.reduce((a, p) => a + r.budget[p.key], 0) || 1;
  const dudosa = r.agreement < JUNGLE_AGREEMENT_MIN;
  const delta = r.first_clear_end != null && mediana != null ? r.first_clear_end - mediana : null;
  // Rojo si tardaste más que de costumbre, verde si menos; "como siempre", gris.
  const tonoMediana =
    delta == null || Math.abs(delta) <= CLEAR_COMO_SIEMPRE_S ? undefined : delta > 0 ? "mt-bad" : "mt-good";
  const camps = r.full_clear ? t("all 6 camps") : t("{n} camps", { n: r.first_clear_camps });
  const foco = firstClearFocus(r, camps, t);

  return (
    <div style={wstyles.body}>
      {dudosa && (
        <p className="jr-warn">
          <AlertTriangle size={13} aria-hidden="true" />
          {t("The video lost your icon for much of this game: only {p}% of your jungle minutes have a camp in the route. Take it as a sketch.", {
            p: Math.round(r.agreement * 100),
          })}
        </p>
      )}

      <div className="mt-facts">
        {foco ? (
          <button type="button" className="mt-fact" onClick={() => onOpenMap(foco)} title={t("Open the map at this moment")}>
            <span>{t("First clear")}</span>
            <b>{mmss(r.first_clear_end as number)}</b>
            <small>
              {camps}
              {delta != null && (
                <span className={tonoMediana}>
                  {" · "}
                  {t("your median {m}", { m: mmss(mediana as number) })}
                </span>
              )}
            </small>
          </button>
        ) : (
          <div className="mt-fact">
            <span>{t("First clear")}</span>
            <b>—</b>
          </div>
        )}
        <div className="mt-fact">
          <span>{t("Late to your camps")}</span>
          <b>{r.mean_delay != null ? mmss(r.mean_delay) : "—"}</b>
          <small>{t("on average, from respawn to you")}</small>
        </div>
        {/* Dos filas: juntas se leía «Vueltas a base 9 · 6 cangrejos», como si
            los cangrejos explicaran las vueltas. */}
        <div className="mt-fact">
          <span>{t("Recalls")}</span>
          <b>{r.recalls.length}</b>
        </div>
        <div className="mt-fact">
          <span>{t("Scuttles")}</span>
          <b>{r.scuttles}</b>
        </div>
      </div>

      {/* ------------------------------------------------ el tiempo */}
      <span className="u-label">{t("Where your time went")}</span>
      <div className="jr-budget" aria-hidden="true">
        {BUDGET_PARTS.map((p) =>
          r.budget[p.key] > 0 ? (
            <span key={p.key} style={{ width: `${(r.budget[p.key] / totalBudget) * 100}%`, background: p.tone }} />
          ) : null
        )}
      </div>
      <div className="jr-budget-legend">
        {BUDGET_PARTS.filter((p) => r.budget[p.key] >= 30).map((p) => (
          <span key={p.key}>
            <i style={{ background: p.tone }} />
            {t(p.label)}
            <b className="u-metric">{Math.round(r.budget[p.key] / 60)} min</b>
          </span>
        ))}
      </div>
    </div>
  );
};
