import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { AppStore } from "../store";
import { isCurrentScan, nextScanGeneration } from "./scanGeneration";
import { projectorChangeAllowed } from "./visionState";
import ConfirmDialog from "../components/ConfirmDialog";
import FeedbackBanner from "../components/FeedbackBanner";
import { useI18n } from "../i18n";
import { isServerRunning, normalizeDisplayPath } from "../lifecycleUtils";
import { shouldConfirmDestructive } from "../preferences";
import { buildNumber } from "../runtimeUtils";
import { useFlashMessage } from "../useFlashMessage";


export default function ModelsPanel({ store, focus = "library" }: { store: AppStore; focus?: "library" | "lora" }) {
  const { t } = useI18n();

  const cfg = store.cfg;
  const [models, setModels] = useState<api.GgufModel[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanTruncated, setScanTruncated] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [dir, setDir] = useState(cfg?.models_dir ?? "");
  const [folderDirty, setFolderDirty] = useState(false);
  const [folderSaved, setFolderSaved] = useState(false);
  const [scanRequest, setScanRequest] = useState(0);
  const [showVision, setShowVision] = useState(false);
  const [flash, notify, dismissFlash] = useFlashMessage();
  const [adapterScale, setAdapterScale] = useState("1");
  const [serverAdapters, setServerAdapters] = useState<api.ServerLoraAdapter[]>([]);
  const [serverAdapterScales, setServerAdapterScales] = useState<Record<number, string>>({});
  const [adapterBusy, setAdapterBusy] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<{ title: string; description: string; confirmLabel: string; onConfirm: () => void } | null>(null);
  const scanTimer = useRef<number | null>(null);
  const scanGeneration = useRef(0);
  const requestedScanDirRef = useRef("");

  const scan = useCallback(async () => {
    const generation = nextScanGeneration(scanGeneration.current);
    scanGeneration.current = generation;
    if (!dir.trim()) {
      setScanError(t("ui.modelsSetDirFirst"));
      setModels(null);
      setScanTruncated(false);
      setScanning(false);
      return;
    }
    setScanning(true);
    setScanError(null);
    try {
      const result = await api.listModels(dir);
      if (!isCurrentScan(generation, scanGeneration.current)) return;
      setModels(result.models);
      setScanTruncated(result.truncated);
    } catch (error) {
      if (!isCurrentScan(generation, scanGeneration.current)) return;
      setScanError(error instanceof Error ? error.message : String(error));
      setModels([]);
      setScanTruncated(false);
    } finally {
      if (isCurrentScan(generation, scanGeneration.current)) setScanning(false);
    }
  }, [dir, t]);

  const cancelScan = () => {
    scanGeneration.current = nextScanGeneration(scanGeneration.current);
    if (scanTimer.current !== null) window.clearTimeout(scanTimer.current);
    setScanning(false);
    setScanError(null);
  };

  useEffect(() => {
    const nextDir = cfg?.models_dir?.trim() ?? "";
    if (folderDirty || !nextDir || requestedScanDirRef.current === nextDir) return;
    requestedScanDirRef.current = nextDir;
    if (nextDir !== dir) setDir(nextDir);
    setScanRequest((current) => current + 1);
  }, [cfg?.models_dir, dir, folderDirty]);

  useEffect(() => {
    if (scanRequest <= 0) return;
    if (scanTimer.current !== null) window.clearTimeout(scanTimer.current);
    scanTimer.current = window.setTimeout(() => void scan(), 0);
    return () => {
      if (scanTimer.current !== null) window.clearTimeout(scanTimer.current);
    };
  }, [scanRequest, scan]);

  const normalizedQuery = modelQuery.trim().toLowerCase();
  const visible = (models ?? []).filter((model) => {
    if (!showVision && model.is_vision) return false;
    if (!normalizedQuery) return true;
    return `${model.name} ${normalizeDisplayPath(model.path)}`.toLowerCase().includes(normalizedQuery);
  });
  const selected = cfg?.active_model ?? "";
  const serverRunning = isServerRunning(store.status.state);

  const refreshServerAdapters = useCallback(async () => {
    if (!isServerRunning(store.status.state) || !store.status.url || !store.status.api_key) {
      setServerAdapters([]);
      return;
    }
    setAdapterBusy(true);
    try {
      const loaded = await api.listServerLoraAdapters(store.status.url, store.status.api_key);
      setServerAdapters(loaded);
      setServerAdapterScales(Object.fromEntries(loaded.map((adapter) => [adapter.id, String(adapter.scale)])));
    } catch (error) {
      setServerAdapters([]);
      notify(`${t("ui.loraHotSwapUnavailable")}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setAdapterBusy(false);
    }
  }, [t, notify, store.status.api_key, store.status.state, store.status.url]);

  useEffect(() => {
    void refreshServerAdapters();
  }, [refreshServerAdapters]);

  const addAdapter = async () => {
    try {
      const path = await api.pickLoraAdapter();
      if (!path) return;
      const scale = Number.parseFloat(adapterScale);
      if (!Number.isFinite(scale) || scale < 0 || scale > 4) {
        notify(t("ui.loraScaleRange"));
        return;
      }
      const next = [...(cfg?.lora_adapters ?? []).filter((adapter) => adapter.path !== path), { path, scale, enabled: scale > 0 }];
      await store.updateConfig({ lora_adapters: next });
      notify(isServerRunning(store.status.state) ? t("ui.loraSavedRestart") : t("ui.loraSaved"));
    } catch (error) {
      notify(`${t("ui.loraSelectionFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const removeAdapter = async (path: string) => {
    try {
      await store.updateConfig({ lora_adapters: (cfg?.lora_adapters ?? []).filter((adapter) => adapter.path !== path) });
      notify(t("ui.loraRemoved"));
    } catch (error) {
      notify(`${t("ui.loraUpdateFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const applyServerAdapters = async () => {
    if (!store.status.url || !store.status.api_key) return;
    try {
      await api.setServerLoraAdapters(store.status.url, store.status.api_key, serverAdapters.map((adapter) => ({ id: adapter.id, scale: Math.max(0, Math.min(4, Number.parseFloat(serverAdapterScales[adapter.id] ?? String(adapter.scale)) || 0)) })));
      await refreshServerAdapters();
      notify(t("ui.loraScalesApplied"));
    } catch (error) {
      notify(`${t("ui.loraHotSwapFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const selectModel = async (model: api.GgufModel) => {
    try {
      await store.updateConfig({ active_model: model.path });
      // 모델 선택은 저장/서버 시작 알림을 표시하지 않는다.
    } catch (error) {
      notify(`${t("panel.saveFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const setProjector = async (model: api.GgufModel) => {
    if (!projectorChangeAllowed(store.status.state)) {
      notify(t("ui.stopBeforeProjector"));
      return;
    }
    try {
      await store.updateConfig({ mmproj: model.path });
      // 프로젝터 선택도 선택 상태 변경이므로 성공 알림을 표시하지 않는다.
    } catch (error) {
      notify(`${t("panel.saveFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const browse = async () => {
    try {
      const chosen = await api.pickModelsDir();
      if (!chosen) return;
      setDir(chosen.trim());
      await store.updateConfig({ models_dir: chosen });
      setFolderDirty(false);
      setFolderSaved(true);
      requestedScanDirRef.current = chosen.trim();
      setScanRequest((current) => current + 1);
    } catch (error) {
      notify(`${t("panel.browseFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const start = async () => {
    try {
      await store.start();
      notify(t("panel.serverStarted"));
    } catch (error) {
      notify(`${t("panel.startFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const performSelectAndStart = async (model: api.GgufModel) => {
    const switching = serverRunning && selected !== model.path;
    try {
      if (switching) await store.stop();
      const next = await store.updateConfig({ active_model: model.path });
      await store.start(next);
      notify(switching ? `${t("panel.restartServer")}: ${model.name}` : `${t("panel.serverStarted")}: ${model.name}`);
    } catch (error) {
      notify(`${t("panel.startFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const selectAndStart = async (model: api.GgufModel) => {
    const switching = serverRunning && selected !== model.path;
    if (switching && shouldConfirmDestructive()) {
      setPendingConfirm({
        title: t("panel.restartSwitchQuestion"),
        description: t("ui.switchModelBody", { name: model.name }),
        confirmLabel: t("panel.restartSwitch"),
        onConfirm: () => { setPendingConfirm(null); void performSelectAndStart(model); },
      });
      return;
    }
    await performSelectAndStart(model);
  };

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(normalizeDisplayPath(path));
      notify(t("ui.modelPathCopied"));
    } catch (error) {
      notify(`${t("panel.saveFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const removeModel = async (model: api.GgufModel) => {
    if (serverRunning) {
      notify(t("ui.stopBeforeDelete"));
      return;
    }
    const remove = async () => {
      setPendingConfirm(null);
      try {
        await api.deleteModel(model.path);
        notify(t("ui.deletedModelNamed", { name: model.name }));
        await scan();
      } catch (error) {
        notify(`${t("ui.deleteFailed")}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    if (!shouldConfirmDestructive()) { void remove(); return; }
    setPendingConfirm({
      title: t("ui.deleteModelTitle"),
      description: t("ui.deleteModelBody", { name: model.name }),
      confirmLabel: t("ui.deleteModelAction"),
      onConfirm: () => void remove(),
    });
  };

  return (
    <div className="app-page-scroll models-panel relative flex h-full min-h-0 min-w-0 flex-col p-4 pb-8" data-testid="models-scroll-region">
      {focus === "lora" && <div className="mb-4"><div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{t("panel.models")}</div><h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-100">{t("panel.loraAdapters")}</h2><p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-500">{t("ui.loraDescription")}</p></div>}

      {/* Rendered outside the library-only fragment so LoRA actions report too. */}
      <div className="app-panel-feedback-layer" aria-live="polite">
        {flash && <FeedbackBanner tone="info" onDismiss={dismissFlash}>{flash}</FeedbackBanner>}
        {focus !== "lora" && (folderSaved || folderDirty) && (
          <FeedbackBanner tone="info">
            <div className="flex items-center justify-between gap-2">
              <span>{folderDirty ? t("panel.modelsChanged") : t("panel.modelsSaved")}</span>
              {folderSaved && !folderDirty && <span className="app-status-badge app-status-badge--success">{t("panel.saved")}</span>}
            </div>
          </FeedbackBanner>
        )}
        {focus !== "lora" && scanTruncated && <FeedbackBanner tone="warning">{t("ui.modelsScanTruncated")}</FeedbackBanner>}
      </div>

      {focus !== "lora" && <>
      <div className="models-folder-actions flex min-w-0 flex-nowrap items-center gap-2.5 overflow-x-auto">
        <label htmlFor="models-dir" className="shrink-0 text-sm text-slate-400">{t("panel.modelsDirectory")}</label>
        <input
          id="models-dir"
          value={normalizeDisplayPath(dir)}
          onChange={(event) => { setDir(event.target.value); setFolderDirty(true); setFolderSaved(false); }}
          onBlur={() => {
            if (!folderDirty) return;
            setDir(normalizeDisplayPath(dir));
          }}
          className="app-input min-w-0 flex-1"
          placeholder="C:\\Users\\you\\.lmstudio\\models"
        />
        <button type="button" onClick={() => void browse()} disabled={scanning} className="app-button app-button--secondary shrink-0">{t("panel.browse")}</button>
        <button type="button" onClick={() => { const displayPath = normalizeDisplayPath(dir); setDir(displayPath); void store.updateConfig({ models_dir: displayPath }).then(() => { setFolderDirty(false); setFolderSaved(true); requestedScanDirRef.current = displayPath; setScanRequest((current) => current + 1); }).catch((error) => notify(`${t("panel.saveFailed")}: ${error instanceof Error ? error.message : String(error)}`)); }} disabled={!folderDirty || scanning} className="app-button app-button--secondary shrink-0">{t("panel.saveFolder")}</button>
        <button type="button" onClick={() => setScanRequest((current) => current + 1)} disabled={scanning} className="app-button app-button--primary shrink-0">{scanning ? t("panel.scanning") : t("panel.rescan")}</button>
        {scanning && <button type="button" onClick={cancelScan} className="app-button app-button--secondary shrink-0">{t("panel.cancelScan")}</button>}
      </div>

      <div className="mt-4 rounded-xl border p-4" style={{ borderColor: "var(--board-border)", background: "var(--board-panel)" }}>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="app-eyebrow">{t("panel.activeModel")}</div>
            {selected ? <div className="truncate text-[15px] font-semibold" style={{ color: "var(--board-ink)" }} title={normalizeDisplayPath(selected)}>{visible.find((model) => model.path === selected)?.name ?? normalizeDisplayPath(selected).split(/[\\/]/).pop()}</div> : <div className="text-[13px]" style={{ color: "var(--board-faint)" }}>{t("panel.noneSelected")}</div>}
            <div className="mt-1 break-words text-xs" style={{ color: "var(--board-muted)" }}>{t("ui.modelsBackendLine", { backend: cfg?.active_backend || "PATH", build: cfg?.active_build ? buildNumber(cfg.active_build) : "system", port: cfg?.port ?? "—" })}</div>
            <div className={`models-status-line mt-1 ${store.status.memory ? "" : "is-empty"}`} title={store.status.memory ? t("ui.modelsMemoryLine", { total: store.status.memory.total_mb.toLocaleString(), model: store.status.memory.model_mb.toLocaleString(), kv: store.status.memory.kv_mb.toLocaleString(), source: store.status.memory.source }) : undefined}>
              {store.status.memory ? t("ui.modelsMemoryLine", { total: store.status.memory.total_mb.toLocaleString(), model: store.status.memory.model_mb.toLocaleString(), kv: store.status.memory.kv_mb.toLocaleString(), source: store.status.memory.source }) : "—"}
            </div>
            <div className={`models-status-line mt-1 ${store.status.lifecycle ? "" : "is-empty"}`} title={store.status.lifecycle ? t("ui.modelsSlotsLine", { parallel: store.status.lifecycle.parallel || "auto", sleep: store.status.lifecycle.sleep_idle_seconds < 0 ? "off" : `${store.status.lifecycle.sleep_idle_seconds}s`, idle: store.status.lifecycle.idle_seconds ?? store.status.idle_seconds ?? 0, requests: store.status.lifecycle.active_requests ?? store.status.active_requests ?? 0 }) : undefined}>
              {store.status.lifecycle ? <>{t("ui.modelsSlotsLine", { parallel: store.status.lifecycle.parallel || "auto", sleep: store.status.lifecycle.sleep_idle_seconds < 0 ? "off" : `${store.status.lifecycle.sleep_idle_seconds}s`, idle: store.status.lifecycle.idle_seconds ?? store.status.idle_seconds ?? 0, requests: store.status.lifecycle.active_requests ?? store.status.active_requests ?? 0 })}{store.status.lifecycle.auto_unload_due ? ` · ${t("ui.autoUnloadDue")}` : ""}</> : "—"}
            </div>
          </div>
          <div className="models-header-actions flex min-w-0 w-full flex-wrap flex-nowrap items-center gap-2 overflow-x-auto lg:ml-auto lg:w-auto lg:justify-end" data-testid="models-header-actions">
            {serverRunning ? <div className="flex flex-wrap items-center gap-2"><button type="button" onClick={() => void api.unloadModel().then(() => notify(t("ui.unloadedOk"))).catch((error) => notify(`${t("ui.unloadFailed")}: ${error instanceof Error ? error.message : String(error)}`))} disabled={store.busy} className="app-button app-button--secondary app-button--sm">{t("ui.unloadModel")}</button><button type="button" onClick={() => void store.stop()} disabled={store.busy} className="app-button app-button--danger app-button--sm">{t("panel.stopServer")}</button></div> : <button type="button" onClick={() => void start()} disabled={!selected || store.busy} className="app-button app-button--primary">{t("panel.startServer")}</button>}
          </div>
        </div>
        {(store.status.state === "failed" || store.status.state === "crashed") && store.status.error && (
          <div className="mt-3 max-h-48 overflow-auto rounded-lg border p-3 text-xs leading-relaxed" style={{ borderColor: "var(--tone-error-border)", background: "var(--tone-error-bg)", color: "var(--tone-error-ink)" }} role="alert">
            <div className="mb-1 font-semibold">{t("ui.serverFailedTitle", { state: store.status.state })}</div>
            <pre className="whitespace-pre-wrap break-words">{store.status.error}</pre>
          </div>
        )}
      </div>

      </>}

      {focus !== "library" && <section className="mt-3.5 rounded-xl border p-4" style={{ borderColor: "var(--board-border)", background: "var(--board-panel)" }} aria-labelledby="lora-heading">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="lora-heading" className="text-sm font-semibold" style={{ color: "var(--board-ink)" }}>{t("panel.loraAdapters")}</h2>
            <p className="mt-1 text-xs" style={{ color: "var(--board-muted)" }}>{t("ui.loraSectionHint")}</p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs" style={{ color: "var(--board-muted)" }} htmlFor="lora-scale">{t("ui.loraScale")}</label>
            <input id="lora-scale" value={adapterScale} onChange={(event) => setAdapterScale(event.target.value)} inputMode="decimal" className="app-input w-16 h-7 text-xs" />
            <button type="button" onClick={() => void addAdapter()} disabled={store.busy} className="app-button app-button--primary app-button--sm">{t("ui.loraAdd")}</button>
          </div>
        </div>
        {(cfg?.lora_adapters ?? []).length > 0 ? <div className="mt-3 space-y-2">{(cfg?.lora_adapters ?? []).map((adapter) => { const displayPath = normalizeDisplayPath(adapter.path); return <div key={adapter.path} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2" style={{ borderColor: "var(--board-border)", background: "var(--board-surface-muted)" }}><div className="min-w-0 flex-1"><div className="truncate text-xs font-medium" style={{ color: "var(--board-ink)" }} title={displayPath}>{displayPath.split(/[\\/]/).pop()}</div><div className="truncate text-[11px]" style={{ color: "var(--board-faint)" }} title={displayPath}>{displayPath}</div></div><span className="text-[11px] tabular-nums" style={{ color: "var(--board-muted)" }}>{t("ui.loraStartupScale", { scale: adapter.scale })}</span><button type="button" onClick={() => void removeAdapter(adapter.path)} disabled={store.busy} className="app-button app-button--ghost app-button--sm text-xs">{t("panel.remove")}</button></div>; })}</div> : <div className="mt-3 text-xs" style={{ color: "var(--board-faint)" }}>{t("ui.loraNoStartup")}</div>}
        {serverRunning && <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--board-border)" }}><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-medium" style={{ color: "var(--board-ink)" }}>{t("ui.loraServerAdapters")}</span><div className="flex gap-2"><button type="button" onClick={() => void refreshServerAdapters()} disabled={adapterBusy} className="app-button app-button--secondary app-button--sm">{adapterBusy ? t("ui.reading") : t("ui.refresh")}</button><button type="button" onClick={() => void applyServerAdapters()} disabled={adapterBusy || serverAdapters.length === 0} className="app-button app-button--primary app-button--sm">{t("ui.loraApplyScales")}</button></div></div>{serverAdapters.length > 0 ? <div className="mt-2 space-y-2">{serverAdapters.map((adapter) => { const displayPath = normalizeDisplayPath(adapter.path); return <label key={adapter.id} className="flex items-center gap-2 text-xs" style={{ color: "var(--board-muted)" }}><span className="min-w-0 flex-1 truncate" title={displayPath}>{displayPath.split(/[\\/]/).pop()}</span><input value={serverAdapterScales[adapter.id] ?? String(adapter.scale)} onChange={(event) => setServerAdapterScales((current) => ({ ...current, [adapter.id]: event.target.value }))} inputMode="decimal" className="app-input w-16 h-7 text-xs" aria-label={t("ui.loraScaleFor", { name: displayPath.split(/[\\/]/).pop() ?? displayPath })} /></label>; })}</div> : <div className="mt-2 text-xs" style={{ color: "var(--board-faint)" }}>{t("ui.loraNoServerAdapters")}</div>}</div>}
      </section>}

      {focus !== "lora" && <div className="mt-4 flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2.5"><h2 className="text-sm font-semibold" style={{ color: "var(--board-ink)" }}>{t("panel.models")} {models ? `(${visible.length})` : ""}</h2><input value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder={t("panel.modelFilterPlaceholder")} aria-label={t("panel.searchModels")} className="app-input min-w-0 max-w-xs flex-1 h-7 text-xs" /></div>
        <label className="flex items-center gap-2 text-xs" style={{ color: "var(--board-muted)" }}><input type="checkbox" checked={showVision} onChange={(event) => setShowVision(event.target.checked)} style={{ accentColor: "var(--board-accent-solid)" }} /> {t("panel.visionModels")}</label>
      </div>}

      <ConfirmDialog
        open={pendingConfirm !== null}
        title={pendingConfirm?.title ?? t("panel.confirmAction")}
        description={pendingConfirm?.description ?? ""}
        confirmLabel={pendingConfirm?.confirmLabel ?? t("common.confirm")}
        onConfirm={() => pendingConfirm?.onConfirm()}
        onCancel={() => setPendingConfirm(null)}
      />

      {focus !== "lora" && <div className="models-model-list mt-2.5 min-w-0 overflow-hidden rounded-xl border" style={{ borderColor: "var(--board-border)" }} data-testid="models-list" role="list" aria-label={t("panel.ariaGgufModels")} aria-busy={scanning}>
        {scanning && <div className="p-6 text-center text-sm" style={{ color: "var(--board-muted)" }} role="status">{t("panel.scanning")}</div>}
        {!scanning && scanError && <div className="m-3 break-words rounded-lg border p-3 text-xs leading-relaxed" style={{ borderColor: "var(--tone-error-border)", background: "var(--tone-error-bg)", color: "var(--tone-error-ink)" }} role="alert">{scanError}<button type="button" onClick={() => void scan()} className="app-button app-button--secondary app-button--sm mt-2">{t("panel.retry")}</button></div>}
        {!scanning && models === null && !scanError && <div className="p-6 text-center text-sm" style={{ color: "var(--board-faint)" }} role="status">{t("ui.modelsLoading")}</div>}
        {!scanning && models !== null && !scanError && visible.length === 0 && (
          <div className="app-empty-state">
            <h3>{t("panel.noModels")}</h3>
            <p>{t("ui.modelsEmptyBody", { dir: dir ? normalizeDisplayPath(dir) : t("ui.modelsEmptyFolder") })}</p>
            <div className="app-empty-actions">
              <button type="button" className="app-button app-button--primary" onClick={() => void browse()}>{t("panel.chooseFolder")}</button>
              <button type="button" className="app-button app-button--secondary" onClick={() => void scan()}>{t("panel.rescan")}</button>
            </div>
          </div>
        )}
        {visible.map((model) => {
          const running = serverRunning && selected === model.path;
          const actionLabel = running ? t("ui.rowRunning") : serverRunning ? t("ui.rowRestartSwitch") : t("ui.rowStart");
          const isSelected = model.path === selected;
          return (
            <div
              key={model.path}
              role="listitem"
              className={`models-model-row flex min-w-0 flex-nowrap items-center justify-between gap-3 border-b px-2 py-1.5 last:border-0 ${isSelected ? "is-selected" : ""}`}
              style={{ borderColor: "var(--board-border)", background: isSelected ? "var(--board-accent-soft)" : undefined }}
            >
              <button
                type="button"
                aria-current={isSelected ? "true" : undefined}
                aria-label={t("ui.selectModelNamed", { name: model.name })}
                disabled={serverRunning}
                title={serverRunning ? t("ui.useRowAction") : undefined}
                onClick={() => void selectModel(model)}
                className="min-w-0 flex-1 rounded-lg px-3 py-2 text-left hover:bg-[var(--board-surface-muted)] disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--board-focus)]"
                style={{ background: isSelected ? "transparent" : undefined }}
              >
                <span className="block truncate text-sm font-medium" style={{ color: "var(--board-ink)" }}>{model.name}</span>
                <span className="block truncate text-xs" style={{ color: "var(--board-faint)" }} title={normalizeDisplayPath(model.path)}>{normalizeDisplayPath(model.path)}</span>
              </button>
              <div className="models-model-actions flex min-w-0 flex-nowrap items-center justify-end gap-1.5 overflow-x-auto px-1">
                <span className="shrink-0 text-xs tabular-nums" style={{ color: "var(--board-faint)" }}>{model.size_mb.toFixed(0)} MB</span>
                {model.is_vision && <span className="rounded-full border px-1.5 py-0.5 text-[10px] font-medium" style={{ borderColor: "var(--board-border)", background: "var(--board-surface-muted)", color: "var(--board-muted)" }}>{t("ui.visionTag")}</span>}
                {isSelected && <span className="rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ background: "var(--tone-success-bg)", color: "var(--tone-success-ink)", border: "1px solid var(--tone-success-border)" }}>{t("ui.activeTag")}</span>}
                {model.is_vision && <button type="button" onClick={() => { if (cfg?.mmproj !== model.path) void setProjector(model); }} disabled={cfg?.mmproj === model.path || store.busy || !projectorChangeAllowed(store.status.state)} title={!projectorChangeAllowed(store.status.state) ? t("ui.stopBeforeProjector") : undefined} className="app-button app-button--secondary app-button--sm shrink-0">{cfg?.mmproj === model.path ? t("ui.rowProjectorActive") : t("ui.rowUseProjector")}</button>}
                <button type="button" onClick={() => void copyPath(model.path)} className="app-button app-button--ghost app-button--sm shrink-0">{t("panel.copyPath")}</button>
                <button type="button" onClick={() => void removeModel(model)} disabled={running || store.busy || serverRunning} title={serverRunning ? t("ui.stopBeforeDelete") : undefined} className="app-button app-button--ghost app-button--sm shrink-0" style={{ color: "var(--board-danger)" }}>{t("panel.delete")}</button>
                <button type="button" onClick={() => { if (!running) void selectAndStart(model); }} disabled={running || store.busy} className="app-button app-button--primary app-button--sm shrink-0">{actionLabel}</button>
              </div>
            </div>
          );
        })}
      </div>}
    </div>
  );
}
