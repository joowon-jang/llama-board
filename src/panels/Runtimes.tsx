import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { AppStore } from "../store";
import { capabilityLabel, readLoadingProfiles, writeLoadingProfiles, type LoadingProfile } from "../runtimeUtils";

const LATEST_CACHE_KEY = "llama-board.latest-runtimes.v2";
type LatestCache = { savedAt: number; infos: Record<string, api.LatestInfo>; errors?: Record<string, string> };

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

function writeLatestCache(infos: Record<string, api.LatestInfo>, errors: Record<string, string>) {
  try {
    localStorage.setItem(LATEST_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), infos, errors } satisfies LatestCache));
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

function mergeBackendRows(previous: BackendRow[], installed: api.InstalledRuntime[]): BackendRow[] {
  const ids = [...new Set([...previous.map((row) => row.backend), ...installed.map((item) => item.backend)])];
  return ids.map((id) => previous.find((row) => row.backend === id) ?? {
    backend: id,
    label: `Unknown backend: ${id}`,
    note: "Generic runtime preserved; use capability probe and Advanced Arguments.",
    latest: null,
    latestErr: "No downloadable catalog asset is defined for this backend.",
    installed: [],
    busy: false,
    progress: null,
  });
}

export default function RuntimesPanel({ store, active = true }: { store: AppStore; active?: boolean }) {
  const [rows, setRows] = useState<BackendRow[]>(initialRows);
  const [flash, setFlash] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<api.RuntimeCapabilities | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [profiles, setProfiles] = useState<LoadingProfile[]>(readLoadingProfiles);
  const [profileName, setProfileName] = useState("");
  const unsubRef = useRef<(() => void) | null>(null);
  const flashTimer = useRef<number | null>(null);
  const refreshGeneration = useRef(0);
  const probeGeneration = useRef(0);
  const probeKeyRef = useRef("");
  const activeBackend = store.cfg?.active_backend ?? "";
  const activeBuild = store.cfg?.active_build ?? "";
  const serverRunning = store.status.state === "running";
  probeKeyRef.current = `${activeBackend}\u0000${activeBuild}`;

  const probe = async () => {
    const generation = ++probeGeneration.current;
    const key = `${activeBackend}\u0000${activeBuild}`;
    setProbeBusy(true);
    try {
      const result = await api.rtProbe(activeBackend, activeBuild);
      if (generation === probeGeneration.current && key === probeKeyRef.current) {
        setCapabilities(result);
        setLoadError(null);
      }
    } catch (error) {
      if (generation === probeGeneration.current && key === probeKeyRef.current) {
        setCapabilities(null);
        setLoadError(`Runtime preflight failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      if (generation === probeGeneration.current) setProbeBusy(false);
    }
  };

  const saveProfile = () => {
    const cfg = store.cfg;
    const name = profileName.trim();
    if (!cfg || !name) { flashT("Enter a profile name first."); return; }
    const profile: LoadingProfile = {
      id: `profile-${Date.now().toString(36)}`,
      name,
      backend: cfg.active_backend,
      build: cfg.active_build,
      active_model: cfg.active_model,
      mmproj: cfg.mmproj,
      ctx_size: cfg.ctx_size,
      ngl: cfg.ngl,
      threads: cfg.threads,
      flash_attn: cfg.flash_attn,
    };
    const next = [profile, ...profiles.filter((item) => item.name !== name)].slice(0, 20);
    setProfiles(next);
    writeLoadingProfiles(next);
    setProfileName("");
    flashT(`Saved loading profile “${name}”.`);
  };

  const applyProfile = async (profile: LoadingProfile) => {
    if (serverRunning) { flashT("Stop the server before applying a loading profile."); return; }
    try {
      await store.updateConfig({ active_backend: profile.backend, active_build: profile.build, active_model: profile.active_model, mmproj: profile.mmproj, ctx_size: profile.ctx_size, ngl: profile.ngl, threads: profile.threads, flash_attn: profile.flash_attn });
      flashT(`Applied loading profile “${profile.name}”.`);
      setCapabilities(null);
    } catch (error) {
      flashT(`Profile apply failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const removeProfile = (profile: LoadingProfile) => {
    const next = profiles.filter((item) => item.id !== profile.id);
    setProfiles(next);
    writeLoadingProfiles(next);
  };

  const flashT = (message: string | null) => {
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    setFlash(message);
    if (message) flashTimer.current = window.setTimeout(() => setFlash(null), 4000);
  };

  const refresh = useCallback(async (force = false) => {
    const generation = ++refreshGeneration.current;
    setLoadError(null);
    try {
      const installed = await api.rtList();
      if (generation !== refreshGeneration.current) return;
      const cached = force ? null : readLatestCache();
      if (cached) {
        setRows((previous) => mergeBackendRows(previous, installed).map((row) => ({
          ...row,
          installed: installed.filter((item) => item.backend === row.backend),
          latest: cached.infos[row.backend] ?? null,
          latestErr: cached.infos[row.backend] ? null : cached.errors?.[row.backend] ?? "No cached asset for this backend.",
        })));
        return;
      }
      const probes = await Promise.all(BACKENDS.map(async (backend) => {
        try {
          return { backend: backend.id, info: await api.rtLatest(backend.id, force), error: null as string | null };
        } catch (error) {
          return { backend: backend.id, info: null, error: error instanceof Error ? error.message : String(error) };
        }
      }));
      if (generation !== refreshGeneration.current) return;
      const infos: Record<string, api.LatestInfo> = {};
      const errors: Record<string, string> = {};
      for (const probe of probes) {
        if (probe.info) infos[probe.backend] = probe.info;
        else if (probe.error) errors[probe.backend] = probe.error;
      }
      if (Object.keys(infos).length > 0 || Object.keys(errors).length > 0) writeLatestCache(infos, errors);
      setRows((previous) => mergeBackendRows(previous, installed).map((row) => ({
        ...row,
        installed: installed.filter((item) => item.backend === row.backend),
        latest: infos[row.backend] ?? null,
        latestErr: probes.find((probe) => probe.backend === row.backend)?.error ?? null,
      })));
    } catch (error) {
      if (generation !== refreshGeneration.current) return;
      const message = error instanceof Error ? error.message : String(error);
      setLoadError(message);
      setRows((previous) => previous.map((row) => ({ ...row, latestErr: row.latestErr ?? message })));
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void refresh();
    let mounted = true;
    void api.onRuntimeProgress((progress) => {
      if (!mounted) return;
      setRows((previous) => previous.map((row) => row.backend === progress.backend ? { ...row, progress } : row));
    }).then((unlisten) => {
      if (mounted) unsubRef.current = unlisten;
      else unlisten();
    });
    return () => {
      mounted = false;
      unsubRef.current?.();
    };
  }, [active, refresh]);

  const cancelInstall = async () => {
    try {
      await api.rtCancel();
      flashT("Runtime cancellation requested.");
    } catch (error) {
      flashT(`Cancellation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

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
      const message = error instanceof Error ? error.message : String(error);
      flashT(message.toLowerCase().includes("cancel") ? "Runtime installation cancelled." : `Install failed: ${message}`);
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
      <section className="mb-3 rounded-xl border border-slate-700 bg-slate-800/40 p-4" aria-labelledby="runtime-capabilities-heading">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="runtime-capabilities-heading" className="text-sm font-semibold text-slate-100">Runtime capabilities</h2><p className="mt-1 text-xs text-slate-500">Read-only probe of the selected executable: version, help flags, visible devices, and llama-bench preflight.</p></div><button type="button" onClick={() => void probe()} disabled={probeBusy || serverRunning} className="shrink-0 rounded-lg bg-cyan-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-600 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">{probeBusy ? "Probing…" : "Probe selected runtime"}</button></div>
        {!capabilities && <p className="mt-3 text-xs text-slate-600">{activeBackend && activeBuild ? `Ready to probe ${activeBackend} ${activeBuild}.` : "No managed runtime selected; probe uses a llama-server found on PATH."}</p>}
        {capabilities && <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5"><div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5"><div className="text-[10px] uppercase tracking-wide text-slate-600">State</div><div className={`mt-1 text-xs font-medium ${capabilities.state === "available" ? "text-emerald-300" : "text-amber-300"}`}>{capabilityLabel(capabilities.state)}</div><div className="mt-1 text-[10px] text-slate-600">{capabilities.backend} · {capabilities.build}</div></div><div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5"><div className="text-[10px] uppercase tracking-wide text-slate-600">Version</div><div className="mt-1 max-h-10 overflow-hidden whitespace-pre-wrap break-words font-mono text-[11px] text-slate-300">{capabilities.version || "not reported"}</div></div><div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5"><div className="text-[10px] uppercase tracking-wide text-slate-600">Flags</div><div className="mt-1 text-xs text-slate-300">{capabilities.flags.length} discovered</div><div className="mt-1 truncate font-mono text-[10px] text-slate-600" title={capabilities.flags.join(", ")}>{capabilities.flags.slice(0, 3).join(", ") || "none"}</div></div><div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5"><div className="text-[10px] uppercase tracking-wide text-slate-600">Devices</div><div className="mt-1 text-xs text-slate-300">{capabilities.devices.length || "No"} visible</div><div className="mt-1 truncate text-[10px] text-slate-600" title={capabilities.devices.join(" · ")}>{capabilities.devices[0] || "probe did not report devices"}</div></div><div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5"><div className="text-[10px] uppercase tracking-wide text-slate-600">Bench</div><div className={`mt-1 text-xs font-medium ${capabilities.bench_available ? "text-emerald-300" : "text-amber-300"}`}>{capabilities.bench_available ? "available" : "failed or missing"}</div><div className="mt-1 text-[10px] text-slate-600">llama-bench --help</div></div></div>}
        {capabilities?.diagnostics.length ? <details className="mt-3"><summary className="cursor-pointer text-[11px] text-amber-400">Diagnostics ({capabilities.diagnostics.length})</summary><pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950 p-2 font-mono text-[10px] text-slate-500">{capabilities.diagnostics.join("\n")}</pre></details> : null}
      </section>

      <section className="mb-3 rounded-xl border border-slate-700 bg-slate-800/40 p-4" aria-labelledby="loading-profiles-heading"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="loading-profiles-heading" className="text-sm font-semibold text-slate-100">Loading profiles</h2><p className="mt-1 text-xs text-slate-500">Save a repeatable model/backend/context setup like an LM Studio load preset.</p></div><div className="flex min-w-[16rem] max-w-full gap-2"><input value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder="Profile name" className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none" /><button type="button" onClick={saveProfile} disabled={!store.cfg || serverRunning} className="shrink-0 rounded-lg bg-slate-700 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-600 disabled:opacity-40">Save current</button></div></div>{profiles.length === 0 && <p className="mt-3 text-xs text-slate-600">No saved profiles.</p>}<div className="mt-3 grid gap-2 md:grid-cols-2">{profiles.map((profile) => <div key={profile.id} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><div className="truncate text-xs font-medium text-slate-200">{profile.name}</div><div className="mt-1 truncate font-mono text-[10px] text-slate-600" title={profile.active_model}>{profile.backend || "system"} {profile.build || "PATH"} · {profile.ctx_size.toLocaleString()} ctx · {profile.ngl} layers</div></div><button type="button" onClick={() => removeProfile(profile)} className="rounded px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-red-950 hover:text-red-300" aria-label={`Delete ${profile.name}`}>×</button></div><div className="mt-2 flex gap-2"><button type="button" onClick={() => void applyProfile(profile)} disabled={serverRunning} className="rounded bg-cyan-900/70 px-2 py-1 text-[11px] text-cyan-200 hover:bg-cyan-800 disabled:opacity-40">Apply profile</button><span className="self-center text-[10px] text-slate-600">flash-attn: {profile.flash_attn}</span></div></div>)}</div></section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        {flash ? <div className="min-w-0 flex-1 break-words rounded-lg border border-indigo-800 bg-indigo-950/50 px-3 py-2 text-sm text-indigo-200" role="status">{flash}</div> : <span />}
        <button type="button" onClick={() => void refresh(true)} disabled={rows.some((row) => row.busy)} className="shrink-0 rounded-lg bg-slate-700 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-600 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">Refresh remote metadata</button>
      </div>

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
                {!newestInstalled && (row.busy ? <button type="button" onClick={() => void cancelInstall()} className="shrink-0 rounded-lg bg-amber-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300">Cancel install</button> : <button type="button" onClick={() => void install(row.backend)} disabled={!info || serverRunning} className="shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">{info ? `Install ${info.build}` : "Install latest"}</button>)}
              </div>
              {info && <div className="mt-2 break-words text-[11px] text-slate-500">Latest: <span className="font-mono text-slate-300">{info.build}</span>{info.digest ? " · SHA-256 published" : " · digest unavailable (install will be refused)"}</div>}
              {!info && <div className="mt-2 break-words text-[11px] text-red-400" role="status">Latest metadata unavailable{row.latestErr ? `: ${row.latestErr}` : ". Use Refresh remote metadata to retry."}</div>}

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
