import assert from "node:assert/strict";
import type { AppConfig } from "../src/api.ts";
import { normalizeDisplayPath } from "../src/lifecycleUtils.ts";
import { normalizeConfigPatch } from "../src/storeConfig.ts";

const extendedPath = "\\\\?\\C:\\Models\\" + "deep\\".repeat(70) + "a.gguf";
const extendedUncPath = "\\\\?\\UNC\\host\\share\\" + "deep\\".repeat(70) + "a.gguf";

const normalizedConfig = normalizeConfigPatch({ active_model: extendedPath, mmproj: extendedUncPath, models_dir: extendedPath }) as Partial<AppConfig>;
assert.equal(normalizedConfig.active_model, extendedPath);
assert.equal(normalizedConfig.mmproj, extendedUncPath);
assert.equal(normalizedConfig.models_dir, extendedPath);
assert.equal(normalizedConfig.lora_adapters, undefined);

const normalizedFunctionPatch = normalizeConfigPatch(() => ({ active_model: extendedPath }));
assert.equal(typeof normalizedFunctionPatch, "function");
assert.equal((normalizedFunctionPatch as (current: Record<string, unknown>) => Record<string, unknown>)({}).active_model, extendedPath);

assert.equal(normalizeDisplayPath("\\\\?\\C:\\Models\\a.gguf"), "C:\\Models\\a.gguf");
assert.equal(normalizeDisplayPath("\\\\?\\UNC\\host\\share\\a.gguf"), "\\\\host\\share\\a.gguf");
assert.equal(normalizeDisplayPath("C:\\Models\\a.gguf"), "C:\\Models\\a.gguf");
assert.equal(normalizeDisplayPath("  \\\\?\\C:\\Models\\a.gguf  "), "C:\\Models\\a.gguf");
console.log("model selection/path regression tests passed");
