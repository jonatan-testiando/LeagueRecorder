import { MatchEvent } from "../types";

/**
 * Compone el texto de un suceso.
 *
 * El backend ya no manda la frase montada: manda los datos (`actor`, `target`,
 * `detail`) y aquí se escribe. Así el idioma es una decisión del frontend y no
 * queda congelado dentro del JSON de cada partida.
 *
 * Y por eso mismo recibe `t`: la frase lleva nombres dentro ("Matas a Ahri"),
 * así que no se puede traducir DESPUÉS — buscar en el diccionario la cadena ya
 * montada nunca acierta. Se compone en el idioma bueno o se queda en inglés
 * dentro de una interfaz en español, que es lo que pasaba.
 *
 * Fallback: las partidas grabadas antes de este cambio no traen esos campos,
 * solo `description`, y en español. Para esas se devuelve la frase tal cual —
 * es información real y borrarla sería peor que mostrarla en otro idioma.
 * `isLegacy` permite a la UI marcarlas si algún día interesa.
 */

/** La firma de `t` que devuelve `useT()`. */
export type Translate = (key: string, vars?: Record<string, string | number>) => string;

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

/**
 * Nombres de dragón de Riot → clave de diccionario.
 *
 * El backend manda el nombre INGLÉS ("Mountain", "Chemtech"). Componer
 * "{kind} Dragon" e intentar traducir la pieza suelta no vale: en español el
 * adjetivo va detrás y con preposición ("Dragón de Montaña"), o sea que la
 * frase entera tiene que ser la clave.
 */
const DRAGON_KEY: Record<string, string> = {
  mountain: "Mountain Dragon",
  ocean: "Ocean Dragon",
  infernal: "Infernal Dragon",
  cloud: "Cloud Dragon",
  hextech: "Hextech Dragon",
  chemtech: "Chemtech Dragon",
  elder: "Elder Dragon",
};

export interface EventText {
  text: string;
  /** true si viene de `description` porque la partida es anterior al cambio. */
  isLegacy: boolean;
}

/**
 * Frase para un objetivo tomado: la misma plantilla sirve para dragón, heraldo
 * y barón, y el robo es una frase distinta, no un sufijo pegado — "(robado)"
 * detrás de una oración en español se lee como una nota al pie.
 */
const objectiveLine = (
  t: Translate,
  subtype: string | undefined,
  what: string,
  stolen: boolean
): string => {
  if (subtype === "ally") {
    return stolen ? t("Your team stole {what}", { what }) : t("Your team took {what}", { what });
  }
  if (subtype === "enemy") {
    return stolen ? t("Enemy stole {what}", { what }) : t("Enemy took {what}", { what });
  }
  return stolen ? t("{what} (stolen)", { what }) : what;
};

export function describeEventFull(ev: MatchEvent, t: Translate): EventText {
  const structured = has(ev.actor) || has(ev.target) || has(ev.detail);
  const stolen = wasStolen(ev);

  if (structured) {
    switch (ev.type) {
      case "ChampionKill":
        if (ev.subtype === "kill" && has(ev.target)) {
          return { text: t("Killed {target}", { target: ev.target }), isLegacy: false };
        }
        if (ev.subtype === "death" && has(ev.actor)) {
          return { text: t("Killed by {actor}", { actor: ev.actor }), isLegacy: false };
        }
        if (ev.subtype === "assist" && has(ev.target)) {
          return { text: t("Assisted killing {target}", { target: ev.target }), isLegacy: false };
        }
        break;

      case "Multikill": {
        const n = detailValue(ev);
        return { text: t((n && MULTIKILL[n]) || "Multi kill"), isLegacy: false };
      }

      case "DragonKill": {
        const kind = detailValue(ev);
        const key = kind ? DRAGON_KEY[kind.toLowerCase()] : undefined;
        // Un tipo de dragón que no conocemos (o el nombre en otro idioma de una
        // partida vieja) se pinta tal cual: decir "Dragón" a secas perdería el
        // dato que sí tenemos.
        const what = key ? t(key) : kind ? t("{kind} Dragon", { kind }) : t("Dragon");
        return { text: objectiveLine(t, ev.subtype, what, stolen), isLegacy: false };
      }

      case "HeraldKill":
        return { text: objectiveLine(t, ev.subtype, t("Rift Herald"), stolen), isLegacy: false };

      case "BaronKill":
        return { text: objectiveLine(t, ev.subtype, t("Baron Nashor"), stolen), isLegacy: false };
    }
  }

  // Sucesos sin datos que componer: la frase del backend ya está en inglés
  // desde el cambio, y en español en las partidas viejas.
  return { text: ev.description, isLegacy: !structured && ev.description.length > 0 };
}

export const describeEvent = (ev: MatchEvent, t: Translate): string =>
  describeEventFull(ev, t).text;
