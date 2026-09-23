import React, { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useAppStore } from "../../../store/useAppStore";
import { useT } from "../../../core/LanguageProvider";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import { mmss } from "../../../core/time";
import "./PlaylistBar.css";

/**
 * Barra de la lista de reproducción entre partidas ("Ver las 11 muertes
 * seguidas", desde el foco de Patrones).
 *
 * La monta App.tsx (que la coloca abajo y centrada) y se pinta solo cuando hay
 * una lista activa y se está en el reproductor: fuera de /review la lista sigue
 * viva en el store, pero una barra que cambia de partida sin que se vea sería
 * un mando a distancia a ciegas. Cambiar de ítem abre la partida de ese ítem en
 * su momento: lo hace el store (`playlistGo`), con el mismo salto que usan los
 * puntos del mapa.
 *
 * Atajos: Alt+← y Alt+→. Las flechas solas son del reproductor (±5 s) y los
 * corchetes marcan el recorte; con Alt no pisan nada. Se escuchan en captura y
 * se paran ahí, para que el reproductor no salte además 5 s en el vídeo que se
 * va, y para que Alt+← no sea también "atrás" en el historial.
 */
export const PlaylistBar: React.FC = () => {
  const t = useT();
  const playlist = useAppStore((s) => s.playlist);
  const matches = useAppStore((s) => s.matches);
  const playlistGo = useAppStore((s) => s.playlistGo);
  const clearPlaylist = useAppStore((s) => s.clearPlaylist);
  const enReproductor = useLocation().pathname === "/review";

  const index = playlist?.index ?? 0;
  const total = playlist?.items.length ?? 0;
  // El paso se da sobre el índice VIVO del store, no el de este render: dos
  // pulsaciones seguidas antes de repintar avanzarían una sola.
  const paso = (d: number) => {
    const pl = useAppStore.getState().playlist;
    if (!pl) return;
    const i = pl.index + d;
    if (i >= 0 && i < pl.items.length) playlistGo(i);
  };

  useEffect(() => {
    if (!playlist || !enReproductor) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      paso(e.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // `paso` lee el store en vivo: no hace falta rehacer el oyente por él.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlist !== null, enReproductor]);

  if (!playlist || total === 0 || !enReproductor) return null;
  const item = playlist.items[index];
  const match = matches.find((m) => m.id === item.matchId) ?? null;
  // La hora que se enseña es la de PARTIDA (la del marcador del juego), no la
  // del vídeo: es la que el jugador reconoce.
  const gameSec = Math.max(0, item.time - (match?.video_offset ?? 0));

  return (
    <div className="pl-bar" role="region" aria-label={t("Playlist")}>
      {match && <ChampionAvatar champion={match.champion} size={32} ring="var(--hair-strong)" />}
      <div className="pl-text">
        <span className="pl-title">
          {playlist.title}
          <span className="pl-count"> · {t("{i} of {n}", { i: index + 1, n: total })}</span>
        </span>
        <span className="pl-label">
          <span className="pl-time">{mmss(gameSec)}</span>
          {" · "}
          {item.label}
        </span>
      </div>
      <div className="pl-nav">
        <button
          type="button"
          className="pl-btn"
          disabled={index === 0}
          onClick={() => paso(-1)}
          aria-label={t("Previous")}
          title={`${t("Previous")} (Alt+←)`}
        >
          <ChevronLeft size={18} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="pl-btn"
          disabled={index >= total - 1}
          onClick={() => paso(1)}
          aria-label={t("Next")}
          title={`${t("Next")} (Alt+→)`}
        >
          <ChevronRight size={18} aria-hidden="true" />
        </button>
        <span className="pl-kbd" aria-hidden="true">
          <kbd>Alt</kbd>
          <kbd>←</kbd>
          <kbd>→</kbd>
        </span>
      </div>
      <button
        type="button"
        className="pl-btn pl-close"
        onClick={clearPlaylist}
        aria-label={t("Close playlist")}
        title={t("Close playlist")}
      >
        <X size={16} aria-hidden="true" />
      </button>
      {/* Cuánto queda, sin números: una línea fina en el canto de abajo. */}
      <span className="pl-progress" aria-hidden="true">
        <span style={{ width: `${((index + 1) / total) * 100}%` }} />
      </span>
    </div>
  );
};
