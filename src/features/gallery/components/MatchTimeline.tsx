import React, { useMemo, useRef, useState } from "react";
import { MatchEvent } from "../../../types";
import { individualEvents } from "../../../core/matchEvents";
import { mmss } from "../../../core/time";

/**
 * Una partida ES su línea de tiempo.
 *
 * La idea rectora del rediseño: todo lo que guarda esta app —muertes,
 * objetivos, APM— ya está anclado a un instante del juego, así que la
 * biblioteca puede enseñar esa forma directamente. Reconoces una partida por su
 * silueta (una derrota se lee como densidad de rojo) antes de leer una cifra.
 *
 * El APM va sin tinte a propósito: es contexto ambiental, no un suceso. Si
 * llevara color competiría con las marcas de eventos, que es lo que hay que
 * mirar.
 */

type Kind = "kill" | "death" | "objective" | "structure";

// Las estructuras van en turquesa apagado, no en --accent-blue: ese alias
// resuelve al mismo turquesa que --win, y torres y kills quedaban idénticas.
// Se distinguen por valor manteniendo la familia de tinte.
const KIND_COLOR: Record<Kind, string> = {
  kill: "var(--win)",
  death: "var(--loss)",
  objective: "var(--gold)",
  structure: "var(--cool-fill)",
};

// Altura relativa de cada marca. Las muertes ocupan casi todo el alto porque son
// lo que buscas al revisar; las kills, la mitad.
const KIND_TOP: Record<Kind, number> = {
  death: 0.10,
  objective: 0.34,
  structure: 0.46,
  kill: 0.46,
};

const classify = (ev: MatchEvent): Kind | null => {
  switch (ev.type) {
    case "ChampionKill":
      return ev.subtype === "death" ? "death" : "kill";
    case "FirstBlood":
      return "kill";
    case "DragonKill":
    case "BaronKill":
    case "HeraldKill":
      return ev.subtype === "enemy" ? "death" : "objective";
    case "TowerKill":
    case "InhibKill":
      return "structure";
    default:
      return null;
  }
};

/** Área suavizada del APM, en coordenadas de viewBox. */
const apmPath = (series: number[], w: number, h: number, close: boolean): string => {
  const n = series.length;
  if (n < 2) return "";
  const max = Math.max(...series, 1);
  const pt = (i: number) => {
    const x = (i / (n - 1)) * w;
    const y = h - (series[i] / max) * h * 0.82 - h * 0.08;
    return [x, y] as const;
  };
  let d = "";
  for (let i = 0; i < n; i++) {
    const [x, y] = pt(i);
    if (i === 0) {
      d += `M${x.toFixed(1)} ${y.toFixed(1)}`;
    } else {
      const [px, py] = pt(i - 1);
      const cx = (px + x) / 2;
      d += `C${cx.toFixed(1)} ${py.toFixed(1)},${cx.toFixed(1)} ${y.toFixed(1)},${x.toFixed(1)} ${y.toFixed(1)}`;
    }
  }
  if (close) d += `L${w} ${h}L0 ${h}Z`;
  return d;
};

export interface MatchTimelineProps {
  events: MatchEvent[];
  duration: number;
  apmSeries?: number[];
  height?: number;
  /** Marcas de la cámara detectadas por el analizador. */
  cameraSnaps?: number[];
}

export const MatchTimeline: React.FC<MatchTimelineProps> = ({
  events,
  duration,
  apmSeries,
  height = 34,
  cameraSnaps,
}) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scrub, setScrub] = useState<number | null>(null);

  const W = 1000;
  const H = height;
  const safeDur = duration > 0 ? duration : 1;

  const marks = useMemo(
    () =>
      // Una marca por suceso: `individualEvents` quita los que ya cuenta otro
      // (el Multikill sobre sus kills, el First Blood sobre su kill).
      individualEvents(events)
        .map((ev) => ({ ev, kind: classify(ev) }))
        .filter((m): m is { ev: MatchEvent; kind: Kind } => m.kind !== null)
        .filter((m) => m.ev.time >= 0 && m.ev.time <= safeDur),
    [events, safeDur]
  );

  const gridMinutes = useMemo(() => {
    const out: number[] = [];
    for (let t = 300; t < safeDur; t += 300) out.push(t);
    return out;
  }, [safeDur]);

  const areaD = useMemo(
    () => (apmSeries && apmSeries.length > 1 ? apmPath(apmSeries, W, H, true) : ""),
    [apmSeries, H]
  );
  const lineD = useMemo(
    () => (apmSeries && apmSeries.length > 1 ? apmPath(apmSeries, W, H, false) : ""),
    [apmSeries, H]
  );

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Sigue al cursor sin transición: el movimiento lo causa la mano del
    // usuario, así que cualquier retardo aquí se siente como lag.
    setScrub(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
  };

  return (
    <div className="mtl">
      <div
        className="mtl__plot"
        ref={wrapRef}
        style={{ height: H }}
        onMouseMove={onMove}
        onMouseLeave={() => setScrub(null)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {gridMinutes.map((t) => (
            <line
              key={t}
              x1={(t / safeDur) * W}
              y1={0}
              x2={(t / safeDur) * W}
              y2={H}
              stroke="var(--line-soft)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {areaD && <path d={areaD} fill="var(--apm-fill)" />}
          {lineD && (
            <path
              d={lineD}
              fill="none"
              stroke="var(--apm-line)"
              strokeWidth={1.25}
              vectorEffect="non-scaling-stroke"
            />
          )}

          <line
            x1={0}
            y1={H - 1}
            x2={W}
            y2={H - 1}
            stroke="var(--line)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />

          {(cameraSnaps ?? []).map((t, i) => (
            <rect
              key={`snap-${i}`}
              x={(t / safeDur) * W - 1}
              y={H - 3}
              width={2}
              height={3}
              fill="var(--flag)"
              opacity={0.75}
            />
          ))}

          {marks.map((m, i) => {
            const x = (m.ev.time / safeDur) * W;
            return (
              <line
                key={`${m.ev.time}-${i}`}
                x1={x}
                y1={H * KIND_TOP[m.kind]}
                x2={x}
                y2={H - 1}
                stroke={KIND_COLOR[m.kind]}
                strokeWidth={1.6}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </svg>

        {scrub !== null && (
          <>
            <span className="mtl__scrub" style={{ left: `${scrub * 100}%` }} />
            <span className="mtl__tip" style={{ left: `${scrub * 100}%` }}>
              {mmss(scrub * safeDur)}
            </span>
          </>
        )}
      </div>

      <div className="mtl__axis">
        <span>0:00</span>
        <span>{mmss(safeDur / 2)}</span>
        <span>{mmss(safeDur)}</span>
      </div>
    </div>
  );
};
