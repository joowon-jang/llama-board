export function normalizeDisplayPath(value: string): string {
  const path = value.trim();
  const lower = path.toLowerCase();
  if (lower.startsWith("\\\\?\\unc\\")) return `\\\\${path.slice(8)}`;
  if (lower.startsWith("\\\\?\\")) return path.slice(4);
  return path;
}

/** Removes Windows verbatim path prefixes from arbitrary displayed text. */
export function normalizeDisplayText(value: string): string {
  return value.replace(/\\\\\?\\UNC\\/gi, "\\\\").replace(/\\\\\?\\/g, "");
}

/** Keeps multiline argument/path editors readable without changing their stored values. */
export function normalizeDisplayPathLines(value: string): string {
  return value.split(/\r?\n/).map(normalizeDisplayText).join("\n");
}

export type LifecycleErrorKind = "timeout" | "port" | "executable" | "model" | "memory" | "unknown";

export function classifyLifecycleError(error: unknown): LifecycleErrorKind {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (text.includes("timeout") || text.includes("timed out")) return "timeout";
  if (text.includes("address already in use") || text.includes("port") && (text.includes("use") || text.includes("bind"))) return "port";
  if (text.includes("not found") || text.includes("no such file") || text.includes("executable")) return "executable";
  if (text.includes("model") && (text.includes("load") || text.includes("file") || text.includes("invalid"))) return "model";
  if (text.includes("out of memory") || text.includes("oom") || text.includes("vram") || text.includes("memory")) return "memory";
  return "unknown";
}

export function lifecycleErrorMessage(action: "start" | "stop", error: unknown): string {
  const kind = classifyLifecycleError(error);
  const detail = error instanceof Error ? error.message : String(error);
  const prefix = action === "start" ? "Server start failed" : "Server stop failed";
  const hint = {
    timeout: "The operation timed out. Check runtime diagnostics and try again.",
    port: "The configured port is already in use. Choose another port or stop the conflicting process.",
    executable: "The runtime executable could not be found. Check the selected runtime installation.",
    model: "The selected model could not be loaded. Check the model path and file integrity.",
    memory: "There is not enough available memory or VRAM for this configuration.",
    unknown: "Open diagnostics for the runtime log and retry after correcting the issue.",
  }[kind];
  return `${prefix}: ${hint}${detail ? ` (${detail})` : ""}`;
}

export function nextPollDelay(baseMs: number, failures: number): number {
  const safeBase = Math.max(250, baseMs);
  return Math.min(10_000, safeBase * 2 ** Math.min(4, Math.max(0, failures)));
}

export function shouldPoll(visibility: DocumentVisibilityState | "unknown"): boolean {
  return visibility !== "hidden";
}

