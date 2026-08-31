import * as api from "../api";
import {
  buildDocumentContext, buildMultimodalContent, buildVectorDocumentContext,
  MAX_SEARCHABLE_DOCUMENT_CHUNKS, splitDocumentChunks,
  vectorDocumentCitations, vectorDocumentSources, type DocumentAttachment, type ImageAttachment,
} from "../chatUtils";
import type { ChatCitation, ChatHistoryMessage } from "../chatHistory";
import { loadDocumentVectors, saveDocumentVectors } from "../documentIndex";
import type { StreamUsage } from "../sse";
import type { ChatMcpTool } from "./useChatMcpTools";
import type { PendingToolCall } from "./chatSendTypes";

type Msg = ChatHistoryMessage;

export function sameImages(left: ImageAttachment[] | undefined, right: ImageAttachment[]) {
  return (left ?? []).length === right.length && (left ?? []).every((image, index) => image.dataUrl === right[index]?.dataUrl);
}

export function toChatMessage(message: Msg): api.ChatMessage {
  const content = `${message.content}${buildDocumentContext(message.documents ?? [], 12_000, message.content)}`;
  return {
    role: message.role,
    content: message.images?.length ? buildMultimodalContent(content, message.images) : content,
  };
}

export function sameDocuments(left: DocumentAttachment[] | undefined, right: DocumentAttachment[]) {
  return (left ?? []).length === right.length && (left ?? []).every((document, index) => document.path === right[index]?.path);
}

export function validateToolArguments(schema: unknown, value: Record<string, unknown>): string | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  const objectSchema = schema as { required?: unknown; properties?: unknown };
  if (Array.isArray(objectSchema.required)) {
    for (const key of objectSchema.required) {
      if (typeof key === "string" && !(key in value)) return `missing required field: ${key}`;
    }
  }
  if (objectSchema.properties && typeof objectSchema.properties === "object" && !Array.isArray(objectSchema.properties)) {
    for (const [key, rule] of Object.entries(objectSchema.properties as Record<string, unknown>)) {
      if (!(key in value) || !rule || typeof rule !== "object") continue;
      const type = (rule as { type?: unknown }).type;
      const actual = value[key];
      if (type === "string" && typeof actual !== "string") return `${key} must be a string`;
      if (type === "number" && (typeof actual !== "number" || !Number.isFinite(actual))) return `${key} must be a number`;
      if (type === "integer" && (!Number.isInteger(actual))) return `${key} must be an integer`;
      if (type === "boolean" && typeof actual !== "boolean") return `${key} must be a boolean`;
      if (type === "array" && !Array.isArray(actual)) return `${key} must be an array`;
      if (type === "object" && (!actual || typeof actual !== "object" || Array.isArray(actual))) return `${key} must be an object`;
    }
  }
  return null;
}

export interface RetrievalResult {
  documentContext: string | null;
  retrievalSources: string[];
  retrievalCitations: ChatCitation[];
  documentChunksTruncated: boolean;
}

/** Vector-ranks attached documents against `text`, falling back to lexical order when embeddings are unavailable. */
export async function retrieveDocumentContext(pendingDocuments: DocumentAttachment[], text: string, model: string, apiKey: string, baseUrl: string): Promise<RetrievalResult> {
  let documentContext = buildDocumentContext(pendingDocuments, 12_000, text);
  let retrievalSources = pendingDocuments.map((document) => `${document.name} (lexical fallback)`);
  let retrievalCitations: ChatCitation[] = pendingDocuments.map((document) => ({ name: document.name, path: document.path, offset: 0 }));
  let documentChunksTruncated = false;
  if (pendingDocuments.length > 0 && text) {
    try {
      const allChunks = splitDocumentChunks(pendingDocuments);
      documentChunksTruncated = allChunks.length > MAX_SEARCHABLE_DOCUMENT_CHUNKS;
      const chunks = allChunks.slice(0, MAX_SEARCHABLE_DOCUMENT_CHUNKS);
      const cachedVectors = await loadDocumentVectors(model, chunks, baseUrl);
      let chunkVectors: number[][];
      let queryVector: number[] | undefined;
      if (cachedVectors) {
        chunkVectors = cachedVectors;
        [queryVector] = await api.embedText(baseUrl, apiKey, model, [text]);
      } else {
        const vectors = await api.embedText(baseUrl, apiKey, model, [...chunks.map((chunk) => chunk.text), text]);
        chunkVectors = vectors.slice(0, chunks.length);
        queryVector = vectors[chunks.length];
        void saveDocumentVectors(model, chunks, chunkVectors, baseUrl).catch(() => undefined);
      }
      if (queryVector) {
        const rankedVectors = [...chunkVectors, queryVector];
        documentContext = buildVectorDocumentContext(chunks, rankedVectors, rankedVectors.length - 1, 12_000) ?? documentContext;
        retrievalSources = vectorDocumentSources(chunks, rankedVectors, rankedVectors.length - 1);
        retrievalCitations = vectorDocumentCitations(chunks, rankedVectors, rankedVectors.length - 1);
      }
    } catch {
      // Older llama.cpp builds may not expose embeddings; lexical retrieval remains the safe fallback.
    }
  }
  return { documentContext, retrievalSources, retrievalCitations, documentChunksTruncated };
}

