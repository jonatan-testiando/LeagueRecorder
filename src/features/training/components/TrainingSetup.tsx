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
import { Select } from "../../../components/ui/Select";
import { Button } from "../../../components/ui/Button";
import { Segmented } from "../../../components/ui/Segmented";
import "./TrainingPanel.css";

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
const KeyCapture: React.FC<{ value: string; onChange: (k: string) => void; label?: string }> = ({
  value,
  onChange,
  label,
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

  // Fragmento y no envoltorio: el aviso es un hijo más de la fila, que lo baja
  // a su propia línea (ver .trn-keycap__problem).
  return (
    <>
      <button
        type="button"
        className="trn-key"
        data-listening={listening || undefined}
        onClick={() => { setListening(true); setProblem(null); }}
        title={listening ? t("Press a key, or Escape to cancel") : t("Change key")}
        aria-label={label ? `${label}: ${value || "—"}` : undefined}
      >
        {listening ? t("press…") : value || "—"}
      </button>
      {problem && <p className="trn-keycap__problem t-small" role="alert">{t(PROBLEM_TEXT[problem])}</p>}
    </>
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

  // Encendido o apagado: el segmentado de Ajustes. Antes era un botón que
  // decía «Activado» y no se sabía si era el estado o la acción.
  const onOff = (on: boolean, set: (v: boolean) => void, label: string) => (
    <Segmented
      label={label}
      value={on ? "on" : "off"}
      onChange={(v) => set(v === "on")}
      options={[
        { value: "off" as const, label: t("Off") },
        { value: "on" as const, label: t("On") },
      ]}
    />
  );

  return (
    <>
      <section className="card trn-card">
        <header className="trn-card__head">
          <Keyboard size={18} />
          <h2 className="trn-card__title t-card">{t("Camera keys")}</h2>
        </header>
        <p className="trn-desc t-body">
          {t("The key you actually press in game for each ally, in TAB order. Everything else — drills, metronome, post-game stats — reads from this.")}
        </p>

        <div className="trn-binds">
          {draft.bindings.map((b, i) => (
            <div key={i} className="trn-bind">
              <KeyCapture value={b.key} onChange={(k) => patchBinding(i, { key: k })} label={t(roleLabel(b.role))} />
              {/* Un `value` que no case con ninguna `option` NO da error: el
                  select enseña la primera, o sea que un rol guardado en otra
                  grafía ("mid" en vez de "MID") se veía como "Top" y el desplegable
                  mentía sobre lo que hay en disco. Se casa por rol, no por
                  cadena, y lo que no se reconozca se enseña tal cual. */}
              {(() => {
                const conocido = ROLE_OPTIONS.find((r) => sameRole(r, b.role));
                return (
                  // El VALOR es el que se guarda; lo que se lee es la etiqueta.
                  <Select
                    label={t("Role")}
                    value={conocido ?? b.role}
                    onChange={(v) => patchBinding(i, { role: v })}
                    options={[
                      ...ROLE_OPTIONS.map((r) => ({ value: r as string, label: t(roleLabel(r)) })),
                      ...(!conocido ? [{ value: b.role, label: b.role }] : []),
                    ]}
                  />
                );
              })()}
              <Button
                variant="danger"
                className="trn-bind__del"
                icon={<Trash2 size={16} />}
                onClick={() => removeBinding(i)}
                title={t("Remove")}
                aria-label={t("Remove")}
              />
            </div>
          ))}
        </div>
        {draft.bindings.length < ROLE_OPTIONS.length && (
          <div>
            <Button size="sm" icon={<Plus size={14} />} onClick={addBinding}>
              {t("Add key")}
            </Button>
          </div>
        )}
      </section>

      <section className="card trn-rows">
        <Row title={t("Recentre key")} help={t("Snapping back to yourself has to be part of the same gesture.")}>
          <KeyCapture value={draft.self_key} onChange={(k) => patch({ self_key: k })} label={t("Recentre key")} />
        </Row>

        {/* La salvedad vivía sólo en el tooltip del botón de prueba, o sea
            que la leía quien ya sospechaba. Es la razón número uno de que el
            overlay "no funcione", y va a la vista. */}
        <Row
          title={t("In-game metronome")}
          help={t("A transparent overlay asks you to check an ally every N seconds.")}
          note={t("It only draws over borderless or windowed games. In exclusive fullscreen the game owns the screen and nothing can paint on top.")}
        >
          {onOff(draft.metronome_enabled, (v) => patch({ metronome_enabled: v }), t("In-game metronome"))}
          <input
            type="number"
            className="field field--num"
            aria-label={t("In-game metronome")}
            min={5}
            max={120}
            value={draft.metronome_interval_secs}
            onChange={(e) => patch({ metronome_interval_secs: clamped(e.target.value, 5, 120, draft.metronome_interval_secs) })}
          />
          <span className="trn-unit t-small">{t("sec")}</span>
          <Button
            size="sm"
            icon={<Eye size={14} />}
            onClick={() => previewMetronomeOverlay().catch((e) => setError(t("Couldn't show the overlay: {msg}", { msg: String(e) })))}
            title={t("Show the overlay for a few seconds. Run it with the game open to confirm it draws on top.")}
          >
            {t("Test")}
          </Button>
        </Row>

        <Row
          title={t("Post-game quiz")}
          help={t("Samples the live game state every N seconds so the quiz can be auto-graded.")}
        >
          {onOff(draft.awareness_quiz_enabled, (v) => patch({ awareness_quiz_enabled: v }), t("Post-game quiz"))}
          <input
            type="number"
            className="field field--num"
            aria-label={t("Post-game quiz")}
            min={1}
            max={60}
            value={draft.snapshot_interval_secs}
            onChange={(e) => patch({ snapshot_interval_secs: clamped(e.target.value, 1, 60, draft.snapshot_interval_secs) })}
          />
          <span className="trn-unit t-small">{t("sec")}</span>
        </Row>

        <Row
          title={t("Flash duration")}
          help={t("How long the recall drill shows each frame. Lower is harder.")}
        >
          <input
            type="number"
            className="field field--num"
            aria-label={t("Flash duration")}
            min={100}
            max={2000}
            step={50}
            value={draft.flash_ms}
            onChange={(e) => patch({ flash_ms: clamped(e.target.value, 100, 2000, draft.flash_ms) })}
          />
          <span className="trn-unit t-small">ms</span>
        </Row>
      </section>

      {error && <p className="trn-error t-body" role="alert">{error}</p>}

      <div className="trn-save">
        <Button
          variant="primary"
          icon={saved && !dirty ? <Check size={16} /> : <Save size={16} />}
          onClick={save}
          disabled={!dirty && saved}
        >
          {t(saved && !dirty ? "Saved" : "Save")}
        </Button>
        {dirty && <span className="trn-save__dirty t-small">{t("Unsaved changes")}</span>}
      </div>
    </>
  );
};

/**
 * Fila de ajuste, como en Ajustes: título y ayuda a la izquierda, controles a
 * la derecha. Fuera del componente para que React no la remonte en cada
 * pintado (los campos perderían el foco a cada tecla).
 */
const Row: React.FC<{
  title: string;
  help?: string;
  /** Salvedad que tiene que verse, debajo de la ayuda y un tono más baja. */
  note?: string;
  children: React.ReactNode;
}> = ({ title, help, note, children }) => (
  <div className="trn-row">
    <div>
      <h3 className="trn-row__title t-body-strong">{title}</h3>
      {help && <p className="trn-row__help t-small">{help}</p>}
      {note && <p className="trn-row__note t-small">{note}</p>}
    </div>
    <div className="trn-row__ctl">{children}</div>
  </div>
);
