import { useCallback, useEffect } from "react";
import { getAppConfig, setAppConfig } from "../../core/tauri-ipc";
import { useAppStore } from "../../store/useAppStore";

/**
 * Estado del asistente de primer arranque.
 *
 * La bandera vive en la config del disco (`onboarding_done`), así que
 * sobrevive a cerrar la app, y se cachea en el store para que la lea cualquier
 * pantalla sin volver a preguntar al backend.
 *
 * `restart()` es el gancho para Ajustes: pone la bandera a false y el asistente
 * vuelve a aparecer encima de la app, con lo que ya está configurado dentro (no
 * es un reset, es un repaso).
 */
export interface OnboardingState {
  /** `null` mientras la config no ha llegado del disco. */
  done: boolean | null;
  loading: boolean;
  /** Lo da por terminado y lo guarda. */
  finish: () => Promise<void>;
  /** Lo vuelve a lanzar. Pensado para el botón de Ajustes. */
  restart: () => Promise<void>;
}

export function useOnboarding(): OnboardingState {
  const done = useAppStore((s) => s.onboardingDone);
  const setDone = useAppStore((s) => s.setOnboardingDone);

  useEffect(() => {
    if (useAppStore.getState().onboardingDone !== null) return;
    let vivo = true;
    getAppConfig()
      .then((c) => { if (vivo) setDone(c.onboarding_done === true); })
      // Si la config no se puede leer NO se enseña el asistente: taparle la app
      // a alguien que ya la tenía configurada por un fallo de lectura es peor
      // que saltarse el asistente en el primer arranque.
      .catch(() => { if (vivo) setDone(true); });
    return () => { vivo = false; };
  }, [setDone]);

  const finish = useCallback(async () => {
    setDone(true);
    await setAppConfig({ onboarding_done: true }).catch(console.error);
  }, [setDone]);

  const restart = useCallback(async () => {
    setDone(false);
    await setAppConfig({ onboarding_done: false }).catch(console.error);
  }, [setDone]);

  return { done, loading: done === null, finish, restart };
}
