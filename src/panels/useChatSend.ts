import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import * as api from "../api";
import type { AppStore } from "../store";
import { buildMultimodalContent, capMaxTokens, estimateChatTokens, MAX_SEARCHABLE_DOCUMENT_CHUNKS, trimChatHistory, type DocumentAttachment, type ImageAttachment } from "../chatUtils";
import type { ChatHistoryMessage, ChatThread } from "../chatHistory";
import { QWEN38_DEFAULTS } from "./qwenDefaults";
import { getActiveModelProfile } from "../modelProfiles";
import type { AppPreferences } from "../preferences";
import { deriveTokensPerSecond } from "../lifecycleUtils";
import type { StreamUsage } from "../sse";
import type { ChatMcpTool } from "./useChatMcpTools";
import type { ChatMetrics, FailedRequest, PendingToolCall } from "./chatSendTypes";
import { createStreamDeltaHandler, resolveDetectedToolCall, retrieveDocumentContext, sameDocuments, sameImages, toChatMessage } from "./chatSendHelpers";

export type { ChatMetrics, PendingToolCall } from "./chatSendTypes";

type Msg = ChatHistoryMessage;

interface UseChatSendOptions {
  store: AppStore;
  preferences?: AppPreferences;
  baseUrl: string | null;
  apiKey: string;
  model: string;
  activeThread: ChatThread | undefined;
  msgs: Msg[];
  setMsgs: Dispatch<SetStateAction<Msg[]>>;
  input: string;
  setInput: (value: string) => void;
  attachments: ImageAttachment[];
  documents: DocumentAttachment[];
  setAttachments: Dispatch<SetStateAction<ImageAttachment[]>>;
  setDocuments: Dispatch<SetStateAction<DocumentAttachment[]>>;
  mcpEntryByFunctionName: Map<string, ChatMcpTool>;
  mcpDefinitions: api.ChatToolDefinition[];
  atBottomRef: MutableRefObject<boolean>;
  phase: "idle" | "thinking" | "streaming";
  setPhase: Dispatch<SetStateAction<"idle" | "thinking" | "streaming">>;
}

