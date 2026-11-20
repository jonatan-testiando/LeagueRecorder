import React, { useEffect, useState } from "react";

/**
 * Una pantalla en su propio trozo de JavaScript, cargada cuando hace falta.
 *
 * Todo iba en un único fichero de 1,16 MB que el WebView tenía que parsear y
 * compilar entero antes de pintar Hoy, aunque el reproductor, Patrones,
 * Entrenamiento o Ajustes no se vean al arrancar (medido el 2026-11-19).
 *
 * Por qué no `React.lazy`: aunque el módulo ya esté cargado, `lazy` suspende
 * igualmente el primer render y pinta un fotograma vacío, y la entrada
 * escalonada de la pantalla (core/enterMotion.ts) se haría sobre la nada. Esto
 * pinta el componente en el mismo render si ya se precargó; si no, lo carga y
 * lo pinta al llegar.
 */
export type Perezoso<C extends React.ComponentType<any>> = React.FC<React.ComponentProps<C>> & {
  /** Empieza a cargar el trozo (una sola vez). Devuelve cuándo está listo. */
  precargar: () => Promise<unknown>;
};

export function perezoso<C extends React.ComponentType<any>>(cargar: () => Promise<C>): Perezoso<C> {
  let componente: C | null = null;
  let promesa: Promise<C> | null = null;

  const precargar = () => {
    if (!promesa) {
      promesa = cargar().then(
        (c) => (componente = c),
        (e) => {
          // Que el siguiente intento vuelva a probar en vez de quedarse vacío.
          promesa = null;
          throw e;
        },
      );
    }
    return promesa;
  };

  const Componente: React.FC<React.ComponentProps<C>> = (props) => {
    const [, avisar] = useState(0);
    useEffect(() => {
      if (componente) return;
      let vivo = true;
      precargar()
        .then(() => vivo && avisar((n) => n + 1))
        .catch(console.error);
      return () => {
        vivo = false;
      };
    }, []);
    if (!componente) return null;
    const C2 = componente as React.ComponentType<any>;
    return <C2 {...props} />;
  };

  return Object.assign(Componente, { precargar });
}

/**
 * Precarga varios trozos cuando el navegador está ocioso, uno tras otro, para
 * no competir con las animaciones de entrada.
 */
export function precargarEnReposo(lista: Array<{ precargar: () => Promise<unknown> }>, retrasoMs = 800): void {
  const ocioso: (cb: () => void) => void =
    typeof window.requestIdleCallback === "function"
      ? (cb) => window.requestIdleCallback(cb, { timeout: 2000 })
      : (cb) => window.setTimeout(cb, 50);
  const siguiente = (i: number) => {
    if (i >= lista.length) return;
    ocioso(() => {
      lista[i]
        .precargar()
        .catch(() => {})
        .finally(() => siguiente(i + 1));
    });
  };
  window.setTimeout(() => siguiente(0), retrasoMs);
}
