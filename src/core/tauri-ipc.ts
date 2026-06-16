import { invoke } from "@tauri-apps/api/core";
import { MatchMetadata, AudioStatus, UltimateSettings } from "../types";

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
