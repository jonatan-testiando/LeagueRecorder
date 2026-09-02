import React, { useMemo, useState } from "react";
import { MatchMetadata } from "../../../types";
import { describeEvent, type Translate } from "../../../core/eventText";
import { eventMeta, type Tone } from "./eventMeta";
import { mmss } from "../../../core/time";
import { setEventReviewed, setErrorClipReviewed, type ErrorClipMetadata } from "../../../core/tauri-ipc";
import { useT } from "../../../core/LanguageProvider";

/**
 * La barra lateral como cola de trabajo, no como marcador.
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

const SEV_COLOR: Record<Severity, string> = {
  high: "var(--loss)",
  med: "var(--gold)",
  low: "var(--faint)",
};

const SEV_ORDER: Record<Severity, number> = { high: 0, med: 1, low: 2 };

/**
 * Segmentos máximos de la barra de progreso.
 *
 * Era un hijo de flex por momento. Con 60 momentos —una partida normal— cada
 * segmento medía menos de un píxel y los huecos de 2px se comían la barra
 * entera: lo que se veía era un rayado gris, no un progreso. A partir de aquí
 * se agrega: cada segmento representa un tramo de la cola y se pinta como hecho
 * cuando lo está entero.
 */
const MAX_SEGMENTS = 24;

/**
 * Distancia a la que un momento se considera "el que estás viendo". Es la mitad
 * de la ventana de clip: lo que se reproduce al saltar a un momento.
 */
const NEAR_SECS = 3;

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

export interface ReviewQueueProps {
  matchId: string;
  moments: Moment[];
  currentTime: number;
  onSeek: (seconds: number) => void;
  onChange: (moments: Moment[]) => void;
}

