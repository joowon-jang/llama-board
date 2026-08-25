import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { SseParser, type StreamDelta } from "./sse.ts";
import {
  anthropicMessagesUrl,
  buildAnthropicMessagesRequestBody,
  buildNativeChatRequestBody,
  consumeAnthropicStream,
  consumeNativeChatStream,
  nativeChatUrl,
  type AnthropicTool,
} from "./endpointAdapters.ts";
import type { JsonObject } from "./panels/tuningValidation.ts";

export interface AppConfig {
  config_version: number;
  models_dir: string;
  port: number;
  ngl: number;
  ctx_size: number;
  flash_attn: string;
  n_cpu_moe: number;
  threads: number;
  temperature: number;
  top_p: number;
  top_k: number;
  spec_type: string;
  spec_draft_n_max: number;
  spec_draft_n_min: number;
  spec_draft_p_min: number;
  spec_draft_p_split: number;
  spec_draft_ngl: string;
  spec_draft_device: string;
  spec_draft_model: string;
  reasoning: string;
  reasoning_format: string;
  reasoning_effort: string;
  reasoning_budget: number;
  reasoning_budget_message: string;
  reasoning_preserve: string;
  server_args: string[];
  chat_options: JsonObject;
  mmproj: string;
  active_model: string;
  active_backend: string;
  active_build: string;
  iters: number;
  parallel: number;
  request_timeout_seconds: number;
  sleep_idle_seconds: number;
  lora_adapters: LoraAdapterConfig[];
}

export interface LoraAdapterConfig {
  path: string;
  scale: number;
  enabled: boolean;
}

export interface GgufModel {
  name: string;
  path: string;
  size_mb: number;
  is_vision: boolean;
}

export interface ModelScanResult {
  models: GgufModel[];
  truncated: boolean;
}

export interface HfModel {
  id: string;
  author: string;
  downloads: number;
  likes: number;
  last_modified: string;
  pipeline_tag?: string;
  tags: string[];
  gated: boolean;
}

export interface HfFile {
  path: string;
  size_bytes: number;
  oid?: string;
  is_mmproj: boolean;
  download_url: string;
}

export interface DownloadedModel {
  repo_id: string;
  file_path: string;
  path: string;
  size_bytes: number;
}

export interface McpServer {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
}

export interface McpTool {
  name: string;
  description?: string;
  input_schema: unknown;
}

export interface ModelDownloadProgress {
  repo_id: string;
  file_path: string;
  phase: "starting" | "downloading" | "cancelled" | "complete";
  received: number;
  total: number;
}

