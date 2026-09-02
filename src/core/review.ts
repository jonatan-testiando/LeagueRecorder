import { MatchMetadata } from "../types";
import type { ErrorClipMetadata } from "./tauri-ipc";
import { buildQueue } from "../features/player/components/ReviewQueue";

/**
 * Qué significa "revisada". UNA definición.
 *
 * Había tres, y no coincidían nunca:
 *
 *  - "Hoy" decía revisada = tiene al menos un comentario.
 *  - El reproductor decía revisada = has tachado los N momentos de la cola.
 *  - Errores decía revisada = el clip está marcado.
 *
 * Así que la biblioteca podía enseñar "por revisar" una partida en la que ya
 * habías tachado los veinte momentos, y darla por hecha en cuanto escribías una
 * nota suelta. La cuenta de la cabecera no cuadraba con nada.
 *
 * La cola de revisión (`buildQueue`) es la que sabe cuántos momentos tiene una
 * partida: sale de sus sucesos, de sus saltos de cámara y de los errores que tú
 * marcaste. Aquí se cuenta esa cola, y se acepta ADEMÁS el comentario como
 * señal de trabajo hecho: quien anota una partida a mano la ha revisado aunque
 * no haya tachado las casillas.
 */
export interface ReviewProgress {
  /** Momentos que la cola de revisión propone para esta partida. */
  total: number;
  /** De ellos, los ya tachados. */
  done: number;
  /** Si la partida cuenta como revisada. */
  reviewed: boolean;
}

/**
 * La cola se monta con títulos ya traducidos porque el reproductor los pinta.
 * Para CONTAR no hace falta idioma, así que se pasa la identidad en vez de
 * arrastrar `t` hasta la biblioteca (que solo quiere un número).
 */
const SIN_TRADUCIR = (k: string) => k;

/**
 * `errorClips` son los de TODA la app: se filtran aquí por partida. Omitirlos
 * solo pierde los momentos que marcaste tú a mano, no rompe la cuenta.
 */
export function reviewProgress(
  match: MatchMetadata,
  errorClips: ErrorClipMetadata[] = []
): ReviewProgress {
  const suyos = errorClips.filter((c) => c.match_id === match.id);
  const moments = buildQueue(match, suyos, SIN_TRADUCIR);
  const total = moments.length;
  const done = moments.filter((m) => m.reviewed).length;
  const conNotas = (match.comments?.length ?? 0) > 0;
  return { total, done, reviewed: (total > 0 && done === total) || conNotas };
}

/** Atajo para filtrar listas. */
export const isReviewed = (m: MatchMetadata, clips: ErrorClipMetadata[] = []): boolean =>
  reviewProgress(m, clips).reviewed;
