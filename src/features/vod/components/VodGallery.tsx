import React, { useState, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { processVod, cancelVod } from "../../../core/tauri-ipc";
import { MatchMetadata } from "../../../types";
import { Film, Upload, Play, Loader, Trash2, X } from "lucide-react";

interface VodGalleryProps {
  onSelectMatch: (match: MatchMetadata) => void;
}

export const VodGallery: React.FC<VodGalleryProps> = ({ onSelectMatch }) => {
  const [vods, setVods] = useState<MatchMetadata[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [hardwareInfo, setHardwareInfo] = useState("");
  const [progressPct, setProgressPct] = useState<number | null>(null);

  useEffect(() => {
    // Cargar historial persistido del disco
    invoke<MatchMetadata[]>("get_vod_reviews")
      .then((savedVods) => setVods(savedVods))
      .catch(console.error);

    const unlisten = listen<string>("vod_progress", (event) => {
      setStatusText(event.payload);
    });
    
    const unlistenHardware = listen<string>("hardware_info", (event) => {
      setHardwareInfo(event.payload);
    });

    const unlistenPct = listen<number>("vod_progress_pct", (event) => {
      setProgressPct(event.payload);
    });

    return () => {
      unlisten.then(f => f());
      unlistenHardware.then(f => f());
      unlistenPct.then(f => f());
    };
  }, []);

  const handleImport = async () => {
    try {
      // 1. Seleccionar VOD
      const selectedVideo = await open({
        multiple: false,
        filters: [{ name: "Video", extensions: ["mp4", "mkv", "avi"] }],
      });

      if (!selectedVideo) return;

      setIsProcessing(true);
      setHardwareInfo("");
      setProgressPct(null);
      setStatusText("Analizando VOD con Inteligencia Artificial...");
      
      const res = await processVod(selectedVideo as string);
      if (res.success && res.metadata) {
        setVods([...vods, res.metadata]);
      } else {
        alert(res.message);
      }
    } catch (err: any) {
      alert("Error: " + err.toString());
    } finally {
      setIsProcessing(false);
      setStatusText("");
      setProgressPct(null);
    }
  };

  const handleCancel = async () => {
    setStatusText("Cancelando análisis...");
    try {
      await cancelVod();
    } catch (err: any) {
      // Si falla la cancelación no bloqueamos la UI; el análisis terminará igualmente.
      console.error("No se pudo cancelar:", err);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm("¿Estás seguro de eliminar este VOD Review de manera permanente?")) return;
    try {
      await invoke("delete_match", { id });
      setVods((prev) => prev.filter((v) => v.id !== id));
    } catch (err: any) {
      alert("Error eliminando VOD: " + err.toString());
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h1 style={styles.pageTitle}>VOD Analysis (AI)</h1>
        <p style={styles.pageSubtitle}>
          Importa partidas de profesionales para analizarlas con Inteligencia Artificial.
        </p>
      </div>

      <div style={styles.actionRow}>
        <div style={{display: 'flex', flexDirection: 'column', gap: '8px'}}>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <button onClick={handleImport} disabled={isProcessing} style={{...styles.importBtn, opacity: isProcessing ? 0.6 : 1}}>
              {isProcessing ? <Loader size={18} className="spin" /> : <Upload size={18} />}
              {isProcessing ? "Procesando VOD..." : "Importar VOD (.mp4)"}
            </button>
            {isProcessing && (
              <button onClick={handleCancel} style={styles.cancelBtn} title="Cancelar análisis">
                <X size={16} /> Cancelar
              </button>
            )}
          </div>
          
          {hardwareInfo && isProcessing && (
            <span style={{
              color: "#10b981",
              fontSize: "12px",
              backgroundColor: "rgba(16, 185, 129, 0.1)",
              padding: "4px 8px",
              borderRadius: "4px",
              display: "inline-block",
              fontWeight: 600
            }}>
              ⚡ GPU Activa: {hardwareInfo}
            </span>
          )}

          {isProcessing && progressPct !== null && (
            <div style={{ width: "260px" }}>
              <div style={{ height: "6px", borderRadius: "3px", backgroundColor: "var(--bg-card)", overflow: "hidden" }}>
                <div style={{
                  width: `${Math.min(100, Math.max(0, progressPct))}%`,
                  height: "100%",
                  backgroundColor: "var(--accent-violet)",
                  transition: "width 0.3s ease",
                }} />
              </div>
              <span style={{ color: "var(--text-muted)", fontSize: "11px" }}>{progressPct.toFixed(0)}%</span>
            </div>
          )}
        </div>
        
        {isProcessing && <span style={{ color: "var(--text-muted)", fontSize: "12px" }}>{statusText}</span>}
      </div>

      <div style={styles.grid}>
        {vods.length === 0 && !isProcessing && (
          <div style={styles.emptyState}>
            <Film size={48} color="var(--text-muted)" />
            <p style={{ marginTop: "16px", color: "var(--text-secondary)" }}>
              No has importado ningún VOD aún. Usa el botón de arriba para comenzar.
            </p>
          </div>
        )}

        {vods.map((vod) => (
          <div key={vod.id} style={styles.card}>
            <div style={styles.cardInfo}>
              <h4 style={{ margin: 0, color: "#fff" }}>{vod.champion}</h4>
              <span style={{ fontSize: "12px", color: "var(--text-muted)" }}>{vod.date}</span>
            </div>
            <div style={{display: "flex", alignItems: "center"}}>
              <button style={styles.playBtn} onClick={() => onSelectMatch(vod)}>
                <Play size={16} /> Reproducir
              </button>
              <button 
                style={{...styles.playBtn, borderColor: "var(--color-defeat)", color: "var(--color-defeat)", marginLeft: "var(--space-2)"}} 
                onClick={() => handleDelete(vod.id)}
                title="Eliminar permanentemente"
              >
                <Trash2 size={16} />
              </button>
            </div>
          </div>
        ))}
      </div>
      <style>{`
        .spin {
          animation: spin 1s linear infinite;
        }
        @keyframes spin {
          100% { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: "var(--space-6) 10%",
    height: "100%",
    display: "flex",
    flexDirection: "column",
    boxSizing: "border-box",
    backgroundColor: "var(--bg-app)",
  },
  header: {
    marginBottom: "var(--space-6)",
  },
  pageTitle: {
    margin: 0,
    fontSize: "var(--font-2xl)",
    fontWeight: 700,
    color: "#fff",
  },
  pageSubtitle: {
    margin: "var(--space-2) 0 0 0",
    fontSize: "var(--font-sm)",
    color: "var(--text-secondary)",
  },
  actionRow: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-4)",
    marginBottom: "var(--space-8)",
  },
  importBtn: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    padding: "var(--space-3) var(--space-6)",
    backgroundColor: "var(--accent-violet)",
    color: "#fff",
    border: "none",
    borderRadius: "var(--radius-md)",
    fontWeight: 600,
    cursor: "pointer",
  },
  cancelBtn: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "var(--space-3) var(--space-4)",
    backgroundColor: "transparent",
    color: "var(--color-defeat)",
    border: "1px solid var(--color-defeat)",
    borderRadius: "var(--radius-md)",
    fontWeight: 600,
    cursor: "pointer",
  },
  grid: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-4)",
  },
  emptyState: {
    padding: "var(--space-12)",
    textAlign: "center",
  },
  card: {
    backgroundColor: "var(--bg-card)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-lg)",
    padding: "var(--space-4)",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  cardInfo: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
  playBtn: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    backgroundColor: "transparent",
    border: "1px solid var(--border-strong)",
    color: "var(--text-primary)",
    padding: "8px 16px",
    borderRadius: "var(--radius-md)",
    cursor: "pointer",
  }
};
