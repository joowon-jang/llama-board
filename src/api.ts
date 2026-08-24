import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ---------- types mirroring the Rust backend ----------
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
}
export interface BenchRow {
  test: string;
  size: string;
  batch: string;
  tps: number;
}
export interface ServerStatus {
  state: "stopped" | "running" | "failed";
  url?: string;
  error?: string;
}
export interface DownloadProgress {
  backend: string;
  build: string;
  phase: string;
  received: number;
  total: number;
}

// ---------- command wrappers ----------
export const getConfig = () => invoke<AppConfig>("get_config");
export const saveConfig = (cfg: AppConfig) => invoke("save_config", { cfg });

export const listModels = (modelsDir: string) => invoke<GgufModel[]>("list_models", { modelsDir });
export const pickModelsDir = () => invoke<string | null>("pick_models_dir");

export const startServer = (cfg: AppConfig) => invoke<string>("start_server", { cfg });
export const stopServer = () => invoke("stop_server");
export const serverStatus = () => invoke<ServerStatus>("server_status");

export const runBench = (cfg: AppConfig) => invoke<BenchRow[]>("run_bench", { cfg });
export const benchCancel = () => invoke("bench_cancel");

export const rtList = () => invoke<InstalledRuntime[]>("rt_list");
export const rtLatest = (backend: string) => invoke<LatestInfo>("rt_latest", { backend });
export const rtInstall = (backend: string, build: string) =>
  invoke<InstalledRuntime>("rt_install", { backend, build });
export const rtUninstall = (backend: string, build: string) =>
  invoke("rt_uninstall", { backend, build });
export const rtSelect = (backend: string, build: string) =>
  invoke("rt_select", { backend, build });

// ---------- streaming chat (OpenAI-compatible) ----------
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// llama-server is started with this local-only API key in server.rs.
export const SERVER_API_KEY = "board-local";

export interface ChatDelta {
  content?: string;
  reasoning?: string;
}

export async function chatStream(
  baseUrl: string,
  model: string,
  messages: ChatMessage[],
  sampling: { temperature: number; top_p: number; top_k: number },
  onDelta: (delta: ChatDelta) => void,
  signal?: AbortSignal,
): Promise<string> {
  const url = baseUrl.replace(/\/v1$/, "") + "/v1/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SERVER_API_KEY}`,
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
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (data === "[DONE]") return full;
      try {
        const json = JSON.parse(data);
        const delta = json.choices?.[0]?.delta ?? {};
        const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : "";
        const content = typeof delta.content === "string" ? delta.content : "";
        if (reasoning || content) {
          onDelta({
            reasoning: reasoning || undefined,
            content: content || undefined,
          });
        }
        if (content) {
          full += content;
        }
      } catch {
        // skip malformed frame
      }
    }
  }
  return full;
}

// ---------- runtime download progress ----------
export function onRuntimeProgress(
  cb: (p: DownloadProgress) => void,
): Promise<UnlistenFn> {
  return listen<DownloadProgress>("runtime-download-progress", (e) => cb(e.payload));
}
