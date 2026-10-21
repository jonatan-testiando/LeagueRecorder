import React from "react";

/**
 * Insignia. El tono es semántico y de ahí sale el color: nadie escribe un hex
 * al usarla.
 *
 * Nota de diseño: en la fila de partida las insignias estaban compitiendo entre
 * sí (cinco a la vez, todas con el mismo peso y fondos translúcidos distintos).
 * Por eso hay dos intensidades. `solid` es para lo único que importa de un
 * vistazo; `quiet` es el resto, que se lee cuando ya has decidido mirar.
 */
export type BadgeTone = "win" | "loss" | "objective" | "flag" | "neutral";

const TONE_VAR: Record<BadgeTone, string> = {
  win: "var(--win)",
  loss: "var(--loss)",
  objective: "var(--gold)",
  flag: "var(--flag)",
  neutral: "var(--muted)",
};

/** El texto sobre el fondo tintado de `solid` va en tinta: en claro, el tinte
 *  sobre su propio 14 % no llega a AA. */
const TONE_INK: Record<BadgeTone, string> = {
  win: "var(--cool-ink)",
  loss: "var(--loss-ink)",
  objective: "var(--brand-ink)",
  flag: "var(--flag-ink)",
  neutral: "var(--muted)",
};

export interface BadgeProps {
  tone?: BadgeTone;
  /** `quiet` sin fondo, solo texto tintado. Es el que debería usarse por defecto. */
  emphasis?: "solid" | "quiet";
  title?: string;
  children: React.ReactNode;
}

export const Badge: React.FC<BadgeProps> = ({
  tone = "neutral",
  emphasis = "quiet",
  title,
  children,
}) => {
  const c = TONE_VAR[tone];
  return (
    <span
      className="badge"
      title={title}
      style={
        emphasis === "solid"
          ? {
              color: TONE_INK[tone],
              background: `color-mix(in srgb, ${c} 14%, transparent)`,
              border: `1px solid color-mix(in srgb, ${c} 32%, transparent)`,
            }
          : { color: c, background: "transparent", border: "1px solid transparent" }
      }
    >
      {children}
    </span>
  );
};
