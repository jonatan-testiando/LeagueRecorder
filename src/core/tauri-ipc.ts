import { invoke } from "@tauri-apps/api/core";
import { MatchMetadata, AudioStatus, VideoSettings, Comment } from "../types";

export const getRecordedMatches = async (): Promise<MatchMetadata[]> => {
  return await invoke<MatchMetadata[]>("get_recorded_matches");
};

export const deleteMatch = async (id: string): Promise<void> => {
  return await invoke<void>("delete_match", { id });
};

export const getRecorderStatus = async (): Promise<boolean> => {
  return await invoke<boolean>("get_recorder_status");
};

export const getAudioStatus = async (): Promise<AudioStatus> => {
  return await invoke<AudioStatus>("get_audio_status");
};

export const startManualRecording = async (id: string): Promise<string> => {
  return await invoke<string>("start_manual_recording", { id });
};

export const stopManualRecording = async (): Promise<void> => {
  return await invoke<void>("stop_manual_recording");
};

export const getVideoSettings = async (): Promise<VideoSettings> => {
  return await invoke<VideoSettings>("get_video_settings");
};

export const setVideoSettings = async (fps: number, quality: string): Promise<VideoSettings> => {
  return await invoke<VideoSettings>("set_video_settings", { fps, quality });
};

export interface ErrorEvent {
  id: string;
  time: number;
  text: string;
  category: string;
}

export interface ErrorClipMetadata {
  path: string;
  name: string;
  match_id: string;
  size: number;
  note: string;
  events: ErrorEvent[];
  /**
   * Segundo del vídeo de origen en que empieza el recorte. Ausente en los clips
   * exportados antes de que se guardara: hasta entonces la posición se perdía al
   * exportar, así que un error marcado no podía volver a la línea de tiempo.
   */
  start_time?: number;
  /** Marcado como visto en la cola de revisión. */
  reviewed?: boolean;
}

export const exportErrorClip = async (matchId: string, videoPath: string, startTime: number, duration: number, note: string): Promise<string> => {
  return await invoke<string>("export_error_clip", { matchId, videoPath, startTime, duration, note });
};

export const getAllErrorClips = async (): Promise<ErrorClipMetadata[]> => {
  return await invoke<ErrorClipMetadata[]>("get_all_error_clips");
};

export const updateErrorNote = async (path: string, note: string): Promise<void> => {
  return await invoke<void>("update_error_note", { path, note });
};

export const addErrorEvent = async (path: string, time: number, text: string, category: string): Promise<string> => {
  return await invoke<string>("add_error_event", { path, time, text, category });
};

export const deleteErrorEvent = async (path: string, eventId: string): Promise<void> => {
  return await invoke<void>("delete_error_event", { path, eventId });
};

export const editErrorEvent = async (path: string, eventId: string, text: string, category: string): Promise<void> => {
  return await invoke<void>("edit_error_event", { path, eventId, text, category });
};

export const toggleClipFavorite = async (path: string): Promise<boolean> => {
  return await invoke<boolean>("toggle_clip_favorite", { path });
};

export interface AppConfig {
  save_directory: string;
  riot_api_key: string;
  auto_dataset_generator: boolean;
  max_storage_gb: number;
  auto_prune_days: number;
}

export const getAppConfig = async (): Promise<AppConfig> => {
  return await invoke<AppConfig>("get_app_config");
};

export const setAppConfig = async (saveDirectory: string, riotApiKey: string, autoDatasetGenerator: boolean, maxStorageGb: number, autoPruneDays: number): Promise<void> => {
  return await invoke<void>("set_app_config", { saveDirectory, riotApiKey, autoDatasetGenerator, maxStorageGb, autoPruneDays });
};

export interface ProcessVodResponse {
  success: boolean;
  message: string;
  metadata: any | null;
}

export const processVod = async (videoPath: string): Promise<ProcessVodResponse> => {
  return await invoke<ProcessVodResponse>("process_vod", { videoPath });
};

export const cancelVod = async (): Promise<void> => {
  return await invoke<void>("cancel_vod");
};

// Detalle completo de una partida/VOD (incluye mouse_events). El listado los
// omite por rendimiento; el reproductor los pide aquí bajo demanda.
export const getMatchDetails = async (id: string): Promise<MatchMetadata | null> => {
  return await invoke<MatchMetadata | null>("get_match_details", { id });
};

// Persiste los comentarios (con marca de tiempo) de una partida en su JSON.
export const saveMatchComments = async (matchId: string, comments: Comment[]): Promise<void> => {
  return await invoke<void>("save_match_comments", { matchId, comments });
};

// Rellena el scoreboard (10 jugadores) de una partida ya sincronizada con Riot.
export const syncMatchNow = async (matchId: string): Promise<MatchMetadata> => {
  return await invoke<MatchMetadata>("sync_match_now", { matchId });
};

// Marca o desmarca un suceso como revisado. El estado vive en el JSON de la
// partida, junto a los comentarios: revisar es una tarea con estado y tiene que
// sobrevivir a cerrar la app.
export const setEventReviewed = async (
  matchId: string,
  time: number,
  reviewed: boolean
): Promise<void> => {
  return await invoke<void>("set_event_reviewed", { matchId, time, reviewed });
};

// Marca o desmarca un clip de error como revisado. Vive en el JSON del clip y no
// en el de la partida porque un error marcado no es un suceso de la partida.
export const setErrorClipReviewed = async (
  path: string,
  reviewed: boolean
): Promise<void> => {
  return await invoke<void>("set_error_clip_reviewed", { path, reviewed });
};
