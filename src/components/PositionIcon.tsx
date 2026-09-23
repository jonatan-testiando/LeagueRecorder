import React from "react";

/**
 * Icono de posición al estilo del cliente de LoL: el cuadrado de la Grieta con
 * la calle que toca resaltada. Es vocabulario que un jugador lee sin aprender.
 *
 * Acepta los nombres de Riot ("TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY")
 * y los alias habituales ("mid", "adc", "support", "jg"…), en cualquier caja.
 */
export type Position = "TOP" | "JUNGLE" | "MIDDLE" | "BOTTOM" | "UTILITY";

const ALIASES: Record<string, Position> = {
  top: "TOP",
  jungle: "JUNGLE", jg: "JUNGLE", jungla: "JUNGLE",
  middle: "MIDDLE", mid: "MIDDLE",
  bottom: "BOTTOM", bot: "BOTTOM", adc: "BOTTOM", carry: "BOTTOM",
  utility: "UTILITY", support: "UTILITY", sup: "UTILITY", supp: "UTILITY", soporte: "UTILITY",
};

export function normalizePosition(p?: string | null): Position | null {
  if (!p) return null;
  return ALIASES[p.trim().toLowerCase()] ?? null;
}

/** Nombre corto en inglés (clave de i18n): "Top", "Jungle", "Mid", "ADC", "Support". */
export const POSITION_LABEL: Record<Position, string> = {
  TOP: "Top",
  JUNGLE: "Jungle",
  MIDDLE: "Mid",
  BOTTOM: "ADC",
  UTILITY: "Support",
};

interface Props {
  position: string | null | undefined;
  size?: number;
  /** Color de la calle resaltada. El resto del mapa va al 35 % del mismo color. */
  color?: string;
  title?: string;
}

export const PositionIcon: React.FC<Props> = ({ position, size = 16, color = "currentColor", title }) => {
  const pos = normalizePosition(position);
  if (!pos) return null;
  const dim = { stroke: color, strokeOpacity: 0.35 };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      style={{ flexShrink: 0 }}
    >
      {pos === "TOP" && (
        <>
          <path d="M4 20V4h16" stroke={color} />
          <path d="M20 8v12H8" {...dim} />
          <rect x="9" y="9" width="6" height="6" rx="1" {...dim} />
        </>
      )}
      {pos === "BOTTOM" && (
        <>
          <path d="M4 20h16V4" stroke={color} />
          <path d="M4 16V4h12" {...dim} />
          <rect x="9" y="9" width="6" height="6" rx="1" {...dim} />
        </>
      )}
      {pos === "MIDDLE" && (
        <>
          <path d="M5 19 19 5" stroke={color} />
          <path d="M4 14V4h10M10 20h10V10" {...dim} />
        </>
      )}
      {pos === "JUNGLE" && (
        <>
          <path d="M12 3c-1.5 4-5 6-7 7 3 1 5 4 5 11 1.2-2.4 1.6-4.6 2-7 .4 2.4.8 4.6 2 7 0-7 2-10 5-11-2-1-5.5-3-7-7Z" stroke={color} />
        </>
      )}
      {pos === "UTILITY" && (
        <>
          <path d="M12 21c-4-2-7-5-7-10V6l7-3 7 3v5c0 5-3 8-7 10Z" stroke={color} />
          <path d="M12 8v6M9 11h6" stroke={color} />
        </>
      )}
    </svg>
  );
};
