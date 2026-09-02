import React from "react";
import { useT } from "../../../core/LanguageProvider";
import type { DiskSpaceInfo } from "../../../core/tauri-ipc";

const GB = 1024 ** 3;
const gb = (bytes: number, decimals = 1): string => (bytes / GB).toFixed(decimals);

/** Por debajo de esto el backend avisa (`storage::DISK_LOW_BYTES`). */
const DISK_LOW_GB = 3;

/**
 * Lo que ocupa la carpeta frente a la CUOTA, y el hueco real del disco.
 *
 * Las dos cosas, y separadas, porque no son la misma: la tira de estado enseñaba
 * solo el porcentaje de la cuota, así que un disco físicamente lleno se leía
 * como "20% usado" mientras la grabadora se negaba a grabar. La cuota la decide
 * el usuario; el disco, no.
 */
export const DiskMeter: React.FC<{ disk: DiskSpaceInfo | null }> = ({ disk }) => {
  const t = useT();
  if (!disk) return null;

  const pct =
    disk.total_bytes > 0
      ? Math.min(100, Math.round((disk.used_bytes / disk.total_bytes) * 100))
      : 0;
  // Solo se pinta el disco si el backend pudo consultarlo: un "0 GB libres de 0"
  // asusta más que no decir nada.
  const hayDisco = disk.drive_total_bytes > 0;
  const libresGb = disk.free_bytes / GB;
  const apretado = hayDisco && libresGb < DISK_LOW_GB;

  return (
    <div style={styles.wrap}>
      <div style={styles.line}>
        <span style={styles.label}>
          {t("{used} GB of {total} GB quota used", {
            used: gb(disk.used_bytes),
            total: gb(disk.total_bytes, 0),
          })}
        </span>
        <span className="u-metric" style={{ fontSize: 11, color: "var(--faint)" }}>
          {pct}%
        </span>
      </div>

      {/* `flex: none` a mano: la clase viene de la barra de descarga, que vive en
          una fila; aquí la columna le dejaba la altura en cero y no se veía. */}
      <span className="upd__track" style={{ flex: "none", height: 4, width: "100%" }}>
        <span
          className="upd__fill"
          style={{ width: `${pct}%`, background: pct >= 90 ? "var(--brand)" : "var(--cool)" }}
        />
      </span>

      {hayDisco && (
        <div style={{ ...styles.line, justifyContent: "flex-start", gap: "var(--space-2)" }}>
          <span style={{ ...styles.label, color: apretado ? "var(--loss)" : "var(--faint)" }}>
            {t("Drive: {free} GB free of {total} GB", {
              free: gb(disk.free_bytes),
              total: gb(disk.drive_total_bytes, 0),
            })}
          </span>
          {apretado && (
            <span className="u-meta" style={{ color: "var(--loss)" }}>
              · {t("Recording stops below 1 GB free")}
            </span>
          )}
        </div>
      )}
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: "var(--space-3) 0 var(--space-2)",
  },
  line: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: "var(--space-3)",
    flexWrap: "wrap",
  },
  label: { fontSize: 11.5, color: "var(--faint)", lineHeight: 1.45 },
};
