// Iconografía y clasificación de los eventos de partida: de un `MatchEvent` a su icono, color,
// etiqueta y "tono" (lo bueno o malo que fue). Vive aparte de VideoPlayer porque es una unidad
// cerrada. Los glifos se exportan para la tabla de objetivos del inspector, que habla el mismo
// vocabulario (dragón, barón, heraldo, torre) que la línea de tiempo.
//
// Los iconos son de trazo y heredan `currentColor`, con el mismo grosor que los de lucide para
// que unos y otros pesen igual cuando aparecen juntos. Antes eran insignias con degradados y
// `drop-shadow` de neón: eso los ataba a una paleta fija (57 colores escritos a mano en este
// archivo) y era el detalle que más abarataba el reproductor.

import React, { useEffect, useState } from "react";
import { MatchEvent } from "../../../types";
import { champIcon } from "../../../core/ddragon";
import { Sparkles, Flag, Trophy, FlagOff, AlertTriangle, ThumbsUp, XCircle } from "lucide-react";

export type Tone = "excellent" | "good" | "inaccuracy" | "mistake" | "throw" | "neutral";
export interface EvMeta {
  icon: React.ReactNode;
  color: string;
  label: string;
  tone: Tone;
  category: "kills" | "deaths" | "assists" | "objectives" | "structures" | "abilities" | "other";
}

// Glifos propios (laboratorio del sistema de diseño, «Glifo propio»): dibujados
// para el juego en una caja de 16, trazo de 1,5 y algún relleno para que
// aguanten a 11-12 px, que es lo que miden dentro de una chapa de la línea de
// tiempo.
const GlyphBase: React.FC<{ size: number; children: React.ReactNode }> = ({ size, children }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

/** Espadas cruzadas. */
export const IconKill: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <GlyphBase size={size}>
    <path d="M3 13 13 3M10.5 3H13v2.5M3 3l10 10M5.5 13H3v-2.5" />
  </GlyphBase>
);

/** Calavera. */
export const IconDeath: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <GlyphBase size={size}>
    <path d="M8 2.5a5 5 0 0 0-5 5c0 1.6.8 2.8 2 3.5V13.5h6V11c1.2-.7 2-1.9 2-3.5a5 5 0 0 0-5-5Z" />
    <circle cx="6" cy="8" r="1" fill="currentColor" stroke="none" />
    <circle cx="10" cy="8" r="1" fill="currentColor" stroke="none" />
  </GlyphBase>
);

/** Círculo con cruz: participaste sin rematar. */
export const IconAssist: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <GlyphBase size={size}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5v6M5 8h6" />
  </GlyphBase>
);

/** Ala de dragón. */
export const IconDragon: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <GlyphBase size={size}>
    <path d="M2 12 8 3l6 9-3-1.8L8 13l-3-2.8Z" />
  </GlyphBase>
);

/** Fauces del barón. */
export const IconBaron: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <GlyphBase size={size}>
    <path d="M3.5 14V8a4.5 4.5 0 0 1 9 0v6" />
    <path d="M5.5 4.5 4.5 2M8 3.5V1.5M10.5 4.5l1-2.5" />
    <circle cx="8" cy="8.5" r="1.2" fill="currentColor" stroke="none" />
  </GlyphBase>
);

/** Torreta. */
export const IconTower: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <GlyphBase size={size}>
    <path d="M5 14V7h6v7M4 7h8M6 7V4h4v3" />
    <circle cx="8" cy="2.5" r="1" fill="currentColor" stroke="none" />
  </GlyphBase>
);

/** Inhibidor: el cristal. Compartía la torreta. */
export const IconInhib: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <GlyphBase size={size}>
    <path d="M8 1.5 12.5 8 8 14.5 3.5 8Z" />
    <path d="M8 5v6" />
  </GlyphBase>
);

/** Heraldo: el ojo. Compartía la torreta, y en la línea de tiempo un heraldo
 *  y una torre caídos al lado eran la misma marca. */
export const IconHerald: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <GlyphBase size={size}>
    <path d="M1.8 8C4 4.3 12 4.3 14.2 8 12 11.7 4 11.7 1.8 8Z" />
    <circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none" />
  </GlyphBase>
);

