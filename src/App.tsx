import { useRef, useState } from "react";
import "./App.css";

import ChatPanel from "./panels/Chat";
import DiscoverPanel from "./panels/Discover";
import DeveloperPanel from "./panels/Developer";
import McpPanel from "./panels/Mcp";
import ModelsPanel from "./panels/Models";
import TuningPanel from "./panels/Tuning";
import BenchPanel from "./panels/Bench";
import RuntimesPanel from "./panels/Runtimes";
import ProjectsPanel from "./panels/Projects";
import { useAppStore } from "./store";

type Tab = "chat" | "models" | "tuning" | "developer";
type ModelsSection = "library" | "discover" | "runtimes" | "benchmark" | "lora";
type TuningSection = "server" | "sampling" | "reasoning" | "escape" | "projects";
type DeveloperSection = "api" | "gateways" | "mcp" | "diagnostics";

const TABS: { id: Tab; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "models", label: "Models" },
  { id: "tuning", label: "Tuning" },
  { id: "developer", label: "Developer" },
];

const MODEL_SECTIONS: { id: ModelsSection; label: string }[] = [
  { id: "library", label: "Library" },
  { id: "discover", label: "Discover" },
  { id: "runtimes", label: "Runtimes" },
  { id: "benchmark", label: "Benchmark" },
  { id: "lora", label: "LoRA adapters" },
];

const TUNING_SECTIONS: { id: TuningSection; label: string }[] = [
  { id: "server", label: "Server & memory" },
  { id: "sampling", label: "Sampling" },
  { id: "reasoning", label: "Reasoning & MTP" },
  { id: "escape", label: "Escape hatches" },
  { id: "projects", label: "Presets & projects" },
];

const DEVELOPER_SECTIONS: { id: DeveloperSection; label: string }[] = [
  { id: "api", label: "Local API" },
  { id: "gateways", label: "Gateways" },
  { id: "mcp", label: "MCP servers" },
  { id: "diagnostics", label: "Diagnostics" },
];

function statusLabel(state: string): string {
  return state === "running" ? "ready" : state;
}

function shortModel(path: string | undefined): string {
  if (!path) return "No model selected";
  return path.split(/[\\/]/).pop() || path;
}