export interface LocalModelInfo {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

export interface InstalledRuntime {
  build: string;
  backend: string;
  dir: string;
  size_mb: number;
}

export interface LatestInfo {
  build: string;
  file_name: string;
  url: string;
  digest?: string;
}

export interface RuntimeCapabilities {
  backend: string;
  build: string;
  executable: string;
  state: "available" | "failed preflight" | "not installed" | "unsupported by this runtime build" | "unknown";
  version: string;
  flags: string[];
  devices: string[];
  diagnostics: string[];
  bench_available?: boolean;
}

export interface BenchRow {
  test: string;
  size: string;
  batch: string;
  tps: number;
}

export interface BenchResult {
  rows: BenchRow[];
  args: string[];
}

export type ServerState = "stopped" | "starting" | "running" | "stopping" | "failed" | "crashed";

export interface ServerStatus {
  state: ServerState;
  url?: string;
  model?: string;
  api_key?: string;
  mmproj?: string;
  pid?: number;
  log_tail?: string;
  error?: string;
  active_requests?: number;
  idle_seconds?: number;
  memory?: MemoryEstimate;
  lifecycle?: LifecycleDiagnostics;
}

export interface MemoryEstimate {
  model_mb: number;
  context_mb: number;
  kv_mb: number;
  projector_mb: number;
  adapters_mb: number;
  total_mb: number;
  available_mb?: number;
  source: "metadata" | "filesystem" | "unknown";
}

export interface LifecycleDiagnostics {
  idle_seconds?: number;
  sleep_idle_seconds: number;
  request_timeout_seconds: number;
  parallel: number;
  active_requests?: number;
  auto_unload_due?: boolean;
  effective_model?: string;
  effective_backend?: string;
  last_ready_at?: string;
}

export interface DownloadProgress {
  backend: string;
  build: string;
  phase: string;
  received: number;
  total: number;
}

export const getConfig = () => invoke<AppConfig>("get_config");
export const saveConfig = (cfg: AppConfig) => invoke<AppConfig>("save_config", { cfg });

export const listModels = (modelsDir: string) => invoke<ModelScanResult>("list_models", { modelsDir });
export const deleteModel = (path: string) => invoke<void>("delete_model", { path });
export const pickModelsDir = () => invoke<string | null>("pick_models_dir");
export const pickLoraAdapter = () => invoke<string | null>("pick_lora_adapter");
export const hfSearchModels = (query: string, limit = 20) => invoke<HfModel[]>("hf_search_models", { query, limit });
export const hfModelFiles = (repoId: string) => invoke<HfFile[]>("hf_model_files", { repoId });
export const hfDownloadModel = (repoId: string, filePath: string, modelsDir: string) =>
  invoke<DownloadedModel>("hf_download_model", { repoId, filePath, modelsDir });
export const hfCancelDownload = () => invoke<void>("hf_cancel_download");
export const pickImage = () => invoke<string | null>("pick_image");
export const readImageData = (path: string) => invoke<string>("read_image_data", { path });
export const pickDocument = () => invoke<string | null>("pick_document");
export const readDocumentText = (path: string) => invoke<string>("read_document_text", { path });
export const readDocumentBinding = (path: string) => invoke<string>("read_document_binding", { path });

export const mcpListServers = () => invoke<McpServer[]>("mcp_list_servers");
export const mcpSaveServer = (server: McpServer) => invoke<McpServer[]>("mcp_save_server", { server });
export const mcpRemoveServer = (id: string) => invoke<McpServer[]>("mcp_remove_server", { id });
export const mcpListTools = (id: string) => invoke<McpTool[]>("mcp_list_tools", { id });
export const mcpCallTool = (id: string, name: string, argumentsValue: Record<string, unknown>) =>
  invoke<unknown>("mcp_call_tool", { id, name, arguments: argumentsValue });

export async function localModels(baseUrl: string, apiKey: string): Promise<LocalModelInfo[]> {
  if (!baseUrl || !apiKey) throw new Error("The local server is not ready.");
  const url = baseUrl.replace(/\/v1\/?$/, "") + "/v1/models";
  const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  const body = await readBoundedResponseText(response);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 500)}`);
  const parsed = JSON.parse(body) as { data?: LocalModelInfo[] };
  return Array.isArray(parsed.data) ? parsed.data : [];
}

export async function nativeModels(baseUrl: string, apiKey: string): Promise<LocalModelInfo[]> {
  if (!baseUrl || !apiKey) throw new Error("The local server is not ready.");
  const response = await fetch(`${baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/api/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const body = await readBoundedResponseText(response);
  if (!response.ok) throw new Error(`Native API HTTP ${response.status}: ${body.slice(0, 500)}`);
  const parsed = JSON.parse(body) as { data?: LocalModelInfo[]; models?: LocalModelInfo[] };
  return Array.isArray(parsed.data) ? parsed.data : Array.isArray(parsed.models) ? parsed.models : [];
}

export async function embedText(
  baseUrl: string,
  apiKey: string,
  model: string,
  input: string[],
  signal?: AbortSignal,
): Promise<number[][]> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input }),
    signal,
  });
  if (!response.ok) throw new Error(`Embedding endpoint HTTP ${response.status}: ${(await readBoundedResponseText(response)).slice(0, 300)}`);
  const payload = await response.json() as { data?: Array<{ embedding?: unknown }> };
  const vectors = (payload.data ?? []).map((entry) => entry.embedding);
  if (vectors.length !== input.length || vectors.some((vector) => !Array.isArray(vector) || vector.some((value) => typeof value !== "number" || !Number.isFinite(value)))) {
    throw new Error("Embedding endpoint returned an invalid vector payload.");
  }
  return vectors as number[][];
}

