import React, { useMemo, useState } from "react";
import { MatchMetadata } from "../../../types";
import { describeEvent } from "../../../core/eventText";
import { eventMeta, type Tone } from "./eventMeta";
import { setEventReviewed } from "../../../core/tauri-ipc";

/**
 * La barra lateral como cola de trabajo, no como marcador.
 *
 * Revisar una partida es una tarea con final: hay N momentos que mirar y los vas
 * tachando. Antes la pantalla no tenía esa noción, así que no había forma de
 * saber por dónde ibas ni cuándo habías acabado — la diferencia entre un panel y
 * una herramienta.
 *
 * No hace falta ningún dato nuevo: la gravedad sale del `tone` que ya calcula
 * `eventMeta`, y los momentos de `events[]` más `camera_snaps`.
 */

type Severity = "high" | "med" | "low";

const SEVERITY_OF: Partial<Record<Tone, Severity>> = {
  throw: "high",
  mistake: "high",
  inaccuracy: "med",
};

const SEV_COLOR: Record<Severity, string> = {
  high: "var(--loss)",
  med: "var(--gold)",
  low: "var(--faint)",
};

const SEV_ORDER: Record<Severity, number> = { high: 0, med: 1, low: 2 };

export interface Moment {
  time: number;
  severity: Severity;
  title: string;
  note?: string;
  reviewed: boolean;
}

const fmt = (s: number) => {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r < 10 ? "0" : ""}${r}`;
};

/**
 * De todos los sucesos, los que merecen una mirada. Un volcado cronológico de
 * los 46 eventos no es una cola de trabajo: 19 de ellos son ultimates.
 */
export function buildQueue(match: MatchMetadata): Moment[] {
  const out: Moment[] = [];

  for (const ev of match.events) {
    const meta = eventMeta(ev);
    const sev = SEVERITY_OF[meta.tone];
    if (!sev) continue;
    out.push({
      time: ev.time,
      severity: sev,
      title: describeEvent(ev),
      note: meta.label,
      reviewed: ev.reviewed === true,
    });
  }

  // Los saltos de cámara no son sucesos de partida, pero sí momentos que revisar:
  // un hueco largo sin mover la cámara es exactamente lo que buscas al repasar.
  for (const t of match.camera_snaps ?? []) {
    if (out.some((m) => Math.abs(m.time - t) < 4)) continue;
    out.push({
      time: t,
      severity: "low",
      title: "Camera jump",
      note: "detected by the analyzer",
      reviewed: false,
    });
  }

  return out.sort((a, b) => a.time - b.time);
}

export interface ReviewQueueProps {
  matchId: string;
  moments: Moment[];
  currentTime: number;
  onSeek: (seconds: number) => void;
  onChange: (moments: Moment[]) => void;
}

export const ReviewQueue: React.FC<ReviewQueueProps> = ({
  matchId,
  moments,
  currentTime,
  onSeek,
  onChange,
}) => {
  const [showAll, setShowAll] = useState(false);

  const done = moments.filter((m) => m.reviewed).length;
  const total = moments.length;

  // Por gravedad y no por reloj: el reloj ya lo da la tira bajo el vídeo. Los
  // vistos caen al fondo para que la cola sea siempre lo pendiente.
  const ordered = useMemo(() => {
    const list = showAll ? moments : moments.filter((m) => !m.reviewed);
    return [...list].sort((a, b) => {
      if (a.reviewed !== b.reviewed) return a.reviewed ? 1 : -1;
      if (SEV_ORDER[a.severity] !== SEV_ORDER[b.severity]) {
        return SEV_ORDER[a.severity] - SEV_ORDER[b.severity];
      }
      return a.time - b.time;
    });
  }, [moments, showAll]);

  const toggle = (m: Moment) => {
    const next = moments.map((x) =>
      x.time === m.time ? { ...x, reviewed: !x.reviewed } : x
    );
    onChange(next);
    // Si el guardado falla, se revierte: mejor que la casilla mienta sobre lo
    // que hay en disco.
    setEventReviewed(matchId, m.time, !m.reviewed).catch((err) => {
      console.error("No se pudo guardar el estado de revisión:", err);
      onChange(moments);
    });
  };

  if (total === 0) {
    return (
      <div style={styles.empty}>
        <p className="empty-state__title" style={{ fontSize: "var(--font-sm)" }}>
          Nothing flagged
        </p>
        <p className="empty-state__text" style={{ fontSize: "var(--font-xs)" }}>
          No deaths or detected mistakes in this game.
        </p>
      </div>
    );
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.progress}>
        <div style={styles.progressTop}>
          <span className="u-label">Review</span>
          <span className="u-metric" style={{ fontSize: 12 }}>
            {done} / {total}
          </span>
        </div>
        <div style={styles.bar}>
          {moments.map((m, i) => (
            <span
              key={`${m.time}-${i}`}
              style={{
                flex: 1,
                height: "100%",
                background: m.reviewed ? "var(--cool)" : "var(--sunken)",
              }}
            />
          ))}
        </div>
      </div>

      <div style={styles.filters}>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          aria-pressed={!showAll}
          onClick={() => setShowAll(false)}
        >
          To review
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          aria-pressed={showAll}
          onClick={() => setShowAll(true)}
        >
          All ({total})
        </button>
      </div>

      <div style={styles.list}>
        {ordered.length === 0 ? (
          <div style={styles.empty}>
            <p className="empty-state__title" style={{ fontSize: "var(--font-sm)" }}>
              All reviewed
            </p>
            <p className="empty-state__text" style={{ fontSize: "var(--font-xs)" }}>
              You went through every flagged moment in this game.
            </p>
          </div>
        ) : (
          ordered.map((m, i) => {
            const active = Math.abs(currentTime - m.time) < 3;
            return (
              <div
                key={`${m.time}-${i}`}
                className="rq-item"
                data-sel={active ? "" : undefined}
                data-done={m.reviewed ? "" : undefined}
                role="button"
                tabIndex={0}
                onClick={() => onSeek(m.time)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSeek(m.time); }
                }}
              >
                <span className="rq-sev" style={{ background: SEV_COLOR[m.severity] }} />
                <span className="rq-time">{fmt(m.time)}</span>
                <span style={{ minWidth: 0 }}>
                  <span className="rq-title">{m.title}</span>
                  {m.note && <span className="rq-note">{m.note}</span>}
                </span>
                <span
                  className="rq-done"
                  role="checkbox"
                  aria-checked={m.reviewed}
                  aria-label={m.reviewed ? "Mark as not reviewed" : "Mark as reviewed"}
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); toggle(m); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); toggle(m); }
                  }}
                />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  wrap: { display: "flex", flexDirection: "column", minHeight: 0, flex: 1 },
  progress: {
    padding: "var(--space-3) var(--space-4)",
    borderBottom: "1px solid var(--line-soft)",
  },
  progressTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: "var(--space-2)",
  },
  bar: {
    height: "3px",
    display: "flex",
    gap: "2px",
    background: "var(--sunken)",
    borderRadius: "2px",
    overflow: "hidden",
  },
  filters: {
    display: "flex",
    gap: "var(--space-2)",
    padding: "var(--space-3) var(--space-4) var(--space-2)",
  },
  list: { flex: 1, minHeight: 0, overflowY: "auto" },
  empty: { padding: "var(--space-6) var(--space-4)", textAlign: "center" },
};
