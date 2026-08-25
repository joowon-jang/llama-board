import { useEffect, useMemo, useState } from "react";
import * as api from "../api";
import type { AppStore } from "../store";
import { buildCurlSnippet, endpointUrl } from "../developerUtils";

const ENDPOINTS = [
  { method: "GET", path: "/models", name: "Models", description: "List loaded and available model identifiers." },
  { method: "POST", path: "/responses", name: "Responses", description: "OpenAI Responses API for agent-style clients when supported by the runtime." },
  { method: "POST", path: "/chat/completions", name: "Chat completions", description: "Streaming and non-streaming chat with text, vision, reasoning, and tools." },
  { method: "POST", path: "/completions", name: "Completions", description: "Legacy text completion endpoint." },
  { method: "POST", path: "/embeddings", name: "Embeddings", description: "Generate vectors when the selected runtime/model supports embeddings." },
];

function copyText(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

export default function DeveloperPanel({ store, section = "api" }: { store: AppStore; section?: "api" | "gateways" | "diagnostics" }) {
  const [models, setModels] = useState<api.LocalModelInfo[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gateway, setGateway] = useState<{ running: boolean; url?: string }>({ running: false });
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const serverReady = store.status.state === "running" && !!store.status.url && !!store.status.api_key;
  const baseUrl = serverReady ? store.status.url ?? "" : "";
  const rootUrl = baseUrl.replace(/\/v1\/?$/, "") || "http://127.0.0.1:8080";

  useEffect(() => {
    void api.anthropicGatewayStatus().then(setGateway).catch(() => setGateway({ running: false }));
  }, [serverReady]);

  const toggleGateway = async () => {
    setError(null);
    try {
      if (gateway.running) {
        await api.stopAnthropicGateway();
        setGateway({ running: false });
      } else {
        const url = await api.startAnthropicGateway();
        setGateway({ running: true, url });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const refreshModels = async () => {
    if (!serverReady) return;
    setLoadingModels(true);
    setError(null);
    setNotice(null);
    try {
      const loaded = await api.localModels(baseUrl, store.status.api_key ?? "");
      setModels(loaded);
      setNotice(`/v1/models responded with ${loaded.length} model${loaded.length === 1 ? "" : "s"}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoadingModels(false);
    }
  };

  useEffect(() => {
    if (serverReady) void refreshModels();
    else setModels([]);
    // Refresh only when the server transitions between ready/offline states.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverReady, baseUrl]);

  const pythonSnippet = useMemo(() => `from openai import OpenAI\n\nclient = OpenAI(\n    base_url="${baseUrl || "http://127.0.0.1:8080/v1"}",\n    api_key="<LOCAL_API_KEY>",\n)\n\nresponse = client.chat.completions.create(\n    model="<MODEL_ID>",\n    messages=[{"role": "user", "content": "Hello"}],\n)\nprint(response.choices[0].message.content)`, [baseUrl]);
  const jsSnippet = useMemo(() => `import OpenAI from "openai";\n\nconst client = new OpenAI({\n  baseURL: "${baseUrl || "http://127.0.0.1:8080/v1"}",\n  apiKey: "<LOCAL_API_KEY>",\n  dangerouslyAllowBrowser: true,\n});`, [baseUrl]);

  const copy = async (id: string, text: string) => {
    try {
      await copyText(text);
      setCopied(id);
      window.setTimeout(() => setCopied((current) => current === id ? null : current), 1800);
    } catch (caught) {
      setError(`Copy failed: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  };

  return (
    <div className="developer-panel flex h-full min-h-0 flex-col overflow-auto p-3 sm:p-4" data-developer-section={section}>
      <div className="mb-4 flex min-w-0 flex-wrap items-end justify-between gap-3">
        <div className="min-w-0"><div className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">Developer</div><h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-100">Local API workspace</h2><p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-500">Connect OpenAI-compatible clients to the same server that powers Chat. The runtime remains local and the key is never included in snippets.</p></div>
        <span role="status" className={`rounded-full px-3 py-1.5 text-xs ${serverReady ? "bg-emerald-950 text-emerald-300" : "bg-slate-800 text-slate-500"}`}>{serverReady ? "API ready" : "Start server in Models"}</span>
      </div>

      {error && <div className="mb-3 break-words rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-200" role="alert">{error}</div>}
      {notice && <div className="mb-3 rounded-lg border border-emerald-800 bg-emerald-950/50 px-3 py-2 text-sm text-emerald-200" role="status">{notice}</div>}

      <section className="developer-section developer-section--connection grid gap-3 lg:grid-cols-[minmax(0,1.3fr)_minmax(17rem,0.7fr)]">
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-sm font-semibold text-slate-200">Connection</h3><p className="mt-1 text-xs text-slate-500">Use this base URL with OpenAI SDKs and local tools.</p></div><button type="button" onClick={() => void refreshModels()} disabled={!serverReady || loadingModels} className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-700 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">{loadingModels ? "Checking…" : "Check /v1/models"}</button></div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2"><div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3"><div className="text-[11px] uppercase tracking-wide text-slate-600">Base URL</div><div className="mt-1 break-all font-mono text-xs text-cyan-300">{baseUrl || "http://127.0.0.1:8080/v1"}</div><button type="button" onClick={() => void copy("base-url", baseUrl)} disabled={!baseUrl} className="mt-2 rounded bg-slate-800 px-2 py-1 text-[11px] text-slate-400 hover:text-white disabled:opacity-40">{copied === "base-url" ? "Copied" : "Copy URL"}</button></div><div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3"><div className="text-[11px] uppercase tracking-wide text-slate-600">Authorization</div><div className="mt-1 font-mono text-xs text-slate-300">Bearer &lt;LOCAL_API_KEY&gt;</div><div className="mt-2 text-[11px] text-slate-600">The live key is held in memory for this app session only.</div></div></div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-500"><span className="rounded bg-slate-800 px-2 py-1">state: {store.status.state}</span>{store.status.pid && <span className="rounded bg-slate-800 px-2 py-1">PID: {store.status.pid}</span>}{store.status.model && <span className="max-w-full truncate rounded bg-slate-800 px-2 py-1" title={store.status.model}>effective: {store.status.model.split(/[\\/\\]/).pop()}</span>}<span className="rounded bg-slate-800 px-2 py-1">auth: local bearer</span></div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4"><h3 className="text-sm font-semibold text-slate-200">Loaded models</h3><p className="mt-1 text-xs text-slate-500">Read back from the live `/v1/models` endpoint.</p>{!serverReady && <div className="mt-4 text-sm text-slate-600">Server is offline.</div>}{serverReady && models.length === 0 && !loadingModels && <div className="mt-4 text-sm text-slate-600">No model response yet.</div>}{models.map((model) => <div key={model.id} className="mt-3 rounded-lg border border-slate-800 bg-slate-950/70 p-2.5"><div className="truncate font-mono text-xs text-slate-200" title={model.id}>{model.id}</div><div className="mt-1 text-[11px] text-slate-600">{model.owned_by || "llama.cpp"}</div></div>)}</div>
      </section>

      <section className="developer-section developer-section--endpoints mt-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4"><div className="flex items-start justify-between gap-3"><div><h3 className="text-sm font-semibold text-slate-200">OpenAI-compatible endpoints</h3><p className="mt-1 text-xs text-slate-500">Availability depends on the selected llama.cpp runtime build. Each row shows the exact path.</p></div><span className="rounded bg-slate-800 px-2 py-1 text-[11px] text-slate-500">/v1</span></div><div className="mt-3 grid gap-2 md:grid-cols-2">{ENDPOINTS.map((endpoint) => { const id = `${endpoint.method}-${endpoint.path}`; const snippet = buildCurlSnippet(baseUrl || "http://127.0.0.1:8080/v1", endpoint.path); return <div key={id} className="rounded-lg border border-slate-800 bg-slate-950/60 p-3"><div className="flex items-center gap-2"><span className="rounded bg-cyan-950 px-1.5 py-0.5 font-mono text-[10px] text-cyan-300">{endpoint.method}</span><code className="font-mono text-xs text-slate-200">/v1{endpoint.path}</code></div><p className="mt-2 text-xs leading-relaxed text-slate-500">{endpoint.description}</p><button type="button" onClick={() => void copy(id, snippet)} className="mt-2 rounded bg-slate-800 px-2 py-1 text-[11px] text-slate-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">{copied === id ? "Copied curl" : "Copy curl"}</button></div>; })}</div></section>

      <section className="developer-section developer-section--compatibility mt-3 grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
          <h3 className="text-sm font-semibold text-slate-200">LM Studio native REST</h3>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">Stateful `/api/v1` clients can use response IDs, model lifecycle endpoints, load progress, and MCP integrations when the target server exposes the LM Studio API.</p>
          <code className="mt-3 block break-all rounded-lg bg-slate-950 p-3 font-mono text-[11px] text-cyan-300">{rootUrl}/api/v1/chat</code>
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-slate-500"><span className="rounded bg-slate-800 px-2 py-1">stateful chat</span><span className="rounded bg-slate-800 px-2 py-1">load/unload</span><span className="rounded bg-slate-800 px-2 py-1">download status</span></div>
          <button type="button" onClick={() => void copy("native-chat", `curl ${rootUrl}/api/v1/chat \\\n  -H "Authorization: Bearer <LOCAL_API_KEY>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"<MODEL_ID>","input":"Hello","stream":true}'`)} className="mt-3 rounded bg-slate-800 px-2 py-1 text-[11px] text-slate-400 hover:text-white">{copied === "native-chat" ? "Copied curl" : "Copy native curl"}</button>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
          <h3 className="text-sm font-semibold text-slate-200">Anthropic Messages adapter</h3>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">The client adapter translates system prompts, vision blocks, reasoning, tools, and SSE events to `/v1/messages`. It is local-only when paired with a local gateway; it does not call Anthropic cloud.</p>
          <code className="mt-3 block break-all rounded-lg bg-slate-950 p-3 font-mono text-[11px] text-fuchsia-300">{rootUrl}/v1/messages</code>
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-slate-500"><span className="rounded bg-slate-800 px-2 py-1">thinking blocks</span><span className="rounded bg-slate-800 px-2 py-1">tool use</span><span className="rounded bg-slate-800 px-2 py-1">SSE translation</span></div>
          <button type="button" onClick={() => void copy("anthropic-messages", `curl ${rootUrl}/v1/messages \\\n  -H "x-api-key: <LOCAL_API_KEY>" \\\n  -H "anthropic-version: 2023-06-01" \\\n  -H "Content-Type: application/json"`)} className="mt-3 rounded bg-slate-800 px-2 py-1 text-[11px] text-slate-400 hover:text-white">{copied === "anthropic-messages" ? "Copied curl" : "Copy Messages curl"}</button>
        </div>
      </section>

      <section className="developer-section developer-section--gateway mt-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-sm font-semibold text-slate-200">Local Anthropic gateway</h3><p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-500">Expose the real localhost <code>/v1/messages</code> adapter backed by the running llama-server. It validates <code>x-api-key</code> and keeps upstream credentials in memory only.</p></div><button type="button" onClick={() => void toggleGateway()} disabled={!serverReady} className="rounded-lg border border-fuchsia-800 bg-fuchsia-950/50 px-3 py-1.5 text-xs text-fuchsia-200 hover:bg-fuchsia-900 disabled:opacity-40">{gateway.running ? "Stop gateway" : "Start gateway"}</button></div>{gateway.running && <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-400"><span className="rounded bg-emerald-950 px-2 py-1 text-emerald-300">running</span><code className="break-all text-fuchsia-300">{gateway.url}</code></div>}<div className="mt-2 text-[11px] text-slate-600">The gateway binds to 127.0.0.1 only; cloud Anthropic traffic is not involved.</div></section>

      <section className="developer-section developer-section--responses mt-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-sm font-semibold text-slate-200">Stateful OpenAI Responses gateway</h3><p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-500">When the local gateway is running, it exposes <code>POST/GET/DELETE /v1/responses</code> with <code>previous_response_id</code>, bounded local history, streaming events, and explicit cancel/delete semantics.</p></div><span className="rounded bg-cyan-950 px-2 py-1 text-[11px] text-cyan-300">{gateway.running ? "available" : "start gateway"}</span></div><div className="mt-3 grid gap-2 sm:grid-cols-2"><code className="break-all rounded-lg bg-slate-950 p-3 font-mono text-[11px] text-cyan-300">{gateway.url ? gateway.url.replace(/\/v1\/messages\/?$/, "") + "/v1/responses" : "http://127.0.0.1:8081/v1/responses"}</code><code className="break-all rounded-lg bg-slate-950 p-3 font-mono text-[11px] text-cyan-300">GET/DELETE /v1/responses/&lt;id&gt;</code></div><button type="button" onClick={() => void copy("responses", `curl ${gateway.url ? gateway.url.replace(/\/v1\/messages\/?$/, "") + "/v1/responses" : "http://127.0.0.1:8081/v1/responses"} \\\n  -H "Authorization: Bearer ***" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"<MODEL_ID>","input":"Hello","previous_response_id":null,"stream":false}'`)} disabled={!gateway.running} className="mt-3 rounded bg-slate-800 px-2 py-1 text-[11px] text-slate-400 hover:text-white disabled:opacity-40">{copied === "responses" ? "Copied curl" : "Copy Responses curl"}</button></section>

      <section className="developer-section developer-section--snippets mt-3 grid gap-3 lg:grid-cols-2"><div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4"><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold text-slate-200">Python</h3><button type="button" onClick={() => void copy("python", pythonSnippet)} className="rounded bg-slate-800 px-2 py-1 text-[11px] text-slate-400 hover:text-white">{copied === "python" ? "Copied" : "Copy"}</button></div><pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-400">{pythonSnippet}</pre></div><div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4"><div className="flex items-center justify-between gap-3"><h3 className="text-sm font-semibold text-slate-200">JavaScript</h3><button type="button" onClick={() => void copy("javascript", jsSnippet)} className="rounded bg-slate-800 px-2 py-1 text-[11px] text-slate-400 hover:text-white">{copied === "javascript" ? "Copied" : "Copy"}</button></div><pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-400">{jsSnippet}</pre></div></section>

      <section className="developer-section developer-section--diagnostics mt-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4"><h3 className="text-sm font-semibold text-slate-200">Runtime diagnostics</h3><p className="mt-3 text-sm text-slate-500">{store.status.log_tail || store.status.error || "No runtime diagnostics reported."}</p></section>

      {serverReady && <div className="mt-3 text-[11px] text-slate-600">Example endpoint: <span className="font-mono text-slate-500">{endpointUrl(baseUrl, "/models")}</span>. API key values are intentionally never rendered or copied.</div>}
    </div>
  );
}
