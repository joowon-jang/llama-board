import { useState } from "react";
import type { AppConfig } from "../api";
import type { AppStore } from "../store";
import { clampNumber } from "./tuningValidation";

type NumericKey = "ngl" | "ctx_size" | "n_cpu_moe" | "threads" | "temperature" | "top_p" | "top_k";
type Phase = "idle" | "dirty" | "applying" | "failed";

interface NumericField {
  key: NumericKey;
  label: string;
  step: number;
  min: number;
  max: number;
  server: boolean;
  hint: string;
}

const SERVER_FIELDS: NumericField[] = [
  { key: "ngl", label: "GPU layers (ngl)", step: 1, min: 0, max: 128, server: true, hint: "0–128. 0 keeps inference on CPU." },
  { key: "ctx_size", label: "Context size", step: 256, min: 512, max: 131072, server: true, hint: "512–131072 tokens. Restart required." },
  { key: "n_cpu_moe", label: "CPU MoE (n-cpu-moe)", step: 1, min: 0, max: 64, server: true, hint: "0–64 experts kept on CPU." },
  { key: "threads", label: "Threads", step: 1, min: 0, max: 64, server: true, hint: "0 = auto. Restart required." },
];

const SAMPLING_FIELDS: NumericField[] = [
  { key: "temperature", label: "Temperature", step: 0.05, min: 0, max: 2, server: false, hint: "0–2. Higher = more random." },
  { key: "top_p", label: "Top-p", step: 0.01, min: 0.01, max: 1, server: false, hint: "0.01–1. Nucleus sampling." },
  { key: "top_k", label: "Top-k", step: 1, min: 1, max: 200, server: false, hint: "1–200. Candidate pool size." },
];

const DEFAULTS: Pick<
  AppConfig,
  "ngl" | "ctx_size" | "flash_attn" | "n_cpu_moe" | "threads" | "temperature" | "top_p" | "top_k"
> = {
  ngl: 99,
  ctx_size: 4096,
  flash_attn: "auto",
  n_cpu_moe: 0,
  threads: 0,
  temperature: 0.7,
  top_p: 0.9,
  top_k: 40,
};

const valueOf = (cfg: AppConfig, key: NumericKey): number => cfg[key] as number;

