import { useEffect } from 'react';
import { create } from 'zustand';
import { MatchMetadata } from '../types';
import { ErrorClipMetadata, getRecordedMatches } from '../core/tauri-ipc';

interface AppState {
  /**
   * La biblioteca de partidas, UNA sola vez para toda la app.
   *
   * Antes cada pantalla (galería, Patrones, tendencias del reproductor) pedía
   * `get_recorded_matches` por su cuenta: el backend relee los JSON de todas
   * las partidas en cada llamada, así que cambiar de pestaña costaba lecturas
   * de disco repetidas para ver los mismos datos.
   */
  matches: MatchMetadata[];
  /** false hasta la primera carga: distingue "vacío" de "aún no pedido". */
  matchesLoaded: boolean;
  /** Relee del disco y publica. Quien borra o graba llama aquí y todas las
   *  pantallas se enteran a la vez. */
  refreshMatches: () => Promise<void>;

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
  matches: [],
  matchesLoaded: false,
  refreshMatches: async () => {
    const data = await getRecordedMatches();
    set({ matches: data, matchesLoaded: true });
  },

  selectedMatch: null,
  setSelectedMatch: (match) => set({ selectedMatch: match }),

  selectedVod: null,
  setSelectedVod: (match) => set({ selectedVod: match }),

  selectedError: null,
  setSelectedError: (err) => set({ selectedError: err }),

  pendingSeek: null,
  setPendingSeek: (seconds) => set({ pendingSeek: seconds }),
}));

/**
 * Las partidas, cargadas una sola vez y compartidas.
 *
 * Cualquier pantalla que solo LEA la biblioteca usa esto en lugar de invocar
 * `get_recorded_matches`: si otra ya la pidió, no hay segunda lectura de disco.
 * El refresco periódico y el de fin de grabación viven en `useGallery`, que
 * está montado siempre (App).
 */
export function useMatches(): { matches: MatchMetadata[]; loaded: boolean } {
  const matches = useAppStore((s) => s.matches);
  const loaded = useAppStore((s) => s.matchesLoaded);
  const refresh = useAppStore((s) => s.refreshMatches);
  useEffect(() => {
    if (!useAppStore.getState().matchesLoaded) {
      refresh().catch(console.error);
    }
  }, [refresh]);
  return { matches, loaded };
}
