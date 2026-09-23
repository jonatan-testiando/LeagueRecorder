import React from "react";
import { ArrowRight, Crosshair, EyeOff, Flag, Magnet, Play, Skull, Swords } from "lucide-react";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import { champIcon } from "../../../core/ddragon";
import { clock } from "../../../core/time";
import { useT } from "../../../core/LanguageProvider";
import { eventMeta } from "../../player/components/eventMeta";
import type { TeachMoment, MomentVerdict } from "../moments";

/**
 * Una tarjeta de «los 3 momentos»: cabecera tipo miniatura (sin vídeo: el
 * retrato del rival desenfocado, o un degradado según el tipo), el duelo o el
 * glifo del suceso, la hora del vídeo, título en frase, valoración y una línea
 * de explicación cuando la hay. Toda la tarjeta abre la partida en ese instante.
 */

const TONE: Record<TeachMoment["kind"], string> = {
  error: "var(--loss)",
  finding: "var(--flag)",
  best: "var(--win)",
};

export const MomentCard: React.FC<{ moment: TeachMoment; onPlay: () => void }> = ({ moment: m, onPlay }) => {
  const t = useT();
  const tone = TONE[m.kind];
  const duel = !!m.you && !!m.other;

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
      default: return null;
    }
  })();

  return (
    <button
      type="button"
      className={`home-mo home-mo--${m.kind}`}
      onClick={onPlay}
      aria-label={`${clock(m.time)} · ${m.title} · ${verdict(m.verdict)}`}
    >
      <span className="home-mo__thumb" aria-hidden="true">
        {m.other ? (
          <img
            className="home-mo__blur"
            src={champIcon(m.other)}
            alt=""
            onError={(e) => ((e.currentTarget.style.display = "none"))}
          />
        ) : m.kind === "finding" ? (
          <svg className="home-mo__strokes" viewBox="0 0 300 118" preserveAspectRatio="none">
            <path d="M-10 118 L120 -10" strokeWidth="26" />
            <path d="M150 130 L310 20" strokeWidth="18" />
          </svg>
        ) : null}
        <span className="home-mo__veil" />

        <span className="home-mo__who">
          {duel ? (
            <>
              <ChampionAvatar champion={m.you!} size={34} ring={tone} />
              <ArrowRight size={16} style={{ color: tone }} />
              <ChampionAvatar champion={m.other!} size={34} ring="var(--hair-strong)" />
            </>
          ) : (
            <>
              {glyph && (
                <span className="home-mo__glyph" style={{ color: tone }}>
                  {glyph}
                </span>
              )}
              {m.caption && <span className="home-mo__caption">{m.caption}</span>}
            </>
          )}
        </span>

        <span className="u-time home-mo__time">{clock(m.time)}</span>
        <span className="home-mo__play">
          <Play size={12} fill="currentColor" />
        </span>
      </span>

      <span className="home-mo__body">
        <span className="home-mo__head">
          <span className="home-mo__title">{m.title}</span>
          <span className="home-mo__chip">{verdict(m.verdict)}</span>
        </span>
        {m.why && <span className="home-mo__why">{m.why}</span>}
      </span>
    </button>
  );
};
