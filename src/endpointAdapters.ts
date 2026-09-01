import type { ChatContentPart, ChatMessage, ChatSampling } from "./api";
import { MAX_SSE_FRAME_CHARS, MAX_STREAM_RESULT_CHARS, type StreamUsage } from "./sse.ts";
import { mapChatOptionAliases } from "./panels/tuningValidation.ts";

export interface NativeInputMessage {
  type: "message";
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[];
  tool_call_id?: string;
  name?: string;
  tool_calls?: ChatMessage["tool_calls"];
}

export interface NativeChatRequestBody {
  model: string;
  input: string | NativeInputMessage[];
  system_prompt?: string;
  stream: boolean;
  store?: boolean;
  previous_response_id?: string;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  max_output_tokens?: number;
  reasoning?: "off" | "low" | "medium" | "high" | "on";
  context_length?: number;
  integrations?: unknown[];
  [key: string]: unknown;
}

export interface NativeStreamDelta {
  text?: string;
  reasoning?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  responseId?: string;
  lifecycle?: "loading" | "prompt_processing" | "completed";
  progress?: number;
  usage?: StreamUsage;
}

export class NativeChatSseParser {
  private buffer = "";
  private result = "";
  private finished = false;
  private readonly onDelta: (delta: NativeStreamDelta) => void;

  constructor(onDelta: (delta: NativeStreamDelta) => void) {
    this.onDelta = onDelta;
  }

  push(chunk: string): boolean {
    if (this.finished) return true;
    if (this.buffer.length + chunk.length > MAX_SSE_FRAME_CHARS) {
      throw new Error("SSE frame exceeds the configured size limit.");
    }
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (this.consumeLine(line.replace(/\r$/, ""))) return true;
    }
    return false;
  }

  finish(): void {
    if (!this.finished && this.buffer.trim()) this.consumeLine(this.buffer);
    this.buffer = "";
  }

  isFinished(): boolean {
    return this.finished;
  }

  value(): string {
    return this.result;
  }

  private consumeLine(line: string): boolean {
    const value = line.trim();
    if (!value || value.startsWith("event:")) return false;
    if (!value.startsWith("data:")) return false;
    let json: unknown;
    try {
      json = JSON.parse(value.slice(5).trim());
    } catch {
      throw new Error("The native LM Studio endpoint returned invalid SSE JSON.");
    }
    if (!json || typeof json !== "object") return false;
    const event = json as Record<string, unknown>;
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "error") {
      const error = event.error && typeof event.error === "object" ? event.error as Record<string, unknown> : {};
      throw new Error(`Native endpoint error: ${String(error.message ?? "unknown error").slice(0, 500)}`);
    }
    if (type === "reasoning.delta" && typeof event.content === "string") {
      this.onDelta({ reasoning: event.content });
    } else if (type === "message.delta" && typeof event.content === "string") {
      if (this.result.length + event.content.length > MAX_STREAM_RESULT_CHARS) {
        throw new Error("The streamed response exceeds the configured size limit.");
      }
      this.result += event.content;
      this.onDelta({ text: event.content });
    } else if (type === "tool_call.start" && typeof event.tool === "string") {
      this.onDelta({ tool: event.tool });
    } else if (type === "tool_call.arguments" && event.arguments && typeof event.arguments === "object") {
      this.onDelta({ tool: typeof event.tool === "string" ? event.tool : undefined, arguments: event.arguments as Record<string, unknown> });
    } else if (type === "model_load.progress" || type === "prompt_processing.progress") {
      this.onDelta({
        lifecycle: type.startsWith("model_load") ? "loading" : "prompt_processing",
        progress: typeof event.progress === "number" ? event.progress : undefined,
      });
    } else if (type === "chat.start") {
      this.onDelta({ responseId: typeof event.response_id === "string" ? event.response_id : undefined });
    } else if (type === "chat.end") {
      const result = event.result && typeof event.result === "object" ? event.result as Record<string, unknown> : {};
      const stats = result.stats && typeof result.stats === "object" ? result.stats as Record<string, unknown> : {};
      this.onDelta({
        lifecycle: "completed",
        responseId: typeof result.response_id === "string" ? result.response_id : undefined,
        usage: {
          prompt_tokens: typeof stats.input_tokens === "number" ? stats.input_tokens : undefined,
          completion_tokens: typeof stats.total_output_tokens === "number" ? stats.total_output_tokens : undefined,
        },
      });
      this.finished = true;
      return true;
    }
    return false;
  }
}

