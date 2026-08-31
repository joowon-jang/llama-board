import type * as api from "../api";
import { buildNumber, buildPhaseLabelKey } from "../runtimeUtils";
import type { UnifiedKey, TranslationVars } from "../i18nUnified";
import type { BackendRow } from "./runtimesHelpers";

interface Props {
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  rows: BackendRow[];
  bundleBusy: boolean;
  bundleProgress: api.DownloadProgress | null;
  runtimeBusy: boolean;
  serverRunning: boolean;
  cancelBusy: boolean;
  onImport: () => void;
  onExport: (backend: string, build: string) => void;
  onCancel: () => void;
}

/** Presentational: the "Portable runtime" import/export card on the Runtimes panel. */
export default function RuntimePortableBundle({
  t, rows, bundleBusy, bundleProgress, runtimeBusy, serverRunning, cancelBusy, onImport, onExport, onCancel,
}: Props) {
  return (
    <section className="mb-4 rounded-xl border app-border-success bg-emerald-950/20 p-4" aria-labelledby="portable-runtime-heading" aria-busy={bundleBusy}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="portable-runtime-heading" className="app-section-title">{t("ui.portableRuntimeTitle")}</h2>
          <p className="app-section-hint break-words">{t("ui.portableRuntimeHint")}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button type="button" onClick={onImport} disabled={runtimeBusy || serverRunning} title={serverRunning ? t("ui.stopBeforeRuntime") : undefined} className="app-button app-button--primary app-button--sm">{bundleBusy ? t("ui.runtimeBundleWorking") : t("ui.importRuntimeBundle")}</button>
          {bundleBusy && <button type="button" onClick={onCancel} disabled={cancelBusy} className="app-button app-button--danger app-button--sm">{cancelBusy ? t("ui.cancelling") : t("ui.cancelRuntimeBundle")}</button>}
        </div>
      </div>
      <div className="runtime-progress-slot mt-3">
        {bundleBusy && bundleProgress && (
          <div role="progressbar" aria-label={t("ui.portableRuntimeTitle")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={bundleProgress.total > 0 ? Math.round((bundleProgress.received / bundleProgress.total) * 100) : undefined}>
            <div className="mb-1 flex justify-between gap-2 text-xs text-slate-400">
              <span>{t(`ui.${buildPhaseLabelKey(bundleProgress.phase)}`)}</span>
              {bundleProgress.total > 0 && <span>{(bundleProgress.received / 1048576).toFixed(1)} / {(bundleProgress.total / 1048576).toFixed(1)} MB</span>}
            </div>
            <div className="h-2 overflow-hidden rounded-full app-bg-elevated">
              <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: bundleProgress.total > 0 ? String(Math.min(100, bundleProgress.received / bundleProgress.total * 100)) + "%" : "100%" }} />
            </div>
          </div>
        )}
      </div>
      {rows.some((row) => row.installed.length > 0) && (
        <div className="mt-3 flex min-w-0 flex-wrap gap-2" aria-label={t("ui.exportRuntime")}>
          {rows.flatMap((row) => row.installed.map((item) => (
            <button key={row.backend + ":" + item.build} type="button" onClick={() => onExport(row.backend, item.build)} disabled={runtimeBusy || serverRunning} title={serverRunning ? t("ui.stopBeforeRuntime") : undefined} className="app-button app-button--secondary app-button--sm">
              {t("ui.exportRuntime")}: {row.backend} {buildNumber(item.build)}
            </button>
          )))}
        </div>
      )}
    </section>
  );
}
