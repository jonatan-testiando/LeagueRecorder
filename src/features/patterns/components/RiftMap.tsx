import React, { useId } from "react";
import { useT } from "../../../core/LanguageProvider";

/**
 * La Grieta del Invocador, dibujada: suelo, muros de jungla, río, calles,
 * bases, torres y fosos. Es el fondo del héroe de Patrones.
 *
 * Dibujada y no la imagen de Data Dragon por tres motivos: se lee a cualquier
 * tamaño (el héroe la estira a 580 px y la imagen es de 512), no depende de la
 * red, y sigue los tokens — en el tema claro es papel, no un agujero negro.
 *
 * Geometría: el cuadrado jugable mide 500 unidades y empieza en x = 0; el
 * viewBox arranca en −40 para dejar 40 de aire a cada lado (580 × 500). Los
 * fosos caen donde caen en el juego: Barón en (5007, 10471) → (169, 148) y
 * Dragón en (9866, 4414) → (333, 352). Quien pinte encima convierte con
 * `riftPercent`.
 */

/** Posición en % del contenedor (580 × 500) de un punto del mapa normalizado. */
export const riftPercent = (u: number, v: number): { left: number; top: number } => ({
  left: ((40 + u * 500) / 580) * 100,
  top: (1 - v) * 100,
});

/** Ancho del cuadrado jugable en % del contenedor. */
export const RIFT_SQUARE_PCT = (500 / 580) * 100;

const MUROS: [number, number, number, number, number][] = [
  [100, 190, 24, 11, 60], [128, 262, 30, 12, -45], [92, 318, 18, 10, 30],
  [238, 372, 30, 12, -45], [310, 408, 24, 11, 30], [182, 410, 18, 10, 60],
  [400, 310, 24, 11, 60], [372, 238, 30, 12, -45], [408, 182, 18, 10, 30],
  [262, 128, 30, 12, -45], [190, 92, 24, 11, 30], [318, 90, 18, 10, 60],
];

const TORRES: [number, number][] = [
  [46, 140], [46, 250], [46, 350], [205, 295], [160, 340], [118, 382],
  [360, 454], [250, 454], [150, 454], [454, 360], [454, 250], [454, 150],
  [295, 205], [340, 160], [382, 118], [140, 46], [250, 46], [350, 46],
];

const RIO = "M -40 -40 C 90 70, 170 175, 250 250 C 330 325, 410 430, 540 540";
/** El cuadrado jugable, con las esquinas redondeadas. */
const CUADRADO = "M 54 16 H 446 Q 484 16 484 54 V 446 Q 484 484 446 484 H 54 Q 16 484 16 446 V 54 Q 16 16 54 16 Z";

export const RiftMap: React.FC = () => {
  const t = useT();
  // El río y las bases se recortan al cuadrado: si no, su trazo llega al canto
  // del SVG y el antialias deja un filo azul donde el mapa se funde con el suelo.
  const clip = `pp-rift-sq-${useId().replace(/:/g, "")}`;
  return (
    <svg className="pp-rift-svg" viewBox="-40 0 580 500" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <clipPath id={clip}>
          <path d={CUADRADO} />
        </clipPath>
      </defs>
      <rect x="-40" y="0" width="580" height="500" fill="var(--rift-wall)" />
      <path d={CUADRADO} fill="var(--rift-ground)" />
      <g clipPath={`url(#${clip})`}>
        <g fill="var(--rift-wall)" fillOpacity="0.85">
          {MUROS.map(([cx, cy, rx, ry, rot], i) => (
            <ellipse key={i} cx={cx} cy={cy} rx={rx} ry={ry} transform={`rotate(${rot} ${cx} ${cy})`} />
          ))}
        </g>
        {/* Río: de arriba a la izquierda a abajo a la derecha. */}
        <path d={RIO} fill="none" stroke="var(--rift-river)" strokeWidth="70" />
        <path d={RIO} fill="none" stroke="var(--rift-river-core)" strokeWidth="30" strokeOpacity="0.45" />
        {/* Calles */}
        <g fill="none" stroke="var(--text)" strokeOpacity="0.07" strokeWidth="24" strokeLinecap="round" strokeLinejoin="round">
          <path d="M 46 400 L 46 92 Q 46 46 92 46 L 408 46" />
          <path d="M 100 400 L 400 100" />
          <path d="M 88 454 L 412 454 Q 454 454 454 412 L 454 100" />
        </g>
        {/* Bases: azul abajo a la izquierda, roja arriba a la derecha. */}
        <path d="M 0 355 A 145 145 0 0 1 145 500 L 0 500 Z" fill="var(--rift-blue)" fillOpacity="0.1" />
        <path d="M 0 355 A 145 145 0 0 1 145 500" fill="none" stroke="var(--rift-blue)" strokeOpacity="0.3" strokeWidth="1.5" />
        <path d="M 500 145 A 145 145 0 0 1 355 0 L 500 0 Z" fill="var(--signal)" fillOpacity="0.06" />
        <path d="M 500 145 A 145 145 0 0 1 355 0" fill="none" stroke="var(--signal)" strokeOpacity="0.22" strokeWidth="1.5" />
      </g>
      {/* El canto del cuadrado jugable; fuera, el suelo de la tarjeta. */}
      <path fill="none" stroke="var(--text)" strokeOpacity="0.08" d={CUADRADO} />
      {/* Nexos */}
      <rect x="-8" y="-8" width="16" height="16" rx="3" transform="translate(60 440) rotate(45)"
        fill="var(--rift-blue)" fillOpacity="0.22" stroke="var(--rift-blue)" strokeOpacity="0.55" strokeWidth="1.5" />
      <rect x="-8" y="-8" width="16" height="16" rx="3" transform="translate(440 60) rotate(45)"
        fill="var(--signal)" fillOpacity="0.1" stroke="var(--signal)" strokeOpacity="0.35" strokeWidth="1.5" />
      {/* Torres */}
      <g fill="var(--rift-ground)" stroke="var(--text)" strokeOpacity="0.4" strokeWidth="1.5">
        {TORRES.map(([cx, cy], i) => <circle key={i} cx={cx} cy={cy} r="3.5" />)}
      </g>
      {/* Foso del Barón */}
      <circle cx="168" cy="146" r="19" fill="var(--rift-pit)" stroke="var(--text)" strokeOpacity="0.2" strokeWidth="1.5" />
      <g transform="translate(160 138) scale(0.6667)" fill="none" stroke="var(--muted)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 20v-6a5 5 0 0 1 10 0v6" /><path d="M8.5 9.5 6 4" /><path d="m15.5 9.5 2.5-5.5" />
        <path d="M10 14h.01" /><path d="M14 14h.01" />
      </g>
      <text x="168" y="113" textAnchor="middle" fontSize="13" fill="var(--faint)">{t("Baron")}</text>
      {/* Foso del Dragón */}
      <circle cx="332" cy="354" r="19" fill="var(--rift-pit)" stroke="var(--text)" strokeOpacity="0.2" strokeWidth="1.5" />
      <g transform="translate(324 346) scale(0.6667)" fill="none" stroke="var(--muted)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
      </g>
      <text x="332" y="395" textAnchor="middle" fontSize="13" fill="var(--faint)">{t("Dragon")}</text>
    </svg>
  );
};
