import type * as api from "../api";
import type { Locale } from "../i18nCatalog";
import type { UiTextKey } from "../uiI18n";
import { translate } from "../i18nUnified";
import { FIT_ORDER, type BackendRow } from "./runtimesHelpers";

export function fitOf(device: api.DeviceReport | null, backend: string): api.BackendFit {
  return device?.backends.find((item) => item.backend === backend)?.fit ?? "compatible";
}

export function suitabilityOf(device: api.DeviceReport | null, backend: string): api.BackendSuitability | undefined {
  return device?.backends.find((item) => item.backend === backend);
}

/** Only backends that can actually drive the detected GPU. Anything already
 * installed stays regardless, or the user could not see or remove it. If a
 * device report has no matching verdicts (for example an unsupported
 * architecture), keep the catalog visible rather than rendering an empty
 * runtime list. */
export function computeVisibleRows(rows: BackendRow[], device: api.DeviceReport | null, showAll: boolean) {
  const matchingRows = rows.filter((row) => showAll || !device || row.installed.length > 0 || fitOf(device, row.backend) === "recommended");
  const visibleRows = (matchingRows.length > 0 ? matchingRows : rows)
    .slice()
    .sort((left, right) => FIT_ORDER[fitOf(device, left.backend)] - FIT_ORDER[fitOf(device, right.backend)]);
  const hiddenCount = matchingRows.length > 0 ? rows.length - visibleRows.length : 0;
  return { visibleRows, hiddenCount };
}

export function deviceSummaryOf(locale: Locale, device: api.DeviceReport | null): string {
  if (!device) return translate(locale, "ui.detectionUnavailable");
  const gpu = device.profile.gpus.find((item) => !item.integrated) ?? device.profile.gpus[0];
  if (!gpu) return translate(locale, "ui.detectedNoGpu");
  return gpu.vram_mb
    ? translate(locale, "ui.detectedGpu", { name: gpu.name, vram: (gpu.vram_mb / 1024).toFixed(1) })
    : gpu.name;
}

export function fitLabelOf(locale: Locale, fit: api.BackendFit): string {
  return fit === "recommended" ? translate(locale, "ui.fitRecommended") : fit === "compatible" ? translate(locale, "ui.fitCompatible") : translate(locale, "ui.fitUnsupported");
}

export function fitClassOf(fit: api.BackendFit): string {
  return fit === "recommended" ? "bg-emerald-900/60 text-emerald-300" : fit === "compatible" ? "app-bg-elevated text-slate-300" : "app-bg-muted text-slate-500";
}

// Policy reasons arrive as keys so the backend never ships display strings.
export function reasonText(locale: Locale, suitability?: api.BackendSuitability): string {
  if (!suitability) return "";
  const key = `reason${suitability.reason.charAt(0).toUpperCase()}${suitability.reason.slice(1)}` as UiTextKey;
  return translate(locale, `ui.${key}`, { device: suitability.device ?? "" });
}

export function stateOf(locale: Locale, row: BackendRow, activeBackend: string, activeBuild: string): { label: string; cls: string } {
  if (row.busy) return { label: translate(locale, "ui.runtimeInstalling"), cls: "bg-amber-900/60 text-amber-300" };
  const active = activeBackend === row.backend && activeBuild !== "";
  if (row.installed.length === 0) return { label: active ? translate(locale, "ui.runtimeActiveSystem") : translate(locale, "ui.none"), cls: "app-bg-muted text-slate-400" };
  if (row.latest && row.installed.some((item) => item.build === row.latest?.build)) return { label: active ? translate(locale, "ui.runtimeActiveUpToDate") : translate(locale, "ui.runtimeUpToDate"), cls: "bg-emerald-900/60 text-emerald-300" };
  return { label: active ? translate(locale, "ui.active") : row.latest ? translate(locale, "ui.runtimeUpdateAvailable") : translate(locale, "ui.runtimeInstalled"), cls: active ? "bg-emerald-900/60 text-emerald-300" : "app-bg-elevated text-slate-200" };
}
