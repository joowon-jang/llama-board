import type { AppConfig } from "./api.ts";
import type { ConfigPatch } from "./configSaveQueue.ts";

function normalizeStoredPath(value: string): string {
  return value.trim();
}

export function normalizeAppConfig(config: AppConfig): AppConfig {
  return {
    ...config,
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
  return next;
}
