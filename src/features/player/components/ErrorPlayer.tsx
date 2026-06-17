import React, { useRef, useState, useEffect, useCallback } from "react";
import { ErrorClipMetadata, addErrorEvent, deleteErrorEvent, editErrorEvent } from "../../../core/tauri-ipc";
import { 
  Play, Pause, VolumeX, Volume1, Volume2, Maximize, 
  ChevronLeft, Plus, Target, Focus, BrainCircuit, Flag, Edit2, Trash2
} from "lucide-react";
import { useDialog } from "../../../components/ui/DialogProvider";
import { motion, AnimatePresence } from "framer-motion";

const streamUrl = (path: string): string => `http://stream.localhost/${encodeURIComponent(path)}`;

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
  const [volume] = useState<number>(0.5);
  const [muted, setMuted] = useState<boolean>(false);
  const playbackRate = 1;
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  
  // Annotation state
  const [activeEventId, setActiveEventId] = useState<string | null>(null);
  const [isAddingMode, setIsAddingMode] = useState<boolean>(false);
  const [editEventId, setEditEventId] = useState<string | null>(null);
  const [noteText, setNoteText] = useState<string>("");
  const [noteCategory, setNoteCategory] = useState<string>("Positioning");

  const { showError, showSuccess } = useDialog();

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
    seekTo(Math.max(0, eventTime - 2), true); // Saltamos 2s antes
  }, [seekTo]);

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

  const formatTime = (seconds: number): string => {
    if (!isFinite(seconds) || seconds < 0) seconds = 0;
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const handleSaveNote = async () => {
    if (!noteText.trim()) return;
    try {
      if (editEventId) {
        await editErrorEvent(clip.path, editEventId, noteText, noteCategory);
        showSuccess("Anotación actualizada");
      } else {
        await addErrorEvent(clip.path, currentTime, noteText, noteCategory);
        showSuccess("Anotación guardada");
      }
      setIsAddingMode(false);
      setEditEventId(null);
      setNoteText("");
      onUpdate(); // Reload clip metadata
    } catch (e) {
      showError("Error al guardar: " + e);
    }
  };

  const handleDeleteNote = async (id: string) => {
    try {
      await deleteErrorEvent(clip.path, id);
      showSuccess("Anotación eliminada");
      onUpdate();
    } catch (e) {
      showError("Error al eliminar: " + e);
    }
  };

  const categoryConfig: Record<string, { color: string, icon: React.ReactNode }> = {
    "Positioning": { color: "var(--accent-teal)", icon: <Target size={14} /> },
    "Mechanics": { color: "var(--accent-violet)", icon: <Focus size={14} /> },
    "Decision Making": { color: "var(--accent-gold)", icon: <BrainCircuit size={14} /> },
    "Other": { color: "var(--text-muted)", icon: <Flag size={14} /> }
  };

  const events = clip.events || [];

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
              <ChevronLeft size={20} /> Volver a Galería
            </button>
            <div style={{ color: "#fff", fontWeight: "bold" }}>{clip.name}</div>
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
          <div style={styles.videoProgressWrapper}>
            <button onClick={handlePlayPause} style={styles.videoPlayBtn}>
              {isPlaying ? <Pause fill="currentColor" size={16} /> : <Play fill="currentColor" size={16} />}
            </button>
            <div style={styles.volumeContainer}>
              <button onClick={() => setMuted(!muted)} style={styles.videoPlayBtn}>
                {muted || volume === 0 ? <VolumeX size={20} /> : volume < 0.5 ? <Volume1 size={20} /> : <Volume2 size={20} />}
              </button>
            </div>
            <span style={styles.videoTime}>{formatTime(currentTime)} / {formatTime(duration)}</span>
            
            <div style={{ marginLeft: "auto", display: "flex", gap: "8px" }}>
              <button onClick={() => { videoRef.current?.pause(); setIsAddingMode(true); setEditEventId(null); setNoteText(""); }} style={styles.addBtn}>
                <Plus size={14} /> Añadir Nota
              </button>
              <button onClick={toggleFullscreen} style={styles.videoPlayBtn}><Maximize size={16} /></button>
            </div>
          </div>
        </div>

        {!isFullscreen && (
        <div style={styles.timelineArea}>
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
              position: "absolute", top: 0, bottom: 0, width: "2px", 
              backgroundColor: "#fff", left: `${duration > 0 ? (currentTime / duration) * 100 : 0}%`, 
              boxShadow: "0 0 8px rgba(255,255,255,0.8)", zIndex: 5, pointerEvents: "none" 
            }} />
          </div>
        </div>
        )}
      </div>

      {!isFullscreen && (
      <div style={styles.rightColumn}>
        <div style={styles.reviewHeader}>
          <span style={styles.reviewTitle}>Libreta de Errores</span>
        </div>

        <div style={styles.reviewList}>
          {events.length === 0 && !isAddingMode && (
             <div style={{ textAlign: "center", color: "var(--text-muted)", marginTop: "40px", fontSize: "14px" }}>
               No hay anotaciones en este clip. Pausa el video y haz clic en "Añadir Nota".
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
                <div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "8px" }}>
                  Anotando en {formatTime(currentTime)}
                </div>
                <select 
                  value={noteCategory} 
                  onChange={e => setNoteCategory(e.target.value)}
                  style={styles.select}
                >
                  <option value="Positioning">Posicionamiento</option>
                  <option value="Mechanics">Mecánicas</option>
                  <option value="Decision Making">Toma de Decisiones</option>
                  <option value="Other">Otro</option>
                </select>
                <textarea 
                  autoFocus
                  placeholder="¿Qué falló aquí? ¿Qué podrías haber hecho mejor?"
                  value={noteText}
                  onChange={e => setNoteText(e.target.value)}
                  style={styles.textarea}
                  rows={4}
                />
                <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "8px" }}>
                  <button onClick={() => { setIsAddingMode(false); setEditEventId(null); }} style={styles.cancelBtn}>Cancelar</button>
                  <button onClick={handleSaveNote} style={styles.saveBtn}>Guardar</button>
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
                    backgroundColor: isActive ? "hsla(0,0%,100%,0.08)" : "hsla(0,0%,100%,0.03)",
                  }}
                  onClick={() => jumpToEvent(ev.time, ev.id)}
                >
                  <div style={styles.reviewCardHeader}>
                    <span style={{ color: "var(--text-muted)", fontSize: "10px", fontWeight: "bold" }}>
                      {formatTime(ev.time)}
                    </span>
                    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                      <div style={{...styles.toneBadge, color: conf.color, backgroundColor: `${conf.color}22`}}>
                        {conf.icon} <span style={{fontSize: "10px", fontWeight: "bold"}}>{ev.category}</span>
                      </div>
                      <button onClick={(e) => { e.stopPropagation(); setEditEventId(ev.id); setNoteText(ev.text); setNoteCategory(ev.category); seekTo(ev.time, false); setIsAddingMode(true); }} style={styles.iconBtn}>
                        <Edit2 size={12} />
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); handleDeleteNote(ev.id); }} style={{...styles.iconBtn, color: "var(--color-defeat)"}}>
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
  container: { display: "flex", width: "100%", height: "100%", backgroundColor: "#000", overflow: "hidden" },
  leftColumn: { flex: 1, display: "flex", flexDirection: "column", position: "relative" },
  videoWrapper: { flex: 1, position: "relative", backgroundColor: "#000", display: "flex", flexDirection: "column" },
  topBar: { position: "absolute", top: 0, left: 0, right: 0, padding: "16px", background: "linear-gradient(180deg, rgba(0,0,0,0.8) 0%, transparent 100%)", display: "flex", justifyContent: "space-between", alignItems: "center", zIndex: 10 },
  backBtn: { background: "transparent", color: "var(--text-secondary)", border: "none", display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontWeight: "bold" },
  video: { width: "100%", height: "100%", objectFit: "contain", flex: 1 },
  videoProgressWrapper: {
    position: "absolute", bottom: 0, left: 0, right: 0, padding: "16px 20px",
    background: "linear-gradient(0deg, rgba(0,0,0,0.8) 0%, transparent 100%)",
    display: "flex", alignItems: "center", gap: "16px", zIndex: 20,
  },
  videoPlayBtn: { background: "transparent", border: "none", color: "#fff", cursor: "pointer", display: "flex" },
  volumeContainer: { display: "flex", alignItems: "center", gap: "8px" },
  videoTime: { color: "#fff", fontSize: "13px", fontWeight: 600, fontVariantNumeric: "tabular-nums" },
  timelineArea: { height: "60px", backgroundColor: "var(--bg-panel)", borderTop: "1px solid var(--border-subtle)", padding: "26px 32px" },
  timelineGraph: { position: "relative", height: "8px", backgroundColor: "var(--bg-card)", borderRadius: "4px", cursor: "pointer" },
  rightColumn: { width: "340px", backgroundColor: "var(--bg-sidebar)", display: "flex", flexDirection: "column", borderLeft: "1px solid var(--border-subtle)", overflow: "hidden" },
  reviewHeader: { padding: "20px 24px", borderBottom: "1px solid var(--border-subtle)", display: "flex" },
  reviewTitle: { fontSize: "18px", fontWeight: 800, color: "#fff" },
  reviewList: { flex: 1, overflowY: "auto", padding: "16px", display: "flex", flexDirection: "column", gap: "12px" },
  reviewCard: { padding: "12px", borderRadius: "8px", border: "1px solid var(--border-subtle)", cursor: "pointer", transition: "all 0.2s" },
  reviewCardHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" },
  toneBadge: { padding: "2px 8px", borderRadius: "12px", display: "flex", alignItems: "center", gap: "4px" },
  reviewCardBody: { fontSize: "13px", color: "var(--text-secondary)", lineHeight: 1.5 },
  reviewCardTitle: { wordBreak: "break-word" },
  addBtn: { background: "var(--accent-violet)", color: "#fff", border: "none", padding: "6px 12px", borderRadius: "6px", fontSize: "12px", fontWeight: "bold", display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" },
  addForm: { backgroundColor: "var(--bg-card)", padding: "16px", borderRadius: "8px", border: "1px solid var(--accent-violet)" },
  select: { width: "100%", padding: "8px", borderRadius: "6px", backgroundColor: "var(--bg-app)", color: "#fff", border: "1px solid var(--border-subtle)", marginBottom: "8px", outline: "none" },
  textarea: { width: "100%", boxSizing: "border-box", padding: "10px", borderRadius: "6px", backgroundColor: "var(--bg-app)", color: "#fff", border: "1px solid var(--border-subtle)", outline: "none", resize: "vertical", fontFamily: "inherit", fontSize: "13px" },
  cancelBtn: { background: "transparent", color: "var(--text-muted)", border: "none", padding: "6px 12px", cursor: "pointer", fontSize: "12px", fontWeight: "bold" },
  saveBtn: { background: "var(--accent-violet)", color: "#fff", border: "none", padding: "6px 16px", borderRadius: "6px", cursor: "pointer", fontSize: "12px", fontWeight: "bold" },
  iconBtn: { background: "transparent", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: "4px", display: "flex" }
};
