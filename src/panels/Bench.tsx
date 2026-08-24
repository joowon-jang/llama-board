import { useState } from "react";
import * as api from "../api";
import type { AppStore } from "../store";

/**
 * §4 Benchmark — states: idle → running → done/error. Run/Cancel with guards:
 * a benchmark is blocked while the server is running (§0.6 concurrency), and
 * v0.1 Cancel is a no-op that just informs the user (runs to completion).
 * tok/s rows come from llama-bench; result table shown on success.
 */
export default function BenchPanel({ store }: { store: AppStore }) {
  const cfg = store.cfg;
  const [phase, setPhase] = useState<"idle" | "running">("idle");
  const [rows, setRows] = useState<api.BenchRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [iters, setIters] = useState(cfg?.iters ?? 5);

  const serverRunning = store.status.state === "running";
  const model = cfg?.active_model ?? "";
  const canRun = !!cfg && !!model && !phase.startsWith("running") && !serverRunning && !store.busy;

  const run = async () => {
    if (!cfg) return;
    setError(null);
    setInfo(null);
    setRows(null);
    setPhase("running");
    try {
      const runCfg = { ...cfg, iters };
      const result = await api.runBench(runCfg);
      setRows(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPhase("idle");
      store.refreshStatus();
    }
  };

  const cancel = () => {
    // v0.1: bench_cancel is a no-op (see §0.6 #4). Inform rather than fake it.
    setInfo("Cancel requested — v0.1 runs benchmarks to completion (real kill lands in v0.2). Waiting…");
  };

  return (
    <div className="flex h-full flex-col p-4">
      {/* controls */}
      <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-400">Iterations</label>
            <input
              type="number"
              min={1}
              max={100}
              value={iters}
              disabled={phase === "running"}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (!Number.isNaN(n)) setIters(Math.min(100, Math.max(1, n)));
              }}
              className="w-24 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none disabled:opacity-50"
            />
          </div>
          {phase === "running" ? (
            <button
              onClick={cancel}
              className="rounded-lg bg-amber-700 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600"
            >
              Cancel (no-op)
            </button>
          ) : (
            <button
              onClick={() => void run()}
              disabled={!canRun}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
            >
              Run benchmark
            </button>
          )}
          <span className="text-xs text-slate-500">
            {model ? `model: ${model}` : "no model selected"}
            {serverRunning ? " · server is running (stop it to benchmark)" : ""}
          </span>
        </div>
        {phase === "running" && (
          <div className="mt-3 flex items-center gap-2 text-sm text-amber-300">
            <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
            Benchmarking… (runs to completion)
          </div>
        )}
      </div>

      {info && (
        <div className="mt-3 rounded-lg border border-amber-800 bg-amber-950/50 px-3 py-2 text-sm text-amber-200">
          {info}
        </div>
      )}

      {/* results / error */}
      <div className="mt-4 min-h-0 flex-1 overflow-auto">
        {error && (
          <div className="rounded-lg border border-red-800 bg-red-950/50 p-4 text-sm text-red-200">
            <div className="mb-1 font-medium text-red-300">Benchmark failed</div>
            <pre className="whitespace-pre-wrap break-words">{error}</pre>
          </div>
        )}

        {rows && (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-left text-xs uppercase tracking-wide text-slate-400">
                <th className="px-3 py-2">Test</th>
                <th className="px-3 py-2">Size</th>
                <th className="px-3 py-2">Batch</th>
                <th className="px-3 py-2 text-right">tok/s</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-slate-800 last:border-0">
                  <td className="px-3 py-2 font-mono text-slate-200">{r.test}</td>
                  <td className="px-3 py-2 text-slate-300">{r.size}</td>
                  <td className="px-3 py-2 text-slate-300">{r.batch}</td>
                  <td className="px-3 py-2 text-right font-mono font-medium text-emerald-300">
                    {r.tps.toFixed(1)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!rows && !error && phase === "idle" && (
          <div className="p-6 text-center text-sm text-slate-500">
            Run a benchmark to see per-test tokens/sec (prompt-processing and token-generation).
          </div>
        )}
      </div>
    </div>
  );
}
