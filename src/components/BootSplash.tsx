import React, { useEffect, useRef, useState } from "react";
import { useT } from "../core/LanguageProvider";
import { useCurrentRank } from "../core/useCurrentRank";
import { rankIcon, rankLabel } from "../core/ddragon";
import { BrandMark } from "./BrandMark";
import "./BootSplash.css";

/**
 * Bienvenida al abrir la app (2026-10-30).
 *
 * El usuario echaba de menos «la pantalla de bienvenida» (el asistente de
 * primer arranque, que solo sale una vez) y la quería al abrir el programa
 * mientras carga, «así solo sean 3 segundos». No es el asistente, que es un
 * formulario: es su cabecera hecha portada. La marca se dibuja, el nombre y
 * el saludo con tu rango, y una línea que dice qué está cargando.
 *
 * Se va cuando la biblioteca está leída, pero no antes de MIN_MS (si no, en un
 * arranque rápido sería un parpadeo) ni después de MAX_MS (si Riot o el disco
 * tardan, la app no se queda secuestrada). Un clic o una tecla la cierran ya.
 * Al irse, App deja que la pantalla de debajo haga su entrada escalonada: con
 * la bienvenida encima, esa entrada pasaba sin verse.
 */

// 1 s desde que se VE (el primer fotograma, no el montaje: en un arranque en
// frío entre uno y otro pasan ~250 ms). La coreografía (BootSplash.css) acaba a
// los ~960 ms —la base de la marca entra a los 700 y dura 260—, así que se ve
// entera. Eran 2 s desde el montaje, y medido el 2026-11-19 los datos de Hoy ya
// estaban pintados debajo a los ~0,8 s: más de un segundo de espera solo por esto.
const MIN_MS = 1000;
const MAX_MS = 6000;
/** Lo que dura la salida (BootSplash.css, `boot-out`). */
const SALIDA_MS = 280;

export const BootSplash: React.FC<{
  /** La biblioteca ya está leída (o falló: tampoco hay que esperar más). */
  ready: boolean;
  /** Cuántas partidas hay, para la última línea. */
  games: number;
  /** Ya no se ve: App la desmonta y suelta la entrada de la pantalla. */
  onGone: () => void;
}> = ({ ready, games, onGone }) => {
  const t = useT();
  const rank = useCurrentRank();
  // Cuándo se vio por primera vez: el fotograma siguiente al montaje.
  const [desde, setDesde] = useState<number | null>(null);
  useEffect(() => {
    const id = requestAnimationFrame(() => setDesde(performance.now()));
    return () => cancelAnimationFrame(id);
  }, []);
  const [saliendo, setSaliendo] = useState(false);
  const fuera = useRef(onGone);
  fuera.current = onGone;

  // Salir: el fundido y, al acabar, fuera del árbol.
  const salir = React.useCallback(() => {
    setSaliendo((s) => {
      if (!s) window.setTimeout(() => fuera.current(), SALIDA_MS);
      return true;
    });
  }, []);

  // Lista y con el mínimo cumplido; o el máximo, pase lo que pase.
  useEffect(() => {
    const max = window.setTimeout(salir, MAX_MS);
    if (!ready || desde === null) return () => window.clearTimeout(max);
    const resto = Math.max(0, MIN_MS - (performance.now() - desde));
    const min = window.setTimeout(salir, resto);
    return () => {
      window.clearTimeout(max);
      window.clearTimeout(min);
    };
  }, [ready, desde, salir]);

  // Cualquier tecla la salta.
  useEffect(() => {
    const onKey = () => salir();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [salir]);

  const rango = rank ? rankLabel(rank.tier, rank.division) : null;
  // «Diamond II» → «Diamante II»: la palabra se traduce, la división no.
  const rangoTxt = rango
    ? rango
        .split(" ")
        .map((w, i) => (i === 0 ? t(w) : w))
        .join(" ")
    : null;
  const estado = !ready
    ? t("Loading your games…")
    : games === 1
      ? t("1 game ready")
      : t("{n} games ready", { n: games });

  return (
    <div
      className="boot"
      data-out={saliendo || undefined}
      role="status"
      aria-live="polite"
      aria-label={t("Welcome back")}
      onClick={salir}
      data-tauri-drag-region
    >
      <div className="boot__card" data-tauri-drag-region>
        <BrandMark size={72} className="boot__mark" animated />
        <h1 className="boot__name">Wardline</h1>
        <p className="boot__hello">
          {t("Welcome back")}
          {rango && rank && (
            <span className="boot__rank">
              <img src={rankIcon(rank.tier)} alt="" aria-hidden="true" />
              {rangoTxt}
            </span>
          )}
        </p>
        <div className="boot__state">
          <span className="boot__bar" data-done={ready || undefined} aria-hidden="true" />
          <span className="boot__stateTxt">{estado}</span>
        </div>
      </div>
    </div>
  );
};