export interface StreamAccumulator {
  assistant: string;
  reasoning: string;
  toolCalls: api.ChatToolCall[];
}

/** Builds the `chatStream` delta callback: accumulates content/reasoning/tool-call deltas into `streamRef` and throttles bubble repaint via `scheduleAssistantRender`. */
export function createStreamDeltaHandler(options: {
  streamRef: { current: StreamAccumulator };
  metricsRef: { current: { startedAt: number; firstTokenAt?: number; usage?: StreamUsage } };
  streamResponses: boolean;
  setPhase: (phase: "streaming") => void;
  scheduleAssistantRender: () => void;
}) {
  const { streamRef, metricsRef, streamResponses, setPhase, scheduleAssistantRender } = options;
  return (delta: api.ChatDelta) => {
    if ((delta.content || delta.reasoning) && metricsRef.current.firstTokenAt === undefined) metricsRef.current.firstTokenAt = performance.now();
    if (delta.usage) metricsRef.current.usage = delta.usage;
    if (delta.reasoning) streamRef.current.reasoning += delta.reasoning;
    if (delta.content) {
      if (streamResponses) setPhase("streaming");
      streamRef.current.assistant += delta.content;
    }
    for (const toolDelta of delta.tool_calls ?? []) {
      const current = streamRef.current.toolCalls[toolDelta.index] ?? {
        id: toolDelta.id ?? `call-${toolDelta.index}`,
        type: "function" as const,
        function: { name: "", arguments: "" },
      };
      if (toolDelta.id) current.id = toolDelta.id;
      if (toolDelta.name) current.function.name += toolDelta.name;
      if (toolDelta.arguments) current.function.arguments += toolDelta.arguments;
      streamRef.current.toolCalls[toolDelta.index] = current;
    }
    if (streamResponses) scheduleAssistantRender();
  };
}

/** Validates the first tool call the model requested against the approved MCP catalog; throws a user-facing message on any mismatch. */
export function resolveDetectedToolCall(toolCall: api.ChatToolCall, mcpEntryByFunctionName: Map<string, ChatMcpTool>): PendingToolCall {
  const entry = mcpEntryByFunctionName.get(toolCall.function.name);
  if (!entry) throw new Error(`The model requested an unapproved MCP tool: ${toolCall.function.name}`);
  let argumentsValue: unknown = {};
  try {
    argumentsValue = toolCall.function.arguments.trim() ? JSON.parse(toolCall.function.arguments) : {};
  } catch {
    throw new Error(`MCP tool ${entry.tool.name} returned invalid JSON arguments.`);
  }
  if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
    throw new Error(`MCP tool ${entry.tool.name} arguments must be a JSON object.`);
  }
  const argumentError = validateToolArguments(entry.tool.input_schema, argumentsValue as Record<string, unknown>);
  if (argumentError) throw new Error(`MCP tool ${entry.tool.name} arguments invalid: ${argumentError}`);
  return {
    serverId: entry.serverId,
    serverName: entry.serverName,
    toolName: entry.tool.name,
    call: toolCall,
    argumentsValue: argumentsValue as Record<string, unknown>,
  };
}
