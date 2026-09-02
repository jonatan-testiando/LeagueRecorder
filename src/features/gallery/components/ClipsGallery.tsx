import React, { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { useNavigate } from "react-router-dom";
import {
  Film, UploadCloud, Check, Copy, ExternalLink, Clock, RotateCcw, Heart,
  FolderOpen, PlaySquare, Trash2,
} from "lucide-react";
import { motion } from "framer-motion";
import { ClipMetadata, MatchMetadata } from "../../../types";
import { deleteClip, toggleClipFavorite, type UploadProgress } from "../../../core/tauri-ipc";
import { useDialog } from "../../../components/ui/DialogProvider";
import { useToast } from "../../../components/ui/Toaster";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { useT } from "../../../core/LanguageProvider";
import { streamUrl } from "../../../core/media";
import { useAppStore, useMatches } from "../../../store/useAppStore";

/**
 * Límites de los servicios de subida, en un solo sitio.
 *
 * Estaban repartidos entre dos constantes y una frase escrita a mano ("200 MB
 * (permanent)"), así que cambiar uno de los dos números obligaba a acordarse
 * del tercero. Los valores son los de catbox y litterbox: el enlace permanente
 * admite menos que el temporal, que es lo contrario de lo que se espera y por
 * eso el aviso propone cambiar de opción en vez de solo decir que no cabe.
 */
const UPLOAD_LIMITS = {
  /** catbox.moe: enlace permanente, 200 MB. */
  permanent: 200 * 1024 * 1024,
  /** litterbox: enlace temporal (máx. 72 h), 1 GB. */
  temporary: 1024 * 1024 * 1024,
} as const;

const LIMIT_LABEL = {
  permanent: "200 MB",
  temporary: "1 GB",
} as const;

// "permanent" -> catbox.moe (enlace permanente). El resto -> litterbox (temporal, máx. 72 h).
const EXPIRY_OPTIONS = [
  { value: "72h", label: "Temporary · 72 h" },
  { value: "24h", label: "Temporary · 24 h" },
  { value: "12h", label: "Temporary · 12 h" },
  { value: "1h", label: "Temporary · 1 h" },
  { value: "permanent", label: "Permanent" },
];

const DURATION_MS: Record<string, number> = {
  "1h": 3600e3,
  "12h": 12 * 3600e3,
  "24h": 24 * 3600e3,
  "72h": 72 * 3600e3,
};

// Enlace subido, persistido en localStorage para que sobreviva a recargas de la app.
interface StoredLink {
  url: string;
  expiry: string;
  uploadedAt: number; // ms epoch
}

const LS_KEY = "clipLinks";

// Medidas del grid. Están aquí y no solo en el CSS porque el virtualizador necesita
// calcular a mano cuántas columnas caben.
const GRID_GAP = 12;
// Ancho mínimo de la tarjeta HORIZONTAL: 2 por hilera en un portátil, 3 en un
// monitor ancho.
const CARD_MIN_WIDTH = 540;

type Sort = "newest" | "oldest" | "largest" | "smallest";

const SORTS: { key: Sort; label: string }[] = [
  { key: "newest", label: "Newest" },
  { key: "oldest", label: "Oldest" },
  { key: "largest", label: "Largest" },
  { key: "smallest", label: "Smallest" },
];

const expiresAt = (l: StoredLink): number =>
  l.expiry === "permanent" ? Infinity : l.uploadedAt + (DURATION_MS[l.expiry] ?? 0);

// Carga los enlaces guardados, descartando los temporales que ya expiraron.
const loadStoredLinks = (): Record<string, StoredLink> => {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed: Record<string, StoredLink> = JSON.parse(raw);
    const now = Date.now();
    const pruned: Record<string, StoredLink> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (expiresAt(v) > now) pruned[k] = v;
    }
    return pruned;
  } catch {
    return {};
  }
};

const formatSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
};

/**
 * `match_20260813_022120` → milisegundos. Es lo único que fecha un clip: el
 * backend no guarda cuándo se recortó, solo de qué partida salió.
 */
const clipTime = (matchId: string): number => {
  const m = /^match_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(matchId);
  if (!m) return 0;
  return new Date(
    `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`
  ).getTime() || 0;
};

