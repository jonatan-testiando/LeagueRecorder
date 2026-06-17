import React, { useEffect, useState } from "react";
import { AlertTriangle, Save } from "lucide-react";
import { ErrorClipMetadata, getAllErrorClips, updateErrorNote } from "../../../core/tauri-ipc";

const streamUrl = (path: string): string =>
  `http://stream.localhost/${encodeURIComponent(path)}`;

const formatSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
};

export const ErrorsGallery: React.FC = () => {
  const [errors, setErrors] = useState<ErrorClipMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingNotePath, setEditingNotePath] = useState<string | null>(null);
  const [editNoteText, setEditNoteText] = useState<string>("");

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

  const handleSaveNote = async (path: string) => {
    try {
      await updateErrorNote(path, editNoteText);
      setErrors(errs => errs.map(e => e.path === path ? { ...e, note: editNoteText } : e));
      setEditingNotePath(null);
    } catch (err) {
      alert("Error al guardar la nota: " + err);
    }
  };

  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.emptyState}>
          <div className="spinner" />
          <p style={{ color: "var(--text-muted)", marginTop: 16 }}>Buscando errores...</p>
        </div>
      </div>
    );
  }

  if (errors.length === 0) {
    return (
      <div style={styles.container}>
        <div style={styles.emptyState}>
          <AlertTriangle size={48} color="var(--color-defeat)" style={{ opacity: 0.5, marginBottom: 16 }} />
          <h3 style={{ color: "#fff", margin: 0 }}>No tienes errores marcados aún</h3>
          <p style={{ color: "var(--text-muted)", marginTop: 8, textAlign: "center", maxWidth: 360 }}>
            Usa la herramienta de Error en el reproductor de video para guardar los errores que cometes y llevar un registro de tu evolución.
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
      <div style={styles.grid}>
        {errors.map((err) => {
          const isEditing = editingNotePath === err.path;
          return (
            <div key={err.path} style={styles.card}>
              <div style={styles.thumbnailWrapper}>
                <video
                  src={streamUrl(err.path)}
                  style={styles.videoPreview}
                  controls
                  preload="metadata"
                />
              </div>
              <div style={styles.cardInfo}>
                <div style={styles.metaRow}>
                  <span style={styles.clipMatch} title={err.match_id}>Partida: {err.match_id}</span>
                  <span style={styles.sizeBadge}>{formatSize(err.size)}</span>
                </div>
                
                <div style={styles.noteSection}>
                  <span style={styles.noteLabel}>Nota del Error:</span>
                  {isEditing ? (
                    <div style={{ display: "flex", gap: "8px", flexDirection: "column" }}>
                      <textarea 
                        autoFocus
                        value={editNoteText}
                        onChange={(e) => setEditNoteText(e.target.value)}
                        style={styles.noteTextarea}
                        rows={3}
                      />
                      <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                        <button onClick={() => setEditingNotePath(null)} style={styles.cancelBtn}>Cancelar</button>
                        <button onClick={() => handleSaveNote(err.path)} style={styles.saveBtn}>
                          <Save size={14} /> Guardar
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div 
                      onClick={() => { setEditingNotePath(err.path); setEditNoteText(err.note); }}
                      style={styles.noteDisplay}
                      title="Haz clic para editar la nota"
                    >
                      {err.note ? err.note : <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>Sin nota. Haz clic para añadir una descripción.</span>}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
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
