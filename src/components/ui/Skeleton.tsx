import React from "react";
import { useT } from "../../core/LanguageProvider";

/**
 * Esqueleto: la forma de lo que va a llegar, mientras llega. Es para el
 * contenido (paneles, listas, secciones); una acción lanzada desde un botón
 * lleva su spinner dentro del botón (`Button loading`), y un proceso de más
 * de 2 s, una barra con porcentaje.
 *
 * Quien lo pinta decide CUÁNDO con `useDelayedLoading`: aparece a los 150 ms
 * (lo que carga antes no parpadea) y, una vez visible, se queda 300 ms como
 * mínimo (no aparece y desaparece de golpe).
 *
 * Formas (Figma, Componentes · Esqueleto): línea de 12 px con radio 4, bloque
 * con radio 8 y círculo.
 */
export type SkeletonShape = "line" | "block" | "circle";

export interface SkeletonProps {
  shape?: SkeletonShape;
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: React.CSSProperties;
}

export const Skeleton: React.FC<SkeletonProps> = ({ shape = "line", width, height, className = "", style }) => (
  <span
    className={`skeleton skeleton--${shape} ${className}`.trim()}
    style={{ width, height, ...style }}
    aria-hidden="true"
  />
);

/**
 * Unas líneas con la forma de un párrafo o de una lista corta: el esqueleto de
 * una sección del inspector. La última va más corta, como un párrafo de
 * verdad.
 */
export const SkeletonLines: React.FC<{ lines?: number; className?: string }> = ({ lines = 3, className = "" }) => {
  const t = useT();
  return (
    <div className={`skeleton-lines ${className}`.trim()} role="status" aria-busy="true" aria-label={t("Loading…")}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={i === lines - 1 && lines > 1 ? "62%" : "100%"} />
      ))}
    </div>
  );
};
