import { useEffect, useRef, useState } from "react";
import type { AppConfig } from "../api";
import type { AppStore } from "../store";
import { QWEN38_CHAT_OPTIONS, QWEN38_DEFAULTS, QWEN38_SERVER_ARGS } from "./qwenDefaults";
import {
  clampNumber,
  isKnownSelectValue,
  MIROSTAT_OPTIONS,
  parseChatOptions,
  parseNumericInput,
  parseServerArgs,
  SPEC_DRAFT_NGL_OPTIONS,
  SPEC_TYPE_OPTIONS,
} from "./tuningValidation";
import { canRollbackAtRevision, draftStillCurrent } from "./tuningAsync";
import { projectorChangeAllowed } from "./visionState";
import type { ConfigPatch } from "../configSaveQueue";

type NumericKey =
  | "ngl"
  | "ctx_size"
  | "n_cpu_moe"
  | "threads"
  | "parallel"
  | "request_timeout_seconds"
  | "sleep_idle_seconds"
  | "temperature"
  | "top_p"
  | "top_k"
  | "spec_draft_n_max"
  | "spec_draft_n_min"
  | "spec_draft_p_min"
  | "spec_draft_p_split"
  | "reasoning_budget";
type ServerTextKey =
  | "spec_type"
  | "spec_draft_ngl"
  | "spec_draft_device"
  | "spec_draft_model"
  | "reasoning"
  | "reasoning_format"
  | "reasoning_budget_message"
  | "reasoning_preserve"
  | "mmproj";
type Phase = "idle" | "dirty" | "applying" | "failed";

interface NumericField {
  key: NumericKey;
  label: string;
  step: number;
  min: number;
  max: number;
  server: boolean;
  hint: string;
}

interface ChatOptionField {
  key: string;
  label: string;
  step: number;
  min: number;
  max: number;
  defaultValue: number;
  hint: string;
  options?: readonly { value: number; label: string }[];
}

const SERVER_FIELDS: NumericField[] = [
  { key: "ngl", label: "GPU layers (ngl)", step: 1, min: 0, max: 128, server: true, hint: "0–128. 0 keeps inference on CPU." },
  { key: "ctx_size", label: "Context size", step: 256, min: 512, max: 131072, server: true, hint: "512–131072 tokens. Restart required." },
  { key: "n_cpu_moe", label: "CPU MoE (n-cpu-moe)", step: 1, min: 0, max: 64, server: true, hint: "0–64 experts kept on CPU." },
  { key: "threads", label: "Threads", step: 1, min: 0, max: 64, server: true, hint: "0 = auto. Restart required." },
  { key: "parallel", label: "Server slots", step: 1, min: 0, max: 128, server: true, hint: "0 = auto. More slots increase concurrent memory use." },
  { key: "request_timeout_seconds", label: "Request timeout (seconds)", step: 1, min: 1, max: 86400, server: true, hint: "llama-server read/write timeout. Restart required." },
  { key: "sleep_idle_seconds", label: "Sleep after idle (seconds)", step: 1, min: -1, max: 604800, server: true, hint: "−1 disables sleep; llama.cpp releases idle compute state." },
];

const MTP_FIELDS: NumericField[] = [
  { key: "spec_draft_n_max", label: "Draft max tokens", step: 1, min: 0, max: 64, server: true, hint: "--spec-draft-n-max. Qwen3.8 default: 5." },
  { key: "spec_draft_n_min", label: "Draft min tokens", step: 1, min: 0, max: 64, server: true, hint: "--spec-draft-n-min. Default: 0." },
  { key: "spec_draft_p_min", label: "Draft min probability", step: 0.01, min: 0, max: 1, server: true, hint: "--spec-draft-p-min. 0 disables the threshold." },
  { key: "spec_draft_p_split", label: "Draft split probability", step: 0.01, min: 0, max: 1, server: true, hint: "--spec-draft-p-split. Qwen3.8 default: 0." },
];

const REASONING_FIELDS: NumericField[] = [
  { key: "reasoning_budget", label: "Reasoning token budget", step: 1, min: -1, max: 1048576, server: true, hint: "−1 is unlimited; 0 ends thinking immediately." },
];

const SAMPLING_FIELDS: NumericField[] = [
  { key: "temperature", label: "Temperature", step: 0.05, min: 0, max: 2, server: false, hint: "0–2. Higher = more random." },
  { key: "top_p", label: "Top-p", step: 0.01, min: 0.01, max: 1, server: false, hint: "0.01–1. Nucleus sampling." },
  { key: "top_k", label: "Top-k", step: 1, min: 1, max: 200, server: false, hint: "1–200. Candidate pool size." },
];

