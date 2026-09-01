import type { AppConfig } from "../api";
import { CACHE_TYPE_OPTIONS, MIROSTAT_OPTIONS } from "./tuningValidation";

export type NumericKey =
  | "ngl" | "ctx_size" | "batch_size" | "ubatch_size" | "keep"
  | "n_cpu_moe" | "threads" | "parallel"
  | "request_timeout_seconds" | "sleep_idle_seconds" | "temperature" | "top_p" | "top_k"
  | "spec_draft_n_max" | "spec_draft_n_min" | "spec_draft_p_min" | "spec_draft_p_split"
  | "reasoning_budget";

export type ServerTextKey =
  | "spec_type" | "spec_draft_ngl" | "spec_draft_device" | "spec_draft_model"
  | "reasoning" | "reasoning_format" | "reasoning_budget_message" | "reasoning_preserve" | "mmproj"
  | "cache_type_k" | "cache_type_v";

/** Stable navigation categories for the staged Tuning redesign. */
export type TuningCategoryId =
  | "runtime"
  | "context"
  | "sampling"
  | "reasoning"
  | "speculative"
  | "multimodal"
  | "advanced";

export type TuningViewMode = "quick" | "advanced";
export type TuningSectionId = "server" | "sampling" | "reasoning" | "escape";

/** Shared id linking the mode tablist/category nav to the rendered section (aria-controls target). */
export const TUNING_CONTENT_PANEL_ID = "tuning-panel-content";

/** Small, serializable tooltip payload shared by fields and nav entries. */
export interface TuningTooltip {
  title: string;
  description: string;
}

export interface TuningCategory {
  id: TuningCategoryId;
  label: string;
  description: string;
  section: TuningSectionId;
  modes: readonly TuningViewMode[];
  keywords: readonly string[];
}

interface TuningFieldMetadata {
  /** Category used by the phase-1 left navigation and search index. */
  category: TuningCategoryId;
  /** Concise help shown by the field's tooltip affordance. */
  tooltip: TuningTooltip;
  /** Upstream names, including aliases when a field maps to more than one. */
  aliases?: readonly string[];
  /** Upstream request key when it differs from the persisted/UI key. */
  requestKey?: string;
  /** Hide from the Quick view while retaining it in Advanced. */
  advancedOnly?: boolean;
}

export interface NumericField extends TuningFieldMetadata {
  key: NumericKey;
  label: string;
  step: number;
  min: number;
  max: number;
  server: boolean;
  hint: string;
}

export interface ChatOptionField extends TuningFieldMetadata {
  key: string;
  label: string;
  step: number;
  min: number;
  max: number;
  defaultValue: number;
  hint: string;
  options?: readonly { value: number; label: string }[];
}

/**
 * Category metadata is intentionally UI-only.  Persisted runtime settings
 * remain the flat AppConfig fields and future/unknown llama.cpp values stay in
 * server_args/chat_options until a later schema-driven editor is introduced.
 */
export const TUNING_CATEGORIES: readonly TuningCategory[] = [
  {
    id: "runtime",
    label: "Runtime",
    description: "GPU offload, CPU execution, slots, and lifecycle settings.",
    section: "server",
    modes: ["quick", "advanced"],
    keywords: ["gpu", "cpu", "threads", "slots", "timeout", "idle", "flash", "runtime"],
  },
  {
    id: "context",
    label: "Context & memory",
    description: "Context capacity and the values that shape memory use.",
    section: "server",
    modes: ["quick", "advanced"],
    keywords: ["context", "memory", "ctx", "kv", "batch"],
  },
  {
    id: "sampling",
    label: "Sampling",
    description: "Per-request token selection and repetition controls.",
    section: "sampling",
    modes: ["quick", "advanced"],
    keywords: ["temperature", "top", "probability", "penalty", "dry", "mirostat", "seed", "sampler", "chain"],
  },
  {
    id: "reasoning",
    label: "Reasoning",
    description: "Thinking mode, format, effort, and token budgets.",
    section: "reasoning",
    modes: ["quick", "advanced"],
    keywords: ["thinking", "reasoning", "effort", "budget", "deepseek"],
  },
  {
    id: "speculative",
    label: "Speculative",
    description: "Draft-model and speculative decoding controls.",
    section: "server",
    modes: ["advanced"],
    keywords: ["draft", "speculative", "mtp", "ngram", "eagle", "dflash"],
  },
  {
    id: "multimodal",
    label: "Multimodal",
    description: "Vision projector and multimodal model sidecars.",
    section: "server",
    modes: ["advanced"],
    keywords: ["vision", "image", "video", "projector", "mmproj"],
  },
  {
    id: "advanced",
    label: "Advanced / raw",
    description: "Future llama.cpp options through the raw escape hatches.",
    section: "escape",
    modes: ["advanced"],
    keywords: ["raw", "json", "server", "argument", "escape", "future"],
  },
] as const;

