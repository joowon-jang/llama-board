import type { Dispatch, SetStateAction } from "react";
import * as api from "../api";
import type { Locale } from "../i18nCatalog";
import { canBuildPrBackend, isInstallCancellation } from "../runtimeUtils";
import { translate } from "../i18nUnified";
import type { BackendRow } from "./runtimesHelpers";

interface CommonDeps {
  locale: Locale;
  flashT: (message: string) => void;
  setFailure: (message: string | null) => void;
  serverRunning: boolean;
}

/** Downloads and installs the latest resolved build for one backend. */
export async function runInstall(
  backend: string,
  rows: BackendRow[],
  setRows: Dispatch<SetStateAction<BackendRow[]>>,
  refresh: () => Promise<void>,
  prBusy: boolean,
  bundleBusy: boolean,
  deps: CommonDeps,
): Promise<void> {
  if (prBusy || bundleBusy) return;
  deps.setFailure(null);
  const row = rows.find((item) => item.backend === backend);
  const info = row?.latest;
  if (!info) {
    deps.flashT(translate(deps.locale, "ui.noLatestResolved"));
    return;
  }
  if (deps.serverRunning) {
    deps.flashT(translate(deps.locale, "ui.stopBeforeRuntime"));
    return;
  }
  setRows((previous) => previous.map((item) => item.backend === backend ? { ...item, busy: true } : item));
  try {
    await api.rtInstall(backend, info.build);
    deps.flashT(translate(deps.locale, "ui.installedOk", { backend, build: info.build }));
    await refresh();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isInstallCancellation(message)) deps.flashT(translate(deps.locale, "ui.installCancelled"));
    else deps.setFailure(`${translate(deps.locale, "ui.installFailed")}: ${message}`);
  } finally {
    setRows((previous) => previous.map((item) => item.backend === backend ? { ...item, busy: false, progress: null } : item));
  }
}

