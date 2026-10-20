import { useEffect, useState } from "react";
import { getCoachSummary, type CoachSummary } from "./tauri-ipc";
import { useAppStore } from "../store/useAppStore";

/**
 * El resumen del coach (`coach.rs`): categorías, tramos y foco sobre todas tus
 * partidas.
 *
 * Se vuelve a pedir cada vez que la biblioteca se refresca, porque es cuando
 * puede haber partidas nuevas o recién sincronizadas; el backend cachea por
 * partida, así que repetir es barato. `undefined` mientras carga y `null` si
 * falló: «cargando» y «no hay foco» no se pueden pintar igual.
 */
export function useCoachSummary(): CoachSummary | null | undefined {
  const matches = useAppStore((s) => s.matches);
  const [data, setData] = useState<CoachSummary | null | undefined>(undefined);

  useEffect(() => {
    let vivo = true;
    getCoachSummary()
      .then((d) => vivo && setData(d))
      .catch(() => vivo && setData(null));
    return () => {
      vivo = false;
    };
  }, [matches]);

  return data;
}
