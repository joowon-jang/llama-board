import assert from "node:assert/strict";
import { storageSchema } from "../src/storageAdapter.ts";

assert.deepEqual(storageSchema(), { name: "llama-board-storage", version: 1, store: "values" });
console.log("storage schema validation passed");
