import { useEffect, useState } from "react";
import * as api from "../api";
import type { AppStore } from "../store";
import { parseNumericInput } from "./tuningValidation";
import { useI18n } from "../i18n";
import { benchmarkCsv, benchmarkFingerprint, benchmarkMetrics, BENCHMARK_RECORD_SCHEMA, isServerRunning, normalizeDisplayPath, normalizeDisplayText, type BenchmarkDevice, type BenchmarkRecord } from "../lifecycleUtils";

const BENCH_HISTORY_KEY = "llama-board-benchmark-history.v1";

function readHistory(): BenchmarkRecord[] {
  try {
    const value = JSON.parse(localStorage.getItem(BENCH_HISTORY_KEY) ?? "[]") as unknown;
    // Records written before the versioned envelope lack the metric shape, so
    // they are dropped rather than rendered with undefined values.
    return Array.isArray(value)
      ? value.filter((item): item is BenchmarkRecord =>
          !!item && typeof item === "object" && (item as BenchmarkRecord).schemaVersion === BENCHMARK_RECORD_SCHEMA)
      : [];
  } catch { return []; }
}

function toBenchmarkDevice(report: api.DeviceReport | null): BenchmarkDevice | undefined {
  if (!report) return undefined;
  const gpu = report.profile.gpus.find((item) => !item.integrated) ?? report.profile.gpus[0];
  return {
    fingerprint: report.profile.fingerprint,
    os: report.profile.os,
    arch: report.profile.arch,
    cpu: report.profile.cpu.name,
    cpuThreads: report.profile.cpu.logical_cores,
    gpu: gpu?.name,
    gpuVendor: gpu?.vendor,
    gpuVramMb: gpu?.vram_mb,
  };
}

function downloadText(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url);
}

