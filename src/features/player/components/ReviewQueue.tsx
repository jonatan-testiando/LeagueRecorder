import { MatchMetadata } from "../../../types";
import { describeEvent, type Translate } from "../../../core/eventText";
import { eventMeta, type Tone } from "./eventMeta";
import { type ErrorClipMetadata } from "../../../core/tauri-ipc";

/**
 * La cola de revisión: qué momentos de una partida merecen una mirada y cuáles
 * están ya vistos. Aquí vive sólo el cálculo (`buildQueue`); la lista que la
 * pinta es la de la pestaña Revisión del reproductor, donde cada suceso lleva
 * su casilla de "visto". Era un componente aparte con la misma lista en otro
 * orden.
 *
 * Revisar una partida es una tarea con final: hay N momentos que mirar y los vas
 * tachando. Antes la pantalla no tenía esa noción, así que no había forma de
 * saber por dónde ibas ni cuándo habías acabado — la diferencia entre un panel y
 * una herramienta.
 *
 * No hace falta ningún dato nuevo: la gravedad sale del `tone` que ya calcula
 * `eventMeta`, y los momentos de `events[]` más `camera_snaps`.
 */

type Severity = "high" | "med" | "low";

const SEVERITY_OF: Partial<Record<Tone, Severity>> = {
  throw: "high",
  mistake: "high",
  inaccuracy: "med",
};

export interface Moment {
  /**
   * Identidad estable. Antes se identificaba por (tiempo, fuente), y dos clips
   * de error marcados en el mismo segundo eran el mismo momento: marcar uno
   * marcaba los dos y el guardado pisaba al otro.
   */
  id: string;
  time: number;
  severity: Severity;
  /** Ya traducido: lleva nombres dentro, así que se compone, no se busca. */
  title: string;
  note?: string;
  reviewed: boolean;
  /**
   * De dónde sale el momento. Importa porque el estado "visto" no se guarda en
   * el mismo sitio: los sucesos viven en el JSON de la partida y los errores
   * marcados en el JSON de su propio clip.
   */
  source: "event" | "error";
  /** Ruta del clip, solo para los de tipo `error`. */
  clipPath?: string;
}

/**
 * De todos los sucesos, los que merecen una mirada. Un volcado cronológico de
 * los 46 eventos no es una cola de trabajo: 19 de ellos son ultimates.
 *
 * Recibe `t` porque el título de un suceso es una frase con nombres dentro
 * ("Te mata Ahri"): se compone en el idioma bueno o no se traduce nunca.
 */
/** Por encima de esto los saltos de cámara son clics, no hallazgos. */
const MAX_SNAPS_EN_COLA = 24;

export function buildQueue(
  match: MatchMetadata,
  errorClips: ErrorClipMetadata[] = [],
  t: Translate
): Moment[] {
  const out: Moment[] = [];
  const seen = match.reviewed_moments ?? [];
  // Igualdad exacta: el segundo que se guarda es EL MISMO número que se leyó de
  // `events[]`, así que la tolerancia de 50 ms no arreglaba ningún redondeo y sí
  // hacía que dos sucesos del mismo instante compartieran estado.
  const isReviewed = (secs: number) => seen.includes(secs);

  for (const ev of match.events) {
    const meta = eventMeta(ev);
    const sev = SEVERITY_OF[meta.tone];
    if (!sev) continue;
    out.push({
      id: `event:${ev.time}:${ev.type}:${ev.subtype ?? ""}`,
      time: ev.time,
      severity: sev,
      title: describeEvent(ev, t),
      note: t(meta.label),
      reviewed: isReviewed(ev.time),
      source: "event",
    });
  }

  // Los errores que marcaste tú. Son la señal más deliberada que hay —dijiste
  // explícitamente "esto estuvo mal"— así que entran arriba del todo.
  //
  // Solo los que conservan su posición: los exportados antes de que se guardara
  // `start_time` no se pueden colocar en la línea de tiempo, y siguen estando en
  // la pantalla de Errors.
  for (const clip of errorClips) {
    if (clip.start_time === undefined || clip.start_time === null) continue;
    const first = clip.events && clip.events.length > 0 ? clip.events[0] : null;
    out.push({
      // La ruta del clip es única por definición: es un fichero.
      id: `error:${clip.path}`,
      time: clip.start_time,
      severity: "high",
      title: (first ? first.text : clip.note) || t("Flagged error"),
      note: first?.category ?? t("you flagged this"),
      reviewed: clip.reviewed === true,
      source: "error",
      clipPath: clip.path,
    });
  }

  // Los saltos de cámara no son sucesos de partida, pero sí momentos que revisar:
  // un hueco largo sin mover la cámara es exactamente lo que buscas al repasar.
  //
  // Solo cuando son pocos. Desde que las miradas salen de los clics de minimapa
  // (`camera_input`) una partida trae cientos, y metidos aquí convertían la cola
  // en "0 / 117 momentos": imposible de terminar y sin nada que revisar. Los del
  // detector de vídeo antiguo (una decena) sí siguen entrando.
  const snaps = match.camera_snaps ?? [];
  for (const secs of snaps.length <= MAX_SNAPS_EN_COLA ? snaps : []) {
    if (out.some((m) => Math.abs(m.time - secs) < 4)) continue;
    out.push({
      id: `snap:${secs}`,
      time: secs,
      severity: "low",
      title: t("Camera jump"),
      note: t("detected by the analyzer"),
      reviewed: isReviewed(secs),
      source: "event",
    });
  }

  return out.sort((a, b) => a.time - b.time);
}

