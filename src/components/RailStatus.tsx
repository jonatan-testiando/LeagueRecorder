import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { checkRiotKey, getDiskUsage, type DiskSpaceInfo } from "../core/tauri-ipc";
import { useT } from "../core/LanguageProvider";

/**
 * Estado de captura, fijo al pie del rail y visible desde cualquier sección.
 *
 * Antes vivía solo en "Hoy" como una tira de tres píldoras, así que desde la
 * biblioteca o el reproductor no se sabía si la app estaba grabando. Ahora es
 * una tarjeta pequeña con dos líneas: qué hace el grabador, y la clave de
 * Riot y el disco en voz baja. Si la clave falla, la línea es un botón que
 * lleva a Ajustes.
 */

type KeyStatus = "ok" | "missing" | "expired" | "invalid";

export const RailStatus: React.FC<{ isRecording: boolean }> = ({ isRecording }) => {
  const t = useT();
  const navigate = useNavigate();
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null);
  const [disk, setDisk] = useState<DiskSpaceInfo | null>(null);

  useEffect(() => {
    let vivo = true;
    getDiskUsage().then((d) => vivo && setDisk(d)).catch(() => {});
    // El backend solo emite `riot_key_status` cuando una llamada choca con un
    // 401/403, así que además se pregunta al arrancar.
    checkRiotKey()
      .then(() => vivo && setKeyStatus("ok"))
      .catch((e) => {
        if (!vivo) return;
        const msg = String(e).toLowerCase();
        setKeyStatus(msg.includes("no_key") || msg.includes("missing") ? "missing" : "invalid");
      });
    const paraClave = listen<{ status: KeyStatus }>("riot_key_status", (e) => setKeyStatus(e.payload.status));
    return () => {
      vivo = false;
      paraClave.then((f) => f()).catch(() => {});
    };
  }, []);

  // Al terminar una grabación el disco cambia: se vuelve a preguntar.
  useEffect(() => {
    if (isRecording) return;
    getDiskUsage().then(setDisk).catch(() => {});
  }, [isRecording]);

  const libreGb = disk && disk.free_bytes > 0 ? (disk.free_bytes / 1024 ** 3).toFixed(0) : null;
  const claveMal = keyStatus !== null && keyStatus !== "ok";
  const claveTexto =
    keyStatus === null
      ? t("Checking key…")
      : keyStatus === "ok"
        ? t("Riot key OK")
        : keyStatus === "missing"
          ? t("No Riot key")
          : keyStatus === "expired"
            ? t("Riot key expired")
            : t("Riot key rejected");

  return (
    <div className="rail-status" role="status">
      <div className="rail-status__st">
        <span className={`rail-status__dot${isRecording ? " rail-status__dot--rec" : ""}`} />
        {isRecording ? t("Recording") : t("Waiting for a game")}
      </div>
      <div className="rail-status__meta u-meta">
        {claveMal ? (
          <button type="button" onClick={() => navigate("/settings?cat=account")}>{claveTexto}</button>
        ) : (
          <span>{claveTexto}</span>
        )}
        <span aria-hidden="true">·</span>
        <span className="u-metric" style={{ fontSize: 11 }}>{libreGb ? t("{n} GB free", { n: libreGb }) : "—"}</span>
      </div>
    </div>
  );
};
