// Iconografía y clasificación de los eventos de partida: de un `MatchEvent` a su icono, color,
// etiqueta y "tono" (lo bueno o malo que fue). Vive aparte de VideoPlayer porque es una unidad
// cerrada: los iconos y las tablas de color de aquí no los usa nadie más que `eventMeta`.

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

// Iconos eSports personalizados estilo badges metálicos con gradientes HSL
const IconKill: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ filter: "drop-shadow(0 0 4px rgba(16, 185, 129, 0.6))" }}>
    <circle cx="12" cy="12" r="10" fill="url(#killBg)" stroke="#34d399" strokeWidth="1.5" />
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6-3.8 3.8-1.4-1.4a1 1 0 0 0-1.4 0l-3.8 3.8L4.3 14a1 1 0 0 0-1.4 1.4l3.5 3.5a1 1 0 0 0 1.4 0l1.6-1.6 3.8-3.8 1.4 1.4a1 1 0 0 0 1.4 0l3.8-3.8 1.6 1.6a1 1 0 0 0 1.4-1.4l-3.5-3.5a1 1 0 0 0-1.4 0z" fill="#ffffff" />
    <defs>
      <linearGradient id="killBg" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
        <stop stopColor="#059669" />
        <stop offset="1" stopColor="#10b981" />
      </linearGradient>
    </defs>
  </svg>
);

const IconDeath: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ filter: "drop-shadow(0 0 4px rgba(239, 68, 68, 0.6))" }}>
    <circle cx="12" cy="12" r="10" fill="url(#deathBg)" stroke="#f87171" strokeWidth="1.5" />
    <path d="M12 4C8.13 4 5 7.13 5 11c0 2.38 1.19 4.47 3 5.74V18c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-1.26c1.81-1.27 3-3.36 3-5.74 0-3.87-3.13-7-7-7zm-2 15h4v1.5h-4V19z" fill="#ffffff" />
    <circle cx="9.5" cy="11.5" r="1.5" fill="#ef4444" />
    <circle cx="14.5" cy="11.5" r="1.5" fill="#ef4444" />
    <defs>
      <linearGradient id="deathBg" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
        <stop stopColor="#dc2626" />
        <stop offset="1" stopColor="#991b1b" />
      </linearGradient>
    </defs>
  </svg>
);

const IconAssist: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ filter: "drop-shadow(0 0 4px rgba(59, 130, 246, 0.6))" }}>
    <circle cx="12" cy="12" r="10" fill="url(#assistBg)" stroke="#60a5fa" strokeWidth="1.5" />
    <path d="M12 17s5-2.5 5-6.5V7l-5-2-5 2v3.5c0 4 5 6.5 5 6.5z" fill="#ffffff" />
    <path d="M10 11l1.5 1.5 3-3" stroke="#1d4ed8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    <defs>
      <linearGradient id="assistBg" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
        <stop stopColor="#2563eb" />
        <stop offset="1" stopColor="#1d4ed8" />
      </linearGradient>
    </defs>
  </svg>
);

const IconDragon: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ filter: "drop-shadow(0 0 4px rgba(245, 158, 11, 0.6))" }}>
    <circle cx="12" cy="12" r="10" fill="url(#dragonBg)" stroke="#fbbf24" strokeWidth="1.5" />
    <path d="M12 5L14 9.5L19 10.2L15.4 13.7L16.4 18.6L12 16L7.6 18.6L8.6 13.7L5 10.2L10 9.5L12 5Z" fill="#ffffff" />
    <defs>
      <linearGradient id="dragonBg" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
        <stop stopColor="#d97706" />
        <stop offset="1" stopColor="#b45309" />
      </linearGradient>
    </defs>
  </svg>
);

const IconBaron: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ filter: "drop-shadow(0 0 4px rgba(168, 85, 247, 0.6))" }}>
    <circle cx="12" cy="12" r="10" fill="url(#baronBg)" stroke="#c084fc" strokeWidth="1.5" />
    <path d="M6 14L4.5 6L9 9.5L12 5L15 9.5L19.5 6L18 14H6Z" fill="#ffffff" />
    <path d="M6 16.5H18V18H6V16.5Z" fill="#e9d5ff" />
    <defs>
      <linearGradient id="baronBg" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
        <stop stopColor="#9333ea" />
        <stop offset="1" stopColor="#6b21a8" />
      </linearGradient>
    </defs>
  </svg>
);

const IconTower: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ filter: "drop-shadow(0 0 4px rgba(6, 182, 212, 0.6))" }}>
    <circle cx="12" cy="12" r="10" fill="url(#towerBg)" stroke="#38bdf8" strokeWidth="1.5" />
    <path d="M7 18H17V16H16V9L17.5 7.5V5H14.5V6.5H13.5V5H10.5V6.5H9.5V5H6.5V7.5L8 9V16H7V18Z" fill="#ffffff" />
    <defs>
      <linearGradient id="towerBg" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
        <stop stopColor="#0891b2" />
        <stop offset="1" stopColor="#0e7490" />
      </linearGradient>
    </defs>
  </svg>
);

