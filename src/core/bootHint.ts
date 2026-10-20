/**
 * Pista de arranque: el tema y el idioma de la última vez, en localStorage.
 *
 * La config de disco (`get_config`) es la que manda, pero llega por IPC a los
 * 150-300 ms de abrir la ventana, y hasta entonces la app se pintaba en inglés
 * y en oscuro aunque el usuario la tenga en español y en claro: un fogonazo en
 * cada arranque. El script en línea de `index.html` lee esta pista y pone
 * `data-theme` y `lang` en <html> antes de que cargue React, y los providers
 * arrancan con ella. Cuando llega la config, si no coincide, gana la config y
 * la pista se corrige sola para la próxima vez.
 *
 * Todo con try/catch: localStorage puede no estar (o lanzar) y la pista es un
 * atajo, nunca algo de lo que dependa nada.
 */

export const BOOT_HINT_KEY = "lr-boot";

export interface BootHint {
  /** La preferencia tal cual, "system" incluido: se resuelve al aplicarla. */
  theme?: "dark" | "light" | "system";
  lang?: "en" | "es";
}

export function readBootHint(): BootHint {
  try {
    const raw = window.localStorage.getItem(BOOT_HINT_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw) as Record<string, unknown>;
    return {
      theme: v.theme === "dark" || v.theme === "light" || v.theme === "system" ? v.theme : undefined,
      lang: v.lang === "en" || v.lang === "es" ? v.lang : undefined,
    };
  } catch {
    return {};
  }
}

export function writeBootHint(patch: BootHint): void {
  try {
    const next = { ...readBootHint(), ...patch };
    window.localStorage.setItem(BOOT_HINT_KEY, JSON.stringify(next));
  } catch {
    // Sin almacenamiento no hay pista: el próximo arranque espera a la config.
  }
}
