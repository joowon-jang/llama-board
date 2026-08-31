import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import type { AppConfig } from "../api";
import type { AppStore } from "../store";
import { I18nProvider } from "../i18n";
import "../App.css";
import ModelsPanel from "./Models";
import * as api from "../api";

// P0-1 follow-up (docs/review-codex-10.md P1 items): two Models.tsx cascade
// regressions where a Tailwind utility silently loses to (or never generates
// a rule to compete with) a hand-written `app-*` class on the same element.

vi.mock("../api", () => ({
  listModels: vi.fn(),
  deleteModel: vi.fn(),
  pickModelsDir: vi.fn(),
  pickLoraAdapter: vi.fn(),
  listServerLoraAdapters: vi.fn(),
  setServerLoraAdapters: vi.fn(),
  unloadModel: vi.fn(),
}));

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

const baseCfg = {
  config_version: 1,
  models_dir: "",
  port: 8080,
  ngl: 0,
  ctx_size: 4096,
  flash_attn: "auto",
  n_cpu_moe: 0,
  threads: 8,
  temperature: 0.7,
  top_p: 0.9,
  top_k: 40,
  spec_type: "none",
  spec_draft_n_max: 16,
  spec_draft_n_min: 0,
  spec_draft_p_min: 0,
  spec_draft_p_split: 0,
  spec_draft_ngl: "auto",
  spec_draft_device: "",
  spec_draft_model: "",
  reasoning: "on",
  reasoning_format: "deepseek",
  reasoning_effort: "default",
  reasoning_budget: -1,
  reasoning_budget_message: "",
  reasoning_preserve: "",
  server_args: [],
  chat_options: { max_tokens: 512 },
  mmproj: "",
  active_model: "",
  active_backend: "PATH",
  active_build: "",
  iters: 1,
  parallel: 1,
  request_timeout_seconds: 60,
  sleep_idle_seconds: -1,
  lora_adapters: [],
} satisfies AppConfig;

function storeFor(cfg: AppConfig): AppStore {
  return {
    cfg,
    status: { state: "stopped" },
    busy: false,
    updateConfig: async () => cfg,
    start: async () => "",
    stop: async () => undefined,
  } as unknown as AppStore;
}

describe("ModelsPanel CSS cascade", () => {
  it("gives the scan-error retry button only the app-* danger class, not a conflicting Tailwind bg-red-900 utility", async () => {
    mocked.listModels.mockRejectedValue(new Error("scan failed"));
    const cfg = { ...baseCfg, models_dir: "C:/models" };
    render(createElement(I18nProvider, {
      initialLocale: "en",
      children: createElement(ModelsPanel, { store: storeFor(cfg) }),
    }));

    const retryButton = await screen.findByRole("button", { name: "Retry" });
    expect(retryButton).toHaveClass("app-button");
    expect(retryButton.className).not.toMatch(/(^|\s)bg-red-900(\s|$)/);
  });

  it("gives the LoRA add button an explicit hover class instead of the unsupported hover:app-bg-accent-solid variant", async () => {
    render(createElement(I18nProvider, {
      initialLocale: "en",
      children: createElement(ModelsPanel, { store: storeFor(baseCfg), focus: "lora" }),
    }));

    const addButton = await screen.findByRole("button", { name: "Add GGUF" });
    expect(addButton).toHaveClass("app-button--primary");
    expect(addButton.className).not.toMatch(/hover:app-bg-accent-solid/);
  });

  it("gives the model row start/switch button the same explicit hover class", async () => {
    mocked.listModels.mockResolvedValue({
      models: [{ path: "C:/models/a.gguf", name: "a.gguf", size_mb: 128, is_vision: false }],
      truncated: false,
    });
    const cfg = { ...baseCfg, models_dir: "C:/models" };
    render(createElement(I18nProvider, {
      initialLocale: "en",
      children: createElement(ModelsPanel, { store: storeFor(cfg) }),
    }));

    const startButton = await screen.findByRole("button", { name: "Start" });
    expect(startButton).toHaveClass("app-button--primary");
    expect(startButton.className).not.toMatch(/hover:app-bg-accent-solid/);
  });
});
