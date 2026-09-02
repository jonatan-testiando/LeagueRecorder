import React, { useState, useEffect, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { processVod, cancelVod } from "../../../core/tauri-ipc";
import { MatchMetadata } from "../../../types";
import { Film, Upload, Play, Loader, Trash2, X, FolderOpen, Zap } from "lucide-react";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { useDialog } from "../../../components/ui/DialogProvider";
import { useT } from "../../../core/LanguageProvider";

/**
 * Análisis de vídeo.
 *
 * Era la pantalla más a medias de la app: sin una sola cadena traducida, con
 * `alert()` y `window.confirm()` del navegador (que en una ventana sin
 * decoraciones parecen de otro programa), su propia copia del keyframe `spin`
 * que ya existe en index.css, y un contenedor con `padding: 10%` que no se
 * parecía a ninguna otra página.
 *
 * También mentía en un sitio silencioso: al terminar un análisis metía el
 * resultado en la lista de memoria en vez de releer lo persistido, así que lo
 * que veías después de analizar no era necesariamente lo que había en disco.
 */

interface VodGalleryProps {
  onSelectMatch: (match: MatchMetadata) => void;
}

export const VodGallery: React.FC<VodGalleryProps> = ({ onSelectMatch }) => {
  const [vods, setVods] = useState<MatchMetadata[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [hardwareInfo, setHardwareInfo] = useState("");
  const [progressPct, setProgressPct] = useState<number | null>(null);
  const t = useT();
  const { showConfirm, showError, showAlert } = useDialog();

  /** Relee lo que hay en disco. Es la única fuente de la lista. */
  const reloadVods = useCallback(async () => {
    try {
      setVods(await invoke<MatchMetadata[]>("get_vod_reviews"));
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    reloadVods();

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
  }, [reloadVods]);

  const handleImport = async () => {
    try {
      const selectedVideo = await open({
        multiple: false,
        filters: [{ name: t("Video"), extensions: ["mp4", "mkv", "avi"] }],
      });

      if (!selectedVideo) return;

      setIsProcessing(true);
      setProgressPct(null);
      setStatusText(t("Analysing the video…"));

      const res = await processVod(selectedVideo as string);
      if (res.success) {
        // Se relee lo persistido en vez de añadir el resultado a mano: así la
        // lista es siempre lo que hay en disco y no una copia que se le parece.
        await reloadVods();
      } else {
        showError(t("Couldn't analyse the video: {msg}", { msg: res.message }));
      }
    } catch (err) {
      showError(t("Couldn't analyse the video: {msg}", { msg: String(err) }));
    } finally {
      setIsProcessing(false);
      setStatusText("");
      setProgressPct(null);
    }
  };

  const handleCancel = async () => {
    setStatusText(t("Cancelling…"));
    try {
      await cancelVod();
      // Cancelar sin decir nada dejaba la pantalla igual que si no hubieras
      // pulsado: el análisis tarda en soltarse y no hay señal de que te haya oído.
      await showAlert(t("Analysis cancelled. Nothing was saved."));
    } catch (err) {
      showError(t("Couldn't cancel the analysis: {msg}", { msg: String(err) }));
    }
  };

  const handleDelete = async (vod: MatchMetadata) => {
    const ok = await showConfirm({
      title: t("Delete analysis"),
      message: t("This permanently deletes the analysis of {name} and everything found in it. The original video file is not touched.", { name: vod.champion }),
      confirmText: t("Delete"),
      cancelText: t("Cancel"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await invoke("delete_match", { id: vod.id });
      await reloadVods();
    } catch (err) {
      showError(t("Couldn't delete the analysis: {msg}", { msg: String(err) }));
    }
  };

  const handleReveal = async (vod: MatchMetadata) => {
    try {
      await revealItemInDir(vod.video_path);
    } catch (err) {
      showError(t("Couldn't open the folder: {msg}", { msg: String(err) }));
    }
  };

  const gpu = hardwareInfo.trim().length > 0;

  return (
    <div style={styles.container} className="panel-enter">
      <div style={styles.header}>
        <h1 style={styles.pageTitle}>{t("Analysis")}</h1>
        <p style={styles.pageSubtitle}>
          {t("Import a video and it reads the cursor and the clicks frame by frame, the same way it does with your own recordings.")}
        </p>
      </div>

      <div style={styles.actionRow}>
        <div style={styles.actionCol}>
          <div style={styles.buttonRow}>
            <button onClick={handleImport} disabled={isProcessing} style={{ ...styles.importBtn, opacity: isProcessing ? 0.6 : 1 }}>
              {/* El keyframe `spin` ya vive en index.css; esta pantalla llevaba
                  su propia copia en un <style> incrustado. */}
              {isProcessing
                ? <Loader size={18} style={{ animation: "spin 1s linear infinite" }} />
                : <Upload size={18} />}
              {isProcessing ? t("Analysing…") : t("Import video")}
            </button>
            {isProcessing && (
              <Button variant="danger" size="sm" icon={<X size={14} />} onClick={handleCancel}>
                {t("Cancel")}
              </Button>
            )}
            {/* La insignia de GPU se queda puesta cuando el backend la anuncia:
                saber con qué se analiza es lo que explica el tiempo de espera. */}
            {gpu && (
              <span style={styles.gpuBadge} title={hardwareInfo}>
                <Zap size={12} /> {t("GPU")} · {hardwareInfo}
              </span>
            )}
          </div>

          {/* Lo que de verdad se pregunta al pulsar: cuánto va a tardar. */}
          <span className="u-meta">
            {gpu
              ? t("With the GPU this runs at roughly the length of the video.")
              : t("On CPU this takes about 1.5× the length of the video. You can keep using the app.")}
          </span>

          {isProcessing && progressPct !== null && (
            <div style={{ width: 260 }}>
              <div style={styles.track}>
                <div
                  style={{
                    ...styles.fill,
                    width: `${Math.min(100, Math.max(0, progressPct))}%`,
                  }}
                />
              </div>
              <span className="u-meta">{progressPct.toFixed(0)}%</span>
            </div>
          )}
        </div>

        {isProcessing && statusText && <span className="u-meta">{statusText}</span>}
      </div>

      <div style={styles.grid}>
        {vods.length === 0 && !isProcessing && (
          <EmptyState
            icon={<Film size={30} color="var(--faint)" />}
            title={t("No videos analysed yet")}
            text={t("Import a match recording and it comes back with the moments worth looking at.")}
          />
        )}

        {vods.map((vod) => (
          <div key={vod.id} className="card" style={styles.card}>
            <div style={styles.cardInfo}>
              <span style={styles.cardTitle}>{vod.champion}</span>
              <span className="u-meta">{vod.date}</span>
            </div>
            <div style={styles.cardActions}>
              <Button variant="ghost" size="sm" icon={<Play size={14} />} onClick={() => onSelectMatch(vod)}>
                {t("Play")}
              </Button>
              <Button
                variant="icon"
                size="sm"
                title={t("Reveal in folder")}
                aria-label={t("Reveal in folder")}
                onClick={() => handleReveal(vod)}
                icon={<FolderOpen size={15} />}
              />
              <Button
                variant="danger"
                size="sm"
                title={t("Delete analysis")}
                aria-label={t("Delete analysis")}
                onClick={() => handleDelete(vod)}
                icon={<Trash2 size={15} />}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    // El mismo contenedor que Clips y Errores. Antes iba a `10%` de padding
    // lateral, así que esta pantalla se veía más estrecha que todas las demás.
    padding: "var(--space-6) var(--space-8)",
    height: "100%",
    display: "flex",
    flexDirection: "column",
    boxSizing: "border-box",
    overflowY: "auto",
    background: "transparent",
  },
  header: {
    marginBottom: "var(--space-5)",
  },
  pageTitle: {
    margin: 0,
    fontSize: "var(--font-xl)",
  },
  pageSubtitle: {
    margin: "var(--space-2) 0 0 0",
    fontSize: "var(--font-sm)",
    color: "var(--muted)",
    maxWidth: "62ch",
  },
  actionRow: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-4)",
    padding: "var(--space-3) 0",
    borderTop: "1px solid var(--line-soft)",
    borderBottom: "1px solid var(--line-soft)",
    marginBottom: "var(--space-5)",
  },
  actionCol: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
  },
  buttonRow: {
    display: "flex",
    gap: "var(--space-3)",
    alignItems: "center",
  },
  importBtn: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    padding: "var(--space-2) var(--space-5)",
    background: "var(--action)",
    color: "var(--on-action)",
    border: "none",
    borderRadius: "var(--radius-md)",
    fontWeight: 600,
    fontSize: "var(--font-sm)",
    cursor: "pointer",
  },
  gpuBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontFamily: "var(--font-mono)",
    fontSize: "10px",
    letterSpacing: "0.08em",
    color: "var(--cool)",
    background: "color-mix(in srgb, var(--cool) 12%, transparent)",
    border: "1px solid color-mix(in srgb, var(--cool) 30%, transparent)",
    borderRadius: "var(--radius-sm)",
    padding: "3px 8px",
    maxWidth: 280,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  track: {
    height: 4,
    borderRadius: "var(--radius-full)",
    background: "var(--sunken)",
    overflow: "hidden",
    boxShadow: "var(--inset-sunken)",
  },
  fill: {
    height: "100%",
    // Violeta: es el tinte de lo que encuentra el analizador.
    background: "var(--flag)",
    borderRadius: "var(--radius-full)",
    transition: "width 0.3s linear",
  },
  grid: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
  },
  card: {
    padding: "var(--space-3) var(--space-4)",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "var(--space-4)",
  },
  cardInfo: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    minWidth: 0,
  },
  cardTitle: {
    fontSize: "var(--font-sm)",
    fontWeight: 600,
    color: "var(--text)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  cardActions: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    flexShrink: 0,
  },
};
