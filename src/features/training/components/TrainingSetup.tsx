import React, { useEffect, useState } from "react";
import { Keyboard, Plus, Trash2, Save, Check, Eye } from "lucide-react";
import {
  CameraBinding,
  KeyProblem,
  TrainingConfig,
  keyProblem,
  normalizeKey,
  previewMetronomeOverlay,
  setTrainingConfig,
} from "../api";
import { useT } from "../../../core/LanguageProvider";
import { roleLabel, sameRole } from "../../../core/roles";

/** Valores GUARDADOS de los puestos. No se pintan tal cual: ver `roleLabel`. */
const ROLE_OPTIONS = ["TOP", "JUNGLE", "MID", "ADC", "SUPPORT"];

/** Por qué no valía la tecla, dicho en una frase. */
const PROBLEM_TEXT: Record<KeyProblem, string> = {
  modifier: "Modifiers on their own can't be a camera key.",
  numpad: "The in-game reader doesn't understand numpad keys yet.",
  unsupported: "Unsupported key. Use a letter, a number, F1–F12, Space or Tab.",
};

/**
 * Botón que captura la siguiente tecla pulsada.
 *
 * Si la tecla no vale, se DICE y se sigue escuchando. Antes se descartaba en
 * silencio y además se dejaba de escuchar: el botón volvía a su estado normal
 * sin haber cambiado nada, que desde fuera es indistinguible de un botón roto.
 */
const KeyCapture: React.FC<{ value: string; onChange: (k: string) => void }> = ({
  value,
  onChange,
}) => {
  const [listening, setListening] = useState(false);
  const [problem, setProblem] = useState<KeyProblem | null>(null);
  const t = useT();

  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      // Escape cancela: quedarse atrapado escuchando no era una salida.
      if (e.key === "Escape") { setListening(false); setProblem(null); return; }
      const k = normalizeKey(e);
      if (k) {
        onChange(k);
        setListening(false);
        setProblem(null);
        return;
      }
      setProblem(keyProblem(e));
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [listening, onChange]);

  return (
    <span style={styles.keyCapture}>
      <button
        className={listening ? "btn btn--primary btn--sm" : "btn btn--ghost btn--sm"}
        style={styles.keyBtn}
        onClick={() => { setListening(true); setProblem(null); }}
        title={listening ? t("Press a key, or Escape to cancel") : t("Change key")}
      >
        {listening ? t("press…") : value || "—"}
      </button>
      {problem && <span style={styles.keyProblem}>{t(PROBLEM_TEXT[problem])}</span>}
    </span>
  );
};

/**
 * Configuración del entrenamiento: qué tecla mira a qué rol, más los ajustes del
 * metrónomo y del muestreo. Todo lo demás (drills, quiz) lee de aquí.
 */