export default function BenchPanel({ store }: { store: AppStore }) {
  const { t } = useI18n();
  const cfg = store.cfg;
  const configuredIters = cfg?.iters;
  const [phase, setPhase] = useState<"idle" | "running" | "canceling">("idle");
  const [rows, setRows] = useState<api.BenchRow[]>([]);
  const [effectiveArgs, setEffectiveArgs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [itersDraft, setItersDraft] = useState(String(cfg?.iters ?? 5));
  const [itersDirty, setItersDirty] = useState(false);
  const [history, setHistory] = useState<BenchmarkRecord[]>(readHistory);
  const [device, setDevice] = useState<api.DeviceReport | null>(null);

  useEffect(() => {
    void api.deviceProfile().then(setDevice).catch(() => setDevice(null));
  }, []);

  useEffect(() => {
    if (configuredIters !== undefined && !itersDirty) setItersDraft(String(configuredIters));
  }, [configuredIters, itersDirty]);

  const serverRunning = isServerRunning(store.status.state);
  const model = cfg?.active_model ?? "";
  const displayModel = normalizeDisplayPath(model);
  const canRun = !!cfg && !!model && phase === "idle" && !serverRunning && !store.busy;

  const run = async () => {
    if (!cfg) return;
    setError(null);
    setInfo(null);
    setRows([]);
    setEffectiveArgs([]);
    setPhase("running");
    try {
      const parsed = parseNumericInput(itersDraft, 1);
      const iters = Math.min(100, Math.max(1, parsed ?? cfg.iters));
      setItersDraft(String(iters));
      setItersDirty(false);
      const runCfg = { ...cfg, iters };
      const result = await api.runBench(runCfg);
      setRows(result.rows);
      setEffectiveArgs(result.args);
      const record: BenchmarkRecord = {
        schemaVersion: BENCHMARK_RECORD_SCHEMA,
        id: `bench-${Date.now().toString(36)}`,
        device: toBenchmarkDevice(device),
        fingerprint: benchmarkFingerprint({ model, backend: runCfg.active_backend, build: runCfg.active_build, ctx: runCfg.ctx_size, ngl: runCfg.ngl, threads: runCfg.threads, parallel: runCfg.parallel, iters }),
        createdAt: Date.now(), model, backend: runCfg.active_backend, build: runCfg.active_build, ctx: runCfg.ctx_size, ngl: runCfg.ngl, threads: runCfg.threads, parallel: runCfg.parallel, iters,
        rows: benchmarkMetrics(result.rows),
      };
      const nextHistory = [record, ...history].slice(0, 20);
      setHistory(nextHistory);
      try { localStorage.setItem(BENCH_HISTORY_KEY, JSON.stringify(nextHistory)); } catch { /* optional */ }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (message.toLowerCase().includes("cancel")) setInfo(t("ui.benchCancelled"));
      else setError(message);
    } finally {
      setPhase("idle");
      void store.refreshStatus();
    }
  };

  const cancel = async () => {
    if (phase !== "running") return;
    setPhase("canceling");
    setInfo(t("ui.benchCancelRequested"));
    try {
      await api.benchCancel();
    } catch (caught) {
      setInfo(`${t("ui.benchCancelFailed")}: ${caught instanceof Error ? caught.message : String(caught)}`);
      setPhase("running");
    }
  };

  return (
    <div className="app-page-scroll relative flex h-full min-h-0 flex-col p-4">
      <div className="rounded-xl border p-4" style={{ borderColor: "var(--board-border)", background: "var(--board-panel)" }}>
        <div className="flex min-w-0 flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="bench-iters" className="text-xs" style={{ color: "var(--board-muted)" }}>{t("panel.iterations")}</label>
            <input
              id="bench-iters"
              type="text"
              inputMode="numeric"
              value={itersDraft}
              disabled={phase !== "idle"}
              onChange={(event) => {
                setItersDraft(event.target.value);
                setItersDirty(true);
              }}
              onBlur={() => {
                const parsed = parseNumericInput(itersDraft, 1);
                const normalized = Math.min(100, Math.max(1, parsed ?? cfg?.iters ?? 5));
                setItersDraft(String(normalized));
                setItersDirty(false);
              }}
              onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
              className="app-input w-24 text-center"
            />
          </div>
          {phase === "running" || phase === "canceling" ? (
            <button
              type="button"
              onClick={() => void cancel()}
              disabled={phase === "canceling"}
              className="bench-run-button app-button app-button--danger app-button--md"
            >
              {phase === "canceling" ? t("panel.canceling") : t("panel.cancelBenchmark")}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void run()}
              disabled={!canRun}
              title={serverRunning ? t("panel.serverRunningBenchmark") : !model ? t("panel.noModelBenchmark") : undefined}
              className="bench-run-button app-button app-button--primary app-button--md"
            >
              {t("panel.benchmark")}
            </button>
          )}
          <span className="bench-model-label min-w-0 break-words text-xs tabular-nums" style={{ color: "var(--board-faint)" }}>
            {model ? displayModel : t("panel.noModelBenchmark")}
            {serverRunning ? ` · ${t("panel.serverRunningBenchmark")}` : ""}
          </span>
        </div>
        <div className="bench-phase-slot mt-3">
          {phase !== "idle" && (
            <div className="flex items-center gap-2 text-xs font-medium" style={{ color: "var(--board-warning)" }} role="status" aria-live="polite">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: "var(--board-warning)" }} aria-hidden="true" />
              {phase === "canceling" ? t("common.wait") : t("status.working")}
            </div>
          )}
        </div>
      </div>

      <div className="bench-info-slot mt-3">
        {info && <div className="rounded-lg border px-3 py-2 text-xs leading-relaxed" style={{ borderColor: "var(--tone-warning-border)", background: "var(--tone-warning-bg)", color: "var(--tone-warning-ink)" }} role="status">{info}</div>}
      </div>

      <div className="mt-4 min-h-0 flex-1 overflow-auto">
        {error && (
          <div className="rounded-lg border p-3 text-xs leading-relaxed" style={{ borderColor: "var(--tone-error-border)", background: "var(--tone-error-bg)", color: "var(--tone-error-ink)" }} role="alert">
            <div className="mb-1 font-semibold">{t("error.wrong")}</div>
            <pre className="whitespace-pre-wrap break-words">{normalizeDisplayText(error)}</pre>
          </div>
        )}

        {rows.length > 0 && (
          <div className="overflow-x-auto rounded-lg border" style={{ borderColor: "var(--board-border)" }}>
            <table className="w-full min-w-[34rem] table-fixed border-collapse text-sm">
              <caption className="sr-only">{t("panel.benchmarkResults")}</caption>
              <thead>
                <tr className="border-b text-left text-xs" style={{ borderColor: "var(--board-border)", color: "var(--board-faint)" }}>
                  <th scope="col" className="w-[40%] px-4 py-2.5 font-medium">{t("ui.benchColumnTest")}</th>
                  <th scope="col" className="w-[20%] px-4 py-2.5 font-medium">{t("ui.benchColumnSize")}</th>
                  <th scope="col" className="w-[20%] px-4 py-2.5 font-medium">{t("ui.benchColumnBatch")}</th>
                  <th scope="col" className="w-[20%] px-4 py-2.5 text-right font-medium">{t("ui.benchColumnTps")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={`${row.test}-${index}`} className="border-b last:border-0" style={{ borderColor: "var(--board-border)" }}>
                    <td className="px-4 py-2.5 font-mono text-xs" style={{ color: "var(--board-ink)" }}>{row.test}</td>
                    <td className="px-4 py-2.5 text-xs tabular-nums" style={{ color: "var(--board-muted)" }}>{row.size}</td>
                    <td className="px-4 py-2.5 text-xs tabular-nums" style={{ color: "var(--board-muted)" }}>{row.batch}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs font-semibold tabular-nums" style={{ color: "var(--board-success)" }}>{row.tps.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {rows.length === 0 && !error && phase === "idle" && (
          <div className="p-6 text-center text-xs" style={{ color: "var(--board-faint)" }}>{t("panel.benchmarkEmpty")}</div>
        )}

        {effectiveArgs.length > 0 && <details className="mt-4 rounded-xl border p-4" style={{ borderColor: "var(--board-border)", background: "var(--board-panel)" }}>
          <summary className="cursor-pointer text-xs font-medium" style={{ color: "var(--board-ink)" }}>{t("panel.effectiveArgs")}</summary>
          <code className="mt-2.5 block whitespace-pre-wrap break-all rounded p-2.5 font-mono text-xs" style={{ background: "var(--board-mono-bg)", color: "var(--board-mono-ink)" }}>{effectiveArgs.map((arg) => JSON.stringify(normalizeDisplayText(arg))).join(" ")}</code>
        </details>}
        {history.length > 0 && <section className="mt-4 rounded-xl border p-4" style={{ borderColor: "var(--board-border)", background: "var(--board-panel)" }} aria-labelledby="benchmark-history-heading">
          <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="benchmark-history-heading" className="app-section-title">{t("ui.benchHistory", { count: history.length })}</h2><button type="button" onClick={() => downloadText("llama-board-benchmarks.csv", benchmarkCsv(history), "text/csv") } className="app-button app-button--secondary app-button--sm">{t("ui.benchExportCsv")}</button></div>
          <div className="mt-2.5 space-y-1.5">{history.slice(0, 5).map((record) => <div key={record.id} className="flex flex-wrap items-center justify-between gap-2 text-xs tabular-nums" style={{ color: "var(--board-faint)" }}><span>{new Date(record.createdAt).toLocaleString()} · {normalizeDisplayPath(record.model).split(/[\\/]/).pop()}</span><span>{record.rows.map((row) => `${row.test}: ${row.value.toFixed(1)} ${row.unit}`).join(" · ")}</span></div>)}</div>
        </section>}
      </div>
    </div>
  );
}