const ULT_COLOR = "#a855f7";
const MULTIKILL_COLOR = "#f59e0b";
const BARON_COLOR = "#a855f7";

const objTone = (s?: string): Tone => (s === "ally" ? "excellent" : s === "enemy" ? "mistake" : "neutral");
const structTone = (s?: string): Tone => (s === "ally" ? "mistake" : s === "enemy" ? "good" : "neutral");
const objColor = (s: string | undefined, base: string) => (s === "enemy" ? "#ef4444" : base);
const structColor = (s?: string) => (s === "ally" ? "#ef4444" : "#06b6d4");

export function eventMeta(ev: MatchEvent): EvMeta {
  const size = 18;
  switch (ev.type) {
    case "ChampionKill":
      if (ev.subtype === "kill")
        return { icon: <IconKill size={size} />, color: "#10b981", label: "Kill", tone: "good", category: "kills" };
      if (ev.subtype === "death")
        return { icon: <IconDeath size={size} />, color: "#ef4444", label: "Death", tone: "mistake", category: "deaths" };
      return { icon: <IconAssist size={size} />, color: "#3b82f6", label: "Assist", tone: "good", category: "assists" };
    case "Multikill":
      return { icon: <IconKill size={size} />, color: MULTIKILL_COLOR, label: "Multi Kill", tone: "excellent", category: "kills" };
    case "FirstBlood":
      return { icon: <IconKill size={size} />, color: "#10b981", label: "First Blood", tone: "excellent", category: "kills" };
    case "DragonKill":
      return { icon: <IconDragon size={size} />, color: objColor(ev.subtype, "#f59e0b"), label: "Dragon", tone: objTone(ev.subtype), category: "objectives" };
    case "BaronKill":
      return { icon: <IconBaron size={size} />, color: objColor(ev.subtype, BARON_COLOR), label: "Baron", tone: objTone(ev.subtype), category: "objectives" };
    case "HeraldKill":
      return { icon: <IconTower size={size} />, color: objColor(ev.subtype, "#06b6d4"), label: "Herald", tone: objTone(ev.subtype), category: "objectives" };
    case "TowerKill":
      return { icon: <IconTower size={size} />, color: structColor(ev.subtype), label: "Tower", tone: structTone(ev.subtype), category: "structures" };
    case "InhibKill":
      return { icon: <IconTower size={size} />, color: structColor(ev.subtype), label: "Inhibitor", tone: structTone(ev.subtype), category: "structures" };
    case "Ultimate":
      return { icon: <Sparkles size={size} color="#a855f7" />, color: ULT_COLOR, label: "Ultimate (R)", tone: "neutral", category: "abilities" };
    case "GameStart":
      return { icon: <Flag size={size} color="#94a3b8" />, color: "#94a3b8", label: "Game Start", tone: "neutral", category: "other" };
    case "GameEnd":
      return ev.subtype === "win"
        ? { icon: <Trophy size={size} color="#10b981" />, color: "#10b981", label: "Victory", tone: "excellent", category: "other" }
        : ev.subtype === "lose"
        ? { icon: <FlagOff size={size} color="#ef4444" />, color: "#ef4444", label: "Defeat", tone: "throw", category: "other" }
        : { icon: <Flag size={size} color="#94a3b8" />, color: "#94a3b8", label: "Game End", tone: "neutral", category: "other" };
    default:
      return { icon: <Sparkles size={size} color="#3b82f6" />, color: "#3b82f6", label: ev.type, tone: "neutral", category: "other" };
  }
}

export function toneLabelAndIcon(tone: Tone) {
  switch (tone) {
    case "excellent": return { text: "Excellent", color: "var(--accent-gold)", icon: <Sparkles size={12} fill="currentColor" /> };
    case "good": return { text: "Good", color: "var(--color-victory)", icon: <ThumbsUp size={12} fill="currentColor" /> };
    case "inaccuracy": return { text: "Inaccuracy", color: "var(--accent-gold)", icon: <AlertTriangle size={12} fill="currentColor" /> };
    case "mistake": return { text: "Mistake", color: "var(--accent-gold)", icon: <AlertTriangle size={12} fill="currentColor" /> }; // Ascent uses orange (!)
    case "throw": return { text: "Throw", color: "var(--color-death)", icon: <XCircle size={12} fill="currentColor" /> };
    default: return { text: "Info", color: "var(--text-muted)", icon: <div style={{width:8,height:8,borderRadius:4,background:"currentColor"}}/> };
  }
}
