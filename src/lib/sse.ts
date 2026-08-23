import type { StreamEvent } from "../types/chat";

export async function consumeOpenAIStream(
  response: Response,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  if (!response.body) throw new Error("The endpoint returned no streaming body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const consumeFrame = (frame: string) => {
    const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
    if (!dataLine) return;
    const data = dataLine.slice(5).trim();
    if (!data || data === "[DONE]") {
      if (data === "[DONE]") onEvent({ type: "done", stopReason: "stop" });
      return;
    }
    const payload = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: string; reasoning_content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const delta = payload.choices?.[0]?.delta;
    if (delta?.content) onEvent({ type: "text", text: delta.content });
    if (delta?.reasoning_content) onEvent({ type: "reasoning", text: delta.reasoning_content });
    for (const call of delta?.tool_calls ?? []) {
      onEvent({ type: "tool", tool: { id: call.id, name: call.function?.name, input: call.function?.arguments } });
    }
    if (payload.usage) {
      onEvent({ type: "usage", usage: { inputTokens: payload.usage.prompt_tokens, outputTokens: payload.usage.completion_tokens } });
    }
    if (payload.choices?.[0]?.finish_reason) {
      onEvent({ type: "done", stopReason: payload.choices[0].finish_reason });
    }
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
