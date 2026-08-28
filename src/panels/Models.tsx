import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { AppStore } from "../store";
import { QWEN38_CHAT_OPTIONS, QWEN38_DFLASH2_DEFAULTS, QWEN38_DFLASH2_PR_BUILD, QWEN38_DEFAULTS, QWEN38_SERVER_ARGS } from "./qwenDefaults";
import { isCurrentScan, nextScanGeneration } from "./scanGeneration";
import { projectorChangeAllowed } from "./visionState";
import ConfirmDialog from "../components/ConfirmDialog";
import FeedbackBanner from "../components/FeedbackBanner";
import { useI18n } from "../i18n";
import { pt } from "../panelI18n";
import { ut } from "../uiI18n";
import { normalizeDisplayPath } from "../lifecycleUtils";
import { shouldConfirmDestructive } from "../preferences";
import { buildNumber } from "../runtimeUtils";


export default function ModelsPanel({ store, focus = "library" }: { store: AppStore; focus?: "library" | "lora" }) {
  const { t, locale } = useI18n();

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
  const [flash, setFlash] = useState<string | null>(null);
  const [adapterScale, setAdapterScale] = useState("1");
  const [serverAdapters, setServerAdapters] = useState<api.ServerLoraAdapter[]>([]);
  const [serverAdapterScales, setServerAdapterScales] = useState<Record<number, string>>({});
  const [adapterBusy, setAdapterBusy] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<{ title: string; description: string; confirmLabel: string; onConfirm: () => void } | null>(null);
  const scanTimer = useRef<number | null>(null);
  const scanGeneration = useRef(0);
  const requestedScanDirRef = useRef("");
  const flashTimer = useRef<number | null>(null);

  const notify = (message: string) => {
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    setFlash(message);
    flashTimer.current = window.setTimeout(() => setFlash(null), 4000);
  };

  const dismissFlash = () => {
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    setFlash(null);
  };

  const scan = useCallback(async () => {
    const generation = nextScanGeneration(scanGeneration.current);
    scanGeneration.current = generation;
    if (!dir.trim()) {
      setScanError(ut(locale, "modelsSetDirFirst"));
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
  }, [dir, locale]);

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
  const serverRunning = store.status.state === "running";
  const selectedName = selected.split(/[\\/]/).pop() ?? selected;
  const isQwen38 = /qwen\s*3(?:\.8|[_-]8)/i.test(selectedName);
  const dflash2RuntimeReady = cfg?.active_build === QWEN38_DFLASH2_PR_BUILD;

  const refreshServerAdapters = useCallback(async () => {
    if (store.status.state !== "running" || !store.status.url || !store.status.api_key) {
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
      notify(`${ut(locale, "loraHotSwapUnavailable")}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setAdapterBusy(false);
    }
  }, [locale, store.status.api_key, store.status.state, store.status.url]);

  useEffect(() => {
    void refreshServerAdapters();
  }, [refreshServerAdapters]);

  const addAdapter = async () => {
    try {
      const path = await api.pickLoraAdapter();
      if (!path) return;
      const scale = Number.parseFloat(adapterScale);
      if (!Number.isFinite(scale) || scale < 0 || scale > 4) {
        notify(ut(locale, "loraScaleRange"));
        return;
      }
      const next = [...(cfg?.lora_adapters ?? []).filter((adapter) => adapter.path !== path), { path, scale, enabled: scale > 0 }];
      await store.updateConfig({ lora_adapters: next });
      notify(store.status.state === "running" ? ut(locale, "loraSavedRestart") : ut(locale, "loraSaved"));
    } catch (error) {
      notify(`${ut(locale, "loraSelectionFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const removeAdapter = async (path: string) => {
    try {
      await store.updateConfig({ lora_adapters: (cfg?.lora_adapters ?? []).filter((adapter) => adapter.path !== path) });
      notify(ut(locale, "loraRemoved"));
    } catch (error) {
      notify(`${ut(locale, "loraUpdateFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const applyServerAdapters = async () => {
    if (!store.status.url || !store.status.api_key) return;
    try {
      await api.setServerLoraAdapters(store.status.url, store.status.api_key, serverAdapters.map((adapter) => ({ id: adapter.id, scale: Math.max(0, Math.min(4, Number.parseFloat(serverAdapterScales[adapter.id] ?? String(adapter.scale)) || 0)) })));
      await refreshServerAdapters();
      notify(ut(locale, "loraScalesApplied"));
    } catch (error) {
      notify(`${ut(locale, "loraHotSwapFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const selectModel = async (model: api.GgufModel) => {
    try {
      await store.updateConfig({ active_model: model.path });
      // 모델 선택은 저장/서버 시작 알림을 표시하지 않는다.
    } catch (error) {
      notify(`${pt(locale, "saveFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const setProjector = async (model: api.GgufModel) => {
    if (!projectorChangeAllowed(store.status.state)) {
      notify(ut(locale, "stopBeforeProjector"));
      return;
    }
    try {
      await store.updateConfig({ mmproj: model.path });
      // 프로젝터 선택도 선택 상태 변경이므로 성공 알림을 표시하지 않는다.
    } catch (error) {
      notify(`${pt(locale, "saveFailed")}: ${error instanceof Error ? error.message : String(error)}`);
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
      notify(`${pt(locale, "browseFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const start = async () => {
    try {
      await store.start();
      notify(pt(locale, "serverStarted"));
    } catch (error) {
      notify(`${pt(locale, "startFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const performSelectAndStart = async (model: api.GgufModel) => {
    const switching = serverRunning && selected !== model.path;
    try {
      if (switching) await store.stop();
      const next = await store.updateConfig({ active_model: model.path });
      await store.start(next);
      notify(switching ? `${pt(locale, "restartServer")}: ${model.name}` : `${pt(locale, "serverStarted")}: ${model.name}`);
    } catch (error) {
      notify(`${pt(locale, "startFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const selectAndStart = async (model: api.GgufModel) => {
    const switching = serverRunning && selected !== model.path;
    if (switching && shouldConfirmDestructive()) {
      setPendingConfirm({
        title: pt(locale, "restartSwitchQuestion"),
        description: ut(locale, "switchModelBody", { name: model.name }),
        confirmLabel: pt(locale, "restartSwitch"),
        onConfirm: () => { setPendingConfirm(null); void performSelectAndStart(model); },
      });
      return;
    }
    await performSelectAndStart(model);
  };

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(normalizeDisplayPath(path));
      notify(ut(locale, "modelPathCopied"));
    } catch (error) {
      notify(`${pt(locale, "saveFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const removeModel = async (model: api.GgufModel) => {
    if (serverRunning) {
      notify(ut(locale, "stopBeforeDelete"));
      return;
    }
    const remove = async () => {
      setPendingConfirm(null);
      try {
        await api.deleteModel(model.path);
        notify(ut(locale, "deletedModelNamed", { name: model.name }));
        await scan();
      } catch (error) {
        notify(`${ut(locale, "deleteFailed")}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    if (!shouldConfirmDestructive()) { void remove(); return; }
    setPendingConfirm({
      title: ut(locale, "deleteModelTitle"),
      description: ut(locale, "deleteModelBody", { name: model.name }),
      confirmLabel: ut(locale, "deleteModelAction"),
      onConfirm: () => void remove(),
    });
  };

  const applyQwenProfile = async () => {
    try {
      await store.updateConfig({ ...QWEN38_DEFAULTS, mmproj: cfg?.mmproj ?? "", server_args: [...QWEN38_SERVER_ARGS], chat_options: QWEN38_CHAT_OPTIONS });
      notify(ut(locale, "qwenProfileApplied"));
    } catch (error) {
      notify(`${ut(locale, "profileApplyFailedShort")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const applyQwenDflash2Profile = async () => {
    if (!dflash2RuntimeReady) {
      notify(ut(locale, "qwenDflash2RuntimeRequired", { build: QWEN38_DFLASH2_PR_BUILD }));
      return;
    }
    try {
      await store.updateConfig({
        ...QWEN38_DEFAULTS,
        ...QWEN38_DFLASH2_DEFAULTS,
        mmproj: cfg?.mmproj ?? "",
        spec_draft_model: cfg?.spec_draft_model ?? "",
        server_args: [...QWEN38_SERVER_ARGS],
        chat_options: QWEN38_CHAT_OPTIONS,
      });
      notify(ut(locale, "qwenDflash2ProfileApplied"));
    } catch (error) {
      notify(`${ut(locale, "profileApplyFailedShort")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      {focus === "lora" && <div className="mb-4"><div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">{pt(locale, "models")}</div><h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-100">{pt(locale, "loraAdapters")}</h2><p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-500">{ut(locale, "loraDescription")}</p></div>}

      {/* Rendered outside the library-only fragment so LoRA actions report too. */}
      {flash && <FeedbackBanner tone="info" onDismiss={dismissFlash}>{flash}</FeedbackBanner>}

      {focus !== "lora" && <>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <label htmlFor="models-dir" className="shrink-0 text-sm text-slate-400">{pt(locale, "modelsDirectory")}</label>
        <input
          id="models-dir"
          value={dir}
          onChange={(event) => { setDir(event.target.value); setFolderDirty(true); setFolderSaved(false); }}
          onBlur={() => {
            if (!folderDirty) return;
            setDir(normalizeDisplayPath(dir));
          }}
          className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
          placeholder="C:\\Users\\you\\.lmstudio\\models"
        />
        <button type="button" onClick={() => void browse()} disabled={scanning} className="shrink-0 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 hover:bg-slate-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">{pt(locale, "browse")}</button>
        <button type="button" onClick={() => { const displayPath = normalizeDisplayPath(dir); setDir(displayPath); void store.updateConfig({ models_dir: displayPath }).then(() => { setFolderDirty(false); setFolderSaved(true); requestedScanDirRef.current = displayPath; setScanRequest((current) => current + 1); }).catch((error) => notify(`${pt(locale, "saveFailed")}: ${error instanceof Error ? error.message : String(error)}`)); }} disabled={!folderDirty || scanning} className="app-button app-button--secondary shrink-0">{pt(locale, "saveFolder")}</button>
        <button type="button" onClick={() => setScanRequest((current) => current + 1)} disabled={scanning} className="app-button app-button--primary shrink-0">{scanning ? pt(locale, "scanning") : pt(locale, "rescan")}</button>
        {scanning && <button type="button" onClick={cancelScan} className="app-button app-button--secondary shrink-0">{pt(locale, "cancelScan")}</button>}
      </div>

      {(folderSaved || folderDirty) && <div className="app-feedback app-feedback--info mt-2" role="status">
        <div className="app-feedback-body">{folderDirty ? pt(locale, "modelsChanged") : pt(locale, "modelsSaved")}</div>
        {folderSaved && !folderDirty && <span className="app-status-badge app-status-badge--success">{pt(locale, "saved")}</span>}
      </div>}

      <div className="mt-3 rounded-xl border border-slate-700 bg-slate-800/40 p-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-xs uppercase tracking-wide text-slate-500">{pt(locale, "activeModel")}</div>
            {selected ? <div className="truncate text-base font-medium text-slate-100" title={selected}>{visible.find((model) => model.path === selected)?.name ?? selected.split(/[\\/]/).pop()}</div> : <div className="text-base text-slate-500">{pt(locale, "noneSelected")}</div>}
            <div className="mt-1 break-words text-xs text-slate-500">{ut(locale, "modelsBackendLine", { backend: cfg?.active_backend || "PATH", build: cfg?.active_build ? buildNumber(cfg.active_build) : "system", port: cfg?.port ?? "—" })}</div>
            {store.status.memory && <div className="mt-1 break-words text-xs text-slate-500">{ut(locale, "modelsMemoryLine", { total: store.status.memory.total_mb.toLocaleString(), model: store.status.memory.model_mb.toLocaleString(), kv: store.status.memory.kv_mb.toLocaleString(), source: store.status.memory.source })}</div>}
            {store.status.lifecycle && <div className="mt-1 break-words text-xs text-slate-500">{ut(locale, "modelsSlotsLine", { parallel: store.status.lifecycle.parallel || "auto", sleep: store.status.lifecycle.sleep_idle_seconds < 0 ? "off" : `${store.status.lifecycle.sleep_idle_seconds}s`, idle: store.status.lifecycle.idle_seconds ?? store.status.idle_seconds ?? 0, requests: store.status.lifecycle.active_requests ?? store.status.active_requests ?? 0 })}{store.status.lifecycle.auto_unload_due ? ` · ${ut(locale, "autoUnloadDue")}` : ""}</div>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isQwen38 && <><button type="button" onClick={() => void applyQwenProfile()} disabled={store.busy || serverRunning} className="rounded-lg border border-indigo-700 bg-indigo-950/60 px-3 py-2 text-xs text-indigo-200 hover:bg-indigo-900 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">{ut(locale, "loadQwenProfile")}</button><button type="button" onClick={() => void applyQwenDflash2Profile()} disabled={store.busy || serverRunning || !dflash2RuntimeReady} title={!dflash2RuntimeReady ? ut(locale, "qwenDflash2RuntimeRequired", { build: QWEN38_DFLASH2_PR_BUILD }) : undefined} className="rounded-lg border border-fuchsia-700 bg-fuchsia-950/60 px-3 py-2 text-xs text-fuchsia-200 hover:bg-fuchsia-900 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-400">{ut(locale, "loadQwenDflash2Profile")}</button></>}
            {serverRunning ? <div className="flex items-center gap-2"><button type="button" onClick={() => void api.unloadModel().then(() => notify(ut(locale, "unloadedOk"))).catch((error) => notify(`${ut(locale, "unloadFailed")}: ${error instanceof Error ? error.message : String(error)}`))} disabled={store.busy} className="rounded-lg border border-amber-700 bg-amber-950/50 px-3 py-2 text-sm font-medium text-amber-200 hover:bg-amber-900/60 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300">{ut(locale, "unloadModel")}</button><button type="button" onClick={() => void store.stop()} disabled={store.busy} className="rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300">{pt(locale, "stopServer")}</button></div> : <button type="button" onClick={() => void start()} disabled={!selected || store.busy} className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300">{pt(locale, "startServer")}</button>}
          </div>
        </div>
        {(store.status.state === "failed" || store.status.state === "crashed") && store.status.error && (
          <div className="mt-3 max-h-48 overflow-auto rounded-lg border border-red-800 bg-red-950/50 p-3 text-xs text-red-300" role="alert">
            <div className="mb-1 font-medium text-red-200">{ut(locale, "serverFailedTitle", { state: store.status.state })}</div>
            <pre className="whitespace-pre-wrap break-words">{store.status.error}</pre>
          </div>
        )}
      </div>

      </>}

      {focus !== "library" && <section className="mt-3 rounded-xl border border-slate-700 bg-slate-800/30 p-4" aria-labelledby="lora-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 id="lora-heading" className="text-sm font-semibold text-slate-200">{pt(locale, "loraAdapters")}</h2>
            <p className="mt-1 text-xs text-slate-500">{ut(locale, "loraSectionHint")}</p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-500" htmlFor="lora-scale">{ut(locale, "loraScale")}</label>
            <input id="lora-scale" value={adapterScale} onChange={(event) => setAdapterScale(event.target.value)} inputMode="decimal" className="w-16 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400" />
            <button type="button" onClick={() => void addAdapter()} disabled={store.busy} className="rounded bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">{ut(locale, "loraAdd")}</button>
          </div>
        </div>
        {(cfg?.lora_adapters ?? []).length > 0 ? <div className="mt-3 space-y-2">{(cfg?.lora_adapters ?? []).map((adapter) => <div key={adapter.path} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2"><div className="min-w-0 flex-1"><div className="truncate text-xs text-slate-200" title={adapter.path}>{adapter.path.split(/[\\/]/).pop()}</div><div className="truncate text-[11px] text-slate-500" title={adapter.path}>{adapter.path}</div></div><span className="text-[11px] text-slate-400">{ut(locale, "loraStartupScale", { scale: adapter.scale })}</span><button type="button" onClick={() => void removeAdapter(adapter.path)} disabled={store.busy} className="rounded bg-slate-800 px-2 py-1 text-[11px] text-red-300 hover:bg-red-900/50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300">{pt(locale, "remove")}</button></div>)}</div> : <div className="mt-3 text-xs text-slate-500">{ut(locale, "loraNoStartup")}</div>}
        {serverRunning && <div className="mt-3 border-t border-slate-800 pt-3"><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-medium text-slate-300">{ut(locale, "loraServerAdapters")}</span><div className="flex gap-2"><button type="button" onClick={() => void refreshServerAdapters()} disabled={adapterBusy} className="rounded bg-slate-700 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-600 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">{adapterBusy ? ut(locale, "reading") : ut(locale, "refresh")}</button><button type="button" onClick={() => void applyServerAdapters()} disabled={adapterBusy || serverAdapters.length === 0} className="rounded bg-emerald-700 px-2 py-1 text-[11px] text-emerald-100 hover:bg-emerald-600 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300">{ut(locale, "loraApplyScales")}</button></div></div>{serverAdapters.length > 0 ? <div className="mt-2 space-y-2">{serverAdapters.map((adapter) => <label key={adapter.id} className="flex items-center gap-2 text-xs text-slate-400"><span className="min-w-0 flex-1 truncate" title={adapter.path}>{adapter.path.split(/[\\/]/).pop()}</span><input value={serverAdapterScales[adapter.id] ?? String(adapter.scale)} onChange={(event) => setServerAdapterScales((current) => ({ ...current, [adapter.id]: event.target.value }))} inputMode="decimal" className="w-16 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400" aria-label={ut(locale, "loraScaleFor", { name: adapter.path.split(/[\\/]/).pop() ?? adapter.path })} /></label>)}</div> : <div className="mt-2 text-xs text-slate-500">{ut(locale, "loraNoServerAdapters")}</div>}</div>}
      </section>}

      {focus !== "lora" && scanTruncated && <div className="mt-3 break-words rounded-lg border border-amber-800 bg-amber-950/50 px-3 py-2 text-sm text-amber-200" role="status">
        {ut(locale, "modelsScanTruncated")}
      </div>}

      {focus !== "lora" && <div className="mt-4 flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2"><h2 className="text-sm font-semibold text-slate-300">{pt(locale, "models")} {models ? `(${visible.length})` : ""}</h2><input value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder={pt(locale, "modelFilterPlaceholder")} aria-label={pt(locale, "searchModels")} className="min-w-0 max-w-xs flex-1 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400" /></div>
        <label className="flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={showVision} onChange={(event) => setShowVision(event.target.checked)} /> {pt(locale, "visionModels")}</label>
      </div>}

      <ConfirmDialog
        open={pendingConfirm !== null}
        title={pendingConfirm?.title ?? pt(locale, "confirmAction")}
        description={pendingConfirm?.description ?? ""}
        confirmLabel={pendingConfirm?.confirmLabel ?? t("common.confirm")}
        onConfirm={() => pendingConfirm?.onConfirm()}
        onCancel={() => setPendingConfirm(null)}
      />

      {focus !== "lora" && <div className="mt-2 min-h-0 flex-1 overflow-auto rounded-xl border border-slate-800" role="list" aria-label={pt(locale, "ariaGgufModels")} aria-busy={scanning}>
        {scanning && <div className="p-6 text-center text-sm text-slate-400" role="status">{pt(locale, "scanning")}</div>}
        {!scanning && scanError && <div className="m-4 break-words rounded-lg border border-red-800 bg-red-950/50 p-4 text-sm text-red-200" role="alert">{scanError}<button type="button" onClick={() => void scan()} className="mt-2 block rounded bg-red-900 px-2 py-1 text-xs hover:bg-red-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300">{pt(locale, "retry")}</button></div>}
        {!scanning && models === null && !scanError && <div className="p-6 text-center text-sm text-slate-400" role="status">{ut(locale, "modelsLoading")}</div>}
        {!scanning && models !== null && !scanError && visible.length === 0 && (
          <div className="app-empty-state">
            <div className="app-empty-icon" aria-hidden="true">⌂</div>
            <h3>{pt(locale, "noModels")}</h3>
            <p>{ut(locale, "modelsEmptyBody", { dir: dir || ut(locale, "modelsEmptyFolder") })}</p>
            <div className="app-empty-actions">
              <button type="button" className="app-button app-button--primary" onClick={() => void browse()}>{pt(locale, "chooseFolder")}</button>
              <button type="button" className="app-button app-button--secondary" onClick={() => void scan()}>{pt(locale, "rescan")}</button>
            </div>
          </div>
        )}
        {visible.map((model) => {
          const running = serverRunning && selected === model.path;
          const actionLabel = running ? ut(locale, "rowRunning") : serverRunning ? ut(locale, "rowRestartSwitch") : ut(locale, "rowStart");
          return (
            // The row holds several buttons, so selection lives on its own
            // button rather than on a focusable `role="listitem"` wrapper.
            <div
              key={model.path}
              role="listitem"
              className={`flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-1 py-1 last:border-0 ${model.path === selected ? "bg-indigo-950/40" : ""}`}
            >
              <button
                type="button"
                aria-current={model.path === selected ? "true" : undefined}
                aria-label={ut(locale, "selectModelNamed", { name: model.name })}
                disabled={serverRunning}
                title={serverRunning ? ut(locale, "useRowAction") : undefined}
                onClick={() => void selectModel(model)}
                className="min-w-0 flex-1 rounded-lg px-3 py-2 text-left hover:bg-slate-800/50 disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400"
              >
                <span className="block truncate text-sm font-medium text-slate-100">{model.name}</span>
                <span className="block truncate text-xs text-slate-500" title={normalizeDisplayPath(model.path)}>{normalizeDisplayPath(model.path)}</span>
              </button>
              <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 pr-3">
                <span className="shrink-0 text-xs text-slate-500">{model.size_mb.toFixed(0)} MB</span>
                {model.is_vision && <span className="rounded bg-purple-900/60 px-1.5 py-0.5 text-[10px] text-purple-300">{ut(locale, "visionTag")}</span>}
                {model.path === selected && <span className="rounded bg-emerald-900/60 px-2 py-0.5 text-[11px] text-emerald-300">{ut(locale, "activeTag")}</span>}
                {model.is_vision && <button type="button" onClick={() => { if (cfg?.mmproj !== model.path) void setProjector(model); }} disabled={cfg?.mmproj === model.path || store.busy || !projectorChangeAllowed(store.status.state)} title={!projectorChangeAllowed(store.status.state) ? ut(locale, "stopBeforeProjector") : undefined} className="shrink-0 rounded bg-purple-700 px-2 py-1.5 text-[11px] text-purple-100 hover:bg-purple-600 disabled:cursor-default disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-300">{cfg?.mmproj === model.path ? ut(locale, "rowProjectorActive") : ut(locale, "rowUseProjector")}</button>}
                <button type="button" onClick={() => void copyPath(model.path)} className="shrink-0 rounded bg-slate-700 px-2 py-1.5 text-[11px] text-slate-200 hover:bg-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">{pt(locale, "copyPath")}</button>
                <button type="button" onClick={() => void removeModel(model)} disabled={running || store.busy || serverRunning} title={serverRunning ? ut(locale, "stopBeforeDelete") : undefined} className="shrink-0 rounded bg-slate-700 px-2 py-1.5 text-[11px] text-red-300 hover:bg-red-900/60 disabled:cursor-default disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300">{pt(locale, "delete")}</button>
                <button type="button" onClick={() => { if (!running) void selectAndStart(model); }} disabled={running || store.busy} className="shrink-0 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:cursor-default disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">{actionLabel}</button>
              </div>
            </div>
          );
        })}
      </div>}
    </div>
  );
}
