import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AlertOctagon, AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { useT } from "../../core/LanguageProvider";

/**
 * Avisos que no interrumpen.
 *
 * El diálogo (`useDialog`) es para lo que exige una respuesta: para y no sigue
 * hasta que pulsas. Pero la grabadora habla sola —arranca, se cae, guarda un
 * clip del replay— y ahí un modal es peor que el silencio: aparece encima de lo
 * que estabas mirando por algo que ya ha pasado y que no vas a decidir.
 *
 * Tres decisiones de piel:
 *
 *  - Abajo a la derecha y apilados, el más nuevo abajo. Arriba están la barra de
 *    título y la navegación; abajo no tapan nada de lo que se estuviera leyendo.
 *  - Se van solos a los 6 s, MENOS los de peligro ("no se pudo grabar", "disco
 *    lleno"): esos se quedan hasta que los cierras. Un fallo que se borra solo
 *    antes de que levantes la vista es un fallo que no se ha contado.
 *  - Entran opacándose y subiendo cuatro píxeles (`pop-in`, el mismo de los
 *    menús). Sin rebote: un aviso que salta llama más atención que su motivo.
 */

export type ToastTone = "info" | "success" | "warning" | "danger";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  /** Una línea. Ya traducida: aquí no se traduce nada. */
  title: string;
  /** El detalle, si lo hay: el motivo técnico o la ruta del fichero. */
  body?: string;
  tone?: ToastTone;
  action?: ToastAction;
  /** Milisegundos hasta que se va solo. 0 = se queda. Por defecto: 6 s, salvo
   *  en `danger`, que se queda. */
  duration?: number;
}

interface Toast extends ToastOptions {
  id: string;
}

interface ToastContextValue {
  /** Muestra un aviso y devuelve su id, por si hay que cerrarlo a mano. */
  toast: (options: ToastOptions) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue>({
  // Fuera del provider no revienta: los avisos son accesorios, y un componente
  // que se monta suelto (una prueba, un panel aislado) no debe caerse por esto.
  toast: () => "",
  dismiss: () => {},
});

export const useToast = (): ToastContextValue => useContext(ToastContext);

const DEFAULT_MS = 6000;

const TONE_COLOR: Record<ToastTone, string> = {
  info: "var(--cool)",
  success: "var(--win)",
  warning: "var(--brand)",
  danger: "var(--signal)",
};

const ToneIcon: React.FC<{ tone: ToastTone }> = ({ tone }) => {
  const color = TONE_COLOR[tone];
  if (tone === "success") return <CheckCircle2 size={16} color={color} />;
  if (tone === "warning") return <AlertTriangle size={16} color={color} />;
  if (tone === "danger") return <AlertOctagon size={16} color={color} />;
  return <Info size={16} color={color} />;
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Los temporizadores viven en una ref y no en el estado: si se guardaran en el
  // estado, cada aviso nuevo repintaría y reiniciaría la cuenta de los demás.
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const t = useT();

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const toast = useCallback(
    (options: ToastOptions): string => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const tone = options.tone ?? "info";
      setToasts((prev) => {
        // Tope de cinco: una tanda de fallos encadenados llenaba la ventana
        // entera de avisos y tapaba la propia app.
        const next = [...prev, { ...options, tone, id }];
        return next.slice(-5);
      });
      const ms = options.duration ?? (tone === "danger" ? 0 : DEFAULT_MS);
      if (ms > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), ms)
        );
      }
      return id;
    },
    [dismiss]
  );

  // Al desmontar, fuera los temporizadores pendientes.
  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((timer) => clearTimeout(timer));
      map.clear();
    };
  }, []);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toasts.length > 0 && (
        <div style={styles.stack} role="region" aria-label={t("Notifications")}>
          {toasts.map((x) => {
            const tone = x.tone ?? "info";
            return (
              <div
                key={x.id}
                style={{
                  ...styles.toast,
                  borderLeft: `2px solid ${TONE_COLOR[tone]}`,
                }}
                role={tone === "danger" ? "alert" : "status"}
                aria-live={tone === "danger" ? "assertive" : "polite"}
              >
                <span style={styles.icon}>
                  <ToneIcon tone={tone} />
                </span>
                <div style={styles.text}>
                  <span style={styles.title}>{x.title}</span>
                  {x.body && <span style={styles.body}>{x.body}</span>}
                  {x.action && (
                    <button
                      className="btn btn--ghost btn--sm"
                      style={styles.action}
                      onClick={() => {
                        x.action?.onClick();
                        dismiss(x.id);
                      }}
                    >
                      {x.action.label}
                    </button>
                  )}
                </div>
                <button
                  onClick={() => dismiss(x.id)}
                  style={styles.close}
                  title={t("Close")}
                  aria-label={t("Close")}
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </ToastContext.Provider>
  );
};

const styles: Record<string, React.CSSProperties> = {
  stack: {
    position: "fixed",
    right: "var(--space-5)",
    bottom: "var(--space-5)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-2)",
    // Por debajo del diálogo (9999): si los dos coinciden, el aviso se cuela
    // por encima del velo del modal y se lee como un fallo de pintado.
    zIndex: 9000,
    // La columna es estrecha, pero el hueco vacío no debe comerse los clics de
    // lo que hay detrás.
    pointerEvents: "none",
  },
  toast: {
    pointerEvents: "auto",
    display: "flex",
    alignItems: "flex-start",
    gap: "var(--space-3)",
    width: 340,
    maxWidth: "calc(100vw - var(--space-8))",
    padding: "var(--space-3) var(--space-4)",
    background: "var(--surface-1)",
    border: "1px solid var(--glass-line)",
    borderRadius: "var(--radius-lg)",
    boxShadow: "var(--shadow-3)",
    animation: "pop-in var(--t-quick) var(--e-out) both",
  },
  icon: { display: "flex", paddingTop: 1, flexShrink: 0 },
  text: { display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: 1 },
  title: { fontSize: "var(--font-xs)", color: "var(--text)", fontWeight: 600, lineHeight: 1.4 },
  body: {
    fontSize: 11.5,
    color: "var(--faint)",
    lineHeight: 1.45,
    // Una ruta larga sin espacios rompería el ancho de la tarjeta.
    overflowWrap: "anywhere",
  },
  action: { alignSelf: "flex-start", marginTop: 4 },
  close: {
    background: "transparent",
    border: "none",
    color: "var(--faint)",
    cursor: "pointer",
    padding: 2,
    display: "flex",
    flexShrink: 0,
    borderRadius: "var(--radius-sm)",
  },
};
