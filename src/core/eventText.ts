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

/**
 * Asesinos que no son campeones.
 *
 * La API en directo manda en `KillerName` el id interno de la unidad cuando
 * quien mata no es un jugador: «Minion_T200L1S07N0026», «Turret_T2_C_05_A»,
 * «SRU_Baron12.1.1», «SRU_Dragon_Fire6.3.1». Se pintaba tal cual: «Te mata
 * minion_t200l1s07n0026». Aquí se les da nombre. La frase va entera porque
 * en español cambia el verbo («te matan los súbditos», «te mata una torre»).
 *
 * Los patrones son estrictos (prefijo de Riot y nada más) para no confundir
 * con un jugador que se llame «Tower» o «Minion».
 */
export interface NonChampionKiller {
  /** Sustantivo, para listas y tooltips: «Súbditos», «Barón Nashor». */
  name: string;
  /** La frase de la muerte: «Te matan los súbditos». */
  phrase: string;
}

/** `SRU_Dragon_<x>` de Riot → clave de `DRAGON_KEY`. */
const DRAGON_ID: Record<string, string> = {
  air: "cloud",
  cloud: "cloud",
  fire: "infernal",
  infernal: "infernal",
  water: "ocean",
  ocean: "ocean",
  earth: "mountain",
  mountain: "mountain",
  hextech: "hextech",
  chemtech: "chemtech",
  elder: "elder",
};

/** Monstruos grandes: se nombran en la frase («Te mata Barón Nashor»). */
const EPIC: [RegExp, string][] = [
  [/^sru_baron/, "Baron Nashor"],
  [/^sru_riftherald/, "Rift Herald"],
  [/^sru_atakhan/, "Atakhan"],
];

/** Campamentos: el nombre en la lista, la frase genérica de monstruo. */
const CAMPS: [RegExp, string][] = [
  [/^sru_horde/, "Void Grubs"],
  [/^sru_blue/, "Blue buff"],
  [/^sru_red/, "Red buff"],
  [/^sru_gromp/, "Gromp"],
  [/^sru_murkwolf/, "Wolves"],
  [/^sru_razorbeak/, "Raptors"],
  [/^sru_krug/, "Krugs"],
  [/^sru_crab/, "Rift Scuttler"],
];

export function nonChampionKiller(actor: string | null | undefined, t: Translate): NonChampionKiller | null {
  const id = (actor ?? "").trim().toLowerCase();
  if (!id) return null;

  if (/^minion_t\d/.test(id) || /^sru_(?:order|chaos)minion/.test(id)) {
    return { name: t("Minions"), phrase: t("Killed by minions") };
  }
  if (/^(?:sru_)?turret_/.test(id)) {
    return { name: t("Turret"), phrase: t("Killed by a tower") };
  }
  if (/^sruap_.*fountain|^sru_.*fountain|^obelisk/.test(id)) {
    return { name: t("Fountain"), phrase: t("Killed by the fountain") };
  }
  const dragon = /^sru_dragon_([a-z]+)/.exec(id);
  if (dragon) {
    const key = DRAGON_KEY[DRAGON_ID[dragon[1]] ?? ""];
    const name = key ? t(key) : t("Dragon");
    return { name, phrase: t("Killed by {actor}", { actor: name }) };
  }
  for (const [re, key] of EPIC) {
    if (re.test(id)) {
      const name = t(key);
      return { name, phrase: t("Killed by {actor}", { actor: name }) };
    }
  }
  for (const [re, key] of CAMPS) {
    if (re.test(id)) return { name: t(key), phrase: t("Killed by a jungle monster") };
  }
  if (/^sru_/.test(id)) {
    return { name: t("Jungle monster"), phrase: t("Killed by a jungle monster") };
  }
  return null;
}

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
          const unit = nonChampionKiller(ev.actor, t);
          if (unit) return { text: unit.phrase, isLegacy: false };
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

  // Objetivos sin `detail`: el tipo y el bando bastan para componer la frase.
  // Sin esto caían a la `description` del backend, que desde el cambio viene
  // en inglés ("Your team killed Baron Nashor" en una interfaz en español;
  // visto en la app real, no en el arnés).
  if (!structured && has(ev.subtype) && (ev.subtype === "ally" || ev.subtype === "enemy")) {
    if (ev.type === "BaronKill") return { text: objectiveLine(t, ev.subtype, t("Baron Nashor"), stolen), isLegacy: false };
    if (ev.type === "HeraldKill") return { text: objectiveLine(t, ev.subtype, t("Rift Herald"), stolen), isLegacy: false };
    if (ev.type === "DragonKill") return { text: objectiveLine(t, ev.subtype, t("Dragon"), stolen), isLegacy: false };
  }

  // Sucesos sin datos que componer: la frase del backend ya está en inglés
  // desde el cambio, y en español en las partidas viejas.
  return { text: ev.description, isLegacy: !structured && ev.description.length > 0 };
}

export const describeEvent = (ev: MatchEvent, t: Translate): string =>
  describeEventFull(ev, t).text;