/**
 * Segundos que se miran antes de cada muerte. El mismo número que usa el panel
 * «Conciencia de mapa antes de morir» (MapAwarenessWidget): si uno dijera 10 y
 * el otro 12, la misma muerte saldría ciega en un sitio y no en el otro.
 */
export const BLIND_LOOKBACK_S = 10;

/**
 * Un hallazgo del analizador: algo que no es un suceso de Riot sino una lectura
 * de lo que hiciste, sacada de datos que ya están grabados. Se pinta en violeta
 * (rombo en la línea de tiempo, aviso sobre el vídeo, tarjeta con el brillo de
 * hallazgo) para que no se confunda con lo que pasó en la partida.
 */
export interface Finding {
  id: string;
  /** Dónde empieza: ahí va la marca. */
  time: number;
  /** Hasta cuándo es "el momento actual" (aviso y tarjeta). */
  end: number;
  /** Ya traducidos. */
  title: string;
  detail: string;
  /** Si merece el aviso sobre el vídeo. Los saltos de cámara ya los anuncia el HUD. */
  notice: boolean;
  /** Cuenta como algo malo en los filtros. */
  bad: boolean;
  /** Si además es un momento de la cola (tiene casilla de revisado). */
  moment?: Moment;
}

/**
 * Los hallazgos de una partida, con lo que ya hay en disco:
 *
 * - **Muertes a ciegas**: ni un clic de minimapa ni una cámara aliada en los
 *   `BLIND_LOOKBACK_S` segundos antes de morir. La marca va al PRINCIPIO de ese
 *   tramo, que es cuando el aviso sirve: lo ves mientras te acercas a la muerte.
 *   Solo si la partida tiene miradas registradas; sin ellas, "no miraste" sería
 *   mentira.
 * - **Saltos de cámara** del detector de vídeo, cuando son pocos (los que ya
 *   entran en la cola, ver `buildQueue`).
 */
export function analyzerFindings(
  deaths: number[],
  looks: number[],
  moments: Moment[],
  t: Translate
): Finding[] {
  const out: Finding[] = [];
  if (looks.length > 0) {
    const sorted = [...looks].sort((a, b) => a - b);
    for (const d of deaths) {
      const from = d - BLIND_LOOKBACK_S;
      if (sorted.some((s) => s >= from && s <= d)) continue;
      out.push({
        id: `finding:blind:${d}`,
        time: Math.max(0, from),
        end: d,
        title: t("Died with no information"),
        detail: t("No minimap click or ally camera in the {n} s before this death.", { n: BLIND_LOOKBACK_S }),
        notice: true,
        bad: true,
      });
    }
  }
  for (const m of moments) {
    if (!m.id.startsWith("snap:")) continue;
    out.push({
      id: m.id,
      time: m.time,
      end: m.time + 3,
      title: m.title,
      detail: t("Detected by the video analyzer."),
      notice: false,
      bad: false,
      moment: m,
    });
  }
  return out.sort((a, b) => a.time - b.time);
}
