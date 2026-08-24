import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { AppStore } from "../store";

const LATEST_CACHE_KEY = "llama-board.latest-runtimes.v2";
type LatestCache = { savedAt: number; infos: Record<string, api.LatestInfo> };

function readLatestCache(): LatestCache | null {
  try {
    const raw = localStorage.getItem(LATEST_CACHE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as LatestCache;
    return Date.now() - value.savedAt < 10 * 60 * 1000 ? value : null;
  } catch {
    return null;
  }
}

function writeLatestCache(infos: Record<string, api.LatestInfo>) {
  try {
    localStorage.setItem(LATEST_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), infos } satisfies LatestCache));
  } catch {
    // A restricted WebView may not provide localStorage.
  }
}

const BACKENDS: { id: string; label: string; note: string }[] = [
  { id: "rocm", label: "ROCm (AMD)", note: "AMD GPU build" },
  { id: "vulkan", label: "Vulkan", note: "broad GPU fallback" },
  { id: "cuda", label: "CUDA (NVIDIA)", note: "NVIDIA only" },
  { id: "sycl", label: "SYCL", note: "Intel" },
  { id: "openvino", label: "OpenVINO", note: "Intel" },
  { id: "cpu", label: "CPU-only", note: "no GPU required" },
];

interface BackendRow {
  backend: string;
  label: string;
  note: string;
  latest: api.LatestInfo | null;
  latestErr: string | null;
  installed: api.InstalledRuntime[];
  busy: boolean;
  progress: api.DownloadProgress | null;
}

const initialRows = (): BackendRow[] => BACKENDS.map((backend) => ({
  backend: backend.id,
  label: backend.label,
  note: backend.note,
  latest: null,
  latestErr: null,
  installed: [],
  busy: false,
  progress: null,
}));

