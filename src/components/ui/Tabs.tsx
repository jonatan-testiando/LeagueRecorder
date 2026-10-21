import React, { useRef } from "react";
import { useIndicator } from "./useIndicator";

/**
 * Pestañas: cambian el panel de debajo. El subrayado de oro se desliza a la
 * pestaña elegida (200 ms) y el contenido cambia al instante: lo que se mueve
 * dice qué ha cambiado, el contenido nuevo no tiene que llegar de ningún sitio.
 *
 * Con el teclado: ← y → (y Inicio/Fin) cambian de pestaña y el foco va con
 * ella; Tab sale de la tira hacia el panel.
 */
export interface TabItem<T extends string> {
  value: T;
  label: React.ReactNode;
}

export interface TabsProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  tabs: TabItem<T>[];
  /** Nombre de la tira para lectores de pantalla. */
  label: string;
  /** Prefijo de los id: la pestaña es `${idBase}-tab-${value}` y su panel `${idBase}-panel-${value}`. */
  idBase?: string;
  className?: string;
}

export function Tabs<T extends string>({ value, onChange, tabs, label, idBase, className = "" }: TabsProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const active = tabs.findIndex((t) => t.value === value);
  useIndicator(ref, active, [tabs.length]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };
    let next = -1;
    if (e.key in keys) next = (active + keys[e.key] + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(tabs[next].value);
    ref.current?.querySelectorAll<HTMLElement>("[data-ind-opt]")[next]?.focus();
  };

  return (
    <div ref={ref} className={`tabs ${className}`.trim()} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((t) => {
        const on = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            className="tabs__tab"
            data-ind-opt=""
            id={idBase ? `${idBase}-tab-${t.value}` : undefined}
            aria-controls={idBase ? `${idBase}-panel-${t.value}` : undefined}
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.value)}
          >
            {t.label}
          </button>
        );
      })}
      <span className="tabs__ink" aria-hidden="true" />
    </div>
  );
}