export const ReviewQueue: React.FC<ReviewQueueProps> = ({
  matchId,
  moments,
  currentTime,
  onSeek,
  onChange,
}) => {
  const [showAll, setShowAll] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const t = useT();

  const done = moments.filter((m) => m.reviewed).length;
  const total = moments.length;

  // Por gravedad y no por reloj: el reloj ya lo da la tira bajo el vídeo. Los
  // vistos caen al fondo para que la cola sea siempre lo pendiente.
  const ordered = useMemo(() => {
    const list = showAll ? moments : moments.filter((m) => !m.reviewed);
    return [...list].sort((a, b) => {
      if (a.reviewed !== b.reviewed) return a.reviewed ? 1 : -1;
      if (SEV_ORDER[a.severity] !== SEV_ORDER[b.severity]) {
        return SEV_ORDER[a.severity] - SEV_ORDER[b.severity];
      }
      return a.time - b.time;
    });
  }, [moments, showAll]);

  /**
   * La barra, agregada. Cada segmento cubre un tramo de la cola y sólo cuenta
   * como hecho si están hechos todos sus momentos: media barra llena mintiendo
   * es peor que una barra con menos resolución.
   */
  const segments = useMemo(() => {
    const n = Math.min(MAX_SEGMENTS, Math.max(1, total));
    const porSegmento = total / n;
    return Array.from({ length: n }, (_, i) => {
      const desde = Math.floor(i * porSegmento);
      const hasta = Math.max(desde + 1, Math.floor((i + 1) * porSegmento));
      const trozo = moments.slice(desde, hasta);
      return {
        done: trozo.length > 0 && trozo.every((m) => m.reviewed),
        count: trozo.length,
      };
    });
  }, [moments, total]);

  const toggle = (m: Moment) => {
    setSaveErr(null);
    const next = moments.map((x) => (x.id === m.id ? { ...x, reviewed: !x.reviewed } : x));
    onChange(next);

    // Cada fuente guarda en su sitio.
    const save =
      m.source === "error" && m.clipPath
        ? setErrorClipReviewed(m.clipPath, !m.reviewed)
        : setEventReviewed(matchId, m.time, !m.reviewed);

    // Si el guardado falla, se revierte: mejor que la casilla mienta sobre lo
    // que hay en disco. Y se DICE: revertir en silencio parecía un clic perdido.
    save.catch((err) => {
      onChange(moments);
      setSaveErr(t("Couldn't save the reviewed state: {msg}", { msg: String(err) }));
    });
  };

  if (total === 0) {
    return (
      <div style={styles.empty}>
        <p className="empty-state__title" style={{ fontSize: "var(--font-sm)" }}>
          {t("Nothing flagged")}
        </p>
        <p className="empty-state__text" style={{ fontSize: "var(--font-xs)" }}>
          {t("No deaths or detected mistakes in this game.")}
        </p>
      </div>
    );
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.progress}>
        <div style={styles.progressTop}>
          <span className="u-label">{t("Review")}</span>
          <span className="u-metric" style={{ fontSize: 12 }}>
            {done} / {total}
          </span>
        </div>
        <div style={styles.bar}>
          {segments.map((s, i) => (
            <span
              key={i}
              style={{
                flex: 1,
                height: "100%",
                background: s.done ? "var(--cool)" : "var(--sunken)",
              }}
            />
          ))}
        </div>
      </div>

      <div style={styles.filters}>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          aria-pressed={!showAll}
          onClick={() => setShowAll(false)}
        >
          {t("To review")}
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          aria-pressed={showAll}
          onClick={() => setShowAll(true)}
        >
          {t("All")} ({total})
        </button>
      </div>

      {saveErr && <p style={styles.saveErr}>{saveErr}</p>}

      <div style={styles.list}>
        {ordered.length === 0 ? (
          <div style={styles.empty}>
            <p className="empty-state__title" style={{ fontSize: "var(--font-sm)" }}>
              {t("All reviewed")}
            </p>
            <p className="empty-state__text" style={{ fontSize: "var(--font-xs)" }}>
              {t("You went through every flagged moment in this game.")}
            </p>
          </div>
        ) : (
          ordered.map((m) => {
            const active = Math.abs(currentTime - m.time) < NEAR_SECS;
            return (
              <div
                key={m.id}
                className="rq-item"
                data-sel={active ? "" : undefined}
                data-done={m.reviewed ? "" : undefined}
                role="button"
                tabIndex={0}
                onClick={() => onSeek(m.time)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSeek(m.time); }
                }}
              >
                <span className="rq-sev" style={{ background: SEV_COLOR[m.severity] }} />
                <span className="rq-time">{mmss(m.time)}</span>
                <span style={{ minWidth: 0 }}>
                  <span className="rq-title">{m.title}</span>
                  {m.note && <span className="rq-note">{m.note}</span>}
                </span>
                <span
                  className="rq-done"
                  role="checkbox"
                  aria-checked={m.reviewed}
                  aria-label={t(m.reviewed ? "Mark as not reviewed" : "Mark as reviewed")}
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); toggle(m); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); toggle(m); }
                  }}
                />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  wrap: { display: "flex", flexDirection: "column", minHeight: 0, flex: 1 },
  progress: {
    padding: "var(--space-3) var(--space-4)",
    borderBottom: "1px solid var(--line-soft)",
  },
  progressTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: "var(--space-2)",
  },
  bar: {
    height: "3px",
    display: "flex",
    gap: "2px",
    background: "var(--sunken)",
    borderRadius: "2px",
    overflow: "hidden",
  },
  filters: {
    display: "flex",
    gap: "var(--space-2)",
    padding: "var(--space-3) var(--space-4) var(--space-2)",
  },
  saveErr: {
    margin: 0,
    padding: "0 var(--space-4) var(--space-2)",
    fontSize: "var(--font-xs)",
    color: "var(--loss)",
  },
  list: { flex: 1, minHeight: 0, overflowY: "auto" },
  empty: { padding: "var(--space-6) var(--space-4)", textAlign: "center" },
};
