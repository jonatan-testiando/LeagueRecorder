import React, { useMemo, useState } from "react";
import { MinuteFrameDto } from "../../../types";
import { useT } from "../../../core/LanguageProvider";
import { EmptyState } from "../../../components/ui/EmptyState";
import { wstyles } from "./videoPlayerStyles";

interface GoldXpChartProps {
  frames: MinuteFrameDto[];
  // Segundos de vídeo previos al 0:00 de la partida: el eje de esta gráfica son minutos
  // DE PARTIDA, así que hay que sumarlos para saltar al punto correcto del vídeo.
  videoOffset: number;
  onSeek: (seconds: number) => void;
}

type MetricMode = "team_gold" | "self_gold" | "self_xp";

const MODES: { key: MetricMode; label: string }[] = [
  { key: "team_gold", label: "Team gold" },
  { key: "self_gold", label: "Your gold" },
  { key: "self_xp", label: "Your XP" },
];

/**
 * Suelo de la escala. Sin él, una partida igualada (±80 de oro) se dibujaba
 * como una montaña rusa. Con el suelo clavado en 1000 pasaba lo contrario: una
 * partida de ±6000 quedaba aplastada... no, quedaba bien, pero una de ±200 se
 * pintaba como una línea muerta aunque la ventaja fuera real. El suelo ahora es
 * relativo a los datos y sólo actúa cuando de verdad no hay nada que enseñar.
 */
const MIN_SCALE = 200;

const HEIGHT = 120;
const WIDTH = 600;

export const GoldXpChart: React.FC<GoldXpChartProps> = ({ frames, videoOffset, onSeek }) => {
  const t = useT();
  const [mode, setMode] = useState<MetricMode>("team_gold");
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const values = useMemo(
    () =>
      (frames ?? []).map((f) => {
        switch (mode) {
          case "team_gold": return f.team_gold_diff;
          case "self_gold": return f.self_gold_diff;
          case "self_xp": return f.self_xp_diff;
        }
      }),
    [frames, mode]
  );

  if (!frames || frames.length < 2) {
    return (
      <EmptyState
        title={t("No minute-by-minute data")}
        text={t("The curve needs at least two minute frames from Riot's timeline.")}
      />
    );
  }

  // La escala sale de los datos, con un mínimo para que una partida clavada no
  // se dibuje como ruido amplificado.
  const maxVal = Math.max(...values.map((v) => Math.abs(v)), MIN_SCALE);
  const minVal = -maxVal;
  const range = maxVal - minVal;

  const points = values.map((val, idx) => {
    const x = (idx / (values.length - 1)) * WIDTH;
    const normalizedY = 1 - (val - minVal) / range;
    const y = Math.max(10, Math.min(HEIGHT - 10, normalizedY * HEIGHT));
    return { x, y, val, minute: frames[idx].minute };
  });

  const zeroY = (1 - (0 - minVal) / range) * HEIGHT;
  const lineD = points.reduce(
    (acc, p, i) => `${acc} ${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`,
    ""
  );
  const areaD = `${lineD} L ${WIDTH} ${zeroY} L 0 ${zeroY} Z`;

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const idx = Math.min(frames.length - 1, Math.floor((relX / rect.width) * frames.length));
    setHoverIndex(idx);
  };

  const handleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const gameSecs = (relX / rect.width) * (frames.length - 1) * 60;
    onSeek(Math.max(0, gameSecs + videoOffset));
  };

  const hoverP = hoverIndex !== null ? points[hoverIndex] : null;
  const unit = mode === "self_xp" ? t("XP") : t("g");

  return (
    // Sin tarjeta ni título: los pone la sección del inspector que la contiene.
    <div style={wstyles.body}>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <div className="tp-seg">
          {MODES.map((m) => (
            <button
              key={m.key}
              onClick={() => setMode(m.key)}
              aria-pressed={mode === m.key}
              data-on={mode === m.key ? "" : undefined}
            >
              {t(m.label)}
            </button>
          ))}
        </div>
      </div>

      <div style={wstyles.chartWrap}>
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          style={wstyles.chartSvg}
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoverIndex(null)}
          onClick={handleClick}
        >
          <defs>
            <linearGradient id="goldPosGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--cool)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="var(--cool)" stopOpacity="0" />
            </linearGradient>
          </defs>

          <line
            x1="0" y1={zeroY} x2={WIDTH} y2={zeroY}
            stroke="var(--line)" strokeDasharray="4 4" strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
          <path d={areaD} fill="url(#goldPosGrad)" />
          <path
            d={lineD} fill="none" stroke="var(--cool)" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"
          />

          {hoverP && (
            <>
              <line
                x1={hoverP.x} y1="0" x2={hoverP.x} y2={HEIGHT}
                stroke="var(--muted)" strokeDasharray="2 2" vectorEffect="non-scaling-stroke"
              />
              <circle cx={hoverP.x} cy={hoverP.y} r="4" fill="var(--text)" stroke="var(--cool)" strokeWidth="2" />
            </>
          )}
        </svg>

        {hoverP && (
          <div style={{ ...wstyles.chartTip, left: `${(hoverP.x / WIDTH) * 100}%` }}>
            {t("min {n}", { n: hoverP.minute })} ·{" "}
            <span style={{ color: hoverP.val >= 0 ? "var(--win)" : "var(--loss)" }}>
              {hoverP.val >= 0 ? "+" : ""}{hoverP.val.toLocaleString()} {unit}
            </span>
          </div>
        )}
      </div>
    </div>
  );
};
