import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ChartNoAxesColumn,
  CircleDot,
  Film,
  FolderOpen,
  Library,
  Moon,
  ScanSearch,
  Search,
  Settings2,
  Sun,
  Target,
  TriangleAlert,
} from "lucide-react";
import { useT } from "../core/LanguageProvider";
import { useTheme } from "../core/ThemeProvider";
import { useAppStore, useErrorClips } from "../store/useAppStore";
import { getAppConfig } from "../core/tauri-ipc";
import { computeKDA, outcome, queueKey } from "../core/matchStats";
import { clock, relativeDay } from "../core/time";
import { describeEvent } from "../core/eventText";
import { eventMeta, type Tone } from "../features/player/components/eventMeta";
import { buildQueue } from "../features/player/components/ReviewQueue";
import { ChampionAvatar } from "./ChampionAvatar";
import type { MatchMetadata } from "../types";

/**
 * Paleta de comandos (Ctrl K / Cmd K).
 *
 * Un solo campo para las cuatro cosas que se buscan en esta app, en este
 * orden: partidas (campeón, resultado, KDA, fecha) → momentos de esas
 * partidas (una muerte, un dragón: abre la partida en ese instante) →
 * pantallas → acciones. Todo sale de lo que ya está en memoria: la lista de
 * partidas del store trae sus sucesos, así que buscar momentos no cuesta
 * ninguna llamada al backend (se miran las 20 más recientes).
 *
 * Teclado de escritorio: ↑ ↓ se mueven, Enter abre, Tab salta de grupo y Esc
 * cierra. El foco no sale del diálogo (se queda en el campo; la lista es un
 * `listbox` con `aria-activedescendant`).
 */

type Group = "games" | "moments" | "screens" | "actions";

interface Item {
  id: string;
  group: Group;
  /** Texto en el que se busca (se compara sin acentos ni mayúsculas). */
  hay: string;
  /** Nombre accesible de la opción. */
  label: string;
  /** Orden dentro del grupo al buscar (menor, antes). Los momentos que salieron
   *  mal van primero: son los que se buscan para revisar. */
  rank?: number;
  run: () => void;
  render: (hl: (s: string) => React.ReactNode, selected: boolean) => React.ReactNode;
}

const GROUP_LABEL: Record<Group, string> = {
  games: "Games",
  moments: "Moments",
  screens: "Screens",
  actions: "Actions",
};
const GROUP_ORDER: Group[] = ["games", "moments", "screens", "actions"];

/** Cuántos de cada grupo, sin buscar y buscando. Sin buscar no se listan las
 *  pantallas (ya están en el rail): la paleta vacía cabe entera sin scroll. */
const LIMIT_IDLE: Record<Group, number> = { games: 3, moments: 3, screens: 0, actions: 3 };
const LIMIT_QUERY: Record<Group, number> = { games: 6, moments: 6, screens: 8, actions: 3 };

/** Partidas cuyos sucesos entran en la búsqueda de momentos. */
const MOMENT_MATCHES = 20;

/** Sin tildes y en minúsculas: "Dragón" se encuentra escribiendo "dragon". */
const fold = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const tokensOf = (q: string): string[] => fold(q).split(/\s+/).filter(Boolean);

/** Resalta cada aparición de cualquiera de los términos, sin tildes de por medio. */
function highlight(text: string, tokens: string[]): React.ReactNode {
  if (!tokens.length || !text) return text;
  const chars = Array.from(text);
  let ns = "";
  const map: number[] = [];
  chars.forEach((ch, i) => {
    for (const c of fold(ch)) {
      ns += c;
      map.push(i);
    }
  });
  const on = new Array<boolean>(chars.length).fill(false);
  for (const tok of tokens) {
    let from = 0;
    for (;;) {
      const at = ns.indexOf(tok, from);
      if (at < 0) break;
      for (let k = at; k < at + tok.length; k++) on[map[k]] = true;
      from = at + tok.length;
    }
  }
  if (!on.some(Boolean)) return text;
  const out: React.ReactNode[] = [];
  let buf = "";
  let cur = on[0];
  const flush = (key: number) => {
    if (!buf) return;
    out.push(cur ? <mark key={key} className="cmdk__hl">{buf}</mark> : buf);
    buf = "";
  };
  chars.forEach((ch, i) => {
    if (on[i] !== cur) {
      flush(i);
      cur = on[i];
    }
    buf += ch;
  });
  flush(chars.length);
  return out;
}