export const startServer = (cfg: AppConfig) => invoke<string>("start_server", { cfg });
export const stopServer = () => invoke<void>("stop_server");
export const unloadModel = () => invoke<void>("unload_model");
export const serverActivity = (phase: "start" | "end" | "touch") => invoke<void>("server_activity", { phase });
export const serverStatus = () => invoke<ServerStatus>("server_status");
export const startAnthropicGateway = () => invoke<string>("start_anthropic_gateway");
export const stopAnthropicGateway = () => invoke<void>("stop_anthropic_gateway");
export const anthropicGatewayStatus = () => invoke<{ running: boolean; url?: string }>("anthropic_gateway_status");

export interface ServerLoraAdapter {
  id: number;
  path: string;
  scale: number;
}

export async function readBoundedResponseText(response: Response, maxChars = 1 * 1024 * 1024): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = decoder.decode(value, { stream: true });
      if (text.length + part.length > maxChars) throw new Error("The response body exceeds the configured size limit.");
      text += part;
    }
    const tail = decoder.decode();
    if (text.length + tail.length > maxChars) throw new Error("The response body exceeds the configured size limit.");
    return text + tail;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed by the transport.
    }
  }
}

export async function listServerLoraAdapters(baseUrl: string, apiKey: string): Promise<ServerLoraAdapter[]> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "").replace(/\/v1$/, "")}/lora-adapters`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const body = await readBoundedResponseText(response);
  if (!response.ok) throw new Error(`LoRA endpoint HTTP ${response.status}: ${body.slice(0, 500)}`);
  const parsed = JSON.parse(body) as unknown;
  if (!Array.isArray(parsed)) throw new Error("LoRA endpoint returned an invalid adapter list.");
  return parsed.filter((value): value is ServerLoraAdapter => {
    if (!value || typeof value !== "object") return false;
    const item = value as Record<string, unknown>;
    return typeof item.id === "number" && typeof item.path === "string" && typeof item.scale === "number";
  });
}

export async function setServerLoraAdapters(baseUrl: string, apiKey: string, adapters: Array<{ id: number; scale: number }>): Promise<void> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "").replace(/\/v1$/, "")}/lora-adapters`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(adapters),
  });
  const body = await readBoundedResponseText(response);
  if (!response.ok) throw new Error(`LoRA apply HTTP ${response.status}: ${body.slice(0, 500)}`);
}

export const runBench = (cfg: AppConfig) => invoke<BenchResult>("run_bench", { cfg });
export const benchCancel = () => invoke<void>("bench_cancel");

export const rtList = () => invoke<InstalledRuntime[]>("rt_list");
export const rtLatest = (backend: string, refresh = false) => invoke<LatestInfo>("rt_latest", { backend, refresh });
export const rtInstall = (backend: string, build: string) =>
  invoke<InstalledRuntime>("rt_install", { backend, build });
export const rtCancel = () => invoke<void>("rt_cancel");
export const rtUninstall = (backend: string, build: string) =>
  invoke<void>("rt_uninstall", { backend, build });
export const rtSelect = (backend: string, build: string) =>
  invoke<AppConfig>("rt_select", { backend, build });
export const rtProbe = (backend = "", build = "") => invoke<RuntimeCapabilities>("rt_probe", { backend, build });

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[];
  tool_call_id?: string;
  name?: string;
  tool_calls?: ChatToolCall[];
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatTextPart {
  type: "text";
  text: string;
}

export interface ChatImagePart {
  type: "image_url";
  image_url: { url: string };
}

export type ChatContentPart = ChatTextPart | ChatImagePart;

export type ChatDelta = StreamDelta;

export interface ChatSampling {
  temperature: number;
  top_p: number;
  top_k: number;
  reasoning?: string;
  reasoning_effort?: string;
  options?: JsonObject;
  tools?: ChatToolDefinition[];
}

export interface ChatToolDefinition {
  type: "function";
  function: { name: string; description?: string; parameters: unknown };
}

export interface ChatRequestBody {
  model: string;
  messages: ChatMessage[];
  stream: true;
  [key: string]: unknown;
}

function asJsonObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

