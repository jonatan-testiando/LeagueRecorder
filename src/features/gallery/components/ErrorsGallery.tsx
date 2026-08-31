import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Play } from "lucide-react";
import { ErrorClipMetadata, getAllErrorClips, getRecordedMatches } from "../../../core/tauri-ipc";
import { MatchMetadata } from "../../../types";
import { Badge } from "../../../components/ui/Badge";
import { EmptyState } from "../../../components/ui/EmptyState";
import { useT } from "../../../core/LanguageProvider";
import { mmss } from "../../../core/time";

import { streamUrl } from "../../../core/media";
/**
 * Los errores marcados.
 *
 * Esta pantalla era un explorador de ficheros: lo más prominente era el id de la
 * partida (`match_20260813_022120`, que es un nombre de archivo) y el tamaño en
 * MB, mientras que la nota —que es la lección, el motivo entero de guardar el
 * clip— iba enterrada como texto de cuerpo.
 *
 * Ahora manda la nota, y el contexto de la partida se resuelve a algo legible:
 * campeón, fecha y el minuto en que ocurrió.
 */

/** Quita los segundos: "2026-08-13 02:21:20" → "2026-08-13 02:21". */
const trimSeconds = (d: string): string =>
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(d) ? d.slice(0, 16) : d;

/** `match_20260813_022120` → `2026-08-13 02:21`. */
const dateFromMatchId = (id: string): string | null => {
  const m = /^match_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})/.exec(id);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
};

interface ErrorsGalleryProps {
  onSelectError?: (error: ErrorClipMetadata) => void;
}

export const ErrorsGallery: React.FC<ErrorsGalleryProps> = ({ onSelectError }) => {
  const [errors, setErrors] = useState<ErrorClipMetadata[]>([]);
  const [matches, setMatches] = useState<MatchMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const t = useT();

  // Antes había dos `useEffect` idénticos, así que la lista se pedía dos veces
  // en cada montaje.
  useEffect(() => {
    let alive = true;
    Promise.all([getAllErrorClips(), getRecordedMatches().catch(() => [])])
      .then(([errs, ms]) => {
        if (!alive) return;
        setErrors(errs);
        setMatches(ms);
      })
      .catch(console.error)
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  const byId = useMemo(() => {
    const map = new Map<string, MatchMetadata>();
    for (const m of matches) map.set(m.id, m);
    return map;
  }, [matches]);

  const gameCount = useMemo(
    () => new Set(errors.map((e) => e.match_id)).size,
    [errors]
  );

  if (loading) {
    return (
      <div style={styles.container} className="panel-enter">
        <div style={styles.center}>
          <div className="spinner" />
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container} className="panel-enter">
      <div style={styles.header}>
        <h1 style={styles.title}>{t("Errors")}</h1>
        {errors.length > 0 && (
          <div className="u-meta" style={{ marginTop: 4 }}>
            {errors.length} {t("flagged")} · {t("across")} {gameCount} {t(gameCount === 1 ? "game" : "games")}
          </div>
        )}
      </div>

      {errors.length === 0 ? (
        <EmptyState
          icon={<AlertTriangle size={30} color="var(--faint)" />}
          title={t("No errors flagged yet")}
          text={t("Use the Error tool in the player to save a mistake and the lesson you took from it.")}
        />
      ) : (
        <div style={styles.grid}>
          {errors.map((err) => {
            const match = byId.get(err.match_id);
            const when = match?.date ? trimSeconds(match.date) : dateFromMatchId(err.match_id);
            const first = err.events && err.events.length > 0 ? err.events[0] : null;
            const lesson = first ? first.text : err.note;

            return (
              <div
                key={err.path}
                className="card card--interactive"
                style={styles.card}
                role="button"
                tabIndex={0}
                onClick={() => onSelectError?.(err)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelectError?.(err); }
                }}
              >
                <div style={styles.thumb}>
                  <video src={streamUrl(err.path)} style={styles.video} preload="metadata" />
                  <div style={styles.thumbVeil}>
                    <Play size={26} color="var(--text)" style={{ opacity: 0.85 }} />
                  </div>
                  {err.start_time !== undefined && err.start_time !== null && (
                    <span style={styles.stamp}>{mmss(err.start_time)}</span>
                  )}
                </div>

                <div style={styles.body}>
                  {/* La lección es lo que se viene a leer aquí, así que va primero
                      y con el peso del texto principal. */}
                  {lesson ? (
                    <p style={styles.lesson}>{lesson}</p>
                  ) : (
                    <p style={styles.lessonEmpty}>{t("No note yet — open it to write what you learned.")}</p>
                  )}

                  <div style={styles.meta}>
                    {first?.category && <Badge tone="loss">{first.category}</Badge>}
                    {match?.champion && (
                      <span className="u-meta" style={{ color: "var(--muted)" }}>{match.champion}</span>
                    )}
                    {when && <span className="u-meta">{when}</span>}
                    {err.events && err.events.length > 1 && (
                      <span className="u-meta">+{err.events.length - 1} {t("more")}</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: "var(--space-6) var(--space-8)",
    height: "100%",
    boxSizing: "border-box",
    overflowY: "auto",
    background: "transparent",
  },
  center: { display: "grid", placeItems: "center", height: "100%" },
  header: { marginBottom: "var(--space-5)" },
  title: { margin: 0, fontSize: "var(--font-xl)" },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(540px, 1fr))",
    gap: "var(--space-3)",
  },
  /* Fila horizontal: la miniatura es el índice, el texto es la fila. */
  card: {
    overflow: "hidden",
    display: "grid",
    gridTemplateColumns: "224px 1fr",
    height: 168,
    padding: 0,
    background: "var(--media-sheen)",
  },
  thumb: {
    width: "100%",
    height: "100%",
    backgroundColor: "var(--sunken)",
    position: "relative",
    borderRight: "1px solid var(--line-soft)",
  },
  video: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  thumbVeil: {
    position: "absolute",
    inset: 0,
    display: "grid",
    placeItems: "center",
    background: "color-mix(in srgb, var(--sunken) 35%, transparent)",
  },
  stamp: {
    position: "absolute",
    right: "var(--space-2)",
    bottom: "var(--space-2)",
    fontFamily: "var(--font-mono)",
    fontSize: "10px",
    color: "var(--text)",
    background: "color-mix(in srgb, var(--sunken) 82%, transparent)",
    border: "1px solid var(--line-soft)",
    padding: "1px 6px",
    borderRadius: "var(--radius-sm)",
    fontVariantNumeric: "tabular-nums",
  },
  body: {
    padding: "var(--space-3) var(--space-4)",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    gap: "var(--space-2)",
    minWidth: 0,
  },
  lesson: {
    margin: 0,
    fontSize: "var(--font-sm)",
    lineHeight: 1.5,
    color: "var(--text)",
    display: "-webkit-box",
    WebkitBoxOrient: "vertical",
    WebkitLineClamp: 3,
    overflow: "hidden",
  },
  lessonEmpty: {
    margin: 0,
    fontSize: "var(--font-xs)",
    lineHeight: 1.5,
    color: "var(--faint)",
  },
  meta: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    flexWrap: "wrap",
  },
};
