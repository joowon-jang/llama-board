import { beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "./api";
import { createModelProfile, createServerProfile, defaultModelProfile, defaultServerProfile, loadProfiles, modelProfilePatch, profileDirtyFields, serverProfilePatch } from "./modelProfiles";

const cfg = {
  active_backend: "PATH", ctx_size: 4096, batch_size: 2048, ubatch_size: 512, keep: 0,
  cache_type_k: "f16", cache_type_v: "f16", ngl: 10, n_cpu_moe: 0, threads: 8, parallel: 1,
  request_timeout_seconds: 60, sleep_idle_seconds: -1, flash_attn: "auto", spec_type: "none", spec_draft_n_max: 16,
  spec_draft_n_min: 0, spec_draft_p_min: 0, spec_draft_p_split: 0, spec_draft_ngl: "auto", spec_draft_device: "",
  spec_draft_model: "", reasoning: "on", reasoning_format: "deepseek", reasoning_effort: "default", reasoning_budget: -1,
  reasoning_budget_message: "", reasoning_preserve: "", mmproj: "", server_args: [], chat_options: { max_tokens: 512 },
  temperature: 0.7, top_p: 0.9, top_k: 40, models_dir: "models", port: 8080, active_model: "", active_build: "",
  iters: 1, lora_adapters: [], config_version: 1,
} as AppConfig;

describe("model profiles", () => {
  beforeEach(() => localStorage.clear());

  it("creates and loads independent server and model profiles", () => {
    const server = createServerProfile(cfg, "Fast");
    const model = createModelProfile(cfg, "models/a.gguf", "Creative");
    localStorage.setItem("llama-board-model-profiles", JSON.stringify({ version: 2, server: [server], model: [model], activeServerId: server.id, activeModelIds: { "models/a.gguf": model.id } }));
    const loaded = loadProfiles(cfg, "models/a.gguf");
    expect(loaded.server[0].name).toBe("Fast");
    expect(loaded.model[0].name).toBe("Creative");
  });

  it("maps all supported fields and reports dirty values", () => {
    const server = defaultServerProfile(cfg);
    const model = defaultModelProfile(cfg, "models/a.gguf");
    expect(serverProfilePatch(server)).toHaveProperty("ctx_size", 4096);
    expect(modelProfilePatch({ ...model, stop_strings: ["<end>"] })).toMatchObject({ temperature: 0.7, chat_options: { stop: ["<end>"] } });
    expect(modelProfilePatch({ ...model, chat_options: { stop: ["stale"], max_tokens: 512 }, stop_strings: [] })).toMatchObject({ chat_options: { max_tokens: 512 } });
    expect(modelProfilePatch({ ...model, chat_options: { stop: ["stale"] }, stop_strings: [] }).chat_options).not.toHaveProperty("stop");
    expect(profileDirtyFields(server, cfg)).toEqual([]);
    expect(profileDirtyFields({ ...model, temperature: 1.1 }, cfg)).toContain("temperature");
  });
});
