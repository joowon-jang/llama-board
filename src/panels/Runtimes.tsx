import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api";
import type { AppStore } from "../store";
import { buildNumber, buildPhaseLabelKey, canBuildPrBackend, capabilityLabel, defaultPrBackendForDevice, formatRuntimeVersion, isInstallCancellation, readLoadingProfiles, runtimeRowAction, writeLoadingProfiles, type LoadingProfile } from "../runtimeUtils";

import ConfirmDialog from "../components/ConfirmDialog";
import FeedbackBanner from "../components/FeedbackBanner";
import { CustomSelect } from "../components/ThemeSwitcher";
import { useI18n } from "../i18n";
import type { Locale } from "../i18nCatalog";
import { pt } from "../panelI18n";
import { ut, type UiTextKey } from "../uiI18n";
import { shouldConfirmDestructive } from "../preferences";
import { normalizeDisplayPath, normalizeDisplayText } from "../lifecycleUtils";

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

/**
 * Provenance for an already-installed PR runtime, recorded at build time.
 *
 * `commit_check` is spelled out rather than assumed: a runtime whose archive
 * layout could not confirm the commit says so, instead of looking identical to
 * one that was confirmed.
 */
function prSourceTitle(locale: Locale, source: api.RuntimeSource): string {
  const parts = [
    `${ut(locale, "runtimePrBuild", { pr: source.pull_request })} · ${ut(locale, "prSourceLabelRepository")}: ${source.repository}`,
    `${ut(locale, "prFieldCommit")}: ${source.commit}`,
  ];
  if (source.head_ref) parts.push(`${ut(locale, "prFieldHeadRef")}: ${source.head_ref}`);
  if (source.author) parts.push(`${ut(locale, "prFieldAuthor")}: ${source.author}`);
  if (source.state) parts.push(`${ut(locale, "prFieldState")}: ${source.state}`);
  if (source.commit_check && !["archive-directory-matches-commit", "github-actions-checkout-ref"].includes(source.commit_check)) {
    parts.push(ut(locale, "prSourceUnverified"));
  }
  return parts.join("\n");
}

/**
 * What the user is agreeing to. Building a pull request compiles and runs code
 * written by whoever opened it, so the dialog names them, the repository the
 * code actually comes from, the branch, and the exact commit — rather than
 * only the PR number the user typed, which says nothing about any of that.
 */
