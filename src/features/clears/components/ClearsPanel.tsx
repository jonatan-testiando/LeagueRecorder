import React, { useContext, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Play, Search } from "lucide-react";
import { PanelActiveContext, ScreenTitle } from "../../../components/ScreenTitle";
import { ChampionAvatar } from "../../../components/ChampionAvatar";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { Segmented } from "../../../components/ui/Segmented";
import { SkeletonLines } from "../../../components/ui/Skeleton";
import { useT } from "../../../core/LanguageProvider";
import { useNavigate } from "../../../core/navegar";
import { matchAge, mmss } from "../../../core/time";
import {
  getJungleClearCatalog,
  getJungleRoutes,
  JUNGLE_AGREEMENT_MIN,
  type JungleClearCatalog,
  type JungleRouteGame,
  type RecordClear,
} from "../../../core/tauri-ipc";
import { useAppStore, useMatches } from "../../../store/useAppStore";
import { Pasos, SEIS, enlaceExterno, pasosTuyos } from "../../player/components/JungleRecord";
import { claveCampeon, idCampeon } from "../campeones";
import "../../player/components/JungleRecord.css";
import "./ClearsPanel.css";

/**
 * Clears: el primer clear récord de cada campeón, de la hoja comunitaria de
 * clears de jungla (copia local que se refresca a diario, jungle_records.rs).
 *
 * A la izquierda, los campeones (buscar, filtrar por categoría de la hoja o
 * por los que juegas tú, ordenar). A la derecha, el elegido: el vídeo de su
 * clear dentro de la app, todos sus clears y tu mejor primer clear con él,
 * sacado de tus rutas de jungla (lo que MicroLab no puede dar: no mide el tuyo).
 */

type T = ReturnType<typeof useT>;
type Tipo = "all" | "meta" | "off_meta" | "non_meta";
type Orden = "fast" | "az";
type Quien = "all" | "mine";

interface Campeon {
  clave: string;
  nombre: string;
  categoria: RecordClear["category"];
  /** Clears completos (6 campamentos), el más rápido primero. */
  clears: RecordClear[];
}

/** Tus primeros clears completos con un campeón. */
interface Tuyo {
  partidas: JungleRouteGame[];
  mejor: JungleRouteGame;
  mediana: number;
}

const CATEGORIA: Record<string, string> = {
  meta: "Meta",
  off_meta: "Off-meta",
  non_meta: "Non-meta",
  outdated: "Outdated",
};

const CLAVE_VISTA = "clears.vista";

const leerVista = (): { tipo: Tipo; orden: Orden; quien: Quien; elegido: string | null } => {
  const base = { tipo: "all" as Tipo, orden: "fast" as Orden, quien: "all" as Quien, elegido: null };
  try {
    return { ...base, ...JSON.parse(localStorage.getItem(CLAVE_VISTA) ?? "{}") };
  } catch {
    return base;
  }
};