const ADVANCED_SAMPLING_FIELDS: ChatOptionField[] = [
  { key: "min_p", label: "Min-p", step: 0.01, min: 0, max: 1, defaultValue: 0.05, hint: "0 disables. Minimum probability relative to the best token." },
  { key: "top_n_sigma", label: "Top-n-sigma", step: 0.01, min: -1, max: 10, defaultValue: -1, hint: "−1 disables sigma sampling." },
  { key: "typical_p", label: "Typical-p", step: 0.01, min: 0, max: 1, defaultValue: 1, hint: "1 disables locally typical sampling." },
  { key: "xtc_probability", label: "XTC probability", step: 0.01, min: 0, max: 1, defaultValue: 0, hint: "0 disables XTC sampling." },
  { key: "xtc_threshold", label: "XTC threshold", step: 0.01, min: 0, max: 1, defaultValue: 0.1, hint: "1 disables XTC token filtering." },
  { key: "dynatemp_range", label: "Dynamic temperature range", step: 0.05, min: 0, max: 2, defaultValue: 0, hint: "0 disables dynamic temperature." },
  { key: "dynatemp_exponent", label: "Dynamic temperature exponent", step: 0.05, min: 0.1, max: 3, defaultValue: 1, hint: "Exponent used when dynamic temperature is enabled." },
  { key: "repeat_last_n", label: "Repeat last n", step: 1, min: -1, max: 131072, defaultValue: 64, hint: "−1 uses the context size; 0 disables repetition penalties." },
  { key: "repeat_penalty", label: "Repeat penalty", step: 0.01, min: 0, max: 2, defaultValue: 1, hint: "1 disables the traditional repetition penalty." },
  { key: "presence_penalty", label: "Presence penalty", step: 0.01, min: -2, max: 2, defaultValue: 0, hint: "0 disables presence penalty." },
  { key: "frequency_penalty", label: "Frequency penalty", step: 0.01, min: -2, max: 2, defaultValue: 0, hint: "0 disables frequency penalty." },
  { key: "dry_multiplier", label: "DRY multiplier", step: 0.05, min: 0, max: 2, defaultValue: 0, hint: "0 disables DRY repetition control." },
  { key: "dry_base", label: "DRY base", step: 0.05, min: 1, max: 3, defaultValue: 1.75, hint: "Exponential base for DRY penalties." },
  { key: "dry_allowed_length", label: "DRY allowed length", step: 1, min: 0, max: 128, defaultValue: 2, hint: "Repeated sequence length allowed before DRY applies." },
  { key: "dry_penalty_last_n", label: "DRY penalty last n", step: 1, min: 0, max: 131072, defaultValue: 64, hint: "0 disables the DRY scan window." },
  { key: "mirostat", label: "Mirostat mode", step: 1, min: 0, max: 2, defaultValue: 0, options: MIROSTAT_OPTIONS, hint: "0 off, 1 Mirostat, 2 Mirostat 2.0." },
  { key: "mirostat_lr", label: "Mirostat learning rate", step: 0.01, min: 0, max: 1, defaultValue: 0.1, hint: "Eta parameter used by Mirostat." },
  { key: "mirostat_ent", label: "Mirostat target entropy", step: 0.1, min: 0, max: 20, defaultValue: 5, hint: "Tau parameter used by Mirostat." },
  { key: "seed", label: "Seed", step: 1, min: -1, max: 4294967295, defaultValue: -1, hint: "−1 selects a random seed for each request." },
  { key: "max_tokens", label: "Max tokens", step: 1, min: -1, max: 131072, defaultValue: -1, hint: "−1 uses the server default / available context." },
  { key: "n_probs", label: "Token probabilities", step: 1, min: 0, max: 100, defaultValue: 0, hint: "0 disables probability data in the response." },
  { key: "min_keep", label: "Minimum kept tokens", step: 1, min: 0, max: 100, defaultValue: 0, hint: "0 lets samplers choose freely." },
  { key: "t_max_predict_ms", label: "Prediction time limit (ms)", step: 1, min: 0, max: 3600000, defaultValue: 0, hint: "0 disables the generation time limit." },
  { key: "id_slot", label: "Slot id", step: 1, min: -1, max: 1024, defaultValue: -1, hint: "−1 lets llama-server choose an idle slot." },
];

const valueOf = (cfg: AppConfig, key: NumericKey): number => cfg[key] as number;

const chatOptionValue = (cfg: AppConfig, field: ChatOptionField): number => {
  const value = cfg.chat_options?.[field.key];
  return typeof value === "number" && Number.isFinite(value) ? value : field.defaultValue;
};

