import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { AppStore } from "../store";

const LATEST_CACHE_KEY = "llama-board.latest-runtimes.v1";
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
    // Storage can be unavailable in restricted WebViews; memory/Rust caches still apply.
  }
}

const BACKENDS: { id: string; label: string; note: string }[] = [
  { id: "rocm", label: "ROCm (AMD)", note: "best for your Radeon AI PRO R9700" },
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
  latest: string | null;
  latestErr: string | null;
  installed: api.InstalledRuntime[];
  busy: boolean;
  progress: api.DownloadProgress | null;
}

/**
 * §5 Runtimes — per-backend states (none / up-to-date / update-available /
 * installing / active) and 4 flows: Install-latest, Update, Select (make
 * active), Uninstall. Download progress bar driven by the
 * `runtime-download-progress` Tauri event.
 */
export default function RuntimesPanel({ store }: { store: AppStore }) {
  const [rows, setRows] = useState<BackendRow[]>(
    BACKENDS.map((b) => ({ backend: b.id, label: b.label, note: b.note, latest: null, latestErr: null, installed: [], busy: false, progress: null })),
  );
  const [flash, setFlash] = useState<string | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  const activeBackend = store.cfg?.active_backend ?? "";
  const activeBuild = store.cfg?.active_build ?? "";

  const flashT = (s: string | null) => {
    setFlash(s);
    if (s) setTimeout(() => setFlash(null), 4000);
  };

  const refresh = useCallback(async () => {
    const installed = await api.rtList();
    const cached = readLatestCache();
    if (cached) {
      setRows((prev) => prev.map((r) => ({
        ...r,
        installed: installed.filter((x) => x.backend === r.backend),
        latest: cached.infos[r.backend]?.build ?? null,
        latestErr: cached.infos[r.backend] ? null : "No cached asset for this backend.",
      })));
      return;
    }

    const probes = await Promise.all(BACKENDS.map(async (backend) => {
      try {
        return { backend: backend.id, info: await api.rtLatest(backend.id), error: null as string | null };
      } catch (e) {
        return { backend: backend.id, info: null, error: e instanceof Error ? e.message : String(e) };
      }
    }));
    const infos: Record<string, api.LatestInfo> = {};
    probes.forEach((probe) => {
      if (probe.info) infos[probe.backend] = probe.info;
    });
    if (Object.keys(infos).length > 0) writeLatestCache(infos);
    setRows((prev) => prev.map((r) => ({
      ...r,
      installed: installed.filter((x) => x.backend === r.backend),
      latest: infos[r.backend]?.build ?? null,
      latestErr: probes.find((probe) => probe.backend === r.backend)?.error ?? null,
    })));
  }, []);

  // Initial load + progress listener.
  useEffect(() => {
    void refresh();
    api.onRuntimeProgress((p) => {
      setRows((prev) => prev.map((r) => (r.backend === p.backend ? { ...r, progress: p } : r)));
    }).then((un) => {
      unsubRef.current = un;
    });
    return () => {
      unsubRef.current?.();
    };
  }, [refresh]);

  const setBusy = (backend: string, v: boolean) =>
    setRows((prev) => prev.map((r) => (r.backend === backend ? { ...r, busy: v } : r)));

  const install = async (backend: string) => {
    const row = rows.find((r) => r.backend === backend);
    const build = row?.latest;
    if (!build) {
      flashT("No latest build resolved for this backend yet.");
      return;
    }
    setBusy(backend, true);
    try {
      await api.rtInstall(backend, build);
      flashT(`Installed ${backend} ${build}.`);
      await refresh();
    } catch (e) {
      flashT(`Install failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setRows((prev) => prev.map((r) => (r.backend === backend ? { ...r, busy: false, progress: null } : r)));
    }
  };

  const select = async (backend: string, build: string) => {
    try {
      await api.rtSelect(backend, build);
      await store.loadConfig();
      flashT(`Active: ${backend} ${build}.`);
    } catch (e) {
      flashT(`Select failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  const uninstall = async (backend: string, build: string) => {
    if (activeBackend === backend && activeBuild === build) {
      flashT("That build is currently active — select another first.");
      return;
    }
    if (!confirm(`Uninstall ${backend} ${build}?`)) return;
    try {
      await api.rtUninstall(backend, build);
      flashT(`Uninstalled ${backend} ${build}.`);
      await refresh();
    } catch (e) {
      flashT(`Uninstall failed: ${e instanceof Error ? e.message : e}`);
    }
  };

  const stateOf = (r: BackendRow): { label: string; cls: string } => {
    if (r.busy) return { label: "installing…", cls: "bg-amber-900/60 text-amber-300" };
    const active = activeBackend === r.backend && activeBuild !== "";
    if (r.installed.length === 0) return { label: active ? "active (PATH)" : "none", cls: "bg-slate-800 text-slate-400" };
    if (r.latest) {
      if (r.installed.some((item) => item.build === r.latest))
        return { label: active ? "active · up-to-date" : "up-to-date", cls: "bg-emerald-900/60 text-emerald-300" };
      return { label: "update available", cls: "bg-sky-900/60 text-sky-300" };
    }
    return { label: active ? "active" : "installed", cls: "bg-slate-700 text-slate-200" };
  };

  return (
    <div className="flex h-full flex-col p-4">
      <p className="mb-3 text-sm text-slate-400">
        Managed runtimes are downloaded into <code className="text-slate-300">%APPDATA%\llama-board\runtimes\</code> and
        are independent of the WinGet llama.cpp on your PATH. The active build is used by the server and the benchmark.
      </p>
      {flash && (
        <div className="mb-3 rounded-lg border border-indigo-800 bg-indigo-950/50 px-3 py-2 text-sm text-indigo-200">{flash}</div>
      )}

      <div className="min-h-0 flex-1 space-y-3 overflow-auto pr-1">
        {rows.map((r) => {
          const st = stateOf(r);
          const hasLatest = !!r.latest;
          const isNewest = hasLatest && r.installed.some((item) => item.build === r.latest);
          return (
            <div key={r.backend} className="rounded-xl border border-slate-700 bg-slate-800/40 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-slate-100">{r.label}</h3>
                    <span className={`rounded px-2 py-0.5 text-[11px] ${st.cls}`}>{st.label}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500">{r.note}</div>
                </div>
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                  {!isNewest && (
                    <button
                      onClick={() => void install(r.backend)}
                      disabled={r.busy || !hasLatest}
                      className="shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
                    >
                      {r.busy && r.progress?.phase === "downloading"
                        ? `downloading ${Math.round((r.progress.received / Math.max(r.progress.total, 1)) * 100)}%`
                        : r.busy
                          ? "installing…"
                          : hasLatest
                            ? `Install ${r.latest}`
                            : "Install latest"}
                    </button>
                  )}
                  {r.latestErr && <span className="min-w-0 break-words text-[11px] text-red-400">{r.latestErr}</span>}
                </div>
              </div>

              {/* progress bar */}
              {r.busy && r.progress && (
                <div className="mt-3">
                  <div className="mb-1 flex justify-between text-xs text-slate-400">
                    <span>{r.progress.phase}</span>
                    {r.progress.total > 0 && (
                      <span>
                        {(r.progress.received / 1048576).toFixed(1)} / {(r.progress.total / 1048576).toFixed(1)} MB
                      </span>
                    )}
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-700">
                    <div
                      className="h-full rounded-full bg-indigo-500 transition-all"
                      style={{ width: r.progress.total > 0 ? `${(r.progress.received / r.progress.total) * 100}%` : "100%" }}
                    />
                  </div>
                </div>
              )}

              {/* installed builds */}
              {r.installed.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {r.installed.map((item) => {
                    const isActive = activeBackend === r.backend && activeBuild === item.build;
                    return (
                      <div
                        key={item.build}
                        className={`flex min-w-0 flex-wrap items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${
                          isActive ? "border-emerald-600 bg-emerald-950/40" : "border-slate-700 bg-slate-800/60"
                        }`}
                      >
                        <span className="font-mono text-slate-200">{item.build}</span>
                        <span className="text-slate-500">{item.size_mb.toFixed(1)} MB</span>
                        {isActive ? (
                          <span className="rounded bg-emerald-800 px-1.5 py-0.5 text-[10px] text-emerald-200">active</span>
                        ) : (
                          <>
                            <button
                              onClick={() => void select(r.backend, item.build)}
                              className="rounded bg-slate-700 px-1.5 py-0.5 text-[11px] text-slate-200 hover:bg-slate-600"
                            >
                              make active
                            </button>
                            <button
                              onClick={() => void uninstall(r.backend, item.build)}
                              disabled={r.busy}
                              className="rounded bg-slate-700 px-1.5 py-0.5 text-[11px] text-red-300 hover:bg-red-900/60 disabled:opacity-40"
                            >
                              remove
                            </button>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
