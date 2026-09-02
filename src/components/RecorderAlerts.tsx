import React, { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useT } from "../core/LanguageProvider";
import { useToast, type ToastOptions } from "./ui/Toaster";
import type { RecorderAlert } from "../core/tauri-ipc";

/**
 * Escucha `recorder_alert` y lo cuenta.
 *
 * Hasta ahora todos estos fallos morían en un `eprintln!` del backend: la
 * partida se quedaba sin vídeo y la app no lo decía en ningún sitio. El usuario
 * se enteraba al abrir Biblioteca y encontrar la partida sin reproductor.
 *
 * El texto se traduce AQUÍ, a partir de `kind`, que es la clave estable. El
 * `message` del backend viene en inglés y solo se usa de respaldo si aparece un
 * `kind` que este componente todavía no conoce (backend más nuevo que la UI).
 *
 * No pinta nada: solo empuja avisos al `ToastProvider`. Se monta una vez, arriba
 * del todo.
 */
export const RecorderAlerts: React.FC = () => {
  const { toast } = useToast();
  const t = useT();

  useEffect(() => {
    // Llevar a Ajustes sin `useNavigate`: así este componente puede montarse
    // fuera del router (en main.tsx, junto al resto de providers).
    const openSettings = () => {
      window.location.hash = "#/settings";
    };

    const build = (a: RecorderAlert): ToastOptions => {
      switch (a.kind) {
        case "start_failed":
          return {
            tone: "danger",
            title: t("Recording could not start"),
            // El motivo técnico importa: casi siempre es ffmpeg o el códec.
            body: a.detail || t("The game is still being tracked, but without video."),
            action: { label: t("Open Settings"), onClick: openSettings },
          };
        case "stopped_unexpectedly":
          return {
            tone: "warning",
            title: t("Recording stopped on its own"),
            body: a.detail || t("The rest of the game has no video."),
          };
        case "disk_low":
          return {
            tone: "warning",
            title: t("Running low on disk space"),
            body: a.detail
              ? `${a.detail} · ${t("Recording stops below 1 GB free")}`
              : t("Recording stops below 1 GB free"),
          };
        case "disk_full":
          return {
            tone: "danger",
            title: t("Not enough free space to record this game"),
            body: a.detail
              ? `${a.detail} · ${t("Free up space or lower the storage quota.")}`
              : t("Free up space or lower the storage quota."),
            action: { label: t("Open Settings"), onClick: openSettings },
          };
        case "replay_saved":
          return {
            tone: "success",
            title: t("Replay clip saved"),
            body: a.detail,
            // Sin esto el clip existe pero no se sabe dónde: la ruta sola no es
            // una forma de llegar a un fichero.
            action: a.detail
              ? {
                  label: t("Reveal"),
                  onClick: () => {
                    revealItemInDir(a.detail as string).catch(console.error);
                  },
                }
              : undefined,
          };
        case "replay_failed":
          return {
            tone: "danger",
            title: t("Could not save the replay clip"),
            body: a.detail,
          };
        default:
          return { tone: "info", title: a.message, body: a.detail };
      }
    };

    const stop = listen<RecorderAlert>("recorder_alert", (e) => {
      toast(build(e.payload));
    });

    return () => {
      stop.then((f) => f()).catch(() => {});
    };
  }, [toast, t]);

  return null;
};
