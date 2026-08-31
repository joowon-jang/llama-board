import { useEffect, useRef, useState } from "react";
import type { AppConfig } from "../api";
import type { AppStore } from "../store";
import { QWEN38_CHAT_OPTIONS, QWEN38_DEFAULTS, QWEN38_SERVER_ARGS } from "./qwenDefaults";
import { isKnownSelectValue, parseChatOptions, parseServerArgs, SPEC_DRAFT_NGL_OPTIONS, SPEC_TYPE_OPTIONS } from "./tuningValidation";
import { draftStillCurrent } from "./tuningAsync";
import { projectorChangeAllowed } from "./visionState";
import type { ConfigPatch } from "../configSaveQueue";
import { useI18n } from "../i18n";
import { normalizeDisplayPath, validateTuningRelations } from "../lifecycleUtils";
import { useFlashMessage } from "../useFlashMessage";
import type { ChatOptionField, NumericField, NumericKey, ServerTextKey } from "./tuningFields";
import {
  commitChatOptionField, commitNumericField, performApplyRestart,
  SERVER_FIELD_LABEL_KEYS, SERVER_TEXT_LABEL_KEYS, serverPathKeys, type TuningPhase,
} from "./tuningControllerHelpers";

export type { TuningPhase } from "./tuningControllerHelpers";

/**
 * Owns Tuning's persistence lifecycle: draft/dirty state for every field group,
 * the debounced-commit handlers that patch `store.cfg`, and the stop/start
 * "apply restart" flow with rollback. `cfg` is only exercised by handlers that
 * are reachable exclusively from the panel's own JSX, which the panel renders
 * only once `store.cfg` is defined — the `if (!cfg) return;` guards here exist
 * because that guarantee crosses a hook boundary TypeScript can't see through,
 * not because these code paths are expected to run before the config loads.
 */
export function useTuningController(store: AppStore, applyRequest: number) {
  const { locale, t } = useI18n();
  const cfg = store.cfg;
  const [phase, setPhase] = useState<TuningPhase>("idle");
  const [flash, notify, dismissFlash] = useFlashMessage();
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

  const projectorEditable = projectorChangeAllowed(store.status.state);
  const configMutationsDisabled = phase === "applying" || store.busy;
  const relationWarnings = cfg ? validateTuningRelations({
    ctxSize: cfg.ctx_size,
    parallel: cfg.parallel,
    ngl: cfg.ngl,
    temperature: cfg.temperature,
    dynatempRange: Number(cfg.chat_options?.dynatemp_range ?? 0),
    topP: cfg.top_p,
    minP: Number(cfg.chat_options?.min_p ?? 0),
  }) : [];

  const numericFieldLabel = (field: NumericField): string => {
    const key = SERVER_FIELD_LABEL_KEYS[field.key];
    return key ? t(`ui.${key}`) : field.label;
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

  const commitContext = { locale, notify, savePatch, setPhase };

  const commitNumeric = async (field: NumericField, raw: string) => {
    if (applyLockRef.current || !cfg) return;
    await commitNumericField(cfg, field, raw, numericFieldLabel, setNumericDrafts, setChangedServerFields, commitContext);
  };

  const commitChatOption = async (field: ChatOptionField, raw: string) => {
    if (applyLockRef.current || !cfg) return;
    await commitChatOptionField(cfg, field, raw, setChatOptionDrafts, setChatOptionSelectModes, commitContext);
  };

  const updateFlash = (value: string) => {
    if (applyLockRef.current) return;
    const normalized = value === "on" || value === "off" ? value : "auto";
    void savePatch({ flash_attn: normalized }, t("ui.saveFailedFor", { label: t("ui.flashAttention") }));
    setPhase("dirty");
  };

  const updateServerText = (key: ServerTextKey, value: string) => {
    if (applyLockRef.current) return;
    void savePatch({ [key]: value } as Partial<AppConfig>, t("ui.saveFailedFor", { label: t(`ui.${SERVER_TEXT_LABEL_KEYS[key]}`) }));
    setPhase("dirty");
  };

  const commitServerText = async (key: ServerTextKey, raw: string) => {
    if (applyLockRef.current || !cfg) return;
    if (key === "mmproj" && !projectorEditable) {
      setServerTextDrafts((current) => ({ ...current, mmproj: cfg.mmproj }));
      notify(t("ui.stopBeforeProjector"));
      return;
    }
    const value = raw.trim();
    const saved = await savePatch({ [key]: value } as Partial<AppConfig>, t("ui.saveFailedFor", { label: t(`ui.${SERVER_TEXT_LABEL_KEYS[key]}`) }));
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

  const serverTextValue = (key: ServerTextKey): string => {
    const value = String(serverTextDrafts[key] ?? cfg?.[key] ?? "");
    return serverPathKeys.has(key) ? normalizeDisplayPath(value) : value;
  };

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
    void savePatch({ reasoning_effort: value }, t("ui.saveFailedFor", { label: t("ui.reasoningEffort") }));
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
        ? t("extra.advancedSaved")
        : t("extra.advancedSavedDraftPending"));
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
        ? t("extra.advancedSaved")
        : t("extra.advancedSavedDraftPending"));
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
    const saved = await savePatch(preset as Partial<AppConfig>, t("ui.saveFailedFor", { label: name }));
    if (!saved) return;
    setPhase("dirty");
    notify(t("extra.presetLoaded", { name }));
  };

  const resetDefaults = () => {
    if (applyLockRef.current || !cfg) return;
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
    void savePatch({ ...QWEN38_DEFAULTS, mmproj: cfg.mmproj, server_args: [...QWEN38_SERVER_ARGS], chat_options: QWEN38_CHAT_OPTIONS }, t("ui.saveFailedFor", { label: t("ui.loadQwenProfile") }));
    setPhase("dirty");
    notify(t("extra.defaultsLoaded"));
  };

  const applyRestart = async () => {
    if (phase === "applying" || store.busy || !cfg) return;
    if (store.status.state !== "running") {
      setPhase("idle");
      notify(t("extra.savedNextStart"));
      return;
    }
    applyLockRef.current = true;
    try {
      await performApplyRestart(store, cfg, locale, notify, setPhase, setChangedServerFields);
    } finally {
      applyLockRef.current = false;
    }
  };

  applyRestartRef.current = applyRestart;

  return {
    cfg, locale, phase, setPhase, flash, notify, dismissFlash,
    serverArgsDraft, setServerArgsDraft, chatOptionsDraft, setChatOptionsDraft,
    serverArgsDirty, setServerArgsDirty, chatOptionsDirty, setChatOptionsDirty,
    advancedError, setAdvancedError,
    numericDrafts, setNumericDrafts, chatOptionDrafts, setChatOptionDrafts,
    chatOptionSelectModes, setChatOptionSelectModes, serverTextDrafts, setServerTextDrafts,
    changedServerFields, pendingBulkChange, setPendingBulkChange,
    serverArgsDraftRef, chatOptionsDraftRef,
    projectorEditable, configMutationsDisabled, relationWarnings, numericFieldLabel,
    commitNumeric, commitChatOption, updateFlash, updateServerText, commitServerText,
    serverTextValue, serverSelectOptions, serverSelectValue, selectServerText,
    updateReasoningEffort, saveServerArgs, saveChatOptions, applyPreset, resetDefaults, applyRestart,
  };
}
