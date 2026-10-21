import React from "react";
import { useT } from "../../../core/LanguageProvider";
import type { DiskSpaceInfo } from "../../../core/tauri-ipc";
import { formatDecimal } from "../../../core/benchmarkFormat";

const GB = 1024 ** 3;
// Con la coma del idioma, como el resto de cifras («12,4 GB»).
const gb = (bytes: number, decimals = 1): string => formatDecimal(bytes / GB, decimals);

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

  // Los estilos viven en SettingsPanel.css (`.stg-disk*`): aquí solo queda lo
  // que depende del dato, el ancho de la barra.
  return (
    <div className="stg-disk">
      <div className="stg-disk__line">
        <span className="stg-disk__label">
          {t("{used} GB of {total} GB quota used", {
            used: gb(disk.used_bytes),
            total: gb(disk.total_bytes, 0),
          })}
        </span>
        <span className="stg-disk__label">{pct}%</span>
      </div>

      {/* La pista es la de la barra de descarga; `.stg-disk__track` le quita el
          `flex: 1`, que en esta columna la dejaba con la altura en cero. */}
      <span className="upd__track stg-disk__track">
        <span
          className="upd__fill"
          {...(pct >= 90 ? { "data-tone": "full" } : {})}
          style={{ "--p": pct / 100 } as React.CSSProperties}
        />
      </span>

      {hayDisco && (
        <div className="stg-disk__line stg-disk__line--start" {...(apretado ? { "data-tone": "bad" } : {})}>
          <span className="stg-disk__label">
            {t("Drive: {free} GB free of {total} GB", {
              free: gb(disk.free_bytes),
              total: gb(disk.drive_total_bytes, 0),
            })}
          </span>
          {apretado && <span className="stg-disk__label">· {t("Recording stops below 1 GB free")}</span>}
        </div>
      )}
    </div>
  );
};
