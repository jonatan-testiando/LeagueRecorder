import { useState, useEffect, useCallback, useRef } from "react";
import { MatchMetadata } from "../../types";
import { useDialog } from "../../components/ui/DialogProvider";
import { getRecordedMatches, deleteMatch as deleteMatchIpc, getRecorderStatus } from "../../core/tauri-ipc";
import { useAppStore } from "../../store/useAppStore";
import { useT } from "../../core/LanguageProvider";

export const useGallery = () => {
  const [matches, setMatches] = useState<MatchMetadata[]>([]);
  const selectedMatch = useAppStore(state => state.selectedMatch);
  const setSelectedMatch = useAppStore(state => state.setSelectedMatch);
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const { showConfirm, showError } = useDialog();
  const t = useT();

  const fetchMatches = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const data = await getRecordedMatches();
      setMatches(data);
      
      // Si la partida seleccionada ya no existe (por ejemplo, tras borrarse), deseleccionarla
      if (selectedMatch) {
        if (!selectedMatch.id.startsWith("vod_")) {
          const stillExists = data.some(m => m.id === selectedMatch.id);
          if (!stillExists) {
            setSelectedMatch(null);
          }
        }
      }
    } catch (err) {
      setError(err as string);
    } finally {
      setIsLoading(false);
    }
  }, [selectedMatch]);

  const checkStatus = useCallback(async () => {
    try {
      const status = await getRecorderStatus();
      setIsRecording(status);
    } catch {
      // Ignorar errores de polling de status
    }
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    const isConfirmed = await showConfirm({
      title: "Eliminar partida",
      message: "¿Estás seguro de que quieres borrar esta grabación? Se eliminarán permanentemente el video y los eventos.",
      confirmText: "Eliminar",
      cancelText: "Cancelar",
      type: "error"
    });
    
    if (isConfirmed) {
      try {
        await deleteMatchIpc(id);
        await fetchMatches();
      } catch (err) {
        showError("Error al borrar la partida: " + err);
      }
    }
  }, [showConfirm, showError]);

  /**
   * Borrado por lotes. Devuelve true solo si el usuario confirmó y se intentó
   * borrar (para que la galería sepa si limpiar la selección).
   *
   * En SERIE a propósito: cada borrado muda clips a `recortes/` y elimina la
   * carpeta, y dos borrados en paralelo pueden pisarse — el mismo solape que ya
   * hubo que arreglar en el borrado individual.
   */
  const handleDeleteBatch = useCallback(async (ids: string[]): Promise<boolean> => {
    if (ids.length === 0) return false;
    const isConfirmed = await showConfirm({
      title: t("Delete selected games"),
      message: t(
        "This permanently deletes {n} recordings with their videos and events. Favourited clips are rescued to the clips folder.",
        { n: ids.length }
      ),
      confirmText: t("Delete"),
      cancelText: t("Cancel"),
      type: "error",
    });
    if (!isConfirmed) return false;

    let fallos = 0;
    for (const id of ids) {
      try {
        await deleteMatchIpc(id);
      } catch {
        fallos++;
      }
    }
    await fetchMatches();
    if (fallos > 0) {
      showError(t("Could not delete {n} of the selected games.", { n: fallos }));
    }
    return true;
  }, [showConfirm, showError, fetchMatches, t]);

  useEffect(() => {
    fetchMatches();
    checkStatus();

    // El estado de la grabadora es barato (un bool en memoria): lo consultamos
    // seguido para que el indicador de "grabando" responda al instante.
    const statusInterval = setInterval(checkStatus, 5000);

    // La lista de partidas SÍ es cara de refrescar (lee los JSON de todas las
    // partidas). Como una partida dura ~30 min, basta con refrescarla cada 5 min.
    // Además, la refrescamos al instante cuando termina una grabación (efecto de
    // abajo), así que no perdemos la utilidad de ver la partida nueva enseguida.
    const listInterval = setInterval(() => {
      getRecordedMatches().then(setMatches).catch(() => {});
    }, 5 * 60 * 1000);

    return () => {
      clearInterval(statusInterval);
      clearInterval(listInterval);
    };
  }, [fetchMatches, checkStatus]);

  // Refresco inmediato de la lista cuando una grabación pasa de activa a inactiva
  // (acaba de terminar una partida): así la nueva grabación aparece al momento
  // sin necesidad de pollear la lista con frecuencia.
  const prevRecording = useRef(false);
  useEffect(() => {
    if (prevRecording.current && !isRecording) {
      getRecordedMatches().then(setMatches).catch(() => {});
    }
    prevRecording.current = isRecording;
  }, [isRecording]);

  return {
    matches,
    selectedMatch,
    setSelectedMatch,
    isRecording,
    isLoading,
    error,
    refreshMatches: fetchMatches,
    deleteMatch: handleDelete,
    deleteMatches: handleDeleteBatch
  };
};
