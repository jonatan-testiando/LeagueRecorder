import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronLeft, FileWarning, Maximize, Minimize, Pause, Play, PlaySquare,
  Volume1, Volume2, VolumeX,
} from "lucide-react";
import { ClipMetadata, MatchMetadata } from "../../../types";
import { Button } from "../../../components/ui/Button";
import { Segmented } from "../../../components/ui/Segmented";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import { useT } from "../../../core/LanguageProvider";
import { streamUrl } from "../../../core/media";
import { clock, matchAge } from "../../../core/time";

/** Velocidades del transporte: las mismas que el reproductor de errores. */
const RATES = [0.25, 0.5, 1, 2];

interface ClipPlayerProps {
  clip: ClipMetadata;
  /** La partida de la que salió, si sigue en la biblioteca. */
  match?: MatchMetadata;
  onBack: () => void;
  onOpenMatch?: () => void;
}

/**
 * El reproductor de un clip suelto.
 *
 * Un clip no tiene sucesos ni notas, así que no le hace falta ni la línea de
 * tiempo de la partida ni el cuaderno del reproductor de errores: es el mismo
 * escenario y el mismo transporte (las clases `tp-*` que comparten los otros
 * dos), con lo que se usa al ver un clip: play, buscar, velocidad, volumen y
 * pantalla completa.
 *
 * Se abre desde el póster de la lista. La lista sigue montada debajo (oculta),
 * así que al volver conserva el scroll y la fila seleccionada.
 */
