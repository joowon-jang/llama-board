import type * as api from "../api";
import type { UnifiedKey, TranslationVars } from "../i18nUnified";

interface Props {
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  device: api.DeviceReport | null;
  deviceSummary: string;
  showAll: boolean;
  hiddenCount: number;
  onToggleShowAll: () => void;
}

export default function RuntimeDeviceCard({ t, device, deviceSummary, showAll, hiddenCount, onToggleShowAll }: Props) {
  return (
    <section className="runtime-detected-device mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-700 app-bg-muted p-4" aria-labelledby="detected-device-heading">
      <div className="min-w-0">
        <h2 id="detected-device-heading" className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{t("ui.detectedDevice")}</h2>
        <div className="mt-1 min-w-0 truncate text-sm text-slate-200" title={deviceSummary}>{deviceSummary}</div>
        <div className="mt-0.5 min-w-0 truncate text-[11px] text-slate-500" title={device ? `${device.profile.cpu.name} · ${device.profile.cpu.logical_cores}T · ${device.profile.os}/${device.profile.arch}` : undefined}>
          {device ? `${device.profile.cpu.name} · ${device.profile.cpu.logical_cores}T · ${device.profile.os}/${device.profile.arch}` : "—"}
        </div>
      </div>
      <div className="runtime-device-actions flex shrink-0 flex-wrap items-center gap-2">
        <span className={`runtime-hidden-count text-[11px] text-slate-500 ${!showAll && hiddenCount > 0 ? "" : "is-empty"}`}>{t("ui.hiddenBackends", { count: hiddenCount })}</span>
        <button type="button" aria-pressed={showAll} onClick={onToggleShowAll} className="app-button app-button--secondary runtime-show-all">
          {showAll ? t("ui.showRecommendedOnly") : t("ui.showAllBackends")}
        </button>
      </div>
    </section>
  );
}
