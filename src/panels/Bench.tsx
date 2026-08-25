import { useEffect, useState } from "react";
import * as api from "../api";
import type { AppStore } from "../store";
import { parseNumericInput } from "./tuningValidation";

export default function BenchPanel({ store }: { store: AppStore }) {
  const cfg = store.cfg;
  const [phase, setPhase] = useState<"idle" | "running" | "canceling">("idle");
  const [rows, setRows] = useState<api.BenchRow[]>([]);
  const [effectiveArgs, setEffectiveArgs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [itersDraft, setItersDraft] = useState(String(cfg?.iters ?? 5));
  const [itersDirty, setItersDirty] = useState(false);

  useEffect(() => {
    if (cfg && !itersDirty) setItersDraft(String(cfg.iters));
  }, [cfg?.iters, itersDirty]);

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
      await store.updateConfig({ iters });
      const result = await api.runBench(runCfg);
      setRows(result.rows);
      setEffectiveArgs(result.args);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (message.toLowerCase().includes("cancel")) setInfo("Benchmark cancelled.");
      else setError(message);
    } finally {
      setPhase("idle");
      void store.refreshStatus();
    }
  };

  const cancel = async () => {
    if (phase !== "running") return;
    setPhase("canceling");
    setInfo("Cancellation requested…");
    try {
      await api.benchCancel();
    } catch (caught) {
      setInfo(`Cancellation request failed: ${caught instanceof Error ? caught.message : String(caught)}`);
      setPhase("running");
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4">
        <div className="flex min-w-0 flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="bench-iters" className="text-xs text-slate-400">Iterations</label>
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
              {phase === "canceling" ? "Canceling…" : "Cancel benchmark"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void run()}
              disabled={!canRun}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
            >
              Run benchmark
            </button>
          )}
          <span className="min-w-0 break-words text-xs text-slate-500">
            {model ? `model: ${model}` : "no model selected"}
            {serverRunning ? " · server is running (stop it to benchmark)" : ""}
          </span>
        </div>
        {phase !== "idle" && (
          <div className="mt-3 flex items-center gap-2 text-sm text-amber-300" role="status" aria-live="polite">
            <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" aria-hidden="true" />
            {phase === "canceling" ? "Stopping benchmark process…" : "Benchmarking…"}
          </div>
        )}
      </div>

      {info && <div className="mt-3 rounded-lg border border-amber-800 bg-amber-950/50 px-3 py-2 text-sm text-amber-200" role="status">{info}</div>}

      <div className="mt-4 min-h-0 flex-1 overflow-auto">
        {error && (
          <div className="rounded-lg border border-red-800 bg-red-950/50 p-4 text-sm text-red-200" role="alert">
            <div className="mb-1 font-medium text-red-300">Benchmark failed</div>
            <pre className="whitespace-pre-wrap break-words">{error}</pre>
          </div>
        )}

        {rows.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-slate-800">
            <table className="w-full min-w-[34rem] border-collapse text-sm">
              <caption className="sr-only">Benchmark tokens per second results</caption>
              <thead>
                <tr className="border-b border-slate-700 text-left text-xs uppercase tracking-wide text-slate-400">
                  <th scope="col" className="px-3 py-2">Test</th>
                  <th scope="col" className="px-3 py-2">Size</th>
                  <th scope="col" className="px-3 py-2">Batch</th>
                  <th scope="col" className="px-3 py-2 text-right">tok/s</th>
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
          <div className="p-6 text-center text-sm text-slate-500">Run a benchmark to see prompt-processing and token-generation speed.</div>
        )}

        {effectiveArgs.length > 0 && <details className="mt-4 rounded-xl border border-slate-700 bg-slate-900/30 p-3">
          <summary className="cursor-pointer text-xs font-medium text-slate-300">Effective llama-bench arguments</summary>
          <code className="mt-2 block whitespace-pre-wrap break-all text-xs text-slate-400">{effectiveArgs.map((arg) => JSON.stringify(arg)).join(" ")}</code>
        </details>}
      </div>
    </div>
  );
}