export const ClipPlayer: React.FC<ClipPlayerProps> = ({ clip, match, onBack, onOpenMatch }) => {
  const t = useT();
  const rootRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrubRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLSpanElement>(null);

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [volume, setVolume] = useState(0.5);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = volume;
    v.muted = muted;
  }, [volume, muted]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = rate;
  }, [rate]);

  // El foco entra en el reproductor al abrirlo: el póster que lo tenía queda
  // oculto, y sin esto el teclado volvía al principio de la ventana.
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  /**
   * La barra de progreso va por fotograma y no por `timeupdate`, que llega
   * cuatro veces por segundo y la hacía avanzar a saltos. Se escribe el
   * `scaleX` directamente en el elemento: un render de React por fotograma
   * para mover una barra es trabajo tirado.
   */
  useEffect(() => {
    if (!playing) return;
    let id = 0;
    const tick = () => {
      const v = videoRef.current;
      const fill = fillRef.current;
      if (v && fill && v.duration > 0) fill.style.transform = `scaleX(${v.currentTime / v.duration})`;
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [playing]);

  // Parado, la barra se coloca con el estado (al buscar o al cargar).
  useEffect(() => {
    if (playing || !fillRef.current) return;
    fillRef.current.style.transform = `scaleX(${duration > 0 ? currentTime / duration : 0})`;
  }, [playing, currentTime, duration]);

  /**
   * Si la sección se oculta (se cambia de pestaña en el rail con el clip
   * abierto), el vídeo se para: un `display: none` no lo pausa y seguiría
   * sonando por debajo de otra pantalla.
   */
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === 0) videoRef.current?.pause();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v || missing) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }, [missing]);

  const seekTo = useCallback((secs: number) => {
    const v = videoRef.current;
    if (!v) return;
    const d = v.duration || 0;
    const target = Math.max(0, d > 0 ? Math.min(secs, d) : secs);
    v.currentTime = target;
    setCurrentTime(target);
  }, []);

  const scrubAt = (clientX: number) => {
    const bar = scrubRef.current;
    if (!bar || duration <= 0) return;
    const r = bar.getBoundingClientRect();
    seekTo((Math.max(0, Math.min(1, (clientX - r.left) / r.width))) * duration);
  };

  const toggleFullscreen = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    else el.requestFullscreen?.().catch(() => {});
  }, []);

  /**
   * Atajos, los del resto de reproductores: Espacio o K para pausar, flechas
   * para moverse cinco segundos, M para silenciar, F para pantalla completa y
   * Esc para volver a la lista. Solo con la sección a la vista y sin escribir.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root || root.clientWidth === 0) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      // Un diálogo o la paleta abiertos encima se quedan sus teclas.
      if (document.querySelector("[role=dialog][aria-modal=true]")) return;
      // El espacio sobre un botón con foco es pulsar ese botón (Volver, una
      // velocidad), no pausar: si no, «Volver» con el teclado pausaría.
      if (e.key === " " && el?.closest("button")) return;
      const v = videoRef.current;
      switch (e.key) {
        case " ":
        case "k":
        case "K":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          if (v) seekTo(v.currentTime - 5);
          break;
        case "ArrowRight":
          e.preventDefault();
          if (v) seekTo(v.currentTime + 5);
          break;
        case "m":
        case "M":
          e.preventDefault();
          setMuted((m) => !m);
          break;
        case "f":
        case "F":
          e.preventDefault();
          toggleFullscreen();
          break;
        case "Escape":
          // En pantalla completa, Esc ya la cierra el navegador.
          if (!document.fullscreenElement) {
            e.preventDefault();
            onBack();
          }
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, seekTo, toggleFullscreen, onBack]);

  const pct = duration > 0 ? Math.round((currentTime / duration) * 100) : 0;

  return (
    <section ref={rootRef} className="cp panel-enter" aria-label={clip.name} tabIndex={-1}>
      <header className="cp-top">
        <Button variant="ghost" size="sm" icon={<ChevronLeft size={15} />} onClick={onBack} title="Esc">
          {t("Back")}
        </Button>
        <div className="cp-top__text">
          <h1 className="cp-title" title={clip.name}>{clip.name}</h1>
          <span className="cp-meta">
            {match && <ChampionAvatar champion={match.champion} size={20} />}
            <span>
              {match
                ? t("From {champion} · {date}", { champion: match.champion, date: matchAge(match.date, t) })
                : t("From {id}", { id: clip.match_id })}
            </span>
          </span>
        </div>
        {onOpenMatch && (
          <Button
            variant="ghost"
            size="sm"
            icon={<PlaySquare size={14} />}
            onClick={onOpenMatch}
            title={t("Open the game this clip came from")}
          >
            {t("Open match")}
          </Button>
        )}
      </header>

      <div className="cp-stage">
        {missing ? (
          <div className="cp-missing">
            <FileWarning size={22} aria-hidden="true" />
            <span>{t("Video file missing")}</span>
          </div>
        ) : (
          <video
            ref={videoRef}
            src={streamUrl(clip.path)}
            autoPlay
            playsInline
            preload="auto"
            onClick={togglePlay}
            onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
            onLoadedMetadata={(e) => {
              const d = e.currentTarget.duration;
              setDuration(Number.isFinite(d) ? d : 0);
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onError={() => setMissing(true)}
          />
        )}
      </div>

      <div className="cp-deck">
        <div
          ref={scrubRef}
          className="cp-scrub"
          role="slider"
          tabIndex={0}
          aria-label={t("Playback position")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-valuetext={`${clock(currentTime)} / ${clock(duration)}`}
          aria-disabled={missing || undefined}
          onPointerDown={(e) => {
            if (missing) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            scrubAt(e.clientX);
          }}
          onPointerMove={(e) => {
            if (e.buttons === 1 && e.currentTarget.hasPointerCapture(e.pointerId)) scrubAt(e.clientX);
          }}
        >
          <span className="cp-scrub__track">
            <span ref={fillRef} className="cp-scrub__fill" />
          </span>
        </div>

        <div className="tp cp-transport">
          <button
            type="button"
            className="tp-b tp-b--primary"
            onClick={togglePlay}
            disabled={missing}
            title={t(playing ? "Pause" : "Play")}
            aria-label={t(playing ? "Pause" : "Play")}
          >
            {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
          </button>

          <span className="tp-tc">
            <b>{clock(currentTime)}</b>
            <span className="tp-tc__total"> / {clock(duration)}</span>
          </span>

          <span className="cp-transport__spacer" />

          {/* Tamaño normal y no el pequeño de los otros reproductores: a 22 px
              las opciones no llegaban al mínimo de 24 para el puntero. */}
          <Segmented
            label={t("Playback speed")}
            value={rate}
            onChange={setRate}
            options={RATES.map((r) => ({ value: r, label: `${r}×` }))}
          />

          <div className="tp-vol">
            <button
              type="button"
              className="tp-b"
              onClick={() => setMuted((m) => !m)}
              title={t(muted ? "Unmute" : "Mute")}
              aria-label={t(muted ? "Unmute" : "Mute")}
            >
              {muted || volume === 0 ? <VolumeX size={15} /> : volume < 0.5 ? <Volume1 size={15} /> : <Volume2 size={15} />}
            </button>
            <input
              className="cp-vol"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={muted ? 0 : volume}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                setVolume(v);
                if (v > 0 && muted) setMuted(false);
              }}
              aria-label={t("Volume")}
            />
          </div>

          <button
            type="button"
            className="tp-b"
            onClick={toggleFullscreen}
            title={t("Fullscreen")}
            aria-label={t("Fullscreen")}
            aria-pressed={fullscreen}
          >
            {fullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
          </button>
        </div>
      </div>
    </section>
  );
};
