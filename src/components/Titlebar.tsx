import React, { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, Copy, X, Scissors } from "lucide-react";

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
        <Scissors
          color="var(--accent-violet)"
          size={15}
          strokeWidth={2.5}
          style={{ transform: "rotate(-45deg)", pointerEvents: "none" }}
        />
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
