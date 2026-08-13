import React from "react";

/**
 * Botón. Sustituye a las cinco definiciones distintas de "botón" que había
 * repartidas por los `const styles` de cada pantalla.
 *
 * Las variantes son de intención, no de color: quien la usa dice *qué* es el
 * botón, no de qué color lo quiere. Así un cambio de piel no obliga a repasar
 * las llamadas.
 */
export type ButtonVariant = "primary" | "ghost" | "icon" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icono a la izquierda del texto. En `variant="icon"` es el contenido entero. */
  icon?: React.ReactNode;
}

export const Button: React.FC<ButtonProps> = ({
  variant = "ghost",
  size = "md",
  icon,
  children,
  className = "",
  ...rest
}) => (
  <button
    {...rest}
    className={`btn btn--${variant} btn--${size} ${className}`.trim()}
  >
    {icon}
    {children}
  </button>
);