export const TrainingSetup: React.FC<{
  config: TrainingConfig;
  onSaved: (cfg: TrainingConfig) => void;
  /** Se llama cuando hay (o deja de haber) cambios sin guardar. */
  onDirtyChange?: (dirty: boolean) => void;
}> = ({ config, onSaved, onDirtyChange }) => {
  const [draft, setDraft] = useState<TrainingConfig>(config);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const t = useT();

  useEffect(() => setDraft(config), [config]);

  // "Guardado" es un hecho sobre el borrador que se guardó, no un estado
  // permanente del botón: en cuanto se toca algo, deja de ser verdad.
  const dirty = JSON.stringify(draft) !== JSON.stringify(config);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { if (dirty) setSaved(false); }, [dirty]);

  /**
   * Los `min`/`max` de un `<input type=number>` no impiden escribir: sólo
   * marcan el campo como inválido. Un 0 en el intervalo del metrónomo llegaba
   * tal cual al backend. Se acota aquí, al leerlo.
   */
  const clamped = (raw: string, min: number, max: number, fallback: number): number => {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  };

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
      setError(t("Key \"{k}\" is assigned to more than one role.", { k: dupe }));
      return;
    }
    try {
      const cfg = await setTrainingConfig(draft);
      onSaved(cfg);
      setSaved(true);
    } catch (e) {
      setError(t("Couldn't save the training settings: {msg}", { msg: String(e) }));
    }
  };

  return (
    <div style={styles.panel}>
      <div style={styles.headerRow}>
        <Keyboard size={18} color="var(--cool)" />
        <h3 style={styles.title}>{t("Camera keys")}</h3>
      </div>
      <p style={styles.desc}>
        {t("The key you actually press in game for each ally, in TAB order. Everything else — drills, metronome, post-game stats — reads from this.")}
      </p>

      <div style={styles.bindings}>
        {draft.bindings.map((b, i) => (
          <div key={i} style={styles.bindingRow}>
            <KeyCapture value={b.key} onChange={(k) => patchBinding(i, { key: k })} />
            {/* Un `value` que no case con ninguna `option` NO da error: el
                select enseña la primera, o sea que un rol guardado en otra
                grafía ("mid" en vez de "MID") se veía como "Top" y el desplegable
                mentía sobre lo que hay en disco. Se casa por rol, no por
                cadena, y lo que no se reconozca se enseña tal cual. */}
            {(() => {
              const conocido = ROLE_OPTIONS.find((r) => sameRole(r, b.role));
              return (
                <select
                  value={conocido ?? b.role}
                  onChange={(e) => patchBinding(i, { role: e.target.value })}
                  style={styles.select}
                >
                  {/* El VALOR es el que se guarda; lo que se lee es la etiqueta. */}
                  {ROLE_OPTIONS.map((r) => (
                    <option key={r} value={r}>
                      {t(roleLabel(r))}
                    </option>
                  ))}
                  {!conocido && <option value={b.role}>{b.role}</option>}
                </select>
              );
            })()}
            <button
              className="icon-btn icon-btn--danger"
              onClick={() => removeBinding(i)}
              title={t("Remove")}
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
        {draft.bindings.length < ROLE_OPTIONS.length && (
          <button className="btn btn--ghost btn--sm" style={styles.chip} onClick={addBinding}>
            <Plus size={14} /> {t("Add key")}
          </button>
        )}
      </div>

      <div style={styles.divider} />

      <div style={styles.settingRow}>
        <div>
          <div style={styles.settingLabel}>{t("Recentre key")}</div>
          <div style={styles.settingHint}>
            {t("Snapping back to yourself has to be part of the same gesture.")}
          </div>
        </div>
        <KeyCapture value={draft.self_key} onChange={(k) => patch({ self_key: k })} />
      </div>

      <div style={styles.settingRow}>
        <div>
          <div style={styles.settingLabel}>{t("In-game metronome")}</div>
          <div style={styles.settingHint}>
            {t("A transparent overlay asks you to check an ally every N seconds.")}
            {/* La salvedad vivía sólo en el tooltip del botón de prueba, o sea
                que la leía quien ya sospechaba. Es la razón número uno de que el
                overlay "no funcione", y va a la vista. */}
            <div style={styles.caveat}>
              {t("It only draws over borderless or windowed games. In exclusive fullscreen the game owns the screen and nothing can paint on top.")}
            </div>
          </div>
        </div>
        <div style={styles.settingControls}>
          <button
            className={draft.metronome_enabled ? "btn btn--primary btn--sm" : "btn btn--ghost btn--sm"}
            style={styles.chip}
            onClick={() => patch({ metronome_enabled: !draft.metronome_enabled })}
          >
            {t(draft.metronome_enabled ? "On" : "Off")}
          </button>
          <input
            type="number"
            min={5}
            max={120}
            value={draft.metronome_interval_secs}
            onChange={(e) => patch({ metronome_interval_secs: clamped(e.target.value, 5, 120, draft.metronome_interval_secs) })}
            style={styles.number}
          />
          <span style={styles.unit}>{t("sec")}</span>
          <button
            className="btn btn--ghost btn--sm"
            style={styles.chip}
            onClick={() => previewMetronomeOverlay().catch((e) => setError(t("Couldn't show the overlay: {msg}", { msg: String(e) })))}
            title={t("Show the overlay for a few seconds. Run it with the game open to confirm it draws on top.")}
          >
            <Eye size={14} /> {t("Test")}
          </button>
        </div>
      </div>

      <div style={styles.settingRow}>
        <div>
          <div style={styles.settingLabel}>{t("Post-game quiz")}</div>
          <div style={styles.settingHint}>
            {t("Samples the live game state every N seconds so the quiz can be auto-graded.")}
          </div>
        </div>
        <div style={styles.settingControls}>
          <button
            className={draft.awareness_quiz_enabled ? "btn btn--primary btn--sm" : "btn btn--ghost btn--sm"}
            style={styles.chip}
            onClick={() => patch({ awareness_quiz_enabled: !draft.awareness_quiz_enabled })}
          >
            {t(draft.awareness_quiz_enabled ? "On" : "Off")}
          </button>
          <input
            type="number"
            min={1}
            max={60}
            value={draft.snapshot_interval_secs}
            onChange={(e) => patch({ snapshot_interval_secs: clamped(e.target.value, 1, 60, draft.snapshot_interval_secs) })}
            style={styles.number}
          />
          <span style={styles.unit}>{t("sec")}</span>
        </div>
      </div>

      <div style={styles.settingRow}>
        <div>
          <div style={styles.settingLabel}>{t("Flash duration")}</div>
          <div style={styles.settingHint}>
            {t("How long the recall drill shows each frame. Lower is harder.")}
          </div>
        </div>
        <div style={styles.settingControls}>
          <input
            type="number"
            min={100}
            max={2000}
            step={50}
            value={draft.flash_ms}
            onChange={(e) => patch({ flash_ms: clamped(e.target.value, 100, 2000, draft.flash_ms) })}
            style={styles.number}
          />
          <span style={styles.unit}>ms</span>
        </div>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      <div style={styles.saveRow}>
        <button
          className="btn btn--primary"
          style={styles.saveBtn}
          onClick={save}
          disabled={!dirty && saved}
        >
          {saved && !dirty ? <Check size={16} /> : <Save size={16} />}
          {t(saved && !dirty ? "Saved" : "Save")}
        </button>
        {dirty && <span style={styles.dirtyHint}>{t("Unsaved changes")}</span>}
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  panel: {
    background: "var(--surface-1)",
    border: "1px solid var(--line-soft)",
    borderRadius: "var(--radius-xl)",
    padding: "var(--space-6)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--space-4)",
    maxWidth: 720,
  },
  headerRow: { display: "flex", alignItems: "center", gap: "var(--space-3)" },
  title: { margin: 0, fontSize: "var(--font-lg)", fontWeight: 700, color: "var(--text)" },
  desc: { margin: 0, fontSize: "var(--font-sm)", color: "var(--muted)" },
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
    background: "var(--surface-2)",
    color: "var(--text)",
    border: "1px solid var(--line)",
    borderRadius: "var(--radius-md)",
    padding: "8px 10px",
    fontSize: "var(--font-sm)",
    fontFamily: "var(--font-sans)",
  },
  chip: { padding: "6px 14px", fontSize: "var(--font-xs)", alignSelf: "flex-start" },
  keyCapture: { display: "inline-flex", flexDirection: "column", gap: 4 },
  keyProblem: { fontSize: "var(--font-xs)", color: "var(--loss)", maxWidth: 220 },
  caveat: { marginTop: 4, fontSize: "var(--font-xs)", color: "var(--faint)", maxWidth: 420 },
  saveRow: { display: "flex", alignItems: "center", gap: "var(--space-3)" },
  dirtyHint: { fontSize: "var(--font-xs)", color: "var(--brand)" },
  divider: { height: 1, background: "var(--line-soft)" },
  settingRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "var(--space-4)",
  },
  settingLabel: { fontSize: "var(--font-sm)", fontWeight: 600, color: "var(--text)" },
  settingHint: { fontSize: "var(--font-xs)", color: "var(--faint)", marginTop: 2, maxWidth: 420 },
  settingControls: { display: "flex", alignItems: "center", gap: "var(--space-2)", flexShrink: 0 },
  number: {
    width: 68,
    background: "var(--surface-2)",
    color: "var(--text)",
    border: "1px solid var(--line)",
    borderRadius: "var(--radius-md)",
    padding: "8px 10px",
    fontSize: "var(--font-sm)",
    fontFamily: "var(--font-mono)",
  },
  unit: { fontSize: "var(--font-xs)", color: "var(--faint)", width: 24 },
  saveBtn: { padding: "10px 24px", alignSelf: "flex-start" },
  error: {
    padding: "var(--space-3)",
    borderRadius: "var(--radius-md)",
    background: "var(--danger-soft)",
    color: "var(--loss)",
    fontSize: "var(--font-sm)",
  },
};
