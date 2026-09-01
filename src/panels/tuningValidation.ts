export function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Parse a completed numeric draft; empty/intermediate keyboard states are not values yet. */
export function parseNumericInput(raw: string, step: number): number | null {
  const value = raw.trim();
  if (value.length === 0 || /^[+-]?$/.test(value)) return null;
  const integerPattern = /^[+-]?\d+$/;
  const decimalPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  if (!(step < 1 ? decimalPattern : integerPattern).test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** llama.cpp's finite speculative-decoding modes exposed by --spec-type. */
export const SPEC_TYPE_OPTIONS = [
  "none",
  "draft-simple",
  "draft-eagle3",
  "draft-mtp",
  "draft-dflash",
  "draft-dspark",
  "ngram-simple",
  "ngram-map-k",
  "ngram-map-k4v",
  "ngram-mod",
  "ngram-cache",
] as const;

/** Named values accepted by --spec-draft-ngl before a custom numeric value. */
export const SPEC_DRAFT_NGL_OPTIONS = ["auto", "all"] as const;

/** Cache tensor types currently accepted by llama.cpp's common parameters. */
export const CACHE_TYPE_OPTIONS = [
  "f16",
  "f32",
  "bf16",
  "q8_0",
  "q5_0",
  "q5_1",
  "q4_0",
  "q4_1",
] as const;

export const MIROSTAT_OPTIONS = [
  { value: 0, label: "Off" },
  { value: 1, label: "Mirostat" },
  { value: 2, label: "Mirostat 2.0" },
] as const;

/**
 * The app owns these llama-server switches.  Keep the aliases in one map so
 * the UI parser can reject an override before it is persisted and callers can
 * explain which canonical option would have collided.  This list deliberately
 * includes the short/alternate spellings from the upstream help output: a
 * canonical-only block list would let raw arguments override a dedicated
 * control by spelling the same option differently.
 */
export const APP_MANAGED_SERVER_OPTION_ALIASES = {
  "--model": ["--model", "-m"],
  "--host": ["--host"],
  "--port": ["--port", "-p"],
  "--api-key": ["--api-key", "--api-key-file", "--no-api-key"],
  "--mmproj": ["--mmproj", "-mm", "--mmproj-url", "--mmproj-auto", "--no-mmproj", "--no-mmproj-auto"],
  "--n-gpu-layers": ["--n-gpu-layers", "--gpu-layers", "-ngl"],
  "--ctx-size": ["--ctx-size", "-c"],
  "--batch-size": ["--batch-size", "-b"],
  "--ubatch-size": ["--ubatch-size", "-ub"],
  "--keep": ["--keep"],
  "--cache-type-k": ["--cache-type-k", "-ctk"],
  "--cache-type-v": ["--cache-type-v", "-ctv"],
  "--flash-attn": ["--flash-attn", "-fa"],
  "--n-cpu-moe": ["--n-cpu-moe", "-ncmoe"],
  "--threads": ["--threads", "-t"],
  "--parallel": ["--parallel", "-np"],
  "--timeout": ["--timeout", "-to"],
  "--sleep-idle-seconds": ["--sleep-idle-seconds"],
  "--lora": ["--lora", "--lora-scaled"],
  "--spec-type": ["--spec-type"],
  "--spec-draft-n-max": ["--spec-draft-n-max"],
  "--spec-draft-n-min": ["--spec-draft-n-min"],
  "--spec-draft-p-min": ["--spec-draft-p-min", "--draft-p-min"],
  "--spec-draft-p-split": ["--spec-draft-p-split", "--draft-p-split"],
  "--spec-draft-ngl": ["--spec-draft-ngl", "--gpu-layers-draft", "--n-gpu-layers-draft"],
  "--spec-draft-device": ["--spec-draft-device", "-devd", "--device-draft"],
  "--spec-draft-model": ["--spec-draft-model", "-md", "--model-draft"],
  "--reasoning": ["--reasoning", "-rea"],
  "--reasoning-format": ["--reasoning-format"],
  "--reasoning-effort": ["--reasoning-effort"],
  "--reasoning-budget": ["--reasoning-budget"],
  "--reasoning-budget-message": ["--reasoning-budget-message"],
  "--reasoning-preserve": ["--reasoning-preserve", "--no-reasoning-preserve"],
} as const;

/**
 * --cont-batching/--webui and their aliases are deliberately excluded from
 * APP_MANAGED_SERVER_OPTION_ALIASES: build_args (src-tauri/src/server.rs)
 * only supplies its own --cont-batching/--no-webui default when server_args
 * is silent on the option, so users must still be able to pass any spelling
 * of these flags through the raw escape hatch to override that default.
 */

/** Flattened alias set kept as a public contract for validation/smoke tests. */
export const APP_MANAGED_SERVER_ARGS = new Set(
  Object.values(APP_MANAGED_SERVER_OPTION_ALIASES).flat(),
);

const SERVER_OPTION_CANONICAL_BY_ALIAS = new Map<string, string>(
  Object.entries(APP_MANAGED_SERVER_OPTION_ALIASES).flatMap(([canonical, aliases]) => (
    aliases.map((alias) => [alias, canonical] as const)
  )),
);

/** Return the canonical option name for a raw argv token, if it is app-owned. */
export function canonicalServerOptionName(argument: string): string | null {
  const name = optionName(argument);
  return SERVER_OPTION_CANONICAL_BY_ALIAS.get(name) ?? null;
}

export function isKnownSelectValue(value: string, options: readonly string[]): boolean {
  return options.includes(value);
}

const RESERVED_CHAT_OPTIONS = new Set(["model", "messages", "stream"]);

/**
 * The UI keeps the llama-server names (`mirostat_lr` / `mirostat_ent`) so
 * saved profiles and the CLI escape hatch stay discoverable.  llama.cpp's
 * OpenAI-compatible request schema uses `mirostat_eta` / `mirostat_tau`.
 * Explicit request-schema keys win when both spellings are present; aliases
 * are always removed from the outgoing object so the server sees one key.
 */
export const CHAT_OPTION_REQUEST_ALIASES = {
  mirostat_lr: "mirostat_eta",
  mirostat_ent: "mirostat_tau",
} as const;

export function mapChatOptionAliases(options: JsonObject): JsonObject {
  const mapped: JsonObject = { ...options };
  for (const [alias, requestKey] of Object.entries(CHAT_OPTION_REQUEST_ALIASES)) {
    if (Object.prototype.hasOwnProperty.call(mapped, requestKey) === false
      && Object.prototype.hasOwnProperty.call(mapped, alias)) {
      mapped[requestKey] = mapped[alias];
    }
    delete mapped[alias];
  }
  return mapped;
}

function optionName(argument: string): string {
  return argument.trim().split("=", 1)[0].trim();
}

/** Parse one literal process argument per line; no shell syntax is evaluated. */
export function parseServerArgs(text: string): string[] {
  const args = text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const blocked = args
    .map((argument) => ({ argument, canonical: canonicalServerOptionName(argument) }))
    .find(({ canonical }) => canonical !== null);
  if (blocked?.canonical) {
    const supplied = optionName(blocked.argument);
    throw new Error(`app-managed llama-server argument cannot be overridden: ${supplied} (managed as ${blocked.canonical})`);
  }
  return args;
}

export function parseChatOptions(text: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`chat options must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("chat options must be a JSON object");
  }
  const reserved = Object.keys(parsed).find((key) => RESERVED_CHAT_OPTIONS.has(key));
  if (reserved) throw new Error(`chat option is reserved by the app: ${reserved}`);
  return parsed as JsonObject;
}
