import React, { createContext, useContext, useState, ReactNode, useCallback, useEffect, useRef } from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { useT } from "../../core/LanguageProvider";

/**
 * El diálogo de la app. Sustituye a `alert`/`confirm`/`prompt` del navegador,
 * que en una ventana sin decoraciones se ven prestados de otro programa.
 *
 * Dos decisiones de piel que costaron una pasada:
 *
 *  - El botón de confirmar NO cambia de color según el tipo. Que un aviso de
 *    éxito pintara el botón de verde y uno de error de rojo hacía que el color
 *    dijera lo mismo que ya decía el icono, y de paso gastaba el rojo —que en
 *    esta app significa "grabando" y "destruye algo"— en un simple "vale".
 *    Ahora el rojo solo aparece con `destructive: true`.
 *  - Teclado: Escape cancela, Enter confirma. Un modal que solo se cierra con
 *    el ratón es lo que delata que no es del sistema.
 */

type DialogType = "confirm" | "alert" | "success" | "error";

interface DialogOptions {
  title?: string;
  message: string;
  type?: DialogType;
  confirmText?: string;
  cancelText?: string;
  /** Tiñe de rojo el botón de confirmar. Solo para lo que borra o rompe algo. */
  destructive?: boolean;
}

interface DialogContextValue {
  showConfirm: (options: DialogOptions | string) => Promise<boolean>;
  showAlert: (options: DialogOptions | string) => Promise<void>;
  showSuccess: (message: string) => Promise<void>;
  showError: (message: string) => Promise<void>;
}

const DialogContext = createContext<DialogContextValue | undefined>(undefined);

export const useDialog = () => {
  const context = useContext(DialogContext);
  if (!context) {
    throw new Error("useDialog must be used within a DialogProvider");
  }
  return context;
};

