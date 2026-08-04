import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

export interface CameraBinding {
  key: string;
  role: string;
}

export interface TrainingConfig {
  bindings: CameraBinding[];
  self_key: string;
  metronome_enabled: boolean;
  metronome_interval_secs: number;
  metronome_window_secs: number;
  flash_ms: number;
  snapshot_interval_secs: number;
  awareness_quiz_enabled: boolean;
}

export const getTrainingConfig = (): Promise<TrainingConfig> =>
  invoke<TrainingConfig>("get_training_config");

export const setTrainingConfig = (config: TrainingConfig): Promise<TrainingConfig> =>
  invoke<TrainingConfig>("set_training_config", { config });

/** Muestra el overlay ~4s con un aviso de ejemplo, para colocarlo y comprobar que se ve. */
export const previewMetronomeOverlay = (): Promise<void> =>
  invoke<void>("preview_metronome_overlay");

// ---------------------------------------------------------------------------
// Sesiones de drill
// ---------------------------------------------------------------------------

export interface RoleStat {
  role: string;
  attempts: number;
  hits: number;
  avg_latency_ms: number;
}

export interface DrillSession {
  id: string;
  date: string;
  /** "reflex" (mapeo tecla→rol) | "recall" (lectura rápida) */
  kind: string;
  rounds: number;
  hits: number;
  avg_latency_ms: number;
  best_latency_ms: number;
  per_role: RoleStat[];
  mode: string;
}

export const getDrillSessions = (limit = 50): Promise<DrillSession[]> =>
  invoke<DrillSession[]>("get_drill_sessions", { limit });

export const saveDrillSession = (session: DrillSession): Promise<void> =>
  invoke<void>("save_drill_session", { session });

// ---------------------------------------------------------------------------
// Awareness
// ---------------------------------------------------------------------------

export interface CameraStats {
  total_presses: number;
  presses_per_minute: number;
  longest_gap_secs: number;
  per_role: [string, number][];
  duration_secs: number;
}

export interface QuizQuestion {
  id: string;
  prompt: string;
  options: string[];
  subject: string;
  at_seconds: number;
}

export interface QuizPayload {
  quiz_id: string;
  match_id: string;
  questions: QuizQuestion[];
  camera: CameraStats | null;
}

export interface AnswerResult {
  question_id: string;
  prompt: string;
  chosen: string;
  correct: string;
  is_correct: boolean;
  at_seconds: number;
}

export interface QuizResult {
  quiz_id: string;
  date: string;
  score: number;
  total: number;
  answers: AnswerResult[];
}

export interface AwarenessSummary {
  match_id: string;
  date: string;
  champion: string;
  snapshots: number;
  camera: CameraStats;
  last_score: number | null;
  last_total: number | null;
  answered: boolean;
  /** [avisos atendidos, avisos lanzados] del metrónomo; null si no estaba activo. */
  metronome: [number, number] | null;
}

export const listAwarenessRecords = (): Promise<AwarenessSummary[]> =>
  invoke<AwarenessSummary[]>("list_awareness_records");

export const generateAwarenessQuiz = (
  matchId: string,
  count = 5,
  regenerate = false
): Promise<QuizPayload> =>
  invoke<QuizPayload>("generate_awareness_quiz", { matchId, count, regenerate });

export const submitAwarenessQuiz = (
  matchId: string,
  answers: Record<string, string>
): Promise<QuizResult> =>
  invoke<QuizResult>("submit_awareness_quiz", { matchId, answers });

export interface RoleChampion {
  role: string;
  champion: string;
}

export const getChampionPool = (): Promise<RoleChampion[]> =>
  invoke<RoleChampion[]>("get_champion_pool");

// ---------------------------------------------------------------------------
// Saltos de cámara (análisis del vídeo)
// ---------------------------------------------------------------------------

export interface SnapAnalysisResult {
  success: boolean;
  message: string;
  snaps: number;
  stills: number;
  per_minute: number;
  longest_gap_secs: number;
}

export interface SnapSummary {
  match_id: string;
  analyzed: boolean;
  snaps: number;
  per_minute: number;
  longest_gap_secs: number;
  stills: number;
}

export interface RecallFrame {
  match_id: string;
  t: number;
  /** Ruta absoluta en disco; se sirve con `streamUrl`. */
  path: string;
}

export const analyzeCameraSnaps = (matchId: string): Promise<SnapAnalysisResult> =>
  invoke<SnapAnalysisResult>("analyze_camera_snaps", { matchId });

export const getCameraSnapSummary = (matchId: string): Promise<SnapSummary> =>
  invoke<SnapSummary>("get_camera_snap_summary", { matchId });

export const listRecallFrames = (): Promise<RecallFrame[]> =>
  invoke<RecallFrame[]>("list_recall_frames");

/** Ruta local → URL servible por el protocolo `stream` registrado en Rust. */
export const streamUrl = (path: string): string =>
  `http://stream.localhost/${encodeURIComponent(path)}`;

// ---------------------------------------------------------------------------
// Utilidades compartidas
// ---------------------------------------------------------------------------

/** Segundos → "mm:ss". */
export const fmtClock = (secs: number): string => {
  const s = Math.max(0, Math.round(secs));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * Normaliza la tecla de un evento de teclado al mismo formato que guarda la
 * configuración: "1", "F3", "SPACE". Devuelve "" si no es una tecla utilizable.
 */
export const normalizeKey = (e: KeyboardEvent): string => {
  if (e.key === " " || e.code === "Space") return "SPACE";
  if (/^F\d{1,2}$/.test(e.key)) return e.key.toUpperCase();
  if (/^[0-9a-zA-Z]$/.test(e.key)) return e.key.toUpperCase();
  return "";
};
