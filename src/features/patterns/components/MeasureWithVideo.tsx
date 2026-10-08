import React, { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  cancelMissingMinimaps,
  getMinimapBatch,
  processMissingMinimaps,
  type MinimapBatch,
} from "../../../core/tauri-ipc";
import { useT } from "../../../core/LanguageProvider";

/**
 * "N partidas tienen la presión estimada: medirlas con el vídeo".
 *
 * La presión solo se MIDE donde el minimapa está procesado; en el resto se
 * estima con la API, que contra el vídeo acierta la mitad. Antes había que
 * abrir cada partida y pulsar en su pestaña de Impacto (unos 4 min cada una), y
 * 12 de 26 partidas del usuario se quedaban estimadas. Esto las encola todas en
 * el backend (`minimap::lanzar_lote`), una detrás de otra, y el resumen se
 * refresca solo al terminar cada una (`usePressureSummary` escucha
 * `minimap_progress`).
 */
export const MeasureWithVideo: React.FC = () => {
  const t = useT();
  const [pending, setPending] = useState<number | null>(null);
  /** Medidas con el detector anterior (sin el recuadro de la cámara). */
  const [outdated, setOutdated] = useState(0);
  /** Con el minimapa al día pero sin el HUD leído (golpes que te comes). */
  const [hudPending, setHudPending] = useState(0);
  const [batch, setBatch] = useState<MinimapBatch | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    const leer = () =>
      getMinimapBatch()
        .then((s) => {
          if (!vivo) return;
          setPending(s.pending);
          setOutdated(s.outdated ?? 0);
          setHudPending(s.hud_pending ?? 0);
          setBatch(s.batch);
        })
        .catch(() => {});
    void leer();
    const off = listen<MinimapBatch>("minimap_batch", (e) => {
      setBatch(e.payload);
      if (!e.payload.activo) void leer();
    });
    return () => {
      vivo = false;
      void off.then((f) => f()).catch(() => {});
    };
  }, []);

  const empezar = () => {
    setError(null);
    processMissingMinimaps()
      .then(setBatch)
      .catch((e) => setError(String(e)));
  };

  if (batch?.activo) {
    const pct = batch.total ? Math.round((batch.hechas / batch.total) * 100) : 0;
    return (
      <div className="mv" role="status">
        <div className="mv__row">
          <span>
            {t("Measuring with the video: {done} of {total} games", { done: batch.hechas, total: batch.total })}
          </span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void cancelMissingMinimaps()}>
            {t("Stop")}
          </button>
        </div>
        <div className="mv__track" aria-hidden="true">
          <i style={{ width: `${Math.max(3, pct)}%` }} />
        </div>
        <p className="mv__note">
          {t("One after another, about 4 min each. You can keep using the app; the figures update as each one finishes.")}
        </p>
      </div>
    );
  }

  if (pending === 0 && outdated > 0) {
    return (
      <div className="mv">
        <div className="mv__row">
          <span>
            {outdated === 1
              ? t("1 game was measured with the previous detector.")
              : t("{n} games were measured with the previous detector.", { n: outdated })}
          </span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={empezar}>
            {outdated === 1 ? t("Measure it again") : t("Measure them again")}
          </button>
        </div>
        <p className="mv__note">
          {t("The new one also reads the camera box, so it follows YOUR icon instead of a teammate's: wrong in ~40% of moments before, ~3% now. About {min} min in total.", {
            min: outdated * 4,
          })}
        </p>
        {error && <p className="mv__note mv__note--err">{error}</p>}
      </div>
    );
  }

  if (pending === 0 && outdated === 0 && hudPending > 0) {
    return (
      <div className="mv">
        <div className="mv__row">
          <span>
            {hudPending === 1
              ? t("1 game doesn't have its hits read yet.")
              : t("{n} games don't have their hits read yet.", { n: hudPending })}
          </span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={empezar}>
            {hudPending === 1 ? t("Read it") : t("Read them")}
          </button>
        </div>
        <p className="mv__note">
          {t("Reads your health bar and the effects enemies put on you, for \"Hits you take\". About {min} min in total.", {
            min: hudPending * 3,
          })}
        </p>
        {error && <p className="mv__note mv__note--err">{error}</p>}
      </div>
    );
  }

  if (pending == null || pending === 0) {
    // Si acaba de terminar un lote, se dice cómo fue; si no, nada que hacer.
    return batch && batch.total > 0 ? (
      <p className="mv__note">
        {batch.fallidas > 0
          ? t("{done} games measured with the video; {failed} couldn't be processed.", { done: batch.hechas, failed: batch.fallidas })
          : t("All your games are measured with the video.")}
      </p>
    ) : null;
  }

  return (
    <div className="mv">
      <div className="mv__row">
        <span>
          {pending === 1
            ? t("1 game has its pressure estimated, not measured on the video.")
            : t("{n} games have their pressure estimated, not measured on the video.", { n: pending })}
        </span>
        <button type="button" className="btn btn--ghost btn--sm" onClick={empezar}>
          {pending === 1 ? t("Measure it") : t("Measure them")}
        </button>
      </div>
      <p className="mv__note">
        {t("About {min} min in total, one after another. Measured episodes are more accurate: from Riot's data alone, about half of them are right.", {
          // ~4,5 min por partida AV1 de 30 min decodificando con la GPU (medido);
          // las H.264 viejas, ~2. Se redondea por arriba.
          min: pending * 4,
        })}
      </p>
      {error && <p className="mv__note mv__note--err">{error}</p>}
    </div>
  );
};
