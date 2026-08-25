import assert from "node:assert/strict";
import {
  createChatThread,
  defaultChatWorkspace,
  loadChatWorkspace,
  mergeHydratedWorkspace,
  saveChatWorkspace,
  threadMatchesQuery,
  titleFromMessage,
  type ChatStorage,
} from "../src/chatHistory.ts";

function storage(): ChatStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

const empty = defaultChatWorkspace(1000);
assert.equal(empty.threads.length, 1);
assert.equal(empty.threads[0].id, "thread-1000");
assert.equal(titleFromMessage("  Explain local inference\nwith details "), "Explain local inference with details");
assert.equal(titleFromMessage(""), "New conversation");

const saved = {
  activeThreadId: "thread-2000",
  threads: [{
    ...createChatThread(2000, "thread-2000", "Qwen notes"),
    messages: [{
      role: "assistant" as const,
      content: "answer",
      citations: [{ name: "notes.md", path: "C:/safe/notes.md", offset: 12, score: 0.75 }],
    }],
  }],
};
const store = storage();
saveChatWorkspace(saved, store);
assert.deepEqual(loadChatWorkspace(store), saved);
assert.equal(threadMatchesQuery({ ...saved.threads[0], messages: [{ role: "user", content: "find this phrase" }] }, "phrase"), true);
assert.equal(threadMatchesQuery({ ...saved.threads[0], messages: [{ role: "user", content: "find this phrase" }] }, "missing"), false);

const initialWorkspace = {
  activeThreadId: "thread-local",
  threads: [
    {
      ...createChatThread(3000, "thread-local", "Local"),
      messages: [],
    },
    createChatThread(3001, "thread-deleted", "Deleted locally"),
  ],
};
const persistedWorkspace = {
  activeThreadId: "thread-persisted",
  threads: [
    {
      ...createChatThread(4000, "thread-local", "Persisted title"),
      messages: [{ role: "assistant" as const, content: "persisted answer" }],
    },
    {
      ...createChatThread(4001, "thread-other", "Other"),
      messages: [{ role: "user" as const, content: "other thread" }],
    },
    createChatThread(4002, "thread-deleted", "Persisted deleted copy"),
  ],
};
const editedBeforeHydration = {
  activeThreadId: "thread-local",
  threads: [{
    ...initialWorkspace.threads[0],
    title: "Edited locally",
    messages: [{ role: "user" as const, content: "typed before hydration" }],
  }],
};
const merged = mergeHydratedWorkspace(persistedWorkspace, editedBeforeHydration, initialWorkspace);
assert.equal(merged.threads.find((thread) => thread.id === "thread-local")?.title, "Edited locally");
assert.equal(merged.threads.find((thread) => thread.id === "thread-local")?.messages[0]?.content, "typed before hydration");
assert.equal(merged.threads.some((thread) => thread.id === "thread-other"), true);
assert.equal(merged.threads.some((thread) => thread.id === "thread-deleted"), false);
assert.equal(mergeHydratedWorkspace(persistedWorkspace, initialWorkspace, initialWorkspace).activeThreadId, "thread-persisted");

store.setItem("llama-board.chat-workspace.v1", "not-json");
assert.equal(loadChatWorkspace(store).threads.length, 1);

const originalWindow = (globalThis as { window?: unknown }).window;
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { get localStorage() { throw new Error("blocked storage"); } },
});
assert.doesNotThrow(() => loadChatWorkspace());
Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
assert.doesNotThrow(() => loadChatWorkspace({
  getItem: () => { throw new Error("storage read blocked"); },
  setItem: () => { throw new Error("storage write blocked"); },
}));

const largeWorkspace = {
  activeThreadId: "thread-large",
  threads: [{
    ...createChatThread(5000, "thread-large"),
    messages: [{ role: "user" as const, content: "x".repeat(100_000) }],
  }],
};
const boundedStore = storage();
saveChatWorkspace(largeWorkspace, boundedStore);
assert.ok((loadChatWorkspace(boundedStore).threads[0]?.messages[0]?.content.length ?? 0) < 20_000);
console.log("chat history tests passed");
