import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { AppStore } from "../store";
import { buildDocumentContext, buildMultimodalContent, buildVectorDocumentContext, capMaxTokens, estimateChatTokens, splitDocumentChunks, trimChatHistory, vectorDocumentCitations, vectorDocumentSources, type DocumentAttachment, type ImageAttachment } from "../chatUtils";
import { createChatThread, loadChatWorkspace, loadChatWorkspaceAsync, mergeHydratedWorkspace, saveChatWorkspaceAsync, threadMatchesQuery, titleFromMessage, type ChatCitation, type ChatHistoryMessage, type ChatThread, type ChatWorkspace } from "../chatHistory";
import { QWEN38_DEFAULTS } from "./qwenDefaults";
import { activeProjectId, PROJECTS_CHANGED_EVENT, readProjects } from "../projectStore";
import { loadDocumentVectors, saveDocumentVectors } from "../documentIndex";
import { buildMcpFunctionNames } from "../mcpUtils";

type Msg = ChatHistoryMessage;

interface FailedRequest {
  text: string;
  images: ImageAttachment[];
  documents: DocumentAttachment[];
  history: api.ChatMessage[];
}

interface ChatMcpTool {
  serverId: string;
  serverName: string;
  tool: api.McpTool;
}

interface PendingToolCall {
  serverId: string;
  serverName: string;
  toolName: string;
  call: api.ChatToolCall;
  argumentsValue: Record<string, unknown>;
}

function sameImages(left: ImageAttachment[] | undefined, right: ImageAttachment[]) {
  return (left ?? []).length === right.length && (left ?? []).every((image, index) => image.dataUrl === right[index]?.dataUrl);
}

function toChatMessage(message: Msg): api.ChatMessage {
  const content = `${message.content}${buildDocumentContext(message.documents ?? [], 12_000, message.content)}`;
  return {
    role: message.role,
    content: message.images?.length ? buildMultimodalContent(content, message.images) : content,
  };
}

function sameDocuments(left: DocumentAttachment[] | undefined, right: DocumentAttachment[]) {
  return (left ?? []).length === right.length && (left ?? []).every((document, index) => document.path === right[index]?.path);
}

