import type { Dispatch, SetStateAction } from "react";
import type { AppConfig } from "../api";
import type { AppStore } from "../store";
import type { ConfigPatch } from "../configSaveQueue";
import type { Locale } from "../i18nCatalog";
import { translate } from "../i18nUnified";
import { clampNumber, parseNumericInput } from "./tuningValidation";
import { canRollbackAtRevision, draftStillCurrent } from "./tuningAsync";
import { chatOptionValue, valueOf, type ChatOptionField, type NumericField, type NumericKey, type ServerTextKey } from "./tuningFields";
import type { UiTextKey } from "../uiI18n";

export type TuningPhase = "idle" | "dirty" | "applying" | "failed";

export const serverPathKeys = new Set<ServerTextKey>(["mmproj", "spec_draft_model"]);

export const SERVER_FIELD_LABEL_KEYS: Partial<Record<NumericKey, UiTextKey>> = {
  ngl: "profileGpuLayers",
  ctx_size: "profileContextSize",
  n_cpu_moe: "profileCpuMoe",
  threads: "profileThreads",
  parallel: "profileServerSlots",
  request_timeout_seconds: "profileRequestTimeout",
  sleep_idle_seconds: "profileSleepAfterIdle",
  spec_draft_n_max: "profileDraftMaxTokens",
  spec_draft_n_min: "profileDraftMinTokens",
  spec_draft_p_min: "profileDraftMinProbability",
  spec_draft_p_split: "profileDraftSplitProbability",
  reasoning_budget: "profileReasoningBudget",
};

export const SERVER_TEXT_LABEL_KEYS: Record<ServerTextKey, UiTextKey> = {
  spec_type: "profileSpeculativeType",
  spec_draft_ngl: "profileDraftGpuLayers",
  spec_draft_device: "profileDraftDevice",
  spec_draft_model: "profileDraftModel",
  reasoning: "profileReasoning",
  reasoning_format: "profileReasoningFormat",
  reasoning_budget_message: "profileReasoningBudgetMessage",
  reasoning_preserve: "profileReasoningPreserve",
  mmproj: "profileVisionProjector",
};

export function serverConfigSnapshot(cfg: AppConfig): Partial<AppConfig> {
  return {
    active_backend: cfg.active_backend,
    ctx_size: cfg.ctx_size,
    ngl: cfg.ngl,
    n_cpu_moe: cfg.n_cpu_moe,
    threads: cfg.threads,
    parallel: cfg.parallel,
    request_timeout_seconds: cfg.request_timeout_seconds,
    sleep_idle_seconds: cfg.sleep_idle_seconds,
    flash_attn: cfg.flash_attn,
    spec_type: cfg.spec_type,
    spec_draft_n_max: cfg.spec_draft_n_max,
    spec_draft_n_min: cfg.spec_draft_n_min,
    spec_draft_p_min: cfg.spec_draft_p_min,
    spec_draft_p_split: cfg.spec_draft_p_split,
    spec_draft_ngl: cfg.spec_draft_ngl,
    spec_draft_device: cfg.spec_draft_device,
    spec_draft_model: cfg.spec_draft_model,
    reasoning: cfg.reasoning,
    reasoning_format: cfg.reasoning_format,
    reasoning_budget: cfg.reasoning_budget,
    reasoning_budget_message: cfg.reasoning_budget_message,
    reasoning_preserve: cfg.reasoning_preserve,
    server_args: [...cfg.server_args],
    mmproj: cfg.mmproj,
  };
}

interface CommitFieldContext {
  locale: Locale;
  notify: (message: string) => void;
  savePatch: (patch: ConfigPatch<AppConfig>, failureLabel: string) => Promise<boolean>;
  setPhase: (phase: TuningPhase) => void;
}

/** Parses, clamps, optimistically drafts, and persists one server/sampling numeric field. */
export async function commitNumericField(
  cfg: AppConfig,
  field: NumericField,
  raw: string,
  numericFieldLabel: (field: NumericField) => string,
  setNumericDrafts: Dispatch<SetStateAction<Partial<Record<NumericKey, string>>>>,
  setChangedServerFields: Dispatch<SetStateAction<string[]>>,
  ctx: CommitFieldContext,
): Promise<void> {
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
    ctx.notify(translate(ctx.locale, "ui.clampedToRange", { label: numericFieldLabel(field), min: field.min, max: field.max }));
  }
  setNumericDrafts((current) => ({ ...current, [field.key]: String(normalized) }));
  const submitted = String(normalized);
  const saved = await ctx.savePatch({ [field.key]: normalized } as Partial<AppConfig>, translate(ctx.locale, "ui.saveFailedFor", { label: numericFieldLabel(field) }));
  if (saved) {
    setNumericDrafts((current) => {
      if (!draftStillCurrent(current[field.key], submitted)) return current;
      const next = { ...current };
      delete next[field.key];
      return next;
    });
    if (field.server) {
      ctx.setPhase("dirty");
      const label = numericFieldLabel(field);
      setChangedServerFields((current) => current.includes(label) ? current : [...current, label]);
    }
  }
}

/** Parses, clamps, optimistically drafts, and persists one per-request chat-option field. */
export async function commitChatOptionField(
  cfg: AppConfig,
  field: ChatOptionField,
  raw: string,
  setChatOptionDrafts: Dispatch<SetStateAction<Record<string, string>>>,
  setChatOptionSelectModes: Dispatch<SetStateAction<Record<string, "select" | "custom">>>,
  ctx: CommitFieldContext,
): Promise<void> {
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
  if (normalized !== parsed) ctx.notify(translate(ctx.locale, "ui.clampedToRange", { label: field.label, min: field.min, max: field.max }));
  setChatOptionDrafts((current) => ({ ...current, [field.key]: String(normalized) }));
  const submitted = String(normalized);
  const saved = await ctx.savePatch(
    (current) => ({ chat_options: { ...current.chat_options, [field.key]: normalized } }),
    translate(ctx.locale, "ui.saveFailedFor", { label: field.label }),
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
}

/** Stops and restarts the running server to pick up server-side config changes, rolling back on failure when the config revision hasn't moved on. Caller must confirm the server is running first. */
export async function performApplyRestart(
  store: AppStore,
  cfg: AppConfig,
  locale: Locale,
  notify: (message: string) => void,
  setPhase: (phase: TuningPhase) => void,
  setChangedServerFields: Dispatch<SetStateAction<string[]>>,
): Promise<void> {
  const before = store.getConfig() ?? cfg;
  const startRevision = store.getConfigRevision();
  setPhase("applying");
  try {
    await store.stop();
    await store.start();
    setPhase("idle");
    setChangedServerFields([]);
    const applied = store.getConfig() ?? before;
    notify(translate(locale, "ui.applySuccessNotice", { ngl: applied.ngl, ctx: applied.ctx_size }));
  } catch (error) {
    let rollbackError: unknown = null;
    let rollbackMessage = translate(locale, "ui.applyRollbackPreserved");
    if (canRollbackAtRevision(startRevision, store.getConfigRevision())) {
      try {
        await store.updateConfig(serverConfigSnapshot(before));
        rollbackMessage = translate(locale, "ui.applyRollbackRestored");
      } catch (rollbackCaught) {
        rollbackError = rollbackCaught;
      }
    }
    setPhase("failed");
    const detail = error instanceof Error ? error.message : String(error);
    const rollback = rollbackError
      ? translate(locale, "ui.applyRollbackFailed", { message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) })
      : rollbackMessage;
    notify(translate(locale, "ui.applyFailedNotice", { detail, rollback }));
  }
}
