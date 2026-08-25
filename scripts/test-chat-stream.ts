import assert from "node:assert/strict";
import { consumeChatStream, readBoundedResponseText } from "../src/api.ts";
import { buildMultimodalContent, capMaxTokens, estimateChatTokens, trimChatHistory } from "../src/chatUtils.ts";
import { SseParser, type StreamDelta } from "../src/sse.ts";

const encoder = new TextEncoder();

function stream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function frame(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

const complete = await consumeChatStream(
  stream([encoder.encode(frame("ok") + "data: [DONE]\n\n")]),
  () => undefined,
);
assert.equal(complete, "ok");

let cancelled = false;
const openStream = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(encoder.encode(frame("done") + "data: [DONE]\n\n"));
  },
  cancel() {
    cancelled = true;
  },
});
assert.equal(await consumeChatStream(openStream, () => undefined), "done");
assert.equal(cancelled, true);

const oversizedFrame = `data: ${"x".repeat(5 * 1024 * 1024)}`;
assert.throws(() => new SseParser(() => undefined).push(oversizedFrame), /SSE frame exceeds/);

const oversizedErrorBody = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(encoder.encode("x".repeat(2 * 1024 * 1024)));
    controller.close();
  },
});
await assert.rejects(
  () => readBoundedResponseText(new Response(oversizedErrorBody), 1024),
  /response body exceeds/,
);

await assert.rejects(
  () => consumeChatStream(stream([encoder.encode(frame("partial"))]), () => undefined),
  /ended the response before completing the stream/,
);

const unicode = "안녕";
const bytes = encoder.encode(frame(unicode) + "data: [DONE]\n\n");
const split = Math.max(1, bytes.findIndex((value) => value >= 0x80));
const decoded = await consumeChatStream(
  stream([bytes.slice(0, split), bytes.slice(split)]),
  () => undefined,
);
assert.equal(decoded, unicode);

const multimodal = buildMultimodalContent("describe this", [{ name: "image.png", dataUrl: "data:image/png;base64,AA==" }]);
assert.equal(multimodal[0].type, "text");
assert.equal(multimodal[1].type, "image_url");
const trimmed = trimChatHistory([
  { role: "system", content: "system" },
  { role: "user", content: "old message".repeat(200) },
  { role: "assistant", content: "old answer".repeat(200) },
  { role: "user", content: "latest" },
], 100);
assert.equal(trimmed.trimmed, true);
assert.equal(trimmed.messages[0].role, "system");
assert.equal(trimmed.messages.at(-1)?.content, "latest");

const orphanSafe = trimChatHistory([
  { role: "system", content: "system" },
  { role: "user", content: "long user turn ".repeat(100) },
  { role: "assistant", content: "answer" },
], 50);
assert.equal(orphanSafe.messages.at(-1)?.role, "user");

const oversizedLatest = trimChatHistory([
  { role: "system", content: "system" },
  { role: "user", content: "latest user content ".repeat(10_000) },
  { role: "assistant", content: "latest answer" },
], 256);
assert.ok(estimateChatTokens(oversizedLatest.messages) <= 256);

const promptTokens = estimateChatTokens([{ role: "user", content: "x".repeat(16384) }]);
const capped = capMaxTokens({ max_tokens: 4096, keep: true }, promptTokens, 4096);
assert.equal(capped.max_tokens, 1);
assert.equal(capped.keep, true);

const toolChunks: StreamDelta[] = [];
const toolParser = new SseParser((delta) => toolChunks.push(delta));
toolParser.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "plan" } }] })}\n\n`);
toolParser.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "search", arguments: JSON.stringify({ q: "llama" }) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 4, completion_tokens: 2 } })}\n\n`);
assert.equal(toolChunks[0]?.reasoning, "plan");
assert.equal(toolChunks[1]?.tool_calls?.[0]?.name, "search");
assert.equal(toolChunks[1]?.finish_reason, "tool_calls");
assert.equal(toolChunks[1]?.usage?.prompt_tokens, 4);

console.log("Chat stream tests passed");
