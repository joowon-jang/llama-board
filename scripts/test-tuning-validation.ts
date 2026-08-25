import assert from "node:assert/strict";
import {
  clampNumber,
  isKnownSelectValue,
  MIROSTAT_OPTIONS,
  SPEC_DRAFT_NGL_OPTIONS,
  SPEC_TYPE_OPTIONS,
  parseNumericInput,
} from "../src/panels/tuningValidation.ts";

assert.equal(clampNumber(3, 0, 2, 0.7), 2);
assert.equal(clampNumber(-1, 0, 2, 0.7), 0);
assert.equal(clampNumber(Number.NaN, 0, 2, 0.7), 0.7);
assert.equal(clampNumber(0.57, 0, 2, 0.7), 0.57);
assert.equal(parseNumericInput("0.05", 0.01), 0.05);
assert.equal(parseNumericInput("-", 0.01), null);
assert.equal(parseNumericInput("", 1), null);
assert.equal(parseNumericInput("12abc", 1), null);
assert.equal(parseNumericInput("1.2", 1), null);
assert.equal(parseNumericInput("1.", 0.1), 1);
assert.ok(SPEC_TYPE_OPTIONS.includes("draft-mtp"));
assert.ok(SPEC_TYPE_OPTIONS.includes("ngram-mod"));
assert.equal(isKnownSelectValue("draft-mtp", SPEC_TYPE_OPTIONS), true);
assert.equal(isKnownSelectValue("draft-mtp,ngram-mod", SPEC_TYPE_OPTIONS), false);
assert.deepEqual(SPEC_DRAFT_NGL_OPTIONS, ["auto", "all"]);
assert.deepEqual(MIROSTAT_OPTIONS.map((option) => option.value), [0, 1, 2]);
console.log("tuning validation tests passed");
