import { streamChat } from "./api-client";
import type { ChatRequest, StreamEvent } from "../types/chat";

export interface AnthropicRequest extends Omit<ChatRequest, "provider"> {
  anthropicVersion?: string;
}

export function streamAnthropic(
  request: AnthropicRequest,
  onEvent: (event: StreamEvent) => void,
) {
  return streamChat({ ...request, provider: "anthropic" }, onEvent);
}