/** Alias retained for callers that prefer a definitions-oriented name. */
export const TUNING_CATEGORY_DEFINITIONS = TUNING_CATEGORIES;

export const SERVER_FIELDS: NumericField[] = [
  { key: "ngl", label: "GPU layers (ngl)", step: 1, min: 0, max: 128, server: true, hint: "0–128. 0 keeps inference on CPU.", category: "runtime", tooltip: { title: "GPU layers", description: "Number of model layers offloaded to the selected GPU." }, aliases: ["--n-gpu-layers", "--gpu-layers", "-ngl"] },
  { key: "ctx_size", label: "Context size", step: 256, min: 512, max: 131072, server: true, hint: "512–131072 tokens. Restart required.", category: "context", tooltip: { title: "Context size", description: "Maximum prompt and generation context allocated by the server." }, aliases: ["--ctx-size", "-c"] },
  { key: "batch_size", label: "Batch size", step: 64, min: 1, max: 131072, server: true, hint: "Logical prompt-processing batch. Restart required.", category: "context", tooltip: { title: "Batch size", description: "Maximum number of tokens processed together during prompt evaluation." }, aliases: ["--batch-size", "-b"], advancedOnly: true },
  { key: "ubatch_size", label: "Micro batch size", step: 64, min: 1, max: 131072, server: true, hint: "Physical micro-batch; keep it at or below batch size.", category: "context", tooltip: { title: "Micro batch size", description: "Physical batch submitted to the backend at once; smaller values reduce peak memory." }, aliases: ["--ubatch-size", "-ub"], advancedOnly: true },
  { key: "keep", label: "Keep prompt tokens", step: 1, min: 0, max: 131072, server: true, hint: "Tokens retained when context shifting. Restart required.", category: "context", tooltip: { title: "Keep prompt tokens", description: "Number of initial prompt tokens retained when the context window shifts." }, aliases: ["--keep"], advancedOnly: true },
  { key: "n_cpu_moe", label: "CPU MoE (n-cpu-moe)", step: 1, min: 0, max: 64, server: true, hint: "0–64 experts kept on CPU.", category: "runtime", tooltip: { title: "CPU MoE", description: "Keep a selected number of mixture-of-experts layers on the CPU." }, aliases: ["--n-cpu-moe", "-ncmoe"] },
  { key: "threads", label: "Threads", step: 1, min: 0, max: 64, server: true, hint: "0 = auto. Restart required.", category: "runtime", tooltip: { title: "CPU threads", description: "Inference thread count; zero lets llama.cpp choose automatically." }, aliases: ["--threads", "-t"] },
  { key: "parallel", label: "Server slots", step: 1, min: 0, max: 128, server: true, hint: "0 = auto. More slots increase concurrent memory use.", category: "runtime", tooltip: { title: "Server slots", description: "Concurrent request slots. More slots increase KV memory use." }, aliases: ["--parallel", "-np"] },
  { key: "request_timeout_seconds", label: "Request timeout (seconds)", step: 1, min: 1, max: 86400, server: true, hint: "llama-server read/write timeout. Restart required.", category: "runtime", tooltip: { title: "Request timeout", description: "Maximum time llama-server waits for a request or response." }, aliases: ["--timeout", "-to"] },
  { key: "sleep_idle_seconds", label: "Sleep after idle (seconds)", step: 1, min: -1, max: 604800, server: true, hint: "−1 disables sleep; llama.cpp releases idle compute state.", category: "runtime", tooltip: { title: "Idle sleep", description: "Release idle compute state after this many seconds; −1 disables it." }, aliases: ["--sleep-idle-seconds"] },
];

