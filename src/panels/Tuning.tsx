import { useEffect, useRef, useState } from "react";
import type { AppConfig } from "../api";
import type { AppStore } from "../store";
import { QWEN38_CHAT_OPTIONS, QWEN38_DEFAULTS, QWEN38_SERVER_ARGS } from "./qwenDefaults";
import {
  clampNumber,
  isKnownSelectValue,

  parseChatOptions,
  parseNumericInput,
  parseServerArgs,
  SPEC_DRAFT_NGL_OPTIONS,
  SPEC_TYPE_OPTIONS,
} from "./tuningValidation";
import { canRollbackAtRevision, draftStillCurrent } from "./tuningAsync";
import { projectorChangeAllowed } from "./visionState";
import type { ConfigPatch } from "../configSaveQueue";
import ConfirmDialog from "../components/ConfirmDialog";
import FeedbackBanner from "../components/FeedbackBanner";
import StatusBadge from "../components/StatusBadge";
import { useI18n } from "../i18n";
import { xt } from "../extraI18n";
import { ut } from "../uiI18n";
import { validateTuningRelations } from "../lifecycleUtils";
import NumericFieldGrid from "./NumericFieldGrid";
import { ADVANCED_SAMPLING_FIELDS, MTP_FIELDS, REASONING_FIELDS, SAMPLING_FIELDS, SERVER_FIELDS, type ChatOptionField, type NumericField, type NumericKey, type ServerTextKey, valueOf, chatOptionValue } from "./tuningFields";

type Phase = "idle" | "dirty" | "applying" | "failed";