/** Makes an already-installed build active. */
export async function runSelect(backend: string, build: string, runtimeBusy: boolean, deps: CommonDeps, loadConfig: () => Promise<void>): Promise<void> {
  deps.setFailure(null);
  if (runtimeBusy) return;
  if (deps.serverRunning) {
    deps.flashT(translate(deps.locale, "ui.stopBeforeSelect"));
    return;
  }
  try {
    await api.rtSelect(backend, build);
    await loadConfig();
    deps.flashT(translate(deps.locale, "ui.activeRuntimeNow", { backend, build }));
  } catch (error) {
    deps.setFailure(`${translate(deps.locale, "ui.selectFailed")}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Exports one installed build as a portable archive. */
export async function runExportRuntime(
  backend: string,
  build: string,
  runtimeBusy: boolean,
  setBundleBusy: (value: boolean) => void,
  setBundleProgress: (value: api.DownloadProgress | null) => void,
  deps: CommonDeps,
): Promise<void> {
  if (runtimeBusy) return;
  if (deps.serverRunning) {
    deps.flashT(translate(deps.locale, "ui.stopBeforeRuntime"));
    return;
  }
  deps.setFailure(null);
  setBundleBusy(true);
  setBundleProgress(null);
  try {
    const info = await api.rtExport(backend, build);
    deps.flashT(translate(deps.locale, "ui.runtimeBundleExported", {
      backend: info.backend,
      build: info.build,
      path: info.path,
      sha: info.archive_sha256,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "runtime export cancelled" || isInstallCancellation(message)) {
      deps.flashT(translate(deps.locale, "ui.runtimeBundleCancelled"));
    } else {
      deps.setFailure(translate(deps.locale, "ui.runtimeBundleExportFailed") + ": " + message);
    }
  } finally {
    setBundleBusy(false);
    setBundleProgress(null);
  }
}

/** Imports a portable runtime archive picked by the user. */
export async function runImportRuntime(
  runtimeBusy: boolean,
  setBundleBusy: (value: boolean) => void,
  setBundleProgress: (value: api.DownloadProgress | null) => void,
  refresh: (force?: boolean) => Promise<void>,
  deps: CommonDeps,
): Promise<void> {
  if (runtimeBusy) return;
  if (deps.serverRunning) {
    deps.flashT(translate(deps.locale, "ui.stopBeforeRuntime"));
    return;
  }
  deps.setFailure(null);
  setBundleBusy(true);
  setBundleProgress(null);
  try {
    const installed = await api.rtImport();
    deps.flashT(translate(deps.locale, "ui.runtimeBundleImported", { backend: installed.backend, build: installed.build }));
    await refresh(true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "runtime import cancelled" || isInstallCancellation(message)) {
      deps.flashT(translate(deps.locale, "ui.runtimeBundleCancelled"));
    } else {
      deps.setFailure(translate(deps.locale, "ui.runtimeBundleImportFailed") + ": " + message);
    }
  } finally {
    setBundleBusy(false);
    setBundleProgress(null);
  }
}

/**
 * Step one of two. Resolve the PR and show who wrote it, where it lives and
 * which commit it points at. Nothing is downloaded or compiled until the
 * user has seen this and agreed to it.
 */
export async function runReviewPullRequest(
  prSource: string,
  prBackend: string,
  rows: BackendRow[],
  prBusy: boolean,
  bundleBusy: boolean,
  prReviewBusy: boolean,
  setPrReviewBusy: (value: boolean) => void,
  setPrPreview: (value: { backend: string; source: string; preview: api.PullRequestPreview } | null) => void,
  deps: CommonDeps,
): Promise<void> {
  const source = prSource.trim();
  const backend = prBackend;
  if (!source) {
    deps.flashT(translate(deps.locale, "ui.enterPrSource"));
    return;
  }
  // The backend refuses these before it downloads anything; say so without
  // a round trip, and keep it on screen instead of flashing it away.
  if (!canBuildPrBackend(backend)) {
    deps.setFailure(translate(deps.locale, "ui.prBackendBlocked", { backend }));
    return;
  }
  if (deps.serverRunning) {
    deps.flashT(translate(deps.locale, "ui.stopBeforeRuntime"));
    return;
  }
  if (prBusy || bundleBusy || prReviewBusy || rows.some((row) => row.busy)) return;
  deps.setFailure(null);
  setPrReviewBusy(true);
  try {
    setPrPreview({ backend, source, preview: await api.rtPrPreview(backend, source) });
  } catch (error) {
    deps.setFailure(`${translate(deps.locale, "ui.prPreviewFailed")}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    setPrReviewBusy(false);
  }
}

export interface PrInstallState {
  pending: { backend: string; source: string; preview: api.PullRequestPreview };
  prInstallInFlight: { current: boolean };
  prBusy: boolean;
  bundleBusy: boolean;
  rows: BackendRow[];
  setPrPreview: (value: null) => void;
  setPrBusy: (value: boolean) => void;
  setActivePrBackend: (value: string | null) => void;
  setCancelBusy: (value: boolean) => void;
  setPrSource: (value: string) => void;
  setRows: Dispatch<SetStateAction<BackendRow[]>>;
  refresh: () => Promise<void>;
}

/**
 * Step two. The confirmed head commit goes back to the backend, which
 * re-resolves the PR and refuses to build anything else — so a branch that
 * is force-pushed between the dialog and this call is caught, not built.
 */
export async function runInstallPullRequest(state: PrInstallState, deps: CommonDeps): Promise<void> {
  if (state.prInstallInFlight.current) return;
  if (state.prBusy || state.bundleBusy || state.rows.some((row) => row.busy)) return;
  // Pin the backend for the whole run: the busy flag has to be cleared on
  // the row it was set on, whatever the picker says by the time we finish.
  const { backend, source, preview } = state.pending;
  state.setPrPreview(null);
  if (!canBuildPrBackend(backend)) {
    deps.setFailure(translate(deps.locale, "ui.prBackendBlocked", { backend }));
    return;
  }
  if (deps.serverRunning) {
    deps.flashT(translate(deps.locale, "ui.stopBeforeRuntime"));
    return;
  }
  if (state.prBusy || state.bundleBusy || state.rows.some((row) => row.busy)) return;
  state.prInstallInFlight.current = true;
  deps.setFailure(null);
  state.setPrBusy(true);
  state.setActivePrBackend(backend);
  state.setRows((previous) => previous.map((item) => item.backend === backend ? { ...item, busy: true, progress: null } : item));
  try {
    const installed = await api.rtInstallPr(backend, source, preview.commit);
    // A PR keeps one directory, so a rebuild swaps the bytes behind a row
    // whose name did not change. Say which commit went away.
    const replaced = installed.replaced;
    deps.flashT(replaced
      ? translate(deps.locale, "ui.installedPrReplacedOk", { backend, pr: installed.source?.pull_request ?? source, previous: replaced.previous_commit.slice(0, 7) })
      : translate(deps.locale, "ui.installedPrOk", { backend, pr: installed.source?.pull_request ?? source }));
    state.setPrSource("");
    await state.refresh();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isInstallCancellation(message)) deps.flashT(translate(deps.locale, "ui.installCancelled"));
    else deps.setFailure(`${translate(deps.locale, "ui.installFailed")}: ${message}`);
  } finally {
    state.prInstallInFlight.current = false;
    state.setPrBusy(false);
    state.setActivePrBackend(null);
    state.setCancelBusy(false);
    state.setRows((previous) => previous.map((item) => item.backend === backend ? { ...item, busy: false, progress: null } : item));
  }
}
