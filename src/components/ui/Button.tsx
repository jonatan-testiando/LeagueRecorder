import React from "react";

/**
 * Botón. Sustituye a las cinco definiciones distintas de "botón" que había
 * repartidas por los `const styles` de cada pantalla.
 *
 * Las variantes son de intención, no de color: quien la usa dice *qué* es el
 * botón, no de qué color lo quiere. Así un cambio de piel no obliga a repasar
 * las llamadas.
 *
 * Responde en el `pointerdown` (se encoge a 0,97 mientras está pulsado): la
 * sensación de que la app va rápida empieza ahí, no en el `click`.
 */
export type ButtonVariant = "primary" | "ghost" | "icon" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icono a la izquierda del texto. En `variant="icon"` es el contenido entero. */
  icon?: React.ReactNode;
  /**
   * Acción en curso lanzada desde este botón (menos de 2 s: comprobar una
   * clave, sincronizar). Pone un spinner en el sitio del icono y, si se da
   * `loadingLabel`, cambia el texto por el verbo en gerundio con sus puntos
   * suspensivos («Comprobando…»). Mientras dura, no se puede pulsar. Con
   * movimiento reducido el spinner se quita y, si no hay verbo, el CSS añade
   * «…» al texto para que siga diciendo que trabaja.
   */
  loading?: boolean;
  loadingLabel?: React.ReactNode;
}

export const Button: React.FC<ButtonProps> = ({
  variant = "ghost",
  size = "md",
  icon,
  loading = false,
  loadingLabel,
  children,
  className = "",
  disabled,
  onClick,
  ...rest
}) => {
  const label = loading && loadingLabel != null ? loadingLabel : children;
  return (
    <button
      {...rest}
      disabled={disabled}
      // Sin `disabled` mientras carga: así no se pierde el foco ni se apaga el
      // botón entero, solo deja de responder.
      onClick={loading ? undefined : onClick}
      aria-busy={loading || undefined}
      data-loading={loading ? (loadingLabel != null ? "label" : "spin") : undefined}
      className={`btn btn--${variant} btn--${size} ${className}`.trim()}
    >
      {loading ? <span className="btn__spinner" aria-hidden="true" /> : icon}
      {label != null && label !== false && <span className="btn__label">{label}</span>}
    </button>
  );
};
