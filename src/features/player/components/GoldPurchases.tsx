import React, { useMemo, useState } from "react";
import type { ItemPurchase, TimelineMarker } from "../../../types";
import type { GoldIncome } from "../../../core/tauri-ipc";
import { mmss } from "../../../core/time";
import { useT } from "../../../core/LanguageProvider";
import { useGoldReport } from "../useMatchData";
import { formatGold } from "./pressureFormat";
import { itemIcon } from "./videoPlayerUtils";
import { wstyles } from "./videoPlayerStyles";
import "./JungleRouteWidget.css";
import "./DeathsSection.css";

/**
 * Tu oro y tus compras, en una sección.
 *
 * Eran tres: "Compras de objetos" (cada objeto con su hora), "Picos de poder"
 * (las MISMAS horas de compra, con las kills de los 3 minutos siguientes) y
 * las vueltas a base de "Tu oro". Las tres hablan de lo mismo —cada visita a
 * la tienda—, así que ahora hay una fila por visita: qué compraste, con cuánto
 * oro llegabas (si se grabó) y qué participaciones vinieron después.
 */

/** Compras a menos de esto entre sí son la misma visita a la tienda. */
const MISMA_VISITA_S = 45;
/** Ventana en la que una compra se considera responsable de una participación. */
const PICO_S = 180;
/** Menos que esto al volver no da para un componente. */
const VUELTA_CORTA = 500;
const PRIMERA_PAGINA = 6;

const PARTES: { key: keyof GoldIncome; label: string; tone: string }[] = [
  { key: "camps", label: "Camps", tone: "var(--cool)" },
  { key: "farm", label: "Minions and monsters", tone: "color-mix(in srgb, var(--cool) 40%, var(--sunken))" },
  { key: "takedowns", label: "Kills and assists", tone: "var(--brand)" },
  { key: "objectives", label: "Objectives", tone: "var(--flag)" },
  { key: "passive", label: "Passive", tone: "var(--muted)" },
  { key: "other", label: "Not split", tone: "var(--hair-strong)" },
];

interface Props {
  matchId: string;
  /** Tiempos en segundos de VÍDEO. */
  itemPurchases: ItemPurchase[];
  markers?: TimelineMarker[];
  ddragonVer: string;
  videoOffset: number;
  onSeek: (videoSeconds: number) => void;
}

export const GoldPurchases: React.FC<Props> = ({ matchId, itemPurchases, markers, ddragonVer, videoOffset, onSeek }) => {
  const t = useT();
  const oro = useGoldReport(matchId);
  const [todas, setTodas] = useState(false);
  const g = oro?.status === "ok" ? oro.report : null;

  const visitas = useMemo(() => {
    const out: { t: number; items: number[] }[] = [];
    for (const ip of [...itemPurchases].sort((a, b) => a.time - b.time)) {
      const ultima = out[out.length - 1];
      if (ultima && ip.time - ultima.t <= MISMA_VISITA_S) ultima.items.push(ip.item_id);
      else out.push({ t: ip.time, items: [ip.item_id] });
    }
    const kills = (markers ?? []).filter((m) => m.event_type === "kill" || m.event_type === "assist");
    return out.map((v) => ({
      ...v,
      ka: kills.filter((k) => k.time >= v.t && k.time <= v.t + PICO_S).length,
      // La vuelta a base del oro va en tiempo de partida; la compra, de vídeo.
      llegada: g?.recalls.find((r) => Math.abs(r.time + videoOffset - v.t) <= 15)?.gold ?? null,
    }));
  }, [itemPurchases, markers, g, videoOffset]);

  if (visitas.length === 0 && !g) {
    return <p className="note" style={{ margin: 0 }}>{t("Item purchases come from Riot's timeline. Sync the game with Riot to see them.")}</p>;
  }

  const total = g ? PARTES.reduce((a, p) => a + g.income[p.key], 0) || 1 : 1;
  const cortas = g ? g.recalls.filter((r) => r.gold < VUELTA_CORTA).length : 0;
  const lista = todas ? visitas : visitas.slice(0, PRIMERA_PAGINA);

  return (
    <div style={wstyles.body}>
      {g && (
        <>
          <span className="u-label">{t("Where your gold came from")}</span>
          <div className="jr-budget" aria-hidden="true">
            {PARTES.map((p) =>
              g.income[p.key] > 0 ? (
                <span key={p.key} style={{ width: `${(g.income[p.key] / total) * 100}%`, background: p.tone }} />
              ) : null
            )}
          </div>
          <div className="jr-budget-legend">
            {PARTES.filter((p) => g.income[p.key] / total >= 0.02).map((p) => (
              <span key={p.key}>
                <i style={{ background: p.tone }} />
                {t(p.label)}
                <b className="u-metric">{formatGold(g.income[p.key])}</b>
              </span>
            ))}
          </div>
          {g.recalls.length > 0 && (
            <p className="note" style={{ margin: 0 }}>
              {cortas > 0
                ? t("{n} of {total} recalls with less than {g} gold: not enough for a component.", { n: cortas, total: g.recalls.length, g: VUELTA_CORTA })
                : t("Every recall with at least {g} gold to spend.", { g: VUELTA_CORTA })}
            </p>
          )}
        </>
      )}

      {visitas.length > 0 && (
        <div className="ds-list">
          {lista.map((v, i) => (
            <button key={i} type="button" className="gp-visit" onClick={() => onSeek(v.t)} title={t("Jump to this moment")}>
              <span className="u-time ds-time">{mmss(Math.max(0, v.t - videoOffset))}</span>
              <span className="gp-items">
                {v.items.map((it, k) => (
                  <img
                    key={k}
                    src={itemIcon(ddragonVer, it)}
                    alt=""
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }}
                  />
                ))}
              </span>
              <span className="gp-meta">
                {v.llegada != null && (
                  <span style={{ color: v.llegada < VUELTA_CORTA ? "var(--loss)" : undefined }}>
                    {t("arrived with {g}", { g: formatGold(v.llegada) })}
                  </span>
                )}
                {v.ka > 0 && <span style={{ color: "var(--win)" }}>{t("+{n} K/A in 3 min", { n: v.ka })}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      {visitas.length > PRIMERA_PAGINA && (
        <button type="button" className="btn btn--ghost btn--sm gp-more" onClick={() => setTodas((x) => !x)}>
          {todas ? t("Show fewer") : t("Show all {n} visits", { n: visitas.length })}
        </button>
      )}
    </div>
  );
};
