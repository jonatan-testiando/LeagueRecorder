import React from "react";

/**
 * Superficie elevada. Antes estaba redibujada desde cero en cinco `const
 * styles` distintos, y por eso ninguna era igual a la anterior.
 *
 * `accent` pinta una franja de 2px en el borde izquierdo: es la forma barata de
 * codificar estado sin gastar una insignia más.
 */
export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
  /** Color CSS (token) para la franja de estado del borde izquierdo. */
  accent?: string;
  /** Anima la entrada. Nunca en listas virtualizadas: se redispara al scrollear. */
  animateIn?: boolean;
}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ interactive, accent, animateIn, className = "", style, children, ...rest }, ref) => (
    <div
      ref={ref}
      {...rest}
      className={[
        "card",
        interactive ? "card--interactive" : "",
        animateIn ? "card--in" : "",
        className,
      ].filter(Boolean).join(" ")}
      style={accent ? { ...style, borderLeft: `2px solid ${accent}` } : style}
    >
      {children}
    </div>
  )
);
Card.displayName = "Card";
