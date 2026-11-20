import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { create } from 'zustand';
import { MatchMetadata } from '../types';
import { ErrorClipMetadata, getAllErrorClips, getRecordedMatchesDelta } from '../core/tauri-ipc';
import { conTransicion, retratoDelReproductor, retratoVisible } from '../core/movimiento';
import { precargarAlPulsar, precargarPartida } from '../features/player/datosPartida';

// Lo del reproductor se pide al pulsar sobre una partida, antes de abrirla.
precargarAlPulsar();

/** Versión (fecha y tamaño de su JSON) de cada partida que ya tiene la lista. */
const versiones: Record<string, string> = {};

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

  /**
   * Sube cada vez que termina un análisis de vídeo (minimapa, HUD, oleadas,
   * barras) o el mantenimiento del arranque. Entra en la firma de la
   * biblioteca: esos análisis cambian el coach y la presión sin tocar nada de
   * lo que la firma mira en las partidas.
   */
  analisis: number;

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

  /** El clip abierto en su reproductor (su ruta), para que el rail se pliegue
   *  como con una partida. */
  playingClip: string | null;
  setPlayingClip: (path: string | null) => void;

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
  refreshErrorClips: (opts?: { fresh?: boolean }) => Promise<void>;

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
    if (get().selectedMatch) set({ selectedMatch: m, pendingSeek: null });
    else conTransicion('open', () => set({ selectedMatch: m, pendingSeek: null }), { origen: retratoVisible(m.id), destino: retratoDelReproductor });
    saltoAplazado = setTimeout(() => {
      saltoAplazado = null;
      if (get().selectedMatch?.id === m.id) set({ pendingSeek: seek });
    }, 60);
  };

  return {
    matches: [],
    matchesLoaded: false,
    analisis: 0,
    refreshMatches: async () => {
      // Solo lo que cambió: el backend compara las versiones que ya tenemos.
      // Las partidas que no cambian conservan su objeto, y si no cambió nada
      // la lista ni se toca (nadie se vuelve a pintar).
      const d = await getRecordedMatchesDelta(versiones);
      const previas = get().matches;
      const porId = new Map(previas.map((m) => [m.id, m]));
      for (const e of d.cambiadas) {
        porId.set(e.m.id, e.m);
        versiones[e.m.id] = e.v;
      }
      const vigentes = new Set(d.orden);
      for (const id of Object.keys(versiones)) if (!vigentes.has(id)) delete versiones[id];
      const igual =
        d.cambiadas.length === 0 &&
        d.orden.length === previas.length &&
        d.orden.every((id, i) => previas[i]?.id === id);
      if (igual && get().matchesLoaded) return;
      if (!get().matchesLoaded) performance.mark("wl:lista-recibida");
      const matches = d.orden.map((id) => porId.get(id)).filter((m): m is MatchMetadata => !!m);
      set({ matches, matchesLoaded: true });
    },

    selectedMatch: null,
    // Abrir a mano otra partida (o cerrar el reproductor) termina la lista: la
    // barra diría "3 de 11" encima de algo que no es el ítem 3. La propia lista
    // cambia de partida con `set` directo, sin pasar por aquí.
    //
    // Abrir y cerrar el reproductor va dentro de una View Transition
    // (core/movimiento.ts): el retrato de la fila (o el de Hoy) vuela hasta la
    // miga del reproductor, y al cerrar, de vuelta. Pasar de una partida a
    // otra con el reproductor abierto (la lista de reproducción) no se anima.
    setSelectedMatch: (match) => {
      const prev = get().selectedMatch;
      // Desde Ctrl K, el post-partida o Patrones no hubo ratón encima: se pide
      // aquí, un fotograma antes de que el reproductor se monte.
      if (match && match.id !== prev?.id) precargarPartida(match.id).catch(() => {});
      const aplicar = () =>
        set((s) => {
          const pl = s.playlist;
          const sigue = !!pl && !!match && pl.items[pl.index]?.matchId === match.id;
          return pl && !sigue ? { selectedMatch: match, playlist: null } : { selectedMatch: match };
        });
      if (!prev === !match) {
        aplicar();
        return;
      }
      conTransicion(
        match ? 'open' : 'back',
        aplicar,
        match
          ? { origen: retratoVisible(match.id), destino: retratoDelReproductor }
          : { origen: retratoDelReproductor(), destino: () => retratoVisible(prev?.id) }
      );
    },

    selectedVod: null,
    setSelectedVod: (match) => {
      const prev = get().selectedVod;
      if (!prev === !match) {
        set({ selectedVod: match });
        return;
      }
      conTransicion(match ? 'open' : 'back', () => set({ selectedVod: match }));
    },

    selectedError: null,
    setSelectedError: (err) => {
      const prev = get().selectedError;
      if (!prev === !err) {
        set({ selectedError: err });
        return;
      }
      conTransicion(err ? 'open' : 'back', () => set({ selectedError: err }));
    },

    playingClip: null,
    setPlayingClip: (path) => set({ playingClip: path }),

    errorClips: [],
    errorClipsLoaded: false,
    errorClipsError: null,
    // Por defecto pide una lectura nueva: casi siempre se llama justo después de
    // crear, borrar o anotar un clip. La carga inicial comparte la que esté en vuelo.
    refreshErrorClips: async (opts) => {
      try {
        const data = await getAllErrorClips({ fresh: opts?.fresh ?? true });
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
 * Firma de la biblioteca: cambia cuando hay partidas nuevas, borradas o
 * recién sincronizadas con Riot, y NO cuando el refresco periódico trae lo
 * mismo de siempre en un array nuevo.
 *
 * Los resúmenes de Home (coach, plan, presión, punto ciego) dependían de la
 * identidad de `matches`: se pedían con la lista vacía, otra vez al llegar y
 * otra en cada refresco de 5 min o sondeo del post-partida, y cada petición
 * recorre la biblioteca entera en el backend. Entra lo que cambia el resultado
 * de esos cálculos: qué partidas hay y si ya tienen los datos de Riot.
 */
export function firmaBiblioteca(matches: MatchMetadata[]): string {
  let h = 0;
  for (const m of matches) {
    const s = `${m.id}|${m.riot_match_id ?? ""}|${m.queue ?? ""}|${m.participants?.length ?? 0}|${
      m.minute_frames?.length ?? 0
    }|${m.impact_rank ?? ""}|${m.rank_tier ?? ""}|${m.video_offset ?? ""}`;
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  }
  return `${matches.length}:${h >>> 0}`;
}

/**
 * La firma de la biblioteca, o `null` hasta que se haya cargado una vez: así
 * quien depende de ella no dispara con la lista vacía del arranque. Devuelve
 * una cadena, de modo que el componente solo se re-renderiza si cambia.
 */
export function useLibraryKey(): string | null {
  escucharAnalisis();
  return useAppStore((s) => (s.matchesLoaded ? `${firmaBiblioteca(s.matches)}#${s.analisis}` : null));
}

/**
 * Engancha UNA vez los eventos de progreso de los análisis de vídeo y sube
 * `analisis` cuando llevan un rato callados, es decir, al terminar una tanda.
 * Los eventos llegan muchas veces por segundo mientras se procesa: subir el
 * contador con cada uno pediría el coach otras tantas veces.
 */
let escuchando = false;
function escucharAnalisis() {
  if (escuchando) return;
  escuchando = true;
  let espera: ReturnType<typeof setTimeout> | undefined;
  const avisar = () => {
    clearTimeout(espera);
    espera = setTimeout(() => {
      useAppStore.setState((s) => ({ analisis: s.analisis + 1 }));
    }, 3000);
  };
  for (const evento of ['minimap_progress', 'minimap_batch', 'hud_progress']) {
    listen(evento, avisar).catch(console.error);
  }
  // El mantenimiento del arranque puede estampar impacto o rango en partidas
  // viejas: al acabar se relee la biblioteca y, si algo cambió, la firma ya lo
  // recoge. Si no cambió nada, no se pide ningún resumen otra vez.
  listen<{ phase: string }>('library_maintenance', (e) => {
    if (e.payload?.phase === 'done') useAppStore.getState().refreshMatches().catch(console.error);
  }).catch(console.error);
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
      refresh({ fresh: false }).catch(console.error);
    }
  }, [refresh]);
  return { clips, loaded, error, refresh };
}