export async function consumeNativeChatStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: NativeStreamDelta) => void,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new NativeChatSseParser(onDelta);
  try {
    while (!parser.isFinished()) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    if (!parser.isFinished()) {
      parser.push(decoder.decode());
      parser.finish();
      if (!parser.isFinished()) throw new Error("The native endpoint ended before chat.end.");
    }
    return parser.value();
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed by the transport.
    }
  }
}

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

export interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

export type AnthropicContentBlock = AnthropicTextBlock | AnthropicImageBlock | AnthropicThinkingBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicMessagesRequestBody {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  stream: boolean;
  system?: string;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  tools?: AnthropicTool[];
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  [key: string]: number;
}

export interface AnthropicMessagesResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

function rootUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function nativeChatUrl(baseUrl: string): string {
  return `${rootUrl(baseUrl)}/api/v1/chat`;
}

export function anthropicMessagesUrl(baseUrl: string): string {
  return `${rootUrl(baseUrl)}/v1/messages`;
}

function dataUrlParts(value: string): { mediaType: string; data: string } | null {
  const match = value.match(/^data:([^;,]+);base64,(.+)$/);
  return match ? { mediaType: match[1], data: match[2] } : null;
}

function toAnthropicContent(content: string | ChatContentPart[]): string | AnthropicContentBlock[] {
  if (typeof content === "string") return content;
  const blocks: AnthropicContentBlock[] = [];
  for (const part of content) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    const parsed = dataUrlParts(part.image_url.url);
    if (parsed) {
      blocks.push({ type: "image", source: { type: "base64", media_type: parsed.mediaType, data: parsed.data } });
    } else {
      blocks.push({ type: "text", text: `[image: ${part.image_url.url}]` });
    }
  }
  return blocks;
}

function toAnthropicMessage(message: ChatMessage): AnthropicMessage {
  if (message.role === "tool") {
    return {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: message.tool_call_id ?? "tool-call",
        content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      }],
    };
  }
  if (message.role === "assistant" && message.tool_calls?.length) {
    const blocks: AnthropicContentBlock[] = [];
    const text = toAnthropicContent(message.content);
    if (typeof text === "string" && text) blocks.push({ type: "text", text });
    for (const call of message.tool_calls) {
      let input: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(call.function.arguments);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
      } catch {
        input = { raw_arguments: call.function.arguments };
      }
      blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input });
    }
    return { role: "assistant", content: blocks };
  }
  return { role: message.role === "system" ? "user" : message.role, content: toAnthropicContent(message.content) };
}

export function buildNativeChatRequestBody(
  model: string,
  messages: ChatMessage[],
  sampling: ChatSampling,
  previousResponseId?: string,
): NativeChatRequestBody {
  const system = messages.find((message) => message.role === "system");
  const input = messages
    .filter((message) => message.role !== "system")
    .map((message): NativeInputMessage => ({ type: "message", role: message.role, content: message.content, tool_call_id: message.tool_call_id, name: message.name, tool_calls: message.tool_calls }));
  const options = mapChatOptionAliases(sampling.options ?? {});
  const body: NativeChatRequestBody = {
    ...options,
    model,
    input,
    stream: true,
    store: true,
    temperature: sampling.temperature,
    top_p: sampling.top_p,
    top_k: sampling.top_k,
    system_prompt: system && typeof system.content === "string" ? system.content : undefined,
    previous_response_id: previousResponseId,
  };
  const reasoning = sampling.reasoning === "off" ? "off" : sampling.reasoning_effort;
  if (reasoning && reasoning !== "default") body.reasoning = reasoning as NativeChatRequestBody["reasoning"];
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)) as NativeChatRequestBody;
}

