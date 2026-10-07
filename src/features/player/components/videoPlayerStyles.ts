// Estilos inline del reproductor de review. Separados de VideoPlayer.tsx por volumen: son datos,
// no lógica, y ocupaban un tercio del archivo.
//
// Aquí queda solo lo que necesita un valor calculado o una posición absoluta
// (capas sobre el vídeo, la tira de miradas, la barra del recortador). El cromo
// de la pantalla —cabecera, rejilla, línea de tiempo con sus marcas y cabezal,
// transporte, inspector, filas y chips— vive en VideoPlayer.css, que es donde
// caben hover, foco y estados por atributo.
// Ningún color escrito a mano: todo son tokens de index.css, así el tema claro
// llega aquí sin que este fichero se entere.

import React from "react";

export const styles: Record<string, React.CSSProperties> = {
  video: {
    width: "100%",
    height: "100%",
    objectFit: "contain",
  },
  // Velo sobre el vídeo para el spinner y los estados vacíos. Va sobre el
  // mismo hundido que el marco, no sobre un negro fijo: en tema claro el marco
  // es gris y el velo tiene que ser del mismo material.
  centerOverlay: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "color-mix(in srgb, var(--sunken) 72%, transparent)",
  },
  // En pantalla completa no hay baraja: aviso, tira y transporte flotan juntos
  // sobre el vídeo, dentro de fsBottom (que pone el degradado y la posición).
  fsBottom: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
    padding: "18px 16px 12px",
    background:
      "linear-gradient(to top, color-mix(in srgb, var(--sunken) 92%, transparent), color-mix(in srgb, var(--sunken) 55%, transparent) 70%, transparent)",
  },
  // La tira compacta (sin curva de APM) pone su propio alto. En bloque y no en
  // columna flex: ahí su `flex: 1` (que en la tarjeta normal es el ANCHO) se
  // comía la altura y el transporte se le montaba encima.
  fsTimeline: {
    position: "relative",
    display: "block",
  },
  // Tira de saltos de cámara al pie del gráfico de APM.
  snapStrip: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: "12px",
    pointerEvents: "none",
    zIndex: 3,
  },
  // Una fila por carril dentro de la tira. 3 px de alto y 1 de aire: las tres
  // caben en los 12 px de la tira sin tocarse.
  snapLane: {
    position: "absolute",
    left: 0,
    right: 0,
    height: "3px",
  },
  snapTick: {
    position: "absolute",
    bottom: 0,
    width: "2px",
    height: "100%",
    marginLeft: "-1px",
    background: "var(--cool)",
    opacity: 0.75,
    borderRadius: "1px",
  },
  resizeHandle: {
    position: "absolute",
    left: "-3px",
    top: 0,
    bottom: 0,
    width: "7px",
    cursor: "ew-resize",
    zIndex: 30,
  },
  emptyEvents: {
    color: "var(--faint)",
    fontSize: "var(--font-sm)",
    textAlign: "center",
    padding: "var(--space-6) var(--space-4)",
  },
  champIcon: {
    width: "26px",
    height: "26px",
    borderRadius: "50%",
    background: "var(--sunken)",
    flexShrink: 0,
    objectFit: "cover",
  },

  // --- barra del recortador ---------------------------------------------
  clipBar: {
    position: "absolute",
    bottom: "var(--space-12)",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 50,
    display: "flex",
    alignItems: "center",
    gap: "var(--space-4)",
    maxWidth: "min(760px, calc(100% - var(--space-8)))",
    padding: "var(--space-3) var(--space-4)",
    background: "var(--panel)",
    border: "1px solid var(--hair-strong)",
    borderRadius: "var(--radius-lg)",
    boxShadow: "inset 0 1px 0 var(--rim), var(--shadow-2)",
  },
  clipTitle: {
    display: "block",
    fontSize: "13.5px",
    fontWeight: 500,
    color: "var(--text)",
    whiteSpace: "nowrap",
  },
  clipRange: { display: "block", fontSize: "12px", color: "var(--faint)" },
  clipNote: {
    flex: 1,
    minWidth: 160,
    padding: "var(--space-2) var(--space-3)",
    borderRadius: "var(--radius-md)",
    border: "1px solid var(--hair-strong)",
    background: "var(--sunken)",
    boxShadow: "var(--inset-sunken)",
    color: "var(--text)",
    fontFamily: "var(--font-sans)",
    fontSize: "13px",
    outline: "none",
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
