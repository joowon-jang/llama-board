import assert from "node:assert/strict";
import {
  clampNumber,
  canonicalServerOptionName,
  isKnownSelectValue,
  mapChatOptionAliases,
  MIROSTAT_OPTIONS,
  APP_MANAGED_SERVER_ARGS,
  APP_MANAGED_SERVER_OPTION_ALIASES,
  SPEC_DRAFT_NGL_OPTIONS,
  SPEC_TYPE_OPTIONS,
  parseChatOptions,
  parseNumericInput,
  parseServerArgs,
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
assert.equal(canonicalServerOptionName("--gpu-layers=24"), "--n-gpu-layers");
assert.equal(canonicalServerOptionName(" -np "), "--parallel");
assert.equal(canonicalServerOptionName("--timeout =120"), "--timeout");
assert.equal(canonicalServerOptionName("--unknown"), null);
for (const alias of Object.values(APP_MANAGED_SERVER_OPTION_ALIASES).flat()) {
  assert.equal(APP_MANAGED_SERVER_ARGS.has(alias), true, `${alias} should be reserved`);
  assert.throws(() => parseServerArgs(`${alias}\nvalue`), /app-managed/);
}
assert.deepEqual(parseServerArgs("--min-p\n0.05"), ["--min-p", "0.05"]);
assert.deepEqual(parseChatOptions('{"mirostat_lr":0.2}'), { mirostat_lr: 0.2 });
assert.deepEqual(
  mapChatOptionAliases({ mirostat_lr: 0.2, mirostat_ent: 4, seed: 7 }),
  { mirostat_eta: 0.2, mirostat_tau: 4, seed: 7 },
);
assert.deepEqual(
  mapChatOptionAliases({ mirostat_lr: 0.2, mirostat_eta: 0.4, mirostat_ent: 4, mirostat_tau: 6 }),
  { mirostat_eta: 0.4, mirostat_tau: 6 },
);
console.log("tuning validation tests passed");
