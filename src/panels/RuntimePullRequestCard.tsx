import type { MutableRefObject } from "react";
import { CustomSelect } from "../components/ThemeSwitcher";
import { canBuildPrBackend, buildPhaseLabelKey } from "../runtimeUtils";
import type { UnifiedKey, TranslationVars } from "../i18nUnified";
import { BACKENDS, type BackendRow } from "./runtimesHelpers";
import type * as api from "../api";

interface Props {
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  prBackend: string;
  setPrBackend: (value: string) => void;
  prBackendTouched: MutableRefObject<boolean>;
  prSource: string;
  setPrSource: (value: string) => void;
  prBusy: boolean;
  bundleBusy: boolean;
  prReviewBusy: boolean;
  serverRunning: boolean;
  rows: BackendRow[];
  cancelBusy: boolean;
  activePrProgress: api.DownloadProgress | null | undefined;
  onReview: () => void;
  onCancel: () => void;
}

export default function RuntimePullRequestCard({
  t, prBackend, setPrBackend, prBackendTouched, prSource, setPrSource, prBusy, bundleBusy, prReviewBusy,
  serverRunning, rows, cancelBusy, activePrProgress, onReview, onCancel,
}: Props) {
  return (
    <section className="mb-4 rounded-xl border border-amber-800 bg-amber-950/20 p-4" aria-labelledby="pull-request-runtime-heading">
      <div>
        <h2 id="pull-request-runtime-heading" className="app-section-title">{t("ui.installPrTitle")}</h2>
        <p className="app-section-hint break-words">{t("ui.installPrHint")}</p>
        <p className="app-section-hint break-words text-amber-300/80">{t("ui.prBackendUnsupportedHint")}</p>
      </div>
      <div className="mt-3.5 grid gap-3 md:grid-cols-[12rem_minmax(0,1fr)_auto] md:items-end">
        <label className="block text-xs text-slate-400">
          <span className="mb-1 block">{t("ui.prBackendLabel")}</span>
          <CustomSelect
            value={prBackend}
            options={BACKENDS.map((backend) => {
              const supported = canBuildPrBackend(backend.id);
              return {
                value: backend.id,
                label: `${t(`ui.${backend.label}`, { id: backend.id })}${supported ? "" : " — " + t("ui.prBackendUnsupported")}`,
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
          <span className="mb-1 block">{t("ui.prSourceLabel")}</span>
          <input value={prSource} onChange={(event) => setPrSource(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onReview(); }} disabled={prBusy || bundleBusy || serverRunning} placeholder={t("ui.prSourcePlaceholder")} className="app-input mt-1" />
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onReview} disabled={!prSource.trim() || prBusy || bundleBusy || prReviewBusy || !canBuildPrBackend(prBackend) || rows.some((row) => row.busy) || serverRunning} title={serverRunning ? t("ui.stopBeforeRuntime") : !canBuildPrBackend(prBackend) ? t("ui.prBackendBlocked", { backend: prBackend }) : undefined} className="app-button app-button--primary app-button--sm">{prBusy ? t("ui.installingPr") : prReviewBusy ? t("ui.prResolving") : t("ui.reviewPrAction")}</button>
          {prBusy && <button type="button" onClick={onCancel} disabled={cancelBusy} className="app-button app-button--danger app-button--sm">{cancelBusy ? t("ui.cancelling") : t("ui.cancelPrBuild")}</button>}
        </div>
      </div>
      <div className="runtime-progress-slot mt-3">
        {prBusy && activePrProgress && <div role="status" aria-live="polite"><div className="mb-1 flex justify-between gap-2 text-xs text-slate-400"><span>{t(`ui.${buildPhaseLabelKey(activePrProgress.phase)}`)}</span><span>{t("ui.installingPr")}</span></div><div className="h-2 overflow-hidden rounded-full app-bg-elevated"><div className="h-full w-full animate-pulse rounded-full bg-amber-500" /></div></div>}
      </div>
    </section>
  );
}
