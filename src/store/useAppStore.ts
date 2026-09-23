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

  /**
   * Lista de reproducción ENTRE partidas ("Ver las 11 muertes seguidas").
   *
   * Cada ítem es un momento de una partida; pasar de uno a otro abre esa
   * partida en ese instante con el mismo mecanismo que los puntos del mapa de
   * Patrones (`selectedMatch` + `pendingSeek`). La pinta `PlaylistBar` sobre el
   * reproductor. Termina sola si se abre a mano otra partida o se cierra el
   * reproductor: seguir enseñando "3 de 11" encima de una partida que no es de
   * la lista sería mentir sobre qué se está viendo.
   */
  playlist: Playlist | null;
  /** Arranca la lista y abre el primer ítem. Quien llama navega a /review. */
  startPlaylist: (title: string, items: PlaylistItem[]) => void;
  /** Salta al ítem `index` (se recorta a la lista) y abre su partida. */
  playlistGo: (index: number) => void;
  clearPlaylist: () => void;
}

export interface PlaylistItem {
  matchId: string;
  /** Segundo del VÍDEO del momento (la muerte), no el de partida. */
  time: number;
  /** Qué pasó, ya traducido ("Te mató Kaisa"). */
  label: string;
}

export interface Playlist {
  title: string;
  items: PlaylistItem[];
  index: number;
}

/**
 * Cuánto antes del momento se pide el salto. El reproductor ya retrocede 5 s
 * al consumir `pendingSeek`; con 3 más la muerte llega unos 8 s después de
 * empezar, que es lo que hace falta para ver cómo se llega a ella.
 */
const PLAYLIST_LEAD_SECS = 3;

/** Salto aplazado al cambiar de partida (ver `abrirItem`). */
let saltoAplazado: ReturnType<typeof setTimeout> | null = null;

export const useAppStore = create<AppState>((set, get) => {
  /**
   * Abre la partida de un ítem de la lista en su momento.
   *
   * Si la partida ya está abierta basta con pedir el salto. Si es otra, el
   * salto se pide un instante DESPUÉS de cambiarla: el reproductor no se
   * desmonta entre partidas, y en el mismo render en que cambia la partida aún
   * cree tener listo el vídeo anterior — consumiría el salto contra ese vídeo
   * (y contra su duración) en vez de esperar al nuevo.
   */
  const abrirItem = (item: PlaylistItem): void => {
    const m = get().matches.find((x) => x.id === item.matchId);
    if (!m) return;
    const seek = Math.max(0, item.time - PLAYLIST_LEAD_SECS);
    if (saltoAplazado) {
      clearTimeout(saltoAplazado);
      saltoAplazado = null;
    }
    if (get().selectedMatch?.id === m.id) {
      set({ pendingSeek: seek });
      return;
    }
    set({ selectedMatch: m, pendingSeek: null });
    saltoAplazado = setTimeout(() => {
      saltoAplazado = null;
      if (get().selectedMatch?.id === m.id) set({ pendingSeek: seek });
    }, 60);
  };

  return {
    matches: [],
    matchesLoaded: false,
    refreshMatches: async () => {
      const data = await getRecordedMatches();
      set({ matches: data, matchesLoaded: true });
    },

    selectedMatch: null,
    // Abrir a mano otra partida (o cerrar el reproductor) termina la lista: la
    // barra diría "3 de 11" encima de algo que no es el ítem 3. La propia lista
    // cambia de partida con `set` directo, sin pasar por aquí.
    setSelectedMatch: (match) =>
      set((s) => {
        const pl = s.playlist;
        const sigue = !!pl && !!match && pl.items[pl.index]?.matchId === match.id;
        return pl && !sigue ? { selectedMatch: match, playlist: null } : { selectedMatch: match };
      }),

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

    playlist: null,
    startPlaylist: (title, items) => {
      if (items.length === 0) return;
      set({ playlist: { title, items, index: 0 } });
      abrirItem(items[0]);
    },
    playlistGo: (index) => {
      const pl = get().playlist;
      if (!pl) return;
      const i = Math.max(0, Math.min(pl.items.length - 1, index));
      set({ playlist: { ...pl, index: i } });
      abrirItem(pl.items[i]);
    },
    clearPlaylist: () => {
      if (saltoAplazado) {
        clearTimeout(saltoAplazado);
        saltoAplazado = null;
      }
      set({ playlist: null });
    },
  };
});

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
