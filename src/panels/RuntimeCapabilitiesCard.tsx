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
    <section className="runtime-capabilities-card mb-4 rounded-xl border p-4" style={{ borderColor: "var(--board-border)", background: "var(--board-panel)" }} aria-labelledby="runtime-capabilities-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="runtime-capabilities-heading" className="app-section-title">{t("section.runtimes")}</h2>
          <p className="app-section-hint">{t("ui.probeHint")}</p>
        </div>
        <button type="button" onClick={onProbe} disabled={probeBusy || serverRunning} title={serverRunning ? t("ui.stopBeforeSelect") : undefined} className="app-button app-button--primary app-button--sm shrink-0">{probeBusy ? t("ui.probing") : t("ui.probeRuntime")}</button>
      </div>
      {!capabilities && <p className="mt-3 text-xs" style={{ color: "var(--board-faint)" }}>{activeBackend && activeBuild ? t("ui.probeReady", { backend: activeBackend, build: buildNumber(activeBuild) }) : t("ui.probeNoRuntime")}</p>}
      {capabilities && (
        <div className="mt-3.5 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-5">
          <div className="rounded-lg border p-3" style={{ borderColor: "var(--board-border)", background: "var(--board-mono-bg)" }}><div className="app-eyebrow">{t("ui.probeState")}</div><div className="mt-1 text-xs font-semibold" style={{ color: capabilities.state === "available" ? "var(--board-success)" : "var(--board-warning)" }}>{capabilityLabel(capabilities.state)}</div><div className="mt-1 text-xs tabular-nums" style={{ color: "var(--board-faint)" }}>{capabilities.backend} · {capabilities.build}</div></div>
          <div className="rounded-lg border p-3" style={{ borderColor: "var(--board-border)", background: "var(--board-mono-bg)" }}><div className="app-eyebrow">{t("ui.probeVersion")}</div><div className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap break-words font-mono text-xs" style={{ color: "var(--board-ink)" }}>{capabilities.version || t("ui.notReported")}</div></div>
          <div className="rounded-lg border p-3" style={{ borderColor: "var(--board-border)", background: "var(--board-mono-bg)" }}><div className="app-eyebrow">{t("ui.probeFlags")}</div><div className="mt-1 text-xs" style={{ color: "var(--board-ink)" }}>{t("ui.flagsDiscovered", { count: capabilities.flags.length })}</div><div className="mt-1 truncate font-mono text-xs" style={{ color: "var(--board-faint)" }} title={capabilities.flags.join(", ")}>{capabilities.flags.slice(0, 3).join(", ") || t("ui.none")}</div></div>
          <div className="rounded-lg border p-3" style={{ borderColor: "var(--board-border)", background: "var(--board-mono-bg)" }}><div className="app-eyebrow">{t("ui.probeDevices")}</div><div className="mt-1 text-xs" style={{ color: "var(--board-ink)" }}>{t("ui.devicesVisible", { count: capabilities.devices.length })}</div><div className="mt-1 truncate text-xs" style={{ color: "var(--board-faint)" }} title={capabilities.devices.join(" · ")}>{capabilities.devices[0] || t("ui.noDevicesReported")}</div></div>
          <div className="rounded-lg border p-3" style={{ borderColor: "var(--board-border)", background: "var(--board-mono-bg)" }}><div className="app-eyebrow">{t("ui.probeBench")}</div><div className="mt-1 text-xs font-semibold" style={{ color: capabilities.bench_available ? "var(--board-success)" : "var(--board-warning)" }}>{capabilities.bench_available ? t("ui.benchAvailable") : t("ui.benchMissing")}</div><div className="mt-1 text-xs" style={{ color: "var(--board-faint)" }}>llama-bench --help</div></div>
        </div>
      )}
      {capabilities?.diagnostics.length ? <details className="mt-3"><summary className="cursor-pointer text-xs" style={{ color: "var(--board-warning)" }}>{t("ui.diagnosticsCount", { count: capabilities.diagnostics.length })}</summary><pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded p-2 font-mono text-xs" style={{ background: "var(--board-mono-bg)", color: "var(--board-faint)" }}>{capabilities.diagnostics.join("\n")}</pre></details> : null}
    </section>
  );
}
