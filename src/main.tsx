import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { MetronomeOverlay } from "./features/training/components/MetronomeOverlay";
import { DialogProvider } from "./components/ui/DialogProvider";
import "./fonts.css";
import "./index.css";

// La ventana del overlay in-game carga el mismo bundle con ?overlay=1. Es una
// ventana transparente y click-through, así que no monta la app entera: solo el
// aviso del metrónomo.
const isOverlay = new URLSearchParams(window.location.search).has("overlay");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isOverlay ? (
      <MetronomeOverlay />
    ) : (
      <DialogProvider>
        <App />
      </DialogProvider>
    )}
  </React.StrictMode>,
);
