import React, { useEffect, useState } from "react";
import { AlertTriangle, Play } from "lucide-react";
import { ErrorClipMetadata, getAllErrorClips } from "../../../core/tauri-ipc";

import { motion, Variants } from "framer-motion";

const streamUrl = (path: string): string =>
  `http://stream.localhost/${encodeURIComponent(path)}`;

const formatSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
};

interface ErrorsGalleryProps {
  onSelectError?: (error: ErrorClipMetadata) => void;
}

export const ErrorsGallery: React.FC<ErrorsGalleryProps> = ({ onSelectError }) => {
  const [errors, setErrors] = useState<ErrorClipMetadata[]>([]);
  const [loading, setLoading] = useState(true);

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

  const fetchErrors = async () => {
    try {
      const result = await getAllErrorClips();
      setErrors(result);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchErrors();
  }, []);

  useEffect(() => {
    fetchErrors();
  }, []);

  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.emptyState}>
          <div className="spinner" />
          <p style={{ color: "var(--text-muted)", marginTop: 16 }}>Loading errors…</p>
        </div>
      </div>
    );
  }

  if (errors.length === 0) {
    return (
      <div style={styles.container}>
        <div style={styles.emptyState}>
          <AlertTriangle size={48} color="var(--color-defeat)" style={{ opacity: 0.5, marginBottom: 16 }} />
          <h3 style={{ color: "#fff", margin: 0 }}>No errors flagged yet</h3>
          <p style={{ color: "var(--text-muted)", marginTop: 8, textAlign: "center", maxWidth: 360 }}>
            Use the Error tool in the video player to save the mistakes you make and track your progress over time.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.title}>Mis Errores</h2>
        <span style={styles.count}>{errors.length} {errors.length === 1 ? "error" : "errores"}</span>
      </div>
      <motion.div 
        variants={containerVariants}
        initial="hidden"
        animate="show"
        style={styles.grid}
      >
        {errors.map((err) => {
          return (
            <motion.div 
              variants={itemVariants}
              key={err.path} 
              style={{...styles.card, cursor: "pointer"}}
              onClick={() => onSelectError && onSelectError(err)}
              whileHover={{ scale: 1.02, borderColor: "var(--color-defeat)" }}
            >
              <div style={styles.thumbnailWrapper}>
                <video
                  src={streamUrl(err.path)}
                  style={styles.videoPreview}
                  preload="metadata"
                />
                <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.3)" }}>
                  <Play size={32} color="#fff" style={{ opacity: 0.8 }} />
                </div>
              </div>
              <div style={styles.cardInfo}>
                <div style={styles.metaRow}>
                  <span style={styles.clipMatch} title={err.match_id}>Match: {err.match_id}</span>
                  <span style={styles.sizeBadge}>{formatSize(err.size)}</span>
                </div>
                
                <div style={styles.noteSection}>
                  <span style={styles.noteLabel}>Anotaciones: {err.events ? err.events.length : 0}</span>
                  <div style={styles.noteDisplay}>
                    {err.events && err.events.length > 0 
                      ? `${err.events[0].category}: ${err.events[0].text}` 
                      : (err.note ? err.note : <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>Sin anotaciones</span>)}
                  </div>
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
    gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
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
    gap: "var(--space-3)",
  },
  metaRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "var(--space-2)",
  },
  clipMatch: {
    color: "var(--text-secondary)",
    fontSize: "var(--font-xs)",
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  sizeBadge: {
    color: "var(--text-muted)",
    fontSize: "var(--font-xs)",
    flexShrink: 0,
  },
  noteSection: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
    marginTop: "var(--space-1)",
  },
  noteLabel: {
    fontSize: "var(--font-xs)",
    color: "var(--color-defeat)",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  noteDisplay: {
    fontSize: "var(--font-sm)",
    color: "var(--text-primary)",
    backgroundColor: "rgba(0,0,0,0.2)",
    padding: "var(--space-3)",
    borderRadius: "var(--radius-md)",
    cursor: "text",
    minHeight: "60px",
    lineHeight: 1.5,
    border: "1px solid transparent",
    transition: "border-color 0.2s",
  },
  noteTextarea: {
    width: "100%",
    boxSizing: "border-box",
    backgroundColor: "rgba(0,0,0,0.4)",
    color: "#fff",
    border: "1px solid var(--accent-violet)",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-3)",
    fontSize: "var(--font-sm)",
    fontFamily: "inherit",
    outline: "none",
    resize: "vertical",
    lineHeight: 1.5,
  },
  cancelBtn: {
    background: "transparent",
    border: "none",
    color: "var(--text-muted)",
    cursor: "pointer",
    fontSize: "var(--font-xs)",
    padding: "4px 8px",
  },
  saveBtn: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    background: "var(--accent-violet)",
    color: "#fff",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "var(--font-xs)",
    fontWeight: "bold",
    padding: "6px 12px",
  }
};
