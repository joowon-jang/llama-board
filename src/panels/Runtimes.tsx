import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { AppStore } from "../store";
import { buildNumber, capabilityLabel, formatRuntimeVersion, readLoadingProfiles, writeLoadingProfiles, type LoadingProfile } from "../runtimeUtils";

import ConfirmDialog from "../components/ConfirmDialog";
import FeedbackBanner from "../components/FeedbackBanner";
import { useI18n } from "../i18n";
import { pt } from "../panelI18n";
import { ut, type UiTextKey } from "../uiI18n";
import { shouldConfirmDestructive } from "../preferences";

const LATEST_CACHE_KEY = "llama-board.latest-runtimes.v2";
const SHOW_ALL_KEY = "llama-board.show-all-backends.v1";

function readShowAll(): boolean {
  try { return localStorage.getItem(SHOW_ALL_KEY) === "1"; } catch { return false; }
}

function writeShowAll(value: boolean) {
  try { localStorage.setItem(SHOW_ALL_KEY, value ? "1" : "0"); } catch { /* storage is optional */ }
}

const FIT_ORDER: Record<api.BackendFit, number> = { recommended: 0, compatible: 1, unsupported: 2 };
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

const BACKENDS = [
  { id: "rocm", label: "backendRocm", note: "noteAmd" },
  { id: "vulkan", label: "backendVulkan", note: "noteVulkan" },
  { id: "cuda", label: "backendCuda", note: "noteNvidia" },
  { id: "sycl", label: "backendSycl", note: "noteIntel" },
  { id: "openvino", label: "backendOpenvino", note: "noteIntel" },
  { id: "cpu", label: "backendCpu", note: "noteCpu" },
] as const satisfies readonly { id: string; label: UiTextKey; note: UiTextKey }[];

interface BackendRow {
  backend: string;
  label: UiTextKey;
  note: UiTextKey;
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
    label: "unknownBackend",
    note: "unknownBackendNote",
    latest: null,
    latestErr: null,
    installed: [],
    busy: false,
    progress: null,
  });
}