export function buildAnthropicMessagesRequestBody(
  model: string,
  messages: ChatMessage[],
  sampling: ChatSampling,
  tools: AnthropicTool[] = [],
): AnthropicMessagesRequestBody {
  const system = messages.find((message) => message.role === "system");
  const converted = messages
    .filter((message) => message.role !== "system")
    .map(toAnthropicMessage);
  const options = sampling.options ?? {};
  const requestedMaxTokens = typeof options.max_tokens === "number" && Number.isFinite(options.max_tokens)
    ? Math.max(1, Math.floor(options.max_tokens))
    : 1024;
  const body: AnthropicMessagesRequestBody = {
    model,
    messages: converted,
    max_tokens: requestedMaxTokens,
    stream: true,
    system: system && typeof system.content === "string" ? system.content : undefined,
    temperature: sampling.temperature,
    top_p: sampling.top_p,
    top_k: sampling.top_k,
    tools: tools.length ? tools : undefined,
  };
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined)) as AnthropicMessagesRequestBody;
}

function textFromOpenAiMessage(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { text: string } => !!part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("");
}

function reasoningFromOpenAiMessage(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const value = (message as { reasoning_content?: unknown }).reasoning_content;
  return typeof value === "string" ? value : "";
}

function stopReason(value: unknown): AnthropicMessagesResponse["stop_reason"] {
  if (value === "tool_calls" || value === "function_call") return "tool_use";
  if (value === "length") return "max_tokens";
  if (value === "stop") return "end_turn";
  if (value === "content_filter") return "stop_sequence";
  return null;
}

export function translateOpenAiResponseToAnthropic(value: unknown): AnthropicMessagesResponse {
  const response = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const choice = Array.isArray(response.choices) && response.choices[0] && typeof response.choices[0] === "object"
    ? response.choices[0] as Record<string, unknown>
    : {};
  const message = choice.message;
  const content: AnthropicContentBlock[] = [];
  const reasoning = reasoningFromOpenAiMessage(message);
  const text = textFromOpenAiMessage(message);
  if (reasoning) content.push({ type: "thinking", thinking: reasoning });
  if (text) content.push({ type: "text", text });
  const toolCalls = message && typeof message === "object" && Array.isArray((message as { tool_calls?: unknown }).tool_calls)
    ? (message as { tool_calls: unknown[] }).tool_calls
    : [];
  for (const call of toolCalls) {
    if (!call || typeof call !== "object") continue;
    const functionValue = (call as { function?: unknown }).function;
    if (!functionValue || typeof functionValue !== "object") continue;
    const fn = functionValue as { name?: unknown; arguments?: unknown };
    let input: Record<string, unknown> = {};
    if (typeof fn.arguments === "string") {
      try {
        const parsed = JSON.parse(fn.arguments) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
      } catch {
        input = { raw_arguments: fn.arguments };
      }
    }
    const id = call && typeof call === "object" && typeof (call as { id?: unknown }).id === "string"
      ? (call as { id: string }).id
      : `tool-call-${content.length}`;
    content.push({ type: "tool_use", id, name: typeof fn.name === "string" ? fn.name : "unknown", input });
  }
  const usageValue = response.usage && typeof response.usage === "object" ? response.usage as Record<string, unknown> : {};
  return {
    id: typeof response.id === "string" ? response.id : "msg_local",
    type: "message",
    role: "assistant",
    model: typeof response.model === "string" ? response.model : "local-model",
    content,
    stop_reason: stopReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: typeof usageValue.prompt_tokens === "number" ? usageValue.prompt_tokens : 0,
      output_tokens: typeof usageValue.completion_tokens === "number" ? usageValue.completion_tokens : 0,
    },
  };
}

