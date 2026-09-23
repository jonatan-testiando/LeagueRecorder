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
 *    antes de que levantes la vista es un fallo que no se ha contado. Los que
 *    se van solos llevan abajo una línea que se vacía: se ve cuánto les queda.
 *  - Entran opacándose y subiendo cuatro píxeles (`pop-in`, el mismo de los
 *    menús). Sin rebote: un aviso que salta llama más atención que su motivo.
 *
 * «Post-partida»: además del icono de tono, un aviso puede llevar su propia
 * imagen (`media`: el retrato del campeón en «Partida guardada»), un cuerpo
 * con marcado (el resultado en su color) y una segunda acción ("Más tarde").
 */

export type ToastTone = "info" | "success" | "warning" | "danger";

export interface ToastAction {
  label: string;
  onClick: () => void;
  /** Icono delante del texto. */
  icon?: React.ReactNode;
}

export interface ToastOptions {
  /** Una línea. Ya traducida: aquí no se traduce nada. */
  title: string;
  /** El detalle, si lo hay: el motivo técnico, la ruta del fichero, o una
   *  línea con marcado (el resultado en su color). */
  body?: React.ReactNode;
  /** Segunda línea de detalle, debajo de `body`. */
  note?: React.ReactNode;
  tone?: ToastTone;
  action?: ToastAction;
  /** Acción secundaria, sin relleno ("Más tarde"). Cierra el aviso. */
  secondary?: ToastAction;
  /** Sustituye al icono de tono: un retrato, un emblema. */
  media?: React.ReactNode;
  /** Texto pequeño junto al título ("ahora"). */
  meta?: string;
  /** Milisegundos hasta que se va solo. 0 = se queda. Por defecto: 6 s, salvo
   *  en `danger`, que se queda. */
  duration?: number;
}

interface Toast extends ToastOptions {
  id: string;
  /** Duración efectiva, para la línea de tiempo restante. */
  ms: number;
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
  if (tone === "success") return <CheckCircle2 size={18} color={color} />;
  if (tone === "warning") return <AlertTriangle size={18} color={color} />;
  if (tone === "danger") return <AlertOctagon size={18} color={color} />;
  return <Info size={18} color={color} />;
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
      const ms = options.duration ?? (tone === "danger" ? 0 : DEFAULT_MS);
      setToasts((prev) => {
        // Tope de cinco: una tanda de fallos encadenados llenaba la ventana
        // entera de avisos y tapaba la propia app.
        const next = [...prev, { ...options, tone, id, ms }];
        return next.slice(-5);
      });
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
                style={styles.toast}
                role={tone === "danger" ? "alert" : "status"}
                aria-live={tone === "danger" ? "assertive" : "polite"}
              >
                <div style={styles.row}>
                  <span style={x.media ? styles.media : styles.icon}>
                    {x.media ?? <ToneIcon tone={tone} />}
                  </span>
                  <div style={styles.text}>
                    <div style={styles.head}>
                      <span style={styles.title}>{x.title}</span>
                      {x.meta && <span style={styles.meta}>{x.meta}</span>}
                      <button
                        type="button"
                        className="toast__close"
                        onClick={() => dismiss(x.id)}
                        title={t("Close")}
                        aria-label={t("Close")}
                      >
                        <X size={13} />
                      </button>
                    </div>
                    {x.body && <span style={styles.body}>{x.body}</span>}
                    {x.note && <span style={styles.body}>{x.note}</span>}
                    {(x.action || x.secondary) && (
                      <div style={styles.actions}>
                        {x.action && (
                          <button
                            type="button"
                            className="toast__btn toast__btn--main"
                            style={{ color: x.media ? TONE_COLOR[tone] : undefined }}
                            onClick={() => {
                              x.action?.onClick();
                              dismiss(x.id);
                            }}
                          >
                            {x.action.icon}
                            {x.action.label}
                          </button>
                        )}
                        {x.secondary && (
                          <button
                            type="button"
                            className="toast__btn"
                            onClick={() => {
                              x.secondary?.onClick();
                              dismiss(x.id);
                            }}
                          >
                            {x.secondary.icon}
                            {x.secondary.label}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                {/* Lo que le queda al aviso. Solo en los que se van solos: los
                    de peligro se quedan y no tienen cuenta que enseñar. */}
                {x.ms > 0 && (
                  <div style={styles.timer} aria-hidden="true">
                    <div
                      className="toast__timer"
                      style={{
                        background: `color-mix(in srgb, ${TONE_COLOR[tone]} 70%, transparent)`,
                        animationDuration: `${x.ms}ms`,
                      }}
                    />
                  </div>
                )}
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
    right: "var(--space-6)",
    bottom: "var(--space-6)",
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
    width: 380,
    maxWidth: "calc(100vw - var(--space-8))",
    overflow: "hidden",
    background: "var(--panel)",
    borderRadius: 14,
    boxShadow: "inset 0 0 0 1px var(--hair), inset 0 1px 0 var(--rim), var(--shadow-3)",
    animation: "pop-in var(--t-quick) var(--e-out) both",
  },
  row: {
    display: "flex",
    alignItems: "flex-start",
    gap: 14,
    padding: "16px 12px 16px 16px",
  },
  icon: { display: "flex", paddingTop: 1, flexShrink: 0 },
  media: { display: "flex", flexShrink: 0, margin: 2 },
  text: { display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: 1 },
  head: { display: "flex", alignItems: "center", gap: 8, minHeight: 24 },
  title: { flex: 1, minWidth: 0, fontSize: 14, color: "var(--text)", fontWeight: 500, lineHeight: 1.4 },
  meta: { fontSize: 12, color: "var(--faint)", whiteSpace: "nowrap" },
  body: {
    fontSize: 13,
    color: "var(--muted)",
    lineHeight: 1.45,
    fontVariantNumeric: "tabular-nums",
    // Una ruta larga sin espacios rompería el ancho de la tarjeta.
    overflowWrap: "anywhere",
  },
  actions: { display: "flex", alignItems: "center", gap: 8, marginTop: 10 },
  timer: { height: 2, background: "color-mix(in srgb, var(--text) 6%, transparent)" },
};
