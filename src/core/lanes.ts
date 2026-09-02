import { roleLabel } from "./roles";

/**
 * Los carriles, para las pantallas que los pintan dentro de una frase.
 *
 * Estaba escrito a mano en cada sitio que lo necesitaba (un ternario en "Hoy",
 * tres cabeceras clavadas en Patrones), así que "Bot" y "ADC" convivían para la
 * misma cosa y ninguna de las dos pasaba por el diccionario.
 *
 * El vocabulario y los alias viven en `roles.ts`, que ya normaliza los dos que
 * usa la app (el de Riot y el del entrenamiento). Esto es la capa de encima: la
 * traduce. Recibe `t` en vez de devolver una clave porque quien llama casi
 * siempre está componiendo una frase, y traducir fuera es justo el paso que se
 * olvida.
 */

export type Lane = "top" | "jungle" | "mid" | "bot" | "support";

/** Orden de carril, de arriba a abajo del mapa. El del cliente de Riot. */
export const LANES: Lane[] = ["top", "jungle", "mid", "bot", "support"];

/** Los tres carriles de línea. Es lo que mide el punto ciego de la cámara. */
export const SIDE_LANES: Lane[] = ["top", "mid", "bot"];

/**
 * Nombre del carril, ya traducido. Con una entrada desconocida devuelve la
 * propia entrada: es preferible a un hueco.
 */
export const laneLabel = (
  lane: string,
  t: (key: string, vars?: Record<string, string | number>) => string
): string => {
  const clave = roleLabel(lane);
  return clave ? t(clave) : lane;
};
