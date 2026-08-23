import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { streamChat, waitForEndpoint } from "./lib/api-client";
import type { ChatMessage, Provider, StreamEvent } from "./types/chat";
import type { BackendInfo, CommandPreview, EnvironmentSnapshot, HelpOption, LaunchResult, Profile, ReleaseInfo } from "./types";
import "./App.css";

const PROFILE_KEY = "llama-board.profile.v2";
const CHAT_KEY = "llama-board.chat.v1";
const REPO_KEY = "llama-board.github-repo";
const DEFAULT_REPO = "joowon-jang/llama-board";
const CURRENT_VERSION = "0.1.3";

const initialProfile: Profile = {
  name: "Qwen3.8 27B · MTP medium",
  mode: "server",
  provider: "openai",
  anthropic_api_key: "",
  anthropic_version: "2023-06-01",
  max_tokens: 32768,
  executable: "llama-server.exe",
  model_path: "",
  mmproj_path: "",
  backend: "auto",
  device: "",
  gpu_layers: "all",
  context_size: 65536,
  batch_size: 2048,
  ubatch_size: 256,
  cache_type_k: "q4_0",
  cache_type_v: "q4_0",
  flash_attn: "auto",
  kv_unified: true,
  temperature: 1,
  top_p: 0.95,
  top_k: 20,
  min_p: 0,
  presence_penalty: 0,
  repeat_penalty: 1,
  reasoning: true,
  reasoning_effort: "medium",
  reasoning_preserve: false,
  spec_type: "draft-mtp",
  spec_draft_n_max: 4,
  spec_draft_n_min: 0,
  host: "127.0.0.1",
  port: 8080,
  parallel: 1,
  ui: true,
  extra_args: "",
  env_overrides: [],
};

type Tab = "chat" | "runtime" | "builder" | "updates";
type PreviewTab = "powershell" | "cmd" | "posix";

type RuntimeState = "stopped" | "starting" | "ready" | "stopping" | "error";

function loadJson<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

function loadProfile(): Profile {
  return { ...initialProfile, ...loadJson<Partial<Profile>>(PROFILE_KEY, {}) };
}

function newMessage(role: ChatMessage["role"], content: string): ChatMessage {
  return { id: `${Date.now()}-${Math.random()}`, role, content, createdAt: Date.now() };
}

