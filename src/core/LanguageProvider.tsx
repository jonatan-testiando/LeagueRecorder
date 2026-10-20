import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { getAppConfig, setAppConfig, AppConfig } from "./tauri-ipc";
import { translate, type Language } from "./i18n";
import { readBootHint, writeBootHint } from "./bootHint";

/**
 * Idioma de la interfaz.
 *
 * Se guarda en la config de disco del backend, no en localStorage: el requisito
 * es que sobreviva a cerrar la app del todo, no solo a recargar la ventana.
 *
 * Mientras carga la config se sirve el idioma de la última vez, de la pista de
 * arranque (`bootHint.ts`), que `index.html` ya ha puesto en <html lang>. Antes
 * se servía inglés, y con español guardado la app salía en inglés 150-300 ms
 * en cada arranque. Sin pista (la primera vez), inglés, el defecto del backend.
 */

interface LanguageContextValue {
  lang: Language;
  /** Traduce una cadena. La clave es el propio texto en inglés. */
  t: (key: string, vars?: Record<string, string | number>) => string;
  setLang: (next: Language) => Promise<void>;
  ready: boolean;
}

const LanguageContext = createContext<LanguageContextValue>({
  lang: "en",
  t: (k) => k,
  setLang: async () => {},
  ready: false,
});

/**
 * <html lang> se escribe ANTES de cambiar el estado, no en un efecto: las
 * fechas (`relativeDay`) y las cifras (`formatDecimal`) lo leen al pintar, y
 * con el efecto el primer render en el idioma nuevo aún las escribía en el
 * viejo.
 */
const htmlLang = (l: Language) => {
  document.documentElement.lang = l;
};

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [lang, setLangState] = useState<Language>(() => {
    const l = readBootHint().lang ?? "en";
    htmlLang(l);
    return l;
  });
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    getAppConfig()
      .then((c) => {
        if (!alive) return;
        setConfig(c);
        const l: Language = c.language === "es" ? "es" : "en";
        htmlLang(l);
        setLangState(l);
      })
      .catch(console.error)
      .finally(() => alive && setReady(true));
    return () => { alive = false; };
  }, []);

  // El idioma también en <html lang>: lo usan los lectores de pantalla y
  // `formatDecimal` (coma en español, punto en inglés) para que las cifras se
  // escriban igual en todas las pantallas.
  useEffect(() => {
    htmlLang(lang);
    writeBootHint({ lang });
  }, [lang]);

  const setLang = useCallback(
    async (next: Language) => {
      htmlLang(next);
      setLangState(next);
      // Solo el idioma: el backend recibe un parche y no toca nada más. Antes
      // se le mandaba la config entera y este sitio olvidaba `minimap_scale`,
      // así que cambiar de idioma reseteaba la calibración del minimapa.
      const base = config ?? (await getAppConfig().catch(() => null));
      if (!base) return;
      setConfig({ ...base, language: next });
      await setAppConfig({ language: next }).catch((err) => {
        console.error("No se pudo guardar el idioma:", err);
        // Si el guardado falla se revierte: mejor que la UI mienta sobre lo que
        // habrá la próxima vez que abras.
        setConfig(base);
        const prev: Language = base.language === "es" ? "es" : "en";
        htmlLang(prev);
        setLangState(prev);
      });
    },
    [config]
  );

  const value = useMemo<LanguageContextValue>(
    () => ({
      lang,
      t: (key, vars) => translate(key, lang, vars),
      setLang,
      ready,
    }),
    [lang, setLang, ready]
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
};

/** Hook de traducción. `const { t } = useLang();` */
export const useLang = (): LanguageContextValue => useContext(LanguageContext);

/** Atajo para el caso habitual: solo la función. */
export const useT = () => useLang().t;
