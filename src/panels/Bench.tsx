import { useEffect, useState } from "react";
import * as api from "../api";
import type { AppStore } from "../store";
import { parseNumericInput } from "./tuningValidation";
import { useI18n } from "../i18n";
import { pt } from "../panelI18n";
import { ut } from "../uiI18n";
import { benchmarkCsv, benchmarkFingerprint, benchmarkMetrics, BENCHMARK_RECORD_SCHEMA, type BenchmarkDevice, type BenchmarkRecord } from "../lifecycleUtils";

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
  const { t, locale } = useI18n();
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

  const serverRunning = store.status.state === "running";
  const model = cfg?.active_model ?? "";
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
      if (message.toLowerCase().includes("cancel")) setInfo(ut(locale, "benchCancelled"));
      else setError(message);
    } finally {
      setPhase("idle");
      void store.refreshStatus();
    }
  };

  const cancel = async () => {
    if (phase !== "running") return;
    setPhase("canceling");
    setInfo(ut(locale, "benchCancelRequested"));
    try {
      await api.benchCancel();
    } catch (caught) {
      setInfo(`${ut(locale, "benchCancelFailed")}: ${caught instanceof Error ? caught.message : String(caught)}`);
      setPhase("running");
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4">
        <div className="flex min-w-0 flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="bench-iters" className="text-xs text-slate-400">{pt(locale, "iterations")}</label>
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
              className="w-24 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:opacity-50"
            />
          </div>
          {phase === "running" || phase === "canceling" ? (
            <button
              type="button"
              onClick={() => void cancel()}
              disabled={phase === "canceling"}
              className="rounded-lg bg-amber-700 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
            >
              {phase === "canceling" ? pt(locale, "canceling") : pt(locale, "cancelBenchmark")}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void run()}
              disabled={!canRun} title={serverRunning ? pt(locale, "serverRunningBenchmark") : !model ? pt(locale, "noModelBenchmark") : undefined}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
            >
              {pt(locale, "benchmark")}
            </button>
          )}
          <span className="min-w-0 break-words text-xs text-slate-500">
            {model ? model : pt(locale, "noModelBenchmark")}
            {serverRunning ? ` · ${pt(locale, "serverRunningBenchmark")}` : ""}
          </span>
        </div>
        {phase !== "idle" && (
          <div className="mt-3 flex items-center gap-2 text-sm text-amber-300" role="status" aria-live="polite">
            <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" aria-hidden="true" />
            {phase === "canceling" ? t("common.wait") : t("status.working")}
          </div>
        )}
      </div>

      {info && <div className="mt-3 rounded-lg border border-amber-800 bg-amber-950/50 px-3 py-2 text-sm text-amber-200" role="status">{info}</div>}

      <div className="mt-4 min-h-0 flex-1 overflow-auto">
        {error && (
          <div className="rounded-lg border border-red-800 bg-red-950/50 p-4 text-sm text-red-200" role="alert">
            <div className="mb-1 font-medium text-red-300">{t("error.wrong")}</div>
            <pre className="whitespace-pre-wrap break-words">{error}</pre>
          </div>
        )}

        {rows.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-slate-800">
            <table className="w-full min-w-[34rem] border-collapse text-sm">
              <caption className="sr-only">{pt(locale, "benchmarkResults")}</caption>
              <thead>
                <tr className="border-b border-slate-700 text-left text-xs uppercase tracking-wide text-slate-400">
                  <th scope="col" className="px-3 py-2">{ut(locale, "benchColumnTest")}</th>
                  <th scope="col" className="px-3 py-2">{ut(locale, "benchColumnSize")}</th>
                  <th scope="col" className="px-3 py-2">{ut(locale, "benchColumnBatch")}</th>
                  <th scope="col" className="px-3 py-2 text-right">{ut(locale, "benchColumnTps")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={`${row.test}-${index}`} className="border-b border-slate-800 last:border-0">
                    <td className="px-3 py-2 font-mono text-slate-200">{row.test}</td>
                    <td className="px-3 py-2 text-slate-300">{row.size}</td>
                    <td className="px-3 py-2 text-slate-300">{row.batch}</td>
                    <td className="px-3 py-2 text-right font-mono font-medium text-emerald-300">{row.tps.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {rows.length === 0 && !error && phase === "idle" && (
          <div className="p-6 text-center text-sm text-slate-500">{pt(locale, "benchmarkEmpty")}</div>
        )}

        {effectiveArgs.length > 0 && <details className="mt-4 rounded-xl border border-slate-700 bg-slate-900/30 p-3">
          <summary className="cursor-pointer text-xs font-medium text-slate-300">{pt(locale, "effectiveArgs")}</summary>
          <code className="mt-2 block whitespace-pre-wrap break-all text-xs text-slate-400">{effectiveArgs.map((arg) => JSON.stringify(arg)).join(" ")}</code>
        </details>}
        {history.length > 0 && <section className="mt-4 rounded-xl border border-slate-700 bg-slate-900/30 p-3" aria-labelledby="benchmark-history-heading">
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="benchmark-history-heading" className="text-xs font-semibold uppercase tracking-wide text-slate-400">{ut(locale, "benchHistory", { count: history.length })}</h2><button type="button" onClick={() => downloadText("llama-board-benchmarks.csv", benchmarkCsv(history), "text/csv") } className="rounded bg-slate-800 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-700">{ut(locale, "benchExportCsv")}</button></div>
          <div className="mt-2 space-y-1">{history.slice(0, 5).map((record) => <div key={record.id} className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500"><span>{new Date(record.createdAt).toLocaleString()} · {record.model.split(/[\\/]/).pop()}</span><span>{record.rows.map((row) => `${row.test}: ${row.value.toFixed(1)} ${row.unit}`).join(" · ")}</span></div>)}</div>
        </section>}
      </div>
    </div>
  );
}