/** Tuning panel: server-side values require restart; sampling applies next chat. */
export default function TuningPanel({ store, section = "server", applyRequest = 0 }: { store: AppStore; section?: "server" | "sampling" | "reasoning" | "escape"; applyRequest?: number }) {
  const { t, locale } = useI18n();
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
  const [changedServerFields, setChangedServerFields] = useState<string[]>([]);
  // Presets and the Qwen profile overwrite every tuning value, so they are
  // confirmed like the other destructive actions in the app.
  const [pendingBulkChange, setPendingBulkChange] = useState<{ title: string; description: string; confirmLabel: string; run: () => void } | null>(null);
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

  if (!cfg) return <div className="p-6 text-sm text-slate-400">{xt(locale, "loading")}</div>;
  const projectorEditable = projectorChangeAllowed(store.status.state);
  const configMutationsDisabled = phase === "applying" || store.busy;
  const relationWarnings = validateTuningRelations({
    ctxSize: cfg.ctx_size,
    parallel: cfg.parallel,
    ngl: cfg.ngl,
    temperature: cfg.temperature,
    dynatempRange: Number(cfg.chat_options?.dynatemp_range ?? 0),
    topP: cfg.top_p,
    minP: Number(cfg.chat_options?.min_p ?? 0),
  });

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
      notify(ut(locale, "clampedToRange", { label: field.label, min: field.min, max: field.max }));
    }
    setNumericDrafts((current) => ({ ...current, [field.key]: String(normalized) }));
    const submitted = String(normalized);
    const saved = await savePatch({ [field.key]: normalized } as Partial<AppConfig>, ut(locale, "saveFailedFor", { label: field.label }));
    if (saved) {
      setNumericDrafts((current) => {
        if (!draftStillCurrent(current[field.key], submitted)) return current;
        const next = { ...current };
        delete next[field.key];
        return next;
      });
      if (field.server) {
        setPhase("dirty");
        setChangedServerFields((current) => current.includes(field.label) ? current : [...current, field.label]);
      }
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
    if (normalized !== parsed) notify(ut(locale, "clampedToRange", { label: field.label, min: field.min, max: field.max }));
    setChatOptionDrafts((current) => ({ ...current, [field.key]: String(normalized) }));
    const submitted = String(normalized);
    const saved = await savePatch(
      (current) => ({ chat_options: { ...current.chat_options, [field.key]: normalized } }),
      ut(locale, "saveFailedFor", { label: field.label }),
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
          <span className="shrink-0 text-[10px] text-emerald-400">{xt(locale, "perRequest")}</span>
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
              <option value="custom">{ut(locale, "customNumeric")}</option>
            </select>
            {selectValue === "custom" && (
              <input
                aria-label={ut(locale, "customValueFor", { label: field.label })}
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
    void savePatch({ flash_attn: normalized }, ut(locale, "saveFailedFor", { label: ut(locale, "flashAttention") }));
    setPhase("dirty");
  };

  const updateServerText = (key: ServerTextKey, value: string) => {
    if (applyLockRef.current) return;
    void savePatch({ [key]: value } as Partial<AppConfig>, ut(locale, "saveFailedFor", { label: key }));
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
    const saved = await savePatch({ [key]: value } as Partial<AppConfig>, ut(locale, "saveFailedFor", { label: key }));
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
    void savePatch({ reasoning_effort: value }, ut(locale, "saveFailedFor", { label: ut(locale, "reasoningEffort") }));
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

  const applyPreset = async (name: "CPU" | "Balanced" | "Max GPU") => {
    if (applyLockRef.current) return;
    const preset =
      name === "CPU"
        ? { ngl: 0, threads: 0, flash_attn: "off" }
        : name === "Balanced"
          ? { ngl: 99, ctx_size: 8192, threads: 0, flash_attn: "auto" }
          : { ngl: 99, ctx_size: 16384, threads: 0, flash_attn: "on" };
    const saved = await savePatch(preset as Partial<AppConfig>, ut(locale, "saveFailedFor", { label: name }));
    if (!saved) return;
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
    void savePatch({ ...QWEN38_DEFAULTS, mmproj: cfg.mmproj, server_args: [...QWEN38_SERVER_ARGS], chat_options: QWEN38_CHAT_OPTIONS }, ut(locale, "saveFailedFor", { label: ut(locale, "loadQwenProfile") }));
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
      setChangedServerFields([]);
      const applied = store.getConfig() ?? before;
      notify(`${t("action.applyRestart")}: ngl=${applied.ngl} · ctx=${applied.ctx_size}.`);
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

  // Both server-side sections need the same restart affordance.
  const applyRow = (
    <div className="mt-5 flex flex-wrap items-center gap-3">
      <button
        type="button"
        onClick={() => void applyRestart()}
        disabled={phase === "applying" || store.busy}
        className="app-button app-button--primary"
      >
        {phase === "applying" ? xt(locale, "applying") : xt(locale, "applyRestart")}
      </button>
      <span className="text-xs text-slate-500">
        {store.status.state === "running" ? xt(locale, "serverRunning") : xt(locale, "serverStopped")}
      </span>
    </div>
  );

  return (
    <div className="tuning-panel flex h-full min-h-0 flex-col p-4" data-tuning-section={section}>
      {flash && <FeedbackBanner tone={phase === "failed" ? "error" : "info"} onDismiss={() => setFlash(null)}>{flash}</FeedbackBanner>}

      <div className="mb-3 flex shrink-0 flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{xt(locale, "tuningPresets")}</span>
        {(["CPU", "Balanced", "Max GPU"] as const).map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setPendingBulkChange({
              title: ut(locale, "presetTitle", { name }),
              description: ut(locale, "presetBody", { name }),
              confirmLabel: ut(locale, "presetConfirm"),
              run: () => applyPreset(name),
            })}
            disabled={phase === "applying" || store.busy}
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-40"
          >
            {name}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setPendingBulkChange({
            title: ut(locale, "loadProfileTitle"),
            description: ut(locale, "loadProfileBody"),
            confirmLabel: ut(locale, "loadProfileConfirm"),
            run: resetDefaults,
          })}
          disabled={phase === "applying" || store.busy}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-400 hover:bg-slate-800 disabled:opacity-40"
        >
          {ut(locale, "loadQwenProfile")}
        </button>
        {phase === "idle" && <StatusBadge label={xt(locale, "saved")} tone="success" />}
                {phase === "dirty" && <StatusBadge label={xt(locale, "restartRequired")} tone="warning" />}
                {phase === "applying" && <StatusBadge label={xt(locale, "applying")} tone="neutral" />}
                {phase === "failed" && <StatusBadge label={xt(locale, "applyFailed")} tone="danger" />}
        {phase === "dirty" && <span className="text-xs text-amber-300">{xt(locale, "previousValues")}</span>}
      </div>
      {phase === "dirty" && changedServerFields.length > 0 && (
        <FeedbackBanner tone="warning" title={ut(locale, "serverSettingsChangedCount", { count: changedServerFields.length })} action={{ label: xt(locale, "applyRestart"), onClick: () => void applyRestart() }}>
          {changedServerFields.join(" · ")} · {xt(locale, "conversationsRemainSaved")}
        </FeedbackBanner>
      )}
      <ConfirmDialog
        open={pendingBulkChange !== null}
        title={pendingBulkChange?.title ?? ""}
        description={pendingBulkChange?.description ?? ""}
        confirmLabel={pendingBulkChange?.confirmLabel ?? t("common.confirm")}
        cancelLabel={t("common.cancel")}
        onConfirm={() => { pendingBulkChange?.run(); setPendingBulkChange(null); }}
        onCancel={() => setPendingBulkChange(null)}
      />
      {relationWarnings.length > 0 && (
        <FeedbackBanner tone="warning" title={t("error.attention")}>
          <ul className="list-disc space-y-1 pl-4">{relationWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </FeedbackBanner>
      )}

      <div className="tuning-grid grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-auto lg:grid-cols-2">
        <section className="tuning-section tuning-section--server min-w-0 rounded-xl border border-slate-700 bg-slate-800/40 p-4">
          <h2 className="mb-1 text-sm font-semibold text-slate-200">{t("section.serverMemory")}</h2>
          <p className="mb-4 text-xs text-slate-500">{ut(locale, "serverMemoryHint")}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><NumericFieldGrid fields={SERVER_FIELDS} cfg={cfg} drafts={numericDrafts} disabled={configMutationsDisabled} onChange={(key, value) => setNumericDrafts((drafts) => ({ ...drafts, [key]: value }))} onCommit={(field, value) => void commitNumeric(field, value)} /></div>
          <div className="mt-4 flex min-w-0 flex-col gap-1.5 sm:max-w-[calc(50%-0.5rem)]">
            <div className="flex items-center justify-between gap-2">
                <label htmlFor="tuning-flash-attn" className="text-sm text-slate-300">{ut(locale, "flashAttention")}</label>
              <span className="shrink-0 text-[10px] text-amber-400">{xt(locale, "serverSide")}</span>
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
            <span className="text-xs text-slate-500">{ut(locale, "flashAttentionHint")}</span>
          </div>

          <div className="mt-4 flex min-w-0 flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="tuning-mmproj" className="text-sm text-slate-300">{ut(locale, "mmprojLabel")}</label>
              <span className="shrink-0 text-[10px] text-amber-400">{xt(locale, "serverSide")}</span>
            </div>
            <input
              id="tuning-mmproj"
              value={serverTextValue("mmproj")}
              onChange={(event) => setServerTextDrafts((current) => ({ ...current, mmproj: event.target.value }))}
              onBlur={(event) => void commitServerText("mmproj", event.currentTarget.value)}
              onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
              disabled={!projectorEditable || configMutationsDisabled}
              placeholder={ut(locale, "mmprojPlaceholder")}
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
            />
            <span className="text-xs text-slate-500">{ut(locale, "mmprojHint")}</span>
          </div>

          <div className="mt-5 rounded-lg border border-slate-700/80 bg-slate-900/40 p-3">
            <h3 className="text-sm font-medium text-slate-300">{ut(locale, "specTitle")}</h3>
            <p className="mb-4 mt-1 text-xs text-slate-500">{ut(locale, "specHint")}</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="tuning-spec-type" className="text-sm text-slate-300">{ut(locale, "specTypeLabel")}</label>
                  <span className="shrink-0 text-[10px] text-amber-400">{xt(locale, "serverSide")}</span>
                </div>
                <select
                  id="tuning-spec-type"
                  value={serverSelectValue("spec_type")}
                  onChange={(event) => selectServerText("spec_type", event.target.value)}
                  disabled={configMutationsDisabled}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                >
                  {SPEC_TYPE_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
                  <option value="custom">{ut(locale, "customCommaList")}</option>
                </select>
                {serverSelectValue("spec_type") === "custom" && (
                  <input
                    aria-label={ut(locale, "customValueFor", { label: ut(locale, "specTypeLabel") })}
                    value={serverTextValue("spec_type")}
                    onChange={(event) => setServerTextDrafts((current) => ({ ...current, spec_type: event.target.value }))}
                    onBlur={(event) => void commitServerText("spec_type", event.currentTarget.value)}
                    onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                    disabled={configMutationsDisabled}
                    placeholder="draft-mtp,ngram-mod"
                    className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                  />
                )}
                <span className="text-xs text-slate-500">{ut(locale, "specTypeHint")}</span>
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="tuning-spec-draft-ngl" className="text-sm text-slate-300">{ut(locale, "specDraftNglLabel")}</label>
                  <span className="shrink-0 text-[10px] text-amber-400">{xt(locale, "serverSide")}</span>
                </div>
                <select
                  id="tuning-spec-draft-ngl"
                  value={serverSelectValue("spec_draft_ngl")}
                  onChange={(event) => selectServerText("spec_draft_ngl", event.target.value)}
                  disabled={configMutationsDisabled}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                >
                  {SPEC_DRAFT_NGL_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
                  <option value="custom">{ut(locale, "customNumeric")}</option>
                </select>
                {serverSelectValue("spec_draft_ngl") === "custom" && (
                  <input
                    aria-label={ut(locale, "customValueFor", { label: ut(locale, "specDraftNglLabel") })}
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
                <span className="text-xs text-slate-500">{ut(locale, "specDraftNglHint")}</span>
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="tuning-spec-draft-device" className="text-sm text-slate-300">{ut(locale, "specDraftDeviceLabel")}</label>
                  <span className="shrink-0 text-[10px] text-amber-400">{xt(locale, "serverSide")}</span>
                </div>
                <input
                  id="tuning-spec-draft-device"
                  value={serverTextValue("spec_draft_device")}
                  onChange={(event) => setServerTextDrafts((current) => ({ ...current, spec_draft_device: event.target.value }))}
                  onBlur={(event) => void commitServerText("spec_draft_device", event.currentTarget.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          disabled={configMutationsDisabled}
                  placeholder={ut(locale, "specDraftDevicePlaceholder")}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                />
                <span className="text-xs text-slate-500">{ut(locale, "specDraftDeviceHint")}</span>
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="tuning-spec-draft-model" className="text-sm text-slate-300">{ut(locale, "specDraftModelLabel")}</label>
                  <span className="shrink-0 text-[10px] text-amber-400">{xt(locale, "serverSide")}</span>
                </div>
                <input
                  id="tuning-spec-draft-model"
                  value={serverTextValue("spec_draft_model")}
                  onChange={(event) => setServerTextDrafts((current) => ({ ...current, spec_draft_model: event.target.value }))}
                  onBlur={(event) => void commitServerText("spec_draft_model", event.currentTarget.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          disabled={configMutationsDisabled}
                  placeholder={ut(locale, "specDraftModelPlaceholder")}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                />
                <span className="text-xs text-slate-500">{ut(locale, "specDraftModelHint")}</span>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2"><NumericFieldGrid fields={MTP_FIELDS} cfg={cfg} drafts={numericDrafts} disabled={configMutationsDisabled} onChange={(key, value) => setNumericDrafts((drafts) => ({ ...drafts, [key]: value }))} onCommit={(field, value) => void commitNumeric(field, value)} /></div>
          </div>
          {applyRow}
        </section>

        <section className="tuning-section tuning-section--reasoning min-w-0 rounded-xl border border-slate-700 bg-slate-800/40 p-4">
            <h2 className="mb-1 text-sm font-semibold text-slate-200">{t("section.reasoning")}</h2>
            <p className="mb-4 text-xs text-slate-500">{xt(locale, "reasoningDescription")}</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="flex min-w-0 flex-col gap-1.5">
                <label htmlFor="tuning-reasoning" className="text-sm text-slate-300">{ut(locale, "reasoningMode")}</label>
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
                <label htmlFor="tuning-reasoning-format" className="text-sm text-slate-300">{ut(locale, "reasoningFormat")}</label>
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
                <label htmlFor="tuning-reasoning-preserve" className="text-sm text-slate-300">{ut(locale, "reasoningPreserve")}</label>
                <select
                  id="tuning-reasoning-preserve"
                  value={cfg.reasoning_preserve}
                  onChange={(event) => updateServerText("reasoning_preserve", event.target.value)}
                  disabled={configMutationsDisabled}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                >
                  <option value="auto">{ut(locale, "templateDefault")}</option>
                  <option value="on">on</option>
                  <option value="off">off</option>
                </select>
                <span className="text-xs text-slate-500">--reasoning-preserve / --no-reasoning-preserve.</span>
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="tuning-reasoning-effort" className="text-sm text-slate-300">{ut(locale, "reasoningEffort")}</label>
                  <span className="shrink-0 text-[10px] text-amber-400">{ut(locale, "serverAndRequest")}</span>
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
                <span className="text-xs text-slate-500">{ut(locale, "reasoningEffortHint")}</span>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <NumericFieldGrid fields={REASONING_FIELDS} cfg={cfg} drafts={numericDrafts} disabled={configMutationsDisabled} onChange={(key, value) => setNumericDrafts((drafts) => ({ ...drafts, [key]: value }))} onCommit={(field, value) => void commitNumeric(field, value)} />
              <div className="flex min-w-0 flex-col gap-1.5">
                <label htmlFor="tuning-reasoning-budget-message" className="text-sm text-slate-300">{ut(locale, "budgetMessageLabel")}</label>
                <input
                  id="tuning-reasoning-budget-message"
                  value={serverTextValue("reasoning_budget_message")}
                  onChange={(event) => setServerTextDrafts((current) => ({ ...current, reasoning_budget_message: event.target.value }))}
                  onBlur={(event) => void commitServerText("reasoning_budget_message", event.currentTarget.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
          disabled={configMutationsDisabled}
                  placeholder={ut(locale, "optional")}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                />
                <span className="text-xs text-slate-500">{ut(locale, "budgetMessageHint")}</span>
              </div>
            </div>
          {applyRow}
        </section>

        <section className="tuning-section tuning-section--sampling min-w-0 rounded-xl border border-slate-700 bg-slate-800/40 p-4">
          <h2 className="mb-1 text-sm font-semibold text-slate-200">{t("section.sampling")}</h2>
          <p className="mb-4 text-xs text-slate-500">{ut(locale, "samplingHint")}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><NumericFieldGrid fields={SAMPLING_FIELDS} cfg={cfg} drafts={numericDrafts} disabled={configMutationsDisabled} onChange={(key, value) => setNumericDrafts((drafts) => ({ ...drafts, [key]: value }))} onCommit={(field, value) => void commitNumeric(field, value)} /></div>

          <details className="mt-5 rounded-lg border border-slate-700/80 bg-slate-900/40 p-3">
            <summary className="cursor-pointer text-sm font-medium text-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">{xt(locale, "moreSampling")}</summary>
            <p className="mb-4 mt-2 text-xs text-slate-500">{ut(locale, "advancedSamplingHint")}</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{ADVANCED_SAMPLING_FIELDS.map(renderChatOption)}</div>
          </details>
          <div className="mt-5 text-xs text-slate-500">{xt(locale, "savedNextMessage")}</div>
        </section>

        <section className="tuning-section tuning-section--escape min-w-0 rounded-xl border border-slate-700 bg-slate-800/40 p-4 lg:col-span-2">
          <h2 className="mb-1 text-sm font-semibold text-slate-200">{t("section.escape")}</h2>
          <p className="mb-4 text-xs text-slate-500">{ut(locale, "escapeHint")}</p>
          {advancedError && <div className="mb-3 break-words rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-200" role="alert">{advancedError}</div>}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <div className="min-w-0">
              <label htmlFor="tuning-server-args" className="text-sm font-medium text-slate-300">{ut(locale, "serverArgsLabel")}</label>
              <p className="mb-2 mt-1 text-xs text-slate-500">{ut(locale, "serverArgsHint")}</p>
              <textarea
                id="tuning-server-args"
                aria-label={ut(locale, "serverArgsLabel")}
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
                  {xt(locale, "saveServerArguments")}
                </button>
                <span className="text-xs text-amber-400">{ut(locale, "restartRequiredShort")}</span>
              </div>
            </div>
            <div className="min-w-0">
              <label htmlFor="tuning-chat-options" className="text-sm font-medium text-slate-300">{ut(locale, "chatOptionsLabel")}</label>
              <p className="mb-2 mt-1 text-xs text-slate-500">{ut(locale, "chatOptionsHint")}</p>
              <textarea
                id="tuning-chat-options"
                aria-label={ut(locale, "chatOptionsLabel")}
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
                  {xt(locale, "saveChatOptions")}
                </button>
                <span className="text-xs text-emerald-400">{ut(locale, "nextMessageShort")}</span>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
