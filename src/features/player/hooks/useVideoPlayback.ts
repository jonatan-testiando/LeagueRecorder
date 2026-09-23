import { useCallback, useEffect, useRef, useState } from "react";
import { MatchMetadata } from "../../../types";
import { useAppStore } from "../../../store/useAppStore";

export type LoadState = "loading" | "ready" | "error";

/**
 * El transporte del reproductor: tiempo, duración, play/pausa, volumen,
 * velocidad, pantalla completa y los saltos entre momentos.
 *
 * Extraído de `VideoPlayer.tsx` tal cual (el componente pasaba de 2100 líneas
 * mezclando esto con el canvas de la estela y el recortador). El hook es dueño
 * del `<video>` vía `videoRef` y de la ventana de "clip" que auto-pausa
 * (`clipEndRef`): quien salte a un momento con `jumpToClip` reproduce hasta el
 * final de esa ventana y se detiene.
 */
export function useVideoPlayback(match: MatchMetadata) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  /** Segundo en que la reproducción actual debe auto-pausarse (ventana de clip). */
  const clipEndRef = useRef<number | null>(null);
  /**
   * De qué partida es el "ready" actual. Al cambiar de partida y pedir un salto
   * en el mismo render (mapa de Patrones, enlaces de Hoy, lista de reproducción),
   * `loadState` todavía decía "ready" por el vídeo ANTERIOR y el salto se
   * consumía contra él —con su duración— antes de que cargara el nuevo.
   */
  const readyForRef = useRef<string | null>(null);
  const matchIdRef = useRef(match.id);
  matchIdRef.current = match.id;

  const [currentTime, setCurrentTime] = useState<number>(0);
  // La duración de la partida, hasta que el vídeo diga la suya (que es la buena).
  //
  // El valor inicial de `useState` solo se usa al montar, así que al pasar de una
  // partida a otra SIN desmontar el reproductor se quedaba la duración de la
  // anterior: los marcadores, las marcas del eje y el reloj se calculaban contra
  // una longitud que no era la de ese vídeo. Se ve enseguida cuando las dos
  // partidas duran distinto.
  const [duration, setDuration] = useState<number>(match.game_duration || 0);
  useEffect(() => {
    setDuration(match.game_duration || 0);
  }, [match.id, match.game_duration]);

  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [volume, setVolume] = useState<number>(0.5);
  const [muted, setMuted] = useState<boolean>(false);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [activeEventTime, setActiveEventTime] = useState<number | null>(null);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // Cambio de partida sin desmontar: todo el transporte vuelve a cero.
  useEffect(() => {
    setCurrentTime(0);
    setIsPlaying(false);
    setLoadState("loading");
    readyForRef.current = null;
    setActiveEventTime(null);
    clipEndRef.current = null;
    if (videoRef.current) videoRef.current.load();
  }, [match]);

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
    if (!v || loadState === "error") return;
    clipEndRef.current = null;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  }, [loadState]);

  const toggleMute = useCallback(() => setMuted((m) => !m), []);
  const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setVolume(parseFloat(e.target.value));
    setMuted(false);
  }, []);

  // Un salto grande anima el cursor; avanzar reproduciendo, no. La regla del
  // sistema: si el movimiento lo causa el sistema, curva; si lo causa la mano
  // del usuario o el propio vídeo, latencia cero.
  const [isSeeking, setIsSeeking] = useState(false);
  const seekAnimRef = useRef<number | null>(null);

  const seekTo = useCallback((seconds: number, play: boolean) => {
    const v = videoRef.current;
    if (!v) return;
    const target = Math.max(0, Math.min(seconds, duration || seconds));
    const jumped = Math.abs(target - v.currentTime) > 1.5;
    v.currentTime = target;
    setCurrentTime(target);
    if (jumped) {
      setIsSeeking(true);
      if (seekAnimRef.current) window.clearTimeout(seekAnimRef.current);
      // 240ms = --t-base con un margen, para no cortar la transición a medias.
      seekAnimRef.current = window.setTimeout(() => setIsSeeking(false), 240);
    }
    if (play && v.paused) v.play().catch(() => {});
  }, [duration]);

  useEffect(() => () => {
    if (seekAnimRef.current) window.clearTimeout(seekAnimRef.current);
  }, []);

  // Salto pedido desde fuera (el mapa de muertes de Patrones, los enlaces de
  // «Hoy», la lista de momentos entre partidas): se consume una sola vez,
  // cuando el vídeo DE ESTA PARTIDA ya sabe su duración — antes, seekTo lo
  // recortaría.
  //
  // La tienda guarda solo los segundos (`setPendingSeek(seconds)` sigue siendo
  // la API de quien llama); aquí se ata el salto a la partida abierta en el
  // render en que aparece — quien abre una partida pide el salto en el mismo
  // gesto, así que los dos cambios llegan juntos. Si la partida cambia sin
  // haberlo consumido (su vídeo no cargó), el salto era de otra y se descarta
  // en vez de aplicarse al vídeo siguiente.
  const pendingSeek = useAppStore((s) => s.pendingSeek);
  const setPendingSeek = useAppStore((s) => s.setPendingSeek);
  const boundSeek = useRef<{ seconds: number; matchId: string } | null>(null);
  if (pendingSeek == null) boundSeek.current = null;
  else if (boundSeek.current?.seconds !== pendingSeek) {
    boundSeek.current = { seconds: pendingSeek, matchId: match.id };
  }
  useEffect(() => {
    const want = boundSeek.current;
    if (pendingSeek == null || !want) return;
    if (want.matchId !== match.id) {
      setPendingSeek(null);
      return;
    }
    if (loadState !== "ready" || readyForRef.current !== match.id) return;
    seekTo(Math.max(0, want.seconds - 5), false);
    setPendingSeek(null);
  }, [loadState, pendingSeek, seekTo, setPendingSeek, match.id]);

  /** Salta a un momento y reproduce su ventana (CLIP_BEFORE..CLIP_AFTER). */
  const jumpToClip = useCallback((eventTime: number, before: number, after: number) => {
    clipEndRef.current = eventTime + after;
    setActiveEventTime(eventTime);
    seekTo(Math.max(0, eventTime - before), true);
  }, [seekTo]);

  const handleTimeUpdate = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    setCurrentTime(v.currentTime);
    if (clipEndRef.current !== null && v.currentTime >= clipEndRef.current) {
      v.pause();
      clipEndRef.current = null;
    }
  }, []);

  const handleLoadedMetadata = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (isFinite(v.duration) && v.duration > 0) setDuration(v.duration);
    readyForRef.current = matchIdRef.current;
    setLoadState("ready");
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) el.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.().catch(() => {});
  }, []);

  return {
    videoRef,
    containerRef,
    clipEndRef,
    currentTime,
    duration,
    isPlaying,
    setIsPlaying,
    loadState,
    setLoadState,
    volume,
    muted,
    setMuted,
    playbackRate,
    setPlaybackRate,
    activeEventTime,
    setActiveEventTime,
    isFullscreen,
    isSeeking,
    seekTo,
    jumpToClip,
    handlePlayPause,
    toggleMute,
    handleVolumeChange,
    handleTimeUpdate,
    handleLoadedMetadata,
    toggleFullscreen,
  };
}
