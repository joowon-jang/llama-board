import type { StreamEvent } from "../types/chat";

export async function consumeAnthropicStream(
  response: Response,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  if (!response.body) throw new Error("The Anthropic endpoint returned no streaming body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const consumeFrame = (frame: string) => {
    const eventName = frame.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
    const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
    if (!dataLine) return;
    const payload = JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;
    const delta = (payload.delta ?? {}) as Record<string, unknown>;
    if (eventName === "content_block_delta") {
      const type = String(delta.type ?? "");
      if (type === "text_delta") onEvent({ type: "text", text: String(delta.text ?? "") });
      if (type === "thinking_delta") onEvent({ type: "reasoning", text: String(delta.thinking ?? "") });
      if (type === "input_json_delta") onEvent({ type: "tool", tool: { input: String(delta.partial_json ?? "") } });
    }
    if (eventName === "content_block_start") {
      const block = (payload.content_block ?? {}) as Record<string, unknown>;
      if (block.type === "tool_use") onEvent({ type: "tool", tool: { id: String(block.id ?? ""), name: String(block.name ?? "") } });
    }
    if (eventName === "message_delta") {
      const usage = (payload.usage ?? {}) as Record<string, unknown>;
      onEvent({ type: "usage", usage: { outputTokens: Number(usage.output_tokens ?? 0) } });
      onEvent({ type: "done", stopReason: String(delta.stop_reason ?? "end_turn") });
    }
    if (eventName === "message_stop") onEvent({ type: "done", stopReason: "end_turn" });
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let separator = buffer.indexOf("\n\n");
    while (separator >= 0) {
      consumeFrame(buffer.slice(0, separator));
      buffer = buffer.slice(separator + 2);
      separator = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
  if (buffer.trim()) consumeFrame(buffer);
}
