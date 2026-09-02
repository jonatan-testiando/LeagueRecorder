import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, FileWarning, Play, RefreshCw, Trash2 } from "lucide-react";
import { ErrorClipMetadata, deleteErrorClip } from "../../../core/tauri-ipc";
import { MatchMetadata } from "../../../types";
import { Badge } from "../../../components/ui/Badge";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { useDialog } from "../../../components/ui/DialogProvider";
import { useToast } from "../../../components/ui/Toaster";
import { useT } from "../../../core/LanguageProvider";
import { mmss } from "../../../core/time";
import { ERROR_CATEGORIES } from "../../player/components/ErrorPlayer";

import { streamUrl } from "../../../core/media";
import { useErrorClips, useMatches } from "../../../store/useAppStore";
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
 *
 * La lista sale del store compartido y no de un fetch propio: así marcar un
 * error desde el reproductor se ve aquí sin recargar la ventana.
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

/** Para ordenar: la fecha de la partida, o 0 si no se puede leer. */
const whenOf = (err: ErrorClipMetadata, match?: MatchMetadata): number => {
  const raw = match?.date ?? dateFromMatchId(err.match_id) ?? "";
  const ms = new Date(raw.replace(" ", "T")).getTime();
  return Number.isFinite(ms) ? ms : 0;
};

type Sort = "newest" | "oldest" | "longest";

const SORTS: { key: Sort; label: string }[] = [
  { key: "newest", label: "Newest" },
  { key: "oldest", label: "Oldest" },
  { key: "longest", label: "Most notes" },
];

interface ErrorsGalleryProps {
  onSelectError?: (error: ErrorClipMetadata) => void;
}

