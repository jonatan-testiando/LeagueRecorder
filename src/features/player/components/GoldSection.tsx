import React, { useEffect, useState } from "react";
import { getGoldReport, type GoldIncome, type GoldReport } from "../../../core/tauri-ipc";
import { mmss } from "../../../core/time";
import { useT } from "../../../core/LanguageProvider";
import { InspSection } from "./InspSection";
import { formatGold } from "./pressureFormat";
import { wstyles } from "./videoPlayerStyles";
import "./JungleRouteWidget.css";

/**
 * Tu oro, segundo a segundo: de dónde sale, con cuánto vuelves a base y con
 * cuánto mueres. El cálculo vive en `src-tauri/src/gold.rs`.
 *
 * Sólo existe en partidas grabadas desde que se guarda el oro en directo: en
 * las demás la sección entera no aparece (no hay nada que decir de ellas, y
 * un "no disponible" en cada partida vieja sería ruido).
 */

/** Más que esto sin gastar al morir es oro que no llegó a pelear. */
const SIN_GASTAR = 1000;
/** Menos que esto al volver no da para un componente. */
const VUELTA_CORTA = 500;

const PARTES: { key: keyof GoldIncome; label: string; tone: string }[] = [
  { key: "camps", label: "Camps", tone: "var(--cool)" },
  { key: "farm", label: "Minions and monsters", tone: "color-mix(in srgb, var(--cool) 40%, var(--sunken))" },
  { key: "takedowns", label: "Kills and assists", tone: "var(--brand)" },
  { key: "objectives", label: "Objectives", tone: "var(--flag)" },
  { key: "passive", label: "Passive", tone: "var(--muted)" },
  { key: "other", label: "Not split", tone: "var(--hair-strong)" },
];

export const GoldSection: React.FC<{ matchId: string; onSeek: (videoSeconds: number) => void }> = ({ matchId, onSeek }) => {
  const t = useT();
  const [r, setR] = useState<GoldReport | null>(null);

  useEffect(() => {
    let vivo = true;
    setR(null);
    getGoldReport(matchId)
      .then((g) => vivo && setR(g.status === "ok" ? g.report : null))
      .catch((e) => console.error("get_gold_report", e));
    return () => { vivo = false; };
  }, [matchId]);

  if (!r) return null;
  const ir = (gameSec: number) => onSeek(Math.max(0, gameSec + r.video_offset - 3));
  const total = PARTES.reduce((a, p) => a + r.income[p.key], 0) || 1;
  const cortas = r.recalls.filter((v) => v.gold < VUELTA_CORTA).length;
  const caras = r.deaths.filter((d) => d.unspent >= SIN_GASTAR).length;

  return (
    <InspSection id="gold" title={t("Your gold")}>
      <div style={wstyles.body}>
        <div className="jr-budget" aria-hidden="true">
          {PARTES.map((p) =>
            r.income[p.key] > 0 ? (
              <span key={p.key} style={{ width: `${(r.income[p.key] / total) * 100}%`, background: p.tone }} />
            ) : null
          )}
        </div>
        <div className="jr-budget-legend">
          {PARTES.filter((p) => r.income[p.key] / total >= 0.02).map((p) => (
            <span key={p.key}>
              <i style={{ background: p.tone }} />
              {t(p.label)}
              <b className="u-metric">{formatGold(r.income[p.key])}</b>
            </span>
          ))}
        </div>

        {r.recalls.length > 0 && (
          <>
            <div className="sect__head" style={{ marginTop: "var(--space-1)" }}>
              <span className="u-label">{t("Recalls")}</span>
              <i className="sect__rule" />
            </div>
            <p className="note" style={{ margin: 0 }}>
              {cortas > 0
                ? t("{n} of {total} recalls with less than {g} gold: not enough for a component.", {
                    n: cortas, total: r.recalls.length, g: VUELTA_CORTA,
                  })
                : t("Every recall with at least {g} gold to spend.", { g: VUELTA_CORTA })}
            </p>
            <div style={wstyles.list}>
              {r.recalls.map((v, i) => (
                <button key={i} type="button" className="jr-death" onClick={() => ir(v.time)}>
                  <span className="u-time">{mmss(v.time)}</span>
                  <span style={{ color: v.gold < VUELTA_CORTA ? "var(--loss)" : undefined }}>
                    {t("arrived with {g}", { g: formatGold(v.gold) })}
                    <span className="jr-death-camp"> · {t("spent {g}", { g: formatGold(v.spent) })}</span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {r.deaths.length > 0 && (
          <>
            <div className="sect__head" style={{ marginTop: "var(--space-1)" }}>
              <span className="u-label">{t("Gold you died with")}</span>
              <i className="sect__rule" />
            </div>
            {caras > 0 && (
              <p className="note" style={{ margin: 0 }}>
                {t("{n} deaths with more than {g} gold unspent: gold that never got to fight.", { n: caras, g: SIN_GASTAR })}
              </p>
            )}
            <div style={wstyles.list}>
              {r.deaths.map((d, i) => (
                <button key={i} type="button" className="jr-death" onClick={() => ir(d.time)}>
                  <span className="u-time">{mmss(d.time)}</span>
                  <span style={{ color: d.unspent >= SIN_GASTAR ? "var(--loss)" : undefined }}>
                    {t("{g} unspent", { g: formatGold(d.unspent) })}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </InspSection>
  );
};
