import React, { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, Copy, X, Search } from "lucide-react";
import { BrandMark } from "./BrandMark";
import { useT } from "../core/LanguageProvider";

/**
 * Barra de título personalizada (la ventana se lanza con decorations:false).
 * La zona `titlebar__drag` lleva `data-tauri-drag-region` para poder mover la
 * ventana; doble-clic sobre ella la maximiza/restaura (lo gestiona Tauri).
 *
 * «Post-partida»: 44 px y tres zonas. La marca a la izquierda (ancho del rail,
 * así el buscador cae centrado sobre el contenido), el buscador en medio —un
 * botón con cara de campo que abre la paleta, Ctrl K— y a la derecha el estado
 * de captura, que antes vivía al pie del rail y no se veía desde el
 * reproductor. Los dos son opcionales: el asistente de primer arranque solo
 * necesita poder mover y cerrar la ventana.
 */
export const Titlebar: React.FC<{
  /** Abre la paleta de comandos. Sin esto no hay buscador. */
  onSearch?: () => void;
  /** Píldora de captura y espacio libre. */
  status?: React.ReactNode;
}> = ({ onSearch, status }) => {
  const [isMaximized, setIsMaximized] = useState(false);
  const appWindow = getCurrentWindow();
  const t = useT();

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
        <div className="titlebar__brand">
          <span style={{ color: "var(--brand)", display: "flex" }}>
            <BrandMark size={16} />
          </span>
          <span className="titlebar__title">LeagueRecorder</span>
        </div>

        {/* El centro también arrastra la ventana: solo el botón no. */}
        <div className="titlebar__center" data-tauri-drag-region>
          {onSearch && (
            <button
              type="button"
              className="titlebar__search"
              onClick={onSearch}
              aria-haspopup="dialog"
              aria-keyshortcuts="Control+K"
            >
              <Search size={14} aria-hidden="true" />
              <span>{t("Search games, champions or moments…")}</span>
              <kbd className="u-kbd">Ctrl K</kbd>
            </button>
          )}
        </div>

        {status && <div className="titlebar__status">{status}</div>}
      </div>

      <div className="titlebar__controls">
        <button
          className="titlebar__btn"
          onClick={() => appWindow.minimize()}
          title={t("Minimize")}
          aria-label={t("Minimize")}
        >
          <Minus size={14} />
        </button>
        <button
          className="titlebar__btn"
          onClick={() => appWindow.toggleMaximize()}
          title={t(isMaximized ? "Restore" : "Maximize")}
          aria-label={t(isMaximized ? "Restore" : "Maximize")}
        >
          {isMaximized ? <Copy size={12} /> : <Square size={12} />}
        </button>
        <button
          className="titlebar__btn titlebar__btn--close"
          onClick={() => appWindow.close()}
          title={t("Close")}
          aria-label={t("Close")}
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
};