function PullRequestProvenance({ locale, preview, backend }: { locale: Locale; preview: api.PullRequestPreview; backend: string }) {
  const rows: [string, string][] = [
    [ut(locale, "prFieldTitle"), preview.title || "—"],
    [ut(locale, "prFieldAuthor"), preview.author || "—"],
    [ut(locale, "prFieldRepository"), preview.repository],
    [ut(locale, "prFieldHeadRef"), preview.head_ref || "—"],
    [ut(locale, "prFieldCommit"), preview.commit],
    [ut(locale, "prFieldState"), preview.draft ? ut(locale, "prStateDraft", { state: preview.state }) : preview.state],
    [ut(locale, "prFieldUpdated"), preview.updated_at || "—"],
    [ut(locale, "prFieldBackend"), backend],
  ];
  // The backend decides which of these apply; the frontend only translates
  // them, so a new state never silently renders as nothing.
  const advisoryText: Record<api.PrAdvisory, UiTextKey> = {
    draft: "prAdvisoryDraft",
    closed: "prAdvisoryClosed",
    merged: "prAdvisoryMerged",
    // Rendered with the repository name and its own emphasis, below.
    fork: "prForkWarning",
    "no-head-ref": "prAdvisoryNoHeadRef",
  };
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-300">{ut(locale, "prConfirmBody", { pr: preview.pull_request })}</p>
      {/* Defensive: a preview from an older backend carries no advisories, and
          a crashed dialog would be a worse failure than a missing warning. */}
      {(preview.advisories ?? []).map((advisory) => (
        <p key={advisory} className={`rounded-lg border px-2.5 py-2 text-xs ${advisory === "fork" ? "border-amber-700 bg-amber-950/40 text-amber-200" : "border-slate-600 bg-slate-900/60 text-slate-300"}`}>
          {advisory === "fork" ? ut(locale, "prForkWarning", { repository: preview.repository }) : ut(locale, advisoryText[advisory] ?? "prAdvisoryUnknown", { advisory })}
        </p>
      ))}
      <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-slate-500">{label}</dt>
            <dd className="min-w-0 break-all font-mono text-slate-200">{value}</dd>
          </div>
        ))}
      </dl>
      {/* L5: say exactly what the build produces, so "build this PR" is not an
          open-ended promise. Mirrors SOURCE_BUILD_TARGETS in runtime.rs. */}
      <div className="rounded-lg border border-slate-700 bg-slate-900/50 px-2.5 py-2">
        <p className="text-[11px] font-medium text-slate-300">{ut(locale, "prBuildPlanTitle")}</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-slate-400">
          <li>{ut(locale, "prBuildPlanTargets")}</li>
          <li>{ut(locale, "prBuildPlanWebui")}</li>
          <li>{ut(locale, "prBuildPlanOffline")}</li>
          {backend === "cuda" && <li>{ut(locale, "prBuildPlanCuda", { variable: "LLAMA_BOARD_CUDA_ARCHITECTURES" })}</li>}
        </ul>
      </div>
      {preview.artifact ? (
        <p className="rounded-lg border border-emerald-700 bg-emerald-950/40 px-2.5 py-2 text-[11px] text-emerald-200">
          {ut(locale, "prPrebuiltAvailable", {
            name: preview.artifact.name,
            size: (preview.artifact.bytes / 1048576).toFixed(1),
          })}
          <span className="mt-1 block break-all font-mono text-[10px] text-emerald-300/70">SHA-256: {preview.artifact.sha256}</span>
        </p>
      ) : (
        <p className="rounded-lg border border-slate-700 bg-slate-900/50 px-2.5 py-2 text-[11px] text-slate-400">{ut(locale, "prLocalBuildRequired")}</p>
      )}
      {preview.artifact_error && <p className="rounded-lg border border-amber-700 bg-amber-950/40 px-2.5 py-2 text-[11px] text-amber-200">{ut(locale, "prArtifactLookupFailed", { error: preview.artifact_error })}</p>}
      <p className="text-[11px] text-slate-500">{ut(locale, "prReplaceNote", { pr: preview.pull_request, backend })}</p>
      {backend === "rocm" && <p className="rounded-lg border border-amber-700 bg-amber-950/40 px-2.5 py-2 text-[11px] text-amber-200">{ut(locale, "prRocmLocalOnly")}</p>}
      <p className="text-[11px] text-slate-500">{ut(locale, "prIntegrityNote")}</p>
    </div>
  );
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
  const [prBackend, setPrBackend] = useState(() => defaultPrBackendForDevice(null));
  const [prSource, setPrSource] = useState("");
  const [prBusy, setPrBusy] = useState(false);
  const [bundleBusy, setBundleBusy] = useState(false);
  const [bundleProgress, setBundleProgress] = useState<api.DownloadProgress | null>(null);
  const [activePrBackend, setActivePrBackend] = useState<string | null>(null);
  const [prReviewBusy, setPrReviewBusy] = useState(false);
  // The resolved pull request awaiting confirmation. Holding the backend and
  // the raw source alongside it keeps the build bound to what was reviewed.
  const [prPreview, setPrPreview] = useState<{ backend: string; source: string; preview: api.PullRequestPreview } | null>(null);
  const [pendingUninstall, setPendingUninstall] = useState<{ backend: string; build: string } | null>(null);
  const [uninstallBusy, setUninstallBusy] = useState(false);
  // A cancel is a one-shot request to the backend; a second click while the
  // first is in flight would only produce a duplicate failure banner.
  const [cancelBusy, setCancelBusy] = useState(false);
  const [device, setDevice] = useState<api.DeviceReport | null>(null);
  const [showAll, setShowAll] = useState(readShowAll);
  const unsubRef = useRef<(() => void) | null>(null);
  const flashTimer = useRef<number | null>(null);
  const refreshGeneration = useRef(0);
  const probeGeneration = useRef(0);
  const probeKeyRef = useRef("");
  const prBackendTouched = useRef(false);
  const prInstallInFlight = useRef(false);
  const activeBackend = store.cfg?.active_backend ?? "";
  const activeBuild = store.cfg?.active_build ?? "";
  const serverRunning = store.status.state === "running";
  const runtimeBusy = bundleBusy || prBusy || rows.some((row) => row.busy);
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
    // Cheap (a few registry reads) and re-read on every visit so swapping a GPU
    // or driver is reflected without restarting the app.
    if (active) {
      void api.deviceProfile().then((report) => {
        setDevice(report);
        if (!prBackendTouched.current) setPrBackend(defaultPrBackendForDevice(report));
      }).catch(() => setDevice(null));
      void refresh();
    }
  }, [active, refresh]);

  // Keep the native progress subscription for the lifetime of the mounted
  // panel. App keeps the panel mounted after first visit, so navigating away
  // must not drop progress events from a still-running PR build.
  useEffect(() => {
    let mounted = true;
    void api.onRuntimeProgress((progress) => {
      if (!mounted) return;
      if (progress.backend === "import" || progress.backend === "export") {
        setBundleProgress(progress);
      } else {
        setRows((previous) => previous.map((row) => row.backend === progress.backend ? { ...row, progress } : row));
      }
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
  }, []);

  const cancelInstall = async () => {
    if (cancelBusy) return;
    setCancelBusy(true);
    try {
      await api.rtCancel();
      flashT(ut(locale, "cancelRequested"));
    } catch (error) {
      fail(ut(locale, "cancelFailed"), error);
    } finally {
      setCancelBusy(false);
    }
  };

  const exportRuntime = async (backend: string, build: string) => {
    if (runtimeBusy) return;
    if (serverRunning) {
      flashT(ut(locale, "stopBeforeRuntime"));
      return;
    }
    setFailure(null);
    setBundleBusy(true);
    setBundleProgress(null);
    try {
      const info = await api.rtExport(backend, build);
      flashT(ut(locale, "runtimeBundleExported", {
        backend: info.backend,
        build: info.build,
        path: info.path,
        sha: info.archive_sha256,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "runtime export cancelled" || isInstallCancellation(message)) {
        flashT(ut(locale, "runtimeBundleCancelled"));
      } else {
        setFailure(ut(locale, "runtimeBundleExportFailed") + ": " + message);
      }
    } finally {
      setBundleBusy(false);
      setBundleProgress(null);
    }
  };

  const importRuntime = async () => {
    if (runtimeBusy) return;
    if (serverRunning) {
      flashT(ut(locale, "stopBeforeRuntime"));
      return;
    }
    setFailure(null);
    setBundleBusy(true);
    setBundleProgress(null);
    try {
      const installed = await api.rtImport();
      flashT(ut(locale, "runtimeBundleImported", { backend: installed.backend, build: installed.build }));
      await refresh(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "runtime import cancelled" || isInstallCancellation(message)) {
        flashT(ut(locale, "runtimeBundleCancelled"));
      } else {
        setFailure(ut(locale, "runtimeBundleImportFailed") + ": " + message);
      }
    } finally {
      setBundleBusy(false);
      setBundleProgress(null);
    }
  };

  const install = async (backend: string) => {
    if (prBusy || bundleBusy) return;
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
      if (isInstallCancellation(message)) flashT(ut(locale, "installCancelled"));
      else setFailure(`${ut(locale, "installFailed")}: ${message}`);
    } finally {
      setRows((previous) => previous.map((item) => item.backend === backend ? { ...item, busy: false, progress: null } : item));
    }
  };

  /**
   * Step one of two. Resolve the PR and show who wrote it, where it lives and
   * which commit it points at. Nothing is downloaded or compiled until the
   * user has seen this and agreed to it.
   */
  const reviewPullRequest = async () => {
    const source = prSource.trim();
    const backend = prBackend;
    if (!source) {
      flashT(ut(locale, "enterPrSource"));
      return;
    }
    // The backend refuses these before it downloads anything; say so without
    // a round trip, and keep it on screen instead of flashing it away.
    if (!canBuildPrBackend(backend)) {
      setFailure(ut(locale, "prBackendBlocked", { backend }));
      return;
    }
    if (serverRunning) {
      flashT(ut(locale, "stopBeforeRuntime"));
      return;
    }
    if (prBusy || bundleBusy || prReviewBusy || rows.some((row) => row.busy)) return;
    setFailure(null);
    setPrReviewBusy(true);
    try {
      setPrPreview({ backend, source, preview: await api.rtPrPreview(backend, source) });
    } catch (error) {
      setFailure(`${ut(locale, "prPreviewFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setPrReviewBusy(false);
    }
  };

  /**
   * Step two. The confirmed head commit goes back to the backend, which
   * re-resolves the PR and refuses to build anything else — so a branch that
   * is force-pushed between the dialog and this call is caught, not built.
   */
  const installPullRequest = async () => {
    const pending = prPreview;
    if (!pending) return;
    if (prInstallInFlight.current) return;
    if (prBusy || bundleBusy || rows.some((row) => row.busy)) return;
    // Pin the backend for the whole run: the busy flag has to be cleared on
    // the row it was set on, whatever the picker says by the time we finish.
    const { backend, source, preview } = pending;
    setPrPreview(null);
    if (!canBuildPrBackend(backend)) {
      setFailure(ut(locale, "prBackendBlocked", { backend }));
      return;
    }
    if (serverRunning) {
      flashT(ut(locale, "stopBeforeRuntime"));
      return;
    }
    if (prBusy || bundleBusy || rows.some((row) => row.busy)) return;
    prInstallInFlight.current = true;
    setFailure(null);
    setPrBusy(true);
    setActivePrBackend(backend);
    setRows((previous) => previous.map((item) => item.backend === backend ? { ...item, busy: true, progress: null } : item));
    try {
      const installed = await api.rtInstallPr(backend, source, preview.commit);
      // A PR keeps one directory, so a rebuild swaps the bytes behind a row
      // whose name did not change. Say which commit went away.
      const replaced = installed.replaced;
      flashT(replaced
        ? ut(locale, "installedPrReplacedOk", { backend, pr: installed.source?.pull_request ?? source, previous: replaced.previous_commit.slice(0, 7) })
        : ut(locale, "installedPrOk", { backend, pr: installed.source?.pull_request ?? source }));
      setPrSource("");
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isInstallCancellation(message)) flashT(ut(locale, "installCancelled"));
      else setFailure(`${ut(locale, "installFailed")}: ${message}`);
    } finally {
      prInstallInFlight.current = false;
      setPrBusy(false);
      setActivePrBackend(null);
      setCancelBusy(false);
      setRows((previous) => previous.map((item) => item.backend === backend ? { ...item, busy: false, progress: null } : item));
    }
  };

  const select = async (backend: string, build: string) => {
    setFailure(null);
    if (runtimeBusy) return;
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
    if (runtimeBusy) return;
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
  // installed stays regardless, or the user could not see or remove it. If a
  // device report has no matching verdicts (for example an unsupported
  // architecture), keep the catalog visible rather than rendering an empty
  // runtime list.
  const matchingRows = rows
    .filter((row) => showAll || !device || row.installed.length > 0 || fitOf(row.backend) === "recommended")
  const visibleRows = (matchingRows.length > 0 ? matchingRows : rows)
    .slice()
    .sort((left, right) => FIT_ORDER[fitOf(left.backend)] - FIT_ORDER[fitOf(right.backend)]);
  const hiddenCount = matchingRows.length > 0 ? rows.length - visibleRows.length : 0;
  const prProgress = activePrBackend ? rows.find((row) => row.backend === activePrBackend)?.progress : null;
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
    <div className="app-page-scroll relative flex h-full min-h-0 flex-col p-4">
      <p className="mb-4 break-words text-sm text-slate-400">
        {ut(locale, "runtimesIntro")}
      </p>

      <section className="runtime-detected-device mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-700 bg-slate-800/40 p-4" aria-labelledby="detected-device-heading">
        <div className="min-w-0">
          <h2 id="detected-device-heading" className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{ut(locale, "detectedDevice")}</h2>
          <div className="mt-1 min-w-0 truncate text-sm text-slate-200" title={deviceSummary}>{deviceSummary}</div>
          <div className="mt-0.5 min-w-0 truncate text-[11px] text-slate-500" title={device ? `${device.profile.cpu.name} · ${device.profile.cpu.logical_cores}T · ${device.profile.os}/${device.profile.arch}` : undefined}>
            {device ? `${device.profile.cpu.name} · ${device.profile.cpu.logical_cores}T · ${device.profile.os}/${device.profile.arch}` : "—"}
          </div>
        </div>
        <div className="runtime-device-actions flex shrink-0 flex-wrap items-center gap-2">
          <span className={`runtime-hidden-count text-[11px] text-slate-500 ${!showAll && hiddenCount > 0 ? "" : "is-empty"}`}>{ut(locale, "hiddenBackends", { count: hiddenCount })}</span>
          <button
            type="button"
            aria-pressed={showAll}
            onClick={() => { const next = !showAll; setShowAll(next); writeShowAll(next); }}
            className="app-button app-button--secondary runtime-show-all"
          >
            {showAll ? ut(locale, "showRecommendedOnly") : ut(locale, "showAllBackends")}
          </button>
        </div>
      </section>
      <div className="app-panel-feedback-layer" aria-live="polite">
        {failure && <FeedbackBanner tone="error" title={t("error.wrong")} onDismiss={() => setFailure(null)}>{failure}</FeedbackBanner>}
        {loadError && <div className="flex flex-wrap items-center gap-2 rounded-lg border border-red-800 bg-red-950/50 px-3.5 py-2.5 text-sm text-red-200" role="alert"><span className="min-w-0 flex-1 break-words">{ut(locale, "runtimeLookupFailed")}: {loadError}</span><button type="button" onClick={() => void refresh()} className="app-button app-button--danger app-button--sm">{pt(locale, "retry")}</button></div>}
      </div>
      <section className="runtime-capabilities-card mb-4 rounded-xl border border-slate-700 bg-slate-800/40 p-4" aria-labelledby="runtime-capabilities-heading">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="runtime-capabilities-heading" className="app-section-title">{t("section.runtimes")}</h2><p className="app-section-hint">{ut(locale, "probeHint")}</p></div><button type="button" onClick={() => void probe()} disabled={probeBusy || serverRunning} title={serverRunning ? ut(locale, "stopBeforeSelect") : undefined} className="app-button app-button--primary app-button--sm shrink-0">{probeBusy ? ut(locale, "probing") : ut(locale, "probeRuntime")}</button></div>
        {!capabilities && <p className="mt-3 text-xs text-slate-600">{activeBackend && activeBuild ? ut(locale, "probeReady", { backend: activeBackend, build: buildNumber(activeBuild) }) : ut(locale, "probeNoRuntime")}</p>}
        {capabilities && <div className="mt-3.5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5"><div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3"><div className="text-[10px] uppercase tracking-wide text-slate-600">{ut(locale, "probeState")}</div><div className={`mt-1 text-xs font-medium ${capabilities.state === "available" ? "text-emerald-300" : "text-amber-300"}`}>{capabilityLabel(capabilities.state)}</div><div className="mt-1 text-[10px] text-slate-600">{capabilities.backend} · {capabilities.build}</div></div><div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3"><div className="text-[10px] uppercase tracking-wide text-slate-600">{ut(locale, "probeVersion")}</div><div className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-slate-300">{capabilities.version || ut(locale, "notReported")}</div></div><div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3"><div className="text-[10px] uppercase tracking-wide text-slate-600">{ut(locale, "probeFlags")}</div><div className="mt-1 text-xs text-slate-300">{ut(locale, "flagsDiscovered", { count: capabilities.flags.length })}</div><div className="mt-1 truncate font-mono text-[10px] text-slate-600" title={capabilities.flags.join(", ")}>{capabilities.flags.slice(0, 3).join(", ") || ut(locale, "none")}</div></div><div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3"><div className="text-[10px] uppercase tracking-wide text-slate-600">{ut(locale, "probeDevices")}</div><div className="mt-1 text-xs text-slate-300">{ut(locale, "devicesVisible", { count: capabilities.devices.length })}</div><div className="mt-1 truncate text-[10px] text-slate-600" title={capabilities.devices.join(" · ")}>{capabilities.devices[0] || ut(locale, "noDevicesReported")}</div></div><div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3"><div className="text-[10px] uppercase tracking-wide text-slate-600">{ut(locale, "probeBench")}</div><div className={`mt-1 text-xs font-medium ${capabilities.bench_available ? "text-emerald-300" : "text-amber-300"}`}>{capabilities.bench_available ? ut(locale, "benchAvailable") : ut(locale, "benchMissing")}</div><div className="mt-1 text-[10px] text-slate-600">llama-bench --help</div></div></div>}
        {capabilities?.diagnostics.length ? <details className="mt-3"><summary className="cursor-pointer text-[11px] text-amber-400">{ut(locale, "diagnosticsCount", { count: capabilities.diagnostics.length })}</summary><pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950 p-2 font-mono text-[10px] text-slate-500">{capabilities.diagnostics.join("\n")}</pre></details> : null}
      </section>

      <section className="mb-4 rounded-xl border border-amber-800/70 bg-amber-950/20 p-4" aria-labelledby="pull-request-runtime-heading">
        <div>
          <h2 id="pull-request-runtime-heading" className="app-section-title">{ut(locale, "installPrTitle")}</h2>
          <p className="app-section-hint break-words">{ut(locale, "installPrHint")}</p>
          <p className="app-section-hint break-words text-amber-300/80">{ut(locale, "prBackendUnsupportedHint")}</p>
        </div>
        <div className="mt-3.5 grid gap-3 md:grid-cols-[12rem_minmax(0,1fr)_auto] md:items-end">
          <label className="block text-xs text-slate-400">
            <span className="mb-1 block">{ut(locale, "prBackendLabel")}</span>
            <CustomSelect
              value={prBackend}
              options={BACKENDS.map((backend) => {
                const supported = canBuildPrBackend(backend.id);
                return {
                  value: backend.id,
                  label: `${ut(locale, backend.label, { id: backend.id })}${supported ? "" : " — " + ut(locale, "prBackendUnsupported")}`,
                  disabled: !supported,
                };
              })}
              onChange={(val) => {
                prBackendTouched.current = true;
                setPrBackend(val);
              }}
              disabled={prBusy || bundleBusy || serverRunning}
              size="sm"
              triggerClassName="w-full"
            />
          </label>
          <label className="block min-w-0 text-xs text-slate-400">
            <span className="mb-1 block">{ut(locale, "prSourceLabel")}</span>
            <input value={prSource} onChange={(event) => setPrSource(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void reviewPullRequest(); }} disabled={prBusy || bundleBusy || serverRunning} placeholder={ut(locale, "prSourcePlaceholder")} className="app-input mt-1" />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void reviewPullRequest()} disabled={!prSource.trim() || prBusy || bundleBusy || prReviewBusy || !canBuildPrBackend(prBackend) || rows.some((row) => row.busy) || serverRunning} title={serverRunning ? ut(locale, "stopBeforeRuntime") : !canBuildPrBackend(prBackend) ? ut(locale, "prBackendBlocked", { backend: prBackend }) : undefined} className="app-button app-button--primary app-button--sm">{prBusy ? ut(locale, "installingPr") : prReviewBusy ? ut(locale, "prResolving") : ut(locale, "reviewPrAction")}</button>
            {prBusy && <button type="button" onClick={() => void cancelInstall()} disabled={cancelBusy} className="app-button app-button--danger app-button--sm">{cancelBusy ? ut(locale, "cancelling") : ut(locale, "cancelPrBuild")}</button>}
          </div>
        </div>
        <div className="runtime-progress-slot mt-3">
          {prBusy && prProgress && <div role="status" aria-live="polite"><div className="mb-1 flex justify-between gap-2 text-xs text-slate-400"><span>{ut(locale, buildPhaseLabelKey(prProgress.phase))}</span><span>{ut(locale, "installingPr")}</span></div><div className="h-2 overflow-hidden rounded-full bg-slate-700"><div className="h-full w-full animate-pulse rounded-full bg-amber-500" /></div></div>}
        </div>
      </section>

      <section className="mb-4 rounded-xl border border-emerald-800/70 bg-emerald-950/20 p-4" aria-labelledby="portable-runtime-heading" aria-busy={bundleBusy}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="portable-runtime-heading" className="app-section-title">{ut(locale, "portableRuntimeTitle")}</h2>
            <p className="app-section-hint break-words">{ut(locale, "portableRuntimeHint")}</p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <button type="button" onClick={() => void importRuntime()} disabled={runtimeBusy || serverRunning} title={serverRunning ? ut(locale, "stopBeforeRuntime") : undefined} className="app-button app-button--primary app-button--sm">{bundleBusy ? ut(locale, "runtimeBundleWorking") : ut(locale, "importRuntimeBundle")}</button>
            {bundleBusy && <button type="button" onClick={() => void cancelInstall()} disabled={cancelBusy} className="app-button app-button--danger app-button--sm">{cancelBusy ? ut(locale, "cancelling") : ut(locale, "cancelRuntimeBundle")}</button>}
          </div>
        </div>
        <div className="runtime-progress-slot mt-3">
          {bundleBusy && bundleProgress && <div role="progressbar" aria-label={ut(locale, "portableRuntimeTitle")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={bundleProgress.total > 0 ? Math.round((bundleProgress.received / bundleProgress.total) * 100) : undefined}><div className="mb-1 flex justify-between gap-2 text-xs text-slate-400"><span>{ut(locale, buildPhaseLabelKey(bundleProgress.phase))}</span>{bundleProgress.total > 0 && <span>{(bundleProgress.received / 1048576).toFixed(1)} / {(bundleProgress.total / 1048576).toFixed(1)} MB</span>}</div><div className="h-2 overflow-hidden rounded-full bg-slate-700"><div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: bundleProgress.total > 0 ? String(Math.min(100, bundleProgress.received / bundleProgress.total * 100)) + "%" : "100%" }} /></div></div>}
        </div>
        {rows.some((row) => row.installed.length > 0) && <div className="mt-3 flex min-w-0 flex-wrap gap-2" aria-label={ut(locale, "exportRuntime")}>
          {rows.flatMap((row) => row.installed.map((item) => (
            <button key={row.backend + ":" + item.build} type="button" onClick={() => void exportRuntime(row.backend, item.build)} disabled={runtimeBusy || serverRunning} title={serverRunning ? ut(locale, "stopBeforeRuntime") : undefined} className="app-button app-button--secondary app-button--sm">
              {ut(locale, "exportRuntime")}: {row.backend} {buildNumber(item.build)}
            </button>
          )))}
        </div>}
      </section>

      <section className="mb-4 rounded-xl border border-slate-700 bg-slate-800/40 p-4" aria-labelledby="loading-profiles-heading"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="loading-profiles-heading" className="app-section-title">{ut(locale, "loadingProfiles")}</h2><p className="app-section-hint">{ut(locale, "loadingProfilesHint")}</p></div><div className="flex min-w-[16rem] max-w-full gap-2"><input value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder={ut(locale, "profileNamePlaceholder")} className="app-input min-w-0 flex-1" /><button type="button" onClick={saveProfile} disabled={!store.cfg || serverRunning} title={serverRunning ? ut(locale, "serverRunningHint") : undefined} className="app-button app-button--secondary app-button--sm shrink-0">{ut(locale, "saveCurrent")}</button></div></div>{profiles.length === 0 && <p className="mt-3 text-xs text-slate-600">{ut(locale, "noProfiles")}</p>}<div className="mt-3.5 grid gap-3 md:grid-cols-2">{profiles.map((profile) => <div key={profile.id} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3.5"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><div className="truncate text-xs font-medium text-slate-200">{profile.name}</div><div className="mt-1 truncate font-mono text-[10px] text-slate-600" title={normalizeDisplayPath(profile.active_model)}>{profile.backend || "system"} {profile.build || "PATH"} · {profile.ctx_size.toLocaleString()} ctx · {profile.ngl} layers</div></div><button type="button" onClick={() => removeProfile(profile)} className="app-icon-button app-icon-button--danger" aria-label={`${pt(locale, "delete")}: ${profile.name}`}>×</button></div><div className="mt-2.5 flex gap-2"><button type="button" onClick={() => void applyProfile(profile)} disabled={serverRunning} title={serverRunning ? ut(locale, "stopBeforeProfile") : undefined} className="app-button app-button--primary app-button--sm">{ut(locale, "applyProfile")}</button><span className="self-center text-[10px] text-slate-600">flash-attn: {profile.flash_attn}</span></div></div>)}</div></section>
      <ConfirmDialog
        open={prPreview !== null}
        title={ut(locale, "prConfirmTitle")}
        description={prPreview ? <PullRequestProvenance locale={locale} preview={prPreview.preview} backend={prPreview.backend} /> : ""}
        confirmLabel={ut(locale, "prConfirmAction")}
        busy={prBusy}
        onConfirm={() => void installPullRequest()}
        onCancel={() => { if (!prBusy) setPrPreview(null); }}
      />
      <ConfirmDialog
        open={pendingUninstall !== null}
        title={ut(locale, "removeRuntimeTitle")}
        description={pendingUninstall ? ut(locale, "removeRuntimeBody", { backend: pendingUninstall.backend, build: buildNumber(pendingUninstall.build) }) : ""}
        confirmLabel={ut(locale, "removeRuntime")}
        busy={uninstallBusy}
        onConfirm={() => void confirmUninstall()}
        onCancel={() => { if (!uninstallBusy) setPendingUninstall(null); }}
      />
      <div className="runtime-refresh-row mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="runtime-flash-slot min-w-0 flex-1">
          {flash && <div className="w-full break-words rounded-lg border border-indigo-800 bg-indigo-950/50 px-3.5 py-2.5 text-sm text-indigo-200" role="status" aria-live="polite">{normalizeDisplayText(flash)}</div>}
        </div>
        <button type="button" onClick={() => void refresh(true)} disabled={runtimeBusy} className="app-button app-button--secondary app-button--sm shrink-0">{ut(locale, "refreshRemote")}</button>
      </div>

      <div className="runtime-list space-y-3.5">
        {visibleRows.map((row) => {
          const state = stateOf(row);
          const info = row.latest;
          const newestInstalled = !!info && row.installed.some((item) => item.build === info.build);
          const rowAction = runtimeRowAction({ busy: row.busy, newestInstalled });
          return (
            <section key={row.backend} className="min-w-0 rounded-xl border border-slate-700 bg-slate-800/40 p-4" aria-labelledby={`runtime-${row.backend}`} aria-busy={row.busy}>
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2"><h3 id={`runtime-${row.backend}`} className="text-sm font-semibold text-slate-100">{ut(locale, row.label, { id: row.backend })}</h3><span className={`rounded px-2 py-0.5 text-[11px] ${state.cls}`}>{state.label}</span>{device && <span className={`rounded px-2 py-0.5 text-[11px] ${fitClass[fitOf(row.backend)]}`}>{fitLabel[fitOf(row.backend)]}</span>}</div>
                  <div className="mt-0.5 break-words text-xs text-slate-500">{ut(locale, row.note)}{device && reasonText(suitabilityOf(row.backend)) ? ` · ${reasonText(suitabilityOf(row.backend))}` : ""}</div>
                </div>
                {rowAction === "cancel" ? <button type="button" onClick={() => void cancelInstall()} disabled={cancelBusy} className="app-button app-button--danger app-button--sm shrink-0">{cancelBusy ? ut(locale, "cancelling") : ut(locale, "cancelInstall")}</button> : rowAction === "install" ? <button type="button" onClick={() => void install(row.backend)} disabled={!info || serverRunning || prBusy || bundleBusy} title={serverRunning ? ut(locale, "stopBeforeRuntime") : prBusy ? ut(locale, "installingPr") : bundleBusy ? ut(locale, "runtimeBundleWorking") : !info ? ut(locale, "noLatestResolved") : undefined} className="app-button app-button--primary app-button--sm shrink-0">{info ? ut(locale, "installBuild", { build: buildNumber(info.build) }) : ut(locale, "installLatest")}</button> : null}
              </div>
              <div className={`runtime-latest-slot mt-2 text-[11px] ${info ? "text-slate-500" : "text-red-400"}`}>
                {info ? <span className="block truncate">{ut(locale, "latestBuild")}: <span className="text-slate-300">{ut(locale, "buildLabel", { build: buildNumber(info.build) })}</span>{" · "}{info.digest ? ut(locale, "digestPublished") : ut(locale, "digestUnavailable")}</span> : <span className="block truncate">{ut(locale, "latestUnavailable")}{row.latestErr ? `: ${row.latestErr}` : ` ${ut(locale, "latestUnavailableRetry")}`}</span>}
              </div>

              <div className="runtime-progress-slot mt-3">
                {row.busy && row.progress && <div role="progressbar" aria-label={ut(locale, "installedBuilds", { label: row.backend })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={row.progress.total > 0 ? Math.round((row.progress.received / row.progress.total) * 100) : undefined}><div className="mb-1 flex justify-between gap-2 text-xs text-slate-400"><span>{ut(locale, buildPhaseLabelKey(row.progress.phase))}</span>{row.progress.total > 0 && <span>{(row.progress.received / 1048576).toFixed(1)} / {(row.progress.total / 1048576).toFixed(1)} MB</span>}</div><div className="h-2 overflow-hidden rounded-full bg-slate-700"><div className="h-full rounded-full bg-indigo-500 transition-all" style={{ width: row.progress.total > 0 ? `${Math.min(100, row.progress.received / row.progress.total * 100)}%` : "100%" }} /></div></div>}
              </div>

              {row.installed.length > 0 && <div className="mt-3 flex min-w-0 flex-wrap gap-2.5" role="list" aria-label={ut(locale, "installedBuilds", { label: ut(locale, row.label, { id: row.backend }) })}>
                {row.installed.map((item) => {
                  const isActive = activeBackend === row.backend && activeBuild === item.build;
                  return <div key={item.build} role="listitem" className={`flex min-w-0 max-w-full flex-wrap items-center gap-2 rounded-lg border px-3 py-1.5 text-xs ${isActive ? "border-emerald-600 bg-emerald-950/40" : "border-slate-700 bg-slate-800/60"}`} title={normalizeDisplayPath(item.dir)}>
                    <span className="text-slate-200" title={item.source?.commit ? prSourceTitle(locale, item.source) : item.version?.commit ? `commit ${item.version.commit}` : item.build}>{item.source ? `${ut(locale, "runtimePrBuild", { pr: item.source.pull_request })} · ${item.source.commit.slice(0, 7)} · ` : ""}{formatRuntimeVersion(item.build, item.version)}</span><span className="text-slate-500">{item.size_mb.toFixed(1)} MB</span>{isActive ? <span className="rounded bg-emerald-800 px-1.5 py-0.5 text-[10px] text-emerald-200">{ut(locale, "active")}</span> : <><button type="button" onClick={() => void select(row.backend, item.build)} disabled={serverRunning || prBusy} title={serverRunning ? ut(locale, "stopBeforeSelect") : prBusy ? ut(locale, "installingPr") : undefined} className="app-button app-button--secondary app-button--sm">{ut(locale, "makeActive")}</button><button type="button" onClick={() => void uninstall(row.backend, item.build)} disabled={row.busy || serverRunning || prBusy} title={serverRunning ? ut(locale, "stopBeforeRemoveRuntime") : prBusy ? ut(locale, "installingPr") : undefined} className="app-button app-button--danger app-button--sm">{pt(locale, "remove")}</button></>}</div>;
                })}
              </div>}
            </section>
          );
        })}
      </div>
    </div>
  );
}
