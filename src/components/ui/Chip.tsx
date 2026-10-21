import React from "react";

/**
 * Chip de estado: una píldora de 22 px que dice en qué está algo («Revisada»,
 * «Por revisar», «Error», «Hallazgo»). No se pulsa: para filtrar, Segmented.
 *
 * Sustituye a las píldoras que cada pantalla dibujaba a su manera (lib-pill,
 * home-pill, las insignias sólidas de Badge, el chip de tono del reproductor).
 *
 * Tonos: neutro, victoria, derrota, hallazgo, oro y contorno. El fondo es el
 * tono suave del tinte y el texto va en su tinta (--*-ink): en claro, el tinte
 * tal cual sobre su propio suave no llegaba a AA.
 */
export type ChipTone = "neutral" | "win" | "loss" | "finding" | "gold" | "outline";

export interface ChipProps {
  tone?: ChipTone;
  /** Punto de color delante del texto, como en la leyenda de la línea de tiempo. */
  dot?: boolean;
  icon?: React.ReactNode;
  title?: string;
  className?: string;
  children: React.ReactNode;
}

export const Chip: React.FC<ChipProps> = ({ tone = "neutral", dot = false, icon, title, className = "", children }) => (
  <span className={`chip chip--${tone} ${className}`.trim()} title={title}>
    {dot && <i className="chip__dot" aria-hidden="true" />}
    {icon}
    {children}
  </span>
);
