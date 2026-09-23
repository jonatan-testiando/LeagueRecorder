import React from "react";
import { champIcon } from "../core/ddragon";

/**
 * Ambiente de campeón: su retrato ampliado y muy desenfocado detrás de un
 * héroe, fundido hacia el panel. Es el único degradado de la pantalla que
 * cambia de partida a partida, y con él el color de la app sale del juego y
 * no del cromo.
 *
 * Va en posición absoluta: el padre necesita `position: relative` y
 * `overflow: hidden`. El contenido del padre tiene que ir encima con
 * `position: relative`.
 *
 * Se usa con el retrato local (128 px): desenfocado a 60 px da igual su
 * resolución, y no pide nada a la red.
 */
interface Props {
  champion: string | null | undefined;
  /** 0–1. 0,5 es el valor de diseño; más no mejora la lectura del texto. */
  intensity?: number;
  /** Lado donde se concentra el color. */
  side?: "right" | "left" | "top";
  /** Color del panel sobre el que se funde (por defecto, --panel). */
  base?: string;
}

export const ChampionWash: React.FC<Props> = ({ champion, intensity = 0.5, side = "right", base = "var(--panel)" }) => {
  if (!champion) return null;
  const img: React.CSSProperties =
    side === "top"
      ? { left: "-10%", right: "-10%", top: "-120%", width: "120%", height: "260%" }
      : side === "left"
        ? { left: "-12%", top: "-60%", width: "70%", height: "220%" }
        : { right: "-12%", top: "-60%", width: "70%", height: "220%" };
  const fade =
    side === "top"
      ? `linear-gradient(180deg, color-mix(in srgb, ${base} 30%, transparent) 0%, ${base} 85%)`
      : side === "left"
        ? `linear-gradient(270deg, ${base} 0%, ${base} 34%, color-mix(in srgb, ${base} 72%, transparent) 62%, color-mix(in srgb, ${base} 35%, transparent) 100%)`
        : `linear-gradient(90deg, ${base} 0%, ${base} 34%, color-mix(in srgb, ${base} 72%, transparent) 62%, color-mix(in srgb, ${base} 35%, transparent) 100%)`;
  return (
    <div aria-hidden="true" style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none", borderRadius: "inherit" }}>
      <img
        src={champIcon(champion)}
        alt=""
        onError={(e) => ((e.currentTarget.style.display = "none"))}
        style={{
          position: "absolute",
          ...img,
          objectFit: "cover",
          filter: "blur(64px) saturate(1.5)",
          opacity: intensity,
        }}
      />
      <div style={{ position: "absolute", inset: 0, background: fade }} />
      <div style={{ position: "absolute", inset: 0, background: `linear-gradient(180deg, transparent 55%, color-mix(in srgb, ${base} 85%, transparent) 100%)` }} />
    </div>
  );
};
