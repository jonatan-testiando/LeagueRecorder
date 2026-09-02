/**
 * Puestos, y sus dos vocabularios.
 *
 * Riot manda `teamPosition` ("TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY") y
 * la configuración del entrenamiento guarda el vocabulario del jugador ("TOP",
 * "JUNGLE", "MID", "ADC", "SUPPORT"). Los dos se pintaban en crudo y en
 * mayúsculas, cada uno en su pantalla, y ninguno pasaba por el diccionario.
 *
 * Aquí se normalizan los dos a la MISMA etiqueta inglesa, que es la clave de
 * i18n: quien la pinta hace `t(roleLabel(role))`. Los valores GUARDADOS no se
 * tocan — esto es sólo cómo se enseñan.
 */

/** Etiquetas canónicas, en el orden del carril de arriba abajo. */
export const ROLE_LABELS = ["Top", "Jungle", "Mid", "Bot", "Support"] as const;
export type RoleLabel = (typeof ROLE_LABELS)[number];

const ALIASES: Record<string, RoleLabel> = {
  TOP: "Top",
  JUNGLE: "Jungle",
  JG: "Jungle",
  MID: "Mid",
  MIDDLE: "Mid",
  BOT: "Bot",
  BOTTOM: "Bot",
  ADC: "Bot",
  SUPPORT: "Support",
  UTILITY: "Support",
  SUP: "Support",
};

/**
 * Etiqueta inglesa (clave de i18n) de un puesto, en cualquiera de los dos
 * vocabularios. Devuelve el valor original si no se reconoce: enseñar un rol
 * raro es mejor que enseñar un hueco.
 */
export const roleLabel = (role?: string | null): string => {
  if (!role) return "";
  return ALIASES[role.trim().toUpperCase()] ?? role;
};

/** ¿Son el mismo puesto, aunque vengan de vocabularios distintos? */
export const sameRole = (a?: string | null, b?: string | null): boolean => {
  const ra = roleLabel(a);
  const rb = roleLabel(b);
  return ra !== "" && ra === rb;
};
