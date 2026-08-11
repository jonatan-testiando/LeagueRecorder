import React, { useState } from "react";
import { TimelineMarker } from "../../../types";
import { Crosshair, CheckCircle2, AlertCircle, XCircle, Filter, Compass, Lightbulb } from "lucide-react";

interface GankEfficiencyWidgetProps {
  markers?: TimelineMarker[];
  gankImpact15?: number;
  onSeek: (seconds: number) => void;
}

type LaneFilter = "all" | "top" | "mid" | "bot";
type OutcomeFilter = "all" | "success" | "neutral" | "failed";

export const GankEfficiencyWidget: React.FC<GankEfficiencyWidgetProps> = ({
  markers = [],
  gankImpact15,
  onSeek,
}) => {
  const [selectedLane, setSelectedLane] = useState<LaneFilter>("all");
  const [selectedOutcome, setSelectedOutcome] = useState<OutcomeFilter>("all");

  // Obtener todos los eventos de ganks e impresiones de presencia temprana (<= 15 min = 900s)
  const gankEvents = markers
    .filter((m) => m.time <= 900)
    .map((m) => {
      let lane: "top" | "mid" | "bot" | "other" = "other";
      let isFlank = false; // Indica si le cortó el paso por detrás

      if (m.position_x !== undefined && m.position_y !== undefined) {
        const x = m.position_x;
        const y = m.position_y;

        if (x < 4500 || y > 10500) {
          lane = "top";
          // En Top, si y > 11500 o x < 2500, estás cortando el paso profundo por detrás
          if (y > 11500 || x < 2500) isFlank = true;
        } else if (x > 10500 || y < 4500) {
          lane = "bot";
          // En Bot, si x > 11500 o y < 2500, estás cortando el paso por detrás
          if (x > 11500 || y < 2500) isFlank = true;
        } else if (x >= 4500 && x <= 10500 && y >= 4500 && y <= 10500) {
          lane = "mid";
          // En Mid, posiciones diagonales profundas detrás de torre
          if (y > 8000 && x < 6000) isFlank = true;
        }
      }

      let outcome: "success" | "neutral" | "failed" = "neutral";
      if (m.event_type === "kill" || m.event_type === "assist") outcome = "success";
      else if (m.event_type === "death") outcome = "failed";
      else if (m.event_type === "gank_attempt") outcome = "neutral";

      return {
        marker: m,
        lane,
        outcome,
        isFlank,
      };
    })
    .filter((g) => g.lane !== "other" || g.marker.event_type === "gank_attempt");

  if (gankEvents.length === 0 && gankImpact15 === undefined) return null;

  // Conteo por carriles
  const topGanks = gankEvents.filter((g) => g.lane === "top");
  const midGanks = gankEvents.filter((g) => g.lane === "mid");
  const botGanks = gankEvents.filter((g) => g.lane === "bot");

  // Filtrar según la selección actual
  const filteredGanks = gankEvents.filter((g) => {
    const laneMatch = selectedLane === "all" || g.lane === selectedLane;
    const outcomeMatch = selectedOutcome === "all" || g.outcome === selectedOutcome;
    return laneMatch && outcomeMatch;
  });

  const successCount = gankEvents.filter((g) => g.outcome === "success").length;
  const neutralCount = gankEvents.filter((g) => g.outcome === "neutral").length;
  const failedCount = gankEvents.filter((g) => g.outcome === "failed").length;

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  };

  return (
    <div
      style={{
        backgroundColor: "var(--bg-card)",
        border: "1px solid var(--border-subtle)",
        borderTop: "3px solid #22c55e",
        borderRadius: "var(--radius-lg)",
        padding: "16px",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        boxShadow: "0 4px 16px rgba(0, 0, 0, 0.2)",
      }}
    >
      {/* Cabecera con Métricas Totales */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "#fff", fontWeight: 700, fontSize: "13px" }}>
          <Crosshair size={16} color="#22c55e" />
          <span>Análisis Táctico de Ganks e Impacto en Líneas</span>
        </div>
        {gankImpact15 !== undefined && (
          <span
            style={{
              fontSize: "11px",
              fontWeight: 800,
              padding: "2px 8px",
              borderRadius: "12px",
              background: "rgba(34, 197, 94, 0.15)",
              color: "#22c55e",
              border: "1px solid rgba(34, 197, 94, 0.3)",
            }}
          >
            {gankImpact15}% Presión de Gank
          </span>
        )}
      </div>

      {/* Botones Interactivos de Selección de Carril */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px" }}>
        <div
          onClick={() => setSelectedLane(selectedLane === "top" ? "all" : "top")}
          style={{
            background: selectedLane === "top" ? "rgba(56, 189, 248, 0.15)" : "var(--bg-app)",
            padding: "8px",
            borderRadius: "6px",
            border: `1px solid ${selectedLane === "top" ? "#38bdf8" : "var(--border-subtle)"}`,
            textAlign: "center",
            cursor: "pointer",
            transition: "all 0.15s ease",
          }}
        >
          <span style={{ fontSize: "10px", color: "var(--text-muted)", fontWeight: 700, textTransform: "uppercase" }}>Top Lane</span>
          <div style={{ fontSize: "15px", fontWeight: 800, color: "#38bdf8", marginTop: "2px" }}>
            {topGanks.length} Ganks
          </div>
        </div>

        <div
          onClick={() => setSelectedLane(selectedLane === "mid" ? "all" : "mid")}
          style={{
            background: selectedLane === "mid" ? "rgba(251, 191, 36, 0.15)" : "var(--bg-app)",
            padding: "8px",
            borderRadius: "6px",
            border: `1px solid ${selectedLane === "mid" ? "#fbbf24" : "var(--border-subtle)"}`,
            textAlign: "center",
            cursor: "pointer",
            transition: "all 0.15s ease",
          }}
        >
          <span style={{ fontSize: "10px", color: "var(--text-muted)", fontWeight: 700, textTransform: "uppercase" }}>Mid Lane</span>
          <div style={{ fontSize: "15px", fontWeight: 800, color: "#fbbf24", marginTop: "2px" }}>
            {midGanks.length} Ganks
          </div>
        </div>

        <div
          onClick={() => setSelectedLane(selectedLane === "bot" ? "all" : "bot")}
          style={{
            background: selectedLane === "bot" ? "rgba(168, 85, 247, 0.15)" : "var(--bg-app)",
            padding: "8px",
            borderRadius: "6px",
            border: `1px solid ${selectedLane === "bot" ? "#a855f7" : "var(--border-subtle)"}`,
            textAlign: "center",
            cursor: "pointer",
            transition: "all 0.15s ease",
          }}
        >
          <span style={{ fontSize: "10px", color: "var(--text-muted)", fontWeight: 700, textTransform: "uppercase" }}>Bot Lane</span>
          <div style={{ fontSize: "15px", fontWeight: 800, color: "#a855f7", marginTop: "2px" }}>
            {botGanks.length} Ganks
          </div>
        </div>
      </div>

      {/* Filtros Secundarios por Resultado */}
      <div style={{ display: "flex", gap: "6px", alignItems: "center", overflowX: "auto" }}>
        <span style={{ fontSize: "11px", color: "var(--text-muted)", fontWeight: 700, display: "flex", alignItems: "center", gap: 4 }}>
          <Filter size={12} /> Resultado:
        </span>
        <button
          onClick={() => setSelectedOutcome("all")}
          style={{
            background: selectedOutcome === "all" ? "var(--accent-violet-soft)" : "var(--bg-app)",
            color: selectedOutcome === "all" ? "#fff" : "var(--text-muted)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "4px",
            padding: "3px 8px",
            fontSize: "11px",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Todos ({gankEvents.length})
        </button>
        <button
          onClick={() => setSelectedOutcome("success")}
          style={{
            background: selectedOutcome === "success" ? "rgba(34, 197, 94, 0.2)" : "var(--bg-app)",
            color: selectedOutcome === "success" ? "#22c55e" : "var(--text-muted)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "4px",
            padding: "3px 8px",
            fontSize: "11px",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Efectivos ({successCount})
        </button>
        <button
          onClick={() => setSelectedOutcome("neutral")}
          style={{
            background: selectedOutcome === "neutral" ? "rgba(251, 191, 36, 0.2)" : "var(--bg-app)",
            color: selectedOutcome === "neutral" ? "#fbbf24" : "var(--text-muted)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "4px",
            padding: "3px 8px",
            fontSize: "11px",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Sin Resultado ({neutralCount})
        </button>
        <button
          onClick={() => setSelectedOutcome("failed")}
          style={{
            background: selectedOutcome === "failed" ? "rgba(239, 68, 68, 0.2)" : "var(--bg-app)",
            color: selectedOutcome === "failed" ? "#ef4444" : "var(--text-muted)",
            border: "1px solid var(--border-subtle)",
            borderRadius: "4px",
            padding: "3px 8px",
            fontSize: "11px",
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Fallidos ({failedCount})
        </button>
      </div>

      {/* Lista de Ganks Filtrados con Evaluación Táctica de Ángulo de Entrada */}
      {filteredGanks.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {filteredGanks.map((item, idx) => {
            const isSuccess = item.outcome === "success";
            const isNeutral = item.outcome === "neutral";
            const isFailed = item.outcome === "failed";

            const accentColor = isSuccess ? "#22c55e" : isNeutral ? "#fbbf24" : "#ef4444";

            return (
              <div
                key={idx}
                onClick={() => onSeek(item.marker.time)}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                  padding: "10px 12px",
                  borderRadius: "6px",
                  background: "var(--bg-app)",
                  border: "1px solid var(--border-subtle)",
                  borderLeft: `4px solid ${accentColor}`,
                  cursor: "pointer",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: "11px",
                        fontWeight: 700,
                        color: "var(--text-secondary)",
                        background: "rgba(255, 255, 255, 0.06)",
                        padding: "2px 6px",
                        borderRadius: "4px",
                      }}
                    >
                      {formatTime(item.marker.time)}
                    </span>
                    <span style={{ fontSize: "12px", fontWeight: 700, color: "#fff" }}>
                      {item.marker.description}
                    </span>
                    <span style={{ fontSize: "10px", color: "var(--text-muted)", textTransform: "uppercase", fontWeight: 800 }}>
                      • {item.lane.toUpperCase()}
                    </span>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    {isSuccess && (
                      <span style={{ fontSize: "11px", color: "#22c55e", fontWeight: 800, display: "flex", alignItems: "center", gap: 3 }}>
                        <CheckCircle2 size={13} /> Efectivo
                      </span>
                    )}
                    {isNeutral && (
                      <span style={{ fontSize: "11px", color: "#fbbf24", fontWeight: 800, display: "flex", alignItems: "center", gap: 3 }}>
                        <AlertCircle size={13} /> Sin resultado
                      </span>
                    )}
                    {isFailed && (
                      <span style={{ fontSize: "11px", color: "#ef4444", fontWeight: 800, display: "flex", alignItems: "center", gap: 3 }}>
                        <XCircle size={13} /> Fallido / Muerte
                      </span>
                    )}
                    <span style={{ fontSize: "10px", color: "var(--accent-violet)", fontWeight: 800, marginLeft: "4px" }}>
                      Ver vídeo
                    </span>
                  </div>
                </div>

                {/* Análisis Táctico de Entrada (Flanqueo vs Entrada Directa) */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(255, 255, 255, 0.03)", padding: "4px 8px", borderRadius: "4px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", color: "var(--text-secondary)" }}>
                    <Compass size={12} color={item.isFlank ? "#38bdf8" : "var(--text-muted)"} />
                    <span>Ángulo de Entrada: <b>{item.isFlank ? "Cortar Paso / Flanqueo por detrás" : "Entrada Frontal / Directa en línea"}</b></span>
                  </div>
                </div>

                {/* Consejo de Coaching Práctico */}
                {isNeutral && !item.isFlank && (
                  <div style={{ fontSize: "11px", color: "#fbbf24", display: "flex", alignItems: "center", gap: "6px", background: "rgba(251, 191, 36, 0.08)", padding: "6px", borderRadius: "4px" }}>
                    <Lightbulb size={13} />
                    <span>Consejo: Entrada frontal detectada. Entrar en línea recta facilitó la huida del rival. En la próxima, rodea por el río/tribush para cortarle el paso hacia su torre.</span>
                  </div>
                )}

                {isNeutral && item.isFlank && (
                  <div style={{ fontSize: "11px", color: "#38bdf8", display: "flex", alignItems: "center", gap: "6px", background: "rgba(56, 189, 248, 0.08)", padding: "6px", borderRadius: "4px" }}>
                    <Lightbulb size={13} />
                    <span>Consejo: Excelente ángulo cortando la retirada. Revisa el clip para comprobar si usó Destello o si faltó sincronizar tu habilidad de control (CC).</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ padding: "12px", textAlign: "center", color: "var(--text-muted)", fontSize: "12px" }}>
          No hay emboscadas registradas con el filtro seleccionado.
        </div>
      )}
    </div>
  );
};
