import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Film, UploadCloud, Check, Copy, ExternalLink, Clock, RotateCcw, Heart } from "lucide-react";
import { motion, Variants } from "framer-motion";
import { ClipMetadata } from "../../../types";
import { toggleClipFavorite } from "../../../core/tauri-ipc";
import { useDialog } from "../../../components/ui/DialogProvider";

// El protocolo de streaming se sirve en http://stream.localhost/<ruta> (igual que
// en el reproductor principal). El esquema "stream://localhost/" no resuelve en el WebView.
const streamUrl = (path: string): string =>
  `http://stream.localhost/${encodeURIComponent(path)}`;

const CATBOX_LIMIT = 200 * 1024 * 1024; // 200 MB (límite de catbox permanente)
const LITTERBOX_LIMIT = 1024 * 1024 * 1024; // 1 GB (límite de litterbox temporal)

// "permanent" -> catbox.moe (enlace permanente). El resto -> litterbox (temporal, máx. 72 h).
const EXPIRY_OPTIONS = [
  { value: "72h", label: "Temporal · 72 h" },
  { value: "24h", label: "Temporal · 24 h" },
  { value: "12h", label: "Temporal · 12 h" },
  { value: "1h", label: "Temporal · 1 h" },
  { value: "permanent", label: "Permanente" },
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
  if (h >= 1) return `Caduca en ~${h} h`;
  const m = Math.max(1, Math.floor(ms / 60e3));
  return `Caduca en ~${m} min`;
};

export const ClipsGallery: React.FC = () => {
  const [clips, setClips] = useState<ClipMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState<string | null>(null);
  const [links, setLinks] = useState<Record<string, StoredLink>>(() => loadStoredLinks());
  const { showSuccess, showError } = useDialog();
  const [expiry, setExpiry] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);

  const containerVariants: Variants = {
    hidden: { opacity: 0 },
    show: {
      opacity: 1,
      transition: { staggerChildren: 0.05 }
    }
  };

  const itemVariants: Variants = {
    hidden: { opacity: 0, y: 20 },
    show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 300, damping: 24 } }
  };

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
      showError("Error al subir: " + e);
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
      showError("Error al marcar favorito: " + err);
    }
  };

  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.emptyState}>
          <div className="spinner" />
          <p style={{ color: "var(--text-muted)", marginTop: 16 }}>Buscando clips...</p>
        </div>
      </div>
    );
  }

  if (clips.length === 0) {
    return (
      <div style={styles.container}>
        <div style={styles.emptyState}>
          <Film size={48} color="var(--text-muted)" style={{ opacity: 0.5, marginBottom: 16 }} />
          <h3 style={{ color: "#fff", margin: 0 }}>No tienes clips aún</h3>
          <p style={{ color: "var(--text-muted)", marginTop: 8, textAlign: "center", maxWidth: 360 }}>
            Usa la herramienta de recorte en el reproductor para crear clips de tus mejores momentos.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>Mis Clips</h2>
        <span style={styles.count}>{clips.length} {clips.length === 1 ? "clip" : "clips"}</span>
      </div>
      <motion.div 
        variants={containerVariants}
        initial="hidden"
        animate="show"
        style={styles.grid}
      >
        {clips.map((clip) => {
          const stored = links[clip.path];
          const isUploading = uploading === clip.path;
          const exp = expiry[clip.path] ?? "72h";
          const isPermanent = exp === "permanent";
          const limit = isPermanent ? CATBOX_LIMIT : LITTERBOX_LIMIT;
          const tooBig = clip.size > limit;
          const remaining = stored ? expiresAt(stored) - Date.now() : 0;

          return (
            <motion.div 
              variants={itemVariants}
              key={clip.path} 
              style={styles.card}
              whileHover={{ scale: 1.02 }}
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
                    title={clip.favorite ? "Quitar de favoritos" : "Añadir a favoritos"}
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
                        <button onClick={() => copyLink(stored.url)} style={styles.iconBtn} title="Copiar enlace">
                          {copied === stored.url ? <Check size={14} color="var(--color-victory)" /> : <Copy size={14} />}
                        </button>
                        <button onClick={() => openUrl(stored.url)} style={styles.iconBtn} title="Abrir en el navegador">
                          <ExternalLink size={14} />
                        </button>
                      </div>
                      <div style={styles.statusRow}>
                        <span style={styles.statusText}>
                          {stored.expiry === "permanent" ? "Enlace permanente" : formatRemaining(remaining)}
                        </span>
                        <button onClick={() => clearLink(clip.path)} style={styles.relinkBtn} title="Generar un enlace nuevo">
                          <RotateCcw size={11} /> Volver a subir
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
                          <><div className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> Subiendo...</>
                        ) : (
                          <><UploadCloud size={14} /> Subir y compartir</>
                        )}
                      </button>
                      {tooBig && (
                        <span style={styles.warn}>
                          Supera el límite de {isPermanent ? "200 MB (permanente)" : "1 GB (temporal)"}.
                          {isPermanent ? " Elige una opción temporal." : ""}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>
            </motion.div>
          );
        })}
      </motion.div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: "var(--space-8)",
    height: "100%",
    boxSizing: "border-box",
    overflowY: "auto",
    backgroundColor: "var(--bg-app)",
  },
  header: {
    display: "flex",
    alignItems: "baseline",
    gap: "var(--space-3)",
    margin: "0 0 var(--space-6) 0",
  },
  title: {
    color: "#fff",
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
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
    gap: "var(--space-6)",
  },
  card: {
    backgroundColor: "var(--bg-card)",
    borderRadius: "var(--radius-lg)",
    border: "1px solid var(--border-subtle)",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
  thumbnailWrapper: {
    width: "100%",
    aspectRatio: "16/9",
    backgroundColor: "#000",
    position: "relative",
  },
  videoPreview: {
    width: "100%",
    height: "100%",
    objectFit: "contain",
  },
  cardInfo: {
    padding: "var(--space-4)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
  },
  clipName: {
    color: "#fff",
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
    background: "var(--accent-violet)",
    border: "none",
    color: "#fff",
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
    color: "#fff",
    border: "none",
    fontSize: "11px",
    outline: "none",
    padding: "0 4px",
  },
  iconBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "var(--accent-blue)",
    border: "none",
    color: "#fff",
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
