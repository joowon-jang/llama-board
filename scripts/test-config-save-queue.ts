import { createConfigSaveQueue } from "../src/configSaveQueue.ts";

type Config = { value: number; label: string };

let current: Config | null = { value: 0, label: "base" };
const persisted: Config[] = [];
let attempts = 0;

const save = createConfigSaveQueue<Config>(
  () => current,
  (next) => {
    current = next;
  },
  async (next) => {
    attempts += 1;
    await Promise.resolve();
    if (attempts === 1) throw new Error("first save failed");
    persisted.push({ ...next });
    return { ...next };
  },
  () => {},
);

const first = save({ value: 1 });
const second = save({ label: "second" });

await first.then(
  () => { throw new Error("first save should fail"); },
  () => undefined,
);
const result = await second;

if (result.value !== 0 || result.label !== "second") {
  throw new Error(`queued update included failed state: ${JSON.stringify(result)}`);
}
if (persisted.length !== 1 || persisted[0].value !== 0 || persisted[0].label !== "second") {
  throw new Error(`unexpected persisted state: ${JSON.stringify(persisted)}`);
}
if (current?.value !== 0 || current.label !== "second") {
  throw new Error(`unexpected current state: ${JSON.stringify(current)}`);
}

let nested: { options: { a: number; b: number } } | null = { options: { a: 0, b: 0 } };
const nestedSave = createConfigSaveQueue(
  () => nested,
  (next) => { nested = next; },
  async (next) => next,
  () => {},
);
await Promise.all([
  nestedSave((value) => ({ options: { ...value.options, a: 1 } })),
  nestedSave((value) => ({ options: { ...value.options, b: 2 } })),
]);
if (nested?.options.a !== 1 || nested.options.b !== 2) {
  throw new Error(`functional patches lost a nested update: ${JSON.stringify(nested)}`);
}

console.log("config save queue tests passed");
