import React from "react";

/**
 * La Grieta del Invocador: el minimapa del juego. Es el fondo del héroe de
 * Patrones.
 *
 * Antes era un SVG dibujado a mano (muros, río, calles, torres); se leía bien
 * pero no se parecía al juego, y el mapa que uno reconoce es el de la partida.
 * La imagen es la capa base del minimapa del cliente
 * (`assets/maps/info/map11/2dlevelminimap_base_baron1.png`, vía
 * CommunityDragon) y viaja en `public/` como los retratos: no depende de la red.
 * Se eligió esa y no la `map11.png` de Data Dragon porque trae los muros
 * transparentes: los rellena el fondo de `.pp-rift-wrap`, así el mapa se funde
 * con la tarjeta en vez de ser un cuadrado negro.
 *
 * Geometría: el contenedor mide 580 × 500 y el cuadrado del mapa (500) va
 * centrado, con 40 de aire a cada lado. Las coordenadas normalizadas son las de
 * Riot sobre `RIFT_W`/`RIFT_H`, que es lo que abarca la imagen (lo mismo que
 * hace el Recorrido del reproductor). Quien pinte encima convierte con
 * `riftPercent`.
 */

/** Posición en % del contenedor (580 × 500) de un punto del mapa normalizado. */
export const riftPercent = (u: number, v: number): { left: number; top: number } => ({
  left: ((40 + u * 500) / 580) * 100,
  top: (1 - v) * 100,
});

/** Ancho del cuadrado jugable en % del contenedor. */
export const RIFT_SQUARE_PCT = (500 / 580) * 100;

export const RiftMap: React.FC = () => (
  <img
    className="pp-rift-img"
    src="/map/rift.png"
    alt=""
    aria-hidden="true"
    draggable={false}
    style={{ left: `${(40 / 580) * 100}%`, width: `${RIFT_SQUARE_PCT}%` }}
  />
);
