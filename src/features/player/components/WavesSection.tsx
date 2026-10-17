import { useT } from "../../../core/LanguageProvider";

/**
 * Nombres de oleadas y macro (ver `oleadas.rs`), compartidos con Patrones.
 *
 * Aquí vivía la sección "Oleadas y macro" de la pestaña Partida: un resumen,
 * tres franjas por carril, tus invasiones, tus ganks (otra vez: también salían
 * en "Ganks", y a otra hora), los objetivos (repetidos) y un párrafo de reglas.
 * Desde el 2026-10-17 lo que decía va en el bloque Jungla (`JungleMoves`):
 * una sola lista de invasiones y ganks, y la línea del resumen. Las franjas las
 * pinta el Mapa sobre el minimapa. Queda lo que importan otros.
 */

type T = ReturnType<typeof useT>;

export const LANE_LABEL: Record<string, string> = { top: "Top", mid: "Mid", bot: "Bot" };

export const OBJECTIVE_LABEL: Record<string, string> = {
  DRAGON: "Dragon",
  BARON_NASHOR: "Baron Nashor",
  RIFTHERALD: "Rift Herald",
  HORDE: "Void Grubs",
  ATAKHAN: "Atakhan",
};

export function verdictTag(v: string, t: T): { text: string; tone: "good" | "bad" | "" } {
  switch (v) {
    case "prio": return { text: t("with priority"), tone: "good" };
    case "half": return { text: t("half priority"), tone: "" };
    case "none": return { text: t("without priority"), tone: "bad" };
    case "early": return { text: t("before the waves meet"), tone: "" };
    default: return { text: t("waves not seen"), tone: "" };
  }
}

export function setupTag(s: string, t: T): { text: string; tone: "good" | "bad" | "" } {
  switch (s) {
    case "good": return { text: t("wave on your side"), tone: "good" };
    case "dive": return { text: t("wave under their tower"), tone: "bad" };
    case "even": return { text: t("wave in the middle"), tone: "" };
    default: return { text: t("wave not seen"), tone: "" };
  }
}
