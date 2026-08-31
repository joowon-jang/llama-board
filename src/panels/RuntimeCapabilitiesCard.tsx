import type * as api from "../api";
import type { UnifiedKey, TranslationVars } from "../i18nUnified";
import { buildNumber, capabilityLabel } from "../runtimeUtils";

interface Props {
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  capabilities: api.RuntimeCapabilities | null;
  probeBusy: boolean;
  serverRunning: boolean;
  activeBackend: string;
  activeBuild: string;
  onProbe: () => void;
}

export default function RuntimeCapabilitiesCard({ t, capabilities, probeBusy, serverRunning, activeBackend, activeBuild, onProbe }: Props) {
  return (
    <section className="runtime-capabilities-card mb-4 rounded-xl border border-slate-700 app-bg-muted p-4" aria-labelledby="runtime-capabilities-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="runtime-capabilities-heading" className="app-section-title">{t("section.runtimes")}</h2>
          <p className="app-section-hint">{t("ui.probeHint")}</p>
        </div>
        <button type="button" onClick={onProbe} disabled={probeBusy || serverRunning} title={serverRunning ? t("ui.stopBeforeSelect") : undefined} className="app-button app-button--primary app-button--sm shrink-0">{probeBusy ? t("ui.probing") : t("ui.probeRuntime")}</button>
      </div>
      {!capabilities && <p className="mt-3 text-xs text-slate-600">{activeBackend && activeBuild ? t("ui.probeReady", { backend: activeBackend, build: buildNumber(activeBuild) }) : t("ui.probeNoRuntime")}</p>}
      {capabilities && (
        <div className="mt-3.5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3"><div className="text-[10px] uppercase tracking-wide text-slate-600">{t("ui.probeState")}</div><div className={`mt-1 text-xs font-medium ${capabilities.state === "available" ? "text-emerald-300" : "text-amber-300"}`}>{capabilityLabel(capabilities.state)}</div><div className="mt-1 text-[10px] text-slate-600">{capabilities.backend} · {capabilities.build}</div></div>
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3"><div className="text-[10px] uppercase tracking-wide text-slate-600">{t("ui.probeVersion")}</div><div className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-slate-300">{capabilities.version || t("ui.notReported")}</div></div>
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3"><div className="text-[10px] uppercase tracking-wide text-slate-600">{t("ui.probeFlags")}</div><div className="mt-1 text-xs text-slate-300">{t("ui.flagsDiscovered", { count: capabilities.flags.length })}</div><div className="mt-1 truncate font-mono text-[10px] text-slate-600" title={capabilities.flags.join(", ")}>{capabilities.flags.slice(0, 3).join(", ") || t("ui.none")}</div></div>
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3"><div className="text-[10px] uppercase tracking-wide text-slate-600">{t("ui.probeDevices")}</div><div className="mt-1 text-xs text-slate-300">{t("ui.devicesVisible", { count: capabilities.devices.length })}</div><div className="mt-1 truncate text-[10px] text-slate-600" title={capabilities.devices.join(" · ")}>{capabilities.devices[0] || t("ui.noDevicesReported")}</div></div>
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3"><div className="text-[10px] uppercase tracking-wide text-slate-600">{t("ui.probeBench")}</div><div className={`mt-1 text-xs font-medium ${capabilities.bench_available ? "text-emerald-300" : "text-amber-300"}`}>{capabilities.bench_available ? t("ui.benchAvailable") : t("ui.benchMissing")}</div><div className="mt-1 text-[10px] text-slate-600">llama-bench --help</div></div>
        </div>
      )}
      {capabilities?.diagnostics.length ? <details className="mt-3"><summary className="cursor-pointer text-[11px] text-amber-400">{t("ui.diagnosticsCount", { count: capabilities.diagnostics.length })}</summary><pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded bg-slate-950 p-2 font-mono text-[10px] text-slate-500">{capabilities.diagnostics.join("\n")}</pre></details> : null}
    </section>
  );
}
