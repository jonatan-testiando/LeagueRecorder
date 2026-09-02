import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { getAppConfig, setAppConfig, AppConfig } from "./tauri-ipc";
import { translate, type Language } from "./i18n";

/**
 * Idioma de la interfaz.
 *
 * Se guarda en la config de disco del backend, no en localStorage: el requisito
 * es que sobreviva a cerrar la app del todo, no solo a recargar la ventana.
 *
 * Mientras carga la config se sirve inglés, que es el valor por defecto del
 * backend; así no hay parpadeo de idioma en el arranque salvo que el usuario
 * tenga español guardado, en cuyo caso cambia una vez y ya.
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

export const LanguageProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [lang, setLangState] = useState<Language>("en");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    getAppConfig()
      .then((c) => {
        if (!alive) return;
        setConfig(c);
        if (c.language === "es") setLangState("es");
      })
      .catch(console.error)
      .finally(() => alive && setReady(true));
    return () => { alive = false; };
  }, []);

  const setLang = useCallback(
    async (next: Language) => {
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
        setLangState(base.language === "es" ? "es" : "en");
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