export const MTP_FIELDS: NumericField[] = [
  { key: "spec_draft_n_max", label: "Draft max tokens", step: 1, min: 0, max: 64, server: true, hint: "--spec-draft-n-max. Qwen3.8 default: 5.", category: "speculative", tooltip: { title: "Draft max tokens", description: "Upper bound for tokens proposed by the speculative draft model." }, aliases: ["--spec-draft-n-max"], advancedOnly: true },
  { key: "spec_draft_n_min", label: "Draft min tokens", step: 1, min: 0, max: 64, server: true, hint: "--spec-draft-n-min. Default: 0.", category: "speculative", tooltip: { title: "Draft min tokens", description: "Minimum draft proposal size before verification." }, aliases: ["--spec-draft-n-min"], advancedOnly: true },
  { key: "spec_draft_p_min", label: "Draft min probability", step: 0.01, min: 0, max: 1, server: true, hint: "--spec-draft-p-min. 0 disables the threshold.", category: "speculative", tooltip: { title: "Draft min probability", description: "Reject draft tokens below this probability threshold." }, aliases: ["--spec-draft-p-min", "--draft-p-min"], advancedOnly: true },
  { key: "spec_draft_p_split", label: "Draft split probability", step: 0.01, min: 0, max: 1, server: true, hint: "--spec-draft-p-split. Qwen3.8 default: 0.", category: "speculative", tooltip: { title: "Draft split probability", description: "Probability used to split speculative draft work." }, aliases: ["--spec-draft-p-split", "--draft-p-split"], advancedOnly: true },
];

export const REASONING_FIELDS: NumericField[] = [
  { key: "reasoning_budget", label: "Reasoning token budget", step: 1, min: -1, max: 1048576, server: true, hint: "−1 is unlimited; 0 ends thinking immediately.", category: "reasoning", tooltip: { title: "Reasoning budget", description: "Maximum reasoning tokens at server start; −1 leaves the budget unlimited." }, aliases: ["--reasoning-budget"] },
];

export const SAMPLING_FIELDS: NumericField[] = [
  { key: "temperature", label: "Temperature", step: 0.05, min: 0, max: 2, server: false, hint: "0–2. Higher = more random.", category: "sampling", tooltip: { title: "Temperature", description: "Controls how much probability is spread across candidate tokens." }, aliases: ["temperature"] },
  { key: "top_p", label: "Top-p", step: 0.01, min: 0.01, max: 1, server: false, hint: "0.01–1. Nucleus sampling.", category: "sampling", tooltip: { title: "Top-p", description: "Limits sampling to the smallest set of tokens within this cumulative probability." }, aliases: ["top_p"] },
  { key: "top_k", label: "Top-k", step: 1, min: 1, max: 200, server: false, hint: "1–200. Candidate pool size.", category: "sampling", tooltip: { title: "Top-k", description: "Limits sampling to the most likely K candidate tokens." }, aliases: ["top_k"] },
];

