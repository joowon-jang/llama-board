import { lazy, Suspense, useEffect, useState } from "react";
import { applyTheme, persistThemeMode, subscribeToSystemTheme } from "./theme";
import "./App.css";


import { useAppStore } from "./store";
import EmptyState from "./components/EmptyState";
import FeedbackBanner from "./components/FeedbackBanner";
import { PanelBoundary } from "./components/ErrorBoundary";
import ThemeSwitcher from "./components/ThemeSwitcher";
import TabNav, { type TabNavItem } from "./components/TabNav";

import { useI18n } from "./i18n";
import { xt } from "./extraI18n";
import { buildNumber } from "./runtimeUtils";
import { loadPreferences, resetPreferences, savePreferences, type AppPreferences } from "./preferences";

const ChatPanel = lazy(() => import("./panels/Chat"));
const DiscoverPanel = lazy(() => import("./panels/Discover"));
const DeveloperPanel = lazy(() => import("./panels/Developer"));
const McpPanel = lazy(() => import("./panels/Mcp"));
const ModelsPanel = lazy(() => import("./panels/Models"));
const TuningPanel = lazy(() => import("./panels/Tuning"));
const BenchPanel = lazy(() => import("./panels/Bench"));
const RuntimesPanel = lazy(() => import("./panels/Runtimes"));
const ProjectsPanel = lazy(() => import("./panels/Projects"));
const SettingsPanel = lazy(() => import("./panels/Settings"));

type Tab = "chat" | "models" | "tuning" | "developer" | "settings";
type ModelsSection = "library" | "discover" | "runtimes" | "benchmark" | "lora";
type TuningSection = "server" | "sampling" | "reasoning" | "escape" | "projects";
type DeveloperSection = "api" | "gateways" | "mcp" | "diagnostics";

function PanelLoading() {
  const { locale } = useI18n();
  return <div className="panel-loading" role="status" aria-label={xt(locale, "loading")}><span className="panel-spinner" aria-hidden="true" /></div>;
}

function LazyPanel({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<PanelLoading />}>{children}</Suspense>;
}


function shortModel(path: string | undefined, emptyLabel: string): string {
  if (!path) return emptyLabel;
  return path.split(/[\\/]/).pop() || path;
}