export default function RuntimesPanel({ store, active = true }: { store: AppStore; active?: boolean }) {
  const { t, locale } = useI18n();
  const [rows, setRows] = useState<BackendRow[]>(initialRows);
  const [flash, setFlash] = useState<string | null>(null);
  // Failures stay on screen until dismissed; a 4s flash is not long enough to
  // read a preflight diagnostic, let alone act on it.
  const [failure, setFailure] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<api.RuntimeCapabilities | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [profiles, setProfiles] = useState<LoadingProfile[]>(readLoadingProfiles);
  const [profileName, setProfileName] = useState("");
  const [pendingUninstall, setPendingUninstall] = useState<{ backend: string; build: string } | null>(null);
  const [uninstallBusy, setUninstallBusy] = useState(false);
  const [device, setDevice] = useState<api.DeviceReport | null>(null);
  const [showAll, setShowAll] = useState(readShowAll);
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
        setLoadError(`${ut(locale, "preflightFailed")}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      if (generation === probeGeneration.current) setProbeBusy(false);
    }
  };

  const saveProfile = () => {
    const cfg = store.cfg;
    const name = profileName.trim();
    if (!cfg || !name) { flashT(ut(locale, "enterProfileName")); return; }
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
    flashT(ut(locale, "savedProfileNamed", { name }));
  };

  const applyProfile = async (profile: LoadingProfile) => {
    if (serverRunning) { flashT(ut(locale, "stopBeforeProfile")); return; }
    try {
      await store.updateConfig({ active_backend: profile.backend, active_build: profile.build, active_model: profile.active_model, mmproj: profile.mmproj, ctx_size: profile.ctx_size, ngl: profile.ngl, threads: profile.threads, flash_attn: profile.flash_attn });
      flashT(ut(locale, "appliedProfileNamed", { name: profile.name }));
      setCapabilities(null);
    } catch (error) {
      fail(ut(locale, "profileApplyFailed"), error);
    }
  };

  const removeProfile = (profile: LoadingProfile) => {
    const next = profiles.filter((item) => item.id !== profile.id);
    setProfiles(next);
    writeLoadingProfiles(next);
  };

  const fail = (label: string, error: unknown) => {
    setFailure(`${label}: ${error instanceof Error ? error.message : String(error)}`);
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
          latestErr: cached.infos[row.backend] ? null : cached.errors?.[row.backend] ?? null,
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
    // Cheap (a few registry reads) and re-read on every visit so swapping a GPU
    // or driver is reflected without restarting the app.
    void api.deviceProfile().then(setDevice).catch(() => setDevice(null));
    void refresh();
    let mounted = true;
    void api.onRuntimeProgress((progress) => {
      if (!mounted) return;
      setRows((previous) => previous.map((row) => row.backend === progress.backend ? { ...row, progress } : row));
    }).then((unlisten) => {
      if (mounted) unsubRef.current = unlisten;
      else unlisten();
    }).catch(() => {
      // Browser preview does not expose native runtime progress events.
    });
    return () => {
      mounted = false;
      unsubRef.current?.();
    };
  }, [active, refresh]);

  const cancelInstall = async () => {
    try {
      await api.rtCancel();
      flashT(ut(locale, "cancelRequested"));
    } catch (error) {
      fail(ut(locale, "cancelFailed"), error);
    }
  };

  const install = async (backend: string) => {
    setFailure(null);
    const row = rows.find((item) => item.backend === backend);
    const info = row?.latest;
    if (!info) {
      flashT(ut(locale, "noLatestResolved"));
      return;
    }
    if (serverRunning) {
      flashT(ut(locale, "stopBeforeRuntime"));
      return;
    }
    setRows((previous) => previous.map((item) => item.backend === backend ? { ...item, busy: true } : item));
    try {
      await api.rtInstall(backend, info.build);
      flashT(ut(locale, "installedOk", { backend, build: info.build }));
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes("cancel")) flashT(ut(locale, "installCancelled"));
      else setFailure(`${ut(locale, "installFailed")}: ${message}`);
    } finally {
      setRows((previous) => previous.map((item) => item.backend === backend ? { ...item, busy: false, progress: null } : item));
    }
  };

  const select = async (backend: string, build: string) => {
    setFailure(null);
    if (serverRunning) {
      flashT(ut(locale, "stopBeforeSelect"));
      return;
    }
    try {
      await api.rtSelect(backend, build);
      await store.loadConfig();
      flashT(ut(locale, "activeRuntimeNow", { backend, build }));
    } catch (error) {
      fail(ut(locale, "selectFailed"), error);
    }
  };

  const uninstall = async (backend: string, build: string) => {
    if (activeBackend === backend && activeBuild === build) {
      flashT(ut(locale, "buildIsActive"));
      return;
    }
    if (serverRunning) {
      flashT(ut(locale, "stopBeforeRemoveRuntime"));
      return;
    }
    if (shouldConfirmDestructive()) setPendingUninstall({ backend, build });
    else void performUninstall(backend, build);
  };

  const performUninstall = async (backend: string, build: string) => {
    if (uninstallBusy) return;
    setFailure(null);
    setUninstallBusy(true);
    try {
      await api.rtUninstall(backend, build);
      flashT(ut(locale, "uninstalledOk", { backend, build }));
      await refresh();
    } catch (error) {
      fail(ut(locale, "uninstallFailed"), error);
    } finally {
      setUninstallBusy(false);
      setPendingUninstall(null);
    }
  };

  const confirmUninstall = async () => {
    if (!pendingUninstall) return;
    await performUninstall(pendingUninstall.backend, pendingUninstall.build);
  };

  const fitOf = (backend: string): api.BackendFit =>
    device?.backends.find((item) => item.backend === backend)?.fit ?? "compatible";
  const suitabilityOf = (backend: string) => device?.backends.find((item) => item.backend === backend);
  // Only backends that can actually drive the detected GPU. Anything already
  // installed stays regardless, or the user could not see or remove it.
  const visibleRows = rows
    .filter((row) => showAll || !device || row.installed.length > 0 || fitOf(row.backend) === "recommended")
    .slice()
    .sort((left, right) => FIT_ORDER[fitOf(left.backend)] - FIT_ORDER[fitOf(right.backend)]);
  const hiddenCount = rows.length - visibleRows.length;
  const deviceSummary = (() => {
    if (!device) return ut(locale, "detectionUnavailable");
    const gpu = device.profile.gpus.find((item) => !item.integrated) ?? device.profile.gpus[0];
    if (!gpu) return ut(locale, "detectedNoGpu");
    return gpu.vram_mb
      ? ut(locale, "detectedGpu", { name: gpu.name, vram: (gpu.vram_mb / 1024).toFixed(1) })
      : gpu.name;
  })();
  const fitLabel: Record<api.BackendFit, string> = {
    recommended: ut(locale, "fitRecommended"),
    compatible: ut(locale, "fitCompatible"),
    unsupported: ut(locale, "fitUnsupported"),
  };
  const fitClass: Record<api.BackendFit, string> = {
    recommended: "bg-emerald-900/60 text-emerald-300",
    compatible: "bg-slate-700 text-slate-300",
    unsupported: "bg-slate-800 text-slate-500",
  };
  // Policy reasons arrive as keys so the backend never ships display strings.
  const reasonText = (suitability?: api.BackendSuitability) => {
    if (!suitability) return "";
    const key = `reason${suitability.reason.charAt(0).toUpperCase()}${suitability.reason.slice(1)}` as UiTextKey;
    return ut(locale, key, { device: suitability.device ?? "" });
  };

  const stateOf = (row: BackendRow) => {
    if (row.busy) return { label: ut(locale, "runtimeInstalling"), cls: "bg-amber-900/60 text-amber-300" };
    const active = activeBackend === row.backend && activeBuild !== "";
    if (row.installed.length === 0) return { label: active ? ut(locale, "runtimeActiveSystem") : ut(locale, "none"), cls: "bg-slate-800 text-slate-400" };
    if (row.latest && row.installed.some((item) => item.build === row.latest?.build)) return { label: active ? ut(locale, "runtimeActiveUpToDate") : ut(locale, "runtimeUpToDate"), cls: "bg-emerald-900/60 text-emerald-300" };
    return { label: active ? ut(locale, "active") : row.latest ? ut(locale, "runtimeUpdateAvailable") : ut(locale, "runtimeInstalled"), cls: active ? "bg-emerald-900/60 text-emerald-300" : "bg-slate-700 text-slate-200" };
  };

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <p className="mb-3 break-words text-sm text-slate-400">
        {ut(locale, "runtimesIntro")}
      </p>

      <section className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-700 bg-slate-800/40 px-4 py-3" aria-labelledby="detected-device-heading">
        <div className="min-w-0">
          <h2 id="detected-device-heading" className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{ut(locale, "detectedDevice")}</h2>
          <div className="mt-1 min-w-0 break-words text-sm text-slate-200">{deviceSummary}</div>
          {device && <div className="mt-0.5 break-words text-[11px] text-slate-500">{device.profile.cpu.name} · {device.profile.cpu.logical_cores}T · {device.profile.os}/{device.profile.arch}</div>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {!showAll && hiddenCount > 0 && <span className="text-[11px] text-slate-500">{ut(locale, "hiddenBackends", { count: hiddenCount })}</span>}
          <button
            type="button"
            aria-pressed={showAll}
            onClick={() => { const next = !showAll; setShowAll(next); writeShowAll(next); }}
            className="app-button app-button--secondary"
          >
            {showAll ? ut(locale, "showRecommendedOnly") : ut(locale, "showAllBackends")}
          </button>
        </div>
      </section>
      {failure && <FeedbackBanner tone="error" title={t("error.wrong")} onDismiss={() => setFailure(null)}>{failure}</FeedbackBanner>}
      {loadError && <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-200" role="alert"><span className="min-w-0 flex-1 break-words">{ut(locale, "runtimeLookupFailed")}: {loadError}</span><button type="button" onClick={() => void refresh()} className="rounded bg-red-900 px-2 py-1 text-xs hover:bg-red-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300">{pt(locale, "retry")}</button></div>}
      <section className="mb-3 rounded-xl border border-slate-700 bg-slate-800/40 p-4" aria-labelledby="runtime-capabilities-heading">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="runtime-capabilities-heading" className="text-sm font-semibold text-slate-100">{t("section.runtimes")}</h2><p className="mt-1 text-xs text-slate-500">{ut(locale, "probeHint")}</p></div><button type="button" onClick={() => void probe()} disabled={probeBusy || serverRunning} title={serverRunning ? ut(locale, "stopBeforeSelect") : undefined} className="shrink-0 rounded-lg bg-cyan-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-cyan-600 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">{probeBusy ? ut(locale, "probing") : ut(locale, "probeRuntime")}</button></div>
        {!capabilities && <p className="mt-3 text-xs text-slate-600">{activeBackend && activeBuild ? ut(locale, "probeReady", { backend: activeBackend, build: buildNumber(activeBuild) }) : ut(locale, "probeNoRuntime")}</p>}
        {capabilities && <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5"><div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5"><div className="text-[10px] uppercase tracking-wide text-slate-600">{ut(locale, "probeState")}</div><div className={`mt-1 text-xs font-medium ${capabilities.state === "available" ? "text-emerald-300" : "text-amber-300"}`}>{capabilityLabel(capabilities.state)}</div><div className="mt-1 text-[10px] text-slate-600">{capabilities.backend} · {capabilities.build}</div></div><div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5"><div className="text-[10px] uppercase tracking-wide text-slate-600">{ut(locale, "probeVersion")}</div><div className="mt-1 max-h-10 overflow-hidden whitespace-pre-wrap break-words font-mono text-[11px] text-slate-300">{capabilities.version || ut(locale, "notReported")}</div></div><div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5"><div className="text-[10px] uppercase tracking-wide text-slate-600">{ut(locale, "probeFlags")}</div><div className="mt-1 text-xs text-slate-300">{ut(locale, "flagsDiscovered", { count: capabilities.flags.length })}</div><div className="mt-1 truncate font-mono text-[10px] text-slate-600" title={capabilities.flags.join(", ")}>{capabilities.flags.slice(0, 3).join(", ") || ut(locale, "none")}</div></div><div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5"><div className="text-[10px] uppercase tracking-wide text-slate-600">{ut(locale, "probeDevices")}</div><div className="mt-1 text-xs text-slate-300">{ut(locale, "devicesVisible", { count: capabilities.devices.length })}</div><div className="mt-1 truncate text-[10px] text-slate-600" title={capabilities.devices.join(" · ")}>{capabilities.devices[0] || ut(locale, "noDevicesReported")}</div></div><div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5"><div className="text-[10px] uppercase tracking-wide text-slate-600">{ut(locale, "probeBench")}</div><div className={`mt-1 text-xs font-medium ${capabilities.bench_available ? "text-emerald-300" : "text-amber-300"}`}>{capabilities.bench_available ? ut(locale, "benchAvailable") : ut(locale, "benchMissing")}</div><div className="mt-1 text-[10px] text-slate-600">llama-bench --help</div></div></div>}
        {capabilities?.diagnostics.length ? <details className="mt-3"><summary className="cursor-pointer text-[11px] text-amber-400">{ut(locale, "diagnosticsCount", { count: capabilities.diagnostics.length })}</summary><pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950 p-2 font-mono text-[10px] text-slate-500">{capabilities.diagnostics.join("\n")}</pre></details> : null}
      </section>

      <section className="mb-3 rounded-xl border border-slate-700 bg-slate-800/40 p-4" aria-labelledby="loading-profiles-heading"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="loading-profiles-heading" className="text-sm font-semibold text-slate-100">{ut(locale, "loadingProfiles")}</h2><p className="mt-1 text-xs text-slate-500">{ut(locale, "loadingProfilesHint")}</p></div><div className="flex min-w-[16rem] max-w-full gap-2"><input value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder={ut(locale, "profileNamePlaceholder")} className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-200 placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none" /><button type="button" onClick={saveProfile} disabled={!store.cfg || serverRunning} title={serverRunning ? ut(locale, "serverRunningHint") : undefined} className="shrink-0 rounded-lg bg-slate-700 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-600 disabled:opacity-40">{ut(locale, "saveCurrent")}</button></div></div>{profiles.length === 0 && <p className="mt-3 text-xs text-slate-600">{ut(locale, "noProfiles")}</p>}<div className="mt-3 grid gap-2 md:grid-cols-2">{profiles.map((profile) => <div key={profile.id} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><div className="truncate text-xs font-medium text-slate-200">{profile.name}</div><div className="mt-1 truncate font-mono text-[10px] text-slate-600" title={profile.active_model}>{profile.backend || "system"} {profile.build || "PATH"} · {profile.ctx_size.toLocaleString()} ctx · {profile.ngl} layers</div></div><button type="button" onClick={() => removeProfile(profile)} className="rounded px-1.5 py-0.5 text-[11px] text-slate-600 hover:bg-red-950 hover:text-red-300" aria-label={`${pt(locale, "delete")}: ${profile.name}`}>×</button></div><div className="mt-2 flex gap-2"><button type="button" onClick={() => void applyProfile(profile)} disabled={serverRunning} title={serverRunning ? ut(locale, "stopBeforeProfile") : undefined} className="rounded bg-cyan-900/70 px-2 py-1 text-[11px] text-cyan-200 hover:bg-cyan-800 disabled:opacity-40">{ut(locale, "applyProfile")}</button><span className="self-center text-[10px] text-slate-600">flash-attn: {profile.flash_attn}</span></div></div>)}</div></section>
      <ConfirmDialog
        open={pendingUninstall !== null}
        title={ut(locale, "removeRuntimeTitle")}
        description={pendingUninstall ? ut(locale, "removeRuntimeBody", { backend: pendingUninstall.backend, build: buildNumber(pendingUninstall.build) }) : ""}
        confirmLabel={ut(locale, "removeRuntime")}
        busy={uninstallBusy}
        onConfirm={() => void confirmUninstall()}
        onCancel={() => { if (!uninstallBusy) setPendingUninstall(null); }}
      />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        {flash ? <div className="min-w-0 flex-1 break-words rounded-lg border border-indigo-800 bg-indigo-950/50 px-3 py-2 text-sm text-indigo-200" role="status" aria-live="polite">{flash}</div> : <span />}
        <button type="button" onClick={() => void refresh(true)} disabled={rows.some((row) => row.busy)} className="shrink-0 rounded-lg bg-slate-700 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-600 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">{ut(locale, "refreshRemote")}</button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto pr-1">
        {visibleRows.map((row) => {
          const state = stateOf(row);
          const info = row.latest;
          const newestInstalled = !!info && row.installed.some((item) => item.build === info.build);
          return (
            <section key={row.backend} className="min-w-0 rounded-xl border border-slate-700 bg-slate-800/40 p-4" aria-labelledby={`runtime-${row.backend}`} aria-busy={row.busy}>
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2"><h3 id={`runtime-${row.backend}`} className="text-sm font-semibold text-slate-100">{ut(locale, row.label, { id: row.backend })}</h3><span className={`rounded px-2 py-0.5 text-[11px] ${state.cls}`}>{state.label}</span>{device && <span className={`rounded px-2 py-0.5 text-[11px] ${fitClass[fitOf(row.backend)]}`}>{fitLabel[fitOf(row.backend)]}</span>}</div>
                  <div className="mt-0.5 break-words text-xs text-slate-500">{ut(locale, row.note)}{device && reasonText(suitabilityOf(row.backend)) ? ` · ${reasonText(suitabilityOf(row.backend))}` : ""}</div>
                </div>
                {!newestInstalled && (row.busy ? <button type="button" onClick={() => void cancelInstall()} className="shrink-0 rounded-lg bg-amber-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300">{ut(locale, "cancelInstall")}</button> : <button type="button" onClick={() => void install(row.backend)} disabled={!info || serverRunning} title={serverRunning ? ut(locale, "stopBeforeRuntime") : !info ? ut(locale, "noLatestResolved") : undefined} className="shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">{info ? ut(locale, "installBuild", { build: buildNumber(info.build) }) : ut(locale, "installLatest")}</button>)}
              </div>
              {info && <div className="mt-2 break-words text-[11px] text-slate-500">{ut(locale, "latestBuild")}: <span className="text-slate-300">{ut(locale, "buildLabel", { build: buildNumber(info.build) })}</span>{" · "}{info.digest ? ut(locale, "digestPublished") : ut(locale, "digestUnavailable")}</div>}
              {!info && <div className="mt-2 break-words text-[11px] text-red-400">{ut(locale, "latestUnavailable")}{row.latestErr ? `: ${row.latestErr}` : ` ${ut(locale, "latestUnavailableRetry")}`}</div>}

              {row.busy && row.progress && <div className="mt-3" role="progressbar" aria-label={ut(locale, "installedBuilds", { label: row.backend })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={row.progress.total > 0 ? Math.round((row.progress.received / row.progress.total) * 100) : undefined}><div className="mb-1 flex justify-between gap-2 text-xs text-slate-400"><span>{row.progress.phase}</span>{row.progress.total > 0 && <span>{(row.progress.received / 1048576).toFixed(1)} / {(row.progress.total / 1048576).toFixed(1)} MB</span>}</div><div className="h-2 overflow-hidden rounded-full bg-slate-700"><div className="h-full rounded-full bg-indigo-500 transition-all" style={{ width: row.progress.total > 0 ? `${Math.min(100, row.progress.received / row.progress.total * 100)}%` : "100%" }} /></div></div>}

              {row.installed.length > 0 && <div className="mt-3 flex min-w-0 flex-wrap gap-2" role="list" aria-label={ut(locale, "installedBuilds", { label: ut(locale, row.label, { id: row.backend }) })}>
                {row.installed.map((item) => {
                  const isActive = activeBackend === row.backend && activeBuild === item.build;
                  return <div key={item.build} role="listitem" className={`flex min-w-0 max-w-full flex-wrap items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${isActive ? "border-emerald-600 bg-emerald-950/40" : "border-slate-700 bg-slate-800/60"}`} title={item.dir}>
                    <span className="text-slate-200" title={item.version?.commit ? `commit ${item.version.commit}` : item.build}>{formatRuntimeVersion(item.build, item.version)}</span><span className="text-slate-500">{item.size_mb.toFixed(1)} MB</span>{isActive ? <span className="rounded bg-emerald-800 px-1.5 py-0.5 text-[10px] text-emerald-200">{ut(locale, "active")}</span> : <><button type="button" onClick={() => void select(row.backend, item.build)} disabled={serverRunning} title={serverRunning ? ut(locale, "stopBeforeSelect") : undefined} className="rounded bg-slate-700 px-1.5 py-0.5 text-[11px] text-slate-200 hover:bg-slate-600 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400">{ut(locale, "makeActive")}</button><button type="button" onClick={() => void uninstall(row.backend, item.build)} disabled={row.busy || serverRunning} title={serverRunning ? ut(locale, "stopBeforeRemoveRuntime") : undefined} className="rounded bg-slate-700 px-1.5 py-0.5 text-[11px] text-red-300 hover:bg-red-900/60 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-300">{pt(locale, "remove")}</button></>}</div>;
                })}
              </div>}
            </section>
          );
        })}
      </div>
    </div>
  );
}
