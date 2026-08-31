import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import ChatPanel from "./Chat";
import { I18nProvider } from "../i18n";
import * as api from "../api";
import type { AppStore } from "../store";

vi.mock("../api", () => ({
  pickDocument: vi.fn(),
  readDocumentText: vi.fn(),
  readDocumentBinding: vi.fn(),
  pickImage: vi.fn(),
  readImageData: vi.fn(),
  embedText: vi.fn(),
  chatStream: vi.fn(),
  serverActivity: vi.fn(async () => undefined),
  mcpListServers: vi.fn(),
  mcpListTools: vi.fn(),
  mcpCallTool: vi.fn(),
}));

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

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
} satisfies api.AppConfig;

const store = {
  cfg,
  status: { state: "running", url: "http://127.0.0.1:8080", api_key: "test-key", model: cfg.active_model },
  busy: false,
  updateConfig: async () => cfg,
  start: async () => "",
  stop: async () => undefined,
  refreshStatus: async () => undefined,
} as unknown as AppStore;

function renderPanel() {
  return render(createElement(I18nProvider, { initialLocale: "en", children: createElement(ChatPanel, { store }) }));
}

/** 200KB of attached text: ~112 chunks at the 1800-char chunk size, well past the 64-chunk search limit. */
const OVERSIZED_DOCUMENT = "x".repeat(200_000);
/** A few chunks, safely under the 64-chunk search limit. */
const SMALL_DOCUMENT = "y".repeat(3_000);

async function attachDocument(name: string, text: string) {
  mocked.pickDocument.mockResolvedValue(`C:/docs/${name}`);
  mocked.readDocumentText.mockResolvedValue(text);
  fireEvent.click(await screen.findByRole("button", { name: "Attach document" }));
  await screen.findByText(name);
}

function respondWithText(text: string) {
  mocked.chatStream.mockImplementationOnce(async (_url: string, _key: string, _model: string, _messages: unknown, _sampling: unknown, onDelta: (delta: { content?: string }) => void) => {
    onDelta({ content: text });
    return text;
  });
}

/** Streams `parts` as separate deltas, mirroring how a real server splits one response across several SSE chunks. */
function respondWithDeltas(parts: string[]) {
  const full = parts.join("");
  mocked.chatStream.mockImplementationOnce(async (_url: string, _key: string, _model: string, _messages: unknown, _sampling: unknown, onDelta: (delta: { content?: string }) => void) => {
    for (const part of parts) onDelta({ content: part });
    return full;
  });
}

async function sendMessage(text: string) {
  fireEvent.change(screen.getByLabelText("Chat message"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
}

async function findTruncationWarning() {
  const warning = await screen.findByRole("status", { name: "Context warning" });
  expect(warning.textContent ?? "").toMatch(/first 64 document chunks/i);
  return warning;
}

describe("ChatPanel document context warning", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocked.serverActivity.mockResolvedValue(undefined);
    // Every request embeds one vector per input string; the content does not matter for ranking here.
    mocked.embedText.mockImplementation(async (_url: string, _key: string, _model: string, input: string[]) => input.map(() => [1]));
  });

  it("warns in the DOM when an attached document exceeds the 64-chunk search limit", async () => {
    renderPanel();
    await attachDocument("big.txt", OVERSIZED_DOCUMENT);
    respondWithText("Here is what I found.");
    await sendMessage("Summarize the attached document.");

    await screen.findByText("Here is what I found.");
    await findTruncationWarning();
  });

  it("assembles a response streamed across multiple deltas and still shows the truncation warning", async () => {
    renderPanel();
    await attachDocument("big.txt", OVERSIZED_DOCUMENT);
    respondWithDeltas(["Here ", "is what ", "I found, ", "in full."]);
    await sendMessage("Summarize the attached document.");

    await screen.findByText("Here is what I found, in full.");
    await findTruncationWarning();
    expect(mocked.chatStream).toHaveBeenCalledTimes(1);
  });

  it("shows no truncation warning when the document stays within the 64-chunk search limit", async () => {
    renderPanel();
    await attachDocument("small.txt", SMALL_DOCUMENT);
    respondWithText("Sure, here is a summary.");
    await sendMessage("Summarize the attached document.");

    await screen.findByText("Sure, here is a summary.");
    expect(screen.queryByText(/first 64 document chunks/i)).not.toBeInTheDocument();
  });

  it("keeps the truncation warning visible through an approved MCP tool follow-up", async () => {
    mocked.mcpListServers.mockResolvedValue([{ id: "srv1", name: "Test Server", command: "node", args: [], enabled: true }]);
    mocked.mcpListTools.mockResolvedValue([{ name: "test_tool", description: "A test tool.", input_schema: { type: "object", properties: {} } }]);
    mocked.mcpCallTool.mockResolvedValue({ ok: true });

    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Load MCP tools" }));
    await screen.findByText(/Test Server/);

    await attachDocument("big.txt", OVERSIZED_DOCUMENT);

    mocked.chatStream.mockImplementationOnce(async (_url: string, _key: string, _model: string, _messages: unknown, _sampling: unknown, onDelta: (delta: { tool_calls?: Array<{ index: number; id?: string; name?: string; arguments?: string }> }) => void) => {
      onDelta({ tool_calls: [{ index: 0, id: "call-1", name: "srv1__test_tool", arguments: "{}" }] });
      return "";
    });
    await sendMessage("Use the tool on the attached document.");
    await findTruncationWarning();

    respondWithText("Final answer after the tool call.");
    fireEvent.click(await screen.findByRole("button", { name: "Approve once" }));

    await screen.findByText("Final answer after the tool call.");
    await waitFor(() => expect(mocked.mcpCallTool).toHaveBeenCalledTimes(1));
    await findTruncationWarning();
  });
});
