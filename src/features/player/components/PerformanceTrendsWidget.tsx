import React, { useMemo } from "react";
import { MatchMetadata } from "../../../types";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { outcome } from "../../../core/matchStats";
import { useMatches } from "../../../store/useAppStore";
import { useT } from "../../../core/LanguageProvider";
import { wstyles } from "./videoPlayerStyles";

interface PerformanceTrendsWidgetProps {
  currentMatch: MatchMetadata;
}

/** Colas clasificatorias de Riot: solo/dúo y flexible. */
const RANKED_QUEUES = [420, 440];

const isRanked = (m: MatchMetadata): boolean =>
  m.queue !== undefined && RANKED_QUEUES.includes(m.queue);

/** El puesto del jugador en esa partida, si el scoreboard llegó a guardarse. */
const selfRole = (m: MatchMetadata): string | undefined =>
  (m.participants ?? []).find((p) => p.is_self)?.role || undefined;

const media = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * Una comparación tuya contra tu propia media. `avg` a null = no hay historial
 * suficiente y la fila NO se pinta: comparar contra cero fingía una media de
 * cero, así que la primera partida con un campeón siempre salía "por encima de
 * tu media" con cualquier número positivo.
 */
const Trend: React.FC<{
  label: string;
  value: string;
  tone?: string;
  avg: string | null;
  delta: number | null;
  deltaText: (d: number) => string;
}> = ({ label, value, tone, avg, delta, deltaText }) => (
  <div style={wstyles.statBox}>
    <span className="u-label">{label}</span>
    <span style={{ ...wstyles.statValue, ...(tone ? { color: tone } : {}) }}>{value}</span>
    {avg !== null && <span className="u-meta">{avg}</span>}
    {delta !== null && (
      <span
        style={{
          ...wstyles.statDelta,
          color: delta > 0 ? "var(--win)" : delta < 0 ? "var(--loss)" : "var(--faint)",
        }}
      >
        {delta > 0 ? <TrendingUp size={11} /> : delta < 0 ? <TrendingDown size={11} /> : <Minus size={11} />}
        {deltaText(delta)}
      </span>
    )}
  </div>
);

/**
 * Cómo va esta partida contra tus anteriores con el MISMO campeón.
 *
 * "Mismo campeón" no basta: una Nidalee de jungla en clasificatoria y una
 * Nidalee de mid en normales no son la misma partida, y mezclarlas hacía que la
 * media contra la que te comparas fuera de otra cosa. Se exige también la misma
 * familia de cola (clasificatoria o no) y el mismo rol — este último sólo
 * cuando las dos partidas lo saben, porque las guardadas antes de que existiera
 * el campo lo traen vacío y filtrarlas dejaría el panel sin historial.
 */
export const PerformanceTrendsWidget: React.FC<PerformanceTrendsWidgetProps> = ({ currentMatch }) => {
  const t = useT();
  // La biblioteca sale del store compartido: nada de releer todos los JSON
  // solo para filtrar las partidas de este campeón.
  const { matches, loaded } = useMatches();

  const rol = selfRole(currentMatch);
  const ranked = isRanked(currentMatch);

  const previas = useMemo(
    () =>
      matches.filter((m) => {
        if (m.id === currentMatch.id) return false;
        if (m.champion?.toLowerCase() !== currentMatch.champion?.toLowerCase()) return false;
        if (isRanked(m) !== ranked) return false;
        const otro = selfRole(m);
        // Si a alguna de las dos le falta el puesto, no se puede comparar: se
        // deja pasar en vez de descartar media biblioteca.
        return !rol || !otro || rol === otro;
      }),
    [matches, currentMatch.id, currentMatch.champion, rol, ranked]
  );

  if (!loaded) {
    return <p className="note" style={{ marginTop: 0 }}>{t("Loading…")}</p>;
  }

  const hasHistory = previas.length > 0;

  // Winrate: por el helper compartido, no por comparar la cadena con "victory".
  // El resultado se guarda en varios idiomas y formatos según cuándo se grabó la
  // partida, así que la comparación literal contaba victorias de menos.
  const jugadas = previas.length + 1;
  const victorias =
    previas.filter((m) => outcome(m.result) === "victory").length +
    (outcome(currentMatch.result) === "victory" ? 1 : 0);
  const winRate = Math.round((victorias / jugadas) * 100);

  const goldPrev = previas.map((m) => m.gold_diff_15).filter((g): g is number => g != null);
  const apmPrev = previas.map((m) => m.apm).filter((a): a is number => a != null && a > 0);
  const gankPrev = previas.map((m) => m.gank_impact_15).filter((g): g is number => g != null);

  const goldNow = currentMatch.gold_diff_15;
  const apmNow = currentMatch.apm ? Math.round(currentMatch.apm) : 0;
  const gankNow = currentMatch.gank_impact_15;

  const avgGold = goldPrev.length > 0 ? Math.round(media(goldPrev)) : null;
  const avgApm = apmPrev.length > 0 ? Math.round(media(apmPrev)) : null;
  const avgGank = gankPrev.length > 0 ? Math.round(media(gankPrev) * 10) / 10 : null;

  const signo = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

  return (
    <div style={wstyles.body}>
      <p className="note" style={{ marginTop: 0 }}>
        {hasHistory
          ? t("Against your {n} previous games on {champion} in the same queue and role. Win rate {pct}%.", {
              n: previas.length,
              champion: currentMatch.champion,
              pct: winRate,
            })
          : t("First game on {champion} in this queue and role — nothing to compare against yet.", {
              champion: currentMatch.champion,
            })}
      </p>

      <div style={wstyles.statGrid}>
        {goldNow != null && (
          <Trend
            label={t("Gold difference")}
            value={`${signo(goldNow)}g`}
            tone={goldNow >= 0 ? "var(--win)" : "var(--loss)"}
            avg={avgGold !== null ? t("avg {v}", { v: `${signo(avgGold)}g` }) : null}
            delta={avgGold !== null ? goldNow - avgGold : null}
            deltaText={(d) =>
              d === 0
                ? t("same as your average")
                : t("{v}g vs your average", { v: signo(d) })
            }
          />
        )}

        {gankNow != null && (
          <Trend
            label={t("Gank pressure")}
            value={`${gankNow}%`}
            tone="var(--brand)"
            avg={avgGank !== null ? t("avg {v}", { v: `${avgGank}%` }) : null}
            delta={avgGank !== null ? Math.round((gankNow - avgGank) * 10) / 10 : null}
            deltaText={(d) =>
              d === 0 ? t("same as your average") : t("{v}% vs your average", { v: signo(d) })
            }
          />
        )}

        {apmNow > 0 && (
          <Trend
            label={t("APM")}
            value={`${apmNow}`}
            tone="var(--cool)"
            avg={avgApm !== null ? t("avg {v}", { v: avgApm }) : null}
            delta={avgApm !== null ? apmNow - avgApm : null}
            deltaText={(d) =>
              d === 0 ? t("same as your average") : t("{v} APM vs your average", { v: signo(d) })
            }
          />
        )}

        {currentMatch.kda && (
          <Trend
            label={t("KDA")}
            value={currentMatch.kda}
            avg={null}
            delta={null}
            deltaText={() => ""}
          />
        )}
      </div>
    </div>
  );
};
