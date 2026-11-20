import { useCallback, useContext } from "react";
import { UNSAFE_NavigationContext, type NavigateFunction, type NavigateOptions, type To } from "react-router-dom";
import { conTransicion } from "./movimiento";

/**
 * Navegar entre pantallas, con View Transition (core/movimiento.ts). Se usa
 * en lugar del `useNavigate` de react-router en toda la app: así cualquier
 * navegación (el raíl, Ctrl K, un botón de Hoy, el post-partida) se anima igual
 * sin que cada pantalla tenga que acordarse.
 *
 * Dos cosas que el original hacía mal aquí:
 * - Se suscribe a la ruta: cada componente que lo usaba (Hoy, la Biblioteca,
 *   Patrones, Coach, Ctrl K…) se volvía a pintar en CADA cambio de pantalla,
 *   aunque no cambiara nada suyo. Esto va directo al navegador del router, que
 *   no cambia. Medido junto con las pantallas memorizadas en App: el render
 *   dentro de la transición bajó de 23 a ~13 ms.
 * - Aplica el cambio dentro de `startTransition` (de ahí también
 *   `<HashRouter useTransitions={false}>` en main.tsx): `flushSync` no lo
 *   fuerza y la transición capturaría dos veces la pantalla de antes.
 *
 * Todas las rutas de la app son absolutas ("/review", "/settings?cat=…"), así
 * que no hace falta resolver rutas relativas.
 *
 * La dirección sigue el orden del raíl: hacia abajo, lo nuevo sube; hacia
 * arriba, baja. Con el teclado no hay animación.
 */
const ORDEN = ["/home", "/review", "/clips", "/errors", "/coach", "/patterns", "/training", "/vod", "/settings", "/champ-select"];

const indice = (ruta: string) => {
  const i = ORDEN.findIndex((p) => ruta === p || ruta.startsWith(p + "/") || ruta.startsWith(p + "?"));
  return i < 0 ? 0 : i;
};

export function useNavigate(): NavigateFunction {
  const { navigator } = useContext(UNSAFE_NavigationContext);
  return useCallback(
    ((to: To | number, opciones?: NavigateOptions) => {
      if (typeof to === "number") {
        conTransicion("nav", () => navigator.go(to));
        return;
      }
      const destino = typeof to === "string" ? to : to.pathname ?? "";
      const actual = window.location.hash.replace(/^#/, "") || "/home";
      const dir = indice(destino) >= indice(actual) ? "down" : "up";
      conTransicion(
        "nav",
        () => (opciones?.replace ? navigator.replace(to, opciones.state) : navigator.push(to, opciones?.state)),
        { dir }
      );
    }) as NavigateFunction,
    [navigator]
  );
}
