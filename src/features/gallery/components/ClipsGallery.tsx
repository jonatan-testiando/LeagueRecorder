import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Film, UploadCloud, Check, Copy, ExternalLink, Clock, RotateCcw, Heart } from "lucide-react";
import { motion } from "framer-motion";
import { ClipMetadata } from "../../../types";
import { toggleClipFavorite } from "../../../core/tauri-ipc";
import { useDialog } from "../../../components/ui/DialogProvider";
import { useVirtualizer } from "@tanstack/react-virtual";
import { EmptyState } from "../../../components/ui/EmptyState";
import { useT } from "../../../core/LanguageProvider";
import { streamUrl } from "../../../core/media";

const CATBOX_LIMIT = 200 * 1024 * 1024; // 200 MB (límite de catbox permanente)
const LITTERBOX_LIMIT = 1024 * 1024 * 1024; // 1 GB (límite de litterbox temporal)

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

const formatRemaining = (ms: number): string => {
  const h = Math.floor(ms / 3600e3);
  if (h >= 1) return `Expires in ~${h} h`;
  const m = Math.max(1, Math.floor(ms / 60e3));
  return `Expires in ~${m} min`;
};

export const ClipsGallery: React.FC = () => {
  const [clips, setClips] = useState<ClipMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const t = useT();
  const [uploading, setUploading] = useState<string | null>(null);
  const [links, setLinks] = useState<Record<string, StoredLink>>(() => loadStoredLinks());
  const { showSuccess, showError } = useDialog();
  const [expiry, setExpiry] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);

  // OJO: todos los hooks van aquí arriba, antes de los `return` de "cargando" y
  // "sin clips". Declararlos después haría que el número de hooks cambiara entre
  // renders y React abortaría con "Rendered more hooks than during the previous render".
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(2);

  // Cuántas tarjetas caben por fila. Replica a mano lo que hacía
  // `grid-template-columns: repeat(auto-fill, minmax(CARD_MIN_WIDTH, 1fr))`,
  // porque el virtualizador necesita saber el número de columnas para agrupar.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const medir = () =>
      setColumns(Math.max(1, Math.floor((el.clientWidth + GRID_GAP) / (CARD_MIN_WIDTH + GRID_GAP))));
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading, clips.length]);

  const rowCount = Math.ceil(clips.length / columns);
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
  // tarjetas: las alturas medidas antes ya no valen.
  useEffect(() => {
    rowVirtualizer.measure();
  }, [columns, rowVirtualizer]);

  // Persistir los enlaces cada vez que cambian para que sobrevivan a recargas.
  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify(links));
  }, [links]);

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
      showSuccess("Clip subido exitosamente");
      await copyLink(url);
    } catch (e) {
      console.error(e);
      showError("Upload failed: " + e);
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
      showError("Failed to toggle favorite: " + err);
    }
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
          <h1 style={styles.title}>Clips</h1>
        </div>
        <EmptyState
          icon={<Film size={30} color="var(--faint)" />}
          title={t("No clips yet")}
          text="Use the clipping tool in the player to save your best moments."
        />
      </div>
    );
  }

  return (
    <div style={styles.container} className="panel-enter">
      <div style={styles.header}>
        <h1 style={styles.title}>Clips</h1>
        <div className="u-meta" style={{ marginTop: 4 }}>
          {clips.length} {clips.length === 1 ? "clip" : "clips"}
        </div>
      </div>
      {/* El scroll vive aquí y no en el contenedor: el virtualizador posiciona los
          items relativos a este div, así que si el elemento con scroll fuera el de
          fuera, la cabecera desplazaría todas las filas. */}
      <div style={styles.scrollArea} ref={scrollRef}>
      <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, width: "100%", position: "relative" }}>
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const startIndex = virtualRow.index * columns;
          const rowClips = clips.slice(startIndex, startIndex + columns);

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
                const limit = isPermanent ? CATBOX_LIMIT : LITTERBOX_LIMIT;
                const tooBig = clip.size > limit;
                const remaining = stored ? expiresAt(stored) - Date.now() : 0;

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
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "8px" }}>
                        <span style={styles.clipName} title={clip.name}>{clip.name}</span>
                        <button 
                          onClick={() => handleToggleFavorite(clip.path)}
                          style={{ ...styles.iconBtn, background: "transparent", color: clip.favorite ? "var(--accent-violet)" : "var(--text-muted)" }}
                          title={clip.favorite ? "Remove from favorites" : "Add to favorites"}
                        >
                          <Heart size={16} fill={clip.favorite ? "var(--accent-violet)" : "transparent"} />
                        </button>
                      </div>
                      <div style={styles.metaRow}>
                        <span style={styles.clipMatch}>De: {clip.match_id}</span>
                        <span style={styles.sizeBadge}>{formatSize(clip.size)}</span>
                      </div>

                      <div style={styles.actions}>
                        {stored ? (
                          <>
                            <div style={styles.linkRow}>
                              <input readOnly value={stored.url} style={styles.linkInput} onFocus={(e) => e.target.select()} />
                              <button onClick={() => copyLink(stored.url)} style={styles.iconBtn} title="Copy link">
                                {copied === stored.url ? <Check size={14} color="var(--color-victory)" /> : <Copy size={14} />}
                              </button>
                              <button onClick={() => openUrl(stored.url)} style={styles.iconBtn} title="Open in browser">
                                <ExternalLink size={14} />
                              </button>
                            </div>
                            <div style={styles.statusRow}>
                              <span style={styles.statusText}>
                                {stored.expiry === "permanent" ? "Permanent link" : formatRemaining(remaining)}
                              </span>
                              <button onClick={() => clearLink(clip.path)} style={styles.relinkBtn} title="Generate a new link">
                                <RotateCcw size={11} /> Re-upload
                              </button>
                            </div>
                          </>
                        ) : (
                          <>
                            <div style={styles.expiryRow}>
                              <Clock size={13} color="var(--text-muted)" />
                              <select
                                value={exp}
                                disabled={isUploading}
                                onChange={(e) => setExpiry(prev => ({ ...prev, [clip.path]: e.target.value }))}
                                style={styles.select}
                              >
                                {EXPIRY_OPTIONS.map(o => (
                                  <option key={o.value} value={o.value}>{o.label}</option>
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
                                <><div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Uploading…</>
                              ) : (
                                <><UploadCloud size={14} /> Upload & share</>
                              )}
                            </button>
                            {tooBig && (
                              <span style={styles.warn}>
                                Exceeds the {isPermanent ? "200 MB (permanent)" : "1 GB (temporary)"} limit.
                                {isPermanent ? " Choose a temporary option." : ""}
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
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    padding: "var(--space-8)",
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
    margin: "0 0 var(--space-6) 0",
  },
  title: {
    color: "var(--text)",
    margin: 0,
    fontSize: "var(--font-xl)",
  },
  count: {
    color: "var(--text-muted)",
    fontSize: "var(--font-sm)",
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
    border: "1px solid var(--border-subtle)",
    overflow: "hidden",
    display: "grid",
    gridTemplateColumns: "224px 1fr",
    height: 168,
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
    color: "var(--text-muted)",
    fontSize: "var(--font-xs)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  sizeBadge: {
    color: "var(--text-secondary)",
    fontSize: "var(--font-xs)",
    fontWeight: 600,
    flexShrink: 0,
  },
  actions: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
    marginTop: "var(--space-2)",
  },
  expiryRow: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
  },
  select: {
    flex: 1,
    background: "var(--bg-app)",
    color: "var(--text-primary)",
    border: "1px solid var(--border-subtle)",
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
    padding: "var(--space-3)",
    borderRadius: "var(--radius-md)",
    fontSize: "var(--font-xs)",
    fontWeight: 600,
    background: "var(--action)",
    border: "none",
    color: "var(--on-action)",
  },
  warn: {
    color: "var(--color-defeat)",
    fontSize: "11px",
    lineHeight: 1.4,
  },
  linkRow: {
    display: "flex",
    width: "100%",
    gap: "6px",
    background: "rgba(0,0,0,0.3)",
    padding: "4px",
    borderRadius: "var(--radius-md)",
    alignItems: "center",
  },
  linkInput: {
    flex: 1,
    minWidth: 0,
    background: "transparent",
    color: "var(--text)",
    border: "none",
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
    borderRadius: "4px",
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
  statusText: {
    color: "var(--text-muted)",
    fontSize: "11px",
  },
  relinkBtn: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    background: "transparent",
    border: "none",
    color: "var(--text-secondary)",
    fontSize: "11px",
    cursor: "pointer",
    padding: 0,
  },
};
