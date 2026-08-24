export interface StreamDelta {
  content?: string;
  reasoning?: string;
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
    let json: any;
    try {
      json = JSON.parse(payload);
    } catch {
      throw new Error("The server returned an invalid SSE frame.");
    }
    const delta = json?.choices?.[0]?.delta ?? {};
    const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
    const content = typeof delta.content === "string" ? delta.content : "";
    if (reasoning || content) {
      this.onDelta({ reasoning: reasoning || undefined, content: content || undefined });
      if (content) this.result += content;
    }
    return false;
  }
}
