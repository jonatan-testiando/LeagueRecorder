// Estilos inline del reproductor de review. Separados de VideoPlayer.tsx por volumen: son datos,
// no lógica, y ocupaban un tercio del archivo.
//
// El cromo del reproductor —cabecera, escenario y su HUD, línea de tiempo,
// transporte, barra del recortador, inspector— vive ya entero en
// VideoPlayer.css, que es donde caben hover, foco, estados por atributo y el
// ámbito oscuro del escenario. Aquí queda lo que aún no tiene clase.
// Ningún color escrito a mano: todo son tokens de index.css, así el tema claro
// llega aquí sin que este fichero se entere.

import React from "react";

export const styles: Record<string, React.CSSProperties> = {
  emptyEvents: {
    color: "var(--faint)",
    fontSize: "var(--font-sm)",
    textAlign: "center",
    padding: "var(--space-6) var(--space-4)",
  },
};

/**
 * Estilos de los widgets de análisis (mapa táctico, ganks, picos de poder,
 * tendencias, curva de oro, conciencia de mapa).
 *
 * Todo texto en sans con cifras tabulares y a 12 px como mínimo (rediseño
 * Post-partida): la mono es solo de los instantes del vídeo y los atajos, y
 * eso lo ponen las clases `.u-time` y `.u-kbd`, no estos objetos.
 *
 * Vienen de seis ficheros donde cada uno se había redibujado su propia tarjeta:
 * borde de color arriba, sombra grande, insignia con fondo translúcido y una
 * paleta distinta cada vez. Ahora no llevan tarjeta: viven DENTRO del
 * inspector, que ya es la superficie, y su gramática es la de las secciones que
 * tenían al lado (`.sect__head`, `.drow`, `.insp__press`, `.imp__row`).
 *
 * Sólo queda aquí lo que no tiene clase: rejillas, el mapa y las curvas.
 */
export const wstyles: Record<string, React.CSSProperties> = {
  // --- armazón común ------------------------------------------------------
  body: { display: "flex", flexDirection: "column", gap: "var(--space-3)" },
  headRight: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-2)",
    marginLeft: "auto",
  },
  toolbar: { display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" },
  list: { display: "flex", flexDirection: "column" },
  // Cifra suelta con su etiqueta, para las rejillas de comparación.
  statBox: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    padding: "var(--space-2) var(--space-3)",
    border: "1px solid var(--hair)",
    borderRadius: "var(--radius-md)",
    background: "var(--sunken)",
  },
  statGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(132px, 1fr))",
    gap: "var(--space-2)",
  },
  statValue: {
    fontFamily: "var(--font-sans)",
    fontSize: "15px",
    fontWeight: 500,
    color: "var(--text)",
    fontVariantNumeric: "tabular-nums",
  },
  statDelta: {
    fontFamily: "var(--font-sans)",
    fontSize: "12px",
    fontVariantNumeric: "tabular-nums",
    display: "flex",
    alignItems: "center",
    gap: "4px",
  },



  // --- curva de oro / XP --------------------------------------------------
  chartWrap: { position: "relative", width: "100%", height: "120px" },
  chartSvg: { width: "100%", height: "100%", cursor: "pointer", overflow: "visible" },
  chartTip: {
    position: "absolute",
    top: "-34px",
    transform: "translateX(-50%)",
    padding: "3px var(--space-2)",
    borderRadius: "var(--radius-sm)",
    background: "color-mix(in srgb, var(--ground) 92%, transparent)",
    border: "1px solid var(--hair-strong)",
    fontFamily: "var(--font-sans)",
    fontVariantNumeric: "tabular-nums",
    fontSize: "12px",
    color: "var(--text)",
    pointerEvents: "none",
    whiteSpace: "nowrap",
    zIndex: 10,
  },
};
