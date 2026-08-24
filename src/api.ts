import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { SseParser, type StreamDelta } from "./sse.ts";

export interface AppConfig {
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
  active_model: string;
  active_backend: string;
  active_build: string;
  iters: number;
}

export interface GgufModel {
  name: string;
  path: string;
  size_mb: number;
  is_vision: boolean;
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

export interface BenchRow {
  test: string;
  size: string;
  batch: string;
  tps: number;
}

export type ServerState = "stopped" | "starting" | "running" | "stopping" | "failed" | "crashed";

export interface ServerStatus {
  state: ServerState;
  url?: string;
  api_key?: string;
  error?: string;
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

export const listModels = (modelsDir: string) => invoke<GgufModel[]>("list_models", { modelsDir });
export const pickModelsDir = () => invoke<string | null>("pick_models_dir");

export const startServer = (cfg: AppConfig) => invoke<string>("start_server", { cfg });
export const stopServer = () => invoke<void>("stop_server");
export const serverStatus = () => invoke<ServerStatus>("server_status");

export const runBench = (cfg: AppConfig) => invoke<BenchRow[]>("run_bench", { cfg });
export const benchCancel = () => invoke<void>("bench_cancel");

export const rtList = () => invoke<InstalledRuntime[]>("rt_list");
export const rtLatest = (backend: string) => invoke<LatestInfo>("rt_latest", { backend });
export const rtInstall = (backend: string, build: string) =>
  invoke<InstalledRuntime>("rt_install", { backend, build });
export const rtUninstall = (backend: string, build: string) =>
  invoke<void>("rt_uninstall", { backend, build });
export const rtSelect = (backend: string, build: string) =>
  invoke<AppConfig>("rt_select", { backend, build });

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type ChatDelta = StreamDelta;

export async function consumeChatStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: ChatDelta) => void,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser(onDelta);
  let doneFrame = false;

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
}

export async function chatStream(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  sampling: { temperature: number; top_p: number; top_k: number },
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
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      temperature: sampling.temperature,
      top_p: sampling.top_p,
      top_k: sampling.top_k,
    }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 500)}`);
  }
  if (!res.body) throw new Error("The server returned an empty response stream.");

  return consumeChatStream(res.body, onDelta);
}

export function onRuntimeProgress(
  cb: (progress: DownloadProgress) => void,
): Promise<UnlistenFn> {
  return listen<DownloadProgress>("runtime-download-progress", (event) => cb(event.payload));
}
