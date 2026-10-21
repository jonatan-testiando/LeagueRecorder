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
 *  - Entran opacándose y subiendo 8 px (--rise-toast) en 200 ms y salen solo
 *    con fundido, en 150. Sin rebote: un aviso que salta llama más atención
 *    que su motivo. La pila se coloca con transform: cada aviso se desplaza
 *    lo que miden los de debajo, así que cuando uno se va los demás se
 *    deslizan a su sitio en vez de saltar.
 *  - Lámina de vidrio (--glass y 16 px de desenfoque): se distingue de lo que
 *    tapa sin ser un bloque opaco encima de la pantalla.
 *
 * «Post-partida»: además del icono de tono, un aviso puede llevar su propia
 * imagen (`media`: el retrato del campeón en «Partida guardada»), un cuerpo
 * con marcado (el resultado en su color) y una segunda acción ("Más tarde").
 *
 * Flujo de fin de partida: un aviso puede ser de progreso (`progress`, una
 * barra que recorre en lugar de la cuenta atrás) y cambiar en su sitio con
 * `update` cuando el trabajo acaba, en vez de apilar un segundo aviso.
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
  /** Trabajo en curso sin cifra: una barra que recorre abajo, en vez de la
   *  cuenta atrás. Va con `duration: 0` y luego se `update`a con el resultado. */
  progress?: boolean;
}

interface Toast extends ToastOptions {
  id: string;
  /** Duración efectiva, para la línea de tiempo restante. */
  ms: number;
  /** Sube con cada `update`: reinicia la cuenta atrás sin repetir la entrada. */
  rev: number;
  /** Saliendo: se funde y deja de ocupar sitio en la pila. */
  leaving?: boolean;
}

interface ToastContextValue {
  /** Muestra un aviso y devuelve su id, por si hay que cerrarlo a mano. */
  toast: (options: ToastOptions) => string;
  /** Cambia un aviso en su sitio («Analizando…» → «Lista»). Si ya se cerró,
   *  sale como uno nuevo: el resultado no se pierde porque se cerrara el
   *  progreso. Devuelve el id con el que queda. */
  update: (id: string, options: ToastOptions) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue>({
  // Fuera del provider no revienta: los avisos son accesorios, y un componente
  // que se monta suelto (una prueba, un panel aislado) no debe caerse por esto.
  toast: () => "",
  update: () => "",
  dismiss: () => {},
});

export const useToast = (): ToastContextValue => useContext(ToastContext);

const DEFAULT_MS = 6000;
/** Lo que dura la salida (--t-quick-exit): después se quita del árbol. */
const EXIT_MS = 150;
const GAP = 8;

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
  // Los ids vivos, para que `update` sepa sin esperar al render si el aviso
  // sigue ahí o hay que sacarlo de nuevo.
  const live = useRef<Set<string>>(new Set());
  const t = useT();