// Streaming updates land in `streamingDraft` instead of `msgs` so the hot rAF path never
// clones the full message array; the draft is flushed into `msgs` once per stream
// (completion, tool call, or error), not once per animation frame, and any still-pending
// rAF is cancelled at each of those terminal transitions to avoid a redundant flush.
export function useChatSend({
  store, preferences, baseUrl, apiKey, model, activeThread, msgs, setMsgs,
  input, setInput, attachments, documents, setAttachments, setDocuments,
  mcpEntryByFunctionName, mcpDefinitions, atBottomRef, phase, setPhase,
}: UseChatSendOptions) {
  const [error, setError] = useState<string | null>(null);
  const [contextWarning, setContextWarning] = useState<string | null>(null);
  const [contextSources, setContextSources] = useState<string[]>([]);
  const [aborting, setAborting] = useState(false);
  const [pendingToolCall, setPendingToolCall] = useState<PendingToolCall | null>(null);
  const [metrics, setMetrics] = useState<ChatMetrics | null>(null);
  const [streamingDraft, setStreamingDraft] = useState<{ content: string; reasoning: string } | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);
  const failedRef = useRef<FailedRequest | null>(null);
  const renderFrameRef = useRef<number | null>(null);
  const streamRef = useRef<{ assistant: string; reasoning: string; toolCalls: api.ChatToolCall[] }>({ assistant: "", reasoning: "", toolCalls: [] });
  const metricsRef = useRef<{ startedAt: number; firstTokenAt?: number; usage?: StreamUsage }>({ startedAt: 0 });
  const toolRoundsRef = useRef(0);
  // MCP follow-up sends carry no documents of their own, so this tracks whether the
  // turn's original message hit the search limit and keeps that warning visible
  // across follow-up rounds until a new user message (or thread switch) resets it.
  const documentTruncationRef = useRef(false);

  useEffect(() => () => {
    if (renderFrameRef.current !== null) window.cancelAnimationFrame(renderFrameRef.current);
  }, []);

  const cancelScheduledRender = () => {
    if (renderFrameRef.current !== null) {
      window.cancelAnimationFrame(renderFrameRef.current);
      renderFrameRef.current = null;
    }
  };

  const scheduleAssistantRender = () => {
    if (renderFrameRef.current !== null) return;
    renderFrameRef.current = window.requestAnimationFrame(() => {
      renderFrameRef.current = null;
      const { assistant, reasoning } = streamRef.current;
      setStreamingDraft({ content: assistant, reasoning });
    });
  };

  const resetChatState = () => {
    setError(null);
    documentTruncationRef.current = false;
    setContextWarning(null);
    setContextSources([]);
  };

  const send = async (retry = false, historyOverride?: api.ChatMessage[], canSend = true) => {
    if (!baseUrl) return;
    const toolFollowup = !!historyOverride;
    const failed = failedRef.current;
    const text = toolFollowup ? "" : (retry ? failed?.text ?? "" : input).trim();
    const images = toolFollowup ? [] : (retry ? failed?.images ?? [] : attachments);
    const pendingDocuments = toolFollowup ? [] : (retry ? failed?.documents ?? [] : documents);
    if (!toolFollowup && !text && images.length === 0 && pendingDocuments.length === 0) return;
    if (!toolFollowup && !canSend && !retry) return;
    if (!toolFollowup) {
      toolRoundsRef.current = 0;
      documentTruncationRef.current = false;
    }

    const controller = new AbortController();
    ctrlRef.current = controller;
    streamRef.current = { assistant: "", reasoning: "", toolCalls: [] };
    cancelScheduledRender();
    setStreamingDraft(null);
    metricsRef.current = { startedAt: performance.now() };
    setMetrics(null);
    let activityStarted = false;
    let assistantAppended = false;
    try {
      await api.serverActivity("start");
      activityStarted = true;

      const { documentContext, retrievalSources, retrievalCitations, documentChunksTruncated } = await retrieveDocumentContext(pendingDocuments, text, model, apiKey, baseUrl);
      if (documentChunksTruncated) documentTruncationRef.current = true;
      setContextSources(retrievalSources);
      const requestContent = `${text}${documentContext ?? ""}`;
      const userMessage: api.ChatMessage = {
        role: "user",
        content: images.length ? buildMultimodalContent(requestContent, images) : requestContent,
      };
      const activeProfile = !historyOverride && store.cfg ? getActiveModelProfile(store.cfg, model) : null;
      const rawHistory = historyOverride ?? (retry && failed ? failed.history : [
        { role: "system" as const, content: activeThread?.systemPrompt.trim() || activeProfile?.system_prompt.trim() || "You are a helpful assistant." },
        ...msgs.map(toChatMessage),
        userMessage,
      ]);
      const contextSize = Math.max(512, store.cfg?.ctx_size ?? 4096);
      const maxContextTokens = Math.max(256, Math.floor(contextSize * 0.75));
      const bounded = toolFollowup ? { messages: rawHistory, trimmed: false } : trimChatHistory(rawHistory, maxContextTokens);
      const promptTokens = estimateChatTokens(bounded.messages);
      const chatOptions = capMaxTokens(store.cfg?.chat_options ?? {}, promptTokens, contextSize);
      const warnings = [
        documentTruncationRef.current ? `Only the first ${MAX_SEARCHABLE_DOCUMENT_CHUNKS} document chunks were searched; the rest of the attached document(s) were not included.` : null,
        bounded.trimmed ? "Older messages were omitted from this request to stay within the configured context window." : null,
      ].filter((warning): warning is string => warning !== null);
      setContextWarning(warnings.length > 0 ? warnings.join(" ") : null);
      failedRef.current = { text, images, documents: pendingDocuments, history: bounded.messages };
      if (!toolFollowup) setInput("");
      if (!retry && !toolFollowup) setAttachments([]);
      if (!retry && !toolFollowup) setDocuments([]);
      setError(null);
      setPhase("thinking");
      atBottomRef.current = true;
      setMsgs((current) => {
        const last = current[current.length - 1];
        const withoutDanglingAssistant = last?.role === "assistant" ? current.slice(0, -1) : current;
        if (toolFollowup) return [...withoutDanglingAssistant, { role: "assistant" as const, content: "", reasoning: "" }];
        const previous = withoutDanglingAssistant[withoutDanglingAssistant.length - 1];
        const hasUserBubble = previous?.role === "user" && previous.content === text && sameImages(previous.images, images) && sameDocuments(previous.documents, pendingDocuments);
        return [...withoutDanglingAssistant, ...(hasUserBubble ? [] : [{ role: "user" as const, content: text, images, documents: pendingDocuments }]), { role: "assistant" as const, content: "", reasoning: "" }];
      });
      assistantAppended = true;
      const sampling = {
        temperature: store.cfg?.temperature ?? QWEN38_DEFAULTS.temperature,
        top_p: store.cfg?.top_p ?? QWEN38_DEFAULTS.top_p,
        top_k: store.cfg?.top_k ?? QWEN38_DEFAULTS.top_k,
        reasoning: store.cfg?.reasoning ?? QWEN38_DEFAULTS.reasoning,
        reasoning_effort: store.cfg?.reasoning_effort ?? QWEN38_DEFAULTS.reasoning_effort,
        options: chatOptions,
        tools: mcpDefinitions,
      };
      const streamResponses = preferences?.chat.streamResponses ?? true;
      const onDelta = createStreamDeltaHandler({ streamRef, metricsRef, streamResponses, setPhase: () => setPhase("streaming"), scheduleAssistantRender });
      const full = await api.chatStream(baseUrl, apiKey, model, bounded.messages, sampling, onDelta, controller.signal);

      const toolCall = streamRef.current.toolCalls[0];
      if (toolCall) {
        const { assistant: toolCallAssistant, reasoning: toolCallReasoning } = streamRef.current;
        cancelScheduledRender();
        setMsgs((current) => {
          if (current[current.length - 1]?.role !== "assistant") return current;
          const next = current.slice();
          next[next.length - 1] = { ...next[next.length - 1], content: toolCallAssistant, reasoning: toolCallReasoning };
          return next;
        });
        setStreamingDraft(null);
        toolRoundsRef.current += 1;
        if (toolRoundsRef.current > 4) throw new Error("MCP tool loop limit reached (4 calls per response).");
        setPendingToolCall(resolveDetectedToolCall(toolCall, mcpEntryByFunctionName));
        setPhase("idle");
        return;
      }

      cancelScheduledRender();
      setMsgs((current) => {
        if (current[current.length - 1]?.role !== "assistant") return current;
        const next = current.slice();
        next[next.length - 1] = {
          ...next[next.length - 1],
          content: full,
          reasoning: streamRef.current.reasoning,
          citations: retrievalCitations.length ? retrievalCitations : undefined,
        };
        return next;
      });
      setStreamingDraft(null);
      {
        const totalMs = performance.now() - metricsRef.current.startedAt;
        const usage = metricsRef.current.usage;
        const completionTokens = usage?.completion_tokens ?? estimateChatTokens([{ role: "assistant", content: full }]);
        setMetrics({
          promptTokens: usage?.prompt_tokens,
          completionTokens,
          firstTokenMs: metricsRef.current.firstTokenAt === undefined ? undefined : metricsRef.current.firstTokenAt - metricsRef.current.startedAt,
          totalMs,
          tokensPerSecond: deriveTokensPerSecond(completionTokens, totalMs) ?? undefined,
        });
      }
      failedRef.current = null;
      toolRoundsRef.current = 0;
      setPhase("idle");
    } catch (caught) {
      const isAbort = controller.signal.aborted || (caught instanceof DOMException && caught.name === "AbortError");
      cancelScheduledRender();
      if (assistantAppended) {
        const partialAssistant = streamRef.current.assistant;
        const partialReasoning = streamRef.current.reasoning;
        if (partialAssistant || partialReasoning) {
          failedRef.current = { ...(failedRef.current ?? { text, images, documents: pendingDocuments, history: [] }), partialAssistant, partialReasoning };
          setMsgs((current) => {
            if (current[current.length - 1]?.role !== "assistant") return current;
            const next = current.slice();
            next[next.length - 1] = { ...next[next.length - 1], content: partialAssistant, reasoning: partialReasoning, interrupted: isAbort, failed: !isAbort };
            return next;
          });
          setStreamingDraft(null);
        } else {
          setMsgs((current) => (current[current.length - 1]?.role === "assistant" ? current.slice(0, -1) : current));
          setStreamingDraft(null);
        }
      }
      if (isAbort) {
        if (!streamRef.current.assistant && !streamRef.current.reasoning) failedRef.current = null;
        toolRoundsRef.current = 0;
        setPhase("idle");
      } else {
        setError(caught instanceof Error ? caught.message : String(caught));
        setPhase("idle");
      }
    } finally {
      if (activityStarted) void api.serverActivity("end").catch(() => undefined);
      ctrlRef.current = null;
      setAborting(false);
      void store.refreshStatus();
    }
  };

  const approvePendingTool = async () => {
    const pending = pendingToolCall;
    const failed = failedRef.current;
    if (!pending || !failed || phase !== "idle") return;
    setPendingToolCall(null);
    setError(null);
    setPhase("thinking");
    try {
      const result = await api.mcpCallTool(pending.serverId, pending.toolName, pending.argumentsValue);
      const serializedResult = JSON.stringify(result);
      if (serializedResult.length > 256_000) throw new Error("MCP tool result exceeds the 256 KiB chat safety limit.");
      const followupHistory: api.ChatMessage[] = [
        ...failed.history,
        { role: "assistant", content: "", tool_calls: [pending.call] },
        { role: "tool", tool_call_id: pending.call.id, name: pending.call.function.name, content: serializedResult },
      ];
      await send(false, followupHistory);
    } catch (caught) {
      setPhase("idle");
      setError(`MCP tool call failed: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  };

  const rejectPendingTool = () => {
    setPendingToolCall(null);
    failedRef.current = null;
    toolRoundsRef.current = 0;
    setMsgs((current) => current[current.length - 1]?.role === "assistant" ? current.slice(0, -1) : current);
    setError("MCP tool call rejected by the user.");
    setPhase("idle");
  };

  const stop = () => {
    setAborting(true);
    ctrlRef.current?.abort();
  };

  return {
    error, setError, contextWarning, contextSources,
    aborting, pendingToolCall, metrics, streamingDraft, failedRef,
    send, approvePendingTool, rejectPendingTool, stop, resetChatState,
  };
}
