// Iconografía y clasificación de los eventos de partida: de un `MatchEvent` a su icono, color,
// etiqueta y "tono" (lo bueno o malo que fue). Vive aparte de VideoPlayer porque es una unidad
// cerrada: los iconos y las tablas de color de aquí no los usa nadie más que `eventMeta`.
//
// Los iconos son de trazo y heredan `currentColor`, con el mismo grosor que los de lucide para
// que unos y otros pesen igual cuando aparecen juntos. Antes eran insignias con degradados y
// `drop-shadow` de neón: eso los ataba a una paleta fija (57 colores escritos a mano en este
// archivo) y era el detalle que más abarataba el reproductor.

import React from "react";
import { MatchEvent } from "../../../types";
import { Sparkles, Flag, Trophy, FlagOff, AlertTriangle, ThumbsUp, XCircle } from "lucide-react";

export type Tone = "excellent" | "good" | "inaccuracy" | "mistake" | "throw" | "neutral";
export interface EvMeta {
  icon: React.ReactNode;
  color: string;
  label: string;
  tone: Tone;
  category: "kills" | "deaths" | "assists" | "objectives" | "structures" | "abilities" | "other";
}

const GlyphBase: React.FC<{ size: number; children: React.ReactNode }> = ({ size, children }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

/** Espadas cruzadas. */
const IconKill: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <GlyphBase size={size}>
    <path d="M4.5 4.5h3l9.5 9.5M19.5 4.5h-3L7 14" />
    <path d="M5 17l2 2M19 17l-2 2" />
    <path d="M4 19.5l3-3M20 19.5l-3-3" />
  </GlyphBase>
);

/** Calavera. */
const IconDeath: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <GlyphBase size={size}>
    <path d="M12 3.5c-4.1 0-7 2.9-7 6.8 0 2.2 1 3.9 2.4 5v2.2c0 .6.4 1 1 1h7.2c.6 0 1-.4 1-1V15.3c1.4-1.1 2.4-2.8 2.4-5 0-3.9-2.9-6.8-7-6.8Z" />
    <circle cx="9.4" cy="10.6" r="1.4" />
    <circle cx="14.6" cy="10.6" r="1.4" />
    <path d="M10.5 18.5v2M13.5 18.5v2" />
  </GlyphBase>
);

/** Escudo con visto: participaste sin rematar. */
const IconAssist: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <GlyphBase size={size}>
    <path d="M12 3.5 5.5 6v5.2c0 4 2.8 7 6.5 8.8 3.7-1.8 6.5-4.8 6.5-8.8V6L12 3.5Z" />
    <path d="m9.3 11.6 1.9 1.9 3.6-3.7" />
  </GlyphBase>
);

/** Ala de dragón. */
const IconDragon: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <GlyphBase size={size}>
    <path d="M3 8.5c3.5-.4 6 .6 7.6 2.4L12 4l1.4 6.9C15 9.1 17.5 8.1 21 8.5c-1.6 2.6-2.9 4.4-4.8 5.6l1.5 5.4-5.7-3.2-5.7 3.2 1.5-5.4C5.9 12.9 4.6 11.1 3 8.5Z" />
  </GlyphBase>
);

/** Fauces del barón. */
const IconBaron: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <GlyphBase size={size}>
    <path d="M4 5.5 6.5 11 12 4.5 17.5 11 20 5.5 18.2 15H5.8L4 5.5Z" />
    <path d="M6.2 17.5h11.6" />
    <path d="M9 15v2.5M12 15v2.5M15 15v2.5" />
  </GlyphBase>
);

/** Torreta. */
const IconTower: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <GlyphBase size={size}>
    <path d="M8 4.5v2.2M12 4.5v2.2M16 4.5v2.2" />
    <path d="M7 4.5h10v2.5l-1.5 1.6V16h-7V8.6L7 7V4.5Z" />
    <path d="M6.5 19.5h11v-2.2h-11v2.2Z" />
  </GlyphBase>
);

// Un tinte por trabajo. Los objetivos (dragón, barón, heraldo) comparten el oro
// a propósito: son la misma categoría de suceso y se distinguen por el glifo.
const C_ALLY = "var(--color-victory)";
const C_ENEMY = "var(--color-defeat)";
const C_OBJECTIVE = "var(--color-objective)";
const C_STRUCTURE = "var(--accent-blue)";
const C_ABILITY = "var(--flag)";
const C_NEUTRAL = "var(--text-muted)";

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
      return { icon: <IconTower size={size} />, color: objColor(ev.subtype, C_OBJECTIVE), label: "Herald", tone: objTone(ev.subtype), category: "objectives" };
    case "TowerKill":
      return { icon: <IconTower size={size} />, color: structColor(ev.subtype), label: "Tower", tone: structTone(ev.subtype), category: "structures" };
    case "InhibKill":
      return { icon: <IconTower size={size} />, color: structColor(ev.subtype), label: "Inhibitor", tone: structTone(ev.subtype), category: "structures" };
    case "Ultimate":
      return { icon: <Sparkles size={size} />, color: C_ABILITY, label: "Ultimate (R)", tone: "neutral", category: "abilities" };
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
 * `text` es la cadena inglesa, que es la clave de i18n: quien la pinta la pasa
 * por `t()`. Se quedo sin traducir hasta que se vio en pantalla — una columna
 * de palabras en ingles en una interfaz en espanol.
 */
export function toneLabelAndIcon(tone: Tone) {
  switch (tone) {
    case "excellent": return { text: "Excellent", color: "var(--accent-gold)", icon: <Sparkles size={12} fill="currentColor" /> };
    case "good": return { text: "Good", color: "var(--color-victory)", icon: <ThumbsUp size={12} fill="currentColor" /> };
    case "inaccuracy": return { text: "Inaccuracy", color: "var(--accent-gold)", icon: <AlertTriangle size={12} fill="currentColor" /> };
    case "mistake": return { text: "Mistake", color: "var(--accent-gold)", icon: <AlertTriangle size={12} fill="currentColor" /> };
    case "throw": return { text: "Throw", color: "var(--color-death)", icon: <XCircle size={12} fill="currentColor" /> };
    default: return { text: "Info", color: "var(--text-muted)", icon: <div style={{width:8,height:8,borderRadius:4,background:"currentColor"}}/> };
  }
}
