import type { ModelProfile, ServerProfile } from "../modelProfiles";
import type { UiTextKey } from "../uiI18n";

export type ServerKey = Exclude<keyof ServerProfile, "id" | "name" | "server_args">;
export type ModelKey = Exclude<keyof ModelProfile, "id" | "modelPath" | "name" | "chat_options" | "stop_strings">;

export const serverFields: Array<[ServerKey, UiTextKey, "number" | "text"]> = [
  ["backend", "profileBackend", "text"],
  ["ctx_size", "profileContextSize", "number"],
  ["ngl", "profileGpuLayers", "number"],
  ["n_cpu_moe", "profileCpuMoe", "number"],
  ["threads", "profileThreads", "number"],
  ["parallel", "profileServerSlots", "number"],
  ["request_timeout_seconds", "profileRequestTimeout", "number"],
  ["sleep_idle_seconds", "profileSleepAfterIdle", "number"],
  ["flash_attn", "profileFlashAttention", "text"],
  ["spec_type", "profileSpeculativeType", "text"],
  ["spec_draft_n_max", "profileDraftMaxTokens", "number"],
  ["spec_draft_n_min", "profileDraftMinTokens", "number"],
  ["spec_draft_p_min", "profileDraftMinProbability", "number"],
  ["spec_draft_p_split", "profileDraftSplitProbability", "number"],
  ["spec_draft_ngl", "profileDraftGpuLayers", "text"],
  ["spec_draft_device", "profileDraftDevice", "text"],
  ["spec_draft_model", "profileDraftModel", "text"],
  ["reasoning", "profileReasoning", "text"],
  ["reasoning_format", "profileReasoningFormat", "text"],
  ["reasoning_budget", "profileReasoningBudget", "number"],
  ["reasoning_preserve", "profileReasoningPreserve", "text"],
  ["reasoning_budget_message", "profileReasoningBudgetMessage", "text"],
  ["mmproj", "profileVisionProjector", "text"],
];

export const modelFields: Array<[ModelKey, UiTextKey, "number" | "text"]> = [
  ["temperature", "profileTemperature", "number"],
  ["top_p", "profileTopP", "number"],
  ["top_k", "profileTopK", "number"],
  ["reasoning_effort", "profileReasoningEffort", "text"],
];

export const chatKeys = [
  "min_p",
  "top_n_sigma",
  "typical_p",
  "xtc_probability",
  "xtc_threshold",
  "dynatemp_range",
  "dynatemp_exponent",
  "repeat_last_n",
  "repeat_penalty",
  "presence_penalty",
  "frequency_penalty",
  "dry_multiplier",
  "dry_base",
  "dry_allowed_length",
  "dry_penalty_last_n",
  "mirostat",
  "mirostat_lr",
  "mirostat_ent",
  "seed",
  "max_tokens",
  "n_probs",
  "min_keep",
  "t_max_predict_ms",
  "id_slot",
] as const;

export const inputClass = "mt-1 min-w-0 w-full rounded-lg border border-slate-700 app-bg-muted px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400";
export const fieldLabelClass = "min-w-0 text-xs text-slate-400";
export const fieldNameClass = "mb-1 block break-words";
export const serverPathKeys = new Set<ServerKey>(["spec_draft_model", "mmproj"]);
