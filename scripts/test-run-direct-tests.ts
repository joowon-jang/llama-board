import assert from "node:assert/strict";
import { runDirectTests, DIRECT_TEST_SCRIPTS, type DirectTestResult } from "./run-direct-tests.ts";

assert.equal(DIRECT_TEST_SCRIPTS.length, 24, "direct test script list should stay in sync with package.json's historical chain");
assert.equal(new Set(DIRECT_TEST_SCRIPTS).size, DIRECT_TEST_SCRIPTS.length, "direct test script list should have no duplicates");

// All scripts succeed: every script runs, in order, exit code 0.
{
  const invoked: string[] = [];
  const summary = runDirectTests(["a.ts", "b.ts", "c.ts"], (script) => {
    invoked.push(script);
    return { status: 0 };
  });
  assert.deepEqual(invoked, ["a.ts", "b.ts", "c.ts"]);
  assert.equal(summary.exitCode, 0);
  assert.equal(summary.stoppedAt, null);
  const codes: DirectTestResult[] = summary.results;
  assert.deepEqual(codes, [
    { script: "a.ts", code: 0 },
    { script: "b.ts", code: 0 },
    { script: "c.ts", code: 0 },
  ]);
}

// A middle script fails: propagate its exit code and stop before later
// scripts run (fail-fast, matching the historical `&&` chain).
{
  const invoked: string[] = [];
  const summary = runDirectTests(["a.ts", "b.ts", "c.ts"], (script) => {
    invoked.push(script);
    return { status: script === "b.ts" ? 1 : 0 };
  });
  assert.deepEqual(invoked, ["a.ts", "b.ts"], "c.ts must not run after b.ts fails");
  assert.equal(summary.exitCode, 1);
  assert.equal(summary.stoppedAt, "b.ts");
}

// A null status (killed by signal) still counts as a failure.
{
  const summary = runDirectTests(["a.ts"], () => ({ status: null }));
  assert.equal(summary.exitCode, 1);
  assert.equal(summary.stoppedAt, "a.ts");
}

console.log("run-direct-tests harness tests passed");
