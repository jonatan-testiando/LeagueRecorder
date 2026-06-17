import { invoke } from "@tauri-apps/api/core";
import { MatchMetadata, AudioStatus, UltimateSettings, VideoSettings } from "../types";

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

export const getUltimateSettings = async (): Promise<UltimateSettings> => {
  return await invoke<UltimateSettings>("get_ultimate_settings");
};

export const setUltimateSettings = async (enabled: boolean, key: string): Promise<UltimateSettings> => {
  return await invoke<UltimateSettings>("set_ultimate_settings", { enabled, key });
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
}

export const getAppConfig = async (): Promise<AppConfig> => {
  return await invoke<AppConfig>("get_app_config");
};

export const setAppConfig = async (saveDirectory: string, riotApiKey: string): Promise<void> => {
  return await invoke<void>("set_app_config", { saveDirectory, riotApiKey });
};
