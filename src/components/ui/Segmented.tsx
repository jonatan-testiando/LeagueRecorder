import React, { useRef } from "react";
import { useIndicator } from "./useIndicator";

/**
 * Control segmentado: un carril en píldora con un indicador que se desliza a
 * la opción elegida. Sustituye a los seis que había (`tp-seg`, `cg-seg`,
 * `lib-seg`, `pp-seg`, la «Calidad» de Ajustes y las pestañas-botón de
 * Training), que hacían lo mismo con seis dibujos distintos.
 *
 * Es para elegir UNA opción de un conjunto pequeño y visible (filtro, orden,
 * periodo, calidad). Para cambiar de panel, `Tabs`.
 *
 * - `md` (34 px) es el de las barras de filtros; `sm` (26 px), el de los sitios
 *   densos: transporte del reproductor, gráficos del inspector, filas de un
 *   formulario.
 * - Cada opción es un botón con `aria-pressed` dentro de un `role="group"`.
 * - La cuenta va en --faint; `countTone: "gold"` la pone en oro (lo que está
 *   por revisar).
 */
export interface SegmentedOption<T extends string | number> {
  value: T;
  label: React.ReactNode;
  count?: React.ReactNode;
  countTone?: "gold";
  icon?: React.ReactNode;
  disabled?: boolean;
  title?: string;
}

export interface SegmentedProps<T extends string | number> {
  value: T | null | undefined;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  /** Nombre del grupo para lectores de pantalla («Filtrar clips»). */
  label: string;
  size?: "md" | "sm";
  className?: string;
  id?: string;
}

export function Segmented<T extends string | number>({
  value,
  onChange,
  options,
  label,
  size = "md",
  className = "",
  id,
}: SegmentedProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const active = options.findIndex((o) => o.value === value);
  useIndicator(ref, active, [options.length]);
  return (
    <div ref={ref} id={id} className={`seg seg--${size} ${className}`.trim()} role="group" aria-label={label}>
      <span className="seg__thumb" aria-hidden="true" />
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          className="seg__opt"
          data-ind-opt=""
          aria-pressed={o.value === value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
          <span>{o.label}</span>
          {o.count != null && (
            <span className={o.countTone === "gold" ? "seg__n seg__n--gold" : "seg__n"}>{o.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}
