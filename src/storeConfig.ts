import type { AppConfig } from "./api.ts";
import type { ConfigPatch } from "./configSaveQueue.ts";

function normalizeStoredPath(value: string): string {
  return value.trim();
}

const DEFAULT_BATCH_SIZE = 2048;
const DEFAULT_UBATCH_SIZE = 512;
const DEFAULT_CACHE_TYPE = "f16";
const CACHE_TYPES = new Set(["f16", "f32", "bf16", "q8_0", "q5_0", "q5_1", "q4_0", "q4_1"]);

function finiteInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function normalizeTypedTuning(config: AppConfig): Pick<AppConfig, "batch_size" | "ubatch_size" | "keep" | "cache_type_k" | "cache_type_v"> {
  const batch_size = finiteInteger(config.batch_size, DEFAULT_BATCH_SIZE, 1, 131072);
  const ubatch_size = finiteInteger(config.ubatch_size, DEFAULT_UBATCH_SIZE, 1, batch_size);
  const keep = finiteInteger(config.keep, 0, 0, 131072);
  const cache_type_k = typeof config.cache_type_k === "string" && CACHE_TYPES.has(config.cache_type_k) ? config.cache_type_k : DEFAULT_CACHE_TYPE;
  const cache_type_v = typeof config.cache_type_v === "string" && CACHE_TYPES.has(config.cache_type_v) ? config.cache_type_v : DEFAULT_CACHE_TYPE;
  return { batch_size, ubatch_size, keep, cache_type_k, cache_type_v };
}

export function normalizeAppConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    ...normalizeTypedTuning(config),
    models_dir: normalizeStoredPath(config.models_dir),
    active_model: normalizeStoredPath(config.active_model),
    mmproj: normalizeStoredPath(config.mmproj),
    lora_adapters: config.lora_adapters.map((adapter) => ({ ...adapter, path: normalizeStoredPath(adapter.path) })),
  };
}

export function normalizeConfigPatch(patch: ConfigPatch<AppConfig>): ConfigPatch<AppConfig> {
  if (typeof patch === "function") {
    return (current) => normalizeConfigPatch(patch(current)) as Partial<AppConfig>;
  }
  const next = { ...patch };
  if (typeof next.models_dir === "string") next.models_dir = normalizeStoredPath(next.models_dir);
  if (typeof next.active_model === "string") next.active_model = normalizeStoredPath(next.active_model);
  if (typeof next.mmproj === "string") next.mmproj = normalizeStoredPath(next.mmproj);
  if (next.lora_adapters) next.lora_adapters = next.lora_adapters.map((adapter) => ({ ...adapter, path: normalizeStoredPath(adapter.path) }));
  if ("batch_size" in next) next.batch_size = finiteInteger(next.batch_size, DEFAULT_BATCH_SIZE, 1, 131072);
  if ("ubatch_size" in next) next.ubatch_size = finiteInteger(next.ubatch_size, DEFAULT_UBATCH_SIZE, 1, next.batch_size ?? 131072);
  if ("keep" in next) next.keep = finiteInteger(next.keep, 0, 0, 131072);
  if (typeof next.cache_type_k === "string" && !CACHE_TYPES.has(next.cache_type_k)) next.cache_type_k = DEFAULT_CACHE_TYPE;
  if (typeof next.cache_type_v === "string" && !CACHE_TYPES.has(next.cache_type_v)) next.cache_type_v = DEFAULT_CACHE_TYPE;
  return next;
}
