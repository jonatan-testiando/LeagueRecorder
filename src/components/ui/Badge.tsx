import React from "react";
import { Chip, type ChipTone } from "./Chip";

/**
 * Insignia. El tono es semántico y de ahí sale el color: nadie escribe un hex
 * al usarla.
 *
 * Nota de diseño: en la fila de partida las insignias estaban compitiendo entre
 * sí (cinco a la vez, todas con el mismo peso y fondos translúcidos distintos).
 * Por eso hay dos intensidades. `solid` es para lo único que importa de un
 * vistazo y es un Chip; `quiet` es el resto, solo texto tintado, que se lee
 * cuando ya has decidido mirar.
 */
export type BadgeTone = "win" | "loss" | "objective" | "flag" | "neutral";

const TONE_VAR: Record<BadgeTone, string> = {
  win: "var(--win)",
  loss: "var(--loss)",
  objective: "var(--gold)",
  flag: "var(--flag)",
  neutral: "var(--muted)",
};

const CHIP_TONE: Record<BadgeTone, ChipTone> = {
  win: "win",
  loss: "loss",
  objective: "gold",
  flag: "finding",
  neutral: "neutral",
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
}) =>
  emphasis === "solid" ? (
    <Chip tone={CHIP_TONE[tone]} title={title}>
      {children}
    </Chip>
  ) : (
    <span className="badge" title={title} style={{ color: TONE_VAR[tone], border: "1px solid transparent" }}>
      {children}
    </span>
  );
