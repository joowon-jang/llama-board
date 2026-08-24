import assert from "node:assert/strict";
import { SseParser } from "../src/sse.ts";

const deltas = [];
const parser = new SseParser((delta) => deltas.push(delta));
const reasoningFrame = `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "think" } }] })}\n\n`;
const contentFrame = `data: ${JSON.stringify({ choices: [{ delta: { content: "hel" } }] })}\n\n`;
const finalFrame = `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n`;
assert.equal(parser.push(reasoningFrame.slice(0, 12)), false);
assert.equal(parser.push(reasoningFrame.slice(12) + contentFrame), false);
assert.equal(parser.push(finalFrame + "data: [DONE]\n\n"), true);
assert.equal(parser.value(), "hello");
assert.deepEqual(deltas, [{ reasoning: "think", content: undefined }, { reasoning: undefined, content: "hel" }, { reasoning: undefined, content: "lo" }]);

const partial = new SseParser(() => undefined);
partial.push(`data: ${JSON.stringify({ choices: [{ delta: { content: "tail" } }] })}`);
assert.equal(partial.finish(), "tail");
assert.equal(partial.isFinished(), false);

const complete = new SseParser(() => undefined);
complete.push("data: [DONE]\n\n");
assert.equal(complete.isFinished(), true);

const malformed = new SseParser(() => undefined);
assert.throws(() => malformed.push("data: {not-json}\n"), /invalid SSE frame/);

console.log("SSE parser tests passed");