function App() {
  const [profile, setProfile] = useState<Profile>(loadProfile);
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadJson(CHAT_KEY, []));
  const [tab, setTab] = useState<Tab>("chat");
  const [input, setInput] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("You are a helpful local assistant. Be accurate, concise, and transparent about uncertainty.");
  const [streaming, setStreaming] = useState(false);
  const [runtimeState, setRuntimeState] = useState<RuntimeState>("stopped");
  const [pid, setPid] = useState<number | null>(null);
  const [modelId, setModelId] = useState("not connected");
  const [status, setStatus] = useState("Ready");
  const [logs, setLogs] = useState<string[]>([]);
  const [environment, setEnvironment] = useState<EnvironmentSnapshot | null>(null);
  const [helpOptions, setHelpOptions] = useState<HelpOption[]>([]);
  const [helpSearch, setHelpSearch] = useState("");
  const [preview, setPreview] = useState<CommandPreview | null>(null);
  const [previewTab, setPreviewTab] = useState<PreviewTab>("powershell");
  const [release, setRelease] = useState<ReleaseInfo | null>(null);
  const [repo, setRepo] = useState(() => localStorage.getItem(REPO_KEY) || DEFAULT_REPO);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updateError, setUpdateError] = useState("");
  const [showUpdatePrompt, setShowUpdatePrompt] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const openaiBase = `http://${profile.host}:${profile.port}/v1`;
  const anthropicBase = "http://127.0.0.1:8081";
  const activeEndpoint = profile.provider === "anthropic" ? `${anthropicBase}/v1/messages` : `${openaiBase}/chat/completions`;

  const patch = <K extends keyof Profile>(key: K, value: Profile[K]) => {
    setProfile((current) => ({ ...current, [key]: value }));
  };

  useEffect(() => {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    void invoke<CommandPreview>("build_command", { profile }).then(setPreview).catch(() => setPreview(null));
    void invoke("configure_anthropic_gateway", { targetUrl: `http://${profile.host}:${profile.port}`, apiKey: profile.anthropic_api_key });
  }, [profile]);

  useEffect(() => {
    localStorage.setItem(CHAT_KEY, JSON.stringify(messages));
  }, [messages]);

  useEffect(() => {
    void scanRuntime();
    const logListener = listen<{ stream: string; line: string }>("runtime-log", (event) => {
      setLogs((current) => [...current.slice(-599), `[${event.payload.stream}] ${event.payload.line}`]);
    });
    const exitListener = listen<{ pid: number; status?: number }>("runtime-exit", (event) => {
      setPid((current) => (current === event.payload.pid ? null : current));
      setRuntimeState("stopped");
      setModelId("not connected");
      setStatus(`llama.cpp exited${event.payload.status == null ? "" : ` with code ${event.payload.status}`}`);
    });
    return () => {
      void logListener.then((stop) => stop());
      void exitListener.then((stop) => stop());
    };
  }, [profile.executable]);

  useEffect(() => {
    if (repo && !repo.startsWith("owner/")) void checkUpdates(true);
    // Startup update checks are intentionally non-blocking.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function scanRuntime() {
    try {
      const detected = await invoke<EnvironmentSnapshot>("detect_environment", { executable: profile.executable });
      setEnvironment(detected);
      const help = await invoke<HelpOption[]>("get_help_options", { executable: profile.executable });
      setHelpOptions(help);
      setStatus(detected.version ? `Runtime detected · ${detected.version.split("\n")[0]}` : "Runtime not detected");
    } catch (error) {
      setStatus(String(error));
    }
  }

  async function startRuntime() {
    if (!profile.model_path.trim()) {
      setStatus("Choose a GGUF model before starting llama.cpp.");
      setTab("runtime");
      return;
    }
    setRuntimeState("starting");
    setStatus("Running backend preflight and starting llama.cpp…");
    setLogs([]);
    try {
      const result = await invoke<LaunchResult>("launch_runtime", { profile });
      setPid(result.pid);
      const model = await waitForEndpoint(openaiBase, 30_000);
      setModelId(model);
      setRuntimeState("ready");
      setStatus(`Ready · PID ${result.pid} · ${model}`);
    } catch (error) {
      setRuntimeState("error");
      setStatus(`Start failed: ${String(error)}`);
    }
  }

  async function stopRuntime() {
    if (!pid) return;
    setRuntimeState("stopping");
    setStatus("Stopping llama.cpp process tree…");
    try {
      await invoke("stop_runtime", { pid });
      setPid(null);
      setModelId("not connected");
      setRuntimeState("stopped");
      setStatus("Runtime stopped");
    } catch (error) {
      setRuntimeState("error");
      setStatus(String(error));
    }
  }

  function appendAssistant(event: StreamEvent) {
    setMessages((current) => {
      const last = current[current.length - 1];
      if (!last || last.role !== "assistant") return current;
      const updated = { ...last };
      if (event.type === "text") updated.content += event.text || "";
      if (event.type === "reasoning") updated.reasoning = `${updated.reasoning || ""}${event.text || ""}`;
      if (event.type === "tool") updated.toolCalls = [...(updated.toolCalls || []), event.tool || {}];
      return [...current.slice(0, -1), updated];
    });
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || streaming) return;
    if (runtimeState !== "ready") {
      setStatus("Start llama.cpp and wait for endpoint readiness before chatting.");
      return;
    }
    setInput("");
    const user = newMessage("user", text);
    const assistant = newMessage("assistant", "");
    const history = [...messages, user];
    setMessages([...history, assistant]);
    setStreaming(true);
    abortRef.current = new AbortController();
    try {
      await streamChat({
        provider: profile.provider as Provider,
        baseUrl: profile.provider === "anthropic" ? anthropicBase : openaiBase,
        apiKey: profile.provider === "anthropic" ? profile.anthropic_api_key : undefined,
        anthropicVersion: profile.anthropic_version,
        model: modelId === "not connected" ? "local-model" : modelId,
        system: systemPrompt,
        messages: history.filter((item) => item.role === "user" || item.role === "assistant").map((item) => ({ role: item.role === "assistant" ? "assistant" as const : "user" as const, content: item.content })),
        maxTokens: profile.max_tokens,
        temperature: profile.temperature,
        topP: profile.top_p,
        signal: abortRef.current.signal,
      }, appendAssistant);
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        setStatus(`Chat error: ${String(error)}`);
        setMessages((current) => current.map((item, index) => index === current.length - 1 ? { ...item, content: `Error: ${String(error)}` } : item));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function stopGeneration() {
    abortRef.current?.abort();
    setStreaming(false);
    setStatus("Generation cancelled");
  }

  async function checkUpdates(silent = false) {
    if (!repo.includes("/") || repo.startsWith("owner/")) {
      if (!silent) setUpdateError("Set a real public GitHub owner/repository first.");
      return;
    }
    setCheckingUpdates(true);
    setUpdateError("");
    localStorage.setItem(REPO_KEY, repo);
    try {
      const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } });
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
      const latest = (await response.json()) as ReleaseInfo;
      setRelease(latest);
      if (latest.tag_name !== `v${CURRENT_VERSION}`) setShowUpdatePrompt(true);
      setStatus("Latest GitHub release checked");
    } catch (error) {
      setUpdateError(String(error));
    } finally {
      setCheckingUpdates(false);
    }
  }

  async function openExternal(url: string) {
    try { await openUrl(url); } catch { window.open(url, "_blank", "noopener,noreferrer"); }
  }

  const filteredHelp = useMemo(() => {
    const q = helpSearch.toLowerCase();
    return helpOptions.filter((item) => `${item.flag} ${item.description}`.toLowerCase().includes(q)).slice(0, 100);
  }, [helpOptions, helpSearch]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark">λ</div><div><strong>Llama Board</strong><span>runtime · endpoint · chat</span></div></div>
        <div className="sidebar-label">Workspace</div>
        <button className={`nav-item ${tab === "chat" ? "active" : ""}`} onClick={() => setTab("chat")}><span>◉</span> Chat</button>
        <button className={`nav-item ${tab === "runtime" ? "active" : ""}`} onClick={() => setTab("runtime")}><span>◈</span> Runtime & devices</button>
        <button className={`nav-item ${tab === "builder" ? "active" : ""}`} onClick={() => setTab("builder")}><span>⌘</span> Command builder</button>
        <button className={`nav-item ${tab === "updates" ? "active" : ""}`} onClick={() => setTab("updates")}><span>↻</span> Updates</button>
        <div className="sidebar-spacer" />
        <div className="status-card"><div className="status-dot" data-running={runtimeState === "ready"} /><div><strong>{runtimeState === "ready" ? "Runtime ready" : runtimeState === "starting" ? "Starting…" : "Runtime stopped"}</strong><span>{status}</span></div></div>
        <div className="version">Llama Board 0.1.3 · Windows first</div>
      </aside>

      <main className="main-panel">
        <header className="topbar"><div><div className="eyebrow">{tab === "chat" ? "LOCAL MODEL CHAT" : tab === "runtime" ? "RUNTIME MATRIX" : tab === "builder" ? "SECONDARY UTILITY" : "DISTRIBUTION"}</div><h1>{tab === "chat" ? "Chat with your local model" : tab === "runtime" ? "Runtime & backend health" : tab === "builder" ? "Generate a portable command" : "Updates & releases"}</h1></div><div className="top-actions"><span className={`runtime-pill ${runtimeState}`}><i />{runtimeState === "ready" ? `ready · ${modelId}` : runtimeState}</span>{runtimeState === "ready" ? <button className="ghost-button" onClick={stopRuntime}>Stop runtime</button> : <button className="primary-button" onClick={startRuntime}>Start llama.cpp</button>}</div></header>

        {tab === "chat" && <div className="chat-layout"><section className="conversation-panel"><div className="conversation-head"><div><span className="section-kicker">CONVERSATION</span><h2>Local session</h2></div><button className="icon-button" title="New conversation" onClick={() => setMessages([])}>＋</button></div><div className="conversation-card active"><span className="conversation-dot" /><div><strong>{profile.name}</strong><small>{messages.filter((item) => item.role === "user").length} prompts · {profile.provider === "anthropic" ? "Anthropic" : "OpenAI"}</small></div></div><div className="conversation-info"><span>Endpoint</span><code>{activeEndpoint}</code><span>Model</span><code>{modelId}</code><span>Backend</span><code>{profile.backend === "auto" ? "auto" : profile.backend}</code></div></section><section className="chat-panel"><div className="chat-toolbar"><div><span className="section-kicker">{profile.provider === "anthropic" ? "ANTHROPIC MESSAGES" : "OPENAI COMPATIBLE"}</span><h2>{runtimeState === "ready" ? "Ready for your prompt" : "Start a runtime to begin"}</h2></div><div className="provider-switch"><button className={profile.provider === "openai" ? "selected" : ""} onClick={() => patch("provider", "openai")}>OpenAI</button><button className={profile.provider === "anthropic" ? "selected" : ""} onClick={() => patch("provider", "anthropic")}>Anthropic</button></div></div><div className="message-scroll">{messages.length === 0 && <div className="welcome"><div className="welcome-mark">λ</div><h2>Run local. Think private.</h2><p>Start llama.cpp above, then chat through its OpenAI-compatible endpoint or the local Anthropic Messages gateway.</p><div className="welcome-grid"><button onClick={() => setTab("runtime")}><strong>1 · Select runtime</strong><span>CPU, Vulkan, CUDA, ROCm, SYCL</span></button><button onClick={() => setTab("builder")}><strong>2 · Tune profile</strong><span>Context, MTP, reasoning, sampling</span></button><button onClick={() => setTab("updates")}><strong>3 · Stay current</strong><span>GitHub app and runtime releases</span></button></div></div>}{messages.map((message) => <article className={`message ${message.role}`} key={message.id}><div className="message-avatar">{message.role === "user" ? "U" : message.role === "assistant" ? "λ" : "S"}</div><div className="message-body"><div className="message-role">{message.role}</div>{message.reasoning && <details className="reasoning" open><summary>Reasoning trace</summary><div>{message.reasoning}</div></details>}<div className="message-content">{message.content || (streaming && message.role === "assistant" ? <span className="typing">Generating<span>.</span><span>.</span><span>.</span></span> : "")}</div>{message.toolCalls?.map((tool, index) => <pre className="tool-call" key={`${tool.id}-${index}`}>{tool.name || "tool"}{tool.input || ""}</pre>)}</div></article>)}</div><div className="composer-wrap"><div className="composer-meta"><span>system prompt enabled</span><button className="text-button" onClick={() => setSystemPrompt(systemPrompt ? "" : "You are a helpful local assistant.")}>{systemPrompt ? "Hide system prompt" : "Add system prompt"}</button></div><textarea value={input} disabled={runtimeState !== "ready" || streaming} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void sendMessage(); }} placeholder={runtimeState === "ready" ? "Message your local model…  Ctrl+Enter to send" : "Start llama.cpp to enable chat"} rows={3} /><div className="composer-actions"><span>{profile.provider === "anthropic" ? "POST /v1/messages · x-api-key · 2023-06-01" : "POST /v1/chat/completions · SSE"}</span>{streaming ? <button className="stop-button" onClick={stopGeneration}>Stop generating</button> : <button className="primary-button" disabled={runtimeState !== "ready" || !input.trim()} onClick={() => void sendMessage()}>Send prompt ↗</button>}</div></div></section><aside className="chat-settings"><div className="settings-card"><span className="section-kicker">SESSION SETTINGS</span><h3>Endpoint adapter</h3><label>Provider<select value={profile.provider} onChange={(event) => patch("provider", event.target.value as Profile["provider"])}><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic Messages</option></select></label>{profile.provider === "anthropic" && <><label>Anthropic API key<input type="password" value={profile.anthropic_api_key} onChange={(event) => patch("anthropic_api_key", event.target.value)} placeholder="optional local gateway key" /></label><label>Anthropic version<input value={profile.anthropic_version} onChange={(event) => patch("anthropic_version", event.target.value)} /></label><div className="endpoint-box"><code>http://127.0.0.1:8081/v1/messages</code><small>Local compatibility gateway</small></div></>}{profile.provider === "openai" && <div className="endpoint-box"><code>{openaiBase}/chat/completions</code><small>llama.cpp native endpoint</small></div>}<label>System prompt<textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} rows={5} /></label></div><div className="settings-card compact"><span className="section-kicker">GENERATION</span><div className="stat-line"><span>Temperature</span><strong>{profile.temperature}</strong></div><div className="stat-line"><span>Reasoning</span><strong>{profile.reasoning ? profile.reasoning_effort : "off"}</strong></div><div className="stat-line"><span>Max output</span><strong>{profile.max_tokens.toLocaleString()}</strong></div><div className="stat-line"><span>Speculative</span><strong>{profile.spec_type} · {profile.spec_draft_n_max}</strong></div></div></aside></div>}

        {tab === "runtime" && <div className="runtime-page"><div className="runtime-toolbar"><div><span className="section-kicker">BACKEND DISCOVERY</span><h2>Runtime & device matrix</h2><p>{environment?.version || "Scan the selected llama.cpp runtime to enumerate devices and backend capabilities."}</p></div><div className="toolbar-actions"><button className="ghost-button" onClick={scanRuntime}>Scan runtime</button>{runtimeState === "ready" ? <button className="primary-button" onClick={stopRuntime}>Stop</button> : <button className="primary-button" onClick={startRuntime}>Start llama.cpp</button>}</div></div><div className="runtime-config card"><div className="two-col"><label>Runtime executable<input value={profile.executable} onChange={(event) => patch("executable", event.target.value)} placeholder="llama-server.exe" /></label><label>GGUF model<input value={profile.model_path} onChange={(event) => patch("model_path", event.target.value)} placeholder="C:\\models\\model.gguf" /></label></div></div><div className="backend-grid">{(environment?.backends || [{ id: "cpu", label: "CPU", available: false, status: "not scanned", devices: [] }]).map((backend: BackendInfo) => <button key={backend.id} className={`backend-card ${backend.available ? "available" : ""} ${profile.backend === backend.id ? "chosen" : ""}`} onClick={() => patch("backend", backend.id)}><div className="backend-icon">{backend.id === "cpu" ? "▦" : backend.id === "vulkan" ? "◇" : backend.id === "cuda" ? "✦" : backend.id === "hip-rocm" ? "◈" : "◎"}</div><div><strong>{backend.label}</strong><span>{backend.status}</span>{backend.devices.map((device) => <small key={device}>{device}</small>)}</div><em>{profile.backend === backend.id ? "selected" : backend.available ? "ready" : "—"}</em></button>)}</div><div className="runtime-two-col"><div className="card log-card"><div className="card-title"><h3>Runtime facts</h3><span className="badge">{environment?.help_available ? `${helpOptions.length} flags` : "not scanned"}</span></div><dl><dt>Executable</dt><dd>{environment?.runtime_path || profile.executable}</dd><dt>Version</dt><dd>{environment?.version || "—"}</dd><dt>Devices</dt><dd>{environment?.devices.length || 0}</dd><dt>Endpoint</dt><dd>{openaiBase}</dd><dt>Anthropic</dt><dd>http://127.0.0.1:8081/v1/messages</dd></dl>{environment?.notes.map((note) => <p className="note" key={note}>{note}</p>)}</div><div className="card log-card"><div className="card-title"><h3>Live runtime logs</h3><button className="text-button" onClick={() => setLogs([])}>Clear</button></div><div className="log-console">{logs.length ? logs.map((line, index) => <div key={`${line}-${index}`}>{line}</div>) : <span>No runtime output yet.</span>}</div></div></div></div>}

        {tab === "builder" && <div className="builder-page"><div className="runtime-toolbar"><div><span className="section-kicker">SECONDARY UTILITY</span><h2>Portable command builder</h2><p>This preview uses the exact profile passed to the launcher. The app itself starts llama.cpp directly.</p></div><button className="ghost-button" onClick={() => navigator.clipboard?.writeText(preview?.[previewTab] || "")}>Copy command</button></div><div className="builder-grid"><div className="card form-card"><label>Model path<input value={profile.model_path} onChange={(event) => patch("model_path", event.target.value)} placeholder="C:\\models\\model.gguf" /></label><div className="two-col"><label>Speculative type<select value={profile.spec_type} onChange={(event) => patch("spec_type", event.target.value)}><option value="draft-mtp">draft-mtp</option><option value="ngram-mod">ngram-mod</option><option value="none">none</option></select></label><label>Draft n-max<input type="number" value={profile.spec_draft_n_max} onChange={(event) => patch("spec_draft_n_max", Number(event.target.value))} /></label></div><div className="two-col"><label>Reasoning effort<select value={profile.reasoning_effort} onChange={(event) => patch("reasoning_effort", event.target.value)}><option>medium</option><option>low</option><option>high</option><option>xhigh</option><option>default</option></select></label><label>Backend<select value={profile.backend} onChange={(event) => patch("backend", event.target.value)}><option>auto</option><option>cpu</option><option>vulkan</option><option>cuda</option><option>hip-rocm</option><option>sycl</option></select></label></div><label>Advanced arguments<textarea rows={6} value={profile.extra_args} onChange={(event) => patch("extra_args", event.target.value)} placeholder="--fit on --no-context-shift" /></label><div className="search-row"><input value={helpSearch} onChange={(event) => setHelpSearch(event.target.value)} placeholder="Search installed llama.cpp flags…" /><span>{filteredHelp.length} shown</span></div><div className="flag-list">{filteredHelp.map((option) => <div className="flag-row" key={option.flag}><code>{option.flag}</code><span>{option.description || option.section}</span></div>)}</div></div><div className="preview-sticky card command-card"><div className="terminal-tabs"><button className={previewTab === "powershell" ? "selected" : ""} onClick={() => setPreviewTab("powershell")}>PowerShell</button><button className={previewTab === "cmd" ? "selected" : ""} onClick={() => setPreviewTab("cmd")}>CMD</button><button className={previewTab === "posix" ? "selected" : ""} onClick={() => setPreviewTab("posix")}>POSIX</button></div><pre>{preview?.[previewTab] || "Choose a model to generate the command."}</pre><div className="command-note">Execution path: direct `Command` argument vector · endpoint: {activeEndpoint}</div></div></div></div>}

        {tab === "updates" && <div className="updates-page"><div className="runtime-toolbar"><div><span className="section-kicker">GITHUB DISTRIBUTION</span><h2>Updates & releases</h2><p>App and backend runtime updates are checked separately and never installed silently.</p></div><button className="primary-button" onClick={() => void checkUpdates()} disabled={checkingUpdates}>{checkingUpdates ? "Checking…" : "Check for updates"}</button></div><div className="card update-settings"><label>GitHub repository<input value={repo} onChange={(event) => setRepo(event.target.value)} placeholder="joowon-jang/llama-board" /></label>{updateError && <div className="error-banner">{updateError}</div>}<p className="note">PowerShell bootstrap: <code>irm https://raw.githubusercontent.com/joowon-jang/llama-board/main/install.ps1 | iex</code></p></div>{release ? <div className="release-card"><div className="release-icon">↻</div><div className="release-content"><span className="section-kicker">LATEST RELEASE · {release.tag_name}</span><h2>{release.name || release.tag_name}</h2><p>{release.body?.slice(0, 480) || "No release notes provided."}</p>{release.assets.map((asset) => <button className="asset-row" key={asset.name} onClick={() => void openExternal(asset.browser_download_url)}><span>{asset.name}</span><small>{(asset.size / 1024 / 1024).toFixed(1)} MB</small><b>Download ↗</b></button>)}</div></div> : <div className="empty-state"><div>↻</div><h2>No release checked</h2><p>Configure the public repository after GitHub publication, then check manually or on startup.</p></div>}</div>}
      </main>
      {showUpdatePrompt && release && <div className="modal-backdrop" onClick={() => setShowUpdatePrompt(false)}><div className="update-modal" onClick={(event) => event.stopPropagation()}><span className="section-kicker">UPDATE AVAILABLE</span><h2>{release.name || release.tag_name}</h2><p>A newer Llama Board release is available. Review the GitHub assets before downloading or installing.</p><div className="modal-actions"><button className="ghost-button" onClick={() => setShowUpdatePrompt(false)}>Later</button><button className="primary-button" onClick={() => { setShowUpdatePrompt(false); setTab("updates"); }}>Review update</button></div></div></div>}
    </div>
  );
}

export default App;
