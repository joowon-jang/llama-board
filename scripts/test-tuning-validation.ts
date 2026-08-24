import assert from "node:assert/strict";
import { clampNumber } from "../src/panels/tuningValidation.ts";

assert.equal(clampNumber(3, 0, 2, 0.7), 2);
assert.equal(clampNumber(-1, 0, 2, 0.7), 0);
assert.equal(clampNumber(Number.NaN, 0, 2, 0.7), 0.7);
assert.equal(clampNumber(0.57, 0, 2, 0.7), 0.57);
console.log("tuning validation tests passed");
