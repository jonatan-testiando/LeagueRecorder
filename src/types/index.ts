export type MatchEventType =
  | 'GameStart'
  | 'GameEnd'
  | 'ChampionKill'
  | 'Multikill'
  | 'FirstBlood'
  | 'TowerKill'
  | 'InhibKill'
  | 'DragonKill'
  | 'BaronKill'
  | 'HeraldKill'
  | 'Ultimate';

export interface MatchEvent {
  type: MatchEventType | string;
  // kill/death/assist para ChampionKill; ally/enemy para objetivos; win/lose para GameEnd; R para Ultimate
  subtype?: 'kill' | 'death' | 'assist' | 'ally' | 'enemy' | 'win' | 'lose' | 'R' | string;
  time: number; // Marca de tiempo en segundos
  description: string;
}

export interface UltimateSettings {
  enabled: boolean;
  key: string;
}

export interface MouseEventData {
  t: number;
  x: number;
  y: number;
  evt: string; // "move", "left_click", "right_click"
}

export interface MatchMetadata {
  id: string;
  game_duration: number;
  video_path: string;
  result: string; // 'Victory' | 'Defeat' | 'Unknown'
  champion: string;
  date: string; // Formato YYYY-MM-DD HH:MM:SS
  events: MatchEvent[];
  apm?: number; // Acciones por minuto promedio
  apm_series?: number[]; // APM por minuto de juego
  mouse_events?: MouseEventData[];
}

export interface ClipMetadata {
  path: string;
  name: string;
  match_id: string;
  size: number; // Tamaño del archivo en bytes
}

export interface AudioStatus {
  system_audio_device: string | null;
  all_devices: string[];
  ready_for_game_audio: boolean;
}

export interface VideoSettings {
  fps: number;
  quality: string;
}