function PageShell<T extends string>({
  scope,
  items,
  active,
  onSelect,
  title,
  children,
}: {
  /** Namespaces the tab/panel ids so several shells can coexist in the DOM. */
  scope: string;
  items: TabNavItem<T>[];
  active: T;
  onSelect: (section: T) => void;
  title: string;
  children: React.ReactNode;
}) {
  const panelId = `${scope}-section-panel`;
  return (
    <div className="app-page-shell">
      <div className="app-side-nav">
        <div className="app-side-label" aria-hidden="true">{title}</div>
        <TabNav
          items={items}
          active={active}
          onSelect={onSelect}
          label={title}
          orientation="vertical"
          tabId={(id) => `${scope}-section-${id}`}
          panelId={() => panelId}
          className="app-side-tablist"
          tabClassName={(isActive) => `app-side-link ${isActive ? "is-active" : ""}`}
        />
      </div>
      <div
        className="app-page-content"
        id={panelId}
        role="tabpanel"
        aria-labelledby={`${scope}-section-${active}`}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}

export default function App() {
  const [preferences, setPreferences] = useState<AppPreferences>(() => loadPreferences());
  const store = useAppStore({ pollIntervalMs: preferences.server.pollIntervalMs, autoStart: preferences.server.autoStart });
  const { t, locale, setLocale } = useI18n();
  const [tab, setTab] = useState<Tab>("chat");
  const [modelsSection, setModelsSection] = useState<ModelsSection>("library");
  const [tuningSection, setTuningSection] = useState<TuningSection>("server");
  const [developerSection, setDeveloperSection] = useState<DeveloperSection>("api");
  const [mountedTabs, setMountedTabs] = useState<Set<Tab>>(() => new Set(["chat"]));
  const [applyRequest, setApplyRequest] = useState(0);
  const tabs: TabNavItem<Tab>[] = [
    { id: "chat", label: t("tab.chat") }, { id: "models", label: t("tab.models") }, { id: "tuning", label: t("tab.tuning") }, { id: "developer", label: t("tab.developer") }, { id: "settings", label: t("tab.settings") },
  ];
  const modelSections: TabNavItem<ModelsSection>[] = [
    { id: "library", label: t("section.library") }, { id: "discover", label: t("section.discover") }, { id: "runtimes", label: t("section.runtimes") }, { id: "benchmark", label: t("section.benchmark") }, { id: "lora", label: t("section.lora") },
  ];
  const tuningSections: TabNavItem<TuningSection>[] = [
    { id: "server", label: t("section.serverMemory") }, { id: "sampling", label: t("section.sampling") }, { id: "reasoning", label: t("section.reasoning") }, { id: "escape", label: t("section.escape") }, { id: "projects", label: t("section.projects") },
  ];
  const developerSections: TabNavItem<DeveloperSection>[] = [
    { id: "api", label: t("section.api") }, { id: "gateways", label: t("section.gateways") }, { id: "mcp", label: t("section.mcp") }, { id: "diagnostics", label: t("section.diagnostics") },
  ];
  const serverBusy = store.busy || store.status.state === "starting" || store.status.state === "stopping";
  const serverState = store.status.state;
  const stopServer = store.stop;
  const hasError = store.bootError || store.actionError || store.statusPollError || store.status.error;

  useEffect(() => {
    applyTheme(preferences.theme);
    persistThemeMode(preferences.theme);
    document.documentElement.lang = locale;
    document.documentElement.dataset.density = preferences.appearance.density;
    document.documentElement.classList.toggle("app-reduce-motion", preferences.appearance.reduceMotion);
    document.documentElement.classList.toggle("app-developer-mode", preferences.advanced.developerMode);
    if (preferences.theme !== "system") return undefined;
    return subscribeToSystemTheme(() => applyTheme("system"));
  }, [locale, preferences.theme, preferences.appearance.density, preferences.appearance.reduceMotion, preferences.advanced.developerMode]);

  useEffect(() => {
    if (!preferences.server.autoStopOnExit) return undefined;
    const stopOnExit = () => {
      if (serverState === "running") void stopServer().catch(() => undefined);
    };
    window.addEventListener("beforeunload", stopOnExit);
    return () => window.removeEventListener("beforeunload", stopOnExit);
  }, [preferences.server.autoStopOnExit, serverState, stopServer]);

  useEffect(() => {
    if (preferences.locale !== locale) {
      setPreferences((current) => {
        const next = { ...current, locale };
        savePreferences(next);
        return next;
      });
    }
  }, [locale, preferences.locale]);

  const updatePreferences = (patch: Partial<AppPreferences>) => {
    setPreferences((current) => {
      const next = { ...current, ...patch };
      savePreferences(next);
      return next;
    });
    if (patch.locale) setLocale(patch.locale);
  };
  const resetAllPreferences = () => {
    const next = resetPreferences();
    setPreferences(next);
    setLocale(next.locale);
  };

  const selectTab = (next: Tab) => {
    setMountedTabs((current) => current.has(next) ? current : new Set([...current, next]));
    setTab(next);
  };

  const openModels = () => { setModelsSection("library"); selectTab("models"); };
  const openDiagnostics = () => { setDeveloperSection("diagnostics"); selectTab("developer"); };

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
    ? `${store.status.active_requests ?? 0} ${t("load.requests")}${store.status.pid ? ` · ${t("load.pid")} ${store.status.pid}` : ""}`
    : serverState === "stopped" ? t("status.stopped") : serverState;
  const backendLabel = store.cfg?.active_backend
    ? `${store.cfg.active_backend}${store.cfg.active_build ? ` · ${buildNumber(store.cfg.active_build)}` : ""}`
    : t("load.pathRuntime");

  return (
    <div className="app-shell">
      <a href="#main-content" className="app-skip-link">{t("app.skip")}</a>

      <header className="app-topbar">
        <div className="app-brand" aria-label="llama-board">
          <span className="app-brand-mark" aria-hidden="true">■</span>
          <h1>llama-board</h1>
        </div>
        <TabNav
          items={tabs}
          active={tab}
          onSelect={selectTab}
          label={t("app.primary")}
          tabId={(id) => `tab-${id}`}
          panelId={(id) => `panel-${id}`}
          className="app-tabs"
          tabClassName={(isActive) => `app-tab ${isActive ? "is-active" : ""}`}
        />
        <div className="app-status-bar">
          <span className={`app-status-chip ${statusTone}`} role="status" aria-live="polite">
            <span className="app-status-dot" aria-hidden="true" />
            {serverState === "running" ? t("status.ready") : serverState === "stopped" ? t("status.stopped") : serverState}
          </span>
          <span className="app-status-detail">{statusDetail}</span>
          <button type="button" onClick={() => void toggleServer()} disabled={!store.cfg || serverBusy} className={`app-server-button ${serverState === "running" ? "is-stop" : "is-start"}`}>
            {serverBusy ? t("status.working") : serverState === "running" ? t("action.stop") : t("action.start")}
          </button>
          <ThemeSwitcher mode={preferences.theme} onChange={(theme) => updatePreferences({ theme })} />
        </div>
      </header>

      <div className="app-loadbar">
        <span className="app-load-label">{t("load.label")}</span>
        <button type="button" className="app-load-select app-load-model" onClick={() => selectTab("models")} title={store.cfg?.active_model ?? t("load.noModel")}>
          {shortModel(store.cfg?.active_model, t("load.noModel"))}
        </button>
        <button type="button" className="app-load-select app-load-backend" onClick={() => { setModelsSection("runtimes"); selectTab("models"); }}>
          {backendLabel}
        </button>
        <span className="app-load-metric"><b>ctx</b> {store.cfg?.ctx_size?.toLocaleString() ?? "—"}</span>
        <span className="app-load-metric"><b>ngl</b> {store.cfg?.ngl ?? "—"}</span>
        <span className="app-load-metric"><b>flash</b> {store.cfg?.flash_attn || "auto"}</span>
        {store.status.memory && <span className="app-load-metric"><b>mem</b> {store.status.memory.total_mb.toLocaleString()} MB</span>}
        <span className="app-load-spacer" />
        {store.actionError && <span className="app-load-warning" title={store.actionError}>● {t("load.failed")}</span>}
        <button type="button" className="app-apply-button" onClick={requestApplyRestart} disabled={!store.cfg || serverBusy}>
          {t("action.applyRestart")}
        </button>
      </div>

      {store.bootState === "native-unavailable" && (
        <FeedbackBanner tone="warning" title={t("native.unavailable")} action={{ label: t("native.openDiagnostics"), onClick: openDiagnostics }}>
          {t("native.message")}
        </FeedbackBanner>
      )}
      {hasError && store.bootState !== "native-unavailable" && (
        <FeedbackBanner tone="error" title={t("error.attention")} onDismiss={store.clearErrors} action={store.status.state === "failed" || store.status.state === "crashed" ? { label: t("native.openDiagnostics"), onClick: openDiagnostics } : undefined}>
          {store.bootError ?? store.actionError ?? store.statusPollError ?? store.status.error}
        </FeedbackBanner>
      )}

      <main id="main-content" className="app-main" tabIndex={-1}>
        {mountedTabs.has("chat") && (
          <section id="panel-chat" role="tabpanel" aria-labelledby="tab-chat" hidden={tab !== "chat"} className="app-panel-host">
            {store.bootState === "native-unavailable" ? (
              <div className="app-runtime-empty"><EmptyState title={t("native.unavailable")} description={t("native.message")} action={{ label: t("native.openDiagnostics"), onClick: openDiagnostics }} /></div>
            ) : <PanelBoundary label="Chat"><LazyPanel><ChatPanel store={store} preferences={preferences} onOpenModels={openModels} onOpenDiagnostics={openDiagnostics} /></LazyPanel></PanelBoundary>}
          </section>
        )}

        {mountedTabs.has("models") && (
          <section id="panel-models" role="tabpanel" aria-labelledby="tab-models" hidden={tab !== "models"} className="app-panel-host">
            <PageShell scope="models" items={modelSections} active={modelsSection} onSelect={setModelsSection} title={t("section.models")}>
              <PanelBoundary label={t("section.models")}><LazyPanel>
                {modelsSection === "library" && <ModelsPanel store={store} focus="library" />}
                {modelsSection === "discover" && <DiscoverPanel store={store} active={tab === "models" && modelsSection === "discover"} />}
                <div hidden={modelsSection !== "runtimes"} aria-hidden={modelsSection !== "runtimes"} className="h-full min-h-0">
                  <RuntimesPanel store={store} active={tab === "models" && modelsSection === "runtimes"} />
                </div>
                {modelsSection === "benchmark" && <BenchPanel store={store} />}
                {modelsSection === "lora" && <ModelsPanel store={store} focus="lora" />}
              </LazyPanel></PanelBoundary>
            </PageShell>
          </section>
        )}

        {mountedTabs.has("tuning") && (
          <section id="panel-tuning" role="tabpanel" aria-labelledby="tab-tuning" hidden={tab !== "tuning"} className="app-panel-host">
            <PageShell scope="tuning" items={tuningSections} active={tuningSection} onSelect={setTuningSection} title={t("section.tuning")}>
              <PanelBoundary label={t("section.tuning")}><LazyPanel>{tuningSection === "projects" ? <ProjectsPanel store={store} /> : <TuningPanel store={store} section={tuningSection} applyRequest={applyRequest} />}</LazyPanel></PanelBoundary>
            </PageShell>
          </section>
        )}

        {mountedTabs.has("developer") && (
          <section id="panel-developer" role="tabpanel" aria-labelledby="tab-developer" hidden={tab !== "developer"} className="app-panel-host">
            <PageShell scope="developer" items={developerSections} active={developerSection} onSelect={setDeveloperSection} title={t("section.developer")}>
              <PanelBoundary label={t("section.developer")}><LazyPanel>{developerSection === "mcp" ? <McpPanel store={store} /> : <DeveloperPanel store={store} section={developerSection} />}</LazyPanel></PanelBoundary>
            </PageShell>
          </section>
        )}
        {mountedTabs.has("settings") && (
          <section id="panel-settings" role="tabpanel" aria-labelledby="tab-settings" hidden={tab !== "settings"} className="app-panel-host">
            <PanelBoundary label={t("section.settings")}><LazyPanel><SettingsPanel preferences={preferences} update={updatePreferences} reset={resetAllPreferences} /></LazyPanel></PanelBoundary>
          </section>
        )}
      </main>
    </div>
  );
}
