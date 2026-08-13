import React, { useState } from "react";
import { MinuteFrameDto } from "../../../types";
import { TrendingUp } from "lucide-react";

interface GoldXpChartProps {
  frames: MinuteFrameDto[];
  // Segundos de vídeo previos al 0:00 de la partida: el eje de esta gráfica son minutos
  // DE PARTIDA, así que hay que sumarlos para saltar al punto correcto del vídeo.
  videoOffset: number;
  onSeek: (seconds: number) => void;
}

type MetricMode = "team_gold" | "self_gold" | "self_xp";

export const GoldXpChart: React.FC<GoldXpChartProps> = ({ frames, videoOffset, onSeek }) => {
  const [mode, setMode] = useState<MetricMode>("team_gold");
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (!frames || frames.length < 2) return null;

  // Extraer valores según el modo seleccionado
  const values = frames.map((f) => {
    switch (mode) {
      case "team_gold": return f.team_gold_diff;
      case "self_gold": return f.self_gold_diff;
      case "self_xp": return f.self_xp_diff;
    }
  });

  const maxVal = Math.max(...values.map((v) => Math.abs(v)), 1000);
  const minVal = -maxVal;
  const range = maxVal - minVal;

  const height = 120;
  const width = 600;

  // Puntos para SVG
  const points = values.map((val, idx) => {
    const x = (idx / (values.length - 1)) * width;
    // Y: 0 arriba, height abajo. El centro es minVal + range/2
    const normalizedY = 1 - (val - minVal) / range;
    const y = Math.max(10, Math.min(height - 10, normalizedY * height));
    return { x, y, val, minute: frames[idx].minute };
  });

  const zeroY = (1 - (0 - minVal) / range) * height;

  // Generar path suave para la línea y el área
  const lineD = points.reduce((acc, p, i) => `${acc} ${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`, "");

  // Áreas positiva y negativa
  const areaPosD = `${lineD} L ${width} ${zeroY} L 0 ${zeroY} Z`;

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const pct = relX / rect.width;
    const idx = Math.min(frames.length - 1, Math.floor(pct * frames.length));
    setHoverIndex(idx);
  };

  const handleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const pct = relX / rect.width;
    const gameSecs = pct * (frames.length - 1) * 60;
    onSeek(Math.max(0, gameSecs + videoOffset));
  };

  const hoverP = hoverIndex !== null ? points[hoverIndex] : null;

  return (
    <div style={{
      backgroundColor: "var(--bg-card)",
      border: "1px solid var(--border-subtle)",
      borderRadius: "var(--radius-lg)",
      padding: "16px",
      display: "flex",
      flexDirection: "column",
      gap: "12px",
      boxShadow: "0 4px 16px rgba(0, 0, 0, 0.2)",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", color: "var(--text)", fontWeight: 700, fontSize: "13px" }}>
          <TrendingUp size={16} color="var(--accent-violet)" />
          <span>Curva de Ventaja de Partida</span>
        </div>
        <div style={{ display: "flex", gap: "4px", background: "var(--bg-app)", padding: "2px", borderRadius: "6px" }}>
          <button
            onClick={() => setMode("team_gold")}
            style={{
              background: mode === "team_gold" ? "var(--accent-violet-soft)" : "transparent",
              color: mode === "team_gold" ? "var(--text)" : "var(--text-muted)",
              border: "none",
              borderRadius: "4px",
              padding: "4px 8px",
              fontSize: "11px",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Oro Equipo
          </button>
          <button
            onClick={() => setMode("self_gold")}
            style={{
              background: mode === "self_gold" ? "var(--accent-violet-soft)" : "transparent",
              color: mode === "self_gold" ? "var(--text)" : "var(--text-muted)",
              border: "none",
              borderRadius: "4px",
              padding: "4px 8px",
              fontSize: "11px",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Oro Individual
          </button>
          <button
            onClick={() => setMode("self_xp")}
            style={{
              background: mode === "self_xp" ? "var(--accent-violet-soft)" : "transparent",
              color: mode === "self_xp" ? "var(--text)" : "var(--text-muted)",
              border: "none",
              borderRadius: "4px",
              padding: "4px 8px",
              fontSize: "11px",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            XP Individual
          </button>
        </div>
      </div>

      <div style={{ position: "relative", width: "100%", height: `${height}px` }}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          style={{ width: "100%", height: "100%", cursor: "pointer", overflow: "visible" }}
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoverIndex(null)}
          onClick={handleClick}
        >
          <defs>
            <linearGradient id="goldPosGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-victory)" stopOpacity="0.35" />
              <stop offset="100%" stopColor="var(--color-victory)" stopOpacity="0.0" />
            </linearGradient>
          </defs>

          {/* Línea cero */}
          <line x1="0" y1={zeroY} x2={width} y2={zeroY} stroke="rgba(255,255,255,0.15)" strokeDasharray="4 4" strokeWidth="1" />

          {/* Relleno de área */}
          <path d={areaPosD} fill="url(#goldPosGrad)" />

          {/* Línea principal */}
          <path d={lineD} fill="none" stroke="var(--accent-violet)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />

          {/* Indicador de hover */}
          {hoverP && (
            <>
              <line x1={hoverP.x} y1="0" x2={hoverP.x} y2={height} stroke="rgba(255,255,255,0.4)" strokeDasharray="2 2" />
              <circle cx={hoverP.x} cy={hoverP.y} r="5" fill="var(--text)" stroke="var(--accent-violet)" strokeWidth="2" />
            </>
          )}
        </svg>

        {/* Tooltip en hover */}
        {hoverP && (
          <div style={{
            position: "absolute",
            top: "-36px",
            left: `${(hoverP.x / width) * 100}%`,
            transform: "translateX(-50%)",
            background: "color-mix(in srgb, var(--panel) 95%, transparent)",
            border: "1px solid var(--border-strong)",
            borderRadius: "6px",
            padding: "4px 8px",
            fontSize: "11px",
            fontWeight: 800,
            color: "var(--text)",
            pointerEvents: "none",
            boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
            whiteSpace: "nowrap",
            zIndex: 10,
          }}>
            Min {hoverP.minute}:00 ·{" "}
            <span style={{ color: hoverP.val >= 0 ? "var(--color-victory)" : "var(--color-defeat)" }}>
              {hoverP.val >= 0 ? `+${hoverP.val.toLocaleString()}` : hoverP.val.toLocaleString()} {mode.includes("gold") ? "g" : "XP"}
            </span>
          </div>
        )}
      </div>

      <span style={{ fontSize: "10px", color: "var(--text-muted)", textAlign: "center" }}>
        Haz clic en cualquier punto de la gráfica para saltar el vídeo a ese minuto de la partida.
      </span>
    </div>
  );
};
