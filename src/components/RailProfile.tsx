import React, { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { getAppConfig, platformLabel } from "../core/tauri-ipc";
import { rankIcon } from "../core/ddragon";
import { useT } from "../core/LanguageProvider";
import { useAppStore } from "../store/useAppStore";
import { useCurrentRank } from "../core/useCurrentRank";
import { normalizePosition, POSITION_LABEL, type Position } from "./PositionIcon";
import { BrandMark } from "./BrandMark";

/**
 * Tarjeta de perfil, al pie del rail: el rango es lo primero que un jugador de
 * LoL reconoce como suyo.
 *
 * Todo sale de lo que la app ya tiene, sin llamadas nuevas a Riot:
 *  - rango y LP: los de Riot en vivo (`useCurrentRank`, el mismo que usan Hoy
 *    y Patrones); sin conexión, los de la última partida grabada, con fecha;
 *  - puesto: el más jugado en las últimas 30 partidas propias con puesto;
 *  - región: la plataforma configurada, o la detectada si está en "auto".
 * Lo que falte simplemente no se pinta: nada de cifras inventadas.
 */

const TIERS = new Set([
  "IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND", "MASTER", "GRANDMASTER", "CHALLENGER",
]);
const APEX = new Set(["MASTER", "GRANDMASTER", "CHALLENGER"]);

export const RailProfile: React.FC<{ collapsed?: boolean }> = ({ collapsed }) => {
  const t = useT();
  const location = useLocation();
  const matches = useAppStore((s) => s.matches);
  const [region, setRegion] = useState<string | null>(null);

  // La región se relee al entrar y al salir de Ajustes, que es donde se cambia.
  const enAjustes = location.pathname.startsWith("/settings");
  useEffect(() => {
    let vivo = true;
    getAppConfig()
      .then((c) => {
        if (!vivo) return;
        const p = c.riot_platform === "auto" ? c.riot_platform_detected : c.riot_platform;
        setRegion(p ? platformLabel(p) : null);
      })
      .catch(() => {});
    return () => {
      vivo = false;
    };
  }, [enAjustes]);

  const rank = useCurrentRank();
  const tier = rank && TIERS.has(rank.tier) ? rank.tier : null;
  const division = tier ? rank!.division : null;
  const lp = tier ? rank!.lp : null;
  const { position } = useMemo(() => {
    const propias = matches
      .filter((m) => !m.is_vod)
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    const cuenta = new Map<Position, number>();
    for (const m of propias.slice(0, 30)) {
      const yo = m.participants?.find((p) => p.is_self);
      const pos = normalizePosition(yo?.role);
      if (pos) cuenta.set(pos, (cuenta.get(pos) ?? 0) + 1);
    }
    let mas: Position | null = null;
    cuenta.forEach((n, pos) => {
      if (mas === null || n > (cuenta.get(mas) ?? 0)) mas = pos;
    });
    return { position: mas as Position | null };
  }, [matches]);

  // "EMERALD" + "II" → "Esmeralda II", con el nombre del rango traducido (la
  // clave es el inglés: "Emerald"). En Maestro y por encima no hay división.
  const rango = tier
    ? (() => {
        const nombre = t(tier.charAt(0) + tier.slice(1).toLowerCase());
        return APEX.has(tier) || !division ? nombre : `${nombre} ${division}`;
      })()
    : null;
  const meta = [
    lp != null ? t("{n} LP", { n: lp }) : null,
    position ? t(POSITION_LABEL[position]) : null,
    region,
  ].filter(Boolean) as string[];
  const titulo = [rango ?? t("Unranked"), ...meta].join(" · ");
  // Si no es en vivo, se dice de cuándo es: puede haber partidas sin grabar
  // entre medias.
  const origen = rank && !rank.live && rank.date
    ? t("Rank from your last recorded game ({date})", { date: rank.date.slice(0, 10) })
    : rank?.live
      ? t("Current rank, from Riot")
      : undefined;

  return (
    <div className="rail-profile" title={collapsed ? [titulo, origen].filter(Boolean).join(" — ") : origen} aria-label={titulo} role="group">
      {tier ? (
        <img className="rail-profile__emblem" src={rankIcon(tier)} alt="" aria-hidden="true" />
      ) : (
        <span className="rail-profile__emblem rail-profile__emblem--none" aria-hidden="true">
          <BrandMark size={16} />
        </span>
      )}
      <div className="rail-profile__text" aria-hidden={collapsed ? true : undefined}>
        <span className="rail-profile__rank">{rango ?? t("Unranked")}</span>
        {meta.length > 0 && <span className="rail-profile__meta">{meta.join(" · ")}</span>}
      </div>
    </div>
  );
};
