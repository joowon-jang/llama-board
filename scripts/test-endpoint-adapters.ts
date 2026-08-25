import assert from "node:assert/strict";
import {
  AnthropicSseParser,
  NativeChatSseParser,
  anthropicMessagesUrl,
  buildAnthropicMessagesRequestBody,
  buildNativeChatRequestBody,
  nativeChatUrl,
  translateOpenAiResponseToAnthropic,
} from "../src/endpointAdapters.ts";

const sampling = { temperature: 0.7, top_p: 0.9, top_k: 40, options: { max_tokens: 128 } };
const messages = [
  { role: "system" as const, content: "Be concise." },
  { role: "user" as const, content: [{ type: "text" as const, text: "Describe this." }, { type: "image_url" as const, image_url: { url: "data:image/png;base64,AA==" } }] },
];

const native = buildNativeChatRequestBody("local-model", messages, sampling, "resp_previous");
assert.equal(native.model, "local-model");
assert.equal(native.system_prompt, "Be concise.");
assert.equal(native.previous_response_id, "resp_previous");
assert.equal(Array.isArray(native.input), true);
assert.equal(native.stream, true);
assert.equal(nativeChatUrl("http://127.0.0.1:1234/v1"), "http://127.0.0.1:1234/api/v1/chat");

const anthropic = buildAnthropicMessagesRequestBody("local-model", messages, sampling);
assert.equal(anthropic.system, "Be concise.");
assert.equal(anthropic.max_tokens, 128);
assert.equal((anthropic.messages[0].content as Array<{ type: string }>)[1].type, "image");
assert.equal(anthropicMessagesUrl("http://127.0.0.1:1234/v1"), "http://127.0.0.1:1234/v1/messages");

const toolMessages = [
  { role: "assistant" as const, content: "", tool_calls: [{ id: "call-1", type: "function" as const, function: { name: "lookup", arguments: '{"q":"llama"}' } }] },
  { role: "tool" as const, tool_call_id: "call-1", name: "lookup", content: '{"ok":true}' },
];
const toolAnthropic = buildAnthropicMessagesRequestBody("local-model", toolMessages, sampling, [{ name: "lookup", input_schema: { type: "object" } }]);
assert.equal((toolAnthropic.messages[0].content as Array<{ type: string }>)[0].type, "tool_use");
assert.equal((toolAnthropic.messages[1].content as Array<{ type: string }>)[0].type, "tool_result");

const translated = translateOpenAiResponseToAnthropic({
  id: "chat-1",
  model: "local-model",
  choices: [{ finish_reason: "stop", message: { content: "answer", reasoning_content: "thought" } }],
  usage: { prompt_tokens: 3, completion_tokens: 2 },
});
assert.equal(translated.stop_reason, "end_turn");
assert.deepEqual(translated.content, [
  { type: "thinking", thinking: "thought" },
  { type: "text", text: "answer" },
]);
assert.deepEqual(translated.usage, { input_tokens: 3, output_tokens: 2 });

const translatedTool = translateOpenAiResponseToAnthropic({
  id: "chat-tool",
  choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: '{"q":"llama"}' } }] } }],
});
assert.equal(translatedTool.stop_reason, "tool_use");
assert.deepEqual(translatedTool.content[0], { type: "tool_use", id: "call-1", name: "lookup", input: { q: "llama" } });

const nativeEvents: string[] = [];
const nativeParser = new NativeChatSseParser((delta) => {
  if (delta.reasoning) nativeEvents.push(`r:${delta.reasoning}`);
  if (delta.text) nativeEvents.push(`t:${delta.text}`);
  if (delta.lifecycle) nativeEvents.push(`l:${delta.lifecycle}`);
});
const nativePayload = [
  `data: ${JSON.stringify({ type: "chat.start", response_id: "resp_1" })}\n\n`,
  `data: ${JSON.stringify({ type: "reasoning.delta", content: "think" })}\n\n`,
  `data: ${JSON.stringify({ type: "message.delta", content: "answer" })}\n\n`,
  `data: ${JSON.stringify({ type: "chat.end", result: { response_id: "resp_1", stats: { input_tokens: 1, total_output_tokens: 2 } } })}\n\n`,
].join("");
for (const chunk of [nativePayload.slice(0, 19), nativePayload.slice(19)]) nativeParser.push(chunk);
assert.deepEqual(nativeEvents, ["r:think", "t:answer", "l:completed"]);
assert.equal(nativeParser.value(), "answer");
assert.equal(nativeParser.isFinished(), true);

const anthropicEvents: string[] = [];
const anthropicParser = new AnthropicSseParser((delta) => {
  if (delta.thinking) anthropicEvents.push(`r:${delta.thinking}`);
  if (delta.text) anthropicEvents.push(`t:${delta.text}`);
  if (delta.finishReason) anthropicEvents.push(`f:${delta.finishReason}`);
});
const anthropicPayload = [
  `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 4 } } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "reason" } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "done" } })}\n\n`,
  `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })}\n\n`,
  `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
].join("");
anthropicParser.push(anthropicPayload);
assert.deepEqual(anthropicEvents, ["r:reason", "t:done", "f:end_turn"]);
assert.equal(anthropicParser.value(), "done");
assert.equal(anthropicParser.isFinished(), true);

console.log("endpoint adapter tests passed");