export const ADVANCED_SAMPLING_FIELDS: ChatOptionField[] = [
  { key: "min_p", label: "Min-p", step: 0.01, min: 0, max: 1, defaultValue: 0.05, hint: "0 disables. Minimum probability relative to the best token.", category: "sampling", tooltip: { title: "Min-p", description: "Discard tokens below this share of the most likely token's probability." }, aliases: ["min_p"], advancedOnly: true },
  { key: "top_n_sigma", label: "Top-n-sigma", step: 0.01, min: -1, max: 10, defaultValue: -1, hint: "−1 disables sigma sampling.", category: "sampling", tooltip: { title: "Top-n-sigma", description: "Use the logits distribution's standard deviation to trim candidates." }, aliases: ["top_n_sigma"], advancedOnly: true },
  { key: "typical_p", label: "Typical-p", step: 0.01, min: 0, max: 1, defaultValue: 1, hint: "1 disables locally typical sampling.", category: "sampling", tooltip: { title: "Typical-p", description: "Prefer tokens whose information content is typical for the distribution." }, aliases: ["typical_p"], advancedOnly: true },
  { key: "xtc_probability", label: "XTC probability", step: 0.01, min: 0, max: 1, defaultValue: 0, hint: "0 disables XTC sampling.", category: "sampling", tooltip: { title: "XTC probability", description: "Probability of applying the XTC token filter." }, aliases: ["xtc_probability"], advancedOnly: true },
  { key: "xtc_threshold", label: "XTC threshold", step: 0.01, min: 0, max: 1, defaultValue: 0.1, hint: "1 disables XTC token filtering.", category: "sampling", tooltip: { title: "XTC threshold", description: "Minimum candidate probability used by XTC filtering." }, aliases: ["xtc_threshold"], advancedOnly: true },
  { key: "dynatemp_range", label: "Dynamic temperature range", step: 0.05, min: 0, max: 2, defaultValue: 0, hint: "0 disables dynamic temperature.", category: "sampling", tooltip: { title: "Dynamic temperature range", description: "Amount by which temperature can vary with the distribution." }, aliases: ["dynatemp_range"], advancedOnly: true },
  { key: "dynatemp_exponent", label: "Dynamic temperature exponent", step: 0.05, min: 0.1, max: 3, defaultValue: 1, hint: "Exponent used when dynamic temperature is enabled.", category: "sampling", tooltip: { title: "Dynamic temperature exponent", description: "Exponent applied to the dynamic temperature adjustment." }, aliases: ["dynatemp_exponent"], advancedOnly: true },
  { key: "repeat_last_n", label: "Repeat last n", step: 1, min: -1, max: 131072, defaultValue: 64, hint: "−1 uses the context size; 0 disables repetition penalties.", category: "sampling", tooltip: { title: "Repeat window", description: "Number of recent tokens examined for repetition penalties." }, aliases: ["repeat_last_n"], advancedOnly: true },
  { key: "repeat_penalty", label: "Repeat penalty", step: 0.01, min: 0, max: 2, defaultValue: 1, hint: "1 disables the traditional repetition penalty.", category: "sampling", tooltip: { title: "Repeat penalty", description: "Penalize tokens that appeared in the repetition window." }, aliases: ["repeat_penalty"], advancedOnly: true },
  { key: "presence_penalty", label: "Presence penalty", step: 0.01, min: -2, max: 2, defaultValue: 0, hint: "0 disables presence penalty.", category: "sampling", tooltip: { title: "Presence penalty", description: "Adjust the likelihood of tokens that have appeared at least once." }, aliases: ["presence_penalty"], advancedOnly: true },
  { key: "frequency_penalty", label: "Frequency penalty", step: 0.01, min: -2, max: 2, defaultValue: 0, hint: "0 disables frequency penalty.", category: "sampling", tooltip: { title: "Frequency penalty", description: "Adjust token likelihood based on how often each token appeared." }, aliases: ["frequency_penalty"], advancedOnly: true },
  { key: "dry_multiplier", label: "DRY multiplier", step: 0.05, min: 0, max: 2, defaultValue: 0, hint: "0 disables DRY repetition control.", category: "sampling", tooltip: { title: "DRY multiplier", description: "Strength of the DRY repetition penalty." }, aliases: ["dry_multiplier"], advancedOnly: true },
  { key: "dry_base", label: "DRY base", step: 0.05, min: 1, max: 3, defaultValue: 1.75, hint: "Exponential base for DRY penalties.", category: "sampling", tooltip: { title: "DRY base", description: "Exponential base used to scale DRY penalties." }, aliases: ["dry_base"], advancedOnly: true },
  { key: "dry_allowed_length", label: "DRY allowed length", step: 1, min: 0, max: 128, defaultValue: 2, hint: "Repeated sequence length allowed before DRY applies.", category: "sampling", tooltip: { title: "DRY allowed length", description: "Repeated sequence length allowed before DRY is applied." }, aliases: ["dry_allowed_length"], advancedOnly: true },
  { key: "dry_penalty_last_n", label: "DRY penalty last n", step: 1, min: 0, max: 131072, defaultValue: 64, hint: "0 disables the DRY scan window.", category: "sampling", tooltip: { title: "DRY scan window", description: "Number of recent tokens scanned for repeated sequences." }, aliases: ["dry_penalty_last_n"], advancedOnly: true },
  { key: "mirostat", label: "Mirostat mode", step: 1, min: 0, max: 2, defaultValue: 0, options: MIROSTAT_OPTIONS, hint: "0 off, 1 Mirostat, 2 Mirostat 2.0.", category: "sampling", tooltip: { title: "Mirostat mode", description: "Adaptive sampler mode; 0 leaves Mirostat disabled." }, aliases: ["mirostat"], advancedOnly: true },
  { key: "mirostat_lr", label: "Mirostat learning rate", step: 0.01, min: 0, max: 1, defaultValue: 0.1, hint: "Eta parameter used by Mirostat.", category: "sampling", tooltip: { title: "Mirostat learning rate", description: "CLI alias for request field mirostat_eta.", }, aliases: ["--mirostat-lr", "mirostat_lr"], requestKey: "mirostat_eta", advancedOnly: true },
  { key: "mirostat_ent", label: "Mirostat target entropy", step: 0.1, min: 0, max: 20, defaultValue: 5, hint: "Tau parameter used by Mirostat.", category: "sampling", tooltip: { title: "Mirostat target entropy", description: "CLI alias for request field mirostat_tau.", }, aliases: ["--mirostat-ent", "mirostat_ent"], requestKey: "mirostat_tau", advancedOnly: true },
  { key: "seed", label: "Seed", step: 1, min: -1, max: 4294967295, defaultValue: -1, hint: "−1 selects a random seed for each request.", category: "sampling", tooltip: { title: "Seed", description: "Seed for deterministic sampling; −1 selects a random seed." }, aliases: ["seed"], advancedOnly: true },
  { key: "max_tokens", label: "Max tokens", step: 1, min: -1, max: 131072, defaultValue: -1, hint: "−1 uses the server default / available context.", category: "sampling", tooltip: { title: "Max tokens", description: "Maximum completion tokens; sent as max_tokens on the chat request." }, aliases: ["max_tokens", "max_completion_tokens", "n_predict"], requestKey: "max_tokens", advancedOnly: true },
  { key: "n_probs", label: "Token probabilities", step: 1, min: 0, max: 100, defaultValue: 0, hint: "0 disables probability data in the response.", category: "sampling", tooltip: { title: "Token probabilities", description: "Number of token probabilities to request in the response." }, aliases: ["n_probs", "logprobs"], advancedOnly: true },
  { key: "min_keep", label: "Minimum kept tokens", step: 1, min: 0, max: 100, defaultValue: 0, hint: "0 lets samplers choose freely.", category: "sampling", tooltip: { title: "Minimum kept tokens", description: "Keep at least this many candidates through sampler stages." }, aliases: ["min_keep"], advancedOnly: true },
  { key: "t_max_predict_ms", label: "Prediction time limit (ms)", step: 1, min: 0, max: 3600000, defaultValue: 0, hint: "0 disables the generation time limit.", category: "sampling", tooltip: { title: "Prediction time limit", description: "Stop generation after this many milliseconds; 0 disables the limit." }, aliases: ["t_max_predict_ms"], advancedOnly: true },
  { key: "id_slot", label: "Slot id", step: 1, min: -1, max: 1024, defaultValue: -1, hint: "−1 lets llama-server choose an idle slot.", category: "sampling", tooltip: { title: "Slot id", description: "Pin this request to a llama-server slot; −1 selects automatically." }, aliases: ["id_slot"], advancedOnly: true },
];

