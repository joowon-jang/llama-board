import assert from "node:assert/strict";
import { suppressModelRowSelection } from "../src/panels/modelRowEvents.ts";

let stopped = 0;
suppressModelRowSelection({ key: "Enter", stopPropagation: () => { stopped += 1; } });
suppressModelRowSelection({ key: " ", stopPropagation: () => { stopped += 1; } });
suppressModelRowSelection({ key: "Tab", stopPropagation: () => { stopped += 1; } });
assert.equal(stopped, 2);
console.log("model row event tests passed");
