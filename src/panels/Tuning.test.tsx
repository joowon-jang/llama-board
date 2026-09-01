import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../i18n";
import type { AppConfig } from "../api";
import type { AppStore } from "../store";
import TuningPanel from "./Tuning";

const cfg: AppConfig = {
  config_version: 7,
  models_dir: "models",
  port: 8080,
  ngl: 0,
  ctx_size: 4096,
  batch_size: 2048,
  ubatch_size: 512,
  keep: 0,
  cache_type_k: "f16",
  cache_type_v: "f16",
  flash_attn: "auto",
  n_cpu_moe: 0,
  threads: 0,
  temperature: 0.8,
  top_p: 0.95,
  top_k: 40,
  spec_type: "none",
  spec_draft_n_max: 3,
  spec_draft_n_min: 0,
  spec_draft_p_min: 0,
  spec_draft_p_split: 0.1,
  spec_draft_ngl: "auto",
  spec_draft_device: "",
  spec_draft_model: "",
  reasoning: "auto",
  reasoning_format: "auto",
  reasoning_effort: "default",
  reasoning_budget: -1,
  reasoning_budget_message: "",
  reasoning_preserve: "auto",
  server_args: [],
  chat_options: {},
  mmproj: "",
  active_model: "model.gguf",
  active_backend: "cpu",
  active_build: "latest",
  iters: 5,
  parallel: 0,
  request_timeout_seconds: 3600,
  sleep_idle_seconds: -1,
  lora_adapters: [],
};

function store(): AppStore {
  return {
    cfg,
    status: { state: "stopped" },
    busy: false,
    bootError: null,
    bootState: "ready",
    actionError: null,
    statusPollError: null,
    getConfig: () => cfg,
    getConfigRevision: () => 1,
    loadConfig: vi.fn(async () => undefined),
    refreshStatus: vi.fn(async () => undefined),
    updateConfig: vi.fn(async () => cfg),
    start: vi.fn(async () => "http://127.0.0.1:8080/v1"),
    stop: vi.fn(async () => undefined),
    clearActionError: vi.fn(),
    clearErrors: vi.fn(),
  };
}

describe("TuningPanel phase-1 shell", () => {
  it("starts in Quick mode and navigates to advanced speculative controls", () => {
    render(
      <I18nProvider initialLocale="en">
        <TuningPanel store={store()} />
      </I18nProvider>,
    );

    expect(screen.getByRole("tab", { name: "Quick" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("button", { name: "Speculative" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));
    fireEvent.click(screen.getByRole("button", { name: "Speculative" }));
    expect(screen.getByRole("heading", { name: "Speculative" })).toBeInTheDocument();
    expect(screen.getByLabelText("Speculative type(s)")).toBeInTheDocument();
    expect(screen.getAllByRole("tooltip").length).toBeGreaterThan(0);
  });
});
