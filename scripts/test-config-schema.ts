import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const rust = readFileSync(new URL("../src-tauri/src/config.rs", import.meta.url), "utf8");
const ts = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
const rustBlock = rust.match(/pub struct AppConfig \{([\s\S]*?)\n\}/)?.[1] ?? "";
const tsBlock = ts.match(/export interface AppConfig \{([\s\S]*?)\n\}/)?.[1] ?? "";
const rustFields = [...rustBlock.matchAll(/^\s*pub ([a-z_][a-z0-9_]*):/gm)].map((match) => match[1]).sort();
const tsFields = [...tsBlock.matchAll(/^\s*([a-z_][a-z0-9_]*)(?:\?)?:/gm)].map((match) => match[1]).sort();

assert.ok(rustFields.length > 0, "Rust AppConfig schema was not found");
assert.ok(tsFields.length > 0, "TypeScript AppConfig schema was not found");
assert.deepEqual(tsFields, rustFields, "Rust and TypeScript AppConfig fields drifted");
console.log(`config schema parity passed (${rustFields.length} fields)`);
