import React, { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, Copy, X } from "lucide-react";
import { BrandMark } from "./BrandMark";

/**
 * Barra de título personalizada (la ventana se lanza con decorations:false).
 * La zona `titlebar__drag` lleva `data-tauri-drag-region` para poder mover la
 * ventana; doble-clic sobre ella la maximiza/restaura (lo gestiona Tauri).
 */
export const Titlebar: React.FC = () => {
  const [isMaximized, setIsMaximized] = useState(false);
  const appWindow = getCurrentWindow();

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    appWindow.isMaximized().then(setIsMaximized).catch(() => {});
    appWindow
      .onResized(() => {
        appWindow.isMaximized().then(setIsMaximized).catch(() => {});
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  return (
    <div className="titlebar">
      <div className="titlebar__drag" data-tauri-drag-region>
        {/* Eran unas tijeras giradas: "recortar un clip" es una funcion mas de
            la app, no lo que la app es. */}
        <span style={{ color: "var(--brand)", display: "flex", pointerEvents: "none" }}>
          <BrandMark size={13} />
        </span>
        <span className="titlebar__title" style={{ pointerEvents: "none" }}>
          LeagueRecorder
        </span>
      </div>

      <div className="titlebar__controls">
        <button
          className="titlebar__btn"
          onClick={() => appWindow.minimize()}
          title="Minimize"
          aria-label="Minimize"
        >
          <Minus size={16} />
        </button>
        <button
          className="titlebar__btn"
          onClick={() => appWindow.toggleMaximize()}
          title={isMaximized ? "Restore" : "Maximize"}
          aria-label={isMaximized ? "Restore" : "Maximize"}
        >
          {isMaximized ? <Copy size={13} /> : <Square size={13} />}
        </button>
        <button
          className="titlebar__btn titlebar__btn--close"
          onClick={() => appWindow.close()}
          title="Close"
          aria-label="Close"
        >
          <X size={17} />
        </button>
      </div>
    </div>
  );
};
