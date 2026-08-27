import { describe, expect, it, beforeEach, vi } from "vitest";
import { clearChatWorkspace, dropLegacyChatWorkspace, loadChatWorkspace, saveChatWorkspace, type ChatWorkspace } from "./chatHistory";
import { indexRecordsForChunks, removeDocumentVectorsForPaths } from "./documentIndex";
import { defaultPreferences, savePreferences, shouldConfirmDestructive } from "./preferences";

const LEGACY_KEY = "llama-board.chat-workspace.v1";
const CURRENT_KEY = "llama-board.chat-workspace.v2";
const INDEX_PREFIX = "llama-board.document-index.v1.";

function workspace(id: string, title: string): ChatWorkspace {
  return {
    activeThreadId: id,
    threads: [{
      id, title, systemPrompt: "", createdAt: 1, updatedAt: 1,
      messages: [{ role: "user", content: "secret" }],
    }],
  };
}

beforeEach(() => {
  localStorage.clear();
  // jsdom has no IndexedDB; the stores fall back to localStorage.
  vi.stubGlobal("indexedDB", undefined);
});

describe("conversation deletion leaves nothing behind", () => {
  it("removes the pre-migration copy so deleted chats are not readable in it", () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(workspace("a", "old")));
    dropLegacyChatWorkspace();
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it("no longer falls back to legacy data once it has been dropped", () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(workspace("a", "old")));
    expect(loadChatWorkspace().threads[0].title).toBe("old");
    dropLegacyChatWorkspace();
    expect(loadChatWorkspace().threads[0].title).not.toBe("old");
  });

  it("clears every stored copy of the workspace", async () => {
    saveChatWorkspace(workspace("a", "kept"));
    localStorage.setItem(LEGACY_KEY, JSON.stringify(workspace("b", "older")));
    expect(localStorage.getItem(CURRENT_KEY)).not.toBeNull();

    const fresh = await clearChatWorkspace();

    expect(localStorage.getItem(CURRENT_KEY)).toBeNull();
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(fresh.threads[0].messages).toEqual([]);
  });
});

describe("orphaned document embeddings", () => {
  const chunk = (path: string) => ({
    document: { name: path, path, text: "document body" },
    offset: 0,
    text: "document body",
    score: 0,
    order: 0,
  });

  function seed(paths: string[]) {
    const records = paths.flatMap((path) => indexRecordsForChunks("model", [chunk(path)], [[1, 0]], 1, "ns"));
    for (const record of records) localStorage.setItem(INDEX_PREFIX + record.key, JSON.stringify(record));
  }

  const storedPaths = () => Object.keys(localStorage)
    .filter((key) => key.startsWith(INDEX_PREFIX))
    .map((key) => (JSON.parse(localStorage.getItem(key) ?? "{}") as { path?: string }).path);

  it("drops only the paths it is given", async () => {
    seed(["C:\\a.md", "C:\\b.md"]);
    expect(storedPaths().sort()).toEqual(["C:\\a.md", "C:\\b.md"]);

    const removed = await removeDocumentVectorsForPaths(["C:\\a.md"]);

    expect(removed).toBe(1);
    expect(storedPaths()).toEqual(["C:\\b.md"]);
  });

  it("is a no-op when nothing is orphaned", async () => {
    seed(["C:\\a.md"]);
    expect(await removeDocumentVectorsForPaths([])).toBe(0);
    expect(await removeDocumentVectorsForPaths(["C:\\missing.md"])).toBe(0);
    expect(storedPaths()).toEqual(["C:\\a.md"]);
  });
});

describe("destructive-action confirmation preference", () => {
  it("defaults to asking", () => {
    expect(shouldConfirmDestructive()).toBe(true);
  });

  it("reports the stored choice so panels can skip the dialog", () => {
    savePreferences({ ...defaultPreferences(), advanced: { developerMode: false, confirmDestructiveActions: false } });
    expect(shouldConfirmDestructive()).toBe(false);
    savePreferences({ ...defaultPreferences(), advanced: { developerMode: false, confirmDestructiveActions: true } });
    expect(shouldConfirmDestructive()).toBe(true);
  });
});
