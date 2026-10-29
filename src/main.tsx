import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { App } from "./App";
import { MetronomeOverlay } from "./features/training/components/MetronomeOverlay";
import { DialogProvider } from "./components/ui/DialogProvider";
import { LanguageProvider } from "./core/LanguageProvider";
import { ThemeProvider } from "./core/ThemeProvider";
import { ToastProvider } from "./components/ui/Toaster";
import { RecorderAlerts } from "./components/RecorderAlerts";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { Titlebar } from "./components/Titlebar";
import "./fonts.css";
import "./index.css";

// La ventana del overlay in-game carga el mismo bundle con ?overlay=1. Es una
// ventana transparente y click-through, así que no monta la app entera: solo el
// aviso del metrónomo.
const isOverlay = new URLSearchParams(window.location.search).has("overlay");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isOverlay ? (
      // El overlay también traduce (el "missed" del metrónomo): necesita el
      // provider, que solo lee el idioma de la config.
      <LanguageProvider>
        <MetronomeOverlay />
      </LanguageProvider>
    ) : (
      <LanguageProvider>
        <ThemeProvider>
        <DialogProvider>
          {/* Los avisos del grabador (disco lleno, replay guardado…) viven fuera
              del router: llegan aunque la ruta cambie. */}
          <ToastProvider>
            <RecorderAlerts />
            <HashRouter>
              {/* La red de debajo: cada panel lleva la suya (App.tsx), esta
                  recoge lo que pete fuera de ellos (rail, barra, paleta). */}
              <ErrorBoundary
                name="App"
                scope="app"
                // La ventana no tiene marco: sin barra no se podría ni cerrar.
                // Va con su propia red por si la que falla es ella.
                chrome={<ErrorBoundary name="Titlebar" fallback={null}><Titlebar brand /></ErrorBoundary>}
              >
                <App />
              </ErrorBoundary>
            </HashRouter>
          </ToastProvider>
        </DialogProvider>
        </ThemeProvider>
      </LanguageProvider>
    )}
  </React.StrictMode>,
);
