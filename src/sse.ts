export interface StreamDelta {
  content?: string;
  reasoning?: string;
  tool_calls?: ToolCallDelta[];
  finish_reason?: string | null;
  usage?: StreamUsage;
  id?: string;
  model?: string;
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

export interface StreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  [key: string]: unknown;
}

export type NormalizedStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_delta"; toolCall: ToolCallDelta }
  | { type: "completed"; finishReason?: string | null; usage?: StreamUsage };

export const MAX_SSE_FRAME_CHARS = 4 * 1024 * 1024;
export const MAX_STREAM_RESULT_CHARS = 16 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? value as JsonRecord : {};
}

export function normalizeStreamDelta(delta: StreamDelta): NormalizedStreamEvent[] {
  const events: NormalizedStreamEvent[] = [];
  if (delta.reasoning) events.push({ type: "reasoning_delta", text: delta.reasoning });
  if (delta.content) events.push({ type: "text_delta", text: delta.content });
  for (const toolCall of delta.tool_calls ?? []) {
    events.push({ type: "tool_call_delta", toolCall });
  }
  if (delta.finish_reason !== undefined || delta.usage) {
    events.push({ type: "completed", finishReason: delta.finish_reason, usage: delta.usage });
  }
  return events;
}

export class SseParser {
  private buffer = "";
  private result = "";
  private finished = false;
  private readonly onDelta: (delta: StreamDelta) => void;

  constructor(onDelta: (delta: StreamDelta) => void) {
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

  finish(): string {
    if (!this.finished && this.buffer.trim()) this.consumeLine(this.buffer);
    this.buffer = "";
    return this.result;
  }

  value(): string {
    return this.result;
  }

  isFinished(): boolean {
    return this.finished;
  }

  private consumeLine(line: string): boolean {
    const text = line.trim();
    if (!text || text.startsWith(":")) return false;
    if (!text.startsWith("data:")) return false;
    const payload = text.slice(5).trim();
    if (payload === "[DONE]") {
      this.finished = true;
      return true;
    }
    let json: JsonRecord;
    try {
      const parsed: unknown = JSON.parse(payload);
      json = asRecord(parsed);
    } catch {
      throw new Error("The server returned an invalid SSE frame.");
    }
    if (json.error) {
      const detail = typeof json.error === "string" ? json.error : JSON.stringify(json.error);
      throw new Error(`The server returned an inference error: ${detail.slice(0, 500)}`);
    }
    const choices = Array.isArray(json.choices) ? json.choices : [];
    const choice = asRecord(choices[0]);
    const delta = asRecord(choice.delta);
    const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
    const content = typeof delta.content === "string" ? delta.content : "";
    const rawToolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    const toolCalls: ToolCallDelta[] = rawToolCalls
      .map((value: unknown, index: number) => {
        const toolCall = asRecord(value);
        const fn = asRecord(toolCall.function);
        return {
          index: typeof toolCall.index === "number" ? toolCall.index : index,
          id: typeof toolCall.id === "string" ? toolCall.id : undefined,
          name: typeof fn.name === "string" ? fn.name : undefined,
          arguments: typeof fn.arguments === "string" ? fn.arguments : undefined,
        };
      })
      .filter((toolCall) => !!toolCall.id || !!toolCall.name || !!toolCall.arguments);
    const finishReason = typeof choice.finish_reason === "string" || choice.finish_reason === null
      ? choice.finish_reason
      : undefined;
    const usage = json.usage && typeof json.usage === "object" ? json.usage as StreamUsage : undefined;
    if (this.result.length + content.length > MAX_STREAM_RESULT_CHARS) {
      throw new Error("The streamed response exceeds the configured size limit.");
    }
    if (reasoning || content || toolCalls.length || finishReason !== undefined || usage) {
      this.onDelta({
        id: typeof json?.id === "string" ? json.id : undefined,
        model: typeof json?.model === "string" ? json.model : undefined,
        reasoning: reasoning || undefined,
        content: content || undefined,
        tool_calls: toolCalls.length ? toolCalls : undefined,
        finish_reason: finishReason,
        usage,
      });
      if (content) this.result += content;
    }
    return false;
  }
}
