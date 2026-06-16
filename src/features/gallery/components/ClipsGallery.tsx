import React, { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Film, UploadCloud } from "lucide-react";
import { ClipMetadata } from "../../../types";

export const ClipsGallery: React.FC = () => {
  const streamUrl = (path: string): string => 
    `stream://localhost/${encodeURIComponent(path)}`;

  const [clips, setClips] = useState<ClipMetadata[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState<string | null>(null);
  const [links, setLinks] = useState<Record<string, string>>({});

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

  const handleUpload = async (clip: ClipMetadata) => {
    setUploading(clip.path);
    try {
      const link = await invoke<string>("upload_to_catbox", { path: clip.path });
      setLinks(prev => ({ ...prev, [clip.path]: link }));
      await navigator.clipboard.writeText(link);
      alert("¡Subido con éxito! El link se ha copiado a tu portapapeles.");
    } catch (e) {
      alert("Error al subir: " + e);
    } finally {
      setUploading(null);
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
          <p style={{ color: "var(--text-muted)", marginTop: 8 }}>Usa la herramienta de recorte en el reproductor para crear clips de tus mejores momentos.</p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <h2 style={styles.title}>Mis Clips</h2>
      <div style={styles.grid}>
        {clips.map((clip) => (
          <div key={clip.path} style={styles.card}>
            <div style={styles.thumbnailWrapper}>
              <video 
                src={streamUrl(clip.path)} 
                style={styles.videoPreview} 
                controls
                preload="metadata"
              />
            </div>
            <div style={styles.cardInfo}>
              <span style={styles.clipName}>{clip.name}</span>
              <span style={styles.clipMatch}>De: {clip.match_id}</span>
              <div style={styles.actions}>
                {links[clip.path] ? (
                  <div style={{ display: "flex", width: "100%", gap: "8px", background: "rgba(0,0,0,0.3)", padding: "4px", borderRadius: "4px" }}>
                    <input readOnly value={links[clip.path]} style={{ flex: 1, background: "transparent", color: "#fff", border: "none", fontSize: "11px", outline: "none" }} />
                    <button onClick={() => { navigator.clipboard.writeText(links[clip.path]); alert("Copiado!"); }} style={{ background: "var(--accent-blue)", border: "none", color: "#fff", borderRadius: "4px", padding: "4px 8px", cursor: "pointer", fontSize: "11px" }}>Copiar</button>
                  </div>
                ) : (
                  <button 
                    onClick={() => handleUpload(clip)} 
                    disabled={uploading === clip.path}
                    style={{...styles.actionBtn, background: "var(--accent-violet)", border: "none", color: "#fff", flex: 1}}
                  >
                    {uploading === clip.path ? <div className="spinner" style={{width: 14, height: 14, borderWidth: 2}} /> : <UploadCloud size={14} />}
                    {uploading === clip.path ? "Subiendo..." : "Subir a la nube"}
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
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
  title: {
    color: "#fff",
    margin: "0 0 var(--space-6) 0",
    fontSize: "var(--font-xl)",
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
  clipMatch: {
    color: "var(--text-muted)",
    fontSize: "var(--font-xs)",
  },
  actions: {
    display: "flex",
    gap: "var(--space-2)",
    marginTop: "var(--space-2)",
  },
  actionBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "var(--space-2)",
    padding: "var(--space-2)",
    borderRadius: "var(--radius-md)",
    cursor: "pointer",
    fontSize: "var(--font-xs)",
    fontWeight: 600,
  }
};