/** Definitiva (R): el destello. */
export const IconUltimate: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <GlyphBase size={size}>
    <path d="M8 1.8 9.4 6.6 14.2 8 9.4 9.4 8 14.2 6.6 9.4 1.8 8 6.6 6.6Z" />
  </GlyphBase>
);

/** Rombo: hallazgo del analizador. Es la única forma que no es un círculo en
 *  la línea de tiempo, así que se distingue sin depender solo del violeta. */
export const IconFinding: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M8 2 14 8 8 14 2 8Z"
      fill="color-mix(in srgb, currentColor 30%, transparent)"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinejoin="round"
    />
  </svg>
);

// Un tinte por trabajo. Los objetivos (dragón, barón, heraldo) comparten el oro
// a propósito: son la misma categoría de suceso y se distinguen por el glifo.
// El violeta es SOLO del analizador (hallazgos): las definitivas lo usaban y en
// la línea de tiempo se confundían con un hallazgo.
const C_ALLY = "var(--win)";
const C_ENEMY = "var(--loss)";
const C_OBJECTIVE = "var(--brand)";
const C_STRUCTURE = "var(--cool)";
const C_ABILITY = "var(--muted)";
const C_NEUTRAL = "var(--faint)";

const objTone = (s?: string): Tone => (s === "ally" ? "excellent" : s === "enemy" ? "mistake" : "neutral");
const structTone = (s?: string): Tone => (s === "ally" ? "mistake" : s === "enemy" ? "good" : "neutral");
const objColor = (s: string | undefined, base: string) => (s === "enemy" ? C_ENEMY : base);
const structColor = (s?: string) => (s === "ally" ? C_ENEMY : C_STRUCTURE);

/** `iconSize` lo fija quien pinta: la línea de tiempo usa marcadores más pequeños. */
export function eventMeta(ev: MatchEvent, iconSize: number = 18): EvMeta {
  const size = iconSize;
  switch (ev.type) {
    case "ChampionKill":
      if (ev.subtype === "kill")
        return { icon: <IconKill size={size} />, color: C_ALLY, label: "Kill", tone: "good", category: "kills" };
      if (ev.subtype === "death")
        return { icon: <IconDeath size={size} />, color: C_ENEMY, label: "Death", tone: "mistake", category: "deaths" };
      return { icon: <IconAssist size={size} />, color: C_ALLY, label: "Assist", tone: "good", category: "assists" };
    case "Multikill":
      return { icon: <IconKill size={size} />, color: C_OBJECTIVE, label: "Multi Kill", tone: "excellent", category: "kills" };
    case "FirstBlood":
      return { icon: <IconKill size={size} />, color: C_ALLY, label: "First Blood", tone: "excellent", category: "kills" };
    case "DragonKill":
      return { icon: <IconDragon size={size} />, color: objColor(ev.subtype, C_OBJECTIVE), label: "Dragon", tone: objTone(ev.subtype), category: "objectives" };
    case "BaronKill":
      return { icon: <IconBaron size={size} />, color: objColor(ev.subtype, C_OBJECTIVE), label: "Baron", tone: objTone(ev.subtype), category: "objectives" };
    case "HeraldKill":
      return { icon: <IconHerald size={size} />, color: objColor(ev.subtype, C_OBJECTIVE), label: "Herald", tone: objTone(ev.subtype), category: "objectives" };
    case "TowerKill":
      return { icon: <IconTower size={size} />, color: structColor(ev.subtype), label: "Tower", tone: structTone(ev.subtype), category: "structures" };
    case "InhibKill":
      return { icon: <IconInhib size={size} />, color: structColor(ev.subtype), label: "Inhibitor", tone: structTone(ev.subtype), category: "structures" };
    case "Ultimate":
      return { icon: <IconUltimate size={size} />, color: C_ABILITY, label: "Ultimate (R)", tone: "neutral", category: "abilities" };
    case "GameStart":
      return { icon: <Flag size={size} />, color: C_NEUTRAL, label: "Game Start", tone: "neutral", category: "other" };
    case "GameEnd":
      return ev.subtype === "win"
        ? { icon: <Trophy size={size} />, color: C_ALLY, label: "Victory", tone: "excellent", category: "other" }
        : ev.subtype === "lose"
        ? { icon: <FlagOff size={size} />, color: C_ENEMY, label: "Defeat", tone: "throw", category: "other" }
        : { icon: <Flag size={size} />, color: C_NEUTRAL, label: "Game End", tone: "neutral", category: "other" };
    default:
      return { icon: <Sparkles size={size} />, color: C_NEUTRAL, label: ev.type, tone: "neutral", category: "other" };
  }
}

