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

export const MIROSTAT_OPTIONS = [
  { value: 0, label: "Off" },
  { value: 1, label: "Mirostat" },
  { value: 2, label: "Mirostat 2.0" },
] as const;

export function isKnownSelectValue(value: string, options: readonly string[]): boolean {
  return options.includes(value);
}

const APP_MANAGED_SERVER_ARGS = new Set([
  "--model",
  "-m",
  "--host",
  "--port",
  "-p",
  "--api-key",
  "--api-key-file",
  "--no-api-key",
  "-mm",
  "--mmproj",
  "--mmproj-url",
  "--mmproj-auto",
  "--no-mmproj",
  "--no-mmproj-auto",
  "--n-gpu-layers",
  "-ngl",
  "--ctx-size",
  "-c",
  "--flash-attn",
  "--n-cpu-moe",
  "-ncmoe",
  "--threads",
  "-t",
  "--spec-type",
  "--spec-draft-n-max",
  "--spec-draft-n-min",
  "--spec-draft-p-min",
  "--spec-draft-p-split",
  "--spec-draft-ngl",
  "--spec-draft-device",
  "--spec-draft-model",
  "--reasoning",
  "--reasoning-format",
  "--reasoning-effort",
  "--reasoning-budget",
  "--reasoning-budget-message",
  "--reasoning-preserve",
  "--no-reasoning-preserve",
]);

const RESERVED_CHAT_OPTIONS = new Set(["model", "messages", "stream"]);

function optionName(argument: string): string {
  return argument.split("=", 1)[0];
}

/** Parse one literal process argument per line; no shell syntax is evaluated. */
export function parseServerArgs(text: string): string[] {
  const args = text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const blocked = args.find((argument) => APP_MANAGED_SERVER_ARGS.has(optionName(argument)));
  if (blocked) {
    throw new Error(`app-managed llama-server argument cannot be overridden: ${optionName(blocked)}`);
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
