import assert from "node:assert/strict";
import { buildPhaseLabelKey, capabilityLabel, defaultPrBackendForDevice, extractFlagNames, parseDeviceLines, readLoadingProfiles, type LoadingProfile } from "../src/runtimeUtils.ts";

const flags = extractFlagNames("  -c, --ctx-size N\n      --flash-attn [on|off]\n      --unknown-future-flag");
assert.deepEqual(flags, ["--ctx-size", "--flash-attn", "--unknown-future-flag"]);
assert.deepEqual(parseDeviceLines("Vulkan0: Radeon\n\nCPU: host"), ["Vulkan0: Radeon", "CPU: host"]);
assert.equal(capabilityLabel("available"), "Available");
assert.equal(capabilityLabel("failed preflight"), "Preflight failed");
assert.equal(defaultPrBackendForDevice({ backends: [{ backend: "cuda", fit: "recommended" }] }), "cuda");
assert.equal(defaultPrBackendForDevice({ backends: [{ backend: "rocm", fit: "recommended" }] }), "rocm");
assert.equal(defaultPrBackendForDevice({ backends: [{ backend: "sycl", fit: "recommended" }, { backend: "openvino", fit: "recommended" }, { backend: "vulkan", fit: "recommended" }] }), "vulkan");
assert.equal(defaultPrBackendForDevice({ backends: [{ backend: "unknown", fit: "recommended" }, { backend: "cpu", fit: "recommended" }] }), "cpu");
assert.equal(defaultPrBackendForDevice({ backends: [{ backend: "cuda", fit: "compatible" }] }), "cpu");
assert.equal(defaultPrBackendForDevice(undefined), "cpu");
assert.equal(buildPhaseLabelKey("resolving"), "buildPhaseResolving");
assert.equal(buildPhaseLabelKey("downloading source"), "buildPhaseDownloadingSource");
assert.equal(buildPhaseLabelKey("building"), "buildPhaseBuilding");
assert.equal(buildPhaseLabelKey("some future phase"), "buildPhaseWorking");
const profile: LoadingProfile = { id: "profile-1", name: "AMD chat", backend: "rocm", build: "b123", active_model: "model.gguf", mmproj: "", ctx_size: 8192, ngl: 99, threads: 0, flash_attn: "on" };
assert.equal(profile.backend, "rocm");

const profileValues = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: (key: string) => profileValues.get(key) ?? null },
});
profileValues.set("bad", JSON.stringify([{ id: "bad-only-id" }]));
assert.deepEqual(readLoadingProfiles("bad"), []);
console.log("runtime utility tests passed");
