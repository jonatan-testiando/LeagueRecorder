import React from "react";

/**
 * La marca de la app.
 *
 * Un marcapáginas: marcar el momento que duele para volver a él. La forma vive
 * también en `assets/brand/mark.svg`, que es de donde se generan el icono de la
 * ventana y el del instalador; si se cambia una, se cambian las dos.
 *
 * Hereda el color (`currentColor`) a propósito: la marca es de una sola tinta,
 * así que quien la coloca decide si va en oro, en hueso o en el color del texto
 * de al lado. Nunca lleva dos colores.
 */
export const BrandMark: React.FC<{ size?: number; className?: string }> = ({
  size = 16,
  className,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 64 64"
    fill="none"
    className={className}
    aria-hidden="true"
    focusable="false"
  >
    <path d="M15 4 H49 V60 L32 46.5 L15 60 Z" fill="currentColor" />
  </svg>
);
