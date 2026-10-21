import { useCallback, useEffect, useState } from "react";
import { abandonCoachPlan, getCoachPlan, startCoachPlan, type CoachCategory, type CoachPlanState } from "./tauri-ipc";
import { useAppStore } from "../store/useAppStore";

/**
 * El plan de 10 partidas del coach (`coach_plan.rs`): el que está en curso, los
 * acabados y el foco que se propone.
 *
 * Como `useCoachSummary`, se vuelve a pedir cada vez que la biblioteca se
 * refresca: el backend mete cada partida sincronizada en el plan antes de
 * avisar de que está lista, así que el refresco ya la trae. `plan` es
 * `undefined` mientras carga y `null` si falló; `error` es la clave del último
 * fallo al empezar o abandonar (`CoachPlanError`, o el texto de un fallo de
 * disco).
 */
export function useCoachPlan(): {
  plan: CoachPlanState | null | undefined;
  busy: boolean;
  error: string | null;
  start: (category?: CoachCategory, tramo?: number) => Promise<void>;
  abandon: () => Promise<void>;
} {
  const matches = useAppStore((s) => s.matches);
  const [plan, setPlan] = useState<CoachPlanState | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    getCoachPlan()
      .then((d) => vivo && setPlan(d))
      .catch(() => vivo && setPlan(null));
    return () => {
      vivo = false;
    };
  }, [matches]);

  const run = useCallback(async (accion: () => Promise<CoachPlanState>) => {
    setBusy(true);
    setError(null);
    try {
      setPlan(await accion());
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const start = useCallback(
    (category?: CoachCategory, tramo?: number) => run(() => startCoachPlan(category, tramo)),
    [run]
  );
  const abandon = useCallback(() => run(abandonCoachPlan), [run]);

  return { plan, busy, error, start, abandon };
}