/** Tuning panel: server-side values require restart; sampling applies next chat. */
export default function TuningPanel({ store, section = "server", applyRequest = 0 }: { store: AppStore; section?: "server" | "sampling" | "reasoning" | "escape"; applyRequest?: number }) {
  const cfg = store.cfg;
  const [phase, setPhase] = useState<Phase>("idle");
  const [flash, setFlash] = useState<string | null>(null);
  const [serverArgsDraft, setServerArgsDraft] = useState("");
  const [chatOptionsDraft, setChatOptionsDraft] = useState("{}");
  const [serverArgsDirty, setServerArgsDirty] = useState(false);
  const [chatOptionsDirty, setChatOptionsDirty] = useState(false);
  const [advancedError, setAdvancedError] = useState<string | null>(null);
  const [numericDrafts, setNumericDrafts] = useState<Partial<Record<NumericKey, string>>>({});
  const [chatOptionDrafts, setChatOptionDrafts] = useState<Record<string, string>>({});
  const [chatOptionSelectModes, setChatOptionSelectModes] = useState<Record<string, "select" | "custom">>({});
  const [serverTextDrafts, setServerTextDrafts] = useState<Partial<Record<ServerTextKey, string>>>({});
  const flashTimer = useRef<number | null>(null);
  const serverArgsDraftRef = useRef("");
  const chatOptionsDraftRef = useRef("{}");
  const applyLockRef = useRef(false);
  const applyRestartRef = useRef<(() => Promise<void>) | null>(null);
  const handledApplyRequestRef = useRef(0);

  useEffect(() => {
    if (!cfg) return;
    if (!serverArgsDirty) {
      const next = cfg.server_args.join("\n");
      serverArgsDraftRef.current = next;
      setServerArgsDraft(next);
    }
    if (!chatOptionsDirty) {
      const next = JSON.stringify(cfg.chat_options, null, 2);
      chatOptionsDraftRef.current = next;
      setChatOptionsDraft(next);
    }
  }, [cfg, serverArgsDirty, chatOptionsDirty]);

  useEffect(() => {
    if (!cfg) return;
    setServerTextDrafts((current) => {
      const next = { ...current };
      for (const key of [
        "spec_type",
        "spec_draft_ngl",
        "spec_draft_device",
        "spec_draft_model",
        "reasoning_budget_message",
        "mmproj",
      ] as const) {
        if (!(key in next)) next[key] = cfg[key];
      }
      return next;
    });
  }, [cfg]);

  useEffect(() => {
    if (applyRequest <= 0 || handledApplyRequestRef.current === applyRequest || !applyRestartRef.current) return;
    handledApplyRequestRef.current = applyRequest;
    void applyRestartRef.current();
  }, [applyRequest, cfg]);

  if (!cfg) return <div className="p-6 text-sm text-slate-400">Loading…</div>;
  const projectorEditable = projectorChangeAllowed(store.status.state);
  const configMutationsDisabled = phase === "applying" || store.busy;

  const notify = (message: string | null) => {
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    setFlash(message);
    if (message) flashTimer.current = window.setTimeout(() => setFlash(null), 3500);
  };

  const savePatch = async (patch: ConfigPatch<AppConfig>, failureLabel: string): Promise<boolean> => {
    if (applyLockRef.current) return false;
    try {
      await store.updateConfig(patch);
      return true;
    } catch (error) {
      setPhase("failed");
      notify(`${failureLabel}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  const commitNumeric = async (field: NumericField, raw: string) => {
    if (applyLockRef.current) return;
    const parsed = parseNumericInput(raw, field.step);
    if (parsed === null) {
      setNumericDrafts((current) => {
        const next = { ...current };
        delete next[field.key];
        return next;
      });
      return;
    }
    const previous = valueOf(cfg, field.key);
    const normalized = clampNumber(parsed, field.min, field.max, clampNumber(previous, field.min, field.max, field.min));
    if (normalized !== parsed) {
      notify(`${field.label}: ${field.min}–${field.max} 범위로 조정했습니다.`);
    }
    setNumericDrafts((current) => ({ ...current, [field.key]: String(normalized) }));
    const submitted = String(normalized);
    const saved = await savePatch({ [field.key]: normalized } as Partial<AppConfig>, `${field.label} save failed`);
    if (saved) {
      setNumericDrafts((current) => {
        if (!draftStillCurrent(current[field.key], submitted)) return current;
        const next = { ...current };
        delete next[field.key];
        return next;
      });
      if (field.server) setPhase("dirty");
    }
  };

  const commitChatOption = async (field: ChatOptionField, raw: string) => {
    if (applyLockRef.current) return;
    const parsed = parseNumericInput(raw, field.step);
    if (parsed === null) {
      setChatOptionDrafts((current) => {
        const next = { ...current };
        delete next[field.key];
        return next;
      });
      return;
    }
    const previous = chatOptionValue(cfg, field);
    const normalized = clampNumber(parsed, field.min, field.max, clampNumber(previous, field.min, field.max, field.defaultValue));
    if (normalized !== parsed) notify(`${field.label}: ${field.min}–${field.max} 범위로 조정했습니다.`);
    setChatOptionDrafts((current) => ({ ...current, [field.key]: String(normalized) }));
    const submitted = String(normalized);
    const saved = await savePatch(
      (current) => ({ chat_options: { ...current.chat_options, [field.key]: normalized } }),
      `${field.label} save failed`,
    );
    if (saved) {
      setChatOptionDrafts((current) => {
        if (!draftStillCurrent(current[field.key], submitted)) return current;
        const next = { ...current };
        delete next[field.key];
        return next;
      });
      if (field.options) {
        setChatOptionSelectModes((current) => {
          const next = { ...current };
          delete next[field.key];
          return next;
        });
      }
    }
  };

  const renderChatOption = (field: ChatOptionField) => {
    const current = clampNumber(chatOptionValue(cfg, field), field.min, field.max, field.defaultValue);
    const draft = chatOptionDrafts[field.key] ?? String(current);
    const inputId = `tuning-${field.key}`;
    const selectValue = field.options
      ? (chatOptionSelectModes[field.key] === "custom" || !field.options.some((option) => String(option.value) === draft) ? "custom" : draft)
      : null;
    return (
      <div key={field.key} className="flex min-w-0 flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={inputId} className="truncate text-sm text-slate-300">{field.label}</label>
          <span className="shrink-0 text-[10px] text-emerald-400">per-request</span>
        </div>
        {field.options ? (
          <>
            <select
              id={inputId}
              value={selectValue ?? "custom"}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "custom") {
                  setChatOptionSelectModes((modes) => ({ ...modes, [field.key]: "custom" }));
                  setChatOptionDrafts((drafts) => ({ ...drafts, [field.key]: draft }));
                } else {
                  setChatOptionSelectModes((modes) => {
                    const next = { ...modes };
                    delete next[field.key];
                    return next;
                  });
                  setChatOptionDrafts((drafts) => ({ ...drafts, [field.key]: value }));
                  void commitChatOption(field, value);
                }
              }}
              disabled={configMutationsDisabled}
              className="w-full min-w-0 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
            >
              {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              <option value="custom">Custom numeric value</option>
            </select>
            {selectValue === "custom" && (
              <input
                aria-label={`${field.label} custom value`}
                type="text"
                inputMode="numeric"
                value={draft}
                step={field.step}
                min={field.min}
                max={field.max}
                onChange={(event) => setChatOptionDrafts((drafts) => ({ ...drafts, [field.key]: event.target.value }))}
                onBlur={(event) => void commitChatOption(field, event.currentTarget.value)}
                onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                disabled={configMutationsDisabled}
                className="w-full min-w-0 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            )}
          </>
        ) : (
          <input
            id={inputId}
            type="text"
            inputMode={field.step < 1 ? "decimal" : "numeric"}
            value={draft}
            step={field.step}
            min={field.min}
            max={field.max}
            onChange={(event) => setChatOptionDrafts((drafts) => ({ ...drafts, [field.key]: event.target.value }))}
            onBlur={(event) => void commitChatOption(field, event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
            disabled={configMutationsDisabled}
            className="w-full min-w-0 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
          />
        )}
        <span className="text-xs text-slate-500">{field.hint}</span>
      </div>
    );
  };

  const updateFlash = (value: string) => {
    if (applyLockRef.current) return;
    const normalized = value === "on" || value === "off" ? value : "auto";
    void savePatch({ flash_attn: normalized }, "Flash attention save failed");
    setPhase("dirty");
  };

  const updateServerText = (key: ServerTextKey, value: string) => {
    if (applyLockRef.current) return;
    void savePatch({ [key]: value } as Partial<AppConfig>, `${key} save failed`);
    setPhase("dirty");
  };

  const commitServerText = async (key: ServerTextKey, raw: string) => {
    if (applyLockRef.current) return;
    if (key === "mmproj" && !projectorEditable) {
      setServerTextDrafts((current) => ({ ...current, mmproj: cfg.mmproj }));
      notify("Stop the server before changing the multimodal projector.");
      return;
    }
    const value = raw.trim();
    const saved = await savePatch({ [key]: value } as Partial<AppConfig>, `${key} save failed`);
    if (saved) {
      setServerTextDrafts((current) => {
        if (!draftStillCurrent(current[key], value)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
      setPhase("dirty");
    }
  };

  const serverTextValue = (key: ServerTextKey): string => serverTextDrafts[key] ?? cfg[key];

  const serverSelectOptions = (key: "spec_type" | "spec_draft_ngl"): readonly string[] => (
    key === "spec_type" ? SPEC_TYPE_OPTIONS : SPEC_DRAFT_NGL_OPTIONS
  );

  const serverSelectValue = (key: "spec_type" | "spec_draft_ngl"): string => {
    const value = serverTextValue(key);
    return isKnownSelectValue(value, serverSelectOptions(key)) ? value : "custom";
  };

  const selectServerText = (key: "spec_type" | "spec_draft_ngl", value: string) => {
    if (applyLockRef.current) return;
    if (value === "custom") {
      const current = serverTextValue(key);
      setServerTextDrafts((drafts) => ({
        ...drafts,
        [key]: isKnownSelectValue(current, serverSelectOptions(key)) ? "" : current,
      }));
      return;
    }
    setServerTextDrafts((drafts) => ({ ...drafts, [key]: value }));
    void commitServerText(key, value);
  };

  const updateReasoningEffort = (value: string) => {
    if (applyLockRef.current) return;
    void savePatch({ reasoning_effort: value }, "Reasoning effort save failed");
    setPhase("dirty");
  };

  const saveServerArgs = async () => {
    if (applyLockRef.current) return;
    try {
      const submitted = serverArgsDraft;
      const serverArgs = parseServerArgs(submitted);
      await store.updateConfig({ server_args: serverArgs });
      const currentDraft = serverArgsDraftRef.current;
      if (draftStillCurrent(currentDraft, submitted)) setServerArgsDirty(false);
      setAdvancedError(null);
      setPhase("dirty");
      notify(draftStillCurrent(currentDraft, submitted)
        ? "Advanced server arguments saved. Apply & restart to use them."
        : "Advanced server arguments saved; newer draft edits remain unsaved.");
    } catch (error) {
      setPhase("failed");
      setAdvancedError(error instanceof Error ? error.message : String(error));
    }
  };

  const saveChatOptions = async () => {
    if (applyLockRef.current) return;
    try {
      const submitted = chatOptionsDraft;
      const chatOptions = parseChatOptions(submitted);
      await store.updateConfig({ chat_options: chatOptions });
      const currentDraft = chatOptionsDraftRef.current;
      if (draftStillCurrent(currentDraft, submitted)) setChatOptionsDirty(false);
      setAdvancedError(null);
      notify(draftStillCurrent(currentDraft, submitted)
        ? "Advanced chat options saved. They apply to the next message."
        : "Advanced chat options saved; newer draft edits remain unsaved.");
    } catch (error) {
      setAdvancedError(error instanceof Error ? error.message : String(error));
    }
  };

  const applyPreset = (name: "CPU" | "Balanced" | "Max GPU") => {
    if (applyLockRef.current) return;
    const preset =
      name === "CPU"
        ? { ngl: 0, threads: 0, flash_attn: "off" }
        : name === "Balanced"
          ? { ngl: 99, ctx_size: 8192, threads: 0, flash_attn: "auto" }
          : { ngl: 99, ctx_size: 16384, threads: 0, flash_attn: "on" };
    void savePatch(preset as Partial<AppConfig>, `${name} preset save failed`);
    setPhase("dirty");
    notify(`${name} preset loaded. Apply & restart to use server-side changes.`);
  };

  const resetDefaults = () => {
    if (applyLockRef.current) return;
    const serverArgs = QWEN38_SERVER_ARGS.join("\n");
    const chatOptions = JSON.stringify(QWEN38_CHAT_OPTIONS, null, 2);
    serverArgsDraftRef.current = serverArgs;
    chatOptionsDraftRef.current = chatOptions;
    setServerArgsDraft(serverArgs);
    setChatOptionsDraft(chatOptions);
    setServerArgsDirty(false);
    setChatOptionsDirty(false);
    setAdvancedError(null);
    setServerTextDrafts({});
    void savePatch({ ...QWEN38_DEFAULTS, mmproj: cfg.mmproj, server_args: [...QWEN38_SERVER_ARGS], chat_options: QWEN38_CHAT_OPTIONS }, "Defaults save failed");
    setPhase("dirty");
    notify("Qwen3.8-27B defaults loaded. Apply & restart to use server-side changes.");
  };

  const applyRestart = async () => {
    if (phase === "applying" || store.busy) return;
    if (store.status.state !== "running") {
      setPhase("idle");
      notify("Saved — changes take effect on the next Start.");
      return;
    }

    const before = store.getConfig() ?? cfg;
    const startRevision = store.getConfigRevision();
    applyLockRef.current = true;
    setPhase("applying");
    try {
      await store.stop();
      await store.start();
      setPhase("idle");
      const applied = store.getConfig() ?? before;
      notify(`Restarted with ngl=${applied.ngl} · ctx=${applied.ctx_size}.`);
    } catch (error) {
      let rollbackError: unknown = null;
      let rollbackMessage = " Newer configuration edits were preserved; server remains stopped.";
      if (canRollbackAtRevision(startRevision, store.getConfigRevision())) {
        try {
          await store.updateConfig({
            ngl: before.ngl,
            ctx_size: before.ctx_size,
            flash_attn: before.flash_attn,
            n_cpu_moe: before.n_cpu_moe,
            threads: before.threads,
          });
          rollbackMessage = " Server-side values were restored; server remains stopped.";
        } catch (rollbackCaught) {
          rollbackError = rollbackCaught;
        }
      }
      setPhase("failed");
      const detail = error instanceof Error ? error.message : String(error);
      const rollback = rollbackError
        ? ` Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        : rollbackMessage;
      notify(`Apply failed: ${detail}.${rollback}`);
    } finally {
      applyLockRef.current = false;
    }
  };

  applyRestartRef.current = applyRestart;

  const renderNumeric = (field: NumericField) => {
    const current = clampNumber(valueOf(cfg, field.key), field.min, field.max, field.min);
    const draft = numericDrafts[field.key] ?? String(current);
    const inputId = `tuning-${field.key}`;
    return (
      <div key={field.key} className="flex min-w-0 flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={inputId} className="truncate text-sm text-slate-300">{field.label}</label>
          <span className={`shrink-0 text-[10px] ${field.server ? "text-amber-400" : "text-emerald-400"}`}>
            {field.server ? "server-side" : "per-request"}
          </span>
        </div>
        <input
          id={inputId}
          type="text"
          inputMode={field.step < 1 ? "decimal" : "numeric"}
          value={draft}
          step={field.step}
          min={field.min}
          max={field.max}
          onChange={(event) => setNumericDrafts((drafts) => ({ ...drafts, [field.key]: event.target.value }))}
          onBlur={(event) => void commitNumeric(field, event.currentTarget.value)}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          disabled={configMutationsDisabled}
          className="w-full min-w-0 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
        />
        <span className="text-xs text-slate-500">{field.hint}</span>
      </div>
    );
  };

  return (
    <div className="tuning-panel flex h-full min-h-0 flex-col p-4" data-tuning-section={section}>
      {flash && (
        <div className="mb-3 shrink-0 rounded-lg border border-indigo-800 bg-indigo-950/50 px-3 py-2 text-sm text-indigo-200" role="status" aria-live="polite">
          {flash}
        </div>
      )}

      <div className="mb-3 flex shrink-0 flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Presets</span>
        {(["CPU", "Balanced", "Max GPU"] as const).map((name) => (
          <button
            key={name}
            onClick={() => applyPreset(name)}
            disabled={phase === "applying" || store.busy}
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-40"
          >
            {name}
          </button>
        ))}
        <button
          onClick={resetDefaults}
          disabled={phase === "applying" || store.busy}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-400 hover:bg-slate-800 disabled:opacity-40"
        >
          Load Qwen3.8 profile
        </button>
        {phase === "dirty" && <span className="text-xs text-amber-300">● unsaved server changes</span>}
        {phase === "failed" && <span className="text-xs text-red-300">● last apply failed</span>}
      </div>

      <div className="tuning-grid grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-auto lg:grid-cols-2">
        <section className="min-w-0 rounded-xl border border-slate-700 bg-slate-800/40 p-4">
          <h2 className="mb-1 text-sm font-semibold text-slate-200">Server-side parameters</h2>
          <p className="mb-4 text-xs text-slate-500">These are baked in at server start. Change, then restart the server to apply.</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{SERVER_FIELDS.map(renderNumeric)}</div>
          <div className="mt-4 flex min-w-0 flex-col gap-1.5 sm:max-w-[calc(50%-0.5rem)]">
            <div className="flex items-center justify-between gap-2">
                <label htmlFor="tuning-flash-attn" className="text-sm text-slate-300">Flash attention</label>
              <span className="shrink-0 text-[10px] text-amber-400">server-side</span>
            </div>
            <select
              id="tuning-flash-attn"
              value={cfg.flash_attn === "on" || cfg.flash_attn === "off" ? cfg.flash_attn : "auto"}
              onChange={(event) => updateFlash(event.target.value)}
              disabled={configMutationsDisabled}
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
            >
              <option value="auto">auto</option>
              <option value="on">on</option>
              <option value="off">off</option>
            </select>
            <span className="text-xs text-slate-500">auto/on/off. Restart required.</span>
          </div>

          <div className="mt-4 flex min-w-0 flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="tuning-mmproj" className="text-sm text-slate-300">Multimodal projector (mmproj)</label>
              <span className="shrink-0 text-[10px] text-amber-400">server-side</span>
            </div>
            <input
              id="tuning-mmproj"
              value={serverTextValue("mmproj")}
              onChange={(event) => setServerTextDrafts((current) => ({ ...current, mmproj: event.target.value }))}
              onBlur={(event) => void commitServerText("mmproj", event.currentTarget.value)}
              onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
              disabled={!projectorEditable || configMutationsDisabled}
              placeholder="optional path to mmproj-*.gguf"
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
            />
            <span className="text-xs text-slate-500">Qwen3.8 is vision-language. Maps to --mmproj; leave empty for text-only GGUFs.</span>
          </div>

          <div className="mt-5 rounded-lg border border-slate-700/80 bg-slate-900/40 p-3">
            <h3 className="text-sm font-medium text-slate-300">Speculative decoding / MTP</h3>
            <p className="mb-4 mt-1 text-xs text-slate-500">MTP models use <code>--spec-type draft-mtp</code>. Other speculative modes and future values can be entered as a comma-separated type list.</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="tuning-spec-type" className="text-sm text-slate-300">Speculative type(s)</label>
                  <span className="shrink-0 text-[10px] text-amber-400">server-side</span>
                </div>
                <select
                  id="tuning-spec-type"
                  value={serverSelectValue("spec_type")}
                  onChange={(event) => selectServerText("spec_type", event.target.value)}
                  disabled={configMutationsDisabled}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                >
                  {SPEC_TYPE_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
                  <option value="custom">Custom / comma-separated…</option>
                </select>
                {serverSelectValue("spec_type") === "custom" && (
                  <input
                    aria-label="Custom speculative type list"
                    value={serverTextValue("spec_type")}
                    onChange={(event) => setServerTextDrafts((current) => ({ ...current, spec_type: event.target.value }))}
                    onBlur={(event) => void commitServerText("spec_type", event.currentTarget.value)}
                    onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                    disabled={configMutationsDisabled}
                    placeholder="draft-mtp,ngram-mod"
                    className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                  />
                )}
                <span className="text-xs text-slate-500">Pick a built-in llama.cpp mode, or use Custom for comma-separated/future values.</span>
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="tuning-spec-draft-ngl" className="text-sm text-slate-300">Draft GPU layers</label>
                  <span className="shrink-0 text-[10px] text-amber-400">server-side</span>
                </div>
                <select
                  id="tuning-spec-draft-ngl"
                  value={serverSelectValue("spec_draft_ngl")}
                  onChange={(event) => selectServerText("spec_draft_ngl", event.target.value)}
                  disabled={configMutationsDisabled}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                >
                  {SPEC_DRAFT_NGL_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
                  <option value="custom">Custom numeric value…</option>
                </select>
                {serverSelectValue("spec_draft_ngl") === "custom" && (
                  <input
                    aria-label="Custom draft GPU layers"
                    value={serverTextValue("spec_draft_ngl")}
                    onChange={(event) => setServerTextDrafts((current) => ({ ...current, spec_draft_ngl: event.target.value }))}
                    onBlur={(event) => void commitServerText("spec_draft_ngl", event.currentTarget.value)}
                    onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                    disabled={configMutationsDisabled}
                    placeholder="32"
                    inputMode="numeric"
                    className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                  />
                )}
                <span className="text-xs text-slate-500">auto/all are named llama.cpp values; Custom accepts an exact numeric layer count.</span>
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="tuning-spec-draft-device" className="text-sm text-slate-300">Draft device</label>
                  <span className="shrink-0 text-[10px] text-amber-400">server-side</span>
                </div>
                <input
                  id="tuning-spec-draft-device"
                  value={serverTextValue("spec_draft_device")}
                  onChange={(event) => setServerTextDrafts((current) => ({ ...current, spec_draft_device: event.target.value }))}
                  onBlur={(event) => void commitServerText("spec_draft_device", event.currentTarget.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          disabled={configMutationsDisabled}
                  placeholder="empty, none, or device list"
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                />
                <span className="text-xs text-slate-500">Maps to --spec-draft-device.</span>
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="tuning-spec-draft-model" className="text-sm text-slate-300">Draft model</label>
                  <span className="shrink-0 text-[10px] text-amber-400">server-side</span>
                </div>
                <input
                  id="tuning-spec-draft-model"
                  value={serverTextValue("spec_draft_model")}
                  onChange={(event) => setServerTextDrafts((current) => ({ ...current, spec_draft_model: event.target.value }))}
                  onBlur={(event) => void commitServerText("spec_draft_model", event.currentTarget.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          disabled={configMutationsDisabled}
                  placeholder="path for draft-simple; empty for draft-mtp"
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                />
                <span className="text-xs text-slate-500">Maps to --spec-draft-model.</span>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">{MTP_FIELDS.map(renderNumeric)}</div>
          </div>

          <div className="mt-5 rounded-lg border border-slate-700/80 bg-slate-900/40 p-3">
            <h3 className="text-sm font-medium text-slate-300">Reasoning / thinking</h3>
            <p className="mb-4 mt-1 text-xs text-slate-500">These controls map to llama.cpp's reasoning template options. The effort value is also sent per chat request when it is not default.</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="flex min-w-0 flex-col gap-1.5">
                <label htmlFor="tuning-reasoning" className="text-sm text-slate-300">Reasoning mode</label>
                <select
                  id="tuning-reasoning"
                  value={cfg.reasoning}
                  onChange={(event) => updateServerText("reasoning", event.target.value)}
                  disabled={configMutationsDisabled}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                >
                  <option value="auto">auto</option>
                  <option value="on">on</option>
                  <option value="off">off</option>
                </select>
                <span className="text-xs text-slate-500">--reasoning.</span>
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <label htmlFor="tuning-reasoning-format" className="text-sm text-slate-300">Reasoning format</label>
                <select
                  id="tuning-reasoning-format"
                  value={cfg.reasoning_format}
                  onChange={(event) => updateServerText("reasoning_format", event.target.value)}
                  disabled={configMutationsDisabled}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                >
                  <option value="auto">auto</option>
                  <option value="none">none</option>
                  <option value="deepseek">deepseek</option>
                  <option value="deepseek-legacy">deepseek-legacy</option>
                </select>
                <span className="text-xs text-slate-500">--reasoning-format.</span>
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <label htmlFor="tuning-reasoning-preserve" className="text-sm text-slate-300">Preserve reasoning</label>
                <select
                  id="tuning-reasoning-preserve"
                  value={cfg.reasoning_preserve}
                  onChange={(event) => updateServerText("reasoning_preserve", event.target.value)}
                  disabled={configMutationsDisabled}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                >
                  <option value="auto">template default</option>
                  <option value="on">on</option>
                  <option value="off">off</option>
                </select>
                <span className="text-xs text-slate-500">--reasoning-preserve / --no-reasoning-preserve.</span>
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="tuning-reasoning-effort" className="text-sm text-slate-300">Reasoning effort</label>
                  <span className="shrink-0 text-[10px] text-amber-400">server + request</span>
                </div>
                <select
                  id="tuning-reasoning-effort"
                  value={cfg.reasoning_effort}
                  onChange={(event) => updateReasoningEffort(event.target.value)}
                  disabled={configMutationsDisabled}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                >
                  <option value="default">default</option>
                  <option value="none">none</option>
                  <option value="minimal">minimal</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="xhigh">xhigh</option>
                  <option value="max">max</option>
                </select>
                <span className="text-xs text-slate-500">Qwen3.8 권장: <code>xhigh</code>. <code>none</code>은 요청에서만 thinking을 끕니다.</span>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              {REASONING_FIELDS.map(renderNumeric)}
              <div className="flex min-w-0 flex-col gap-1.5">
                <label htmlFor="tuning-reasoning-budget-message" className="text-sm text-slate-300">Budget exhausted message</label>
                <input
                  id="tuning-reasoning-budget-message"
                  value={serverTextValue("reasoning_budget_message")}
                  onChange={(event) => setServerTextDrafts((current) => ({ ...current, reasoning_budget_message: event.target.value }))}
                  onBlur={(event) => void commitServerText("reasoning_budget_message", event.currentTarget.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          disabled={configMutationsDisabled}
                  placeholder="optional"
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                />
                <span className="text-xs text-slate-500">Maps to --reasoning-budget-message.</span>
              </div>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              onClick={() => void applyRestart()}
              disabled={phase === "applying" || store.busy}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {phase === "applying" ? "Restarting…" : "Apply & restart server"}
            </button>
            <span className="text-xs text-slate-500">
              {store.status.state === "running" ? "server is running" : "server is stopped"}
            </span>
          </div>
        </section>

        <section className="min-w-0 rounded-xl border border-slate-700 bg-slate-800/40 p-4">
          <h2 className="mb-1 text-sm font-semibold text-slate-200">Sampling parameters</h2>
          <p className="mb-4 text-xs text-slate-500">Sent with every chat request — take effect immediately, no restart needed.</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{SAMPLING_FIELDS.map(renderNumeric)}</div>

          <details className="mt-5 rounded-lg border border-slate-700/80 bg-slate-900/40 p-3">
            <summary className="cursor-pointer text-sm font-medium text-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">More llama.cpp sampling controls</summary>
            <p className="mb-4 mt-2 text-xs text-slate-500">These map directly to llama.cpp request options. Leave a value at its default to keep the runtime default.</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{ADVANCED_SAMPLING_FIELDS.map(renderChatOption)}</div>
          </details>
          <div className="mt-5 text-xs text-slate-500">Saved to config and used by the Chat panel on the next message.</div>
        </section>

        <section className="min-w-0 rounded-xl border border-slate-700 bg-slate-800/40 p-4 lg:col-span-2">
          <h2 className="mb-1 text-sm font-semibold text-slate-200">Advanced llama.cpp settings</h2>
          <p className="mb-4 text-xs text-slate-500">Use these escape hatches for every current or future llama.cpp option that does not have a dedicated control above.</p>
          {advancedError && <div className="mb-3 break-words rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-200" role="alert">{advancedError}</div>}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <div className="min-w-0">
              <label htmlFor="tuning-server-args" className="text-sm font-medium text-slate-300">Additional llama-server arguments</label>
              <p className="mb-2 mt-1 text-xs text-slate-500">One literal process argument per line. For a flag with a value, put the flag and value on separate lines. Shell syntax is not evaluated.</p>
              <textarea
                id="tuning-server-args"
                aria-label="Additional llama-server arguments"
                value={serverArgsDraft}
                onChange={(event) => { serverArgsDraftRef.current = event.target.value; setServerArgsDraft(event.target.value); setServerArgsDirty(true); setAdvancedError(null); }}
                disabled={configMutationsDisabled}
                rows={12}
                spellCheck={false}
                className="w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs leading-relaxed text-slate-100 focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                placeholder={'--min-p\n0.05\n--chat-template\nqwen'}
              />
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void saveServerArgs()}
                  disabled={!serverArgsDirty || phase === "applying" || store.busy}
                  className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
                >
                  Save server arguments
                </button>
                <span className="text-xs text-amber-400">restart required</span>
              </div>
            </div>
            <div className="min-w-0">
              <label htmlFor="tuning-chat-options" className="text-sm font-medium text-slate-300">Advanced chat options (JSON)</label>
              <p className="mb-2 mt-1 text-xs text-slate-500">Merged into <code>/v1/chat/completions</code>. This supports arrays and newer options such as samplers, DRY breakers, grammar, JSON schema, and cache controls.</p>
              <textarea
                id="tuning-chat-options"
                aria-label="Advanced chat options JSON"
                value={chatOptionsDraft}
                onChange={(event) => { chatOptionsDraftRef.current = event.target.value; setChatOptionsDraft(event.target.value); setChatOptionsDirty(true); setAdvancedError(null); }}
                disabled={configMutationsDisabled}
                rows={12}
                spellCheck={false}
                className="w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs leading-relaxed text-slate-100 focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                placeholder={'{\n  "dry_sequence_breakers": ["\\n", ":"],\n  "samplers": ["dry", "top_k", "top_p", "temperature"]\n}'}
              />
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void saveChatOptions()}
                  disabled={!chatOptionsDirty || phase === "applying" || store.busy}
                  className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
                >
                  Save chat options
                </button>
                <span className="text-xs text-emerald-400">next message</span>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
