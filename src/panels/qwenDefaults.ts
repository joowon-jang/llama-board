import type { AppConfig } from "../api";

/** Recommended baseline for Qwen3.8-27B GGUF in llama.cpp. */
export const QWEN38_DEFAULTS: Pick<
  AppConfig,
  | "ngl"
  | "ctx_size"
  | "batch_size"
  | "ubatch_size"
  | "keep"
  | "cache_type_k"
  | "cache_type_v"
  | "flash_attn"
  | "n_cpu_moe"
  | "threads"
  | "temperature"
  | "top_p"
  | "top_k"
  | "spec_type"
  | "spec_draft_n_max"
  | "spec_draft_n_min"
  | "spec_draft_p_min"
  | "spec_draft_p_split"
  | "spec_draft_ngl"
  | "spec_draft_device"
  | "spec_draft_model"
  | "reasoning"
  | "reasoning_format"
  | "reasoning_effort"
  | "reasoning_budget"
  | "reasoning_budget_message"
  | "reasoning_preserve"
  | "mmproj"
  | "parallel"
> = {
  ngl: 99,
  ctx_size: 131072,
  batch_size: 1024,
  ubatch_size: 512,
  keep: 0,
  cache_type_k: "q8_0",
  cache_type_v: "q8_0",
  flash_attn: "on",
  n_cpu_moe: 0,
  threads: 0,
  temperature: 1.0,
  top_p: 0.95,
  top_k: 20,
  spec_type: "draft-mtp",
  spec_draft_n_max: 5,
  spec_draft_n_min: 0,
  spec_draft_p_min: 0.0,
  spec_draft_p_split: 0.0,
  spec_draft_ngl: "all",
  spec_draft_device: "",
  spec_draft_model: "",
  reasoning: "on",
  reasoning_format: "deepseek",
  reasoning_effort: "xhigh",
  reasoning_budget: -1,
  reasoning_budget_message: "",
  reasoning_preserve: "on",
  mmproj: "",
  parallel: 1,
};

/** DFlash2 speculative-decoding overrides for the Qwen3.8 target profile. */
export const QWEN38_DFLASH2_PR_BUILD = "pr27342";

export const QWEN38_DFLASH2_DEFAULTS: Pick<
  AppConfig,
  "spec_type" | "spec_draft_n_max"
> = {
  spec_type: "draft-dflash",
  spec_draft_n_max: 7,
};

/** Request options for Qwen3.8 thinking mode. */
export const QWEN38_CHAT_OPTIONS: AppConfig["chat_options"] = {
  min_p: 0.0,
  repeat_penalty: 1.0,
  presence_penalty: 0.0,
  max_tokens: 131072,
  chat_template_kwargs: {
    enable_thinking: true,
    preserve_thinking: true,
  },
};

/** Additional llama-server flags used by the Qwen3.8 long-context profile. */
export const QWEN38_SERVER_ARGS = [
  "--cache-ram",
  "16384",
  "--ctx-checkpoints",
  "32",
  "--cache-prompt",
  "--kv-unified",
  "--no-context-shift",
  "--jinja",
  "--spec-draft-type-k",
  "q8_0",
  "--spec-draft-type-v",
  "q8_0",
  "--spec-draft-backend-sampling",
] as const;