export const DialogProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [options, setOptions] = useState<DialogOptions>({ message: "" });
  const [resolvePromise, setResolvePromise] = useState<((value: boolean) => void) | null>(null);
  // El provider vive dentro de LanguageProvider (main.tsx), así que aquí sí hay
  // traducción disponible: los títulos y botones por defecto son suyos.
  const t = useT();
  const confirmRef = useRef<HTMLButtonElement>(null);

  const showConfirm = useCallback((opts: DialogOptions | string): Promise<boolean> => {
    return new Promise((resolve) => {
      setOptions(typeof opts === "string" ? { message: opts, type: "confirm" } : { ...opts, type: opts.type || "confirm" });
      setResolvePromise(() => resolve);
      setIsOpen(true);
    });
  }, []);

  const showAlert = useCallback((opts: DialogOptions | string): Promise<void> => {
    return new Promise((resolve) => {
      setOptions(typeof opts === "string" ? { message: opts, type: "alert" } : { ...opts, type: opts.type || "alert" });
      setResolvePromise(() => () => resolve());
      setIsOpen(true);
    });
  }, []);

  const showSuccess = useCallback((message: string): Promise<void> => {
    return showAlert({ message, type: "success" });
  }, [showAlert]);

  const showError = useCallback((message: string): Promise<void> => {
    return showAlert({ message, type: "error" });
  }, [showAlert]);

  const handleConfirm = useCallback(() => {
    if (resolvePromise) resolvePromise(true);
    setIsOpen(false);
  }, [resolvePromise]);

  const handleCancel = useCallback(() => {
    if (resolvePromise) resolvePromise(false);
    setIsOpen(false);
  }, [resolvePromise]);

  // Escape cancela, Enter confirma. Va en `keydown` de la ventana y no del
  // modal porque el foco puede estar en el botón, en el velo o en nada.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); handleCancel(); }
      else if (e.key === "Enter") { e.preventDefault(); handleConfirm(); }
    };
    window.addEventListener("keydown", onKey);
    // El foco al botón principal: así el Enter también funciona para quien
    // llega con el teclado, y el lector de pantalla anuncia la salida.
    confirmRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, handleCancel, handleConfirm]);

  const getTypeIcon = () => {
    switch (options.type) {
      case "error":
        return <AlertTriangle size={20} color="var(--signal)" />;
      case "success":
        return <CheckCircle2 size={20} color="var(--cool)" />;
      case "confirm":
        return <Info size={20} color="var(--brand)" />;
      default:
        return <Info size={20} color="var(--faint)" />;
    }
  };

  const getTitle = () => {
    if (options.title) return options.title;
    switch (options.type) {
      case "error": return t("Error");
      case "success": return t("Success");
      case "confirm": return t("Confirm action");
      default: return t("Notice");
    }
  };

  // Solo lo que destruye algo se pinta de rojo. Todo lo demás usa el jade, que
  // es el tinte de interacción del sistema.
  const accent = options.destructive ? "var(--signal)" : "var(--cool)";

  return (
    <DialogContext.Provider value={{ showConfirm, showAlert, showSuccess, showError }}>
      {children}
      {isOpen && (
        <div style={styles.overlay} onClick={options.type !== "confirm" ? handleConfirm : undefined}>
          <div
            style={styles.modal}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={getTitle()}
          >
            <div style={styles.header}>
              <div style={styles.titleRow}>
                {getTypeIcon()}
                <h3 style={styles.title}>{getTitle()}</h3>
              </div>
              <button
                onClick={handleCancel}
                style={styles.closeBtn}
                title={t("Close")}
                aria-label={t("Close")}
              >
                <X size={18} />
              </button>
            </div>

            <div style={styles.body}>
              <p style={styles.message}>{options.message}</p>
            </div>

            <div style={styles.footer}>
              {options.type === "confirm" && (
                <button onClick={handleCancel} style={styles.cancelBtn}>
                  {options.cancelText || t("Cancel")}
                </button>
              )}
              <button
                ref={confirmRef}
                onClick={handleConfirm}
                style={{
                  ...styles.confirmBtn,
                  background: `color-mix(in srgb, ${accent} 18%, var(--surface-2))`,
                  border: `1px solid color-mix(in srgb, ${accent} 45%, transparent)`,
                  color: accent,
                }}
              >
                {options.confirmText || t("OK")}
              </button>
            </div>
          </div>
        </div>
      )}
    </DialogContext.Provider>
  );
};

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    top: 0, left: 0, right: 0, bottom: 0,
    // El velo se deriva del fondo de la app, no de un negro suelto: sobre el
    // marino de la ventana un rgba(0,0,0,.7) se lee como suciedad.
    background: "color-mix(in srgb, var(--ground) 78%, transparent)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 9999,
  },
  modal: {
    background: "var(--surface-1)",
    borderRadius: "var(--radius-lg)",
    border: "1px solid var(--line)",
    width: "100%",
    maxWidth: "420px",
    boxShadow: "var(--shadow-2)",
    overflow: "hidden",
    // Sin rebote: entra opacándose y subiendo dos píxeles, nada más.
    animation: "pop-in 0.16s ease-out",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "var(--space-4) var(--space-5)",
    borderBottom: "1px solid var(--line-soft)",
  },
  titleRow: {
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
  },
  title: {
    margin: 0,
    fontSize: "var(--font-md)",
    color: "var(--text)",
    fontWeight: 600,
  },
  closeBtn: {
    background: "transparent",
    border: "none",
    color: "var(--faint)",
    cursor: "pointer",
    padding: "4px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-sm)",
  },
  body: {
    padding: "var(--space-5)",
  },
  message: {
    margin: 0,
    color: "var(--muted)",
    fontSize: "var(--font-sm)",
    lineHeight: 1.55,
    // Un mensaje de error del backend puede venir con una ruta larga sin
    // espacios: sin esto rompe el ancho del modal.
    overflowWrap: "anywhere",
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "var(--space-3)",
    padding: "var(--space-4) var(--space-5)",
    background: "var(--sunken)",
    borderTop: "1px solid var(--line-soft)",
  },
  cancelBtn: {
    background: "transparent",
    border: "1px solid var(--line)",
    color: "var(--muted)",
    padding: "7px 15px",
    borderRadius: "var(--radius-md)",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: "var(--font-xs)",
  },
  confirmBtn: {
    padding: "7px 15px",
    borderRadius: "var(--radius-md)",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: "var(--font-xs)",
  },
};
