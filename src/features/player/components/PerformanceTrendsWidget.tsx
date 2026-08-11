import React, { useEffect, useState } from "react";
import { MatchMetadata } from "../../../types";
import { getRecordedMatches } from "../../../core/tauri-ipc";
import { TrendingUp, TrendingDown, Minus, ShieldCheck } from "lucide-react";

interface PerformanceTrendsWidgetProps {
  currentMatch: MatchMetadata;
}

const champIcon = (champion: string) => `/champions/${champion}.png`;

export const PerformanceTrendsWidget: React.FC<PerformanceTrendsWidgetProps> = ({ currentMatch }) => {
  const [championMatches, setChampionMatches] = useState<MatchMetadata[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let isMounted = true;
    getRecordedMatches()
      .then((matches) => {
        if (!isMounted) return;
        // Filtrar partidas registradas del mismo campeón (excluyendo la partida actual si ya está guardada)
        const sameChamp = (matches || []).filter(
          (m) => m.champion?.toLowerCase() === currentMatch.champion?.toLowerCase() && m.id !== currentMatch.id
        );
        setChampionMatches(sameChamp);
      })
      .catch((err) => console.error("Error loading match history for trends:", err))
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [currentMatch.champion, currentMatch.id]);

  if (loading) {
    return (
      <div style={{ backgroundColor: "var(--bg-card)", borderRadius: "var(--radius-lg)", padding: "16px", color: "var(--text-muted)", fontSize: "12px" }}>
        Cargando historial de tendencias...
      </div>
    );
  }

  const hasHistory = championMatches.length > 0;

  // Calcular promedios históricos del campeón
  const totalGames = championMatches.length + 1;
  const victoriesCount = championMatches.filter((m) => m.result?.toLowerCase() === "victory").length + (currentMatch.result?.toLowerCase() === "victory" ? 1 : 0);
  const winRate = Math.round((victoriesCount / totalGames) * 100);

  // Promedio Oro @15m
  const goldDiffs15 = championMatches.map((m) => m.gold_diff_15).filter((g): g is number => g !== undefined && g !== null);
  const avgGoldDiff15 = goldDiffs15.length > 0 ? Math.round(goldDiffs15.reduce((a, b) => a + b, 0) / goldDiffs15.length) : 0;
  const currGoldDiff15 = currentMatch.gold_diff_15 ?? 0;
  const goldDelta = currGoldDiff15 - avgGoldDiff15;

  // Promedio APM
  const apms = championMatches.map((m) => m.apm).filter((a): a is number => a !== undefined && a !== null && a > 0);
  const avgApm = apms.length > 0 ? Math.round(apms.reduce((a, b) => a + b, 0) / apms.length) : 0;
  const currApm = currentMatch.apm ? Math.round(currentMatch.apm) : 0;
  const apmDelta = currApm - avgApm;

  // Promedio Gank Impact @15m
  const gankImpacts = championMatches.map((m) => m.gank_impact_15).filter((g): g is number => g !== undefined && g !== null);
  const avgGankImpact = gankImpacts.length > 0 ? Math.round((gankImpacts.reduce((a, b) => a + b, 0) / gankImpacts.length) * 10) / 10 : 0;
  const currGankImpact = currentMatch.gank_impact_15 ?? 0;
  const gankDelta = Math.round((currGankImpact - avgGankImpact) * 10) / 10;

  return (
    <div
      style={{
        backgroundColor: "var(--bg-card)",
        border: "1px solid var(--border-subtle)",
        borderTop: "3px solid var(--accent-violet)",
        borderRadius: "var(--radius-lg)",
        padding: "16px",
        display: "flex",
        flexDirection: "column",
        gap: "14px",
        boxShadow: "0 4px 16px rgba(0, 0, 0, 0.2)",
      }}
    >
      {/* Cabecera del Campeón y Rendimiento */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <img
            src={champIcon(currentMatch.champion)}
            alt={currentMatch.champion}
            style={{ width: "32px", height: "32px", borderRadius: "50%", border: "2px solid var(--accent-violet)" }}
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }}
          />
          <div>
            <div style={{ color: "#fff", fontWeight: 800, fontSize: "13px" }}>
              Tendencias con {currentMatch.champion}
            </div>
            <div style={{ fontSize: "10px", color: "var(--text-muted)" }}>
              {hasHistory ? `Comparado contra ${championMatches.length} partidas anteriores` : "Primera partida registrada con este campeón"}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "6px", background: "rgba(129, 140, 248, 0.12)", padding: "4px 10px", borderRadius: "12px", border: "1px solid rgba(129, 140, 248, 0.3)" }}>
          <ShieldCheck size={14} color="var(--accent-violet)" />
          <span style={{ fontSize: "11px", fontWeight: 800, color: "#fff" }}>
            {winRate}% Winrate
          </span>
        </div>
      </div>

      {/* Grid de Comparativa de Métricas */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
        {/* Oro a Minuto 15 */}
        <div style={{ background: "var(--bg-app)", padding: "10px", borderRadius: "8px", border: "1px solid var(--border-subtle)" }}>
          <span style={{ fontSize: "10px", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" }}>Diferencia Oro @15m</span>
          <div style={{ display: "flex", alignItems: "baseline", gap: "6px", marginTop: "2px" }}>
            <span style={{ fontSize: "16px", fontWeight: 800, color: currGoldDiff15 >= 0 ? "#22c55e" : "#ef4444" }}>
              {currGoldDiff15 >= 0 ? `+${currGoldDiff15}g` : `${currGoldDiff15}g`}
            </span>
            {hasHistory && (
              <span style={{ fontSize: "10px", color: "var(--text-secondary)" }}>
                (Prom: {avgGoldDiff15 >= 0 ? `+${avgGoldDiff15}g` : `${avgGoldDiff15}g`})
              </span>
            )}
          </div>
          {hasHistory && (
            <div style={{ display: "flex", alignItems: "center", gap: "4px", marginTop: "4px", fontSize: "10px", fontWeight: 700, color: goldDelta >= 0 ? "#22c55e" : "#ef4444" }}>
              {goldDelta > 0 ? <TrendingUp size={12} /> : goldDelta < 0 ? <TrendingDown size={12} /> : <Minus size={12} />}
              <span>{goldDelta > 0 ? `+${goldDelta}g superior a tu media` : goldDelta < 0 ? `${goldDelta}g inferior a tu media` : "Igual a tu media"}</span>
            </div>
          )}
        </div>

        {/* Presión de Ganks @15m */}
        <div style={{ background: "var(--bg-app)", padding: "10px", borderRadius: "8px", border: "1px solid var(--border-subtle)" }}>
          <span style={{ fontSize: "10px", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" }}>Presión de Ganks</span>
          <div style={{ display: "flex", alignItems: "baseline", gap: "6px", marginTop: "2px" }}>
            <span style={{ fontSize: "16px", fontWeight: 800, color: "#fbbf24" }}>
              {currGankImpact}%
            </span>
            {hasHistory && (
              <span style={{ fontSize: "10px", color: "var(--text-secondary)" }}>
                (Prom: {avgGankImpact}%)
              </span>
            )}
          </div>
          {hasHistory && (
            <div style={{ display: "flex", alignItems: "center", gap: "4px", marginTop: "4px", fontSize: "10px", fontWeight: 700, color: gankDelta >= 0 ? "#22c55e" : "#ef4444" }}>
              {gankDelta > 0 ? <TrendingUp size={12} /> : gankDelta < 0 ? <TrendingDown size={12} /> : <Minus size={12} />}
              <span>{gankDelta > 0 ? `+${gankDelta}% más activo` : gankDelta < 0 ? `${gankDelta}% menos activo` : "En tu media"}</span>
            </div>
          )}
        </div>

        {/* APM Mechanicos */}
        {currApm > 0 && (
          <div style={{ background: "var(--bg-app)", padding: "10px", borderRadius: "8px", border: "1px solid var(--border-subtle)" }}>
            <span style={{ fontSize: "10px", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" }}>Ritmo APM</span>
            <div style={{ display: "flex", alignItems: "baseline", gap: "6px", marginTop: "2px" }}>
              <span style={{ fontSize: "16px", fontWeight: 800, color: "#38bdf8" }}>
                {currApm} APM
              </span>
              {hasHistory && avgApm > 0 && (
                <span style={{ fontSize: "10px", color: "var(--text-secondary)" }}>
                  (Prom: {avgApm})
                </span>
              )}
            </div>
            {hasHistory && avgApm > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: "4px", marginTop: "4px", fontSize: "10px", fontWeight: 700, color: apmDelta >= 0 ? "#22c55e" : "#ef4444" }}>
                {apmDelta > 0 ? <TrendingUp size={12} /> : apmDelta < 0 ? <TrendingDown size={12} /> : <Minus size={12} />}
                <span>{apmDelta > 0 ? `+${apmDelta} APM más veloz` : apmDelta < 0 ? `${apmDelta} APM por debajo` : "Ritmo idéntico"}</span>
              </div>
            )}
          </div>
        )}

        {/* KDA Actual */}
        {currentMatch.kda && (
          <div style={{ background: "var(--bg-app)", padding: "10px", borderRadius: "8px", border: "1px solid var(--border-subtle)" }}>
            <span style={{ fontSize: "10px", fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase" }}>KDA de la Partida</span>
            <div style={{ display: "flex", alignItems: "baseline", gap: "6px", marginTop: "2px" }}>
              <span style={{ fontSize: "16px", fontWeight: 800, color: "#fff" }}>
                {currentMatch.kda}
              </span>
            </div>
            <div style={{ fontSize: "10px", color: "var(--accent-violet)", fontWeight: 700, marginTop: "4px" }}>
              {totalGames} partidas registradas
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
