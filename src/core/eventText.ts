import { MatchEvent } from "../types";

/**
 * Compone el texto de un suceso.
 *
 * El backend ya no manda la frase montada: manda los datos (`actor`, `target`,
 * `detail`) y aquí se escribe. Así el idioma es una decisión del frontend y no
 * queda congelado dentro del JSON de cada partida.
 *
 * Fallback: las partidas grabadas antes de este cambio no traen esos campos,
 * solo `description`, y en español. Para esas se devuelve la frase tal cual —
 * es información real y borrarla sería peor que mostrarla en otro idioma.
 * `isLegacy` permite a la UI marcarlas si algún día interesa.
 */

const has = (v?: string): v is string => typeof v === "string" && v.length > 0;

const detailParts = (ev: MatchEvent): string[] =>
  has(ev.detail) ? ev.detail.split(",").map((d) => d.trim()).filter(Boolean) : [];

const wasStolen = (ev: MatchEvent): boolean => detailParts(ev).includes("stolen");

/** El primer trozo de `detail` que no sea un marcador conocido. */
const detailValue = (ev: MatchEvent): string | undefined =>
  detailParts(ev).find((d) => d !== "stolen");

const MULTIKILL: Record<string, string> = {
  "2": "Double kill",
  "3": "Triple kill",
  "4": "Quadra kill",
  "5": "Pentakill",
};

export interface EventText {
  text: string;
  /** true si viene de `description` porque la partida es anterior al cambio. */
  isLegacy: boolean;
}

export function describeEventFull(ev: MatchEvent): EventText {
  const structured = has(ev.actor) || has(ev.target) || has(ev.detail);
  const stolen = wasStolen(ev) ? " (stolen)" : "";

  if (structured) {
    switch (ev.type) {
      case "ChampionKill":
        if (ev.subtype === "kill" && has(ev.target)) {
          return { text: `Killed ${ev.target}`, isLegacy: false };
        }
        if (ev.subtype === "death" && has(ev.actor)) {
          return { text: `Killed by ${ev.actor}`, isLegacy: false };
        }
        if (ev.subtype === "assist" && has(ev.target)) {
          return { text: `Assisted killing ${ev.target}`, isLegacy: false };
        }
        break;

      case "Multikill": {
        const n = detailValue(ev);
        return { text: (n && MULTIKILL[n]) || "Multi kill", isLegacy: false };
      }

      case "DragonKill": {
        const kind = detailValue(ev);
        const what = kind ? `${kind} Dragon` : "Dragon";
        if (ev.subtype === "ally") return { text: `Your team took the ${what}${stolen}`, isLegacy: false };
        if (ev.subtype === "enemy") return { text: `Enemy took the ${what}${stolen}`, isLegacy: false };
        return { text: `${what}${stolen}`, isLegacy: false };
      }

      case "HeraldKill":
        if (ev.subtype === "ally") return { text: `Your team took Rift Herald${stolen}`, isLegacy: false };
        if (ev.subtype === "enemy") return { text: `Enemy took Rift Herald${stolen}`, isLegacy: false };
        return { text: `Rift Herald${stolen}`, isLegacy: false };

      case "BaronKill":
        if (ev.subtype === "ally") return { text: `Your team killed Baron Nashor${stolen}`, isLegacy: false };
        if (ev.subtype === "enemy") return { text: `Enemy killed Baron Nashor${stolen}`, isLegacy: false };
        return { text: `Baron Nashor${stolen}`, isLegacy: false };
    }
  }

  // Sucesos sin datos que componer: la frase del backend ya está en inglés
  // desde el cambio, y en español en las partidas viejas.
  return { text: ev.description, isLegacy: !structured && ev.description.length > 0 };
}

export const describeEvent = (ev: MatchEvent): string => describeEventFull(ev).text;
