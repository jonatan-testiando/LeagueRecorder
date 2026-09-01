import { create } from 'zustand';
import { MatchMetadata } from '../types';
import { ErrorClipMetadata } from '../core/tauri-ipc';

interface AppState {
  /** Partida abierta en la pestaña Games. */
  selectedMatch: MatchMetadata | null;
  setSelectedMatch: (match: MatchMetadata | null) => void;

  /**
   * VOD abierto en la pestaña VOD Analysis. Va aparte de `selectedMatch` a
   * propósito: las dos pestañas están montadas a la vez, así que compartir una
   * sola selección abriría dos reproductores del mismo vídeo y haría aparecer la
   * partida de Games dentro del análisis.
   */
  selectedVod: MatchMetadata | null;
  setSelectedVod: (match: MatchMetadata | null) => void;

  selectedError: ErrorClipMetadata | null;
  setSelectedError: (err: ErrorClipMetadata | null) => void;

  /**
   * Segundo de vídeo al que saltar cuando el reproductor abra la partida
   * seleccionada. Lo deja quien navega hacia /review desde fuera (el mapa de
   * muertes de Patrones); el reproductor lo consume una sola vez al estar listo.
   */
  pendingSeek: number | null;
  setPendingSeek: (seconds: number | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  selectedMatch: null,
  setSelectedMatch: (match) => set({ selectedMatch: match }),

  selectedVod: null,
  setSelectedVod: (match) => set({ selectedVod: match }),

  selectedError: null,
  setSelectedError: (err) => set({ selectedError: err }),

  pendingSeek: null,
  setPendingSeek: (seconds) => set({ pendingSeek: seconds }),
}));
