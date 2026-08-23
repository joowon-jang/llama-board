export type Provider = "openai" | "anthropic";

export interface ChatMessage {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoning?: string;
  toolCalls?: Array<{ id?: string; name?: string; input?: string }>;
  createdAt: number;
}

export interface StreamEvent {
  type: "text" | "reasoning" | "tool" | "usage" | "done";
  text?: string;
  tool?: { id?: string; name?: string; input?: string };
  usage?: { inputTokens?: number; outputTokens?: number };
  stopReason?: string;
}

export interface ChatRequest {
  provider: Provider;
  baseUrl: string;
  apiKey?: string;
  anthropicVersion?: string;
  model: string;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens: number;
  temperature?: number;
  topP?: number;
  signal?: AbortSignal;
}
