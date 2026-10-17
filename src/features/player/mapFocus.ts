/**
 * El Mapa (antes «Recorrido») abierto en un momento concreto.
 *
 * Las estadísticas de mapa (invasiones, ganks, muertes, objetivos, presión)
 * son datos de posición: escritos en la columna lateral se leen mal, y
 * dibujados encima del minimapa de la grabación se entienden de un vistazo.
 * Cada fila de Partida o Impacto que habla de un sitio construye uno de estos
 * y llama a `onOpenMap`: el reproductor pasa al Mapa, salta a ese instante y
 * `RouteReplay` dibuja lo que trae.
 *
 * Tiempos en segundos de PARTIDA (los del reloj del juego). Coordenadas de
 * juego (0..14870, origen abajo a la izquierda), las mismas que la API y el
 * detector del minimapa.
 */

export type MapFocusKind = "invade" | "gank" | "death" | "objective" | "pressure" | "moment";

export type MapTone = "good" | "bad" | "neutral";

/** Algo que señalar en el mapa. */
export interface MapMark {
  x: number;
  y: number;
  kind: "camp" | "death" | "ally_death" | "kill" | "tower" | "inhibitor" | "plate" | "epic" | "objective" | "gank";
  /** Texto corto junto a la marca, ya traducido ("+650", "Torre"). */
  label?: string;
  tone?: MapTone;
  /** Cuándo pasó (partida). Sin él, se enseña durante todo el foco. */
  t?: number;
}

export interface MapFocus {
  kind: MapFocusKind;
  /** El instante clave (partida). */
  t: number;
  /** Fin del tramo (partida), para episodios. Sin él, es un instante. */
  until?: number;
  /** Segundos de vídeo antes de `t` desde los que se reproduce. Def. 5. */
  lead?: number;
  /** Título de la tarjeta del mapa, ya traducido ("Invasión · Lobos"). */
  title: string;
  /** Una frase con el veredicto, ya traducida. */
  detail?: string;
  tone?: MapTone;
  /** Carriles a señalar con dónde estaba su oleada: 0 = tu base, 1 = la suya. */
  lanes?: { lane: "top" | "mid" | "bot"; push: number | null }[];
  /** Radio (unidades de juego) a dibujar alrededor de tu posición: "encima". */
  ring?: number;
  marks?: MapMark[];
  /** Episodio de presión: pide la franja de vida y rivales encima. */
  episode?: { from: number; to: number };
}

export type OpenMap = (focus: MapFocus) => void;
