import React, { useEffect, useState } from "react";
import { Keyboard, Plus, Trash2, Save, Check, Eye } from "lucide-react";
import {
  CameraBinding,
  TrainingConfig,
  normalizeKey,
  previewMetronomeOverlay,
  setTrainingConfig,
} from "../api";

const ROLE_OPTIONS = ["TOP", "JUNGLE", "MID", "ADC", "SUPPORT"];

/** Botón que captura la siguiente tecla pulsada. */
const KeyCapture: React.FC<{ value: string; onChange: (k: string) => void }> = ({
  value,
  onChange,
}) => {
  const [listening, setListening] = useState(false);

  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      const k = normalizeKey(e);
      if (k) onChange(k);
      setListening(false);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [listening, onChange]);

  return (
    <button
      className={listening ? "btn-primary" : "btn-ghost"}
      style={styles.keyBtn}
      onClick={() => setListening(true)}
    >
      {listening ? "press…" : value || "—"}
    </button>
  );
};

/**
 * Configuración del entrenamiento: qué tecla mira a qué rol, más los ajustes del
 * metrónomo y del muestreo. Todo lo demás (drills, quiz) lee de aquí.
 */
export const TrainingSetup: React.FC<{
  config: TrainingConfig;
  onSaved: (cfg: TrainingConfig) => void;
}> = ({ config, onSaved }) => {
  const [draft, setDraft] = useState<TrainingConfig>(config);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => setDraft(config), [config]);

  const patch = (p: Partial<TrainingConfig>) => {
    setDraft((d) => ({ ...d, ...p }));
    setSaved(false);
  };

  const patchBinding = (i: number, p: Partial<CameraBinding>) => {
    setDraft((d) => ({
      ...d,
      bindings: d.bindings.map((b, idx) => (idx === i ? { ...b, ...p } : b)),
    }));
    setSaved(false);
  };

  const addBinding = () => {
    const used = draft.bindings.map((b) => b.role);
    const role = ROLE_OPTIONS.find((r) => !used.includes(r)) ?? "TOP";
    patch({ bindings: [...draft.bindings, { key: "", role }] });
  };

  const removeBinding = (i: number) =>
    patch({ bindings: draft.bindings.filter((_, idx) => idx !== i) });

  const save = async () => {
    setError(null);
    // Un mismo dedo no puede mirar a dos sitios: avisamos antes de que el backend
    // acepte una config en la que la primera coincidencia se come a la segunda.
    const keys = draft.bindings.map((b) => b.key.toUpperCase());
    const dupe = keys.find((k, i) => k && keys.indexOf(k) !== i);
    if (dupe) {
      setError(`Key "${dupe}" is assigned to more than one role.`);
      return;
    }
    try {
      const cfg = await setTrainingConfig(draft);
      onSaved(cfg);
      setSaved(true);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div style={styles.panel}>
      <div style={styles.headerRow}>
        <Keyboard size={18} color="var(--accent-violet)" />
        <h3 style={styles.title}>Camera keys</h3>
      </div>
      <p style={styles.desc}>
        The key you actually press in game for each ally, in TAB order. Everything else —
        drills, metronome, post-game stats — reads from this.
      </p>

      <div style={styles.bindings}>
        {draft.bindings.map((b, i) => (
          <div key={i} style={styles.bindingRow}>
            <KeyCapture value={b.key} onChange={(k) => patchBinding(i, { key: k })} />
            <select
              value={b.role}
              onChange={(e) => patchBinding(i, { role: e.target.value })}
              style={styles.select}
            >
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <button
              className="icon-btn icon-btn--danger"
              onClick={() => removeBinding(i)}
              title="Remove"
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
        {draft.bindings.length < ROLE_OPTIONS.length && (
          <button className="btn-ghost" style={styles.chip} onClick={addBinding}>
            <Plus size={14} /> Add key
          </button>
        )}
      </div>

      <div style={styles.divider} />

      <div style={styles.settingRow}>
        <div>
          <div style={styles.settingLabel}>Recentre key</div>
          <div style={styles.settingHint}>
            Snapping back to yourself has to be part of the same gesture.
          </div>
        </div>
        <KeyCapture value={draft.self_key} onChange={(k) => patch({ self_key: k })} />
      </div>

      <div style={styles.settingRow}>
        <div>
          <div style={styles.settingLabel}>In-game metronome</div>
          <div style={styles.settingHint}>
            A transparent overlay asks you to check an ally every N seconds.
          </div>
        </div>
        <div style={styles.settingControls}>
          <button
            className={draft.metronome_enabled ? "btn-primary" : "btn-ghost"}
            style={styles.chip}
            onClick={() => patch({ metronome_enabled: !draft.metronome_enabled })}
          >
            {draft.metronome_enabled ? "On" : "Off"}
          </button>
          <input
            type="number"
            min={5}
            max={120}
            value={draft.metronome_interval_secs}
            onChange={(e) => patch({ metronome_interval_secs: Number(e.target.value) })}
            style={styles.number}
          />
          <span style={styles.unit}>sec</span>
          <button
            className="btn-ghost"
            style={styles.chip}
            onClick={() => previewMetronomeOverlay().catch((e) => setError(String(e)))}
            title="Show the overlay for a few seconds. Run it with the game open to confirm it draws on top — it will not over exclusive fullscreen, only borderless."
          >
            <Eye size={14} /> Test
          </button>
        </div>
      </div>

      <div style={styles.settingRow}>
        <div>
          <div style={styles.settingLabel}>Post-game quiz</div>
          <div style={styles.settingHint}>
            Samples the live game state every N seconds so the quiz can be auto-graded.
          </div>
        </div>
        <div style={styles.settingControls}>
          <button
            className={draft.awareness_quiz_enabled ? "btn-primary" : "btn-ghost"}
            style={styles.chip}
            onClick={() => patch({ awareness_quiz_enabled: !draft.awareness_quiz_enabled })}
          >
            {draft.awareness_quiz_enabled ? "On" : "Off"}
          </button>
          <input
            type="number"
            min={1}
            max={60}
            value={draft.snapshot_interval_secs}
            onChange={(e) => patch({ snapshot_interval_secs: Number(e.target.value) })}
            style={styles.number}
          />
          <span style={styles.unit}>sec</span>
        </div>
      </div>

      <div style={styles.settingRow}>
        <div>
          <div style={styles.settingLabel}>Flash duration</div>
          <div style={styles.settingHint}>
            How long the recall drill shows each frame. Lower is harder.
          </div>
        </div>
        <div style={styles.settingControls}>
          <input
            type="number"
            min={100}
            max={2000}
            step={50}
            value={draft.flash_ms}
            onChange={(e) => patch({ flash_ms: Number(e.target.value) })}
            style={styles.number}
          />
          <span style={styles.unit}>ms</span>
        </div>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      <button className="btn-primary" style={styles.saveBtn} onClick={save}>
        {saved ? <Check size={16} /> : <Save size={16} />}
        {saved ? "Saved" : "Save"}
      </button>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  panel: {
    background: "var(--bg-card)",
    border: "1px solid var(--border-subtle)",
    borderRadius: "var(--radius-xl)",
    padding: "var(--space-6)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-4)",
    maxWidth: 720,
  },
  headerRow: { display: "flex", alignItems: "center", gap: "var(--space-3)" },
  title: { margin: 0, fontSize: "var(--font-lg)", fontWeight: 700, color: "var(--text)" },
  desc: { margin: 0, fontSize: "var(--font-sm)", color: "var(--text-secondary)" },
  bindings: { display: "flex", flexDirection: "column", gap: "var(--space-2)" },
  bindingRow: { display: "flex", alignItems: "center", gap: "var(--space-3)" },
  keyBtn: {
    width: 72,
    justifyContent: "center",
    padding: "8px 0",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--font-sm)",
    fontWeight: 700,
  },
  select: {
    flex: 1,
    maxWidth: 200,
    background: "var(--bg-elevated)",
    color: "var(--text-primary)",
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--radius-md)",
    padding: "8px 10px",
    fontSize: "var(--font-sm)",
    fontFamily: "var(--font-sans)",
  },
  chip: { padding: "6px 14px", fontSize: "var(--font-xs)", alignSelf: "flex-start" },
  divider: { height: 1, background: "var(--border-subtle)" },
  settingRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--space-4)",
  },
  settingLabel: { fontSize: "var(--font-sm)", fontWeight: 600, color: "var(--text-primary)" },
  settingHint: { fontSize: "var(--font-xs)", color: "var(--text-muted)", marginTop: 2, maxWidth: 420 },
  settingControls: { display: "flex", alignItems: "center", gap: "var(--space-2)", flexShrink: 0 },
  number: {
    width: 68,
    background: "var(--bg-elevated)",
    color: "var(--text-primary)",
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--radius-md)",
    padding: "8px 10px",
    fontSize: "var(--font-sm)",
    fontFamily: "var(--font-mono)",
  },
  unit: { fontSize: "var(--font-xs)", color: "var(--text-muted)", width: 24 },
  saveBtn: { padding: "10px 24px", alignSelf: "flex-start" },
  error: {
    padding: "var(--space-3)",
    borderRadius: "var(--radius-md)",
    background: "var(--danger-soft)",
    color: "var(--color-defeat)",
    fontSize: "var(--font-sm)",
  },
};