export function shouldAutoStart(enabled: boolean, state: string, busy: boolean, consumed: boolean, configRevision: number): boolean {
  return enabled && !consumed && !busy && state === "stopped" && configRevision === 1;
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

export function createErrorId(now = Date.now()): string {
  return `LB-${now.toString(36).toUpperCase()}`;
}

export function benchmarkFingerprint(value: { model: string; backend: string; build: string; ctx: number; ngl: number; threads: number; parallel: number; iters: number }): string {
  return [value.model, value.backend, value.build, value.ctx, value.ngl, value.threads, value.parallel, value.iters].join("|");
}

export interface PerformanceMetrics {
  promptTokens?: number;
  completionTokens?: number;
  firstTokenMs?: number;
  totalMs?: number;
  tokensPerSecond?: number;
}

export function deriveTokensPerSecond(completionTokens?: number, totalMs?: number): number | null {
  if (!completionTokens || !totalMs || totalMs <= 0) return null;
  return completionTokens / (totalMs / 1000);
}

export type AttachmentStatus = "queued" | "reading" | "indexing" | "ready" | "failed" | "removed";

export interface AttachmentProgress {
  name: string;
  kind: "document" | "image";
  status: AttachmentStatus;
  error?: string;
}

export function normalizeAttachmentProgress(value: Partial<AttachmentProgress>): AttachmentProgress {
  return {
    name: value.name?.trim() || "attachment",
    kind: value.kind === "image" ? "image" : "document",
    status: value.status ?? "queued",
    error: value.error,
  };
}

export type McpApprovalPolicy = "always-ask" | "once" | "session" | "server-tool" | "deny";

const MCP_POLICY_KEY = "llama-board.mcp-approval-policy.v1";

export function loadMcpApprovalPolicy(): McpApprovalPolicy {
  try {
    const value = window.localStorage.getItem(MCP_POLICY_KEY);
    return value === "once" || value === "session" || value === "server-tool" || value === "deny" ? value : "always-ask";
  } catch {
    return "always-ask";
  }
}

export function saveMcpApprovalPolicy(policy: McpApprovalPolicy): void {
  try { window.localStorage.setItem(MCP_POLICY_KEY, policy); } catch { /* optional */ }
}

export function approvalKey(serverId: string, toolName: string): string {
  return `${serverId}:${toolName}`;
}

export function canAutoApprove(policy: McpApprovalPolicy | undefined, approved: Set<string>, key: string): boolean {
  return policy === "deny" ? false : policy === "session" || policy === "server-tool" ? approved.has(key) : false;
}

export function validateTuningRelations(values: { ctxSize: number; parallel: number; ngl: number; temperature: number; dynatempRange: number; topP: number; minP: number }): string[] {
  const warnings: string[] = [];
  if (values.parallel > 1) warnings.push("Multiple server slots can increase memory usage.");
  if (values.ctxSize > 32_768) warnings.push("Large context sizes can consume substantial KV memory.");
  if (values.ngl === 0) warnings.push("GPU layers are disabled; inference will run on CPU unless the runtime chooses otherwise.");
  if (values.dynatempRange > 0 && values.temperature === 0) warnings.push("Dynamic temperature is enabled while temperature is zero.");
  if (values.topP < 1 && values.minP > 0.1) warnings.push("Top-p and Min-p are both restrictive; generation may become repetitive.");
  return warnings;
}

/** Bump when a stored record's shape changes; readers drop older envelopes. */
export const BENCHMARK_RECORD_SCHEMA = 1;

/**
 * The device a run happened on, denormalized into the record so an exported or
 * uploaded result stands on its own. `fingerprint` is the device-class key a
 * benchmark service groups by; it carries nothing that identifies the owner.
 */
export interface BenchmarkDevice {
  fingerprint: string;
  os: string;
  arch: string;
  cpu: string;
  cpuThreads: number;
  gpu?: string;
  gpuVendor?: string;
  gpuVramMb?: number;
}

/**
 * One measurement from a run. llama-bench already emits several per run
 * (`pp512`, `tg128`, …); `test` names the workload and `unit` keeps the record
 * readable when metrics beyond tokens/s are added.
 */
export interface BenchmarkMetric {
  test: string;
  size: string;
  batch: string;
  value: number;
  unit: string;
}

export interface BenchmarkRecord {
  schemaVersion: number;
  id: string;
  /** Configuration key used to spot reruns of the same setup. */
  fingerprint: string;
  createdAt: number;
  model: string;
  backend: string;
  build: string;
  runtimeVersion?: string;
  ctx: number;
  ngl: number;
  threads: number;
  parallel: number;
  iters: number;
  device?: BenchmarkDevice;
  rows: BenchmarkMetric[];
}

/** Normalizes llama-bench output into the stored metric shape. */
export function benchmarkMetrics(rows: Array<{ test: string; size: string; batch: string; tps: number }>): BenchmarkMetric[] {
  return rows.map((row) => ({ test: row.test, size: row.size, batch: row.batch, value: row.tps, unit: "tok/s" }));
}

const CSV_COLUMNS = [
  "createdAt", "fingerprint", "deviceFingerprint", "os", "arch", "cpu", "cpuThreads", "gpu", "gpuVendor", "gpuVramMb",
  "model", "backend", "build", "runtimeVersion", "ctx", "ngl", "threads", "parallel", "iters",
  "test", "size", "batch", "value", "unit",
] as const;

export function benchmarkCsv(records: BenchmarkRecord[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const record of records) {
    for (const row of record.rows) {
      lines.push([
        new Date(record.createdAt).toISOString(), record.fingerprint,
        record.device?.fingerprint ?? "", record.device?.os ?? "", record.device?.arch ?? "",
        record.device?.cpu ?? "", record.device?.cpuThreads ?? "", record.device?.gpu ?? "",
        record.device?.gpuVendor ?? "", record.device?.gpuVramMb ?? "",
        record.model, record.backend, record.build, record.runtimeVersion ?? "",
        record.ctx, record.ngl, record.threads, record.parallel, record.iters,
        row.test, row.size, row.batch, row.value, row.unit,
      ].map((value) => `"${String(value).replace(/"/g, '""')}"`).join(","));
    }
  }
  return `${lines.join("\n")}\n`;
}

export function configExport<T>(preferences: T): { schemaVersion: 1; exportedAt: string; preferences: T } {
  return { schemaVersion: 1, exportedAt: new Date().toISOString(), preferences };
}

export function parseConfigExport<T>(raw: string): T {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || (parsed as { schemaVersion?: unknown }).schemaVersion !== 1) throw new Error("Unsupported settings export format.");
  return (parsed as { preferences?: T }).preferences as T;
}

export function safeTextExport(value: string): string {
  return value.replace(/(api[_-]?key|token|password|secret|credential|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}
