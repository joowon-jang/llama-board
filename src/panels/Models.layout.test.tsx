import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import type { AppConfig } from "../api";
import type { AppStore } from "../store";
import { I18nProvider } from "../i18n";
import "../App.css";
import ModelsPanel from "./Models";

const cfg = {
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
  active_model: "C:/models/example.gguf",
  active_backend: "PATH",
  active_build: "",
  iters: 1,
  parallel: 1,
  request_timeout_seconds: 60,
  sleep_idle_seconds: -1,
  lora_adapters: [],
} satisfies AppConfig;

const store = {
  cfg,
  status: { state: "stopped" },
  busy: false,
  updateConfig: async () => cfg,
  start: async () => "",
  stop: async () => undefined,
} as unknown as AppStore;

describe("ModelsPanel layout", () => {
  it("keeps the execution profile inside a vertical scroll owner", async () => {
    render(createElement(I18nProvider, {
      initialLocale: "en",
      children: createElement(ModelsPanel, { store }),
    }));

    const scrollRegion = screen.getByTestId("models-scroll-region");
    expect(scrollRegion).toHaveClass("models-panel");
    expect(scrollRegion).toContainElement(await screen.findByRole("heading", { name: "Execution profiles" }));
    expect(screen.getByTestId("execution-profiles-section")).toHaveClass("border-t", "rounded-none");
    expect(screen.getByTestId("models-list")).toHaveClass("models-model-list");
    expect(screen.getByTestId("execution-profiles-grid")).toHaveClass("items-start", "xl:grid-cols-2");
    expect(screen.getByTestId("models-header-actions")).toHaveClass("min-w-0", "w-full", "flex-wrap");
    expect(screen.getByTestId("server-profile-picker")).toHaveClass("grid", "sm:grid-cols-[minmax(12rem,1fr)_auto]");
    const systemPrompt = screen.getByTestId("model-system-prompt-field");
    expect(systemPrompt).toHaveClass("sm:col-span-2");
    expect(systemPrompt.querySelector("textarea")).toBeInTheDocument();
  });
});