  // Alturas medidas de cada aviso, para colocar la pila con transform.
  const heights = useRef<Map<string, number>>(new Map());
  const [, setLayout] = useState(0);
  const ro = useMemo(
    () =>
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => {
            let changed = false;
            for (const e of entries) {
              const id = (e.target as HTMLElement).dataset.toastId;
              const h = Math.round(e.contentRect.height);
              if (id && heights.current.get(id) !== h) {
                heights.current.set(id, h);
                changed = true;
              }
            }
            if (changed) setLayout((n) => n + 1);
          }),
    []
  );
  const measure = useCallback(
    (el: HTMLDivElement | null) => {
      if (el && ro) ro.observe(el);
    },
    [ro]
  );

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    live.current.delete(id);
    setToasts((prev) => prev.map((x) => (x.id === id ? { ...x, leaving: true } : x)));
    setTimeout(() => {
      heights.current.delete(id);
      setToasts((prev) => prev.filter((x) => x.id !== id));
    }, EXIT_MS);
  }, []);

  const arm = useCallback(
    (id: string, ms: number) => {
      const old = timers.current.get(id);
      if (old) clearTimeout(old);
      timers.current.delete(id);
      if (ms > 0) timers.current.set(id, setTimeout(() => dismiss(id), ms));
    },
    [dismiss]
  );

  const toast = useCallback(
    (options: ToastOptions): string => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const tone = options.tone ?? "info";
      const ms = options.duration ?? (tone === "danger" ? 0 : DEFAULT_MS);
      live.current.add(id);
      setToasts((prev) => {
        // Tope de cinco: una tanda de fallos encadenados llenaba la ventana
        // entera de avisos y tapaba la propia app.
        const next = [...prev, { ...options, tone, id, ms, rev: 0 }];
        next.slice(0, -5).forEach((x) => live.current.delete(x.id));
        return next.slice(-5);
      });
      arm(id, ms);
      return id;
    },
    [arm]
  );

  const update = useCallback(
    (id: string, options: ToastOptions): string => {
      if (!live.current.has(id)) return toast(options);
      const tone = options.tone ?? "info";
      const ms = options.duration ?? (tone === "danger" ? 0 : DEFAULT_MS);
      setToasts((prev) =>
        prev.map((x) => (x.id === id ? { ...options, tone, id, ms, rev: x.rev + 1 } : x))
      );
      arm(id, ms);
      return id;
    },
    [arm, toast]
  );

  // Al desmontar, fuera los temporizadores pendientes.
  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((timer) => clearTimeout(timer));
      map.clear();
      ro?.disconnect();
    };
  }, [ro]);

  const value = useMemo(() => ({ toast, update, dismiss }), [toast, update, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toasts.length > 0 && (
        <div className="toasts" role="region" aria-label={t("Notifications")}>
          {toasts.map((x, i) => {
            const tone = x.tone ?? "info";
            // Lo que miden los avisos más nuevos (los de debajo) que siguen en
            // la pila: el que se va deja su hueco en cuanto empieza a fundirse.
            let offset = 0;
            for (const y of toasts.slice(i + 1)) {
              if (!y.leaving) offset += (heights.current.get(y.id) ?? 0) + GAP;
            }
            return (
              <div
                key={x.id}
                className="toast-slot"
                style={{ transform: `translateY(${-offset}px)` }}
                data-leaving={x.leaving ? "" : undefined}
              >
                <div
                  ref={measure}
                  data-toast-id={x.id}
                  className="toast"
                  role={tone === "danger" ? "alert" : "status"}
                  aria-live={tone === "danger" ? "assertive" : "polite"}
                >
                  <div className="toast__row">
                    <span className={x.media ? "toast__media" : "toast__icon"}>
                      {x.media ?? <ToneIcon tone={tone} />}
                    </span>
                    <div className="toast__text">
                      <div className="toast__head">
                        <span className="toast__title">{x.title}</span>
                        {x.meta && <span className="toast__meta">{x.meta}</span>}
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
                      {x.body && <span className="toast__body">{x.body}</span>}
                      {x.note && <span className="toast__body">{x.note}</span>}
                      {(x.action || x.secondary) && (
                        <div className="toast__actions">
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
                  {/* Trabajo en curso: la barra recorre, no finge un porcentaje. */}
                  {x.progress && (
                    <div className="toast__line toast__progress" aria-hidden="true">
                      <span />
                    </div>
                  )}
                  {/* Lo que le queda al aviso. Solo en los que se van solos: los
                      de peligro se quedan y no tienen cuenta que enseñar. La
                      clave con `rev` la reinicia cuando el aviso cambia. */}
                  {x.ms > 0 && !x.progress && (
                    <div className="toast__line" aria-hidden="true">
                      <div
                        key={x.rev}
                        className="toast__timer"
                        style={{
                          background: `color-mix(in srgb, ${TONE_COLOR[tone]} 70%, transparent)`,
                          animationDuration: `${x.ms}ms`,
                        }}
                      />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </ToastContext.Provider>
  );
};
