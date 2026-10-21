import React, { useState } from "react";
import { CircleCheck, Crosshair, EyeOff, Flag, Magnet, Play, Skull, Swords } from "lucide-react";
import { clock } from "../../../core/time";
import { streamUrl } from "../../../core/media";
import { useLang } from "../../../core/LanguageProvider";
import { Chip } from "../../../components/ui/Chip";
import { eventMeta } from "../../player/components/eventMeta";
import { wpDeltaNumber, type TeachMoment, type MomentVerdict } from "../moments";

/**
 * Una tarjeta de «los 3 momentos»: arriba, una vista previa en escenario
 * (marino en los dos temas, como el vídeo que abre) con el tipo de momento, la
 * hora del vídeo y el botón de reproducir; abajo, el título en frase, lo que
 * movió la probabilidad de victoria («−6 %») y una línea de explicación cuando
 * la hay. Toda la tarjeta abre la partida en ese instante.
 *
 * El ΔWP solo se pinta si la jugada existe en el modelo (`momentWp`): un
 * momento que no es una jugada (un error marcado, un episodio de presión) va
 * sin cifra, no con una inventada.
 */

const CHIP_TONE = { error: "loss", finding: "finding", best: "win" } as const;

export const MomentCard: React.FC<{
  moment: TeachMoment;
  /** ΔWP del momento desde tu equipo (−1…1), o null si no se conoce. */
  wp: number | null;
  onPlay: () => void;
  /** Posición en la entrada escalonada de la primera visita. */
  index?: number;
  /**
   * El vídeo de la partida: la vista previa enseña el fotograma del momento
   * (`m.time` va en segundos de vídeo), como el póster de Clips. Sin él, o si
   * el fichero falta, queda el escenario teñido.
   */
  videoPath?: string | null;
}> = ({ moment: m, wp, onPlay, index, videoPath }) => {
  const { t, lang } = useLang();
  const [frameReady, setFrameReady] = useState(false);
  const [frameFailed, setFrameFailed] = useState(false);

  const verdict = (v: MomentVerdict) => {
    switch (v) {
      case "Mistake": return t("Mistake");
      case "Finding": return t("Finding");
      case "Excellent": return t("Excellent");
      case "Good": return t("Good");
    }
  };

  const glyph = (() => {
    switch (m.glyph) {
      case "objective": return m.event ? eventMeta(m.event, 16).icon : <Flag size={16} />;
      case "flag": return <Flag size={16} />;
      case "eye": return <EyeOff size={16} />;
      case "gank": return <Crosshair size={16} />;
      case "pressure": return <Magnet size={16} />;
      case "death": return <Skull size={16} />;
      case "kill": return <Swords size={16} />;
    }
    // Duelo (te mata / matas a alguien con retrato): el glifo del tipo.
    return m.kind === "error" ? <Skull size={16} /> : m.kind === "best" ? <CircleCheck size={16} /> : <EyeOff size={16} />;
  })();

  // Qué clase de momento es, dicho en la vista previa; quién te mató o a quién
  // mataste ya lo dice el título.
  const tipo =
    m.caption ??
    (m.kind === "error"
      ? t("A mistake that cost you")
      : m.kind === "best"
        ? t("A play that paid off")
        : t("Detected by the analyzer"));

  const delta = wp != null ? wpDeltaNumber(wp, lang) : null;

  return (
    <button
      type="button"
      className={`home-mo home-mo--${m.kind}`}
      onClick={onPlay}
      style={index != null ? ({ "--i": index } as React.CSSProperties) : undefined}
      aria-label={[clock(m.time), m.title, delta ? t("{n}% win chance", { n: delta }) : verdict(m.verdict)].join(" · ")}
    >
      <span className="home-mo__thumb stage-dark" aria-hidden="true" data-frame={frameReady || undefined}>
        {videoPath && !frameFailed && (
          // Mudo, sin controles y con #t= en la URL: pinta ese fotograma con
          // solo pedir los metadatos, sin miniaturas generadas en el backend.
          <video
            className="home-mo__frame"
            src={`${streamUrl(videoPath)}#t=${Math.max(0.1, m.time).toFixed(1)}`}
            preload="metadata"
            muted
            playsInline
            tabIndex={-1}
            onLoadedData={() => setFrameReady(true)}
            onError={() => setFrameFailed(true)}
          />
        )}
        <span className="home-mo__kind">
          {glyph}
          <span className="t-label home-mo__caption">{tipo}</span>
        </span>
        <span className="home-mo__foot">
          <span className="u-time home-mo__time">{clock(m.time)}</span>
          <span className="home-mo__play">
            <Play size={14} fill="currentColor" />
          </span>
        </span>
      </span>

      <span className="home-mo__body">
        <span className="home-mo__head">
          <span className="t-body-strong home-mo__title">{m.title}</span>
          {delta && (
            <Chip tone={CHIP_TONE[m.kind]} title={t("What this moment moved your win chance")}>
              {t("{n}%", { n: delta })}
            </Chip>
          )}
        </span>
        {m.why && <span className="t-small home-mo__why">{m.why}</span>}
      </span>
    </button>
  );
};
