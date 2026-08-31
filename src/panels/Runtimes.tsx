import type { AppStore } from "../store";
import ConfirmDialog from "../components/ConfirmDialog";
import FeedbackBanner from "../components/FeedbackBanner";
import { useI18n } from "../i18n";
import { buildNumber } from "../runtimeUtils";
import { normalizeDisplayText } from "../lifecycleUtils";
import { useRuntimesController } from "./useRuntimesController";
import { computeVisibleRows, deviceSummaryOf } from "./runtimeRowPresentation";
import RuntimeDeviceCard from "./RuntimeDeviceCard";
import RuntimeCapabilitiesCard from "./RuntimeCapabilitiesCard";
import RuntimePullRequestCard from "./RuntimePullRequestCard";
import RuntimePortableBundle from "./RuntimePortableBundle";
import RuntimeLoadingProfiles from "./RuntimeLoadingProfiles";
import RuntimeBackendList from "./RuntimeBackendList";
import PullRequestProvenance from "./RuntimePullRequestProvenance";

export type { BackendRow } from "./runtimesHelpers";

export default function RuntimesPanel({ store, active = true }: { store: AppStore; active?: boolean }) {
  const { t, locale } = useI18n();
  const rt = useRuntimesController(store, active);
  const { visibleRows, hiddenCount } = computeVisibleRows(rt.rows, rt.device, rt.showAll);
  const activePrProgress = rt.activePrBackend ? rt.rows.find((row) => row.backend === rt.activePrBackend)?.progress : null;
  const deviceSummary = deviceSummaryOf(locale, rt.device);

  return (
    <div className="app-page-scroll relative flex h-full min-h-0 flex-col p-4">
      <p className="mb-4 break-words text-sm text-slate-400">{t("ui.runtimesIntro")}</p>

      <RuntimeDeviceCard
        t={t}
        device={rt.device}
        deviceSummary={deviceSummary}
        showAll={rt.showAll}
        hiddenCount={hiddenCount}
        onToggleShowAll={rt.toggleShowAll}
      />
      <div className="app-panel-feedback-layer" aria-live="polite">
        {rt.failure && <FeedbackBanner tone="error" title={t("error.wrong")} onDismiss={() => rt.setFailure(null)}>{rt.failure}</FeedbackBanner>}
        {rt.loadError && <div className="flex flex-wrap items-center gap-2 rounded-lg border border-red-800 bg-red-950/50 px-3.5 py-2.5 text-sm text-red-200" role="alert"><span className="min-w-0 flex-1 break-words">{t("ui.runtimeLookupFailed")}: {rt.loadError}</span><button type="button" onClick={() => void rt.refresh()} className="app-button app-button--danger app-button--sm">{t("panel.retry")}</button></div>}
      </div>

      <RuntimeCapabilitiesCard
        t={t}
        capabilities={rt.capabilities}
        probeBusy={rt.probeBusy}
        serverRunning={rt.serverRunning}
        activeBackend={rt.activeBackend}
        activeBuild={rt.activeBuild}
        onProbe={() => void rt.probe()}
      />

      <RuntimePullRequestCard
        t={t}
        prBackend={rt.prBackend}
        setPrBackend={rt.setPrBackend}
        prBackendTouched={rt.prBackendTouched}
        prSource={rt.prSource}
        setPrSource={rt.setPrSource}
        prBusy={rt.prBusy}
        bundleBusy={rt.bundleBusy}
        prReviewBusy={rt.prReviewBusy}
        serverRunning={rt.serverRunning}
        rows={rt.rows}
        cancelBusy={rt.cancelBusy}
        activePrProgress={activePrProgress}
        onReview={() => void rt.reviewPullRequest()}
        onCancel={() => void rt.cancelInstall()}
      />

      <RuntimePortableBundle
        t={t}
        rows={rt.rows}
        bundleBusy={rt.bundleBusy}
        bundleProgress={rt.bundleProgress}
        runtimeBusy={rt.runtimeBusy}
        serverRunning={rt.serverRunning}
        cancelBusy={rt.cancelBusy}
        onImport={() => void rt.importRuntime()}
        onExport={(backend, build) => void rt.exportRuntime(backend, build)}
        onCancel={() => void rt.cancelInstall()}
      />

      <RuntimeLoadingProfiles
        t={t}
        profiles={rt.profiles}
        profileName={rt.profileName}
        onProfileNameChange={rt.setProfileName}
        onSave={rt.saveProfile}
        onApply={(profile) => void rt.applyProfile(profile)}
        onRemove={rt.removeProfile}
        canSave={!!store.cfg}
        serverRunning={rt.serverRunning}
      />
      <ConfirmDialog
        open={rt.prPreview !== null}
        title={t("ui.prConfirmTitle")}
        description={rt.prPreview ? <PullRequestProvenance t={t} preview={rt.prPreview.preview} backend={rt.prPreview.backend} /> : ""}
        confirmLabel={t("ui.prConfirmAction")}
        busy={rt.prBusy}
        onConfirm={() => void rt.installPullRequest()}
        onCancel={() => { if (!rt.prBusy) rt.setPrPreview(null); }}
      />
      <ConfirmDialog
        open={rt.pendingUninstall !== null}
        title={t("ui.removeRuntimeTitle")}
        description={rt.pendingUninstall ? t("ui.removeRuntimeBody", { backend: rt.pendingUninstall.backend, build: buildNumber(rt.pendingUninstall.build) }) : ""}
        confirmLabel={t("ui.removeRuntime")}
        busy={rt.uninstallBusy}
        onConfirm={() => void rt.confirmUninstall()}
        onCancel={() => { if (!rt.uninstallBusy) rt.setPendingUninstall(null); }}
      />
      <div className="runtime-refresh-row mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="runtime-flash-slot min-w-0 flex-1">
          {rt.flash && <div className="w-full break-words rounded-lg border border-indigo-800 bg-indigo-950/50 px-3.5 py-2.5 text-sm text-indigo-200" role="status" aria-live="polite">{normalizeDisplayText(rt.flash)}</div>}
        </div>
        <button type="button" onClick={() => void rt.refresh(true)} disabled={rt.runtimeBusy} className="app-button app-button--secondary app-button--sm shrink-0">{t("ui.refreshRemote")}</button>
      </div>

      <RuntimeBackendList
        t={t}
        locale={locale}
        visibleRows={visibleRows}
        device={rt.device}
        activeBackend={rt.activeBackend}
        activeBuild={rt.activeBuild}
        serverRunning={rt.serverRunning}
        prBusy={rt.prBusy}
        bundleBusy={rt.bundleBusy}
        cancelBusy={rt.cancelBusy}
        onCancelInstall={() => void rt.cancelInstall()}
        onInstall={(backend) => void rt.install(backend)}
        onSelect={(backend, build) => void rt.select(backend, build)}
        onUninstall={(backend, build) => void rt.uninstall(backend, build)}
      />
    </div>
  );
}
