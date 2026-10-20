import { useEffect, useRef, useState } from "react";

/**
 * Cuándo enseñar el esqueleto de una carga.
 *
 * Devuelve true solo si la carga pasa de `delay` ms (por debajo, un esqueleto
 * que aparece y se va en un parpadeo molesta más que el hueco), y una vez
 * visible lo mantiene al menos `minVisible` ms aunque los datos lleguen antes:
 * así no destella. Quien lo usa pinta tres estados distintos: mientras
 * `loading` sea true NUNCA el vacío; el esqueleto cuando esto diga true; y los
 * datos (o el vacío de verdad) cuando la carga acabe y esto vuelva a false.
 */
export function useDelayedLoading(loading: boolean, delay = 150, minVisible = 300): boolean {
  const [visible, setVisible] = useState(false);
  const shownAt = useRef<number | null>(null);

  useEffect(() => {
    if (loading) {
      if (visible) return;
      const id = window.setTimeout(() => {
        shownAt.current = performance.now();
        setVisible(true);
      }, delay);
      return () => window.clearTimeout(id);
    }
    if (!visible) return;
    const quedan = minVisible - (performance.now() - (shownAt.current ?? 0));
    if (quedan <= 0) {
      shownAt.current = null;
      setVisible(false);
      return;
    }
    const id = window.setTimeout(() => {
      shownAt.current = null;
      setVisible(false);
    }, quedan);
    return () => window.clearTimeout(id);
  }, [loading, visible, delay, minVisible]);

  return visible;
}