export function buildChatRequestBody(
  model: string,
  messages: ChatMessage[],
  sampling: ChatSampling,
): ChatRequestBody {
  const body: ChatRequestBody = {
    ...(sampling.options ?? {}),
    model,
    messages,
    stream: true,
    temperature: sampling.temperature,
    top_p: sampling.top_p,
    top_k: sampling.top_k,
      tools: sampling.tools?.length ? sampling.tools : undefined,
    };
  const reasoningEffort = sampling.reasoning === "off" ? "none" : sampling.reasoning_effort;
  if (reasoningEffort && reasoningEffort !== "default") {
    body.reasoning_effort = reasoningEffort;
    const chatTemplateKwargs = {
      ...(asJsonObject(sampling.options?.chat_template_kwargs) ?? {}),
    };
    if (reasoningEffort === "none") {
      chatTemplateKwargs.enable_thinking = false;
      delete chatTemplateKwargs.reasoning_effort;
    } else {
      chatTemplateKwargs.enable_thinking = true;
      chatTemplateKwargs.reasoning_effort = reasoningEffort;
    }
    body.chat_template_kwargs = chatTemplateKwargs;
  }
  return body;
}

export async function consumeChatStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: ChatDelta) => void,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser(onDelta);
  let doneFrame = false;
  try {
    while (!doneFrame) {
      const { done, value } = await reader.read();
      if (done) break;
      doneFrame = parser.push(decoder.decode(value, { stream: true }));
    }
    if (!doneFrame) {
      parser.push(decoder.decode());
      parser.finish();
      if (!parser.isFinished()) {
        throw new Error("The server ended the response before completing the stream.");
      }
    }
    return parser.value();
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed by the transport.
    }
  }
}

export async function chatStream(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  sampling: ChatSampling,
  onDelta: (delta: ChatDelta) => void,
  signal?: AbortSignal,
): Promise<string> {
  if (!apiKey) throw new Error("Server authentication is not ready; retry after the server becomes ready.");
  const url = baseUrl.replace(/\/v1$/, "") + "/v1/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(buildChatRequestBody(model, messages, sampling)),
    signal,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 500)}`);
  }
  if (!res.body) throw new Error("The server returned an empty response stream.");

  return consumeChatStream(res.body, onDelta);
}

export async function nativeChatStream(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  sampling: ChatSampling,
  onDelta: (delta: ChatDelta) => void,
  previousResponseId?: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!apiKey) throw new Error("Server authentication is not ready; retry after the server becomes ready.");
  const response = await fetch(nativeChatUrl(baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(buildNativeChatRequestBody(model, messages, sampling, previousResponseId)),
    signal,
  });
  if (!response.ok) {
    const body = await readBoundedResponseText(response);
    throw new Error(`Native API HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
  if (!response.body) throw new Error("The native API returned an empty response stream.");
  return consumeNativeChatStream(response.body, (delta) => {
    onDelta({ reasoning: delta.reasoning, content: delta.text, usage: delta.usage });
  });
}

export async function anthropicMessagesStream(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  sampling: ChatSampling,
  onDelta: (delta: ChatDelta) => void,
  tools: AnthropicTool[] = [],
  signal?: AbortSignal,
): Promise<string> {
  if (!apiKey) throw new Error("Server authentication is not ready; retry after the server becomes ready.");
  const response = await fetch(anthropicMessagesUrl(baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(buildAnthropicMessagesRequestBody(model, messages, sampling, tools)),
    signal,
  });
  if (!response.ok) {
    const body = await readBoundedResponseText(response);
    throw new Error(`Anthropic-compatible API HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
  if (!response.body) throw new Error("The Anthropic-compatible API returned an empty response stream.");
  return consumeAnthropicStream(response.body, (delta) => {
    onDelta({ reasoning: delta.thinking, content: delta.text, usage: delta.usage });
  });
}

export function onRuntimeProgress(
  cb: (progress: DownloadProgress) => void,
): Promise<UnlistenFn> {
  return listen<DownloadProgress>("runtime-download-progress", (event) => cb(event.payload));
}

export function onModelDownloadProgress(
  cb: (progress: ModelDownloadProgress) => void,
): Promise<UnlistenFn> {
  return listen<ModelDownloadProgress>("model-download-progress", (event) => cb(event.payload));
}