export interface ServerTextField extends TuningFieldMetadata {
  key: ServerTextKey;
  label: string;
  options?: readonly string[];
}

/** Non-numeric dedicated controls included in the same category/search index. */
export const SERVER_TEXT_FIELDS: ServerTextField[] = [
  { key: "spec_type", label: "Speculative type", category: "speculative", tooltip: { title: "Speculative type", description: "Select the draft or n-gram strategy used by llama.cpp." }, aliases: ["--spec-type"], advancedOnly: true },
  { key: "spec_draft_ngl", label: "Draft GPU layers", category: "speculative", tooltip: { title: "Draft GPU layers", description: "GPU layers used by the speculative draft model." }, aliases: ["--spec-draft-ngl", "--gpu-layers-draft", "--n-gpu-layers-draft"], advancedOnly: true },
  { key: "spec_draft_device", label: "Draft device", category: "speculative", tooltip: { title: "Draft device", description: "Optional device selector for speculative decoding." }, aliases: ["--spec-draft-device", "-devd", "--device-draft"], advancedOnly: true },
  { key: "spec_draft_model", label: "Draft model", category: "speculative", tooltip: { title: "Draft model", description: "Optional GGUF draft model used by draft-based speculation." }, aliases: ["--spec-draft-model", "-md", "--model-draft"], advancedOnly: true },
  { key: "reasoning", label: "Reasoning mode", category: "reasoning", tooltip: { title: "Reasoning mode", description: "Server-side reasoning mode: automatic, on, or off." }, aliases: ["--reasoning", "-rea"] },
  { key: "reasoning_format", label: "Reasoning format", category: "reasoning", tooltip: { title: "Reasoning format", description: "Format used to expose reasoning content from the runtime." }, aliases: ["--reasoning-format"] },
  { key: "reasoning_budget_message", label: "Reasoning budget message", category: "reasoning", tooltip: { title: "Budget message", description: "Optional message emitted when the reasoning budget is exhausted." }, aliases: ["--reasoning-budget-message"] },
  { key: "reasoning_preserve", label: "Preserve reasoning", category: "reasoning", tooltip: { title: "Preserve reasoning", description: "Choose whether reasoning content is preserved between template stages." }, aliases: ["--reasoning-preserve", "--no-reasoning-preserve"] },
  { key: "mmproj", label: "Vision projector", category: "multimodal", tooltip: { title: "Vision projector", description: "Local mmproj GGUF sidecar used for image input." }, aliases: ["--mmproj", "-mm"], advancedOnly: true },
  { key: "cache_type_k", label: "KV cache key type", category: "context", tooltip: { title: "KV cache key type", description: "Data type used for key vectors in the server KV cache." }, aliases: ["--cache-type-k", "-ctk"], options: CACHE_TYPE_OPTIONS, advancedOnly: true },
  { key: "cache_type_v", label: "KV cache value type", category: "context", tooltip: { title: "KV cache value type", description: "Data type used for value vectors in the server KV cache." }, aliases: ["--cache-type-v", "-ctv"], options: CACHE_TYPE_OPTIONS, advancedOnly: true },
];

