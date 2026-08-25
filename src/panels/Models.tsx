import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { AppStore } from "../store";
import { QWEN38_CHAT_OPTIONS, QWEN38_DEFAULTS, QWEN38_SERVER_ARGS } from "./qwenDefaults";
import { isCurrentScan, nextScanGeneration } from "./scanGeneration";
import { projectorChangeAllowed } from "./visionState";
import { suppressModelRowSelection } from "./modelRowEvents";

export default function ModelsPanel({ store, focus = "library" }: { store: AppStore; focus?: "library" | "lora" }) {
  const cfg = store.cfg;
  const [models, setModels] = useState<api.GgufModel[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanTruncated, setScanTruncated] = useState(false);
  const [dir, setDir] = useState(cfg?.models_dir ?? "");
  const [showVision, setShowVision] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [adapterScale, setAdapterScale] = useState("1");
  const [serverAdapters, setServerAdapters] = useState<api.ServerLoraAdapter[]>([]);
  const [serverAdapterScales, setServerAdapterScales] = useState<Record<number, string>>({});
  const [adapterBusy, setAdapterBusy] = useState(false);
  const scanTimer = useRef<number | null>(null);
  const scanGeneration = useRef(0);
  const flashTimer = useRef<number | null>(null);

  const notify = (message: string) => {
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    setFlash(message);
    flashTimer.current = window.setTimeout(() => setFlash(null), 4000);
  };

  const scan = useCallback(async () => {
    const generation = nextScanGeneration(scanGeneration.current);
    scanGeneration.current = generation;
    if (!dir.trim()) {
      setScanError("Set a models directory first.");
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
  }, [dir]);

  useEffect(() => {
    if (cfg && !dir) setDir(cfg.models_dir);
  }, [cfg, dir]);

  useEffect(() => {
    scanGeneration.current = nextScanGeneration(scanGeneration.current);
    if (!dir.trim()) {
      setScanning(false);
      if (cfg) {
        setScanError("Set a models directory first.");
        setModels(null);
        setScanTruncated(false);
      }
      return;
    }
    if (scanTimer.current !== null) window.clearTimeout(scanTimer.current);
    scanTimer.current = window.setTimeout(() => void scan(), 500);
    return () => {
      if (scanTimer.current !== null) window.clearTimeout(scanTimer.current);
    };
  }, [dir, scan]);

  const visible = (models ?? []).filter((model) => showVision || !model.is_vision);
  const selected = cfg?.active_model ?? "";
  const serverRunning = store.status.state === "running";
  const selectedName = selected.split(/[\\/]/).pop() ?? selected;
  const isQwen38 = /qwen\s*3(?:\.8|[_-]8)/i.test(selectedName);

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
      notify(`LoRA hot-swap is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setAdapterBusy(false);
    }
  }, [store.status.api_key, store.status.state, store.status.url]);

  useEffect(() => {
    void refreshServerAdapters();
  }, [refreshServerAdapters]);

  const addAdapter = async () => {
    try {
      const path = await api.pickLoraAdapter();
      if (!path) return;
      const scale = Number.parseFloat(adapterScale);
      if (!Number.isFinite(scale) || scale < 0 || scale > 4) {
        notify("Adapter scale must be between 0 and 4.");
        return;
      }
      const next = [...(cfg?.lora_adapters ?? []).filter((adapter) => adapter.path !== path), { path, scale, enabled: scale > 0 }];
      await store.updateConfig({ lora_adapters: next });
      notify(store.status.state === "running" ? "LoRA saved. Restart to load a new adapter." : "LoRA adapter saved.");
    } catch (error) {
      notify(`LoRA selection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const removeAdapter = async (path: string) => {
    try {
      await store.updateConfig({ lora_adapters: (cfg?.lora_adapters ?? []).filter((adapter) => adapter.path !== path) });
      notify("LoRA adapter removed from the startup profile.");
    } catch (error) {
      notify(`LoRA update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const applyServerAdapters = async () => {
    if (!store.status.url || !store.status.api_key) return;
    try {
      await api.setServerLoraAdapters(store.status.url, store.status.api_key, serverAdapters.map((adapter) => ({ id: adapter.id, scale: Math.max(0, Math.min(4, Number.parseFloat(serverAdapterScales[adapter.id] ?? String(adapter.scale)) || 0)) })));
      await refreshServerAdapters();
      notify("LoRA scales applied to the running server.");
    } catch (error) {
      notify(`LoRA hot-swap failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const pickAndSave = async (model: api.GgufModel) => {
    try {
      await store.updateConfig({ active_model: model.path });
      notify(`Selected: ${model.name}`);
    } catch (error) {
      notify(`Selection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const setProjector = async (model: api.GgufModel) => {
    if (!projectorChangeAllowed(store.status.state)) {
      notify("Stop the server before changing the multimodal projector.");
      return;
    }
    try {
      await store.updateConfig({ mmproj: model.path });
      notify(`Projector selected: ${model.name}`);
    } catch (error) {
      notify(`Projector selection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const browse = async () => {
    try {
      const chosen = await api.pickModelsDir();
      if (!chosen) return;
      setDir(chosen);
      await store.updateConfig({ models_dir: chosen });
      notify(`Models directory saved: ${chosen}`);
    } catch (error) {
      notify(`Browse failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const start = async () => {
    try {
      await store.start();
      notify("Server started.");
    } catch (error) {
      notify(`Start failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const selectAndStart = async (model: api.GgufModel) => {
    const switching = serverRunning && selected !== model.path;
    if (switching && !window.confirm(`Switch to ${model.name}? The running server will restart.`)) return;
    try {
      if (switching) await store.stop();
      const next = await store.updateConfig({ active_model: model.path });
      await store.start(next);
      notify(switching ? `Restarted with ${model.name}.` : `Started with ${model.name}.`);
    } catch (error) {
      notify(`Start failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      notify("Model path copied.");
    } catch (error) {
      notify(`Copy failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const removeModel = async (model: api.GgufModel) => {
    if (serverRunning) {
      notify("Stop the server before deleting a model.");
      return;
    }
    if (!window.confirm(`Delete ${model.name} from disk? This cannot be undone.`)) return;
    try {
      await api.deleteModel(model.path);
      notify(`Deleted: ${model.name}`);
      await scan();
    } catch (error) {
      notify(`Delete failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const applyQwenProfile = async () => {
    try {
      await store.updateConfig({ ...QWEN38_DEFAULTS, mmproj: cfg?.mmproj ?? "", server_args: [...QWEN38_SERVER_ARGS], chat_options: QWEN38_CHAT_OPTIONS });
      notify("Qwen3.8 profile applied. Apply & restart in Tuning to use server-side changes.");
    } catch (error) {
      notify(`Profile apply failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      {focus === "lora" && <div className="mb-4"><div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Models</div><h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-900">LoRA adapters</h2><p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-500">Attach startup adapters or hot-swap scales while keeping the running server local.</p></div>}

      {focus !== "lora" && <>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <label htmlFor="models-dir" className="shrink-0 text-sm text-slate-400">Models directory</label>
        <input
          id="models-dir"
          value={dir}
          onChange={(event) => setDir(event.target.value)}
          onBlur={() => void store.updateConfig({ models_dir: dir }).catch((error) => notify(`Save failed: ${error instanceof Error ? error.message : String(error)}`))}
          className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
          placeholder="C:\\Users\\you\\.lmstudio\\models"
        />
        <button type="button" onClick={() => void browse()} disabled={scanning} className="shrink-0 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 hover:bg-slate-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">Browse…</button>
        <button type="button" onClick={() => void scan()} disabled={scanning} className="shrink-0 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">{scanning ? "Scanning…" : "Rescan"}</button>
      </div>

      {flash && <div className="mt-2 break-words rounded-lg border border-indigo-800 bg-indigo-950/50 px-3 py-2 text-sm text-indigo-200" role="status">{flash}</div>}

      <div className="mt-3 rounded-xl border border-slate-700 bg-slate-800/40 p-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-xs uppercase tracking-wide text-slate-500">Active model</div>
            {selected ? <div className="truncate text-base font-medium text-slate-100" title={selected}>{visible.find((model) => model.path === selected)?.name ?? selected.split(/[\\/]/).pop()}</div> : <div className="text-base text-slate-500">none selected</div>}
            <div className="mt-1 break-words text-xs text-slate-500">backend: {cfg?.active_backend || "PATH"} · build: {cfg?.active_build || "system"} · port {cfg?.port}</div>
            {store.status.memory && <div className="mt-1 break-words text-xs text-slate-500">estimated memory: {store.status.memory.total_mb.toLocaleString()} MB · model {store.status.memory.model_mb.toLocaleString()} MB · KV {store.status.memory.kv_mb.toLocaleString()} MB · {store.status.memory.source}</div>}
            {store.status.lifecycle && <div className="mt-1 break-words text-xs text-slate-500">slots: {store.status.lifecycle.parallel || "auto"} · idle sleep: {store.status.lifecycle.sleep_idle_seconds < 0 ? "off" : `${store.status.lifecycle.sleep_idle_seconds}s`} · idle for {store.status.lifecycle.idle_seconds ?? store.status.idle_seconds ?? 0}s · active requests {store.status.lifecycle.active_requests ?? store.status.active_requests ?? 0}{store.status.lifecycle.auto_unload_due ? " · auto-unload due" : ""}</div>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isQwen38 && <button type="button" onClick={() => void applyQwenProfile()} disabled={store.busy || serverRunning} className="rounded-lg border border-indigo-700 bg-indigo-950/60 px-3 py-2 text-xs text-indigo-200 hover:bg-indigo-900 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">Load Qwen3.8 profile</button>}
            {serverRunning ? <div className="flex items-center gap-2"><button type="button" onClick={() => void api.unloadModel().then(() => notify("Model unloaded and server stopped.")).catch((error) => notify(`Unload failed: ${error instanceof Error ? error.message : String(error)}`))} disabled={store.busy} className="rounded-lg border border-amber-700 bg-amber-950/50 px-3 py-2 text-sm font-medium text-amber-200 hover:bg-amber-900/60 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300">Unload model</button><button type="button" onClick={() => void store.stop()} disabled={store.busy} className="rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300">Stop server</button></div> : <button type="button" onClick={() => void start()} disabled={!selected || store.busy} className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300">Start server</button>}
          </div>
        </div>
        {(store.status.state === "failed" || store.status.state === "crashed") && store.status.error && (
          <div className="mt-3 max-h-48 overflow-auto rounded-lg border border-red-800 bg-red-950/50 p-3 text-xs text-red-300" role="alert">
            <div className="mb-1 font-medium text-red-200">Server {store.status.state}</div>
            <pre className="whitespace-pre-wrap break-words">{store.status.error}</pre>
          </div>
        )}
      </div>

      </>}

      {focus !== "library" && <section className="mt-3 rounded-xl border border-slate-700 bg-slate-800/30 p-4" aria-labelledby="lora-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 id="lora-heading" className="text-sm font-semibold text-slate-200">LoRA adapters</h2>
            <p className="mt-1 text-xs text-slate-500">Attach startup adapters or hot-swap scales when this llama.cpp build exposes <code>/lora-adapters</code>.</p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-500" htmlFor="lora-scale">scale</label>
            <input id="lora-scale" value={adapterScale} onChange={(event) => setAdapterScale(event.target.value)} inputMode="decimal" className="w-16 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400" />
            <button type="button" onClick={() => void addAdapter()} disabled={store.busy} className="rounded bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">Add GGUF</button>
          </div>
        </div>
        {(cfg?.lora_adapters ?? []).length > 0 ? <div className="mt-3 space-y-2">{(cfg?.lora_adapters ?? []).map((adapter) => <div key={adapter.path} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900/50 px-3 py-2"><div className="min-w-0 flex-1"><div className="truncate text-xs text-slate-200" title={adapter.path}>{adapter.path.split(/[\\/]/).pop()}</div><div className="truncate text-[11px] text-slate-500" title={adapter.path}>{adapter.path}</div></div><span className="text-[11px] text-slate-400">startup ×{adapter.scale}</span><button type="button" onClick={() => void removeAdapter(adapter.path)} disabled={store.busy} className="rounded bg-slate-800 px-2 py-1 text-[11px] text-red-300 hover:bg-red-900/50 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300">Remove</button></div>)}</div> : <div className="mt-3 text-xs text-slate-500">No startup adapters configured.</div>}
        {serverRunning && <div className="mt-3 border-t border-slate-800 pt-3"><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-medium text-slate-300">Running server adapters</span><div className="flex gap-2"><button type="button" onClick={() => void refreshServerAdapters()} disabled={adapterBusy} className="rounded bg-slate-700 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-600 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">{adapterBusy ? "Reading…" : "Refresh"}</button><button type="button" onClick={() => void applyServerAdapters()} disabled={adapterBusy || serverAdapters.length === 0} className="rounded bg-emerald-700 px-2 py-1 text-[11px] text-emerald-100 hover:bg-emerald-600 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300">Apply scales</button></div></div>{serverAdapters.length > 0 ? <div className="mt-2 space-y-2">{serverAdapters.map((adapter) => <label key={adapter.id} className="flex items-center gap-2 text-xs text-slate-400"><span className="min-w-0 flex-1 truncate" title={adapter.path}>{adapter.path.split(/[\\/]/).pop()}</span><input value={serverAdapterScales[adapter.id] ?? String(adapter.scale)} onChange={(event) => setServerAdapterScales((current) => ({ ...current, [adapter.id]: event.target.value }))} inputMode="decimal" className="w-16 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400" aria-label={`Scale ${adapter.path.split(/[\\/]/).pop()}`} /></label>)}</div> : <div className="mt-2 text-xs text-slate-500">No adapters reported by the running server. New adapters require a restart.</div>}</div>}
      </section>}

      {focus !== "lora" && scanTruncated && <div className="mt-3 break-words rounded-lg border border-amber-800 bg-amber-950/50 px-3 py-2 text-sm text-amber-200" role="status">
        Scan was truncated by a safety limit. Narrow the directory to see every model.
      </div>}

      {focus !== "lora" && <div className="mt-4 flex min-w-0 flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-300">Models {models ? `(${visible.length})` : ""}</h2>
        <label className="flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={showVision} onChange={(event) => setShowVision(event.target.checked)} /> show vision sidecars (mmproj)</label>
      </div>}

      {focus !== "lora" && <div className="mt-2 min-h-0 flex-1 overflow-auto rounded-xl border border-slate-800" role="list" aria-label="GGUF models" aria-busy={scanning}>
        {scanning && <div className="p-6 text-center text-sm text-slate-400" role="status">Scanning for *.gguf…</div>}
        {!scanning && scanError && <div className="m-4 break-words rounded-lg border border-red-800 bg-red-950/50 p-4 text-sm text-red-200" role="alert">{scanError}<button type="button" onClick={() => void scan()} className="mt-2 block rounded bg-red-900 px-2 py-1 text-xs hover:bg-red-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300">Retry scan</button></div>}
        {!scanning && models === null && !scanError && <div className="p-6 text-center text-sm text-slate-400" role="status">Loading models…</div>}
        {!scanning && models !== null && !scanError && visible.length === 0 && <div className="p-6 text-center text-sm text-slate-500">No GGUF models found in this directory.</div>}
        {visible.map((model) => {
          const running = serverRunning && selected === model.path;
          const actionLabel = running ? "Running ✓" : serverRunning ? "Restart (switch model)" : "Start";
          return (
            <div
              key={model.path}
              role="listitem"
              aria-current={model.path === selected ? "true" : undefined}
              tabIndex={0}
              onClick={() => { if (!serverRunning) void pickAndSave(model); else if (model.path !== selected) notify("Use the row action to restart and switch models."); }}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (!serverRunning) void pickAndSave(model); } }}
              className={`flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3 last:border-0 hover:bg-slate-800/50 focus-visible:bg-slate-800/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400 ${model.path === selected ? "bg-indigo-950/40" : ""}`}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-slate-100">{model.name}</div>
                <div className="truncate text-xs text-slate-500" title={model.path}>{model.path}</div>
              </div>
              <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                <span className="shrink-0 text-xs text-slate-500">{model.size_mb.toFixed(0)} MB</span>
                {model.is_vision && <span className="rounded bg-purple-900/60 px-1.5 py-0.5 text-[10px] text-purple-300">vision</span>}
                {model.path === selected && <span className="rounded bg-emerald-900/60 px-2 py-0.5 text-[11px] text-emerald-300">active</span>}
                {model.is_vision && <button type="button" onClick={(event) => { event.stopPropagation(); if (cfg?.mmproj !== model.path) void setProjector(model); }} onKeyDown={suppressModelRowSelection} disabled={cfg?.mmproj === model.path || store.busy || !projectorChangeAllowed(store.status.state)} className="shrink-0 rounded bg-purple-700 px-2 py-1.5 text-[11px] text-purple-100 hover:bg-purple-600 disabled:cursor-default disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-300">{cfg?.mmproj === model.path ? "Projector ✓" : "Use as projector"}</button>}
                <button type="button" onClick={(event) => { event.stopPropagation(); void copyPath(model.path); }} onKeyDown={suppressModelRowSelection} className="shrink-0 rounded bg-slate-700 px-2 py-1.5 text-[11px] text-slate-200 hover:bg-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">Copy path</button>
                <button type="button" onClick={(event) => { event.stopPropagation(); void removeModel(model); }} onKeyDown={suppressModelRowSelection} disabled={running || store.busy || serverRunning} className="shrink-0 rounded bg-slate-700 px-2 py-1.5 text-[11px] text-red-300 hover:bg-red-900/60 disabled:cursor-default disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300">Delete</button>
                <button type="button" onClick={(event) => { event.stopPropagation(); if (!running) void selectAndStart(model); }} onKeyDown={suppressModelRowSelection} disabled={running || store.busy} className="shrink-0 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:cursor-default disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">{actionLabel}</button>
              </div>
            </div>
          );
        })}
      </div>}
    </div>
  );
}
