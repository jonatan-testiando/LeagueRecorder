import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { getAppConfig, setAppConfig } from "./tauri-ipc";
import { readBootHint, writeBootHint } from "./bootHint";

/**
 * Tema de la interfaz: oscuro, claro o el de Windows.
 *
 * Igual que el idioma, vive en la config de disco del backend (`theme`), no en
 * localStorage: tiene que sobrevivir a cerrar la app. El tema se aplica como
 * `data-theme="dark" | "light"` en <html>, y es index.css quien redefine los
 * tokens para el claro; ningún componente sabe qué tema hay.
 *
 * Hasta que llega la config se sirve el tema de la última vez, que guarda la
 * pista de arranque (`bootHint.ts`) y que `index.html` ya ha puesto en <html>
 * antes de cargar React. Antes se servía el oscuro, y quien tenía el claro veía
 * 150-300 ms de oscuro en cada arranque. Sin pista (la primera vez), el oscuro,
 * que es el defecto del backend.
 */

export type Theme = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

export const THEMES: { code: Theme; label: string }[] = [
  { code: "dark", label: "Dark" },
  { code: "light", label: "Light" },
  { code: "system", label: "System" },
];

interface ThemeContextValue {
  theme: Theme;
  resolved: ResolvedTheme;
  setTheme: (next: Theme) => Promise<void>;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "dark",
  resolved: "dark",
  setTheme: async () => {},
});

const media = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: light)")
    : null;

const resolve = (theme: Theme): ResolvedTheme =>
  theme === "system" ? (media()?.matches ? "light" : "dark") : theme;

const asTheme = (v: unknown): Theme => (v === "light" || v === "system" ? v : "dark");

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<Theme>(() => readBootHint().theme ?? "dark");
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolve(theme));

  useEffect(() => {
    let alive = true;
    getAppConfig()
      .then((c) => { if (alive) setThemeState(asTheme(c.theme)); })
      .catch(console.error);
    return () => { alive = false; };
  }, []);

  // Se resuelve "system" contra Windows, y se sigue escuchando por si cambia
  // con la app abierta.
  useEffect(() => {
    const apply = () => setResolved(resolve(theme));
    apply();
    const m = media();
    if (theme !== "system" || !m) return;
    m.addEventListener("change", apply);
    return () => m.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  // La preferencia, no el resuelto: con "system" el próximo arranque vuelve a
  // mirar Windows, que puede haber cambiado entre medias.
  useEffect(() => {
    writeBootHint({ theme });
  }, [theme]);

  const setTheme = useCallback(async (next: Theme) => {
    const prev = theme;
    setThemeState(next);
    // Solo el tema: el backend recibe un parche y no toca nada más.
    await setAppConfig({ theme: next }).catch((err) => {
      console.error("No se pudo guardar el tema:", err);
      setThemeState(prev);
    });
  }, [theme]);

  const value = useMemo<ThemeContextValue>(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export const useTheme = () => useContext(ThemeContext);
