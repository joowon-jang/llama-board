import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { AppStore } from "../store";

export default function ModelsPanel({ store }: { store: AppStore }) {
  const cfg = store.cfg;
  const [models, setModels] = useState<api.GgufModel[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [dir, setDir] = useState(cfg?.models_dir ?? "");
  const [showVision, setShowVision] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const scanTimer = useRef<number | null>(null);

  const notify = (message: string) => {
    setFlash(message);
    window.setTimeout(() => setFlash(null), 4000);
  };

  const scan = useCallback(async () => {
    if (!dir.trim()) {
      setScanError("Set a models directory first.");
      setModels(null);
      return;
    }
    setScanning(true);
    setScanError(null);
    try {
      setModels(await api.listModels(dir));
    } catch (error) {
      setScanError(error instanceof Error ? error.message : String(error));
      setModels([]);
    } finally {
      setScanning(false);
    }
  }, [dir]);

  useEffect(() => {
    if (cfg && !dir) setDir(cfg.models_dir);
  }, [cfg, dir]);

  useEffect(() => {
    if (!dir.trim()) return;
    if (scanTimer.current !== null) window.clearTimeout(scanTimer.current);
    scanTimer.current = window.setTimeout(() => void scan(), 500);
    return () => {
      if (scanTimer.current !== null) window.clearTimeout(scanTimer.current);
    };
  }, [dir, scan]);

  const visible = (models ?? []).filter((model) => showVision || !model.is_vision);
  const selected = cfg?.active_model ?? "";
  const serverRunning = store.status.state === "running";

  const pickAndSave = async (model: api.GgufModel) => {
    try {
      await store.updateConfig({ active_model: model.path });
      notify(`Selected: ${model.name}`);
    } catch (error) {
      notify(`Selection failed: ${error instanceof Error ? error.message : String(error)}`);
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

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
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
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {serverRunning ? <button type="button" onClick={() => void store.stop()} disabled={store.busy} className="rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300">Stop server</button> : <button type="button" onClick={() => void start()} disabled={!selected || store.busy} className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300">Start server</button>}
          </div>
        </div>
        {(store.status.state === "failed" || store.status.state === "crashed") && store.status.error && (
          <div className="mt-3 max-h-48 overflow-auto rounded-lg border border-red-800 bg-red-950/50 p-3 text-xs text-red-300" role="alert">
            <div className="mb-1 font-medium text-red-200">Server {store.status.state}</div>
            <pre className="whitespace-pre-wrap break-words">{store.status.error}</pre>
          </div>
        )}
      </div>

      <div className="mt-4 flex min-w-0 flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-300">Models {models ? `(${visible.length})` : ""}</h2>
        <label className="flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={showVision} onChange={(event) => setShowVision(event.target.checked)} /> show vision sidecars (mmproj)</label>
      </div>

      <div className="mt-2 min-h-0 flex-1 overflow-auto rounded-xl border border-slate-800" role="list" aria-label="GGUF models" aria-busy={scanning}>
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
                <button type="button" onClick={(event) => { event.stopPropagation(); void copyPath(model.path); }} className="shrink-0 rounded bg-slate-700 px-2 py-1.5 text-[11px] text-slate-200 hover:bg-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">Copy path</button>
                <button type="button" onClick={(event) => { event.stopPropagation(); if (!running) void selectAndStart(model); }} disabled={running || store.busy} className="shrink-0 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:cursor-default disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">{actionLabel}</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
