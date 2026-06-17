import React, { createContext, useContext, useState, ReactNode, useCallback } from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";

type DialogType = "confirm" | "alert" | "success" | "error";

interface DialogOptions {
  title?: string;
  message: string;
  type?: DialogType;
  confirmText?: string;
  cancelText?: string;
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

  const handleConfirm = () => {
    if (resolvePromise) resolvePromise(true);
    setIsOpen(false);
  };

  const handleCancel = () => {
    if (resolvePromise) resolvePromise(false);
    setIsOpen(false);
  };

  const getTypeIcon = () => {
    switch (options.type) {
      case "error":
        return <AlertTriangle size={24} color="var(--color-defeat)" />;
      case "success":
        return <CheckCircle2 size={24} color="var(--color-victory)" />;
      case "confirm":
        return <Info size={24} color="var(--accent-blue)" />;
      default:
        return <Info size={24} color="var(--text-muted)" />;
    }
  };

  const getTitle = () => {
    if (options.title) return options.title;
    switch (options.type) {
      case "error": return "Error";
      case "success": return "Éxito";
      case "confirm": return "Confirmar acción";
      default: return "Atención";
    }
  };

  return (
    <DialogContext.Provider value={{ showConfirm, showAlert, showSuccess, showError }}>
      {children}
      {isOpen && (
        <div style={styles.overlay} onClick={options.type !== "confirm" ? handleConfirm : undefined}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.header}>
              <div style={styles.titleRow}>
                {getTypeIcon()}
                <h3 style={styles.title}>{getTitle()}</h3>
              </div>
              <button onClick={handleCancel} style={styles.closeBtn}>
                <X size={20} />
              </button>
            </div>
            
            <div style={styles.body}>
              <p style={styles.message}>{options.message}</p>
            </div>

            <div style={styles.footer}>
              {options.type === "confirm" && (
                <button onClick={handleCancel} style={styles.cancelBtn}>
                  {options.cancelText || "Cancelar"}
                </button>
              )}
              <button 
                onClick={handleConfirm} 
                style={{
                  ...styles.confirmBtn, 
                  backgroundColor: options.type === "error" ? "var(--color-defeat)" : 
                                  options.type === "success" ? "var(--color-victory)" : 
                                  "var(--accent-violet)"
                }}
              >
                {options.confirmText || "Aceptar"}
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
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    backdropFilter: "blur(4px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 9999,
  },
  modal: {
    backgroundColor: "var(--bg-card)",
    borderRadius: "var(--radius-lg)",
    border: "1px solid var(--border-subtle)",
    width: "100%",
    maxWidth: "400px",
    boxShadow: "0 10px 30px rgba(0, 0, 0, 0.5)",
    overflow: "hidden",
    animation: "modalFadeIn 0.2s ease-out",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "var(--space-4) var(--space-5)",
    borderBottom: "1px solid var(--border-subtle)",
  },
  titleRow: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
  },
  title: {
    margin: 0,
    fontSize: "var(--font-lg)",
    color: "#fff",
    fontWeight: 600,
  },
  closeBtn: {
    background: "transparent",
    border: "none",
    color: "var(--text-muted)",
    cursor: "pointer",
    padding: "4px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "4px",
  },
  body: {
    padding: "var(--space-5)",
  },
  message: {
    margin: 0,
    color: "var(--text-secondary)",
    fontSize: "var(--font-md)",
    lineHeight: 1.5,
  },
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "12px",
    padding: "var(--space-4) var(--space-5)",
    backgroundColor: "var(--bg-panel)",
    borderTop: "1px solid var(--border-subtle)",
  },
  cancelBtn: {
    background: "transparent",
    border: "1px solid var(--border-strong)",
    color: "var(--text-primary)",
    padding: "8px 16px",
    borderRadius: "6px",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: "var(--font-sm)",
  },
  confirmBtn: {
    border: "none",
    color: "#fff",
    padding: "8px 16px",
    borderRadius: "6px",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: "var(--font-sm)",
  }
};
