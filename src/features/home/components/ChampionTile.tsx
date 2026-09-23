import React, { useEffect, useState } from "react";
import { champIcon, useChampionIcon } from "../../../core/ddragon";
import { championInitials } from "../../../core/matchStats";

/**
 * Retrato cuadrado de radio suave, como los de la tira de historial del
 * cliente. Misma cadena de carga que `ChampionAvatar` (fichero local primero,
 * CDN solo si falta, iniciales si todo falla); lo que cambia es la forma.
 */
export const ChampionTile: React.FC<{
  champion: string;
  size: number;
  radius?: number;
  /** Ocupa el ancho de su celda (hasta `size`) y se queda cuadrado. */
  fluid?: boolean;
}> = ({ champion, size, radius = 8, fluid = false }) => {
  const [sinLocal, setSinLocal] = useState(false);
  const remoto = useChampionIcon(champion, sinLocal);
  const url = sinLocal ? remoto : champIcon(champion);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setSinLocal(false);
    setFailed(false);
  }, [champion]);
  useEffect(() => setFailed(false), [url]);

  return (
    <span
      className="home-tile"
      style={{
        width: fluid ? "100%" : size,
        maxWidth: size,
        height: fluid ? "auto" : size,
        aspectRatio: "1 / 1",
        borderRadius: radius,
        fontSize: Math.round(size * 0.34),
      }}
    >
      {url && !failed ? (
        <img
          src={url}
          alt={champion}
          onError={() => (sinLocal ? setFailed(true) : setSinLocal(true))}
        />
      ) : (
        championInitials(champion)
      )}
    </span>
  );
};
