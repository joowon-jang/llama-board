import assert from "node:assert/strict";
import { BENCHMARK_RECORD_SCHEMA, benchmarkCsv, benchmarkMetrics, classifyLifecycleError, configExport, deriveTokensPerSecond, lifecycleErrorMessage, nextPollDelay, parseConfigExport, shouldPoll } from "../src/lifecycleUtils.ts";

assert.equal(classifyLifecycleError(new Error("address already in use")), "port");
assert.equal(classifyLifecycleError(new Error("out of memory")), "memory");
assert.equal(classifyLifecycleError(new Error("startup timeout")), "timeout");
assert.match(lifecycleErrorMessage("start", new Error("port bind failed")), /port/i);
assert.equal(nextPollDelay(1000, 0), 1000);
assert.equal(nextPollDelay(1000, 5), 10000);
assert.equal(shouldPoll("hidden"), false);
assert.equal(shouldPoll("visible"), true);
assert.equal(deriveTokensPerSecond(100, 2000), 50);
const exported = configExport({ theme: "dark" });
assert.deepEqual(parseConfigExport<typeof exported.preferences>(JSON.stringify(exported)), { theme: "dark" });
const csv = benchmarkCsv([{
  schemaVersion: BENCHMARK_RECORD_SCHEMA, id: "x", fingerprint: "f", createdAt: 0,
  model: "m", backend: "b", build: "v", ctx: 1, ngl: 2, threads: 3, parallel: 1, iters: 2,
  device: { fingerprint: "dev", os: "windows", arch: "x86_64", cpu: "CPU", cpuThreads: 8, gpu: "GPU", gpuVendor: "amd", gpuVramMb: 16384 },
  rows: benchmarkMetrics([{ test: "tg", size: "1", batch: "2", tps: 3 }]),
}]);
assert.match(csv, /^createdAt,fingerprint,deviceFingerprint/);
assert.match(csv, /"dev".*"GPU".*"tg".*"3","tok\/s"/);
assert.doesNotMatch(csv, /undefined/);
console.log("lifecycle utility tests passed");
