import { describe, expect, it } from "vitest";
import { BENCHMARK_RECORD_SCHEMA, benchmarkCsv, benchmarkMetrics, type BenchmarkRecord } from "./lifecycleUtils";

const record: BenchmarkRecord = {
  schemaVersion: BENCHMARK_RECORD_SCHEMA,
  id: "bench-1",
  fingerprint: "model|rocm|b10638|4096|999|0|1|5",
  createdAt: Date.UTC(2026, 7, 27),
  model: "C:\\models\\qwen.gguf",
  backend: "rocm",
  build: "b10638",
  runtimeVersion: "0.3.0-dev",
  ctx: 4096,
  ngl: 999,
  threads: 0,
  parallel: 1,
  iters: 5,
  device: {
    fingerprint: "82be538662590e6a",
    os: "windows",
    arch: "x86_64",
    cpu: "AMD EPYC 4585PX 16-Core Processor",
    cpuThreads: 32,
    gpu: "AMD Radeon AI PRO R9700",
    gpuVendor: "amd",
    gpuVramMb: 32624,
  },
  rows: benchmarkMetrics([
    { test: "pp512", size: "512", batch: "512", tps: 1234.5 },
    { test: "tg128", size: "128", batch: "1", tps: 67.8 },
  ]),
};

describe("benchmark records", () => {
  it("normalizes llama-bench rows into unit-tagged metrics", () => {
    expect(record.rows).toEqual([
      { test: "pp512", size: "512", batch: "512", value: 1234.5, unit: "tok/s" },
      { test: "tg128", size: "128", batch: "1", value: 67.8, unit: "tok/s" },
    ]);
  });

  it("emits one CSV row per metric, carrying the device class", () => {
    const csv = benchmarkCsv([record]);
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("deviceFingerprint");
    expect(lines[0]).toContain("unit");
    expect(lines[1]).toContain('"82be538662590e6a"');
    expect(lines[1]).toContain('"AMD Radeon AI PRO R9700"');
    expect(lines[1]).toContain('"pp512"');
    expect(lines[2]).toContain('"tg128"');
  });

  it("keeps every row on the declared column count", () => {
    const lines = benchmarkCsv([record]).trim().split("\n");
    const columns = lines[0].split(",").length;
    for (const line of lines.slice(1)) {
      expect(line.split('","').length).toBe(columns);
    }
  });

  it("renders a record with no device profile without leaking undefined", () => {
    const csv = benchmarkCsv([{ ...record, device: undefined, runtimeVersion: undefined }]);
    expect(csv).not.toContain("undefined");
    expect(csv.trim().split("\n")).toHaveLength(3);
  });
});
