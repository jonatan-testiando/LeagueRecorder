import React from "react";
import "./MatchTab.css";

/**
 * Un "?" con la regla o la definición en su `title`.
 *
 * Al pie de cada sección de Partida había un párrafo de letra pequeña con las
 * reglas ("invadir con los dos carriles empujados…", "mirada: clic de
 * minimapa…"). Hacía falta una vez y luego era ruido que se leía cada vez. El
 * texto sigue a un gesto (pasar el ratón o el foco con el teclado).
 */
export const HelpDot: React.FC<{ text: string }> = ({ text }) => (
  <span className="mt-help" tabIndex={0} role="img" title={text} aria-label={text}>
    ?
  </span>
);
