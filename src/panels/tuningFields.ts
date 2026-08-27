import type { AppConfig } from "../api";
import { MIROSTAT_OPTIONS } from "./tuningValidation";

export type NumericKey =
  | "ngl" | "ctx_size" | "n_cpu_moe" | "threads" | "parallel"
  | "request_timeout_seconds" | "sleep_idle_seconds" | "temperature" | "top_p" | "top_k"
  | "spec_draft_n_max" | "spec_draft_n_min" | "spec_draft_p_min" | "spec_draft_p_split"
  | "reasoning_budget";

export type ServerTextKey =
  | "spec_type" | "spec_draft_ngl" | "spec_draft_device" | "spec_draft_model"
  | "reasoning" | "reasoning_format" | "reasoning_budget_message" | "reasoning_preserve" | "mmproj";

export interface NumericField {
  key: NumericKey;
  label: string;
  step: number;
  min: number;
  max: number;
  server: boolean;
  hint: string;
}

export interface ChatOptionField {
  key: string;
  label: string;
  step: number;
  min: number;
  max: number;
  defaultValue: number;
  hint: string;
  options?: readonly { value: number; label: string }[];
}

export const SERVER_FIELDS: NumericField[] = [
  { key: "ngl", label: "GPU layers (ngl)", step: 1, min: 0, max: 128, server: true, hint: "0–128. 0 keeps inference on CPU." },
  { key: "ctx_size", label: "Context size", step: 256, min: 512, max: 131072, server: true, hint: "512–131072 tokens. Restart required." },
  { key: "n_cpu_moe", label: "CPU MoE (n-cpu-moe)", step: 1, min: 0, max: 64, server: true, hint: "0–64 experts kept on CPU." },
  { key: "threads", label: "Threads", step: 1, min: 0, max: 64, server: true, hint: "0 = auto. Restart required." },
  { key: "parallel", label: "Server slots", step: 1, min: 0, max: 128, server: true, hint: "0 = auto. More slots increase concurrent memory use." },
  { key: "request_timeout_seconds", label: "Request timeout (seconds)", step: 1, min: 1, max: 86400, server: true, hint: "llama-server read/write timeout. Restart required." },
  { key: "sleep_idle_seconds", label: "Sleep after idle (seconds)", step: 1, min: -1, max: 604800, server: true, hint: "−1 disables sleep; llama.cpp releases idle compute state." },
];

export const MTP_FIELDS: NumericField[] = [
  { key: "spec_draft_n_max", label: "Draft max tokens", step: 1, min: 0, max: 64, server: true, hint: "--spec-draft-n-max. Qwen3.8 default: 5." },
  { key: "spec_draft_n_min", label: "Draft min tokens", step: 1, min: 0, max: 64, server: true, hint: "--spec-draft-n-min. Default: 0." },
  { key: "spec_draft_p_min", label: "Draft min probability", step: 0.01, min: 0, max: 1, server: true, hint: "--spec-draft-p-min. 0 disables the threshold." },
  { key: "spec_draft_p_split", label: "Draft split probability", step: 0.01, min: 0, max: 1, server: true, hint: "--spec-draft-p-split. Qwen3.8 default: 0." },
];

export const REASONING_FIELDS: NumericField[] = [
  { key: "reasoning_budget", label: "Reasoning token budget", step: 1, min: -1, max: 1048576, server: true, hint: "−1 is unlimited; 0 ends thinking immediately." },
];

export const SAMPLING_FIELDS: NumericField[] = [
  { key: "temperature", label: "Temperature", step: 0.05, min: 0, max: 2, server: false, hint: "0–2. Higher = more random." },
  { key: "top_p", label: "Top-p", step: 0.01, min: 0.01, max: 1, server: false, hint: "0.01–1. Nucleus sampling." },
  { key: "top_k", label: "Top-k", step: 1, min: 1, max: 200, server: false, hint: "1–200. Candidate pool size." },
];

export const ADVANCED_SAMPLING_FIELDS: ChatOptionField[] = [
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

export const valueOf = (cfg: AppConfig, key: NumericKey): number => cfg[key] as number;
export const chatOptionValue = (cfg: { chat_options?: Record<string, unknown> }, field: ChatOptionField): number => {
  const value = cfg.chat_options?.[field.key];
  return typeof value === "number" && Number.isFinite(value) ? value : field.defaultValue;
};
