import assert from "node:assert/strict";
import { buildChatRequestBody } from "../src/api.ts";
import { QWEN38_CHAT_OPTIONS, QWEN38_DEFAULTS, QWEN38_SERVER_ARGS } from "../src/panels/qwenDefaults.ts";
import { parseChatOptions, parseServerArgs } from "../src/panels/tuningValidation.ts";

assert.equal(QWEN38_DEFAULTS.ctx_size, 131072);
assert.equal(QWEN38_DEFAULTS.batch_size, 1024);
assert.equal(QWEN38_DEFAULTS.ubatch_size, 512);
assert.equal(QWEN38_DEFAULTS.cache_type_k, "q8_0");
assert.equal(QWEN38_DEFAULTS.cache_type_v, "q8_0");
assert.equal(QWEN38_DEFAULTS.temperature, 1);
assert.equal(QWEN38_DEFAULTS.top_p, 0.95);
assert.equal(QWEN38_DEFAULTS.top_k, 20);
assert.equal(QWEN38_DEFAULTS.spec_type, "draft-mtp");
assert.equal(QWEN38_DEFAULTS.spec_draft_n_max, 5);
assert.equal(QWEN38_DEFAULTS.reasoning_effort, "xhigh");
assert.equal(QWEN38_DEFAULTS.mmproj, "");
assert.deepEqual(QWEN38_SERVER_ARGS.slice(0, 2), ["--cache-ram", "16384"]);
assert.ok(QWEN38_SERVER_ARGS.includes("--jinja"));
assert.ok(QWEN38_SERVER_ARGS.includes("--spec-draft-type-k"));
assert.ok(QWEN38_SERVER_ARGS.includes("--spec-draft-type-v"));
assert.ok(QWEN38_SERVER_ARGS.includes("--spec-draft-backend-sampling"));
assert.deepEqual(QWEN38_CHAT_OPTIONS.chat_template_kwargs, {
  enable_thinking: true,
  preserve_thinking: true,
});

assert.deepEqual(
  parseServerArgs("\n--min-p\n0.05\n--chat-template\nqwen\n"),
  ["--min-p", "0.05", "--chat-template", "qwen"],
);
assert.throws(() => parseServerArgs("--host\n0.0.0.0"), /app-managed/);
assert.throws(() => parseServerArgs("--api-key=secret"), /app-managed/);
assert.throws(() => parseServerArgs("--no-api-key"), /app-managed/);
assert.throws(() => parseServerArgs("--mmproj\nprojector.gguf"), /app-managed/);
assert.throws(() => parseServerArgs("-mm\nprojector.gguf"), /app-managed/);
for (const flag of [
  "--n-gpu-layers",
  "-ngl",
  "--ctx-size",
  "-c",
  "--flash-attn",
  "--n-cpu-moe",
  "--threads",
  "-t",
  "--spec-type",
  "--spec-draft-n-max",
  "--reasoning",
  "--reasoning-format",
  "--reasoning-effort",
  "--reasoning-budget",
  "--reasoning-budget-message",
  "--reasoning-preserve",
  "--no-reasoning-preserve",
]) {
  assert.throws(() => parseServerArgs(`${flag}\nvalue`), /app-managed/);
}

assert.deepEqual(parseChatOptions('{"min_p":0.05,"dry_sequence_breakers":["\\n",":"]}'), {
  min_p: 0.05,
  dry_sequence_breakers: ["\n", ":"],
});
assert.throws(() => parseChatOptions("[]"), /JSON object/);
assert.throws(() => parseChatOptions('{"stream":false}'), /reserved/);

const body = buildChatRequestBody(
  "selected-model",
  [{ role: "user", content: "hello" }],
  {
    temperature: 0.7,
    top_p: 0.9,
    top_k: 40,
    reasoning_effort: "high",
    options: { min_p: 0.05, max_tokens: 128, stream: false, model: "wrong-model" },
  },
);
assert.equal(body.model, "selected-model");
assert.equal(body.stream, true);
assert.equal(body.temperature, 0.7);
assert.equal(body.top_p, 0.9);
assert.equal(body.top_k, 40);
assert.equal(body.min_p, 0.05);
assert.equal(body.max_tokens, 128);
assert.equal(body.reasoning_effort, "high");

const noThinkingBody = buildChatRequestBody(
  "selected-model",
  [{ role: "user", content: "hello" }],
  { temperature: 0.7, top_p: 0.9, top_k: 40, reasoning_effort: "none" },
);
assert.equal(noThinkingBody.reasoning_effort, "none");

const dedicatedOffBody = buildChatRequestBody(
  "selected-model",
  [{ role: "user", content: "hello" }],
  {
    temperature: 0.7,
    top_p: 0.9,
    top_k: 40,
    reasoning: "off",
    reasoning_effort: "xhigh",
    options: { chat_template_kwargs: { enable_thinking: true } },
  },
);
assert.equal(dedicatedOffBody.reasoning_effort, "none");
assert.equal((dedicatedOffBody.chat_template_kwargs as { enable_thinking: boolean }).enable_thinking, false);
assert.deepEqual(
  buildChatRequestBody(
    "selected-model",
    [{ role: "user", content: "hello" }],
    {
      temperature: QWEN38_DEFAULTS.temperature,
      top_p: QWEN38_DEFAULTS.top_p,
      top_k: QWEN38_DEFAULTS.top_k,
      reasoning_effort: "high",
      options: QWEN38_CHAT_OPTIONS,
    },
  ).chat_template_kwargs,
  {
    enable_thinking: true,
    preserve_thinking: true,
    reasoning_effort: "high",
  },
);

console.log("advanced settings tests passed");
