import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { App } from "./App";
import { MetronomeOverlay } from "./features/training/components/MetronomeOverlay";
import { DialogProvider } from "./components/ui/DialogProvider";
import { LanguageProvider } from "./core/LanguageProvider";
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
        <DialogProvider>
          <HashRouter>
            <App />
          </HashRouter>
        </DialogProvider>
      </LanguageProvider>
    )}
  </React.StrictMode>,
);
