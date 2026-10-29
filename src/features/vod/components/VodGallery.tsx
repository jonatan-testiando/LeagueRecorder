import React, { useState, useEffect, useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { processVod, cancelVod } from "../../../core/tauri-ipc";
import { MatchMetadata } from "../../../types";
import { Film, Upload, Play, Trash2, X, FolderOpen, Zap } from "lucide-react";
import { Button } from "../../../components/ui/Button";
import { Chip } from "../../../components/ui/Chip";
import { EmptyState } from "../../../components/ui/EmptyState";
import { useDialog } from "../../../components/ui/DialogProvider";
import { useT } from "../../../core/LanguageProvider";
import { clock, matchAge } from "../../../core/time";
import { ScreenTitle } from "../../../components/ScreenTitle";
import "./VodGallery.css";

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
      message: t("This permanently deletes the analysis of {name} and everything found in it. The original video file is not touched.", { name: fileName(vod.video_path) || vod.champion }),
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
  // Hasta el primer porcentaje (el modelo tarda en cargar) la barra está a 0:
  // es lo que hay, y el texto de estado de debajo dice en qué anda.
  const pct = Math.min(100, Math.max(0, progressPct ?? 0));

  return (
    // Sin `panel-enter`: el envoltorio del panel en App.tsx ya hace el fundido
    // de entrada, y con los dos la pantalla entraba dos veces.
    <div className="vod">
      <div className="vod__col">
        {/* El título, en la barra (piel A); la entradilla, aquí. */}
        <ScreenTitle align="form" title={t("Video analysis")} />
        <p className="vod__sub t-body">
          {t("Import a video and it reads the cursor and the clicks frame by frame, the same way it does with your own recordings.")}
        </p>

        <section className="card vod-import" aria-busy={isProcessing || undefined}>
          <div className="vod-import__row">
            <Button variant="primary" icon={<Upload size={16} />} onClick={handleImport} disabled={isProcessing}>
              {isProcessing ? t("Analysing…") : t("Import video")}
            </Button>
            {/* La insignia de GPU se queda puesta cuando el backend la anuncia:
                saber con qué se analiza es lo que explica el tiempo de espera. */}
            {gpu && (
              <Chip tone="outline" icon={<Zap size={12} />} title={hardwareInfo} className="vod-gpu">
                <span className="vod-gpu__text">{t("GPU")} · {hardwareInfo}</span>
              </Chip>
            )}
          </div>

          {/* Lo que de verdad se pregunta al pulsar: cuánto va a tardar. */}
          <p className="vod-import__hint t-small">
            {gpu
              ? t("With the GPU this runs at roughly the length of the video.")
              : t("On CPU this takes about 1.5× the length of the video. You can keep using the app.")}
          </p>

          {/* Tarda minutos: barra con porcentaje, no un icono girando. */}
          {isProcessing && (
            <div className="vod-progress">
              <div className="vod-progress__bar">
                <div
                  className="vod-progress__track"
                  role="progressbar"
                  aria-label={t("Analysing the video…")}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(pct)}
                >
                  <span className="vod-progress__fill" style={{ "--p": pct / 100 } as React.CSSProperties} />
                </div>
                <span className="vod-progress__pct t-small-strong">{pct.toFixed(0)}%</span>
              </div>
              <div className="vod-progress__foot">
                <span className="vod-progress__status t-small" title={statusText}>{statusText}</span>
                <Button variant="danger" size="sm" icon={<X size={14} />} onClick={handleCancel}>
                  {t("Cancel")}
                </Button>
              </div>
            </div>
          )}
        </section>

        {vods.length === 0 && !isProcessing && (
          <EmptyState
            icon={<Film />}
            title={t("No videos analysed yet")}
            text={t("Import a match recording and it comes back with the moments worth looking at.")}
          />
        )}

        {vods.length > 0 && (
          <section className="vod-list">
            <h2 className="vod-list__label t-small-strong">
              {t("Analysed videos")}
              <span className="vod-list__count">{vods.length}</span>
            </h2>
            <div className="card vod-rows">
              {vods.map((vod) => {
                const name = fileName(vod.video_path) || vod.champion;
                return (
                  <div key={vod.id} className="vod-row">
                    <span className="vod-row__icon" aria-hidden="true">
                      <Film size={16} />
                    </span>
                    <div className="vod-row__main">
                      <span className="vod-row__name t-body-strong" title={vod.video_path}>{name}</span>
                      <span className="vod-row__meta t-small">
                        {matchAge(vod.date, t)} · {clock(vod.game_duration)}
                      </span>
                    </div>
                    <div className="vod-row__actions">
                      <Button size="sm" icon={<Play size={14} />} onClick={() => onSelectMatch(vod)}>
                        {t("Play")}
                      </Button>
                      <Button
                        variant="icon"
                        title={t("Reveal in folder")}
                        aria-label={t("Reveal in folder")}
                        onClick={() => handleReveal(vod)}
                        icon={<FolderOpen size={16} />}
                      />
                      <Button
                        variant="danger"
                        className="vod-row__del"
                        title={t("Delete analysis")}
                        aria-label={t("Delete analysis")}
                        onClick={() => handleDelete(vod)}
                        icon={<Trash2 size={16} />}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
};

/**
 * Nombre del fichero de vídeo, sin carpeta. El backend guarda «VOD Analysis»
 * como campeón de todos los análisis, así que la lista eran filas iguales:
 * el nombre del fichero es lo único que las distingue.
 */
const fileName = (p: string): string => p.split(/[\\/]/).pop() ?? "";