function PageShell<T extends string>({
  items,
  active,
  onSelect,
  children,
}: {
  items: { id: T; label: string }[];
  active: T;
  onSelect: (section: T) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="app-page-shell">
      <aside className="app-side-nav" aria-label="Section navigation">
        <div className="app-side-label">{items.length ? items[0].label === "Library" ? "MODELS" : items[0].label === "Server & memory" ? "TUNING" : "DEVELOPER" : "SECTION"}</div>
        <nav>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`app-side-link ${item.id === active ? "is-active" : ""}`}
              aria-current={item.id === active ? "page" : undefined}
              onClick={() => onSelect(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>
      <div className="app-page-content">{children}</div>
    </div>
  );
}

export default function App() {
  const store = useAppStore();
  const [tab, setTab] = useState<Tab>("chat");
  const [modelsSection, setModelsSection] = useState<ModelsSection>("library");
  const [tuningSection, setTuningSection] = useState<TuningSection>("server");
  const [developerSection, setDeveloperSection] = useState<DeveloperSection>("api");
  const [mountedTabs, setMountedTabs] = useState<Set<Tab>>(() => new Set(["chat"]));
  const [applyRequest, setApplyRequest] = useState(0);
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement>>>({});
  const currentIndex = TABS.findIndex((item) => item.id === tab);
  const serverBusy = store.busy || store.status.state === "starting" || store.status.state === "stopping";
  const serverState = store.status.state;
  const hasError = store.bootError || store.actionError || store.statusPollError || store.status.error;

  const selectTab = (next: Tab, focus = false) => {
    setMountedTabs((current) => current.has(next) ? current : new Set([...current, next]));
    setTab(next);
    if (focus) window.requestAnimationFrame(() => tabRefs.current[next]?.focus());
  };

  const moveTab = (delta: number) => {
    const next = (currentIndex + delta + TABS.length) % TABS.length;
    selectTab(TABS[next].id, true);
  };

  const toggleServer = async () => {
    try {
      if (serverState === "running") await store.stop();
      else await store.start();
    } catch {
      // The store publishes an actionable error banner; keep the shell mounted.
    }
  };

  const requestApplyRestart = () => {
    setTuningSection("server");
    setApplyRequest((current) => current + 1);
    selectTab("tuning");
  };

  const statusTone = serverState === "running" ? "is-ready" : serverState === "failed" || serverState === "crashed" ? "is-error" : "is-idle";
  const statusDetail = serverState === "running"
    ? `${store.status.active_requests ?? 0} req${store.status.pid ? ` · PID ${store.status.pid}` : ""}`
    : serverState === "stopped" ? "server stopped" : serverState;
  const backendLabel = store.cfg?.active_backend
    ? `${store.cfg.active_backend}${store.cfg.active_build ? ` · ${store.cfg.active_build}` : ""}`
    : "PATH runtime";

  return (
    <div className="app-shell">
      <a href="#main-content" className="app-skip-link">Skip to workspace</a>

      <header className="app-topbar">
        <div className="app-brand" aria-label="llama-board">
          <span className="app-brand-mark" aria-hidden="true">■</span>
          <h1>llama-board</h1>
        </div>
        <nav aria-label="Primary" role="tablist" aria-orientation="horizontal" className="app-tabs">
          {TABS.map((item) => (
            <button
              key={item.id}
              id={`tab-${item.id}`}
              role="tab"
              type="button"
              aria-selected={tab === item.id}
              aria-controls={`panel-${item.id}`}
              tabIndex={tab === item.id ? 0 : -1}
              ref={(element) => { tabRefs.current[item.id] = element ?? undefined; }}
              onClick={() => selectTab(item.id)}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                  event.preventDefault();
                  moveTab(1);
                } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                  event.preventDefault();
                  moveTab(-1);
                } else if (event.key === "Home") {
                  event.preventDefault();
                  selectTab(TABS[0].id, true);
                } else if (event.key === "End") {
                  event.preventDefault();
                  selectTab(TABS[TABS.length - 1].id, true);
                }
              }}
              className={`app-tab ${tab === item.id ? "is-active" : ""}`}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="app-status-bar">
          <span className={`app-status-chip ${statusTone}`} role="status" aria-live="polite">
            <span className="app-status-dot" aria-hidden="true" />
            {statusLabel(serverState)}
          </span>
          <span className="app-status-detail">{statusDetail}</span>
          <button type="button" onClick={() => void toggleServer()} disabled={!store.cfg || serverBusy} className={`app-server-button ${serverState === "running" ? "is-stop" : "is-start"}`}>
            {serverBusy ? "Working…" : serverState === "running" ? "Stop" : "Start"}
          </button>
        </div>
      </header>

      <div className="app-loadbar">
        <span className="app-load-label">LOAD</span>
        <button type="button" className="app-load-select app-load-model" onClick={() => selectTab("models")} title={store.cfg?.active_model ?? "Open Models"}>
          {shortModel(store.cfg?.active_model)}
        </button>
        <button type="button" className="app-load-select app-load-backend" onClick={() => { setModelsSection("runtimes"); selectTab("models"); }}>
          {backendLabel}
        </button>
        <span className="app-load-metric"><b>ctx</b> {store.cfg?.ctx_size?.toLocaleString() ?? "—"}</span>
        <span className="app-load-metric"><b>ngl</b> {store.cfg?.ngl ?? "—"}</span>
        <span className="app-load-metric"><b>flash</b> {store.cfg?.flash_attn || "auto"}</span>
        {store.status.memory && <span className="app-load-metric"><b>mem</b> {store.status.memory.total_mb.toLocaleString()} MB</span>}
        <span className="app-load-spacer" />
        {store.actionError && <span className="app-load-warning">● unsaved action error</span>}
        <button type="button" className="app-apply-button" onClick={requestApplyRestart} disabled={!store.cfg || serverBusy}>
          Apply &amp; restart
        </button>
      </div>

      {hasError && (
        <div className="app-alert" role="alert">
          <div>{store.bootError ?? store.actionError ?? store.statusPollError ?? store.status.error}</div>
          <button type="button" aria-label="Dismiss error" onClick={store.clearErrors}>×</button>
        </div>
      )}

      <main id="main-content" className="app-main" tabIndex={-1}>
        {mountedTabs.has("chat") && (
          <section id="panel-chat" role="tabpanel" aria-labelledby="tab-chat" hidden={tab !== "chat"} className="app-panel-host">
            <ChatPanel store={store} />
          </section>
        )}

        {mountedTabs.has("models") && (
          <section id="panel-models" role="tabpanel" aria-labelledby="tab-models" hidden={tab !== "models"} className="app-panel-host">
            <PageShell items={MODEL_SECTIONS} active={modelsSection} onSelect={setModelsSection}>
              {modelsSection === "library" && <ModelsPanel store={store} focus="library" />}
              {modelsSection === "discover" && <DiscoverPanel store={store} active={tab === "models" && modelsSection === "discover"} />}
              {modelsSection === "runtimes" && <RuntimesPanel store={store} active={tab === "models" && modelsSection === "runtimes"} />}
              {modelsSection === "benchmark" && <BenchPanel store={store} />}
              {modelsSection === "lora" && <ModelsPanel store={store} focus="lora" />}
            </PageShell>
          </section>
        )}

        {mountedTabs.has("tuning") && (
          <section id="panel-tuning" role="tabpanel" aria-labelledby="tab-tuning" hidden={tab !== "tuning"} className="app-panel-host">
            <PageShell items={TUNING_SECTIONS} active={tuningSection} onSelect={setTuningSection}>
              {tuningSection === "projects" ? <ProjectsPanel store={store} /> : <TuningPanel store={store} section={tuningSection} applyRequest={applyRequest} />}
            </PageShell>
          </section>
        )}

        {mountedTabs.has("developer") && (
          <section id="panel-developer" role="tabpanel" aria-labelledby="tab-developer" hidden={tab !== "developer"} className="app-panel-host">
            <PageShell items={DEVELOPER_SECTIONS} active={developerSection} onSelect={setDeveloperSection}>
              {developerSection === "mcp" ? <McpPanel store={store} /> : <DeveloperPanel store={store} section={developerSection} />}
            </PageShell>
          </section>
        )}
      </main>
    </div>
  );
}
