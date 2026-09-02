import { useEffect } from 'react';
import { create } from 'zustand';
import { MatchMetadata } from '../types';
import { ErrorClipMetadata, getAllErrorClips, getRecordedMatches } from '../core/tauri-ipc';

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
   * Los errores marcados, también compartidos.
   *
   * Vivían dentro de `ErrorsGallery`, y por eso el reproductor de errores no
   * tenía a quién avisar al guardar una nota: su `onUpdate` era una función
   * vacía y la nota recién escrita no aparecía hasta recargar la ventana.
   */
  errorClips: ErrorClipMetadata[];
  errorClipsLoaded: boolean;
  /** Error de la última lectura, para poder enseñarlo en vez de "no hay nada". */
  errorClipsError: string | null;
  /**
   * Relee del disco. Además, si hay un clip abierto, lo vuelve a apuntar a su
   * versión fresca: es lo que hace que la nota recién guardada se vea sin salir
   * y volver a entrar.
   */
  refreshErrorClips: () => Promise<void>;

  /**
   * Segundo de vídeo al que saltar cuando el reproductor abra la partida
   * seleccionada. Lo deja quien navega hacia /review desde fuera (el mapa de
   * muertes de Patrones); el reproductor lo consume una sola vez al estar listo.
   */
  pendingSeek: number | null;
  setPendingSeek: (seconds: number | null) => void;

  /**
   * Si el asistente de primer arranque ya se completó.
   *
   * `null` mientras no ha llegado la config del disco: es la diferencia entre
   * "no hace falta el asistente" y "todavía no lo sé", y sin ella la app
   * parpadearía enseñando el asistente medio segundo en cada arranque.
   *
   * Vive en el store y no dentro del propio asistente porque Ajustes tiene que
   * poder volver a lanzarlo ("Repetir la configuración") desde otra pantalla.
   */
  onboardingDone: boolean | null;
  setOnboardingDone: (done: boolean | null) => void;

  /**
   * Filtro con el que abrir la biblioteca desde otra pantalla.
   *
   * Los "Ver todas" de Hoy llevan a una lista concreta ("por revisar", "las
   * derrotas"), no a la biblioteca entera: un enlace que te deja delante de 300
   * partidas es lo mismo que no llevarte a ninguna parte. La galería lo consume
   * una sola vez y lo pone a null.
   */
  libraryFilter: "all" | "unreviewed" | "defeats" | null;
  setLibraryFilter: (f: "all" | "unreviewed" | "defeats" | null) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
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

  errorClips: [],
  errorClipsLoaded: false,
  errorClipsError: null,
  refreshErrorClips: async () => {
    try {
      const data = await getAllErrorClips();
      const abierto = get().selectedError;
      const fresco = abierto ? data.find((e) => e.path === abierto.path) ?? null : null;
      set({
        errorClips: data,
        errorClipsLoaded: true,
        errorClipsError: null,
        // Si el clip abierto ya no está (se borró desde otra pantalla), se deja
        // como estaba: cerrarlo por sorpresa es peor que enseñarlo obsoleto.
        ...(fresco ? { selectedError: fresco } : {}),
      });
    } catch (e) {
      set({ errorClipsLoaded: true, errorClipsError: String(e) });
    }
  },

  pendingSeek: null,
  setPendingSeek: (seconds) => set({ pendingSeek: seconds }),

  onboardingDone: null,
  setOnboardingDone: (done) => set({ onboardingDone: done }),

  libraryFilter: null,
  setLibraryFilter: (f) => set({ libraryFilter: f }),
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

/**
 * Los errores marcados, compartidos igual que la biblioteca.
 *
 * Al compartirlos, marcar un error en el reproductor y guardar una nota se ven
 * en la galería sin recargar: las dos pantallas leen la misma lista.
 */
export function useErrorClips(): {
  clips: ErrorClipMetadata[];
  loaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const clips = useAppStore((s) => s.errorClips);
  const loaded = useAppStore((s) => s.errorClipsLoaded);
  const error = useAppStore((s) => s.errorClipsError);
  const refresh = useAppStore((s) => s.refreshErrorClips);
  useEffect(() => {
    if (!useAppStore.getState().errorClipsLoaded) {
      refresh().catch(console.error);
    }
  }, [refresh]);
  return { clips, loaded, error, refresh };
}
