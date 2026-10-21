import React, { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useT } from "../../../core/LanguageProvider";
import { roleLabel } from "../../../core/roles";

/**
 * Dónde se dibuja el aviso.
 *
 * La posición estaba escrita dentro del objeto de estilos y no había forma de
 * moverla: para quien tenga el HUD del juego arriba en el centro, el aviso cae
 * justo encima. Debería ser un ajuste, pero `TrainingConfig`
 * (src-tauri/src/training.rs) no tiene campo para ello y el backend queda fuera
 * de este trabajo; queda aquí, en un solo sitio y con nombre, que es lo que hay
 * que cambiar el día que se añada el ajuste.
 */
const POSITION: React.CSSProperties = { top: "var(--space-2)", left: "50%", transform: "translateX(-50%)" };

interface PromptPayload {
  role: string;
  key: string;
  /** Segundos que tienes para responder. */
  window_secs: number;
}

interface AckPayload {
  ok: boolean;
  role: string;
  latency_ms: number;
}

type View =
  | { kind: "idle" }
  | { kind: "prompt"; role: string; key: string }
  | { kind: "ack"; ok: boolean; latencyMs: number };

/**
 * Aviso del metrónomo durante la partida.
 *
 * Vive en una ventana transparente, sin bordes, siempre encima y click-through:
 * no roba el foco ni intercepta el ratón, así que el juego no se entera. La lógica
 * (cuándo pedir, quién toca, si respondiste) está en Rust; aquí solo se pinta.
 */
export const MetronomeOverlay: React.FC = () => {
  const t = useT();
  const [view, setView] = useState<View>({ kind: "idle" });

  // La ventana debe ser realmente transparente: el CSS global pinta un fondo
  // opaco pensado para la ventana principal.
  useEffect(() => {
    const prevHtml = document.documentElement.style.background;
    const prevBody = document.body.style.background;
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    document.body.style.overflow = "hidden";
    return () => {
      document.documentElement.style.background = prevHtml;
      document.body.style.background = prevBody;
    };
  }, []);

  useEffect(() => {
    let hideTimer: number | null = null;
    const clear = () => {
      if (hideTimer !== null) window.clearTimeout(hideTimer);
      hideTimer = null;
    };

    const unPrompt = listen<PromptPayload>("metronome_prompt", (e) => {
      clear();
      setView({ kind: "prompt", role: e.payload.role, key: e.payload.key });
      // Si Rust no manda ack (partida terminada, app cerrada), no nos quedamos
      // con el aviso clavado en pantalla para siempre.
      hideTimer = window.setTimeout(
        () => setView({ kind: "idle" }),
        Math.max(2, e.payload.window_secs) * 1000 + 1500
      );
    });

    const unAck = listen<AckPayload>("metronome_ack", (e) => {
      clear();
      setView({ kind: "ack", ok: e.payload.ok, latencyMs: e.payload.latency_ms });
      hideTimer = window.setTimeout(() => setView({ kind: "idle" }), 1200);
    });

    return () => {
      clear();
      unPrompt.then((f) => f()).catch(() => {});
      unAck.then((f) => f()).catch(() => {});
    };
  }, []);

  if (view.kind === "idle") return null;

  if (view.kind === "ack") {
    return (
      <div style={{ ...styles.pill, ...(view.ok ? styles.pillOk : styles.pillMiss) }}>
        {view.ok ? (
          <>
            <span style={styles.tick}>✓</span>
            <span style={styles.latency}>{Math.round(view.latencyMs)} ms</span>
          </>
        ) : (
          <>
            <span style={styles.cross}>✕</span>
            <span style={styles.latency}>{t("missed")}</span>
          </>
        )}
      </div>
    );
  }

  return (
    <div style={{ ...styles.pill, ...styles.pillPrompt }}>
      <span style={styles.keyCap}>{view.key}</span>
      <span style={styles.role}>{t(roleLabel(view.role))}</span>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  pill: {
    position: "fixed",
    ...POSITION,
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--space-2)",
    padding: "var(--space-2) var(--space-4)",
    borderRadius: "var(--radius-full)",
    background: "color-mix(in srgb, var(--ground) 82%, transparent)",
    backdropFilter: "blur(6px)",
    border: "1px solid var(--glass-line)",
    fontFamily: "var(--font-sans)",
    boxShadow: "var(--shadow-2)",
    userSelect: "none",
    whiteSpace: "nowrap",
  },
  pillPrompt: { borderColor: "color-mix(in srgb, var(--cool) 55%, transparent)" },
  pillOk: { borderColor: "color-mix(in srgb, var(--win) 55%, transparent)" },
  pillMiss: { borderColor: "color-mix(in srgb, var(--loss) 55%, transparent)" },
  keyCap: {
    minWidth: 26,
    height: 26,
    padding: "0 var(--space-1)",
    borderRadius: "var(--radius-md)",
    background: "var(--cool)",
    // Tinta del fondo y no --text: el hueso sobre jade se quedaba en 1,4:1 en
    // oscuro y 2,1:1 en claro; --ground da 7,7 y 4,9.
    color: "var(--ground)",
    fontWeight: 600,
    fontSize: "var(--fs-14)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontFamily: "var(--font-mono)",
  },
  role: { color: "var(--text)", fontWeight: 500, fontSize: "var(--fs-14)" },
  tick: { color: "var(--win)", fontSize: "var(--fs-16)", fontWeight: 600 },
  cross: { color: "var(--loss)", fontSize: "var(--fs-16)", fontWeight: 600 },
  latency: {
    color: "var(--muted)",
    fontSize: "var(--fs-13)",
    fontVariantNumeric: "tabular-nums",
  },
};
