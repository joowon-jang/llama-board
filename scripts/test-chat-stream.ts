import assert from "node:assert/strict";
import { consumeChatStream } from "../src/api.ts";

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

console.log("Chat stream tests passed");