const hhmm = (iso: string): string => {
  const d = new Date(iso.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const RESULT_COLOR = (r: ReturnType<typeof outcome>) =>
  r === "victory" ? "var(--win)" : r === "defeat" ? "var(--loss)" : "var(--faint)";

/** Marca del momento: círculo rojo para lo que salió mal, jade para lo bueno,
 *  rombo violeta para lo que encontró el analizador. */
const Mark: React.FC<{ kind: "bad" | "good" | "finding" | "neutral" }> = ({ kind }) => (
  <span className={`cmdk__slot cmdk__slot--${kind}`} aria-hidden="true">
    <span className="cmdk__mark" />
  </span>
);

const RANK_OF: Record<Tone, number> = { throw: 0, mistake: 0, inaccuracy: 1, excellent: 2, good: 3, neutral: 4 };

const markOf = (tone: Tone): "bad" | "good" | "neutral" =>
  tone === "mistake" || tone === "throw" || tone === "inaccuracy"
    ? "bad"
    : tone === "excellent" || tone === "good"
      ? "good"
      : "neutral";

const SKIP_EVENTS = new Set(["GameStart", "GameEnd", "Ultimate"]);

export const CommandPalette: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const t = useT();
  const navigate = useNavigate();
  const { resolved, setTheme } = useTheme();
  const matches = useAppStore((s) => s.matches);
  const setSelectedMatch = useAppStore((s) => s.setSelectedMatch);
  const setSelectedVod = useAppStore((s) => s.setSelectedVod);
  const setPendingSeek = useAppStore((s) => s.setPendingSeek);
  const { clips: errorClips } = useErrorClips();

  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<Element | null>(null);

  // Al abrir: campo vacío y foco dentro. Al cerrar: el foco vuelve a donde
  // estaba (el botón de la barra, o lo que fuera).
  useLayoutEffect(() => {
    if (open) {
      prevFocus.current = document.activeElement;
      setQuery("");
      setSel(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else if (prevFocus.current instanceof HTMLElement) {
      prevFocus.current.focus();
      prevFocus.current = null;
    }
  }, [open]);

  const close = useCallback(() => onClose(), [onClose]);

  const openMatch = useCallback(
    (m: MatchMetadata, seek?: number) => {
      if (seek != null) setPendingSeek(seek);
      if (m.is_vod) {
        setSelectedVod(m);
        navigate("/vod");
      } else {
        setSelectedMatch(m);
        navigate("/review");
      }
    },
    [navigate, setPendingSeek, setSelectedMatch, setSelectedVod]
  );

  const byDate = useMemo(
    () => [...matches].sort((a, b) => (a.date < b.date ? 1 : -1)),
    [matches]
  );

  /* -------------------------------------------------------------- partidas */
  const games = useMemo<Item[]>(() => {
    if (!open) return [];
    return byDate.map((m) => {
      const r = outcome(m.result);
      const res = t(r === "victory" ? "Victory" : r === "defeat" ? "Defeat" : "No result");
      const k = computeKDA(m.events);
      const kda = m.kda ?? `${k.kills}/${k.deaths}/${k.assists}`;
      const rel = relativeDay(m.date, t);
      const cuando = rel === t("today") || rel === t("yesterday") ? `${rel} ${hhmm(m.date)}` : rel;
      const cola = t(queueKey(m.queue));
      return {
        id: `game:${m.id}`,
        group: "games" as const,
        hay: fold([m.champion, res, m.result, kda, rel, m.date, cola, m.is_vod ? "vod" : ""].join(" ")),
        label: `${m.champion} · ${res} · ${kda} · ${cuando}`,
        run: () => openMatch(m),
        render: (hl) => (
          <>
            <ChampionAvatar champion={m.champion} size={28} ring={RESULT_COLOR(r)} />
            <span className="cmdk__main">
              <span className="cmdk__strong">{hl(m.champion)}</span>
              <span className="cmdk__dim"> · </span>
              <span style={{ color: RESULT_COLOR(r) }}>{hl(res)}</span>
              <span className="cmdk__dim"> · </span>
              <span className="cmdk__num">{hl(kda)}</span>
            </span>
            <span className="cmdk__meta">{hl(cuando)}</span>
          </>
        ),
      };
    });
  }, [open, byDate, t, openMatch]);

  /* -------------------------------------------------------------- momentos */
  // Sin buscar: la cola de revisión de la última partida (lo que queda por
  // mirar). Buscando: todos los sucesos con frase de las 20 más recientes.
  const momentsIdle = useMemo<Item[]>(() => {
    if (!open) return [];
    const ultima = byDate.find((m) => !m.is_vod);
    if (!ultima) return [];
    const rel = relativeDay(ultima.date, t);
    const clips = errorClips.filter((c) => c.match_id === ultima.id);
    return buildQueue(ultima, clips, t)
      .filter((mo) => !mo.reviewed)
      .map((mo) => ({
        id: `moment:${ultima.id}:${mo.id}`,
        group: "moments" as const,
        hay: "",
        label: `${clock(mo.time)} ${mo.title} · ${ultima.champion}, ${rel}`,
        run: () => openMatch(ultima, mo.time),
        render: (hl) => (
          <>
            <Mark kind={mo.severity === "low" ? "finding" : "bad"} />
            <span className="cmdk__time">{clock(mo.time)}</span>
            <span className="cmdk__main">{hl(mo.title)}</span>
            <span className="cmdk__meta">{`${ultima.champion}, ${rel}`}</span>
          </>
        ),
      }));
  }, [open, byDate, errorClips, t, openMatch]);

  const momentsAll = useMemo<Item[]>(() => {
    if (!open) return [];
    const out: Item[] = [];
    for (const m of byDate.slice(0, MOMENT_MATCHES)) {
      const rel = relativeDay(m.date, t);
      for (const ev of m.events) {
        if (SKIP_EVENTS.has(ev.type)) continue;
        const meta = eventMeta(ev);
        const text = describeEvent(ev, t);
        if (!text) continue;
        const where = `${m.champion}, ${rel}`;
        out.push({
          id: `moment:${m.id}:${ev.time}:${ev.type}:${ev.subtype ?? ""}`,
          group: "moments",
          hay: fold([text, t(meta.label), m.champion, rel, ev.actor ?? "", ev.target ?? ""].join(" ")),
          label: `${clock(ev.time)} ${text} · ${where}`,
          rank: RANK_OF[meta.tone] ?? 4,
          run: () => openMatch(m, ev.time),
          render: (hl) => (
            <>
              <Mark kind={markOf(meta.tone)} />
              <span className="cmdk__time">{clock(ev.time)}</span>
              <span className="cmdk__main">{hl(text)}</span>
              <span className="cmdk__meta">{hl(where)}</span>
            </>
          ),
        });
      }
      // Los errores que marcaste tú en esa partida, con su nota.
      for (const c of errorClips) {
        if (c.match_id !== m.id || c.start_time == null) continue;
        const first = c.events?.[0];
        const text = (first ? first.text : c.note) || t("Flagged error");
        const where = `${m.champion}, ${rel}`;
        out.push({
          id: `moment:${m.id}:clip:${c.path}`,
          group: "moments",
          hay: fold([text, t("Flagged error"), first?.category ?? "", m.champion, rel].join(" ")),
          label: `${clock(c.start_time)} ${text} · ${where}`,
          rank: 0,
          run: () => openMatch(m, c.start_time ?? 0),
          render: (hl) => (
            <>
              <Mark kind="bad" />
              <span className="cmdk__time">{clock(c.start_time ?? 0)}</span>
              <span className="cmdk__main">{hl(text)}</span>
              <span className="cmdk__meta">{hl(where)}</span>
            </>
          ),
        });
      }
    }
    return out;
  }, [open, byDate, errorClips, t, openMatch]);

  /* -------------------------------------------------------------- pantallas */
  const screens = useMemo<Item[]>(() => {
    const S: { path: string; label: string; icon: React.ReactNode }[] = [
      { path: "/home", label: "Today", icon: <CircleDot size={16} /> },
      { path: "/review", label: "Library", icon: <Library size={16} /> },
      { path: "/clips", label: "Clips", icon: <Film size={16} /> },
      { path: "/errors", label: "Errors", icon: <TriangleAlert size={16} /> },
      { path: "/patterns", label: "Patterns", icon: <ChartNoAxesColumn size={16} /> },
      { path: "/training", label: "Training", icon: <Target size={16} /> },
      { path: "/vod", label: "Video analysis", icon: <ScanSearch size={16} /> },
      { path: "/settings", label: "Settings", icon: <Settings2 size={16} /> },
    ];
    return S.map((s) => ({
      id: `screen:${s.path}`,
      group: "screens" as const,
      hay: fold(`${t(s.label)} ${s.label}`),
      label: t(s.label),
      run: () => navigate(s.path),
      render: (hl) => (
        <>
          <span className="cmdk__slot" aria-hidden="true">{s.icon}</span>
          <span className="cmdk__main">{hl(t(s.label))}</span>
          <span className="cmdk__meta">{t("Go to screen")}</span>
        </>
      ),
    }));
  }, [t, navigate]);

  /* --------------------------------------------------------------- acciones */
  const actions = useMemo<Item[]>(() => {
    const aClaro = resolved === "dark";
    const tema = aClaro ? t("Switch to light theme") : t("Switch to dark theme");
    // La prueba de 10 s vive dentro de Ajustes (lleva la cuenta atrás y el
    // parar): desde aquí se lleva al botón, no se lanza a ciegas.
    const prueba = t("Run a 10-second recording test");
    const carpeta = t("Open recordings folder");
    return [
      {
        id: "action:test",
        group: "actions" as const,
        hay: fold(`${prueba} Run a 10-second recording test test capture`),
        label: prueba,
        run: () => navigate("/settings?cat=recording"),
        render: (hl) => (
          <>
            <span className="cmdk__slot cmdk__slot--action" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <circle cx="12" cy="12" r="9" />
                <circle cx="12" cy="12" r="3.5" fill="var(--signal)" stroke="none" />
              </svg>
            </span>
            <span className="cmdk__main">{hl(prueba)}</span>
            <span className="cmdk__meta">{`${t("Settings")} › ${t("Capture")}`}</span>
          </>
        ),
      },
      {
        id: "action:folder",
        group: "actions" as const,
        hay: fold(`${carpeta} Open recordings folder folder videos`),
        label: carpeta,
        run: () => {
          getAppConfig()
            .then((c) => (c.save_directory ? revealItemInDir(c.save_directory) : Promise.reject()))
            .catch(() => navigate("/settings?cat=storage"));
        },
        render: (hl) => (
          <>
            <span className="cmdk__slot cmdk__slot--action" aria-hidden="true"><FolderOpen size={16} /></span>
            <span className="cmdk__main">{hl(carpeta)}</span>
          </>
        ),
      },
      {
        id: "action:theme",
        group: "actions" as const,
        hay: fold(`${tema} ${aClaro ? "Switch to light theme" : "Switch to dark theme"} theme`),
        label: tema,
        run: () => {
          setTheme(aClaro ? "light" : "dark").catch(() => {});
        },
        render: (hl) => (
          <>
            <span className="cmdk__slot cmdk__slot--action" aria-hidden="true">
              {aClaro ? <Sun size={16} /> : <Moon size={16} />}
            </span>
            <span className="cmdk__main">{hl(tema)}</span>
          </>
        ),
      },
    ];
  }, [resolved, setTheme, t, navigate]);

  /* ------------------------------------------------------------- resultados */
  const tokens = useMemo(() => tokensOf(query), [query]);
  const sections = useMemo(() => {
    const buscando = tokens.length > 0;
    const lim = buscando ? LIMIT_QUERY : LIMIT_IDLE;
    const pasa = (it: Item) => tokens.every((tok) => it.hay.includes(tok));
    const src: Record<Group, Item[]> = {
      games,
      moments: buscando ? momentsAll : momentsIdle,
      screens,
      actions,
    };
    const porRango = (a: Item, b: Item) => (a.rank ?? 0) - (b.rank ?? 0);
    return GROUP_ORDER.map((g) => ({
      group: g,
      // `sort` es estable: a igual rango se conserva el orden de antes (la
      // partida más reciente primero, y dentro, por minuto).
      items: (buscando ? src[g].filter(pasa).sort(porRango) : src[g]).slice(0, lim[g]),
    })).filter((s) => s.items.length > 0);
  }, [tokens, games, momentsAll, momentsIdle, screens, actions]);

  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  const selIdx = flat.length ? Math.min(sel, flat.length - 1) : -1;
  const selected = selIdx >= 0 ? flat[selIdx] : null;

  useEffect(() => setSel(0), [query]);

  // La opción elegida siempre a la vista, también al moverse con el teclado.
  useEffect(() => {
    if (!selected) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-cmdk-id="${CSS.escape(selected.id)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const run = useCallback(
    (it: Item | null) => {
      if (!it) return;
      onClose();
      it.run();
    },
    [onClose]
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (flat.length) setSel((selIdx + 1) % flat.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length) setSel((selIdx - 1 + flat.length) % flat.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(selected);
    } else if (e.key === "Tab") {
      // Tab salta al primer elemento del grupo siguiente (Mayús: anterior). Y
      // de paso atrapa el foco: nunca sale del diálogo.
      e.preventDefault();
      if (!sections.length) return;
      const starts: number[] = [];
      let n = 0;
      for (const s of sections) {
        starts.push(n);
        n += s.items.length;
      }
      let cur = 0;
      for (let i = 0; i < starts.length; i++) if (selIdx >= starts[i]) cur = i;
      const next = e.shiftKey
        ? (cur - 1 + starts.length) % starts.length
        : (cur + 1) % starts.length;
      setSel(starts[next]);
    }
  };

  if (!open) return null;

  const hl = (s: string) => highlight(s, tokens);
  const optId = (it: Item) => `cmdk-opt-${it.id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

  return (
    <div className="cmdk-veil" onMouseDown={close}>
      <div
        className="cmdk"
        role="dialog"
        aria-modal="true"
        aria-label={t("Search LeagueRecorder")}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="cmdk__field">
          <Search size={18} aria-hidden="true" />
          <input
            ref={inputRef}
            className="cmdk__input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-list"
            aria-autocomplete="list"
            aria-activedescendant={selected ? optId(selected) : undefined}
            aria-label={t("Search games, champions or moments…")}
            placeholder={t("Search games, champions or moments…")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <kbd className="u-kbd">Esc</kbd>
        </div>

        <div
          className="cmdk__list"
          id="cmdk-list"
          role="listbox"
          ref={listRef}
          aria-label={t("Results")}
          // Un clic en una opción no debe robarle el foco al campo: si se lo
          // roba, Esc y las flechas dejan de llegar a la paleta.
          onMouseDown={(e) => e.preventDefault()}
        >
          {sections.length === 0 && (
            <p className="cmdk__empty">{t("Nothing matches “{q}”.", { q: query.trim() })}</p>
          )}
          {sections.map((s, si) => (
            <div key={s.group} role="group" aria-labelledby={`cmdk-g-${s.group}`}>
              <div
                id={`cmdk-g-${s.group}`}
                className="cmdk__group"
                style={si === 0 ? { paddingTop: 10 } : undefined}
              >
                {t(GROUP_LABEL[s.group])}
              </div>
              {s.items.map((it) => {
                const on = selected?.id === it.id;
                return (
                  <div
                    key={it.id}
                    id={optId(it)}
                    data-cmdk-id={it.id}
                    role="option"
                    aria-selected={on}
                    aria-label={it.label}
                    className={`cmdk__item${on ? " cmdk__item--on" : ""}`}
                    onMouseMove={() => {
                      const i = flat.indexOf(it);
                      if (i !== selIdx) setSel(i);
                    }}
                    onClick={() => run(it)}
                  >
                    {it.render(hl, on)}
                    {on && <kbd className="u-kbd cmdk__enter">Enter</kbd>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div className="cmdk__foot" aria-hidden="true">
          <span className="cmdk__keys">
            <kbd className="u-kbd">↑</kbd>
            <kbd className="u-kbd">↓</kbd>
            {t("move")}
          </span>
          <span>·</span>
          <span className="cmdk__keys">
            <kbd className="u-kbd">Enter</kbd>
            {t("open")}
          </span>
          <span>·</span>
          <span className="cmdk__keys">
            <kbd className="u-kbd">Tab</kbd>
            {t("switch group")}
          </span>
        </div>
      </div>
    </div>
  );
};
