import assert from "node:assert/strict";
import { capabilityLabel, extractFlagNames, parseDeviceLines, readLoadingProfiles, type LoadingProfile } from "../src/runtimeUtils.ts";

const flags = extractFlagNames("  -c, --ctx-size N\n      --flash-attn [on|off]\n      --unknown-future-flag");
assert.deepEqual(flags, ["--ctx-size", "--flash-attn", "--unknown-future-flag"]);
assert.deepEqual(parseDeviceLines("Vulkan0: Radeon\n\nCPU: host"), ["Vulkan0: Radeon", "CPU: host"]);
assert.equal(capabilityLabel("available"), "Available");
assert.equal(capabilityLabel("failed preflight"), "Preflight failed");
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
