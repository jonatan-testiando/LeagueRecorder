import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, Library, RefreshCw, Trash2 } from "lucide-react";
import { ErrorClipMetadata, deleteErrorClip } from "../../../core/tauri-ipc";
import { MatchMetadata } from "../../../types";
import { Chip } from "../../../components/ui/Chip";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Segmented } from "../../../components/ui/Segmented";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import { useDialog } from "../../../components/ui/DialogProvider";
import { useToast } from "../../../components/ui/Toaster";
import { useT } from "../../../core/LanguageProvider";
import { matchAge, mmss } from "../../../core/time";
import { ERROR_CATEGORIES } from "../../player/components/ErrorPlayer";
import { useErrorClips, useMatches } from "../../../store/useAppStore";
import { useDelayedLoading } from "../../../core/useDelayedLoading";
import { Skeleton } from "../../../components/ui/Skeleton";
import { ClipPoster } from "./ClipPoster";
import "./ClipsGallery.css";

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
  const navigate = useNavigate();
  const { showConfirm } = useDialog();
  const { toast } = useToast();
  const [category, setCategory] = useState<string>("all");
  const [sort, setSort] = useState<Sort>("newest");

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

  /** Cuántos errores hay de cada categoría, para decirlo en su píldora. */
  const countByCategory = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of errors) {
      const cats = new Set((e.events ?? []).map((ev) => ev.category).filter(Boolean) as string[]);
      for (const c of cats) map.set(c, (map.get(c) ?? 0) + 1);
    }
    return map;
  }, [errors]);

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

  const esqueleto = useDelayedLoading(!loaded);
  if (!loaded || esqueleto) {
    return (
      <div className="cg panel-enter">
        {esqueleto && (
          <div className="page-skel" role="status" aria-busy="true" aria-label={t("Loading…")}>
            <Skeleton width={180} height={28} />
            <Skeleton shape="block" width={300} height={34} className="cg-skel__seg" />
            {[0, 1, 2].map((i) => <Skeleton key={i} shape="block" height={168} />)}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="cg panel-enter">
      <div className="cg__head">
        <h1>{t("Errors")}</h1>
        {errors.length > 0 && (
          <span className="cg__count">
            {errors.length === 1
              ? t("1 error flagged")
              : gameCount === 1
                ? t("{n} flagged in 1 game", { n: errors.length })
                : t("{n} flagged across {m} games", { n: errors.length, m: gameCount })}
          </span>
        )}
      </div>

      {/* Fallo de lectura: se dice, con salida. Enseñar "aún no has marcado
          ningún error" cuando lo que ha pasado es que no se ha podido leer el
          disco es la clase de mentira que hace desconfiar de todo lo demás. */}
      {loadError && (
        <div className="cg-notice">
          <AlertTriangle size={15} color="var(--signal)" />
          <span className="cg-notice__text">
            {t("Couldn't load your flagged errors: {msg}", { msg: loadError })}
          </span>
          <Button variant="ghost" size="sm" icon={<RefreshCw size={13} />} onClick={() => refresh()}>
            {t("Retry")}
          </Button>
        </div>
      )}

      {errors.length > 0 && (
        <div className="cg__tools">
          <Segmented
            label={t("Filter by category")}
            value={category}
            onChange={setCategory}
            options={[
              { value: "all", label: t("All"), count: errors.length },
              ...presentCategories.map((c) => ({ value: c, label: t(c), count: countByCategory.get(c) ?? 0 })),
            ]}
          />
          <span className="cg__spacer" />
          <span className="cg__toolLabel">{t("Sort")}</span>
          <Segmented
            label={t("Sort")}
            value={sort}
            onChange={setSort}
            options={SORTS.map((s) => ({ value: s.key, label: t(s.label) }))}
          />
        </div>
      )}

      {errors.length === 0 ? (
        <div className="cg-center">
          <EmptyState
            icon={<AlertTriangle size={30} color="var(--faint)" />}
            title={t("No errors flagged yet")}
            text={t("When something goes wrong in a game, flag it from the player with the lesson you took. It waits here for your next review.")}
            action={
              <Button variant="primary" size="md" icon={<Library size={15} />} onClick={() => navigate("/review")}>
                {t("Go to the Library")}
              </Button>
            }
          />
        </div>
      ) : visible.length === 0 ? (
        <div className="cg-center">
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
        </div>
      ) : (
        <div className="cg__list cg__list--flow">
          {visible.map((err, i) => {
            const match = byId.get(err.match_id);
            const whenIso = match?.date ?? dateFromMatchId(err.match_id);
            const when = whenIso ? matchAge(whenIso, t) : null;
            const first = err.events && err.events.length > 0 ? err.events[0] : null;
            const lesson = first ? first.text : err.note;
            const extra = (err.events?.length ?? 0) - 1;
            const at = err.start_time !== undefined && err.start_time !== null
              ? t("at {t} in the game", { t: mmss(err.start_time) })
              : null;
            const open = () => onSelectError?.(err);

            return (
              // El control de verdad es el play del póster (con foco y nombre);
              // el clic en el resto de la fila es un atajo para el ratón. Antes
              // la fila era un role=button con el botón de borrar DENTRO: un
              // control dentro de otro, que el lector de pantalla no separa.
              <div
                key={err.path}
                className="cg-row cg-row--open"
                {...(i === visible.length - 1 ? { "data-nodivider": true } : {})}
                onClick={open}
              >
                <ClipPoster
                  path={err.path}
                  label={`${t("Play")}: ${lesson || t("Flagged error")}`}
                  onOpen={open}
                  openWhenMissing
                />

                <div className="cg-body">
                  <div className="cg-top">
                    <div className="cg-top__text">
                      {/* La lección es lo que se viene a leer aquí, así que es
                          el titular de la fila. */}
                      {lesson ? (
                        <p className="cg-title cg-title--wrap">{lesson}</p>
                      ) : (
                        <p className="cg-title cg-title--empty">{t("No note yet — open it to write what you learned.")}</p>
                      )}
                      {/* El minuto de la partida iba en una esquina de la
                          miniatura; esa esquina es ahora la duración del clip,
                          como en Clips, y el minuto se dice en la línea. */}
                      {(match?.champion || when || at) && (
                        <span className="cg-meta">
                          {match?.champion && <ChampionAvatar champion={match.champion} size={20} />}
                          <span>
                            {[match?.champion, when, at].filter(Boolean).join(" · ")}
                          </span>
                        </span>
                      )}
                    </div>
                    {/* Para la propagación: sin eso, cancelar el borrado te
                        dejaba en el reproductor. */}
                    <Button
                      variant="icon"
                      size="sm"
                      icon={<Trash2 size={15} />}
                      title={t("Delete flagged error")}
                      aria-label={t("Delete flagged error")}
                      onClick={(e) => { e.stopPropagation(); handleDelete(err); }}
                    />
                  </div>

                  <div className="cg-chips">
                    {/* La categoría se GUARDA en inglés (es el identificador que
                        conoce el backend) y se PINTA traducida. */}
                    {first?.category && <Chip tone="loss">{t(first.category)}</Chip>}
                    {extra > 0 && (
                      <Chip tone="neutral">
                        {extra === 1 ? t("1 more note") : t("{n} more notes", { n: extra })}
                      </Chip>
                    )}
                    {err.reviewed && <Chip tone="win">{t("Checked")}</Chip>}
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
