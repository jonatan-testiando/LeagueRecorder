import React from "react";

/**
 * La marca de la app: Wardline.
 *
 * El minimapa reducido a lo que lee el análisis: las dos bases y los tres
 * carriles (arriba y abajo por el borde, el centro en diagonal), sobre la
 * baldosa roja. Se eligió en el laboratorio del preview del sistema de diseño
 * (2026-10-29). La forma vive también en `assets/brand/mark.svg`, que es de
 * donde se generan el icono de la ventana y el del instalador; si se cambia
 * una, se cambian las dos.
 *
 * Son dos colores fijos a propósito: una marca no cambia con el tema.
 */
export const BrandMark: React.FC<{ size?: number; className?: string }> = ({
  size = 16,
  className,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    className={className}
    aria-hidden="true"
    focusable="false"
  >
    <rect x={1} y={1} width={22} height={22} rx={6.5} fill="#d4002a" />
    <path
      d="M6.2 13.5V6.2h7.3M10.5 17.8h7.3v-7.3M9.2 14.8l5.6-5.6"
      stroke="#f2efe9"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <rect x={4} y={15.5} width={4.5} height={4.5} rx={1.3} fill="#f2efe9" />
    <rect x={15.5} y={4} width={4.5} height={4.5} rx={1.3} fill="#f2efe9" />
  </svg>
);