export default function RuntimesPanel({ store }: { store: AppStore }) {
  const [rows, setRows] = useState<BackendRow[]>(initialRows);
  const [flash, setFlash] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const activeBackend = store.cfg?.active_backend ?? "";
  const activeBuild = store.cfg?.active_build ?? "";
  const serverRunning = store.status.state === "running";

  const flashT = (message: string | null) => {
    setFlash(message);
    if (message) window.setTimeout(() => setFlash(null), 4000);
  };

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const installed = await api.rtList();
      const cached = readLatestCache();
      if (cached) {
        setRows((previous) => previous.map((row) => ({
          ...row,
          installed: installed.filter((item) => item.backend === row.backend),
          latest: cached.infos[row.backend] ?? null,
          latestErr: cached.infos[row.backend] ? null : "No cached asset for this backend.",
        })));
        return;
      }
      const probes = await Promise.all(BACKENDS.map(async (backend) => {
        try {
          return { backend: backend.id, info: await api.rtLatest(backend.id), error: null as string | null };
        } catch (error) {
          return { backend: backend.id, info: null, error: error instanceof Error ? error.message : String(error) };
        }
      }));
      const infos: Record<string, api.LatestInfo> = {};
      for (const probe of probes) if (probe.info) infos[probe.backend] = probe.info;
      if (Object.keys(infos).length > 0) writeLatestCache(infos);
      setRows((previous) => previous.map((row) => ({
        ...row,
        installed: installed.filter((item) => item.backend === row.backend),
        latest: infos[row.backend] ?? null,
        latestErr: probes.find((probe) => probe.backend === row.backend)?.error ?? null,
      })));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLoadError(message);
      setRows((previous) => previous.map((row) => ({ ...row, latestErr: row.latestErr ?? message })));
    }
  }, []);

  useEffect(() => {
    void refresh();
    let active = true;
    void api.onRuntimeProgress((progress) => {
      if (!active) return;
      setRows((previous) => previous.map((row) => row.backend === progress.backend ? { ...row, progress } : row));
    }).then((unlisten) => {
      if (active) unsubRef.current = unlisten;
      else unlisten();
    });
    return () => {
      active = false;
      unsubRef.current?.();
    };
  }, [refresh]);

  const install = async (backend: string) => {
    const row = rows.find((item) => item.backend === backend);
    const info = row?.latest;
    if (!info) {
      flashT("No latest build resolved for this backend yet.");
      return;
    }
    if (serverRunning) {
      flashT("Stop the server before changing runtimes.");
      return;
    }
    setRows((previous) => previous.map((item) => item.backend === backend ? { ...item, busy: true } : item));
    try {
      await api.rtInstall(backend, info.build);
      flashT(`Installed ${backend} ${info.build}; SHA-256 was checked before activation.`);
      await refresh();
    } catch (error) {
      flashT(`Install failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRows((previous) => previous.map((item) => item.backend === backend ? { ...item, busy: false, progress: null } : item));
    }
  };

  const select = async (backend: string, build: string) => {
    if (serverRunning) {
      flashT("Stop the server before selecting a different runtime.");
      return;
    }
    try {
      await api.rtSelect(backend, build);
      await store.loadConfig();
      flashT(`Active runtime: ${backend} ${build}.`);
    } catch (error) {
      flashT(`Select failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const uninstall = async (backend: string, build: string) => {
    if (activeBackend === backend && activeBuild === build) {
      flashT("That build is active — select another runtime first.");
      return;
    }
    if (serverRunning) {
      flashT("Stop the server before removing runtimes.");
      return;
    }
    if (!window.confirm(`Uninstall ${backend} ${build}?`)) return;
    try {
      await api.rtUninstall(backend, build);
      flashT(`Uninstalled ${backend} ${build}.`);
      await refresh();
    } catch (error) {
      flashT(`Uninstall failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const stateOf = (row: BackendRow) => {
    if (row.busy) return { label: "installing…", cls: "bg-amber-900/60 text-amber-300" };
    const active = activeBackend === row.backend && activeBuild !== "";
    if (row.installed.length === 0) return { label: active ? "active (system)" : "none", cls: "bg-slate-800 text-slate-400" };
    if (row.latest && row.installed.some((item) => item.build === row.latest?.build)) return { label: active ? "active · up-to-date" : "up-to-date", cls: "bg-emerald-900/60 text-emerald-300" };
    return { label: active ? "active" : row.latest ? "update available" : "installed", cls: active ? "bg-emerald-900/60 text-emerald-300" : "bg-slate-700 text-slate-200" };
  };

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <p className="mb-3 break-words text-sm text-slate-400">
        Managed runtimes are installed under the platform data directory and never replace your system llama.cpp. The selected build is used on the next server start.
      </p>
      {loadError && <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-200" role="alert"><span className="min-w-0 flex-1 break-words">Runtime lookup failed: {loadError}</span><button type="button" onClick={() => void refresh()} className="rounded bg-red-900 px-2 py-1 text-xs hover:bg-red-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300">Retry</button></div>}
      {flash && <div className="mb-3 break-words rounded-lg border border-indigo-800 bg-indigo-950/50 px-3 py-2 text-sm text-indigo-200" role="status">{flash}</div>}

      <div className="min-h-0 flex-1 space-y-3 overflow-auto pr-1">
        {rows.map((row) => {
          const state = stateOf(row);
          const info = row.latest;
          const newestInstalled = !!info && row.installed.some((item) => item.build === info.build);
          return (
            <section key={row.backend} className="min-w-0 rounded-xl border border-slate-700 bg-slate-800/40 p-4" aria-labelledby={`runtime-${row.backend}`}>
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2"><h3 id={`runtime-${row.backend}`} className="text-sm font-semibold text-slate-100">{row.label}</h3><span className={`rounded px-2 py-0.5 text-[11px] ${state.cls}`} role="status">{state.label}</span></div>
                  <div className="mt-0.5 break-words text-xs text-slate-500">{row.note}</div>
                </div>
                {!newestInstalled && <button type="button" onClick={() => void install(row.backend)} disabled={row.busy || !info || serverRunning} className="shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">{row.busy && row.progress?.phase === "downloading" ? `Downloading ${Math.round((row.progress.received / Math.max(row.progress.total, 1)) * 100)}%` : row.busy ? "Installing…" : info ? `Install ${info.build}` : "Install latest"}</button>}
              </div>
              {info && <div className="mt-2 break-words text-[11px] text-slate-500">Latest: <span className="font-mono text-slate-300">{info.build}</span>{info.digest ? " · SHA-256 published" : " · digest unavailable (install will be refused)"}</div>}
              {row.latestErr && <div className="mt-2 break-words text-[11px] text-red-400">{row.latestErr}</div>}

              {row.busy && row.progress && <div className="mt-3" role="progressbar" aria-label={`${row.backend} runtime installation`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={row.progress.total > 0 ? Math.round((row.progress.received / row.progress.total) * 100) : undefined}><div className="mb-1 flex justify-between gap-2 text-xs text-slate-400"><span>{row.progress.phase}</span>{row.progress.total > 0 && <span>{(row.progress.received / 1048576).toFixed(1)} / {(row.progress.total / 1048576).toFixed(1)} MB</span>}</div><div className="h-2 overflow-hidden rounded-full bg-slate-700"><div className="h-full rounded-full bg-indigo-500 transition-all" style={{ width: row.progress.total > 0 ? `${Math.min(100, row.progress.received / row.progress.total * 100)}%` : "100%" }} /></div></div>}

              {row.installed.length > 0 && <div className="mt-3 flex min-w-0 flex-wrap gap-2" role="list" aria-label={`${row.label} installed builds`}>
                {row.installed.map((item) => {
                  const isActive = activeBackend === row.backend && activeBuild === item.build;
                  return <div key={item.build} role="listitem" className={`flex min-w-0 max-w-full flex-wrap items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${isActive ? "border-emerald-600 bg-emerald-950/40" : "border-slate-700 bg-slate-800/60"}`} title={item.dir}>
                    <span className="font-mono text-slate-200">{item.build}</span><span className="text-slate-500">{item.size_mb.toFixed(1)} MB</span>{isActive ? <span className="rounded bg-emerald-800 px-1.5 py-0.5 text-[10px] text-emerald-200">active</span> : <><button type="button" onClick={() => void select(row.backend, item.build)} disabled={serverRunning} className="rounded bg-slate-700 px-1.5 py-0.5 text-[11px] text-slate-200 hover:bg-slate-600 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">Make active</button><button type="button" onClick={() => void uninstall(row.backend, item.build)} disabled={row.busy || serverRunning} className="rounded bg-slate-700 px-1.5 py-0.5 text-[11px] text-red-300 hover:bg-red-900/60 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300">Remove</button></>}</div>;
                })}
              </div>}
            </section>
          );
        })}
      </div>
    </div>
  );
}
