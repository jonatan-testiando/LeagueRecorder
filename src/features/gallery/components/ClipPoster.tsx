import React, { useState } from "react";
import { FileWarning, Play } from "lucide-react";
import { useT } from "../../../core/LanguageProvider";
import { streamUrl } from "../../../core/media";
import { mmss } from "../../../core/time";

/**
 * Póster de un recorte: el primer fotograma, la duración en mono y un botón de
 * play propio. Lo comparten Clips y Errores.
 *
 * Antes la miniatura del clip era el `<video controls>` de Chromium: barra gris,
 * volumen y pantalla completa del navegador, distinto de todo lo demás, y se
 * reproducía metido en 256 px. Ahora la miniatura solo enseña y el play abre el
 * reproductor de la app.
 *
 * El fotograma sale del propio vídeo y no de una miniatura generada en el
 * backend: un `<video>` sin controles, mudo y con `#t=0.1` en la URL pinta el
 * primer fotograma con solo pedir los metadatos. El 0,1 evita el negro del
 * fotograma cero que dejan algunos cortes con `-c copy`.
 */
interface ClipPosterProps {
  /** Ruta del .mp4 en disco. */
  path: string;
  /** Nombre accesible del botón: «Reproducir: Doble kill en bot». */
  label: string;
  onOpen: () => void;
  /**
   * Si el fichero falta, ¿sigue abriendo? En Errores sí: las notas se leen
   * sin vídeo. En Clips no hay nada que abrir.
   */
  openWhenMissing?: boolean;
}

export const ClipPoster: React.FC<ClipPosterProps> = ({ path, label, onOpen, openWhenMissing = false }) => {
  const t = useT();
  const [duration, setDuration] = useState<number | null>(null);
  // Con fotograma, el vídeo aparece con un fundido sobre el escenario; sin él
  // se quedaría un rectángulo negro idéntico a uno que simplemente tarda.
  const [ready, setReady] = useState(false);
  const [missing, setMissing] = useState(false);

  const state = missing ? "missing" : ready ? "ready" : "loading";

  const aviso = (
    <span className="cg-poster__missing">
      <FileWarning size={18} aria-hidden="true" />
      <span>{t("Video file missing")}</span>
    </span>
  );

  // Sin fichero y sin nada que abrir, el póster deja de ser un botón: un
  // «Reproducir» apagado que no reproduce nada solo confunde.
  if (missing && !openWhenMissing) {
    return <div className="cg-poster" data-state={state}>{aviso}</div>;
  }

  return (
    <button
      type="button"
      className="cg-poster"
      data-state={state}
      onClick={(e) => { e.stopPropagation(); onOpen(); }}
      aria-label={label}
      title={label}
    >
      {missing ? aviso : (
        <>
          <video
            src={`${streamUrl(path)}#t=0.1`}
            preload="metadata"
            muted
            playsInline
            tabIndex={-1}
            aria-hidden="true"
            onLoadedMetadata={(e) => {
              const d = e.currentTarget.duration;
              if (Number.isFinite(d) && d > 0) setDuration(d);
            }}
            onLoadedData={() => setReady(true)}
            onError={() => setMissing(true)}
          />
          <span className="cg-poster__foot">
            {duration !== null ? (
              <span className="cg-poster__dur t-time">{mmss(duration)}</span>
            ) : (
              <span />
            )}
            <span className="cg-poster__play" aria-hidden="true">
              <Play size={14} fill="currentColor" />
            </span>
          </span>
        </>
      )}
    </button>
  );
};