export const ClipsGallery: React.FC = () => {
  const [clips, setClips] = useState<ClipMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const t = useT();
  const navigate = useNavigate();
  const [uploading, setUploading] = useState<string | null>(null);
  // Segundos que lleva la subida en curso. Sigue haciendo falta: el primer
  // aviso de progreso puede tardar (el backend abre la conexión antes de
  // empezar a mandar bytes), y hasta que llegue lo honesto es una barra
  // indeterminada con el tiempo transcurrido debajo.
  const [uploadElapsed, setUploadElapsed] = useState(0);
  // Bytes ya enviados del clip en curso, según el evento `clip_upload_progress`.
  // null = todavía no ha llegado ninguno.
  const [uploadProg, setUploadProg] = useState<UploadProgress | null>(null);
  const [links, setLinks] = useState<Record<string, StoredLink>>(() => loadStoredLinks());
  const { showSuccess, showError, showConfirm } = useDialog();
  const { toast } = useToast();
  const [expiry, setExpiry] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [sort, setSort] = useState<Sort>("newest");

  // La biblioteca, para poder decir de qué partida salió cada clip con algo que
  // se pueda leer (campeón y fecha) en vez del id de la carpeta.
  const { matches } = useMatches();
  const setSelectedMatch = useAppStore((s) => s.setSelectedMatch);

  // OJO: todos los hooks van aquí arriba, antes de los `return` de "cargando" y
  // "sin clips". Declararlos después haría que el número de hooks cambiara entre
  // renders y React abortaría con "Rendered more hooks than during the previous render".
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(2);

  const matchById = useMemo(() => {
    const map = new Map<string, MatchMetadata>();
    for (const m of matches) map.set(m.id, m);
    return map;
  }, [matches]);

  const visible = useMemo(() => {
    const list = onlyFavorites ? clips.filter((c) => c.favorite) : clips;
    const out = [...list];
    switch (sort) {
      case "largest": out.sort((a, b) => b.size - a.size); break;
      case "smallest": out.sort((a, b) => a.size - b.size); break;
      case "oldest": out.sort((a, b) => clipTime(a.match_id) - clipTime(b.match_id)); break;
      default: out.sort((a, b) => clipTime(b.match_id) - clipTime(a.match_id)); break;
    }
    return out;
  }, [clips, onlyFavorites, sort]);

  // Cuántas tarjetas caben por fila. Replica a mano lo que hacía
  // `grid-template-columns: repeat(auto-fill, minmax(CARD_MIN_WIDTH, 1fr))`,
  // porque el virtualizador necesita saber el número de columnas para agrupar.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let anchoPrevio = 0;
    const medir = () => {
      const w = el.clientWidth;
      setColumns(Math.max(1, Math.floor((w + GRID_GAP) / (CARD_MIN_WIDTH + GRID_GAP))));
      // Mismo bug que la biblioteca: la ruta se oculta con display:none sin
      // desmontarse y el virtualizador cachea medidas a 0. Al reaparecer, se
      // remide — y los elementos que siguieron montados se remiden a mano,
      // porque measure() solo limpia la caché y su observer interno ya disparó.
      if (anchoPrevio === 0 && w > 0) {
        rowVirtualizer.measure();
        requestAnimationFrame(() => {
          el.querySelectorAll("[data-index]").forEach((n) =>
            rowVirtualizer.measureElement(n as HTMLElement)
          );
        });
      }
      anchoPrevio = w;
    };
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading, clips.length]);

  const rowCount = Math.ceil(visible.length / columns);
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    // Estimación inicial; la altura real de cada fila se mide con `measureElement`,
    // porque la tarjeta cambia de alto según el estado (selector de caducidad, fila
    // de enlace ya subido, aviso de tamaño excedido...).
    estimateSize: () => 380,
    overscan: 3,
  });

  // Al cambiar el número de columnas, cada índice de fila pasa a contener otras
  // tarjetas: las alturas medidas antes ya no valen. Igual al reordenar o filtrar.
  useEffect(() => {
    rowVirtualizer.measure();
  }, [columns, sort, onlyFavorites, rowVirtualizer]);

  // Persistir los enlaces cada vez que cambian para que sobrevivan a recargas.
  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify(links));
  }, [links]);

  /**
   * Progreso real de la subida en curso.
   *
   * Se filtra por ruta porque el evento es global y puede haber más de una
   * subida viva; `total` viaja en cada aviso, así que entrar a mitad basta
   * para pintar el porcentaje.
   */
  useEffect(() => {
    if (!uploading) { setUploadProg(null); return; }
    let vivo = true;
    let quitar: (() => void) | null = null;
    listen<UploadProgress>("clip_upload_progress", (e) => {
      if (e.payload && e.payload.path === uploading) setUploadProg(e.payload);
    })
      .then((f) => { if (vivo) quitar = f; else f(); })
      .catch(console.error);
    return () => {
      vivo = false;
      if (quitar) quitar();
      setUploadProg(null);
    };
  }, [uploading]);

  // Cronómetro de la subida en curso.
  useEffect(() => {
    if (!uploading) { setUploadElapsed(0); return; }
    const t0 = Date.now();
    const id = setInterval(() => setUploadElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, [uploading]);

  const fetchClips = async () => {
    try {
      const result = await invoke<ClipMetadata[]>("get_all_clips");
      setClips(result);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchClips();
  }, []);

  const copyLink = async (link: string) => {
    await navigator.clipboard.writeText(link);
    setCopied(link);
    setTimeout(() => setCopied(c => (c === link ? null : c)), 1500);
  };

  const handleUpload = async (clip: ClipMetadata) => {
    const exp = expiry[clip.path] ?? "72h";
    setUploading(clip.path);
    try {
      const url = await invoke<string>("upload_clip", { path: clip.path, expiry: exp });
      setLinks(prev => ({ ...prev, [clip.path]: { url, expiry: exp, uploadedAt: Date.now() } }));
      showSuccess(t("Clip uploaded. The link is on your clipboard."));
      await copyLink(url);
    } catch (e) {
      console.error(e);
      showError(t("Couldn't upload the clip: {msg}", { msg: String(e) }));
    } finally {
      setUploading(null);
    }
  };

  const clearLink = (path: string) => {
    setLinks(prev => {
      const next = { ...prev };
      delete next[path];
      return next;
    });
  };

  const handleToggleFavorite = async (clipPath: string) => {
    try {
      const isFav = await toggleClipFavorite(clipPath);
      setClips(clips.map(c => c.path === clipPath ? { ...c, favorite: isFav } : c));
    } catch (err) {
      showError(t("Couldn't change the favourite: {msg}", { msg: String(err) }));
    }
  };

  /**
   * Borra el recorte del disco.
   *
   * Se pide confirmación porque no hay papelera: el backend borra el .mp4 y su
   * JSON de al lado. El enlace guardado se olvida a la vez — dejarlo apuntando
   * a un fichero que ya no está era ofrecer "Re-subir" de algo inexistente.
   */
  const handleDelete = async (clip: ClipMetadata) => {
    const ok = await showConfirm({
      title: t("Delete clip"),
      message: t("This clip is deleted for good. The game it came from is not touched."),
      confirmText: t("Delete"),
      cancelText: t("Cancel"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteClip(clip.path);
      setClips((prev) => prev.filter((c) => c.path !== clip.path));
      clearLink(clip.path);
    } catch (e) {
      toast({
        title: t("Couldn't delete the clip"),
        body: String(e),
        tone: "danger",
      });
    }
  };

  const handleReveal = async (clip: ClipMetadata) => {
    try {
      await revealItemInDir(clip.path);
    } catch (err) {
      showError(t("Couldn't open the folder: {msg}", { msg: String(err) }));
    }
  };

  /** Abre la partida de origen en el reproductor, igual que hace la biblioteca. */
  const openMatch = (match: MatchMetadata) => {
    setSelectedMatch(match);
    navigate("/review");
  };

  const formatRemaining = (ms: number): string => {
    const h = Math.floor(ms / 3600e3);
    if (h >= 1) return t("Expires in ~{h} h", { h });
    const m = Math.max(1, Math.floor(ms / 60e3));
    return t("Expires in ~{m} min", { m });
  };

  if (loading) {
    return (
      <div style={styles.container} className="panel-enter">
        <div style={styles.emptyState}>
          <div className="spinner" />
        </div>
      </div>
    );
  }

  if (clips.length === 0) {
    return (
      <div style={styles.container} className="panel-enter">
        <div style={styles.header}>
          <h1 style={styles.title}>{t("Clips")}</h1>
        </div>
        <EmptyState
          icon={<Film size={30} color="var(--faint)" />}
          title={t("No clips yet")}
          // Palabra por palabra la clave del diccionario: la frase de antes se
          // le parecía pero no era la misma, así que en español salía en inglés.
          text={t("Use the clipping tool in the player to create clips of your best moments.")}
        />
      </div>
    );
  }

  return (
    <div style={styles.container} className="panel-enter">
      <div style={styles.header}>
        <h1 style={styles.title}>{t("Clips")}</h1>
        <div className="u-meta">
          {clips.length} {t(clips.length === 1 ? "clip" : "clips")}
        </div>
      </div>

      <div style={styles.tools}>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={onlyFavorites}
          icon={<Heart size={13} fill={onlyFavorites ? "currentColor" : "transparent"} />}
          onClick={() => setOnlyFavorites((v) => !v)}
        >
          {t("Favourites")}
        </Button>
        <span style={{ flex: 1 }} />
        <span className="u-label" style={{ marginRight: 2 }}>{t("Sort")}</span>
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

      {visible.length === 0 ? (
        <EmptyState
          icon={<Heart size={30} color="var(--faint)" />}
          title={t("No favourite clips yet")}
          text={t("Mark a clip with the heart and it shows up here.")}
          action={
            <Button variant="ghost" size="sm" onClick={() => setOnlyFavorites(false)}>
              {t("Clear filters")}
            </Button>
          }
        />
      ) : (
      /* El scroll vive aquí y no en el contenedor: el virtualizador posiciona los
         items relativos a este div, así que si el elemento con scroll fuera el de
         fuera, la cabecera desplazaría todas las filas. */
      <div style={styles.scrollArea} ref={scrollRef}>
      <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}>
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const startIndex = virtualRow.index * columns;
          const rowClips = visible.slice(startIndex, startIndex + columns);

          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={rowVirtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                // Sin `height`: la mide `measureElement`. El hueco entre filas se
                // hace con padding para que entre en esa medida.
                paddingBottom: `${GRID_GAP}px`,
                transform: `translateY(${virtualRow.start}px)`,
                display: "grid",
                gridTemplateColumns: `repeat(${columns}, 1fr)`,
                gap: `${GRID_GAP}px`,
              }}
            >
              {rowClips.map((clip) => {
                const stored = links[clip.path];
                const isUploading = uploading === clip.path;
                const exp = expiry[clip.path] ?? "72h";
                const isPermanent = exp === "permanent";
                const kind = isPermanent ? "permanent" : "temporary";
                const tooBig = clip.size > UPLOAD_LIMITS[kind];
                const remaining = stored ? expiresAt(stored) - Date.now() : 0;
                const match = matchById.get(clip.match_id);

                return (
                  <motion.div
                    key={clip.path}
                    style={styles.card}
                    whileHover={{ scale: 1.005 }}
                  >
                    <div style={styles.thumbnailWrapper}>
                      <video
                        src={streamUrl(clip.path)}
                        style={styles.videoPreview}
                        controls
                        preload="metadata"
                      />
                    </div>
                    <div style={styles.cardInfo}>
                      <div style={styles.nameRow}>
                        <span style={styles.clipName} title={clip.name}>{clip.name}</span>
                        <button
                          onClick={() => handleToggleFavorite(clip.path)}
                          style={{ ...styles.iconBtn, background: "transparent", color: clip.favorite ? "var(--flag)" : "var(--faint)" }}
                          title={t(clip.favorite ? "Remove from favourites" : "Add to favourites")}
                          aria-label={t(clip.favorite ? "Remove from favourites" : "Add to favourites")}
                        >
                          <Heart size={16} fill={clip.favorite ? "var(--flag)" : "transparent"} />
                        </button>
                      </div>
                      <div style={styles.metaRow}>
                        {/* Era "De: match_20260813_022120", o sea el nombre de la
                            carpeta. Lo que ubica un clip es de qué partida salió. */}
                        <span style={styles.clipMatch} title={clip.match_id}>
                          {match
                            ? t("From {champion} · {date}", { champion: match.champion, date: match.date })
                            : t("From {id}", { id: clip.match_id })}
                        </span>
                        <span style={styles.sizeBadge}>{formatSize(clip.size)}</span>
                      </div>

                      <div style={styles.rowActions}>
                        {match && (
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={<PlaySquare size={13} />}
                            onClick={() => openMatch(match)}
                            title={t("Open the game this clip came from")}
                          >
                            {t("Open match")}
                          </Button>
                        )}
                        <Button
                          variant="icon"
                          size="sm"
                          icon={<FolderOpen size={14} />}
                          title={t("Reveal in folder")}
                          aria-label={t("Reveal in folder")}
                          onClick={() => handleReveal(clip)}
                        />
                        <Button
                          variant="icon"
                          size="sm"
                          icon={<Trash2 size={14} />}
                          title={t("Delete clip")}
                          aria-label={t("Delete clip")}
                          onClick={() => handleDelete(clip)}
                        />
                      </div>

                      <div style={styles.actions}>
                        {stored ? (
                          <>
                            <div style={styles.linkRow}>
                              <input
                                readOnly
                                value={stored.url}
                                style={styles.linkInput}
                                aria-label={t("Share link")}
                                onFocus={(e) => e.target.select()}
                              />
                              <button
                                onClick={() => copyLink(stored.url)}
                                style={styles.iconBtn}
                                title={t("Copy link")}
                                aria-label={t("Copy link")}
                              >
                                {copied === stored.url ? <Check size={14} color="var(--cool)" /> : <Copy size={14} />}
                              </button>
                              <button
                                onClick={() => openUrl(stored.url)}
                                style={styles.iconBtn}
                                title={t("Open in browser")}
                                aria-label={t("Open in browser")}
                              >
                                <ExternalLink size={14} />
                              </button>
                            </div>
                            <div style={styles.statusRow}>
                              <span className="u-meta">
                                {stored.expiry === "permanent" ? t("Permanent link") : formatRemaining(remaining)}
                              </span>
                              <button
                                onClick={() => clearLink(clip.path)}
                                style={styles.relinkBtn}
                                title={t("Generate a new link")}
                              >
                                <RotateCcw size={11} /> {t("Re-upload")}
                              </button>
                            </div>
                          </>
                        ) : (
                          <>
                            <div style={styles.expiryRow}>
                              <Clock size={13} color="var(--faint)" />
                              <select
                                value={exp}
                                disabled={isUploading}
                                onChange={(e) => setExpiry(prev => ({ ...prev, [clip.path]: e.target.value }))}
                                aria-label={t("How long the link lasts")}
                                style={styles.select}
                              >
                                {EXPIRY_OPTIONS.map(o => (
                                  <option key={o.value} value={o.value}>{t(o.label)}</option>
                                ))}
                              </select>
                            </div>
                            <button
                              onClick={() => handleUpload(clip)}
                              disabled={isUploading || tooBig}
                              style={{
                                ...styles.uploadBtn,
                                opacity: isUploading || tooBig ? 0.5 : 1,
                                cursor: isUploading || tooBig ? "default" : "pointer",
                              }}
                            >
                              {isUploading ? (
                                <>
                                  <div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                                  {t("Uploading…")}
                                </>
                              ) : (
                                <><UploadCloud size={14} /> {t("Upload & share")}</>
                              )}
                            </button>
                            {/* Con progreso del backend, barra de verdad con los
                                MB. Sin él todavía (los primeros segundos son
                                handshake), la indeterminada con el tiempo que
                                lleva: una barra que avanza sola sería una
                                mentira útil, pero mentira. */}
                            {isUploading && (
                              uploadProg && uploadProg.total > 0 ? (
                                <div>
                                  <div style={styles.indeterminateTrack}>
                                    <span
                                      style={{
                                        ...styles.progressFill,
                                        width: `${Math.min(100, (100 * uploadProg.sent) / uploadProg.total)}%`,
                                      }}
                                    />
                                  </div>
                                  <span className="u-meta">
                                    {t("{pct}% · {sent} of {total} MB", {
                                      pct: Math.floor((100 * uploadProg.sent) / uploadProg.total),
                                      sent: (uploadProg.sent / 1024 / 1024).toFixed(1),
                                      total: (uploadProg.total / 1024 / 1024).toFixed(1),
                                    })}
                                  </span>
                                </div>
                              ) : (
                                <div>
                                  <div style={styles.indeterminateTrack}>
                                    <span style={styles.indeterminateFill} />
                                  </div>
                                  <span className="u-meta">
                                    {t("{s}s elapsed", { s: uploadElapsed })}
                                  </span>
                                </div>
                              )
                            )}
                            {tooBig && (
                              <span style={styles.warn}>
                                {isPermanent
                                  ? t("Over the {limit} limit of the permanent link. Pick a temporary one.", { limit: LIMIT_LABEL.permanent })
                                  : t("Over the {limit} limit. Clip a shorter moment.", { limit: LIMIT_LABEL.temporary })}
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          );
        })}
      </div>
      </div>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    padding: "var(--space-6) var(--space-8)",
    height: "100%",
    boxSizing: "border-box",
    background: "transparent",
  },
  scrollArea: {
    flex: 1,
    overflowY: "auto",
    position: "relative",
  },
  header: {
    display: "flex",
    alignItems: "baseline",
    gap: "var(--space-3)",
    margin: "0 0 var(--space-3) 0",
  },
  title: {
    color: "var(--text)",
    margin: 0,
    fontSize: "var(--font-xl)",
  },
  tools: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    flexWrap: "wrap",
    padding: "var(--space-3) 0",
    borderTop: "1px solid var(--line-soft)",
    borderBottom: "1px solid var(--line-soft)",
    marginBottom: "var(--space-4)",
  },
  emptyState: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
  },
  card: {
    background: "var(--media-sheen)",
    borderRadius: "var(--radius-lg)",
    border: "1px solid var(--line)",
    overflow: "hidden",
    display: "grid",
    gridTemplateColumns: "224px 1fr",
    height: 210,
  },
  thumbnailWrapper: {
    width: "100%",
    height: "100%",
    backgroundColor: "var(--sunken)",
    position: "relative",
    borderRight: "1px solid var(--line-soft)",
  },
  videoPreview: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    display: "block",
  },
  cardInfo: {
    padding: "var(--space-3) var(--space-4)",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    gap: "var(--space-2)",
    minWidth: 0,
    overflow: "hidden",
  },
  nameRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: "var(--space-2)",
  },
  clipName: {
    color: "var(--text)",
    fontSize: "var(--font-md)",
    fontWeight: 600,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  metaRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "var(--space-2)",
  },
  clipMatch: {
    color: "var(--faint)",
    fontSize: "var(--font-xs)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  sizeBadge: {
    color: "var(--muted)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--font-xs)",
    fontWeight: 600,
    flexShrink: 0,
  },
  rowActions: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
  },
  actions: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
  },
  expiryRow: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
  },
  select: {
    flex: 1,
    background: "var(--sunken)",
    color: "var(--text)",
    border: "1px solid var(--line)",
    borderRadius: "var(--radius-md)",
    padding: "6px 8px",
    fontSize: "var(--font-xs)",
    cursor: "pointer",
    outline: "none",
  },
  uploadBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--space-2)",
    padding: "var(--space-2)",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--font-xs)",
    fontWeight: 600,
    background: "var(--action)",
    border: "none",
    color: "var(--on-action)",
  },
  indeterminateTrack: {
    height: 3,
    background: "var(--sunken)",
    borderRadius: "var(--radius-full)",
    overflow: "hidden",
    boxShadow: "var(--inset-sunken)",
  },
  indeterminateFill: {
    display: "block",
    width: "100%",
    height: "100%",
    borderRadius: "var(--radius-full)",
    background: "var(--cool)",
    // Latido, no barrido: dice "sigue vivo", no "va por la mitad". Reutiliza el
    // keyframe `pulse` que ya existe en index.css en vez de traerse el suyo.
    animation: "pulse 1.4s ease-in-out infinite",
  },
  progressFill: {
    display: "block",
    height: "100%",
    borderRadius: "var(--radius-full)",
    background: "var(--cool)",
    transition: "width var(--t-quick) var(--e-move)",
  },
  warn: {
    color: "var(--signal)",
    fontSize: "11px",
    lineHeight: 1.4,
  },
  linkRow: {
    display: "flex",
    width: "100%",
    gap: "6px",
    background: "var(--sunken)",
    padding: "4px",
    borderRadius: "var(--radius-md)",
    alignItems: "center",
    boxShadow: "var(--inset-sunken)",
  },
  linkInput: {
    flex: 1,
    minWidth: 0,
    background: "transparent",
    color: "var(--text)",
    border: "none",
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
    outline: "none",
    padding: "0 4px",
  },
  iconBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--surface-2)",
    border: "1px solid var(--glass-line-soft)",
    color: "var(--muted)",
    borderRadius: "var(--radius-sm)",
    padding: "6px",
    cursor: "pointer",
    flexShrink: 0,
  },
  statusRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "var(--space-2)",
  },
  relinkBtn: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    background: "transparent",
    border: "none",
    color: "var(--muted)",
    fontSize: "11px",
    cursor: "pointer",
    padding: 0,
  },
};