/**
 * Marca de la línea de tiempo (Figma, Componentes · «Marca de línea de
 * tiempo»): una forma de 8-10 px por TIPO y un tinte por trabajo. Sustituye a
 * los retratos de 20 px, que se pisaban en cualquier pelea; el retrato sale
 * ahora en la etiqueta al pasar por encima.
 *
 * - `dot`: círculo lleno, suceso de combate (kill, muerte).
 * - `ring`: círculo hueco, asistencia: participaste sin rematar.
 * - `diamond`: rombo, objetivo o estructura (y, en violeta, hallazgo).
 * - `pip`: punto pequeño, lo que no es ni combate ni objetivo (definitivas).
 *
 * El tono sale del mismo color que `eventMeta`, para que la marca y la fila
 * de la lista digan lo mismo.
 */
export type MarkTone = "win" | "loss" | "brand" | "flag" | "neutral";
export type MarkShape = "dot" | "ring" | "diamond" | "pip";

const toneOfColor = (color: string): MarkTone =>
  color === C_ALLY || color === C_STRUCTURE
    ? "win"
    : color === C_ENEMY
      ? "loss"
      : color === C_OBJECTIVE
        ? "brand"
        : "neutral";

export function markOf(ev: MatchEvent): { shape: MarkShape; tone: MarkTone } {
  const meta = eventMeta(ev, 12);
  const tone = toneOfColor(meta.color);
  switch (meta.category) {
    case "objectives":
    case "structures":
      return { shape: "diamond", tone };
    case "assists":
      return { shape: "ring", tone };
    case "kills":
    case "deaths":
      return { shape: "dot", tone };
    default:
      return { shape: "pip", tone };
  }
}

/**
 * `text` es la cadena inglesa, que es la clave de i18n: quien la pinta la pasa
 * por `t()`. Se quedo sin traducir hasta que se vio en pantalla — una columna
 * de palabras en ingles en una interfaz en espanol.
 *
 * El oro ya no es de ningún tono: es la acción de la pantalla. Un «Error» en
 * oro se leía como un botón; ahora lo malo es rojo y lo bueno jade, como en la
 * línea de tiempo.
 */
export function toneLabelAndIcon(tone: Tone) {
  switch (tone) {
    case "excellent": return { text: "Excellent", color: "var(--win)", icon: <Sparkles size={12} fill="currentColor" /> };
    case "good": return { text: "Good", color: "var(--win)", icon: <ThumbsUp size={12} fill="currentColor" /> };
    case "inaccuracy": return { text: "Inaccuracy", color: "var(--muted)", icon: <AlertTriangle size={12} fill="currentColor" /> };
    case "mistake": return { text: "Mistake", color: "var(--loss)", icon: <AlertTriangle size={12} fill="currentColor" /> };
    case "throw": return { text: "Throw", color: "var(--loss)", icon: <XCircle size={12} fill="currentColor" /> };
    default: return { text: "Info", color: "var(--faint)", icon: <div style={{width:8,height:8,borderRadius:4,background:"currentColor"}}/> };
  }
}

/**
 * Retrato de un campeón para las marcas de la línea de tiempo, con la vuelta al
 * icono si el fichero no está. Los 174 retratos viajan con la app
 * (`public/champions`), así que casi nunca falla; cuando falla (un campeón
 * nuevo, un nombre raro) se ve el glifo del suceso y no un hueco.
 */
export const ChampFace: React.FC<{
  champion: string;
  size: number;
  fallback: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}> = ({ champion, size, fallback, style, className }) => {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [champion]);
  if (failed) return <>{fallback}</>;
  return (
    <img
      src={champIcon(champion)}
      alt=""
      width={size}
      height={size}
      className={className}
      style={style}
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
};
