import React, { createContext, useContext } from "react";
import { createPortal } from "react-dom";

/**
 * El hueco de la barra de título donde cada pantalla pinta su título (piel A).
 * Lo da `App` y lo rellena cada pantalla con `ScreenTitle`: así el título no
 * gasta una fila propia encima del contenido.
 */
export const TitleSlotContext = createContext<HTMLElement | null>(null);

/**
 * Si la pantalla que pinta el título es la visible. `App` mantiene montadas las
 * pantallas ya visitadas (solo las oculta), así que sin esto todas pintarían su
 * título a la vez en la barra.
 */
export const PanelActiveContext = createContext(true);

/**
 * Título y subtítulo de la pantalla, pintados en la barra de título. Se funde
 * con la pantalla (los mismos 120 ms del cambio de sección) para no llegar
 * antes que ella. `children` son controles pequeños que van junto al título.
 */
export const ScreenTitle: React.FC<{
  title: React.ReactNode;
  sub?: React.ReactNode;
  children?: React.ReactNode;
  /**
   * La pantalla se centra en una columna y el título se alinea con su borde,
   * no con el raíl: «content» en --content-max (pantallas de datos), «wide» en
   * --content-wide (Biblioteca), «form» en --form-max (Ajustes, Entrenamiento,
   * Análisis).
   */
  align?: "content" | "wide" | "form";
}> = ({ title, sub, children, align }) => {
  const slot = useContext(TitleSlotContext);
  const active = useContext(PanelActiveContext);
  if (!slot || !active) return null;
  return createPortal(
    // El fundido de entrada (0,4 → 1 en 120 ms) es CSS (`.screen-title`):
    // antes era framer-motion solo para esto.
    <div className={align ? `screen-title screen-title--${align}` : "screen-title"}>
      <div className="screen-title__txt">
        <h1 className="screen-title__h1">{title}</h1>
        {sub && <p className="screen-title__sub">{sub}</p>}
      </div>
      {children && <div className="screen-title__extra">{children}</div>}
    </div>,
    slot,
  );
};

/**
 * Apaga el título de lo que lleva dentro aunque su pantalla sea la visible: la
 * Biblioteca sigue montada (oculta) bajo el reproductor, y el título de la
 * barra es entonces el de la partida.
 */
export const TitleOff: React.FC<{ off: boolean; children: React.ReactNode }> = ({ off, children }) => {
  const active = useContext(PanelActiveContext);
  return <PanelActiveContext.Provider value={active && !off}>{children}</PanelActiveContext.Provider>;
};
