import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChatHistoryMessage, ChatWorkspace } from "../chatHistory";

/**
 * Regression test for P1-7 (docs/review-codex-6.md #2): Chat.tsx used to pass
 * ChatMessageLog a brand-new `onCopy` closure on every render, which broke
 * MessageBubble's `memo()` bailout for every earlier bubble whenever a
 * streaming tick patched only the newest message. MessageBubble.perf.test.tsx
 * proves memo() itself works, but it hand-rolls a stable `onCopy` and never
 * renders through Chat.tsx, so it could not have caught that bug. This test
 * drives the real ChatPanel -> ChatMessageLog -> MessageBubble production
 * path with 220 seeded messages and asserts that streaming ticks only ever
 * re-render the newest bubble.
 */

const SEED_MESSAGE_COUNT = 220;
const NEW_ASSISTANT_INDEX = SEED_MESSAGE_COUNT + 1;

const { bubbleRenderSpy, seedWorkspace } = vi.hoisted(() => {
  const messages: ChatHistoryMessage[] = Array.from({ length: 220 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `seed message ${index}`,
  }));
  // The send() flow strips a trailing assistant bubble as "dangling" before appending a
  // new turn; force the seed to end on a user message so all 220 seeded bubbles survive.
  messages[messages.length - 1] = { role: "user", content: `seed message ${messages.length - 1}` };
  const workspace: ChatWorkspace = {
    activeThreadId: "thread-seed",
    threads: [{
      id: "thread-seed",
      title: "Seed thread",
      systemPrompt: "You are a helpful assistant.",
      createdAt: 0,
      updatedAt: 0,
      messages,
    }],
  };
  return { bubbleRenderSpy: vi.fn(), seedWorkspace: workspace };
});

vi.mock("./MessageBubble", async () => {
  const React = await import("react");
  interface StubProps { index: number; message: { content: string } }
  function MessageBubbleStub({ index, message }: StubProps) {
    bubbleRenderSpy(index);
    return React.createElement("div", { "data-testid": `bubble-${index}` }, message.content);
  }
  return { default: React.memo(MessageBubbleStub), MessageBubble: MessageBubbleStub };
});

vi.mock("../chatHistory", async () => {
  const actual = await vi.importActual<typeof import("../chatHistory")>("../chatHistory");
  return {
    ...actual,
    loadChatWorkspace: () => seedWorkspace,
    loadChatWorkspaceAsync: async () => seedWorkspace,
  };
});

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

import ChatPanel from "./Chat";
import { I18nProvider } from "../i18n";
import * as api from "../api";
import type { AppStore } from "../store";

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

const cfg = {
  config_version: 1,
  models_dir: "",
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

/** Streams `parts` as separate SSE-style deltas, pausing between them so each one lands as its own rAF-scheduled commit (mirrors real server chunking + useChatSend's throttled repaint). */
function respondWithThrottledDeltas(parts: string[]) {
  mocked.chatStream.mockImplementationOnce(async (_url: string, _key: string, _model: string, _messages: unknown, _sampling: unknown, onDelta: (delta: { content?: string }) => void) => {
    let full = "";
    for (const part of parts) {
      full += part;
      onDelta({ content: part });
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    return full;
  });
}

describe("ChatPanel streaming re-render isolation (P1-7)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocked.serverActivity.mockResolvedValue(undefined);
  });

  it("re-renders only the newest bubble across streaming ticks in a 220-message thread", async () => {
    renderPanel();

    await screen.findByTestId(`bubble-${SEED_MESSAGE_COUNT - 1}`);
    const seededIndexes = new Set(bubbleRenderSpy.mock.calls.map((call) => call[0] as number));
    expect(seededIndexes.size).toBe(SEED_MESSAGE_COUNT);

    respondWithThrottledDeltas(["Hello ", "there ", "friend."]);
    fireEvent.change(screen.getByLabelText("Chat message"), { target: { value: "Hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    // Wait for the first streaming tick to land, then start measuring: this
    // excludes the one-time idle->thinking->streaming phase transitions (which
    // legitimately touch every bubble's `phase` prop) and isolates the
    // per-rAF-tick re-renders the review flagged.
    await waitFor(() => expect(screen.getByTestId(`bubble-${NEW_ASSISTANT_INDEX}`)).toHaveTextContent("Hello"));
    bubbleRenderSpy.mockClear();

    await waitFor(() => expect(screen.getByTestId(`bubble-${NEW_ASSISTANT_INDEX}`)).toHaveTextContent("Hello there friend."));

    const callsDuringTicks = bubbleRenderSpy.mock.calls.map((call) => call[0] as number);
    const seedCallsDuringTicks = callsDuringTicks.filter((index) => index < SEED_MESSAGE_COUNT);
    expect(seedCallsDuringTicks).toEqual([]);

    const newBubbleCalls = callsDuringTicks.filter((index) => index === NEW_ASSISTANT_INDEX);
    expect(newBubbleCalls.length).toBeGreaterThanOrEqual(2);
  });
});