export interface TuningFieldCatalogEntry {
  key: string;
  label: string;
  category: TuningCategoryId;
  tooltip: TuningTooltip;
  advancedOnly?: boolean;
  aliases?: readonly string[];
  requestKey?: string;
  options?: readonly string[] | readonly { value: number; label: string }[];
  kind: "numeric" | "text" | "chat-option";
}

/** Flattened catalog consumed by the phase-1 nav/search shell. */
export const TUNING_FIELD_CATALOG: readonly TuningFieldCatalogEntry[] = [
  ...SERVER_FIELDS.map((field) => ({ ...field, kind: "numeric" as const })),
  ...MTP_FIELDS.map((field) => ({ ...field, kind: "numeric" as const })),
  ...REASONING_FIELDS.map((field) => ({ ...field, kind: "numeric" as const })),
  ...SAMPLING_FIELDS.map((field) => ({ ...field, kind: "numeric" as const })),
  ...ADVANCED_SAMPLING_FIELDS.map((field) => ({ ...field, kind: "chat-option" as const })),
  ...SERVER_TEXT_FIELDS.map((field) => ({ ...field, kind: "text" as const })),
];

export function categoryForTuningField(field: Pick<TuningFieldCatalogEntry, "category">): TuningCategory {
  return TUNING_CATEGORIES.find((category) => category.id === field.category) ?? TUNING_CATEGORIES[0];
}

export function tuningCatalogMatches(entry: TuningFieldCatalogEntry, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  const category = categoryForTuningField(entry);
  return [entry.key, entry.requestKey ?? "", entry.label, entry.tooltip.title, entry.tooltip.description, ...(entry.aliases ?? []), category.label, ...category.keywords]
    .some((value) => value.toLocaleLowerCase().includes(normalized));
}

export const valueOf = (cfg: AppConfig, key: NumericKey): number => cfg[key] as number;
export const chatOptionValue = (cfg: { chat_options?: Record<string, unknown> }, field: ChatOptionField): number => {
  const value = cfg.chat_options?.[field.key];
  return typeof value === "number" && Number.isFinite(value) ? value : field.defaultValue;
};
