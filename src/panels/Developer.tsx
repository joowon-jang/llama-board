import { useEffect, useMemo, useState } from "react";
import * as api from "../api";
import type { AppStore } from "../store";
import { buildCurlSnippet, endpointUrl } from "../developerUtils";
import FeedbackBanner from "../components/FeedbackBanner";
import StatusBadge from "../components/StatusBadge";
import { useI18n } from "../i18n";
import { pt } from "../panelI18n";
import { ut } from "../uiI18n";
import { normalizeDisplayPath, normalizeDisplayText } from "../lifecycleUtils";


const ENDPOINTS = [
  { method: "GET", path: "/models", description: "endpointModels" },
  { method: "POST", path: "/responses", description: "endpointResponses" },
  { method: "POST", path: "/chat/completions", description: "endpointChat" },
  { method: "POST", path: "/completions", description: "endpointCompletions" },
  { method: "POST", path: "/embeddings", description: "endpointEmbeddings" },
] as const;

function copyText(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}

export default function DeveloperPanel({ store, section = "api" }: { store: AppStore; section?: "api" | "gateways" | "diagnostics" }) {
  const { t, locale } = useI18n();

  const [models, setModels] = useState<api.LocalModelInfo[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gateway, setGateway] = useState<{ running: boolean; url?: string }>({ running: false });
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
    try {
      const loaded = await api.localModels(baseUrl, store.status.api_key ?? "");
      setModels(loaded);
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
      setError(`${t("error.wrong")}: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  };

  // The sidebar swaps which section is visible, so the page heading has to
  // follow it instead of always describing the API section.
  const sectionHeading = section === "gateways"
    ? { title: t("section.gateways"), description: ut(locale, "gatewaysDescription") }
    : section === "diagnostics"
    ? { title: t("section.diagnostics"), description: ut(locale, "diagnosticsDescription") }
      : { title: t("section.api"), description: "" };

  return (
    <div className="app-page-scroll developer-panel relative flex h-full min-h-0 flex-col overflow-auto p-4" data-developer-section={section}>
      <div className="developer-header mb-4 flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="developer-header-copy min-w-0"><div className="text-xs font-semibold uppercase tracking-[0.18em] text-cyan-300">{t("section.developer")}</div><h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-100">{sectionHeading.title}</h2>{sectionHeading.description && <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-500">{sectionHeading.description}</p>}</div>
        <StatusBadge label={serverReady ? pt(locale, "apiReady") : pt(locale, "startServer")} tone={serverReady ? "success" : "warning"} />
      </div>
      {error && <div className="app-panel-feedback-layer" aria-live="polite">
        <FeedbackBanner tone="error" title={t("error.wrong")} onDismiss={() => setError(null)}>{error}</FeedbackBanner>
      </div>}
      {!serverReady && !error && <div className="developer-api-status" role="status" aria-live="polite">
        <span className="developer-api-status__dot" aria-hidden="true" />
        <span className="developer-api-status__title">{pt(locale, "apiUnavailable")}</span>
        <span className="developer-api-status__message">{pt(locale, "startLocalServer")}</span>
      </div>}
      {section === "api" && <div className="developer-summary-grid mb-4 grid gap-3 sm:grid-cols-3" role="group" aria-label={pt(locale, "ariaDeveloperSummary")}>
        <div className="flex flex-col justify-center rounded-lg border border-slate-800 bg-slate-900/50 p-3.5"><div className="text-[10px] uppercase tracking-wide text-slate-500">{ut(locale, "localApi")}</div><div className="mt-1 text-sm font-medium text-slate-200">{serverReady ? pt(locale, "ready") : pt(locale, "offline")}</div><div className="mt-1 truncate font-mono text-[10px] text-slate-500" title={baseUrl || ut(locale, "startServerForUrl")}>{baseUrl || ut(locale, "startServerForUrl")}</div></div>
        <div className="flex flex-col justify-center rounded-lg border border-slate-800 bg-slate-900/50 p-3.5"><div className="text-[10px] uppercase tracking-wide text-slate-500">{ut(locale, "loadedModels")}</div><div className="mt-1 text-sm font-medium text-slate-200">{models.length || "—"}</div><div className="mt-1 text-[10px] text-slate-500">{ut(locale, "fromModelsEndpoint")}</div></div>
        <div className="flex flex-col justify-center rounded-lg border border-slate-800 bg-slate-900/50 p-3.5"><div className="text-[10px] uppercase tracking-wide text-slate-500">{ut(locale, "gateway")}</div><div className="mt-1 text-sm font-medium text-slate-200">{gateway.running ? ut(locale, "running") : ut(locale, "stopped")}</div><div className="mt-1 text-[10px] text-slate-500">{ut(locale, "localhostOnly")}</div></div>
      </div>}

      {section === "api" && <section className="developer-section developer-section--connection grid items-start gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(17rem,0.7fr)]">
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="app-section-title">{ut(locale, "connection")}</h3><p className="app-section-hint">{ut(locale, "apiDescription")}</p><p className="app-section-hint mt-1">{ut(locale, "connectionHint")}</p></div><button type="button" onClick={() => void refreshModels()} disabled={!serverReady || loadingModels} className="app-button app-button--secondary app-button--sm">{loadingModels ? ut(locale, "checking") : ut(locale, "checkModels")}</button></div>
          <div className="mt-3.5 grid gap-3 sm:grid-cols-2"><div className="flex flex-col justify-between rounded-lg border border-slate-800 bg-slate-950/70 p-3"><div className="text-[11px] uppercase tracking-wide text-slate-600">{ut(locale, "baseUrl")}</div><div className="mt-1 break-all font-mono text-xs text-cyan-300">{baseUrl || "http://127.0.0.1:8080/v1"}</div><button type="button" onClick={() => void copy("base-url", baseUrl)} disabled={!baseUrl} className="app-button app-button--secondary app-button--sm mt-2.5 self-start">{copied === "base-url" ? pt(locale, "copied") : ut(locale, "copyUrl")}</button></div><div className="flex flex-col justify-between rounded-lg border border-slate-800 bg-slate-950/70 p-3"><div className="text-[11px] uppercase tracking-wide text-slate-600">{ut(locale, "authorization")}</div><div className="mt-1 font-mono text-xs text-slate-300">Bearer &lt;LOCAL_API_KEY&gt;</div><div className="mt-2 text-[11px] text-slate-600">{ut(locale, "keyInMemory")}</div></div></div>
          <div className="mt-3.5 flex flex-wrap gap-2 text-xs text-slate-500"><span className="rounded bg-slate-800 px-2.5 py-1">state: {store.status.state}</span>{store.status.pid && <span className="rounded bg-slate-800 px-2.5 py-1">PID: {store.status.pid}</span>}{store.status.model && <span className="max-w-full truncate rounded bg-slate-800 px-2.5 py-1" title={normalizeDisplayPath(store.status.model)}>effective: {normalizeDisplayPath(store.status.model).split(/[\\/]/).pop()}</span>}<span className="rounded bg-slate-800 px-2.5 py-1">{ut(locale, "authLocalBearer")}</span></div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4"><h3 className="app-section-title">{ut(locale, "loadedModels")}</h3><p className="app-section-hint">{ut(locale, "loadedModelsHint")}</p>{!serverReady && <div className="mt-4 text-sm text-slate-600">{ut(locale, "serverOffline")}</div>}{serverReady && models.length === 0 && !loadingModels && <div className="mt-4 text-sm text-slate-600">{ut(locale, "noModelResponse")}</div>}{models.map((model) => { const displayModelId = normalizeDisplayPath(model.id); return <div key={model.id} className="mt-3 rounded-lg border border-slate-800 bg-slate-950/70 p-2.5"><div className="truncate font-mono text-xs text-slate-200" title={displayModelId}>{displayModelId}</div><div className="mt-1 text-[11px] text-slate-600">{model.owned_by || "llama.cpp"}</div></div>; })}</div>
      </section>}

      {section === "api" && <section className="developer-section developer-section--endpoints mt-4 rounded-xl border border-slate-800 bg-slate-900/50 p-4"><div className="flex items-start justify-between gap-3"><div><h3 className="app-section-title">{ut(locale, "endpointsTitle")}</h3><p className="app-section-hint">{ut(locale, "endpointsHint")}</p></div><span className="rounded bg-slate-800 px-2.5 py-1 text-[11px] text-slate-500">/v1</span></div><div className="mt-3.5 grid gap-3 md:grid-cols-2">{ENDPOINTS.map((endpoint) => { const id = `${endpoint.method}-${endpoint.path}`; const snippet = buildCurlSnippet(baseUrl || "http://127.0.0.1:8080/v1", endpoint.path); return <div key={id} className="rounded-lg border border-slate-800 bg-slate-950/60 p-3.5"><div className="flex items-center gap-2"><span className="rounded bg-cyan-950 px-2 py-0.5 font-mono text-[10px] text-cyan-300">{endpoint.method}</span><code className="font-mono text-xs text-slate-200">/v1{endpoint.path}</code></div><p className="mt-2 text-xs leading-relaxed text-slate-500">{ut(locale, endpoint.description)}</p><button type="button" onClick={() => void copy(id, snippet)} className="app-button app-button--secondary app-button--sm mt-2.5">{copied === id ? ut(locale, "copiedCurl") : ut(locale, "copyCurl")}</button></div>; })}</div></section>}

      {section === "api" && <section className="developer-section developer-section--compatibility mt-4 grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
          <h3 className="app-section-title">{ut(locale, "lmStudioTitle")}</h3>
          <p className="app-section-hint">{ut(locale, "lmStudioHint")}</p>
          <code className="mt-3 block break-all rounded-lg bg-slate-950 p-3 font-mono text-[11px] text-cyan-300">{rootUrl}/api/v1/chat</code>
          <div className="mt-2.5 flex flex-wrap gap-1.5 text-[11px] text-slate-500"><span className="rounded bg-slate-800 px-2.5 py-1">stateful chat</span><span className="rounded bg-slate-800 px-2.5 py-1">load/unload</span><span className="rounded bg-slate-800 px-2.5 py-1">download status</span></div>
          <button type="button" onClick={() => void copy("native-chat", `curl ${rootUrl}/api/v1/chat \\\n  -H "Authorization: Bearer <LOCAL_API_KEY>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"<MODEL_ID>","input":"Hello","stream":true}'`)} className="app-button app-button--secondary app-button--sm mt-3">{copied === "native-chat" ? ut(locale, "copiedCurl") : ut(locale, "copyNativeCurl")}</button>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
          <h3 className="app-section-title">{ut(locale, "anthropicTitle")}</h3>
          <p className="app-section-hint">{ut(locale, "anthropicHint")}</p>
          <code className="mt-3 block break-all rounded-lg bg-slate-950 p-3 font-mono text-[11px] text-fuchsia-300">{rootUrl}/v1/messages</code>
          <div className="mt-2.5 flex flex-wrap gap-1.5 text-[11px] text-slate-500"><span className="rounded bg-slate-800 px-2.5 py-1">thinking blocks</span><span className="rounded bg-slate-800 px-2.5 py-1">tool use</span><span className="rounded bg-slate-800 px-2.5 py-1">SSE translation</span></div>
          <button type="button" onClick={() => void copy("anthropic-messages", `curl ${rootUrl}/v1/messages \\\n  -H "x-api-key: <LOCAL_API_KEY>" \\\n  -H "anthropic-version: 2023-06-01" \\\n  -H "Content-Type: application/json"`)} className="app-button app-button--secondary app-button--sm mt-3">{copied === "anthropic-messages" ? ut(locale, "copiedCurl") : ut(locale, "copyMessagesCurl")}</button>
        </div>
      </section>}

      {section === "gateways" && <section className="developer-section developer-section--gateway mt-4 rounded-xl border border-slate-800 bg-slate-900/50 p-4"><div className="developer-section-header flex min-w-0 flex-wrap items-start justify-between gap-3"><div className="developer-section-copy min-w-0"><h3 className="app-section-title">{ut(locale, "gatewayTitle")}</h3><p className="app-section-hint max-w-2xl">{ut(locale, "gatewayHint")}</p></div><button type="button" onClick={() => void toggleGateway()} disabled={!serverReady} className="developer-section-action app-button app-button--primary app-button--sm">{gateway.running ? ut(locale, "stopGateway") : ut(locale, "startGateway")}</button></div>{gateway.running && <div className="developer-section-status mt-3 flex min-w-0 flex-wrap items-center gap-2 text-xs text-slate-400"><span className="rounded bg-emerald-950 px-2 py-1 text-emerald-300">{ut(locale, "running")}</span><code className="developer-code-block min-w-0 break-all text-fuchsia-300">{gateway.url}</code></div>}<div className="mt-2 text-[11px] text-slate-600">{ut(locale, "gatewayBindHint")}</div></section>}

      {section === "gateways" && <section className="developer-section developer-section--responses mt-4 rounded-xl border border-slate-800 bg-slate-900/50 p-4"><div className="developer-section-header flex min-w-0 flex-wrap items-start justify-between gap-3"><div className="developer-section-copy min-w-0"><h3 className="app-section-title">{ut(locale, "responsesTitle")}</h3><p className="app-section-hint max-w-2xl">{ut(locale, "responsesHint")}</p></div><span className="developer-section-status rounded bg-cyan-950 px-2.5 py-1 text-[11px] text-cyan-300">{gateway.running ? ut(locale, "responsesAvailable") : ut(locale, "responsesStartGateway")}</span></div><div className="developer-responses-grid mt-3.5 grid min-w-0 gap-3 sm:grid-cols-2"><code className="developer-code-block min-w-0 break-all rounded-lg bg-slate-950 p-3 font-mono text-[11px] text-cyan-300">{gateway.url ? gateway.url.replace(/\/v1\/messages\/?$/, "") + "/v1/responses" : "http://127.0.0.1:8081/v1/responses"}</code><code className="developer-code-block min-w-0 break-all rounded-lg bg-slate-950 p-3 font-mono text-[11px] text-cyan-300">GET/DELETE /v1/responses/&lt;id&gt;</code></div><button type="button" onClick={() => void copy("responses", `curl ${gateway.url ? gateway.url.replace(/\/v1\/messages\/?$/, "") + "/v1/responses" : "http://127.0.0.1:8081/v1/responses"} \\\n  -H "Authorization: Bearer ***" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"<MODEL_ID>","input":"Hello","previous_response_id":null,"stream":false}'`)} disabled={!gateway.running} className="app-button app-button--secondary app-button--sm mt-3">{copied === "responses" ? ut(locale, "copiedCurl") : ut(locale, "copyResponsesCurl")}</button></section>}

      {section === "api" && <section className="developer-section developer-section--snippets mt-4 grid gap-4 lg:grid-cols-2"><div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4"><div className="flex items-center justify-between gap-3"><h3 className="app-section-title">Python</h3><button type="button" onClick={() => void copy("python", pythonSnippet)} className="app-button app-button--secondary app-button--sm">{copied === "python" ? pt(locale, "copied") : ut(locale, "copy")}</button></div><pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-400">{pythonSnippet}</pre></div><div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4"><div className="flex items-center justify-between gap-3"><h3 className="app-section-title">JavaScript</h3><button type="button" onClick={() => void copy("javascript", jsSnippet)} className="app-button app-button--secondary app-button--sm">{copied === "javascript" ? pt(locale, "copied") : ut(locale, "copy")}</button></div><pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-400">{jsSnippet}</pre></div></section>}

      {section === "diagnostics" && <section className="developer-section developer-section--diagnostics mt-4 rounded-xl border border-slate-800 bg-slate-900/50 p-4"><h3 className="app-section-title">{ut(locale, "diagnosticsTitle")}</h3><pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg p-3 font-mono text-xs leading-relaxed">{normalizeDisplayText(store.status.log_tail || store.status.error || ut(locale, "noDiagnostics"))}</pre></section>}

      {section === "api" && serverReady && <div className="developer-api-footer mt-4 text-[11px] text-slate-600">{ut(locale, "exampleEndpoint")}: <span className="font-mono text-slate-500">{endpointUrl(baseUrl, "/models")}</span>. {ut(locale, "keyNeverRendered")}</div>}
    </div>
  );
}
