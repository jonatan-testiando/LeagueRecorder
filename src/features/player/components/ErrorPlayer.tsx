import React, { useRef, useState, useEffect, useCallback } from "react";
import { ErrorClipMetadata, addErrorEvent, deleteErrorEvent, editErrorEvent } from "../../../core/tauri-ipc";
import { 
  Play, Pause, VolumeX, Volume1, Volume2, Maximize, 
  ChevronLeft, Plus, Target, Focus, BrainCircuit, Flag, Edit2, Trash2,
  SkipBack, SkipForward, Clock3
} from "lucide-react";
import { useDialog } from "../../../components/ui/DialogProvider";
import { motion, AnimatePresence } from "framer-motion";
import { mix } from "../../../core/color";
import { useT } from "../../../core/LanguageProvider";

import { clock } from "../../../core/time";

import { streamUrl } from "../../../core/media";

/**
 * Las categorías de error, en el orden en que se ofrecen.
 *
 * Estos valores son IDENTIFICADORES, no texto: es lo que se guarda en el JSON
 * del clip y lo que agrupa el gráfico de Patrones, así que no se traducen al
 * escribirlos. Se traducen al PINTARLOS, aquí, en la galería y en Patrones —
 * que es también por qué viven en un solo sitio.
 */
export const ERROR_CATEGORIES: string[] = [
  "Positioning",
  "Mechanics",
  "Decision Making",
  "Other",
];

/** Velocidades del transporte. Las mismas que el reproductor principal. */
const RATES = [0.25, 0.5, 1, 2];

interface ErrorPlayerProps {
  clip: ErrorClipMetadata;
  onUpdate: () => void;
  onClose: () => void;
}