function validateToolArguments(schema: unknown, value: Record<string, unknown>): string | null {
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

export default function ChatPanel({ store }: { store: AppStore }) {
  const [workspace, setWorkspace] = useState<ChatWorkspace>(() => loadChatWorkspace());
  const activeThread = workspace.threads.find((thread) => thread.id === workspace.activeThreadId) ?? workspace.threads[0];
  const [msgs, setMsgs] = useState<Msg[]>(() => activeThread?.messages ?? []);
  const [input, setInput] = useState("");
  const [threadQuery, setThreadQuery] = useState("");
  const [threadPanelOpen, setThreadPanelOpen] = useState(false);
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [documents, setDocuments] = useState<DocumentAttachment[]>([]);
  const [phase, setPhase] = useState<"idle" | "thinking" | "streaming">("idle");
  const [error, setError] = useState<string | null>(null);
  const [contextWarning, setContextWarning] = useState<string | null>(null);
  const [contextSources, setContextSources] = useState<string[]>([]);
  const [aborting, setAborting] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);
  const [mcpCatalog, setMcpCatalog] = useState<ChatMcpTool[]>([]);
  const [selectedMcpTools, setSelectedMcpTools] = useState<string[]>([]);
  const [activeProjectName, setActiveProjectName] = useState<string | null>(null);
  const [loadingMcpTools, setLoadingMcpTools] = useState(false);
  const [pendingToolCall, setPendingToolCall] = useState<PendingToolCall | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const ctrlRef = useRef<AbortController | null>(null);
  const failedRef = useRef<FailedRequest | null>(null);
  const atBottomRef = useRef(true);
  const renderFrameRef = useRef<number | null>(null);
  const streamRef = useRef<{ assistant: string; reasoning: string; toolCalls: api.ChatToolCall[] }>({ assistant: "", reasoning: "", toolCalls: [] });
  const toolRoundsRef = useRef(0);
  const hydratedRef = useRef(false);
  const initialWorkspaceRef = useRef(workspace);
  const initialMsgsRef = useRef(msgs);
  const workspaceRef = useRef(workspace);
  const msgsRef = useRef(msgs);
  workspaceRef.current = workspace;
  msgsRef.current = msgs;

  useEffect(() => {
    let cancelled = false;
    void loadChatWorkspaceAsync().then((persisted) => {
      if (cancelled) return;
      const merged = mergeHydratedWorkspace(persisted, workspaceRef.current, initialWorkspaceRef.current);
      const localMessagesChanged = JSON.stringify(msgsRef.current) !== JSON.stringify(initialMsgsRef.current);
      const nextActive = merged.threads.find((thread) => thread.id === merged.activeThreadId) ?? merged.threads[0];
      hydratedRef.current = true;
      setWorkspace(merged);
      if (!localMessagesChanged) setMsgs(nextActive?.messages ?? []);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const applyActiveProjectBinding = () => {
      const id = activeProjectId();
      const project = id ? readProjects().find((item) => item.id === id) : null;
      setActiveProjectName(project?.name ?? null);
      if (!project || phase !== "idle") return;
      setWorkspace((current) => ({
        ...current,
        threads: current.threads.map((thread) => thread.id === current.activeThreadId
          ? { ...thread, systemPrompt: project.systemPrompt, updatedAt: Date.now() }
          : thread),
      }));
      setSelectedMcpTools(project.toolIds);
      void Promise.all(project.documentBindings.slice(0, 4).map(async (binding) => {
        try {
          return { name: binding.name, path: binding.path, text: await api.readDocumentBinding(binding.path) };
        } catch {
          return null;
        }
      })).then((loaded) => {
        if (!cancelled) setDocuments(loaded.filter((document): document is DocumentAttachment => document !== null));
      });
    };
    applyActiveProjectBinding();
    window.addEventListener(PROJECTS_CHANGED_EVENT, applyActiveProjectBinding);
    return () => {
      cancelled = true;
      window.removeEventListener(PROJECTS_CHANGED_EVENT, applyActiveProjectBinding);
    };
  }, [phase]);

  useEffect(() => {
    if (hydratedRef.current) void saveChatWorkspaceAsync(workspace);
  }, [workspace]);

  useEffect(() => {
    if (phase !== "idle" || !activeThread) return;
    setWorkspace((current) => {
      const thread = current.threads.find((item) => item.id === current.activeThreadId);
      if (!thread || thread.messages === msgs) return current;
      const firstUser = msgs.find((message) => message.role === "user");
      const nextTitle = thread.title === "New conversation" && firstUser ? titleFromMessage(firstUser.content) : thread.title;
      return {
        ...current,
        threads: current.threads.map((item) => item.id === thread.id
          ? { ...item, messages: msgs, title: nextTitle, updatedAt: Date.now() }
          : item),
      };
    });
  }, [activeThread, msgs, phase]);

  const serverOn = store.status.state === "running";
  const baseUrl = serverOn && store.status.url ? store.status.url : null;
  const apiKey = serverOn ? store.status.api_key ?? "" : "";
  const configuredModel = store.cfg?.active_model ?? "";
  const model = (serverOn ? store.status.model : "") || configuredModel;
  const canSend = serverOn && !!apiKey && !!model && phase === "idle" && !aborting && !store.busy && (!!input.trim() || attachments.length > 0 || documents.length > 0);
  const disabled = !serverOn || !model || !apiKey;
  const visionReady = serverOn && !!store.status.mmproj;
  const visibleThreads = workspace.threads
    .filter((thread) => threadMatchesQuery(thread, threadQuery))
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const selectedMcpEntries = mcpCatalog.filter((entry) => selectedMcpTools.includes(`${entry.serverId}:${entry.tool.name}`));
  const generatedMcpNames = buildMcpFunctionNames(selectedMcpEntries.map((entry) => ({ serverId: entry.serverId, toolName: entry.tool.name })));
  const mcpEntryByFunctionName = new Map(generatedMcpNames.map((name, index) => [name, selectedMcpEntries[index]]));
  const mcpDefinitions: api.ChatToolDefinition[] = selectedMcpEntries.map((entry, index) => ({
      type: "function",
      function: {
        name: generatedMcpNames[index],
        description: entry.tool.description,
        parameters: entry.tool.input_schema && typeof entry.tool.input_schema === "object"
          ? entry.tool.input_schema
          : { type: "object", properties: {} },
      },
    }));

  const refreshMcpTools = async () => {
    if (loadingMcpTools) return;
    setLoadingMcpTools(true);
    try {
      const servers = await api.mcpListServers();
      const entries: ChatMcpTool[] = [];
      for (const server of servers.filter((item) => item.enabled)) {
        const tools = await api.mcpListTools(server.id);
        entries.push(...tools.map((tool) => ({ serverId: server.id, serverName: server.name, tool })));
      }
      setMcpCatalog(entries);
      setSelectedMcpTools(entries.map((entry) => `${entry.serverId}:${entry.tool.name}`));
      setError(null);
    } catch (caught) {
      setError(`MCP tool discovery failed: ${caught instanceof Error ? caught.message : String(caught)}`);
    } finally {
      setLoadingMcpTools(false);
    }
  };

  const requireIdle = () => {
    if (phase === "idle") return true;
    setError("Stop the current response before switching conversations.");
    return false;
  };

  const selectThread = (thread: ChatThread) => {
    if (!requireIdle()) return;
    setWorkspace((current) => ({ ...current, activeThreadId: thread.id }));
    setMsgs(thread.messages);
    setInput("");
    setAttachments([]);
    setDocuments([]);
    setError(null);
    setContextWarning(null);
    setContextSources([]);
    setThreadPanelOpen(false);
  };

  const newThread = () => {
    if (!requireIdle()) return;
    const now = Date.now();
    let id = `thread-${now}`;
    let suffix = 1;
    while (workspace.threads.some((thread) => thread.id === id)) id = `thread-${now}-${suffix++}`;
    const thread = createChatThread(now, id);
    setWorkspace((current) => ({ activeThreadId: thread.id, threads: [thread, ...current.threads] }));
    setMsgs([]);
    setInput("");
    setAttachments([]);
    setDocuments([]);
    setError(null);
    setContextWarning(null);
    setContextSources([]);
    setThreadPanelOpen(false);
  };

  const deleteThread = (thread: ChatThread) => {
    if (!requireIdle()) return;
    const remaining = workspace.threads.filter((item) => item.id !== thread.id);
    if (thread.id !== workspace.activeThreadId) {
      setWorkspace((current) => ({ ...current, threads: remaining }));
      return;
    }
    const replacement = remaining[0] ?? createChatThread(Date.now(), `thread-${Date.now()}`);
    setWorkspace({ activeThreadId: replacement.id, threads: remaining.length ? remaining : [replacement] });
    setMsgs(replacement.messages);
    setInput("");
    setAttachments([]);
    setDocuments([]);
    setError(null);
    setContextWarning(null);
    setContextSources([]);
  };

  const updateActiveThread = (patch: Partial<Pick<ChatThread, "title" | "systemPrompt">>) => {
    if (!activeThread || !requireIdle()) return;
    setWorkspace((current) => ({
      ...current,
      threads: current.threads.map((thread) => thread.id === current.activeThreadId
        ? { ...thread, ...patch, updatedAt: Date.now() }
        : thread),
    }));
  };

  useEffect(() => () => {
    if (renderFrameRef.current !== null) window.cancelAnimationFrame(renderFrameRef.current);
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !atBottomRef.current) return;
    window.requestAnimationFrame(() => element.scrollTo({ top: element.scrollHeight, behavior: phase === "idle" ? "smooth" : "auto" }));
  }, [msgs, phase]);

  const scheduleAssistantRender = () => {
    if (renderFrameRef.current !== null) return;
    renderFrameRef.current = window.requestAnimationFrame(() => {
      renderFrameRef.current = null;
      const { assistant, reasoning } = streamRef.current;
      setMsgs((current) => {
        if (current[current.length - 1]?.role !== "assistant") return current;
        const next = current.slice();
        next[next.length - 1] = { role: "assistant", content: assistant, reasoning };
        return next;
      });
    });
  };

  const send = async (retry = false, historyOverride?: api.ChatMessage[]) => {
    if (!baseUrl) return;
    const toolFollowup = !!historyOverride;
    const failed = failedRef.current;
    const text = toolFollowup ? "" : (retry ? failed?.text ?? "" : input).trim();
    const images = toolFollowup ? [] : (retry ? failed?.images ?? [] : attachments);
    const pendingDocuments = toolFollowup ? [] : (retry ? failed?.documents ?? [] : documents);
    if (!toolFollowup && !text && images.length === 0 && pendingDocuments.length === 0) return;
    if (!toolFollowup && !canSend && !retry) return;
    if (!toolFollowup) toolRoundsRef.current = 0;

    const controller = new AbortController();
    ctrlRef.current = controller;
    streamRef.current = { assistant: "", reasoning: "", toolCalls: [] };
    let activityStarted = false;
    let assistantAppended = false;
    try {
      await api.serverActivity("start");
      activityStarted = true;

    let documentContext = buildDocumentContext(pendingDocuments, 12_000, text);
    let retrievalSources = pendingDocuments.map((document) => `${document.name} (lexical fallback)`);
    let retrievalCitations: ChatCitation[] = pendingDocuments.map((document) => ({ name: document.name, path: document.path, offset: 0 }));
    if (pendingDocuments.length > 0 && text) {
      try {
        const chunks = splitDocumentChunks(pendingDocuments).slice(0, 64);
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
    setContextSources(retrievalSources);
    const requestContent = `${text}${documentContext ?? ""}`;
    const userMessage: api.ChatMessage = {
      role: "user",
      content: images.length ? buildMultimodalContent(requestContent, images) : requestContent,
    };
    const rawHistory = historyOverride ?? (retry && failed ? failed.history : [
      { role: "system" as const, content: activeThread?.systemPrompt.trim() || "You are a helpful assistant." },
      ...msgs.map(toChatMessage),
      userMessage,
    ]);
    const contextSize = Math.max(512, store.cfg?.ctx_size ?? 4096);
    const maxContextTokens = Math.max(256, Math.floor(contextSize * 0.75));
    const bounded = toolFollowup ? { messages: rawHistory, trimmed: false } : trimChatHistory(rawHistory, maxContextTokens);
    const promptTokens = estimateChatTokens(bounded.messages);
    const chatOptions = capMaxTokens(store.cfg?.chat_options ?? {}, promptTokens, contextSize);
    setContextWarning(bounded.trimmed ? "Older messages were omitted from this request to stay within the configured context window." : null);
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
      const full = await api.chatStream(baseUrl, apiKey, model, bounded.messages, sampling, (delta) => {
        if (delta.reasoning) streamRef.current.reasoning += delta.reasoning;
        if (delta.content) {
          setPhase("streaming");
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
        scheduleAssistantRender();
      }, controller.signal);

      const toolCall = streamRef.current.toolCalls[0];
      if (toolCall) {
        toolRoundsRef.current += 1;
        if (toolRoundsRef.current > 4) throw new Error("MCP tool loop limit reached (4 calls per response).");
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
        setPendingToolCall({
          serverId: entry.serverId,
          serverName: entry.serverName,
          toolName: entry.tool.name,
          call: toolCall,
          argumentsValue: argumentsValue as Record<string, unknown>,
        });
        setPhase("idle");
        return;
      }

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
      failedRef.current = null;
      toolRoundsRef.current = 0;
      setPhase("idle");
    } catch (caught) {
      const isAbort = controller.signal.aborted || (caught instanceof DOMException && caught.name === "AbortError");
      if (assistantAppended) {
        setMsgs((current) => (current[current.length - 1]?.role === "assistant" ? current.slice(0, -1) : current));
      }
      if (isAbort) {
        failedRef.current = null;
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

  const addImage = async () => {
    if (!visionReady) {
      setError("Select an mmproj vision sidecar in Models or Tuning before attaching an image.");
      return;
    }
    try {
      const path = await api.pickImage();
      if (!path) return;
      const dataUrl = await api.readImageData(path);
      setAttachments((current) => current.length >= 4 ? current : [...current, { name: path.split(/[\\/]/).pop() ?? "image", dataUrl }]);
      setError(null);
    } catch (caught) {
      setError(`Image attachment failed: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  };

  const addDocument = async () => {
    try {
      const path = await api.pickDocument();
      if (!path) return;
      const text = await api.readDocumentText(path);
      const name = path.split(/[\\/]/).pop() ?? "document";
      setDocuments((current) => current.some((document) => document.path === path) || current.length >= 4
        ? current
        : [...current, { name, path, text }]);
      setError(null);
    } catch (caught) {
      setError(`Document attachment failed: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  };

  const stop = () => {
    setAborting(true);
    ctrlRef.current?.abort();
  };

  const copyMessage = async (index: number, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(index);
      window.setTimeout(() => setCopied((current) => (current === index ? null : current)), 1800);
    } catch (caught) {
      setError(`Copy failed: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col p-3 sm:p-4">
      <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setThreadPanelOpen((current) => !current)}
            className="rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs text-slate-300 hover:border-slate-600 hover:text-white sm:hidden"
            aria-expanded={threadPanelOpen}
            aria-controls="chat-thread-panel"
          >
            Chats
          </button>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-slate-100">{activeThread?.title ?? "New conversation"}</h2>
            <p className="truncate text-xs text-slate-500">{model ? `${model.split(/[\\/]/).pop()}${configuredModel && store.status.model && configuredModel !== store.status.model ? " · effective" : ""}` : "Select a model to begin"}{activeProjectName ? ` · ${activeProjectName}` : ""}</p>
          </div>
        </div>
        <details className="relative shrink-0">
          <summary className="cursor-pointer list-none rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-300 hover:border-slate-600 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">
            Conversation settings
          </summary>
          <div className="absolute right-0 z-30 mt-2 w-[min(24rem,calc(100vw-2rem))] rounded-xl border border-slate-700 bg-slate-900 p-3 shadow-2xl">
            <label className="block text-xs font-medium text-slate-300" htmlFor="chat-thread-title">Title</label>
            <input
              id="chat-thread-title"
              value={activeThread?.title ?? ""}
              onChange={(event) => updateActiveThread({ title: event.target.value })}
              disabled={phase !== "idle"}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
            />
            <label className="mt-3 block text-xs font-medium text-slate-300" htmlFor="chat-system-prompt">System prompt</label>
            <textarea
              id="chat-system-prompt"
              value={activeThread?.systemPrompt ?? ""}
              onChange={(event) => updateActiveThread({ systemPrompt: event.target.value })}
              disabled={phase !== "idle"}
              rows={5}
              className="mt-1 w-full resize-y rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
              placeholder="Instructions for this conversation"
            />
            <p className="mt-2 text-[11px] leading-relaxed text-slate-500">Saved locally with this conversation. It is sent as the system message on the next request.</p>
          </div>
        </details>
      </div>

      <div className="relative flex min-h-0 flex-1 gap-3">
        <aside
          id="chat-thread-panel"
          aria-label="Conversations"
          className={`${threadPanelOpen ? "absolute inset-y-0 left-0 z-20 flex shadow-2xl" : "hidden"} w-72 shrink-0 flex-col rounded-xl border border-slate-800 bg-slate-900/95 p-2 sm:relative sm:inset-auto sm:z-auto sm:flex sm:w-64 sm:shadow-none`}
        >
          <div className="flex items-center gap-2 px-2 pb-2">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">Conversations</div>
              <div className="mt-0.5 text-[11px] text-slate-600">{workspace.threads.length} saved locally</div>
            </div>
            <button type="button" onClick={newThread} className="rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">New chat</button>
          </div>
          <label className="sr-only" htmlFor="chat-thread-search">Search conversations</label>
          <input
            id="chat-thread-search"
            value={threadQuery}
            onChange={(event) => setThreadQuery(event.target.value)}
            placeholder="Search conversations"
            className="mx-1 mb-2 rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none"
          />
          <div className="min-h-0 flex-1 space-y-1 overflow-auto" role="list">
            {visibleThreads.length === 0 && <p className="px-2 py-4 text-xs text-slate-600">No matching conversations.</p>}
            {visibleThreads.map((thread) => (
              <div key={thread.id} role="listitem" className={`flex items-center gap-1 rounded-lg border ${thread.id === workspace.activeThreadId ? "border-indigo-500/40 bg-indigo-500/10" : "border-transparent hover:bg-slate-800"}`}>
                <button
                  type="button"
                  onClick={() => selectThread(thread)}
                  className="min-w-0 flex-1 px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400"
                  aria-current={thread.id === workspace.activeThreadId ? "page" : undefined}
                >
                  <span className="block truncate text-xs font-medium text-slate-200">{thread.title || "New conversation"}</span>
                  <span className="mt-0.5 block text-[10px] text-slate-600">{thread.messages.length ? `${thread.messages.length} messages` : "Empty"}</span>
                </button>
                <button type="button" onClick={() => deleteThread(thread)} aria-label={`Delete ${thread.title || "conversation"}`} className="mr-1 rounded px-1.5 py-1 text-xs text-slate-600 hover:bg-red-950 hover:text-red-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400">×</button>
              </div>
            ))}
          </div>
        </aside>

        <div className="flex min-w-0 min-h-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            role="log"
            aria-live="off"
            aria-label="Conversation"
            onScroll={(event) => {
              const element = event.currentTarget;
              atBottomRef.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 80;
            }}
            className="min-h-0 flex-1 space-y-3 overflow-auto pr-1"
          >
            {disabled && (
              <div className="mx-auto mt-8 max-w-xl rounded-xl border border-slate-700 bg-slate-800/60 p-6 text-center text-sm text-slate-300">
                <p className="mb-2 font-medium text-slate-200">{!serverOn ? "Server is offline" : !model ? "No model selected" : "Server authentication is starting"}</p>
                <p>{!serverOn ? "Start the server in Models to begin chatting." : !model ? "Select a GGUF model in Models, then start the server." : "Wait for the server to become ready, then try again."}</p>
              </div>
            )}

            {!disabled && msgs.length === 0 && (
              <div className="mx-auto mt-10 max-w-lg px-4 text-center">
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl border border-indigo-500/30 bg-indigo-500/10 text-xl text-indigo-300">✦</div>
                <h3 className="text-base font-semibold text-slate-100">Start a new conversation</h3>
                <p className="mt-1 text-sm leading-relaxed text-slate-500">Ask a question, attach an image when a projector is loaded, or adjust the conversation instructions above.</p>
              </div>
            )}

            {msgs.map((message, index) => (
              <div key={`${message.role}-${index}`} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`group relative max-w-[min(88%,56rem)] min-w-0 rounded-2xl px-4 py-2.5 text-sm ${message.role === "user" ? "bg-indigo-600 text-white" : "bg-slate-800 text-slate-100"}`}>
                  {message.role === "assistant" && message.reasoning && <details className="mb-2 rounded border border-slate-700/80 bg-slate-900/50 px-2 py-1 text-xs text-slate-400">
                    <summary className="cursor-pointer select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">Thinking process</summary>
                    <div className="mt-1 whitespace-pre-wrap break-words leading-relaxed">{message.reasoning}</div>
                  </details>}
                  {message.images?.length ? <div className="mb-2 flex flex-wrap gap-2">{message.images.map((image) => <img key={image.dataUrl} src={image.dataUrl} alt={image.name} className="max-h-40 max-w-40 rounded-lg border border-white/20 object-contain" />)}</div> : null}
                  {message.documents?.length ? <div className="mb-2 flex flex-wrap gap-1.5">{message.documents.map((document) => <span key={document.path} className="rounded-md border border-white/20 bg-black/10 px-2 py-1 text-[11px]">Document · {document.name}</span>)}</div> : null}
                  <div className="whitespace-pre-wrap break-words">{message.content || (phase === "thinking" && index === msgs.length - 1 ? <span className="animate-pulse text-slate-400">thinking…</span> : "")}</div>
                  {message.role === "assistant" && message.content && <button type="button" onClick={() => void copyMessage(index, message.content)} className="mt-2 rounded px-2 py-1 text-[11px] text-slate-400 opacity-0 transition hover:bg-slate-700 hover:text-slate-200 focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 group-hover:opacity-100" aria-label="Copy assistant message">{copied === index ? "Copied" : "Copy"}</button>}
                </div>
              </div>
            ))}

            {error && <div className="rounded-lg border border-red-800 bg-red-950/50 p-3 text-sm text-red-200" role="alert">
              <div className="mb-1 font-medium">Request failed</div>
              <div className="whitespace-pre-wrap break-words text-red-300">{error}</div>
              {failedRef.current && <button type="button" onClick={() => void send(true)} disabled={!serverOn || phase !== "idle" || !apiKey} className="mt-2 rounded bg-red-800 px-3 py-1 text-xs text-red-100 hover:bg-red-700 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300">Retry last message</button>}
            </div>}
          </div>

          {contextWarning && <div className="mt-2 rounded-lg border border-amber-800 bg-amber-950/50 px-3 py-2 text-xs text-amber-200" role="status">{contextWarning}</div>}
          {contextSources.length > 0 && <div className="mt-2 rounded-lg border border-cyan-900/70 bg-cyan-950/30 px-3 py-2 text-xs text-cyan-200" role="status"><span className="font-medium">Context sources:</span> {contextSources.join(" · ")}</div>}
          <div className="mt-2 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => void refreshMcpTools()} disabled={disabled || phase !== "idle" || loadingMcpTools} className="rounded-md bg-slate-800 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-700 disabled:opacity-40">{loadingMcpTools ? "Loading MCP tools…" : "Load MCP tools"}</button>
              <span className="text-[11px] text-slate-600">{mcpDefinitions.length ? `${mcpDefinitions.length} tool${mcpDefinitions.length === 1 ? "" : "s"} enabled; calls always require approval` : "MCP tools are optional and off until loaded"}</span>
            </div>
            {mcpCatalog.length > 0 && <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">{mcpCatalog.map((entry) => { const key = `${entry.serverId}:${entry.tool.name}`; const checked = selectedMcpTools.includes(key); return <label key={key} className="flex max-w-full items-center gap-1.5 text-[11px] text-slate-400"><input type="checkbox" checked={checked} onChange={() => setSelectedMcpTools((current) => checked ? current.filter((item) => item !== key) : [...current, key])} disabled={phase !== "idle"} className="accent-indigo-500" /><span className="max-w-52 truncate" title={`${entry.serverName}: ${entry.tool.name}`}>{entry.serverName} · {entry.tool.name}</span></label>; })}</div>}
          </div>
          {pendingToolCall && <div className="mt-2 rounded-lg border border-amber-700 bg-amber-950/50 p-3 text-xs text-amber-100" role="alert"><div className="font-medium">MCP approval required</div><p className="mt-1 text-amber-200">{pendingToolCall.serverName} wants to run <code className="font-mono">{pendingToolCall.toolName}</code>.</p><pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded bg-black/20 p-2 font-mono text-[11px] text-amber-200">{JSON.stringify(pendingToolCall.argumentsValue, null, 2)}</pre><div className="mt-2 flex gap-2"><button type="button" onClick={() => void approvePendingTool()} className="rounded bg-amber-600 px-3 py-1.5 font-medium text-white hover:bg-amber-500">Approve once</button><button type="button" onClick={rejectPendingTool} className="rounded bg-slate-800 px-3 py-1.5 text-slate-200 hover:bg-slate-700">Reject</button></div></div>}
          {attachments.length > 0 && <div className="mt-2 flex flex-wrap gap-2" aria-label="Pending image attachments">{attachments.map((image) => <div key={image.dataUrl} className="relative"><img src={image.dataUrl} alt={image.name} className="h-16 w-16 rounded-lg border border-slate-700 object-cover" /><button type="button" onClick={() => setAttachments((current) => current.filter((item) => item.dataUrl !== image.dataUrl))} className="absolute -right-2 -top-2 rounded-full bg-red-700 px-1.5 text-xs text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300" aria-label={`Remove ${image.name}`}>×</button></div>)}</div>}
          {documents.length > 0 && <div className="mt-2 flex flex-wrap gap-2" aria-label="Pending document attachments">{documents.map((document) => <div key={document.path} className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-300"><span className="max-w-48 truncate">{document.name}</span><button type="button" onClick={() => setDocuments((current) => current.filter((item) => item.path !== document.path))} className="rounded px-1 text-slate-500 hover:bg-red-900 hover:text-red-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300" aria-label={`Remove ${document.name}`}>×</button></div>)}</div>}
          <div className="mt-3 flex min-w-0 items-end gap-2">
            <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={onKeyDown} disabled={disabled || phase !== "idle"} rows={2} aria-label="Chat message" placeholder={disabled ? "Server offline — select a model and start it" : "Message (Enter to send, Shift+Enter for newline)"} className="min-h-[3rem] min-w-0 flex-1 resize-y rounded-xl border border-slate-700 bg-slate-800 p-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:opacity-50" />
            <button type="button" onClick={() => void addDocument()} disabled={disabled || phase !== "idle" || documents.length >= 4} title="Attach a text document for offline context" className="shrink-0 rounded-xl bg-slate-700 px-3 py-2.5 text-sm text-slate-200 hover:bg-slate-600 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400" aria-label="Attach document">Doc</button>
            <button type="button" onClick={() => void addImage()} disabled={disabled || phase !== "idle" || attachments.length >= 4} title={visionReady ? "Attach an image" : "An mmproj vision sidecar is required"} className="shrink-0 rounded-xl bg-slate-700 px-3 py-2.5 text-sm text-slate-200 hover:bg-slate-600 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400" aria-label="Attach image">Image</button>
            {phase !== "idle" ? <button type="button" onClick={stop} disabled={aborting} className="shrink-0 rounded-xl bg-red-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300">{aborting ? "Stopping…" : "Stop"}</button> : <button type="button" onClick={() => void send()} disabled={!canSend} className="shrink-0 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">Send</button>}
          </div>
          <div className="mt-1.5 flex min-w-0 justify-between gap-3 text-xs text-slate-500">
            <span className="min-w-0 truncate" title={model}>{model ? `model: ${model}` : "no model"}</span>
            <span className="shrink-0" role="status" aria-live="polite">{phase === "streaming" ? "generating…" : phase === "thinking" ? "waiting for first token…" : msgs.length === 0 ? "empty conversation" : `${msgs.length} messages`}</span>
          </div>
        </div>
      </div>
    </div>
  );
}