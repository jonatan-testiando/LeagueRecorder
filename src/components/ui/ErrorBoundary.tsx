import React from "react";
import { Check, Copy, RotateCcw, TriangleAlert } from "lucide-react";
import { getVersion } from "@tauri-apps/api/app";
import { EmptyState } from "./EmptyState";
import { Button } from "./Button";
import { useT } from "../../core/LanguageProvider";

/**
 * Corta un fallo de render en la sección que lo tiene.
 *
 * Sin esto un throw en cualquier panel (en el arnés, `rutas.filter` sobre un
 * `null` en Patrones) desmontaba el árbol entero y la ventana quedaba en negro,
 * sin barra de título con la que cerrarla. Envuelve cada panel en `App.tsx`:
 * la barra y el rail siguen vivos y el panel caído dice qué pasó, con dos
 * salidas: recargar SOLO esa sección (se remonta su árbol, no la ventana) y
 * copiar los detalles para contarlo.
 *
 * `scope="app"` es la red de debajo, en `main.tsx`, para lo que pete fuera de
 * los paneles: ahí no hay sección que remontar y se recarga la ventana.
 */

interface Props {
  /** Nombre de la sección, ya traducido: «Recargar Patrones». */
  name: string;
  scope?: "section" | "app";
  /** Lo que se pinta encima del aviso: en `scope="app"`, la barra de título,
   *  que es lo único con lo que mover y cerrar una ventana sin marco. */
  chrome?: React.ReactNode;
  /** Sustituye al aviso entero. `null` = que lo caído desaparezca sin más. */
  fallback?: React.ReactNode;
  children: React.ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
  /** Sube con cada «Recargar»: es la clave que remonta los hijos. */
  attempt: number;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, componentStack: null, attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error(`[${this.props.name}] la sección falló al pintar:`, error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  private reload = () => {
    if (this.props.scope === "app") {
      window.location.reload();
      return;
    }
    this.setState((s) => ({ error: null, componentStack: null, attempt: s.attempt + 1 }));
  };

  render() {
    const { error, componentStack, attempt } = this.state;
    if (error) {
      if (this.props.fallback !== undefined) return this.props.fallback;
      return (
        <>
        {this.props.chrome}
        <SectionError
          name={this.props.name}
          scope={this.props.scope ?? "section"}
          error={error}
          componentStack={componentStack}
          onReload={this.reload}
        />
        </>
      );
    }
    return <React.Fragment key={attempt}>{this.props.children}</React.Fragment>;
  }
}

const SectionError: React.FC<{
  name: string;
  scope: "section" | "app";
  error: Error;
  componentStack: string | null;
  onReload: () => void;
}> = ({ name, scope, error, componentStack, onReload }) => {
  const t = useT();
  const [copied, setCopied] = React.useState(false);

  const copy = async () => {
    // La versión se pide al copiar: es lo primero que hay que saber de un
    // fallo, y fuera de Tauri (el arnés) simplemente no está.
    const version = await getVersion().catch(() => "?");
    const details = [
      `LeagueRecorder v${version}`,
      `${scope === "app" ? "App" : name} · ${window.location.hash || "#/"}`,
      // La pila de V8 ya empieza por «TypeError: …»; sin pila, el mensaje.
      error.stack ?? `${error.name}: ${error.message}`,
      componentStack ? `Componentes:${componentStack}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    try {
      await navigator.clipboard.writeText(details);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error("No se pudieron copiar los detalles:", e);
    }
  };

  return (
    <div role="alert" style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <EmptyState
        icon={<TriangleAlert size={30} color="var(--signal)" />}
        title={scope === "app" ? t("The app failed to load") : t("This section failed to load")}
        text={
          scope === "app"
            ? t("Reload the window to try again. If it happens again, copy the details to report it.")
            : t("The rest of the app still works. Reload just this section, or copy the details to report it.")
        }
        action={
          <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "var(--space-2)" }}>
            <Button variant="primary" icon={<RotateCcw size={14} />} onClick={onReload}>
              {scope === "app" ? t("Reload the window") : t("Reload {section}", { section: name })}
            </Button>
            <Button variant="ghost" icon={copied ? <Check size={14} /> : <Copy size={14} />} onClick={copy}>
              {copied ? t("Copied") : t("Copy details")}
            </Button>
          </div>
        }
      />
    </div>
  );
};
