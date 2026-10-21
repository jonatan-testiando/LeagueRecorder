import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

/**
 * Selector propio. El `<select>` nativo traía su propio fondo y su propio menú
 * (blanco en tema oscuro, la fuente del sistema), distinto en cada sitio.
 *
 * Patrón de combobox de solo selección (WAI-ARIA): el foco se queda en el
 * botón y la opción activa se anuncia con `aria-activedescendant`.
 *   - Cerrado: ↑ ↓ Intro o Espacio lo abren; una letra salta a la opción que
 *     empieza por ella.
 *   - Abierto: ↑ ↓ Inicio Fin mueven, Intro o Espacio eligen, Esc cierra sin
 *     cambiar y Tab cierra y sigue.
 *
 * El menú va en un portal a `body`: dentro de un panel con overflow se
 * recortaba. Se coloca debajo del botón o encima si no cabe, y nace del
 * borde del botón (opacidad y escala desde ahí, 160 ms; se va en 100).
 *
 * `variant="field"` es el campo hundido de los formularios; `"plain"` no
 * pinta nada y deja el aspecto a la clase que pase quien lo usa.
 */
export interface SelectOption<T extends string> {
  value: T;
  label: React.ReactNode;
  /** Texto para la búsqueda por letra si `label` no es texto. */
  text?: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  /** Nombre para lectores de pantalla si no hay un <label htmlFor>. */
  label?: string;
  id?: string;
  disabled?: boolean;
  size?: "md" | "sm";
  variant?: "field" | "plain";
  /** Icono a la izquierda del valor. */
  icon?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
  /** Ancho mínimo del menú, si ha de ser más ancho que el botón. */
  menuMinWidth?: number;
}

const EXIT_MS = 100;
const GAP = 4;

export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  id,
  disabled = false,
  size = "md",
  variant = "field",
  icon,
  className = "",
  style,
  title,
  menuMinWidth,
}: SelectProps<T>) {
  const autoId = useId();
  const baseId = id ?? `sel${autoId.replace(/:/g, "")}`;
  const listId = `${baseId}-list`;
  const optId = (i: number) => `${baseId}-opt-${i}`;

  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean; maxH: number } | null>(null);
  const typed = useRef({ text: "", at: 0 });
  const closeTimer = useRef<number | undefined>(undefined);

  const selectedIdx = options.findIndex((o) => o.value === value);
  const current = options[selectedIdx];

  const place = useCallback(() => {
    const b = btnRef.current;
    if (!b) return;
    const r = b.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - GAP - 8;
    const above = r.top - GAP - 8;
    const want = Math.min(320, options.length * 36 + 8);
    const up = below < want && above > below;
    setPos({
      left: r.left,
      top: up ? r.top - GAP : r.bottom + GAP,
      width: Math.max(r.width, menuMinWidth ?? 0),
      up,
      maxH: Math.max(120, Math.min(320, up ? above : below)),
    });
  }, [menuMinWidth, options.length]);

  const openMenu = useCallback(
    (at?: number) => {
      if (disabled) return;
      window.clearTimeout(closeTimer.current);
      place();
      setClosing(false);
      setOpen(true);
      setActive(at ?? (selectedIdx >= 0 ? selectedIdx : options.findIndex((o) => !o.disabled)));
    },
    [disabled, options, place, selectedIdx]
  );

  const close = useCallback(() => {
    if (!open) return;
    setClosing(true);
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, EXIT_MS);
  }, [open]);

  const choose = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    if (o.value !== value) onChange(o.value);
    close();
    btnRef.current?.focus();
  };

  // Fuera de él, se cierra; con la ventana moviéndose, se recoloca.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const tgt = e.target as Node;
      if (btnRef.current?.contains(tgt) || listRef.current?.contains(tgt)) return;
      close();
    };
    const onMove = () => place();
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, close, place]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  // La opción activa, siempre a la vista dentro del menú.
  useLayoutEffect(() => {
    if (!open || active < 0) return;
    document.getElementById(optId(active))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  const step = (from: number, dir: 1 | -1) => {
    for (let k = 1; k <= options.length; k++) {
      const i = (from + dir * k + options.length) % options.length;
      if (!options[i].disabled) return i;
    }
    return from;
  };

  const typeahead = (ch: string) => {
    const now = performance.now();
    typed.current.text = now - typed.current.at > 700 ? ch : typed.current.text + ch;
    typed.current.at = now;
    const q = typed.current.text.toLocaleLowerCase();
    const start = open ? active : selectedIdx;
    for (let k = 1; k <= options.length; k++) {
      const i = (start + k + options.length) % options.length;
      const o = options[i];
      const txt = (o.text ?? (typeof o.label === "string" ? o.label : String(o.value))).toLocaleLowerCase();
      if (!o.disabled && txt.startsWith(q)) return i;
    }
    return -1;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    const k = e.key;
    if (!open) {
      if (k === "ArrowDown" || k === "ArrowUp" || k === "Enter" || k === " ") {
        e.preventDefault();
        openMenu();
      } else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const i = typeahead(k);
        if (i >= 0 && options[i].value !== value) onChange(options[i].value);
      }
      return;
    }
    if (k === "ArrowDown") { e.preventDefault(); setActive((a) => step(a, 1)); }
    else if (k === "ArrowUp") { e.preventDefault(); setActive((a) => step(a, -1)); }
    else if (k === "Home") { e.preventDefault(); setActive(step(-1, 1)); }
    else if (k === "End") { e.preventDefault(); setActive(step(options.length, -1)); }
    else if (k === "Enter" || k === " ") { e.preventDefault(); choose(active); }
    else if (k === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
    else if (k === "Tab") { close(); }
    else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const i = typeahead(k);
      if (i >= 0) setActive(i);
    }
  };

  return (
    <>
      <button
        ref={btnRef}
        id={baseId}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open && !closing}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 ? optId(active) : undefined}
        aria-label={label}
        title={title}
        disabled={disabled}
        className={`select select--${variant} select--${size} ${className}`.trim()}
        style={style}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKeyDown}
      >
        {icon}
        <span className="select__value">{current?.label ?? ""}</span>
        <ChevronDown size={size === "sm" ? 14 : 16} className="select__chev" aria-hidden="true" />
      </button>
      {open &&
        pos &&
        createPortal(
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={label}
            tabIndex={-1}
            className="select-menu"
            data-up={pos.up ? "" : undefined}
            data-closing={closing ? "" : undefined}
            style={{
              left: pos.left,
              top: pos.up ? undefined : pos.top,
              bottom: pos.up ? window.innerHeight - pos.top : undefined,
              minWidth: pos.width,
              maxHeight: pos.maxH,
            }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {options.map((o, i) => (
              <li
                key={o.value}
                id={optId(i)}
                role="option"
                aria-selected={o.value === value}
                aria-disabled={o.disabled || undefined}
                data-active={i === active ? "" : undefined}
                className="select-menu__opt"
                onPointerMove={() => !o.disabled && setActive(i)}
                onClick={() => choose(i)}
              >
                <span className="select-menu__label">{o.label}</span>
                {o.value === value && <Check size={14} aria-hidden="true" className="select-menu__check" />}
              </li>
            ))}
          </ul>,
          document.body
        )}
    </>
  );
}