export interface AnthropicStreamDelta {
  text?: string;
  thinking?: string;
  finishReason?: AnthropicMessagesResponse["stop_reason"];
  usage?: AnthropicUsage;
}

export class AnthropicSseParser {
  private buffer = "";
  private result = "";
  private finished = false;
  private readonly onDelta: (delta: AnthropicStreamDelta) => void;

  constructor(onDelta: (delta: AnthropicStreamDelta) => void) {
    this.onDelta = onDelta;
  }

  push(chunk: string): boolean {
    if (this.finished) return true;
    if (this.buffer.length + chunk.length > MAX_SSE_FRAME_CHARS) {
      throw new Error("SSE frame exceeds the configured size limit.");
    }
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (this.consumeLine(line.replace(/\r$/, ""))) return true;
    }
    return false;
  }

  finish(): void {
    if (!this.finished && this.buffer.trim()) this.consumeLine(this.buffer);
    this.buffer = "";
  }

  isFinished(): boolean {
    return this.finished;
  }

  value(): string {
    return this.result;
  }

  private consumeLine(line: string): boolean {
    const value = line.trim();
    if (!value || value.startsWith("event:")) return false;
    if (!value.startsWith("data:")) return false;
    const payload = value.slice(5).trim();
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      throw new Error("The Anthropic server returned invalid SSE JSON.");
    }
    if (!json || typeof json !== "object") return false;
    const event = json as Record<string, unknown>;
    if (event.type === "error") {
      const error = event.error && typeof event.error === "object" ? JSON.stringify(event.error) : String(event.error ?? "unknown error");
      throw new Error(`Anthropic-compatible endpoint error: ${error.slice(0, 500)}`);
    }
    if (event.type === "message_start") {
      const message = event.message && typeof event.message === "object" ? event.message as Record<string, unknown> : {};
      const usage = message.usage && typeof message.usage === "object" ? message.usage as Record<string, unknown> : {};
      this.onDelta({ usage: { input_tokens: Number(usage.input_tokens ?? 0), output_tokens: 0 } });
    } else if (event.type === "content_block_delta") {
      const delta = event.delta && typeof event.delta === "object" ? event.delta as Record<string, unknown> : {};
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        if (this.result.length + delta.text.length > MAX_STREAM_RESULT_CHARS) {
          throw new Error("The streamed response exceeds the configured size limit.");
        }
        this.result += delta.text;
        this.onDelta({ text: delta.text });
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        this.onDelta({ thinking: delta.thinking });
      }
    } else if (event.type === "message_delta") {
      const delta = event.delta && typeof event.delta === "object" ? event.delta as Record<string, unknown> : {};
      const usage = event.usage && typeof event.usage === "object" ? event.usage as Record<string, unknown> : undefined;
      this.onDelta({
        finishReason: delta.stop_reason as AnthropicMessagesResponse["stop_reason"] | undefined,
        usage: usage ? { input_tokens: Number(usage.input_tokens ?? 0), output_tokens: Number(usage.output_tokens ?? 0) } : undefined,
      });
    } else if (event.type === "message_stop") {
      this.finished = true;
      return true;
    }
    return false;
  }
}

export async function consumeAnthropicStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: AnthropicStreamDelta) => void,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new AnthropicSseParser(onDelta);
  try {
    while (!parser.isFinished()) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    if (!parser.isFinished()) {
      parser.push(decoder.decode());
      parser.finish();
      if (!parser.isFinished()) throw new Error("The Anthropic server ended the response before message_stop.");
    }
    return parser.value();
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed by the transport.
    }
  }
}

export function streamDeltaFromUsage(usage: StreamUsage | undefined): AnthropicStreamDelta {
  return usage ? { usage: { input_tokens: Number(usage.prompt_tokens ?? 0), output_tokens: Number(usage.completion_tokens ?? 0) } } : {};
}