/** Tuning panel: server-side values require restart; sampling applies next chat. */
export default function TuningPanel({ store }: { store: AppStore }) {
  const cfg = store.cfg;
  const [phase, setPhase] = useState<Phase>("idle");
  const [flash, setFlash] = useState<string | null>(null);

  if (!cfg) return <div className="p-6 text-sm text-slate-400">Loading…</div>;

  const notify = (message: string | null) => {
    setFlash(message);
    if (message) window.setTimeout(() => setFlash(null), 3500);
  };

  const updateNumeric = (field: NumericField, raw: string) => {
    const parsed = field.step < 1 ? Number.parseFloat(raw) : Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return;
    const previous = valueOf(cfg, field.key);
    const normalized = clampNumber(parsed, field.min, field.max, clampNumber(previous, field.min, field.max, field.min));
    if (normalized !== parsed) {
      notify(`${field.label}: ${field.min}–${field.max} 범위로 조정했습니다.`);
    }
    void store.updateConfig({ [field.key]: normalized } as never);
    if (field.server) setPhase("dirty");
  };

  const updateFlash = (value: string) => {
    const normalized = value === "on" || value === "off" ? value : "auto";
    void store.updateConfig({ flash_attn: normalized });
    setPhase("dirty");
  };

  const applyPreset = (name: "CPU" | "Balanced" | "Max GPU") => {
    const preset =
      name === "CPU"
        ? { ngl: 0, threads: 0, flash_attn: "off" }
        : name === "Balanced"
          ? { ngl: 99, ctx_size: 8192, threads: 0, flash_attn: "auto" }
          : { ngl: 99, ctx_size: 16384, threads: 0, flash_attn: "on" };
    void store.updateConfig(preset as never);
    setPhase("dirty");
    notify(`${name} preset loaded. Apply & restart to use server-side changes.`);
  };

  const resetDefaults = () => {
    void store.updateConfig(DEFAULTS);
    setPhase("dirty");
    notify("Defaults loaded. Apply & restart to use server-side changes.");
  };

  const applyRestart = async () => {
    if (phase === "applying" || store.busy) return;
    if (store.status.state !== "running") {
      setPhase("idle");
      notify("Saved — changes take effect on the next Start.");
      return;
    }

    const before = { ...cfg };
    setPhase("applying");
    try {
      await store.stop();
      await store.start();
      setPhase("idle");
      notify(`Restarted with ngl=${cfg.ngl} · ctx=${cfg.ctx_size}.`);
    } catch (error) {
      await store.updateConfig({
        ngl: before.ngl,
        ctx_size: before.ctx_size,
        flash_attn: before.flash_attn,
        n_cpu_moe: before.n_cpu_moe,
        threads: before.threads,
      });
      setPhase("failed");
      notify(`Apply failed — values restored: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const renderNumeric = (field: NumericField) => {
    const current = clampNumber(valueOf(cfg, field.key), field.min, field.max, field.min);
    return (
      <div key={field.key} className="flex min-w-0 flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <label className="truncate text-sm text-slate-300">{field.label}</label>
          <span className={`shrink-0 text-[10px] ${field.server ? "text-amber-400" : "text-emerald-400"}`}>
            {field.server ? "server-side" : "per-request"}
          </span>
        </div>
        <input
          type="number"
          value={current}
          step={field.step}
          min={field.min}
          max={field.max}
          onChange={(event) => updateNumeric(field, event.target.value)}
          className="w-full min-w-0 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
        />
        <span className="text-xs text-slate-500">{field.hint}</span>
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      {flash && (
        <div className="mb-3 shrink-0 rounded-lg border border-indigo-800 bg-indigo-950/50 px-3 py-2 text-sm text-indigo-200">
          {flash}
        </div>
      )}

      <div className="mb-3 flex shrink-0 flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Presets</span>
        {(["CPU", "Balanced", "Max GPU"] as const).map((name) => (
          <button
            key={name}
            onClick={() => applyPreset(name)}
            disabled={phase === "applying" || store.busy}
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-40"
          >
            {name}
          </button>
        ))}
        <button
          onClick={resetDefaults}
          disabled={phase === "applying" || store.busy}
          className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-400 hover:bg-slate-800 disabled:opacity-40"
        >
          Reset defaults
        </button>
        {phase === "dirty" && <span className="text-xs text-amber-300">● unsaved server changes</span>}
        {phase === "failed" && <span className="text-xs text-red-300">● last apply failed</span>}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-auto lg:grid-cols-2">
        <section className="min-w-0 rounded-xl border border-slate-700 bg-slate-800/40 p-4">
          <h2 className="mb-1 text-sm font-semibold text-slate-200">Server-side parameters</h2>
          <p className="mb-4 text-xs text-slate-500">These are baked in at server start. Change, then restart the server to apply.</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{SERVER_FIELDS.map(renderNumeric)}</div>
          <div className="mt-4 flex min-w-0 flex-col gap-1.5 sm:max-w-[calc(50%-0.5rem)]">
            <div className="flex items-center justify-between gap-2">
              <label className="text-sm text-slate-300">Flash attention</label>
              <span className="shrink-0 text-[10px] text-amber-400">server-side</span>
            </div>
            <select
              value={cfg.flash_attn === "on" || cfg.flash_attn === "off" ? cfg.flash_attn : "auto"}
              onChange={(event) => updateFlash(event.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
            >
              <option value="auto">auto</option>
              <option value="on">on</option>
              <option value="off">off</option>
            </select>
            <span className="text-xs text-slate-500">auto/on/off. Restart required.</span>
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              onClick={() => void applyRestart()}
              disabled={phase === "applying" || store.busy}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {phase === "applying" ? "Restarting…" : "Apply & restart server"}
            </button>
            <span className="text-xs text-slate-500">
              {store.status.state === "running" ? "server is running" : "server is stopped"}
            </span>
          </div>
        </section>

        <section className="min-w-0 rounded-xl border border-slate-700 bg-slate-800/40 p-4">
          <h2 className="mb-1 text-sm font-semibold text-slate-200">Sampling parameters</h2>
          <p className="mb-4 text-xs text-slate-500">Sent with every chat request — take effect immediately, no restart needed.</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{SAMPLING_FIELDS.map(renderNumeric)}</div>
          <div className="mt-5 text-xs text-slate-500">Saved to config and used by the Chat panel on the next message.</div>
        </section>
      </div>
    </div>
  );
}
