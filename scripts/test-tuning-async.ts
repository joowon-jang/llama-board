import assert from "node:assert/strict";
import { draftStillCurrent, canRollbackAtRevision } from "../src/panels/tuningAsync.ts";

assert.equal(draftStillCurrent("new", "old"), false);
assert.equal(draftStillCurrent("new", "new"), true);
assert.equal(canRollbackAtRevision(4, 5), false);
assert.equal(canRollbackAtRevision(4, 4), true);
console.log("tuning async tests passed");
