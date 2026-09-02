import React, { useCallback, useEffect, useState } from "react";
import { useT } from "../../../core/LanguageProvider";

/**
 * Botón que captura la siguiente tecla pulsada y la guarda.
 *
 * Mismo patrón que el de Entrenamiento (`TrainingSetup`), con una diferencia: la
 * que decide si la tecla vale es el BACKEND, porque es quien tiene que
 * registrarla en el listener global. Así que aquí se manda tal cual y, si la
 * rechaza, se enseña su motivo y se sigue escuchando: cerrar la escucha sin
 * decir nada era indistinguible de un botón roto.
 */
export const HotkeyCapture: React.FC<{
  value: string;
  /** Guarda. Debe rechazar con el mensaje del backend si la tecla no vale. */
  onCapture: (key: string) => Promise<void>;
  disabled?: boolean;
}> = ({ value, onCapture, disabled }) => {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const t = useT();

  /**
   * De un evento de teclado al vocabulario del backend: letras, dígitos, F1–F12,
   * espacio y tabulador, todo en mayúsculas. Lo que no encaje se manda igual —
   * que conteste el backend, que es quien sabe lo que puede registrar.
   */
  const keyName = useCallback((e: KeyboardEvent): string => {
    if (e.key === " " || e.code === "Space") return "SPACE";
    if (e.key === "Tab") return "TAB";
    return e.key.toUpperCase();
  }, []);

  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      // Escape cancela: quedarse atrapado escuchando no era una salida.
      if (e.key === "Escape") {
        setListening(false);
        setError("");
        return;
      }
      // Un modificador suelto no es un atajo: se ignora y se sigue esperando,
      // porque casi siempre es la mano apoyada antes de la tecla de verdad.
      if (["Shift", "Control", "Alt", "Meta", "AltGraph"].includes(e.key)) return;
      const k = keyName(e);
      setListening(false);
      setSaving(true);
      onCapture(k)
        .then(() => setError(""))
        .catch((err) => setError(String(err).replace(/^Error:\s*/, "")))
        .finally(() => setSaving(false));
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [listening, onCapture, keyName]);

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
      <button
        className={listening ? "btn btn--primary btn--sm" : "btn btn--ghost btn--sm"}
        style={{ fontFamily: "var(--font-mono)", minWidth: 76, justifyContent: "center" }}
        disabled={disabled || saving}
        onClick={() => {
          setListening(true);
          setError("");
        }}
        title={listening ? t("Press a key, or Escape to cancel") : t("Change key")}
      >
        {listening ? t("press…") : saving ? t("Saving…") : value || "—"}
      </button>
      {error && (
        <span className="u-meta" style={{ color: "var(--loss)", maxWidth: "32ch", textAlign: "right" }}>
          {error}
        </span>
      )}
    </span>
  );
};
