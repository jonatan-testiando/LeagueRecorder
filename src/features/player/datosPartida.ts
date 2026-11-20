import type { MatchMetadata, MouseEventData } from "../../types";
import {
  getCameraLooks,
  getMatchDetails,
  getMatchTrail,
  getMinuteSeries,
  type CameraLook,
  type MinuteSeries,
} from "../../core/tauri-ipc";
import { getCameraSnapSummary, type SnapSummary } from "../training/api";

/**
 * Lo que el reproductor pide al abrir una partida, en una sola espera.
 *
 * Antes cada dato llegaba por su lado (detalle, estela, serie por minuto,
 * miradas, resumen de saltos) y cada uno volvía a pintar el reproductor
 * entero: unas diez veces en el primer medio segundo, justo mientras volaba el
 * retrato, y cada repintado le quitaba fotogramas al vuelo (medido). Juntos,
 * se aplican de una vez.
 *
 * Y se piden antes de abrir: al pulsar el ratón sobre una fila o al
 * seleccionarla (`precargarPartida`). Con doble clic en la Biblioteca suelen
 * estar ya al abrir, y el reproductor se monta con todo.
 *
 * No es una caché de partidas: cada entrada vive poco (VIDA_MS) y el
 * reproductor la gasta al usarla (`olvidarPartida`), así que lo que cambie
 * mientras está abierto (una nota, una sincronización) se vuelve a leer al
 * reabrir.
 */
export interface DatosPartida {
  detalle: MatchMetadata | null;
  /** La estela del ratón; null si no se pudo leer (se queda la del listado). */
  estela: MouseEventData[] | null;
  serie: MinuteSeries | null;
  miradas: CameraLook[];
  saltos: SnapSummary | null;
}

const VIDA_MS = 15_000;

interface Entrada {
  t: number;
  promesa: Promise<DatosPartida>;
  datos?: DatosPartida;
}

const entradas = new Map<string, Entrada>();

const viva = (e: Entrada | undefined, ahora = performance.now()): e is Entrada => !!e && ahora - e.t < VIDA_MS;

/** Pide (o reutiliza, si ya está en camino) todo lo del reproductor. */
export function precargarPartida(id: string): Promise<DatosPartida> {
  const ahora = performance.now();
  const hay = entradas.get(id);
  if (viva(hay, ahora)) return hay.promesa;
  for (const [k, e] of entradas) if (!viva(e, ahora)) entradas.delete(k);
  const entrada = { t: ahora } as Entrada;
  entrada.promesa = Promise.all([
    getMatchDetails(id).catch(() => null),
    getMatchTrail(id).catch((e) => {
      console.error(e);
      return null;
    }),
    getMinuteSeries(id).catch(() => null),
    getCameraLooks(id).catch(() => [] as CameraLook[]),
    getCameraSnapSummary(id).catch(() => null),
  ]).then(([detalle, estela, serie, miradas, saltos]) => {
    entrada.datos = { detalle, estela, serie, miradas, saltos };
    return entrada.datos;
  });
  entradas.set(id, entrada);
  // Si no se llega a abrir, no se queda en memoria (la estela pesa).
  setTimeout(() => {
    if (entradas.get(id) === entrada) entradas.delete(id);
  }, VIDA_MS);
  return entrada.promesa;
}

/**
 * Pedirlos en cuanto se pulsa el ratón sobre algo que abre una partida: una
 * fila de la Biblioteca (`data-match-id`) o los accesos de Hoy
 * (`data-abre-partida`). Entre pulsar y soltar pasan ~100 ms, y en la
 * Biblioteca el primer clic del doble clic solo selecciona: casi siempre
 * llegan antes de abrir. Se instala una vez.
 */
let escuchando = false;
export function precargarAlPulsar(): void {
  if (escuchando || typeof document === "undefined") return;
  escuchando = true;
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 0) return;
      const el = (e.target as Element | null)?.closest?.<HTMLElement>("[data-match-id], [data-abre-partida]");
      const id = el?.dataset.matchId ?? el?.dataset.abrePartida;
      if (id) precargarPartida(id).catch(() => {});
    },
    { capture: true, passive: true }
  );
}

/** Los datos, si ya llegaron; sin esperar. */
export function datosListos(id: string): DatosPartida | undefined {
  const e = entradas.get(id);
  return viva(e) ? e.datos : undefined;
}

/** El reproductor ya los usó: la próxima apertura los vuelve a leer. */
export function olvidarPartida(id: string): void {
  entradas.delete(id);
}

/** La versión de Data Dragon, una vez por sesión (es un fichero del disco,
 *  pero cada apertura lo pedía y repintaba al llegar). */
let versionDdragon: Promise<string | null> | null = null;
let versionLista: string | null = null;
export function versionDeDdragon(url: string): Promise<string | null> {
  versionDdragon ??= fetch(url)
    .then((r) => r.json())
    .then((v: unknown) => {
      versionLista = Array.isArray(v) && typeof v[0] === "string" ? v[0] : null;
      return versionLista;
    })
    .catch(() => null);
  return versionDdragon;
}
export const versionDdragonLista = (): string | null => versionLista;
