import type * as api from "../api";
import type { DocumentAttachment, ImageAttachment } from "../chatUtils";

export interface FailedRequest {
  text: string;
  images: ImageAttachment[];
  documents: DocumentAttachment[];
  history: api.ChatMessage[];
  partialAssistant?: string;
  partialReasoning?: string;
}

export interface ChatMetrics {
  promptTokens?: number;
  completionTokens?: number;
  firstTokenMs?: number;
  totalMs?: number;
  tokensPerSecond?: number;
}

export interface PendingToolCall {
  serverId: string;
  serverName: string;
  toolName: string;
  call: api.ChatToolCall;
  argumentsValue: Record<string, unknown>;
}
