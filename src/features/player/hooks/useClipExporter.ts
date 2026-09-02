import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MatchMetadata } from "../../../types";
import { exportErrorClip } from "../../../core/tauri-ipc";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useDialog } from "../../../components/ui/DialogProvider";
import { useT } from "../../../core/LanguageProvider";

export type ExportType = "clip" | "error";

/**
 * El recortador: la selección de rango sobre la línea de tiempo, sus dos
 * asideros arrastrables y la exportación a Tauri (clip de vídeo o error con
 * nota).
 *
 * Extraído de `VideoPlayer.tsx` tal cual. El arrastre de los asideros sigue
 * pasando por los pointer handlers de la tira (el hook solo guarda QUÉ asidero
 * está cogido); el componente pregunta `clipDragThumb` en su onPointerMove y
 * llama a `dragThumbTo`.
 */
export function useClipExporter(match: MatchMetadata) {
  const [isClippingMode, setIsClippingMode] = useState<boolean>(false);
  const [clipDragThumb, setClipDragThumb] = useState<"start" | "end" | null>(null);
  const [clipStart, setClipStart] = useState<number>(0);
  const [clipEnd, setClipEnd] = useState<number>(0);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportType, setExportType] = useState<ExportType>("clip");
  const [errorNote, setErrorNote] = useState<string>("");

  const { showConfirm, showError } = useDialog();
  const t = useT();

  /** Abre (o cierra) el recortador centrado en el instante actual. */
  const toggleClipMode = useCallback(
    (type: ExportType, currentTime: number, duration: number) => {
      setExportType(type);
      setIsClippingMode((abierto) => {
        if (!abierto) {
          setClipStart(Math.max(0, currentTime - 10));
          setClipEnd(Math.min(duration, currentTime + 10));
        }
        return !abierto;
      });
    },
    []
  );

  /** Mueve el asidero cogido a un instante, sin dejar que se cruce con el otro. */
  const dragThumbTo = useCallback(
    (newTime: number) => {
      if (clipDragThumb === "start") setClipStart(Math.min(newTime, clipEnd - 1));
      else if (clipDragThumb === "end") setClipEnd(Math.max(newTime, clipStart + 1));
    },
    [clipDragThumb, clipStart, clipEnd]
  );

  const doExport = useCallback(async () => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const dur = Math.max(0.1, clipEnd - clipStart);
      let destino = "";
      if (exportType === "clip") {
        destino = await invoke<string>("export_clip", { matchId: match.id, videoPath: match.video_path, startTime: clipStart, duration: dur });
      } else {
        destino = await exportErrorClip(match.id, match.video_path, clipStart, dur, errorNote);
        setErrorNote("");
      }
      setIsClippingMode(false);
      // "Exported successfully!" no decía dónde: el fichero existía y no había
      // forma de llegar a él sin buscarlo. Ahora se enseña la ruta y se ofrece
      // abrir la carpeta.
      const abrir = await showConfirm({
        title: t("Clip exported"),
        message: destino ? t("Saved to {path}", { path: destino }) : t("Saved to your clips folder."),
        confirmText: t("Reveal in folder"),
        cancelText: t("Done"),
      });
      if (abrir && destino) {
        await revealItemInDir(destino).catch(() => {});
      }
    } catch (err) {
      showError(t("Couldn't export the clip: {msg}", { msg: String(err) }));
    } finally {
      setIsExporting(false);
    }
  }, [isExporting, clipStart, clipEnd, exportType, errorNote, match.id, match.video_path, showConfirm, showError, t]);

  return {
    isClippingMode,
    setIsClippingMode,
    clipDragThumb,
    setClipDragThumb,
    clipStart,
    clipEnd,
    isExporting,
    exportType,
    errorNote,
    setErrorNote,
    toggleClipMode,
    dragThumbTo,
    doExport,
  };
}
