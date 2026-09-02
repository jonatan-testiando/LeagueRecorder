import React, { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useNavigate } from "react-router-dom";
import { X } from "lucide-react";
import { checkRiotKey } from "../core/tauri-ipc";
import { useT } from "../core/LanguageProvider";

/**
 * Aviso persistente sobre la clave de Riot.
 *
 * Las claves de desarrollo caducan cada 24 h. Hasta ahora eso se notaba como
 * partidas que dejaban de traer marcador, rango ni impacto, sin ningún cartel
 * que dijera por qué: el 403 de Riot se traducía en "no hay datos". El backend
 * emite `riot_key_status` en cuanto una llamada choca con un 401/403 y esto lo
 * enseña donde se está mirando, con el enlace para renovarla al lado.
 *
 * Se puede cerrar, pero solo por sesión: si la clave sigue caducada mañana, el
 * aviso vuelve. Un cartel que se puede silenciar para siempre es un cartel que
 * nadie ve el día que importa.
 */

export const RIOT_DEV_PORTAL = "https://developer.riotgames.com/";

type KeyStatus = "ok" | "invalid" | "expired" | "missing";

interface KeyStatusEvent {
  status: KeyStatus;
  message: string;
}

export const RiotKeyBanner: React.FC = () => {
  const t = useT();
  const navigate = useNavigate();
  const [status, setStatus] = useState<KeyStatus>("ok");
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let alive = true;
    const stop = listen<KeyStatusEvent>("riot_key_status", (e) => {
      if (!alive) return;
      setStatus(e.payload.status);
      // Un estado NUEVO vuelve a mostrar el aviso aunque se hubiera cerrado:
      // cerrar "sin clave" no debería tapar un "caducada" de mañana.
      setDismissed(false);
    });
    // Además de escuchar, se pregunta: el backend solo emite cuando alguna
    // llamada falla, así que al abrir la app con la clave ya caducada no habría
    // llegado nada hasta la primera sincronización. Esto también le deja al
    // backend el AppHandle con el que emite después.
    checkRiotKey().catch(() => {});
    return () => {
      alive = false;
      stop.then((f) => f()).catch(() => {});
    };
  }, []);

  if (status === "ok" || dismissed) return null;

  const sinClave = status === "missing";
  const tono = sinClave ? "var(--brand)" : "var(--signal)";

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        padding: "var(--space-2) var(--space-4)",
        // Los paneles traen su propio margen interior (ver `.setpage`); el
        // aviso vive fuera de ellos, así que se lo pone él.
        margin: "var(--space-4) var(--space-8) 0",
        borderRadius: "var(--radius-md)",
        border: `1px solid color-mix(in srgb, ${tono} 34%, transparent)`,
        background: `color-mix(in srgb, ${tono} 10%, var(--surface-2))`,
        fontFamily: "var(--font-sans)",
        fontSize: "var(--font-sm)",
        color: "var(--text)",
        flexShrink: 0,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: tono,
          flexShrink: 0,
        }}
      />
      <span style={{ flex: 1, minWidth: 0 }}>
        {sinClave
          ? t("Add your Riot key to unlock scoreboard, impact and rank")
          : status === "invalid"
            ? t("Riot rejected your key. Check it in Settings.")
            : t("Your Riot key expired. Development keys last 24 h.")}
      </span>
      <button className="btn btn--ghost btn--sm" onClick={() => openUrl(RIOT_DEV_PORTAL)}>
        {t("Renew key")}
      </button>
      <button className="btn btn--ghost btn--sm" onClick={() => navigate("/settings")}>
        {t("Open Settings")}
      </button>
      <button
        className="btn btn--icon btn--sm"
        onClick={() => setDismissed(true)}
        title={t("Dismiss")}
        aria-label={t("Dismiss")}
      >
        <X size={14} />
      </button>
    </div>
  );
};
