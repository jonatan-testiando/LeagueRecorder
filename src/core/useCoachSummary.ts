import { useEffect, useState } from "react";
import { getCoachSummary, type CoachSummary } from "./tauri-ipc";
import { useLibraryKey } from "../store/useAppStore";

/**
 * El resumen del coach (`coach.rs`): categorías, tramos y foco sobre todas tus
 * partidas.
 *
 * Se vuelve a pedir cuando cambia la firma de la biblioteca (partidas nuevas,
 * borradas o recién sincronizadas), no en cada refresco que trae lo mismo: cada
 * petición recorre la biblioteca entera en el backend. `undefined` mientras carga y `null` si
 * falló: «cargando» y «no hay foco» no se pueden pintar igual.
 */
export function useCoachSummary(): CoachSummary | null | undefined {
  const biblioteca = useLibraryKey();
  const [data, setData] = useState<CoachSummary | null | undefined>(undefined);

  useEffect(() => {
    if (biblioteca === null) return;
    let vivo = true;
    getCoachSummary()
      .then((d) => vivo && setData(d))
      .catch(() => vivo && setData(null));
    return () => {
      vivo = false;
    };
  }, [biblioteca]);

  return data;
}
