import assert from "node:assert/strict";
import { formatBytes, isGgufPath, isMmprojPath, quantLabel, validateHfRepoId, validateHfPath } from "../src/discoverUtils.ts";

assert.equal(validateHfRepoId("bartowski/Llama-3.2-3B-Instruct-GGUF"), true);
assert.equal(validateHfRepoId("https://huggingface.co/foo/bar"), false);
assert.equal(validateHfRepoId("foo/../bar"), false);
assert.equal(validateHfPath("Q4_K_M/model.gguf"), true);
assert.equal(validateHfPath("../model.gguf"), false);
assert.equal(validateHfPath("Q4_K_M\\model.gguf"), false);
assert.equal(isGgufPath("Q4_K_M/model.gguf"), true);
assert.equal(isGgufPath("README.md"), false);
assert.equal(isMmprojPath("mmproj-model-f16.gguf"), true);
assert.equal(quantLabel("Llama-3.2-3B-Q4_K_M.gguf"), "Q4_K_M");
assert.equal(formatBytes(1024 * 1024 * 1024), "1.00 GB");
console.log("discover utility tests passed");