export const ErrorPlayer: React.FC<ErrorPlayerProps> = ({ clip, onUpdate, onClose }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  // El volumen y la velocidad eran constantes: el deslizador y el selector no
  // existían, así que un clip con el audio alto solo se podía silenciar entero
  // y una mecánica no se podía ver a cámara lenta, que es justo para lo que se
  // guarda un error.
  const [volume, setVolume] = useState<number>(0.5);
  const [muted, setMuted] = useState<boolean>(false);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  // Annotation state
  const [activeEventId, setActiveEventId] = useState<string | null>(null);
  const [isAddingMode, setIsAddingMode] = useState<boolean>(false);
  const [editEventId, setEditEventId] = useState<string | null>(null);
  const [noteText, setNoteText] = useState<string>("");
  const [noteCategory, setNoteCategory] = useState<string>("Positioning");
  /**
   * Instante al que se anclará la nota que se está escribiendo.
   *
   * Antes se leía `currentTime` en el momento de guardar, así que una nota
   * editada se re-anclaba sola al sitio donde estuviera el vídeo. Ahora es
   * estado, y el botón "usar el instante actual" lo mueve a propósito.
   */
  const [noteTime, setNoteTime] = useState<number>(0);

  const { showError, showSuccess, showConfirm } = useDialog();
  const t = useT();

  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.volume = volume;
      videoRef.current.muted = muted;
    }
  }, [volume, muted]);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate]);

  const handlePlayPause = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }, []);

  const seekTo = useCallback((seconds: number, play: boolean) => {
    const v = videoRef.current;
    if (!v) return;
    const target = Math.max(0, Math.min(seconds, duration || seconds));
    v.currentTime = target;
    setCurrentTime(target);
    if (play && v.paused) v.play().catch(() => {});
  }, [duration]);

  const jumpToEvent = useCallback((eventTime: number, eventId: string) => {
    setActiveEventId(eventId);
    seekTo(Math.max(0, eventTime - 5), true); // Saltamos 5s antes
  }, [seekTo]);

  /**
   * Salta a la nota anterior o siguiente.
   *
   * En un clip de error las notas SON los puntos de interés, así que el
   * transporte se mueve entre ellas y no de diez en diez segundos.
   */
  const stepNote = useCallback((dir: 1 | -1) => {
    const times = (clip.events ?? []).map((e) => e.time).sort((a, b) => a - b);
    if (times.length === 0) return;
    const cur = videoRef.current?.currentTime ?? 0;
    // Margen de medio segundo para no quedarse clavado en la nota actual.
    const next = dir === 1
      ? times.find((t) => t > cur + 0.5)
      : [...times].reverse().find((t) => t < cur - 0.5);
    if (next === undefined) return;
    const ev = (clip.events ?? []).find((e) => e.time === next);
    if (ev) jumpToEvent(ev.time, ev.id);
  }, [clip.events, jumpToEvent]);

  const toggleFullscreen = () => {
    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) el.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.().catch(() => {});
  };

  const handleTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;
    setCurrentTime(v.currentTime);
  };

  const updateScrub = (clientX: number, playAfter: boolean) => {
    if (progressBarRef.current && duration > 0) {
      const rect = progressBarRef.current.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      seekTo(pct * duration, playAfter);
    }
  };

  /** Abre el formulario en blanco, anclado al instante actual. */
  const startAdding = useCallback(() => {
    videoRef.current?.pause();
    setEditEventId(null);
    setNoteText("");
    setNoteCategory("Positioning");
    setNoteTime(videoRef.current?.currentTime ?? currentTime);
    setIsAddingMode(true);
  }, [currentTime]);

  const handleSaveNote = async () => {
    if (!noteText.trim()) return;
    try {
      if (editEventId) {
        // `edit_error_event` ya acepta el instante, así que mover el ancla es
        // una edición y no un borrar-y-volver-a-poner. Con lo de antes la nota
        // cambiaba de id cada vez que se reanclaba, y quien la tuviera
        // referenciada (la cola de revisión) se quedaba apuntando a nada.
        await editErrorEvent(clip.path, editEventId, noteText, noteCategory, noteTime);
        showSuccess(t("Note updated"));
      } else {
        await addErrorEvent(clip.path, noteTime, noteText, noteCategory);
        showSuccess(t("Note saved"));
      }
      setIsAddingMode(false);
      setEditEventId(null);
      setNoteText("");
      onUpdate(); // Reload clip metadata
    } catch (e) {
      showError(t("Couldn't save the note: {msg}", { msg: String(e) }));
    }
  };

  const handleDeleteNote = async (id: string) => {
    const ok = await showConfirm({
      title: t("Delete note"),
      message: t("This note is deleted for good. The clip stays."),
      confirmText: t("Delete"),
      cancelText: t("Cancel"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteErrorEvent(clip.path, id);
      showSuccess(t("Note deleted"));
      onUpdate();
    } catch (e) {
      showError(t("Couldn't delete the note: {msg}", { msg: String(e) }));
    }
  };

  const categoryConfig: Record<string, { color: string, icon: React.ReactNode }> = {
    "Positioning": { color: "var(--cool)", icon: <Target size={14} /> },
    "Mechanics": { color: "var(--flag)", icon: <Focus size={14} /> },
    "Decision Making": { color: "var(--brand)", icon: <BrainCircuit size={14} /> },
    "Other": { color: "var(--faint)", icon: <Flag size={14} /> }
  };

  const events = clip.events || [];

  /**
   * Atajos de teclado, los mismos que el reproductor principal: Espacio y K
   * para pausar, flechas para moverse cinco segundos, M para silenciar.
   *
   * No se disparan mientras se escribe una nota: en un `textarea` la barra
   * espaciadora es una barra espaciadora.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const escribiendo =
        !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
      if (escribiendo) return;
      const v = videoRef.current;
      if (!v) return;
      switch (e.key) {
        case " ":
        case "k":
        case "K":
          e.preventDefault();
          handlePlayPause();
          break;
        case "ArrowLeft":
          e.preventDefault();
          seekTo(v.currentTime - 5, false);
          break;
        case "ArrowRight":
          e.preventDefault();
          seekTo(v.currentTime + 5, false);
          break;
        case "m":
        case "M":
          e.preventDefault();
          setMuted((prev) => !prev);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handlePlayPause, seekTo]);

  return (
    <motion.div 
      ref={containerRef} 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      style={styles.container}
    >
      <div style={styles.leftColumn}>
        <div style={styles.videoWrapper}>
          <div style={styles.topBar}>
            <button style={styles.backBtn} onClick={onClose}>
              <ChevronLeft size={20} /> {t("Back")}
            </button>
            {/* El título era el nombre del .mp4 en crudo. Un nombre de fichero
                no es información: lo que identifica a este clip es qué error es
                y en qué minuto de la partida ocurre. */}
            <div style={styles.titleBlock}>
              <span style={styles.title}>
                {clip.events?.[0]?.category ? t(clip.events[0].category) : t("Flagged error")}
              </span>
              {clip.start_time !== undefined && clip.start_time !== null && (
                <span className="u-meta" style={{ marginTop: 2 }}>
                  {t("at {t} in the game", { t: clock(clip.start_time) })}
                </span>
              )}
            </div>
            <div style={{ width: "120px" }}></div>
          </div>

          <video
            ref={videoRef}
            src={streamUrl(clip.path)}
            style={styles.video}
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={() => setDuration(videoRef.current?.duration || 0)}
            onClick={handlePlayPause}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            preload="auto"
          />
        </div>

        {/* Transporte y tira, una sola pieza: igual que en el reproductor
            principal, eran una barra flotando sobre el vídeo y una tira separada
            más abajo, o sea la misma herramienta partida en dos. */}
        {!isFullscreen && (
        <div style={styles.deck}>
          <div className="tp" style={styles.transport}>
            <button
              className="tp-b"
              onClick={() => stepNote(-1)}
              disabled={events.length === 0}
              title={t("Previous note")}
              aria-label={t("Previous note")}
            >
              <SkipBack size={14} fill="currentColor" />
            </button>
            <button
              className="tp-b tp-b--primary"
              onClick={handlePlayPause}
              title={t(isPlaying ? "Pause" : "Play")}
              aria-label={t(isPlaying ? "Pause" : "Play")}
            >
              {isPlaying ? <Pause fill="currentColor" size={15} /> : <Play fill="currentColor" size={15} />}
            </button>
            <button
              className="tp-b"
              onClick={() => stepNote(1)}
              disabled={events.length === 0}
              title={t("Next note")}
              aria-label={t("Next note")}
            >
              <SkipForward size={14} fill="currentColor" />
            </button>

            <span className="tp-tc">
              <b>{clock(currentTime)}.{String(Math.floor((currentTime % 1) * 100)).padStart(2, "0")}</b>
              <span className="tp-tc__total"> / {clock(duration)}</span>
            </span>

            {/* Segmentado y no desplegable, igual que en el reproductor
                principal: en una revisión la velocidad se cambia todo el rato. */}
            <span className="tp-seg" role="group" aria-label={t("Playback speed")}>
              {RATES.map((r) => (
                <button
                  key={r}
                  onClick={() => setPlaybackRate(r)}
                  aria-pressed={playbackRate === r}
                  data-on={playbackRate === r ? "" : undefined}
                >
                  {r}&times;
                </button>
              ))}
            </span>

            <span style={{ flex: 1, minWidth: 12 }} />

            <button
              className="btn btn--ghost btn--sm"
              onClick={startAdding}
              title={t("Write a note at the current time")}
            >
              <Plus size={13} /> {t("Add note")}
            </button>

            <div className="tp-vol">
              <button
                className="tp-b"
                onClick={() => setMuted(!muted)}
                title={t(muted ? "Unmute" : "Mute")}
                aria-label={t(muted ? "Unmute" : "Mute")}
              >
                {muted || volume === 0 ? <VolumeX size={15} /> : volume < 0.5 ? <Volume1 size={15} /> : <Volume2 size={15} />}
              </button>
              {/* Faltaba el deslizador entero: el botón silenciaba, y eso era
                  todo el control de volumen que había. */}
              <input
                type="range" min="0" max="1" step="0.05"
                value={muted ? 0 : volume}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  setVolume(v);
                  if (v > 0 && muted) setMuted(false);
                }}
                aria-label={t("Volume")}
                style={styles.volumeSlider}
              />
            </div>
            <button className="tp-b" onClick={toggleFullscreen} title={t("Fullscreen")} aria-label={t("Fullscreen")}>
              <Maximize size={15} />
            </button>
          </div>

          <div 
            style={styles.timelineGraph} 
            ref={progressBarRef} 
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              updateScrub(e.clientX, !videoRef.current?.paused);
            }}
            onPointerMove={(e) => {
              if (e.buttons === 1) updateScrub(e.clientX, false);
            }}
          >
            {events.map((ev) => {
              const pos = duration > 0 ? (ev.time / duration) * 100 : 0;
              const conf = categoryConfig[ev.category] || categoryConfig["Other"];
              const isActive = ev.id === activeEventId;
              return (
                <div
                  key={ev.id}
                  onClick={(e) => { e.stopPropagation(); jumpToEvent(ev.time, ev.id); }}
                  style={{
                    position: "absolute",
                    top: "50%",
                    left: `${pos}%`,
                    width: "14px",
                    height: "14px",
                    borderRadius: "50%",
                    backgroundColor: isActive ? conf.color : "var(--bg-app)",
                    border: `2px solid ${conf.color}`,
                    transform: `translate(-50%, -50%) scale(${isActive ? 1.3 : 1})`,
                    cursor: "pointer",
                    zIndex: 10,
                    transition: "all 0.2s ease"
                  }}
                  title={ev.text}
                />
              );
            })}
            <div style={{ 
              position: "absolute", top: -3, bottom: -3, width: "1.5px", 
              backgroundColor: "var(--signal)", left: `${duration > 0 ? (currentTime / duration) * 100 : 0}%`, zIndex: 5, pointerEvents: "none" 
            }} />
          </div>
        </div>
        )}
      </div>

      {!isFullscreen && (
      <div style={styles.rightColumn}>
        <div style={styles.reviewHeader}>
          <span style={styles.reviewTitle}>{t("Error Notebook")}</span>
        </div>

        <div style={styles.reviewList}>
          {events.length === 0 && !isAddingMode && (
             <div style={{ textAlign: "center", color: "var(--text-muted)", marginTop: "40px", fontSize: "14px" }}>
               {t("No notes on this clip yet. Pause the video and add one.")}
             </div>
          )}

          <AnimatePresence mode="popLayout">
            {isAddingMode && (
              <motion.div 
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                style={styles.addForm}
              >
                {/* El instante al que se ancla la nota, y cómo moverlo. Antes
                    se leía el reloj al guardar, así que editar una nota vieja la
                    arrastraba al punto donde estuviera el vídeo. */}
                <div style={styles.noteTimeRow}>
                  <span className="u-meta">{t("Note at")}</span>
                  <span className="u-metric" style={{ fontSize: 12 }}>{clock(noteTime)}</span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => setNoteTime(videoRef.current?.currentTime ?? currentTime)}
                    title={t("Anchor this note to where the video is now")}
                  >
                    <Clock3 size={12} /> {t("Use current time")}
                  </button>
                </div>
                <select
                  value={noteCategory}
                  onChange={e => setNoteCategory(e.target.value)}
                  aria-label={t("Error category")}
                  style={styles.select}
                >
                  {/* El VALOR es el identificador en inglés, que es lo que se
                      guarda; la etiqueta va traducida. */}
                  {ERROR_CATEGORIES.map((c) => (
                    <option key={c} value={c}>{t(c)}</option>
                  ))}
                </select>
                <textarea
                  autoFocus
                  placeholder={t("What went wrong here? What could you have done better?")}
                  value={noteText}
                  onChange={e => setNoteText(e.target.value)}
                  style={styles.textarea}
                  rows={4}
                />
                <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "8px" }}>
                  <button onClick={() => { setIsAddingMode(false); setEditEventId(null); }} className="btn-ghost" style={styles.cancelBtn}>{t("Cancel")}</button>
                  <button onClick={handleSaveNote} style={styles.saveBtn}>{t("Save")}</button>
                </div>
              </motion.div>
            )}

            {!isAddingMode && events.map((ev) => {
              const conf = categoryConfig[ev.category] || categoryConfig["Other"];
              const isActive = ev.id === activeEventId;
              
              return (
                <motion.div 
                  key={ev.id}
                  layout
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  style={{
                    ...styles.reviewCard,
                    borderColor: isActive ? conf.color : "var(--border-subtle)",
                    backgroundColor: isActive ? "var(--raised)" : "transparent",
                  }}
                  onClick={() => jumpToEvent(ev.time, ev.id)}
                >
                  <div style={styles.reviewCardHeader}>
                    <span style={{ color: "var(--text-muted)", fontSize: "10px", fontWeight: "bold" }}>
                      {clock(ev.time)}
                    </span>
                    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                      <div style={{...styles.toneBadge, color: conf.color, backgroundColor: mix(conf.color, 13)}}>
                        {conf.icon} <span style={{fontSize: "10px", fontWeight: "bold"}}>{t(ev.category)}</span>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditEventId(ev.id);
                          setNoteText(ev.text);
                          setNoteCategory(ev.category);
                          setNoteTime(ev.time);
                          seekTo(ev.time, false);
                          setIsAddingMode(true);
                        }}
                        style={styles.iconBtn}
                        title={t("Edit note")}
                        aria-label={t("Edit note")}
                      >
                        <Edit2 size={12} />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteNote(ev.id); }}
                        style={{...styles.iconBtn, color: "var(--signal)"}}
                        title={t("Delete note")}
                        aria-label={t("Delete note")}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                  <div style={styles.reviewCardBody}>
                    <span style={styles.reviewCardTitle}>{ev.text}</span>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </div>
      )}
    </motion.div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  container: { display: "flex", width: "100%", height: "100%", backgroundColor: "var(--sunken)", overflow: "hidden" },
  leftColumn: { flex: 1, display: "flex", flexDirection: "column", position: "relative" },
  videoWrapper: { flex: 1, position: "relative", backgroundColor: "var(--sunken)", display: "flex", flexDirection: "column" },
  topBar: { position: "absolute", top: 0, left: 0, right: 0, padding: "var(--space-3) var(--space-4)", background: "linear-gradient(180deg, rgba(0,0,0,0.75) 0%, transparent 100%)", display: "flex", justifyContent: "space-between", alignItems: "flex-start", zIndex: 10 },
  titleBlock: { display: "flex", flexDirection: "column", alignItems: "center", minWidth: 0 },
  title: { fontFamily: "var(--font-mono)", fontSize: "12px", letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text)" },
  backBtn: { background: "transparent", color: "var(--text-secondary)", border: "none", display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontWeight: "bold" },
  video: { width: "100%", height: "100%", objectFit: "contain", flex: 1 },
  videoProgressWrapper: {
    position: "absolute", bottom: 0, left: 0, right: 0, padding: "16px 20px",
    background: "linear-gradient(0deg, rgba(0,0,0,0.8) 0%, transparent 100%)",
    display: "flex", alignItems: "center", gap: "16px", zIndex: 20,
  },
  videoPlayBtn: { background: "transparent", border: "none", color: "var(--text)", cursor: "pointer", display: "flex" },
  volumeContainer: { display: "flex", alignItems: "center", gap: "8px" },
  videoTime: { color: "var(--text)", fontSize: "13px", fontWeight: 600, fontVariantNumeric: "tabular-nums" },
  // Transporte y tira, una sola superficie. `--bg-panel` no existe como
  // token: se usaba en tres sitios y resolvia a nada, o sea transparente.
  deck: { background: "var(--surface-1)", borderTop: "1px solid var(--line-soft)", padding: "var(--space-3) var(--space-4) var(--space-4)", display: "flex", flexDirection: "column", gap: "var(--space-3)" },
  transport: { display: "flex", alignItems: "center", gap: "var(--space-2)", padding: "0 0 var(--space-3) 0", borderBottom: "1px solid var(--line-soft)" },
  timelineGraph: { position: "relative", height: "8px", backgroundColor: "var(--sunken)", border: "1px solid var(--line-soft)", borderRadius: "var(--radius-sm)", cursor: "pointer" },
  rightColumn: { width: "340px", backgroundColor: "var(--bg-sidebar)", display: "flex", flexDirection: "column", borderLeft: "1px solid var(--border-subtle)", overflow: "hidden" },
  reviewHeader: { padding: "20px 24px", borderBottom: "1px solid var(--border-subtle)", display: "flex" },
  reviewTitle: { fontSize: "var(--font-md)", fontWeight: 600, color: "var(--text)" },
  reviewList: { flex: 1, overflowY: "auto", padding: "16px", display: "flex", flexDirection: "column", gap: "12px" },
  reviewCard: { padding: "12px", borderRadius: "8px", border: "1px solid var(--border-subtle)", cursor: "pointer", transition: "all 0.2s" },
  reviewCardHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" },
  toneBadge: { padding: "2px 8px", borderRadius: "12px", display: "flex", alignItems: "center", gap: "4px" },
  reviewCardBody: { fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.5 },
  reviewCardTitle: { wordBreak: "break-word" },
  addForm: { backgroundColor: "var(--raised)", padding: "var(--space-4)", borderRadius: "var(--radius-md)", border: "1px solid var(--line)" },
  noteTimeRow: { display: "flex", alignItems: "center", gap: "var(--space-2)", marginBottom: "var(--space-3)", flexWrap: "wrap" },
  volumeSlider: {
    width: "80px",
    accentColor: "var(--cool)",
    cursor: "pointer",
    height: "4px",
    borderRadius: "2px",
    appearance: "none",
    background: "var(--sunken)",
    boxShadow: "var(--inset-sunken)",
  },
  select: { width: "100%", padding: "8px", borderRadius: "6px", backgroundColor: "var(--bg-app)", color: "var(--text)", border: "1px solid var(--border-subtle)", marginBottom: "8px", outline: "none" },
  textarea: { width: "100%", boxSizing: "border-box", padding: "10px", borderRadius: "6px", backgroundColor: "var(--bg-app)", color: "var(--text)", border: "1px solid var(--border-subtle)", outline: "none", resize: "vertical", fontFamily: "inherit", fontSize: "13px" },
  cancelBtn: { background: "transparent", color: "var(--text-muted)", border: "none", padding: "6px 12px", cursor: "pointer", fontSize: "12px", fontWeight: "bold" },
  saveBtn: { background: "var(--action)", color: "var(--on-action)", border: "none", padding: "6px 16px", borderRadius: "var(--radius-md)", cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: "12px", fontWeight: 600 },
  iconBtn: { background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: "4px", display: "flex" }
};