const mediana = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export const ClearsPanel: React.FC = () => {
  const t = useT();
  const activo = useContext(PanelActiveContext);
  const [catalogo, setCatalogo] = useState<JungleClearCatalog | null | undefined>(undefined);
  const [rutas, setRutas] = useState<JungleRouteGame[] | null>(null);

  // Se pide al entrar por primera vez, no al arrancar la app.
  useEffect(() => {
    if (!activo || catalogo !== undefined) return;
    getJungleClearCatalog()
      .then(setCatalogo)
      .catch(() => setCatalogo(null));
  }, [activo, catalogo]);
  useEffect(() => {
    if (!activo || rutas) return;
    getJungleRoutes()
      .then(setRutas)
      .catch(() => setRutas([]));
  }, [activo, rutas]);

  const inicial = useMemo(leerVista, []);
  const [tipo, setTipo] = useState<Tipo>(inicial.tipo);
  const [orden, setOrden] = useState<Orden>(inicial.orden);
  const [quien, setQuien] = useState<Quien>(inicial.quien);
  const [elegido, setElegido] = useState<string | null>(inicial.elegido);
  const [busca, setBusca] = useState("");
  useEffect(() => {
    try {
      localStorage.setItem(CLAVE_VISTA, JSON.stringify({ tipo, orden, quien, elegido }));
    } catch {
      /* sin almacenamiento: no pasa nada */
    }
  }, [tipo, orden, quien, elegido]);

  /** Los campeones de la hoja con sus clears completos. */
  const campeones = useMemo<Campeon[]>(() => {
    const por = new Map<string, Campeon>();
    for (const r of catalogo?.records ?? []) {
      if (r.camps !== 6) continue;
      const k = claveCampeon(r.champion);
      const c = por.get(k) ?? { clave: k, nombre: r.champion, categoria: r.category, clears: [] };
      c.clears.push(r);
      por.set(k, c);
    }
    for (const c of por.values()) c.clears.sort((a, b) => a.clearS - b.clearS);
    return [...por.values()];
  }, [catalogo]);

  /** Tus primeros clears completos y fiables, por campeón. */
  const tuyos = useMemo(() => {
    const por = new Map<string, JungleRouteGame[]>();
    for (const g of rutas ?? []) {
      const r = g.route;
      if (!r.full_clear || r.first_clear_end == null || r.agreement < JUNGLE_AGREEMENT_MIN) continue;
      const k = claveCampeon(g.champion);
      por.set(k, [...(por.get(k) ?? []), g]);
    }
    const out = new Map<string, Tuyo>();
    for (const [k, partidas] of por) {
      const fines = partidas.map((g) => g.route.first_clear_end as number);
      const mejor = partidas.reduce((a, b) => ((b.route.first_clear_end as number) < (a.route.first_clear_end as number) ? b : a));
      out.set(k, { partidas, mejor, mediana: mediana(fines) });
    }
    return out;
  }, [rutas]);

  const visibles = useMemo(() => {
    const q = claveCampeon(busca);
    const lista = campeones.filter(
      (c) =>
        (tipo === "all" || c.categoria === tipo) &&
        (quien === "all" || tuyos.has(c.clave)) &&
        (!q || c.clave.includes(q))
    );
    lista.sort((a, b) =>
      orden === "az" ? a.nombre.localeCompare(b.nombre) : a.clears[0].clearS - b.clears[0].clearS || a.nombre.localeCompare(b.nombre)
    );
    return lista;
  }, [campeones, tipo, quien, busca, orden, tuyos]);

  // Por defecto, el campeón con el que más clears tuyos hay; si no, el primero.
  const actual = useMemo(() => {
    const porClave = (k: string | null) => (k ? campeones.find((c) => c.clave === k) : undefined);
    const tuyoMasJugado = [...tuyos.entries()].sort((a, b) => b[1].partidas.length - a[1].partidas.length)[0]?.[0] ?? null;
    return porClave(elegido) ?? porClave(tuyoMasJugado) ?? visibles[0] ?? null;
  }, [campeones, elegido, tuyos, visibles]);

  // El elegido, a la vista en la lista (ordenada por tiempo, puede quedar muy abajo).
  const lista = useRef<HTMLElement>(null);
  useEffect(() => {
    lista.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, [actual?.clave, visibles.length]);

  let cuerpo: React.ReactNode;
  if (catalogo === undefined) {
    cuerpo = (
      <div className="card clr-empty">
        <SkeletonLines lines={6} />
      </div>
    );
  } else if (catalogo === null || catalogo.unavailable) {
    cuerpo = (
      <div className="card clr-empty">
        <EmptyState
          title={t("Couldn't download the community sheet of record clears. It will retry on its own.")}
          text={t("It needs an internet connection the first time; after that it works from the local copy.")}
        />
      </div>
    );
  } else {
    cuerpo = (
      <div className="clr-body">
        <nav ref={lista} className="card clr-list" aria-label={t("Champions")}>
          {visibles.length === 0 ? (
            <p className="clr-list__none">{t("No champion matches these filters.")}</p>
          ) : (
            <ul>
              {visibles.map((c) => {
                const tu = tuyos.get(c.clave);
                return (
                  <li key={c.clave}>
                    <button
                      type="button"
                      className="clr-item"
                      aria-current={actual?.clave === c.clave ? "true" : undefined}
                      onClick={() => setElegido(c.clave)}
                    >
                      <ChampionAvatar champion={idCampeon(c.nombre)} size={28} />
                      <span className="clr-item__name">{c.nombre}</span>
                      <span className="clr-item__meta">
                        {tu && <span className="clr-item__you">{t("you {t}", { t: mmss(tu.mejor.route.first_clear_end as number) })}</span>}
                        <b className="u-metric">{mmss(c.clears[0].clearS)}</b>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>
        {actual ? (
          <Detalle key={actual.clave} campeon={actual} tuyo={tuyos.get(actual.clave) ?? null} t={t} />
        ) : (
          <div className="card clr-empty">
            <EmptyState title={t("No champion matches these filters.")} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="clr">
      <ScreenTitle align="content" title={t("Clears")} sub={t("Record first clears for every champion")} />
      <div className="clr-col">
        <div className="clr-filters" role="group" aria-label={t("Filters")}>
          <label className="clr-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              className="field"
              placeholder={t("Search champion…")}
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              aria-label={t("Search champion…")}
            />
          </label>
          <Segmented
            label={t("Category")}
            value={tipo}
            onChange={setTipo}
            options={[
              { value: "all", label: t("All") },
              { value: "meta", label: "Meta" },
              { value: "off_meta", label: "Off-meta" },
              { value: "non_meta", label: "Non-meta" },
            ]}
          />
          <Segmented
            label={t("Champions")}
            value={quien}
            onChange={setQuien}
            options={[
              { value: "all", label: t("All champions") },
              { value: "mine", label: t("Yours"), count: tuyos.size || undefined, disabled: tuyos.size === 0 },
            ]}
          />
          <Segmented
            label={t("Sort")}
            value={orden}
            onChange={setOrden}
            options={[
              { value: "fast", label: t("Fastest") },
              { value: "az", label: "A-Z" },
            ]}
          />
        </div>
        {cuerpo}
        {catalogo && !catalogo.unavailable && (
          <p className="jrec__src clr-src">
            <button type="button" className="jrec__link" onClick={() => openUrl(catalogo.sheetUrl).catch(() => {})}>
              {t("Community jungle clear sheet")}
            </button>
            {catalogo.season && ` · ${catalogo.season}`}
            {` · ${t("{n} champions, {m} clears", { n: campeones.length, m: campeones.reduce((a, c) => a + c.clears.length, 0) })}`}
            {catalogo.updatedMs != null &&
              ` · ${t("updated {when}", { when: matchAge(new Date(catalogo.updatedMs).toISOString(), t) })}`}
          </p>
        )}
      </div>
    </div>
  );
};

/** El campeón elegido: su vídeo, sus clears y el tuyo. */
const Detalle: React.FC<{ campeon: Campeon; tuyo: Tuyo | null; t: T }> = ({ campeon, tuyo, t }) => {
  const [sel, setSel] = useState(0);
  const rec = campeon.clears[Math.min(sel, campeon.clears.length - 1)];
  const navigate = useNavigate();
  // Las partidas, cargándolas si aún no lo estaban (sin pasar por la Biblioteca).
  const { matches } = useMatches();
  const setSelectedMatch = useAppStore((s) => s.setSelectedMatch);
  const setPendingSeek = useAppStore((s) => s.setPendingSeek);

  const mejor = tuyo?.mejor ?? null;
  const tuRuta = mejor ? pasosTuyos(mejor.route) : [];
  const delta = mejor ? Math.round((mejor.route.first_clear_end as number) - rec.clearS) : null;
  const orden = (route: string[]) => route.filter((k) => SEIS.includes(k)).join(">");
  const mismaRuta = mejor != null && orden(tuRuta) === orden(rec.route);

  // Tu partida, en el momento en que empieza el primer clear.
  const abrirTuya = () => {
    if (!mejor) return;
    const m = matches.find((x) => x.id === mejor.match_id);
    if (!m) return;
    const inicio = mejor.route.clears[0]?.start ?? 0;
    setPendingSeek(Math.max(0, mejor.route.video_offset + inicio - 3));
    setSelectedMatch(m);
    navigate("/review");
  };

  return (
    <section className="card clr-detail" aria-label={campeon.nombre}>
      <header className="clr-detail__head">
        <ChampionAvatar champion={idCampeon(campeon.nombre)} size={40} />
        <div className="clr-detail__title">
          <h2 className="t-card">{campeon.nombre}</h2>
          <span className="t-small clr-faint">
            {t(CATEGORIA[campeon.categoria] ?? campeon.categoria)} ·{" "}
            {campeon.clears.length === 1 ? t("1 clear") : t("{n} clears", { n: campeon.clears.length })}
          </span>
        </div>
      </header>

      <div className="clr-video">
        {rec.youtubeId ? (
          <iframe
            key={`${rec.youtubeId}@${rec.startS}`}
            src={`https://www.youtube-nocookie.com/embed/${rec.youtubeId}?start=${rec.startS}&rel=0`}
            title={`${campeon.nombre} · ${mmss(rec.clearS)} · ${rec.player}`}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <div className="clr-video__fuera">
            <p>{t("This video isn't on YouTube: it opens in your browser.")}</p>
            <Button variant="primary" size="sm" icon={<ExternalLink size={13} />} onClick={() => openUrl(enlaceExterno(rec)).catch(() => {})}>
              {t("Watch the record")}
            </Button>
          </div>
        )}
      </div>

      <div className="clr-sel">
        <div className="jrec__time">
          <b className="u-metric">{mmss(rec.clearS)}</b>
          <span>
            {[rec.player, t("patch {p}", { p: rec.patch }), rec.smites === 1 ? t("1 smite") : t("{n} smites", { n: rec.smites })]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        <Pasos pasos={rec.route} t={t} />
        {rec.notes && <p className="jrec__note">{t("Sheet notes: {notes}", { notes: rec.notes })}</p>}
      </div>

      {/* Tú con este campeón: el mejor primer clear completo de tus rutas. */}
      <div className="clr-you">
        <span className="u-label">{t("You with {champ}", { champ: campeon.nombre })}</span>
        {mejor && tuyo ? (
          <>
            <p className="jrec__vs">
              {t("Best {best} · median {median} · {n} games", {
                best: mmss(mejor.route.first_clear_end as number),
                median: mmss(tuyo.mediana),
                n: tuyo.partidas.length,
              })}
              {delta != null &&
                ` · ${
                  delta > 0
                    ? t("{s} s slower than this clear", { s: delta })
                    : delta < 0
                      ? t("{s} s faster than this clear", { s: -delta })
                      : t("same time as this clear")
                }`}
            </p>
            <div className="clr-you__ruta">
              <Pasos pasos={tuRuta} t={t} />
              {mismaRuta && <span className="jrec__note">{t("Same order as this clear.")}</span>}
            </div>
            <Button variant="ghost" size="sm" icon={<Play size={13} />} onClick={abrirTuya}>
              {t("Watch your best clear")}
            </Button>
          </>
        ) : (
          <p className="jrec__note">{t("No full first clear of yours with {champ} yet (it needs the game measured with video).", { champ: campeon.nombre })}</p>
        )}
      </div>

      {/* Todos los clears del campeón: el de arriba es el que se ve. */}
      <div className="clr-clears">
        <span className="u-label">{t("All clears")}</span>
        <ul>
          {campeon.clears.map((c, i) => (
            <li key={`${c.videoUrl}@${c.startS}@${i}`}>
              <button type="button" className="clr-clear" aria-current={c === rec ? "true" : undefined} onClick={() => setSel(i)}>
                <b className="u-metric">{mmss(c.clearS)}</b>
                <span className="clr-clear__ruta">
                  <Pasos pasos={c.route} t={t} />
                </span>
                <span className="clr-clear__meta">
                  {[c.player, c.patch, c.smites === 1 ? t("1 smite") : t("{n} smites", { n: c.smites })].join(" · ")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
};
