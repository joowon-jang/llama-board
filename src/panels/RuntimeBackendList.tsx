import type * as api from "../api";
import type { Locale } from "../i18nCatalog";
import { buildNumber, buildPhaseLabelKey, formatRuntimeVersion, runtimeRowAction } from "../runtimeUtils";
import { normalizeDisplayPath } from "../lifecycleUtils";
import type { UnifiedKey, TranslationVars } from "../i18nUnified";
import { prSourceTitle, type BackendRow } from "./runtimesHelpers";
import { fitClassOf, fitLabelOf, fitOf, reasonText, stateOf, suitabilityOf } from "./runtimeRowPresentation";

interface Props {
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  locale: Locale;
  visibleRows: BackendRow[];
  device: api.DeviceReport | null;
  activeBackend: string;
  activeBuild: string;
  serverRunning: boolean;
  prBusy: boolean;
  bundleBusy: boolean;
  cancelBusy: boolean;
  onCancelInstall: () => void;
  onInstall: (backend: string) => void;
  onSelect: (backend: string, build: string) => void;
  onUninstall: (backend: string, build: string) => void;
}

export default function RuntimeBackendList({
  t, locale, visibleRows, device, activeBackend, activeBuild, serverRunning, prBusy, bundleBusy, cancelBusy,
  onCancelInstall, onInstall, onSelect, onUninstall,
}: Props) {
  return (
    <div className="runtime-list space-y-3.5">
      {visibleRows.map((row) => {
        const state = stateOf(locale, row, activeBackend, activeBuild);
        const info = row.latest;
        const newestInstalled = !!info && row.installed.some((item) => item.build === info.build);
        const rowAction = runtimeRowAction({ busy: row.busy, newestInstalled });
        return (
          <section key={row.backend} className="min-w-0 rounded-xl border border-slate-700 app-bg-muted p-4" aria-labelledby={`runtime-${row.backend}`} aria-busy={row.busy}>
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h3 id={`runtime-${row.backend}`} className="text-sm font-semibold text-slate-100">{t(`ui.${row.label}`, { id: row.backend })}</h3>
                  <span className={`rounded px-2 py-0.5 text-[11px] ${state.cls}`}>{state.label}</span>
                  {device && <span className={`rounded px-2 py-0.5 text-[11px] ${fitClassOf(fitOf(device, row.backend))}`}>{fitLabelOf(locale, fitOf(device, row.backend))}</span>}
                </div>
                <div className="mt-0.5 break-words text-xs text-slate-500">{t(`ui.${row.note}`)}{device && reasonText(locale, suitabilityOf(device, row.backend)) ? ` · ${reasonText(locale, suitabilityOf(device, row.backend))}` : ""}</div>
              </div>
              {rowAction === "cancel" ? (
                <button type="button" onClick={onCancelInstall} disabled={cancelBusy} className="app-button app-button--danger app-button--sm shrink-0">{cancelBusy ? t("ui.cancelling") : t("ui.cancelInstall")}</button>
              ) : rowAction === "install" ? (
                <button type="button" onClick={() => onInstall(row.backend)} disabled={!info || serverRunning || prBusy || bundleBusy} title={serverRunning ? t("ui.stopBeforeRuntime") : prBusy ? t("ui.installingPr") : bundleBusy ? t("ui.runtimeBundleWorking") : !info ? t("ui.noLatestResolved") : undefined} className="app-button app-button--primary app-button--sm shrink-0">{info ? t("ui.installBuild", { build: buildNumber(info.build) }) : t("ui.installLatest")}</button>
              ) : null}
            </div>
            <div className={`runtime-latest-slot mt-2 text-[11px] ${info ? "text-slate-500" : "text-red-400"}`}>
              {info
                ? <span className="block truncate">{t("ui.latestBuild")}: <span className="text-slate-300">{t("ui.buildLabel", { build: buildNumber(info.build) })}</span>{" · "}{info.digest ? t("ui.digestPublished") : t("ui.digestUnavailable")}</span>
                : <span className="block truncate">{t("ui.latestUnavailable")}{row.latestErr ? `: ${row.latestErr}` : ` ${t("ui.latestUnavailableRetry")}`}</span>}
            </div>

            <div className="runtime-progress-slot mt-3">
              {row.busy && row.progress && (
                <div role="progressbar" aria-label={t("ui.installedBuilds", { label: row.backend })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={row.progress.total > 0 ? Math.round((row.progress.received / row.progress.total) * 100) : undefined}>
                  <div className="mb-1 flex justify-between gap-2 text-xs text-slate-400">
                    <span>{t(`ui.${buildPhaseLabelKey(row.progress.phase)}`)}</span>
                    {row.progress.total > 0 && <span>{(row.progress.received / 1048576).toFixed(1)} / {(row.progress.total / 1048576).toFixed(1)} MB</span>}
                  </div>
                  <div className="h-2 overflow-hidden rounded-full app-bg-elevated"><div className="h-full rounded-full app-bg-accent-solid transition-all" style={{ width: row.progress.total > 0 ? `${Math.min(100, row.progress.received / row.progress.total * 100)}%` : "100%" }} /></div>
                </div>
              )}
            </div>

            {row.installed.length > 0 && (
              <div className="mt-3 flex min-w-0 flex-wrap gap-2.5" role="list" aria-label={t("ui.installedBuilds", { label: t(`ui.${row.label}`, { id: row.backend }) })}>
                {row.installed.map((item) => {
                  const isActive = activeBackend === row.backend && activeBuild === item.build;
                  return (
                    <div key={item.build} role="listitem" className={`flex min-w-0 max-w-full flex-wrap items-center gap-2 rounded-lg border px-3 py-1.5 text-xs ${isActive ? "app-border-success bg-emerald-950/40" : "border-slate-700 app-bg-muted"}`} title={normalizeDisplayPath(item.dir)}>
                      <span className="text-slate-200" title={item.source?.commit ? prSourceTitle(locale, item.source) : item.version?.commit ? `commit ${item.version.commit}` : item.build}>{item.source ? `${t("ui.runtimePrBuild", { pr: item.source.pull_request })} · ${item.source.commit.slice(0, 7)} · ` : ""}{formatRuntimeVersion(item.build, item.version)}</span>
                      <span className="text-slate-500">{item.size_mb.toFixed(1)} MB</span>
                      {isActive ? (
                        <span className="rounded bg-emerald-800 px-1.5 py-0.5 text-[10px] text-emerald-200">{t("ui.active")}</span>
                      ) : (
                        <>
                          <button type="button" onClick={() => onSelect(row.backend, item.build)} disabled={serverRunning || prBusy} title={serverRunning ? t("ui.stopBeforeSelect") : prBusy ? t("ui.installingPr") : undefined} className="app-button app-button--secondary app-button--sm">{t("ui.makeActive")}</button>
                          <button type="button" onClick={() => onUninstall(row.backend, item.build)} disabled={row.busy || serverRunning || prBusy} title={serverRunning ? t("ui.stopBeforeRemoveRuntime") : prBusy ? t("ui.installingPr") : undefined} className="app-button app-button--danger app-button--sm">{t("panel.remove")}</button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
