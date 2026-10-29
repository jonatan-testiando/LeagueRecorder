import React, { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, Copy, X, Search } from "lucide-react";
import { BrandMark } from "./BrandMark";
import { useT } from "../core/LanguageProvider";
import { originOf, type NavOrigin } from "../core/navOrigin";

/**
 * Barra de título personalizada (la ventana se lanza con decorations:false).
 * La zona `titlebar__drag` lleva `data-tauri-drag-region` para poder mover la
 * ventana; doble-clic sobre ella la maximiza/restaura (lo gestiona Tauri).
 *
 * Piel A (2026-10-29): la barra va a la derecha del raíl, que sube hasta
 * arriba con la marca. Tres zonas: las de los lados crecen igual, así el
 * buscador queda centrado mientras el título quepa. A la izquierda, el hueco
 * donde cada pantalla pinta su título (`slotRef`); en medio, el buscador en
 * cápsula, un botón con cara de campo que abre la paleta (Ctrl K); a la
 * derecha, el estado de captura. Todo es opcional: el asistente de primer
 * arranque, sin raíl, pide `brand` para llevar la marca, y solo necesita
 * poder mover y cerrar la ventana.
 */
export const Titlebar: React.FC<{
  /** Abre la paleta de comandos. Sin esto no hay buscador. */
  /** Abre la paleta. `origin` dice si fue con el ratón o con el teclado. */
  onSearch?: (origin: NavOrigin) => void;
  /** Píldora de captura y espacio libre. */
  status?: React.ReactNode;
  /** Recibe el hueco donde cada pantalla pinta su título. */
  slotRef?: (el: HTMLDivElement | null) => void;
  /** Marca y nombre a la izquierda, cuando no hay raíl que los lleve. */
  brand?: boolean;
}> = ({ onSearch, status, slotRef, brand }) => {
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
        <div className="titlebar__start" ref={slotRef} data-tauri-drag-region>
          {brand && (
            <div className="titlebar__brand">
              <BrandMark size={18} />
              <span className="titlebar__title">Wardline</span>
            </div>
          )}
        </div>

        {/* El centro también arrastra la ventana: solo el botón no. */}
        <div className="titlebar__center" data-tauri-drag-region>
          {onSearch && (
            <button
              type="button"
              className="titlebar__search"
              onClick={(e) => onSearch(originOf(e))}
              aria-haspopup="dialog"
              aria-keyshortcuts="Control+K"
            >
              <Search size={14} aria-hidden="true" />
              <span>{t("Search games, champions or moments…")}</span>
              <kbd className="u-kbd">Ctrl K</kbd>
            </button>
          )}
        </div>

        <div className="titlebar__end" data-tauri-drag-region>
          {status && <div className="titlebar__status">{status}</div>}
        </div>
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