export const ErrorsGallery: React.FC<ErrorsGalleryProps> = ({ onSelectError }) => {
  // Lista compartida: la mantiene el store, así que se entera de lo que marca
  // el reproductor sin que esta pantalla vuelva a pedir nada.
  const { clips: errors, loaded, error: loadError, refresh } = useErrorClips();
  const { matches } = useMatches();
  const t = useT();
  const { showConfirm } = useDialog();
  const { toast } = useToast();
  const [category, setCategory] = useState<string>("all");
  const [sort, setSort] = useState<Sort>("newest");
  // Vídeos que el navegador no ha podido abrir (fichero movido o corrupto).
  const [broken, setBroken] = useState<Set<string>>(() => new Set());

  // Al volver a la pestaña se relee: un error marcado desde el reproductor en
  // otra pantalla, o un fichero borrado por fuera, aparecen sin recargar.
  useEffect(() => {
    const onFocus = () => { refresh().catch(console.error); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const byId = useMemo(() => {
    const map = new Map<string, MatchMetadata>();
    for (const m of matches) map.set(m.id, m);
    return map;
  }, [matches]);

  /** Categorías presentes de verdad. No se ofrece filtrar por lo que no hay. */
  const presentCategories = useMemo(() => {
    const set = new Set<string>();
    for (const e of errors) for (const ev of e.events ?? []) if (ev.category) set.add(ev.category);
    // Se enseñan en el orden canónico y las desconocidas al final.
    const known = ERROR_CATEGORIES.filter((c) => set.has(c));
    const rest = [...set].filter((c) => !ERROR_CATEGORIES.includes(c)).sort();
    return [...known, ...rest];
  }, [errors]);

  const visible = useMemo(() => {
    const list = errors.filter((e) =>
      category === "all" || (e.events ?? []).some((ev) => ev.category === category)
    );
    const sorted = [...list];
    if (sort === "longest") {
      sorted.sort((a, b) => (b.events?.length ?? 0) - (a.events?.length ?? 0));
    } else {
      const dir = sort === "newest" ? -1 : 1;
      sorted.sort((a, b) => dir * (whenOf(a, byId.get(a.match_id)) - whenOf(b, byId.get(b.match_id))));
    }
    return sorted;
  }, [errors, category, sort, byId]);

  /**
   * Borra el clip y su JSON (con la nota y los sucesos marcados dentro).
   *
   * Se refresca el store en vez de tocar una lista local: esta pantalla no
   * tiene la suya, y el reproductor de errores mira la misma.
   */
  const handleDelete = async (err: ErrorClipMetadata) => {
    const ok = await showConfirm({
      title: t("Delete flagged error"),
      message: t("This clip and the notes on it are deleted for good."),
      confirmText: t("Delete"),
      cancelText: t("Cancel"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteErrorClip(err.path);
      await refresh();
    } catch (e) {
      toast({
        title: t("Couldn't delete the clip"),
        body: String(e),
        tone: "danger",
      });
    }
  };

  const gameCount = useMemo(
    () => new Set(errors.map((e) => e.match_id)).size,
    [errors]
  );

  if (!loaded) {
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

      {/* Fallo de lectura: se dice, con salida. Enseñar "aún no has marcado
          ningún error" cuando lo que ha pasado es que no se ha podido leer el
          disco es la clase de mentira que hace desconfiar de todo lo demás. */}
      {loadError && (
        <div style={styles.notice}>
          <AlertTriangle size={14} color="var(--signal)" />
          <span style={{ flex: 1, minWidth: 0 }}>
            {t("Couldn't load your flagged errors: {msg}", { msg: loadError })}
          </span>
          <Button variant="ghost" size="sm" icon={<RefreshCw size={13} />} onClick={() => refresh()}>
            {t("Retry")}
          </Button>
        </div>
      )}

      {errors.length > 0 && (
        <div style={styles.filters}>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={category === "all"}
            onClick={() => setCategory("all")}
          >
            {t("All")}
          </Button>
          {presentCategories.map((c) => (
            <Button
              key={c}
              variant="ghost"
              size="sm"
              aria-pressed={category === c}
              onClick={() => setCategory(c)}
            >
              {t(c)}
            </Button>
          ))}
          <span style={{ flex: 1 }} />
          {SORTS.map((s) => (
            <Button
              key={s.key}
              variant="ghost"
              size="sm"
              aria-pressed={sort === s.key}
              onClick={() => setSort(s.key)}
            >
              {t(s.label)}
            </Button>
          ))}
        </div>
      )}

      {errors.length === 0 ? (
        <EmptyState
          icon={<AlertTriangle size={30} color="var(--faint)" />}
          title={t("No errors flagged yet")}
          text={t("Use the Error tool in the player to save a mistake and the lesson you took from it.")}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<AlertTriangle size={30} color="var(--faint)" />}
          title={t("No errors match this filter")}
          text={t("Try another category, or go back to All.")}
          action={
            <Button variant="ghost" size="sm" onClick={() => setCategory("all")}>
              {t("Clear filters")}
            </Button>
          }
        />
      ) : (
        <div style={styles.grid}>
          {visible.map((err) => {
            const match = byId.get(err.match_id);
            const when = match?.date ? trimSeconds(match.date) : dateFromMatchId(err.match_id);
            const first = err.events && err.events.length > 0 ? err.events[0] : null;
            const lesson = first ? first.text : err.note;
            const isBroken = broken.has(err.path);

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
                  {isBroken ? (
                    // Sin esto, un clip cuyo fichero ya no está se veía como un
                    // rectángulo negro: idéntico a uno que simplemente tarda.
                    <div style={styles.brokenVeil}>
                      <FileWarning size={22} color="var(--faint)" />
                      <span className="u-meta" style={{ textAlign: "center", padding: "0 var(--space-2)" }}>
                        {t("Video file missing")}
                      </span>
                    </div>
                  ) : (
                    <>
                      <video
                        src={streamUrl(err.path)}
                        style={styles.video}
                        preload="metadata"
                        onError={() => setBroken((prev) => new Set(prev).add(err.path))}
                      />
                      <div style={styles.thumbVeil}>
                        <Play size={26} color="var(--text)" style={{ opacity: 0.85 }} />
                      </div>
                    </>
                  )}
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
                    {/* La categoría se GUARDA en inglés (es el identificador que
                        conoce el backend) y se PINTA traducida. */}
                    {first?.category && <Badge tone="loss">{t(first.category)}</Badge>}
                    {match?.champion && (
                      <span className="u-meta" style={{ color: "var(--muted)" }}>{match.champion}</span>
                    )}
                    {when && <span className="u-meta">{when}</span>}
                    {err.events && err.events.length > 1 && (
                      <span className="u-meta">+{err.events.length - 1} {t("more")}</span>
                    )}
                    <span style={{ flex: 1 }} />
                    {/* La tarjeta entera es un botón que abre el clip, así que
                        este de dentro tiene que parar la propagación: sin eso,
                        cancelar el borrado te dejaba en el reproductor. */}
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      title={t("Delete flagged error")}
                      aria-label={t("Delete flagged error")}
                      onClick={(e) => { e.stopPropagation(); handleDelete(err); }}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <Trash2 size={13} />
                    </button>
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
  header: { marginBottom: "var(--space-4)" },
  title: { margin: 0, fontSize: "var(--font-xl)" },
  notice: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
    padding: "var(--space-3) var(--space-4)",
    marginBottom: "var(--space-4)",
    background: "color-mix(in srgb, var(--signal) 8%, var(--panel))",
    border: "1px solid color-mix(in srgb, var(--signal) 28%, transparent)",
    borderRadius: "var(--radius-md)",
    color: "var(--muted)",
    fontSize: "var(--font-xs)",
    overflowWrap: "anywhere",
  },
  filters: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    flexWrap: "wrap",
    padding: "var(--space-3) 0",
    borderTop: "1px solid var(--line-soft)",
    borderBottom: "1px solid var(--line-soft)",
    marginBottom: "var(--space-4)",
  },
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
  brokenVeil: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--space-2)",
    background: "var(--sunken)",
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
