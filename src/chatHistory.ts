import type { DocumentAttachment, ImageAttachment } from "./chatUtils";
import { storageAdapter } from "./storageAdapter.ts";

export const CHAT_WORKSPACE_KEY = "llama-board.chat-workspace.v2";
const LEGACY_CHAT_WORKSPACE_KEY = "llama-board.chat-workspace.v1";
const CHAT_DB_NAME = "llama-board-chat";
const CHAT_DB_VERSION = 1;
const CHAT_STORE = "workspace";
const CHAT_RECORD_KEY = "active";
const LOCAL_IMAGE_LIMIT = 512 * 1024;
const LOCAL_DOCUMENT_LIMIT = 64 * 1024;
const PERSISTED_TEXT_LIMIT = 16 * 1024;
const PERSISTED_REASONING_LIMIT = 16 * 1024;
const PERSISTED_MESSAGES_LIMIT = 100;
const PERSISTED_THREADS_LIMIT = 100;
const PERSISTED_RAW_LIMIT = 4 * 1024 * 1024;

export interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
  images?: ImageAttachment[];
  documents?: DocumentAttachment[];
  reasoning?: string;
  interrupted?: boolean;
  failed?: boolean;
  citations?: ChatCitation[];
}

export interface ChatCitation {
  name: string;
  path: string;
  offset: number;
  score?: number;
}

export interface ChatThread {
  id: string;
  title: string;
  systemPrompt: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatHistoryMessage[];
}

export interface ChatWorkspace {
  activeThreadId: string;
  threads: ChatThread[];
}

export interface ChatStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  /** Optional so test doubles only need the read/write pair. */
  removeItem?: (key: string) => void;
}

export type ChatPersistenceResult = "indexeddb" | "local" | "unavailable";

function sameWorkspace(left: ChatWorkspace, right: ChatWorkspace): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function browserStorage(): ChatStorage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function validImage(value: unknown): value is ImageAttachment {
  if (value === null || typeof value !== "object") return false;
  const image = value as Partial<ImageAttachment>;
  return typeof image.name === "string" && typeof image.dataUrl === "string";
}

function validDocument(value: unknown): value is DocumentAttachment {
  if (value === null || typeof value !== "object") return false;
  const document = value as Partial<DocumentAttachment>;
  return typeof document.name === "string"
    && typeof document.path === "string"
    && typeof document.text === "string";
}

function validCitation(value: unknown): value is ChatCitation {
  if (value === null || typeof value !== "object") return false;
  const citation = value as Partial<ChatCitation>;
  return typeof citation.name === "string"
    && typeof citation.path === "string"
    && typeof citation.offset === "number"
    && Number.isInteger(citation.offset)
    && citation.offset >= 0
    && (citation.score === undefined || (typeof citation.score === "number" && Number.isFinite(citation.score)));
}

function validMessage(value: unknown): value is ChatHistoryMessage {
  if (value === null || typeof value !== "object") return false;
  const message = value as Partial<ChatHistoryMessage>;
  return (message.role === "user" || message.role === "assistant")
    && typeof message.content === "string"
    && (message.images === undefined || (Array.isArray(message.images) && message.images.every(validImage)))
    && (message.documents === undefined || (Array.isArray(message.documents) && message.documents.every(validDocument)))
    && (message.reasoning === undefined || typeof message.reasoning === "string")
    && (message.interrupted === undefined || typeof message.interrupted === "boolean")
    && (message.failed === undefined || typeof message.failed === "boolean")
    && (message.citations === undefined || (Array.isArray(message.citations) && message.citations.every(validCitation)));
}

function normalizeThread(value: unknown): ChatThread | null {
  if (value === null || typeof value !== "object") return null;
  const thread = value as Partial<ChatThread>;
  if (typeof thread.id !== "string" || !thread.id || typeof thread.title !== "string") return null;
  if (!Array.isArray(thread.messages) || !thread.messages.every(validMessage)) return null;
  return {
    id: thread.id,
    title: thread.title.trim() || "New conversation",
    systemPrompt: typeof thread.systemPrompt === "string" ? thread.systemPrompt : "You are a helpful assistant.",
    createdAt: typeof thread.createdAt === "number" ? thread.createdAt : Date.now(),
    updatedAt: typeof thread.updatedAt === "number" ? thread.updatedAt : Date.now(),
    messages: thread.messages,
  };
}

function normalizeWorkspace(value: unknown): ChatWorkspace | null {
  if (value === null || typeof value !== "object") return null;
  const parsed = value as Partial<ChatWorkspace>;
  const threads = Array.isArray(parsed.threads)
    ? parsed.threads.map(normalizeThread).filter((thread): thread is ChatThread => thread !== null)
    : [];
  if (!threads.length) return null;
  const activeThreadId = typeof parsed.activeThreadId === "string" && threads.some((thread) => thread.id === parsed.activeThreadId)
    ? parsed.activeThreadId
    : threads[0].id;
  return { activeThreadId, threads };
}

function parseWorkspace(raw: string | null): ChatWorkspace | null {
  if (!raw || raw.length > PERSISTED_RAW_LIMIT) return null;
  try {
    return normalizeWorkspace(JSON.parse(raw));
  } catch {
    return null;
  }
}

function localSafeWorkspace(workspace: ChatWorkspace): ChatWorkspace {
  const active = workspace.threads.find((thread) => thread.id === workspace.activeThreadId);
  const orderedThreads = active
    ? [active, ...workspace.threads.filter((thread) => thread.id !== active.id)]
    : workspace.threads;
  return {
    ...workspace,
    threads: orderedThreads.slice(0, PERSISTED_THREADS_LIMIT).map((thread) => ({
      ...thread,
      systemPrompt: thread.systemPrompt.slice(0, PERSISTED_TEXT_LIMIT),
      messages: thread.messages.slice(-PERSISTED_MESSAGES_LIMIT).map((message) => {
        const safeMessage: ChatHistoryMessage = {
          role: message.role,
          content: message.content.slice(0, PERSISTED_TEXT_LIMIT),
        };
        if (message.reasoning !== undefined) safeMessage.reasoning = message.reasoning.slice(0, PERSISTED_REASONING_LIMIT);
        if (message.interrupted) safeMessage.interrupted = true;
        if (message.failed) safeMessage.failed = true;
        if (message.images !== undefined) {
          safeMessage.images = message.images.slice(0, 4).map((image) => ({
            name: image.name,
            dataUrl: image.dataUrl.length <= LOCAL_IMAGE_LIMIT ? image.dataUrl : "",
          }));
        }
        if (message.documents !== undefined) {
          safeMessage.documents = message.documents.slice(0, 4).map((document) => ({
            ...document,
            text: document.text.slice(0, LOCAL_DOCUMENT_LIMIT),
          }));
        }
        if (message.citations !== undefined) safeMessage.citations = message.citations.slice(0, 64);
        return safeMessage;
      }),
    })),
  };
}

function persistedWorkspace(workspace: ChatWorkspace): ChatWorkspace {
  const safe = localSafeWorkspace(workspace);
  const threads = safe.threads.filter((thread) => thread.messages.length > 0 || thread.id === safe.activeThreadId);
  return {
    ...safe,
    threads: threads.length ? threads : [safe.threads[0]],
    activeThreadId: threads.some((thread) => thread.id === safe.activeThreadId)
      ? safe.activeThreadId
      : threads[0]?.id ?? safe.activeThreadId,
  };
}

function openChatDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable."));
      return;
    }
    const request = indexedDB.open(CHAT_DB_NAME, CHAT_DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(CHAT_STORE)) request.result.createObjectStore(CHAT_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB could not be opened."));
  });
}

async function readIndexedWorkspace(): Promise<ChatWorkspace | null> {
  const db = await openChatDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(CHAT_STORE, "readonly").objectStore(CHAT_STORE).get(CHAT_RECORD_KEY);
    request.onsuccess = () => {
      db.close();
      const workspace = normalizeWorkspace(request.result);
      resolve(workspace ? persistedWorkspace(workspace) : null);
    };
    request.onerror = () => {
      db.close();
      reject(request.error ?? new Error("IndexedDB read failed."));
    };
  });
}

async function writeIndexedWorkspace(workspace: ChatWorkspace): Promise<void> {
  const db = await openChatDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(CHAT_STORE, "readwrite");
    transaction.objectStore(CHAT_STORE).put(workspace, CHAT_RECORD_KEY);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error ?? new Error("IndexedDB write failed."));
    };
  });
}

async function deleteIndexedWorkspace(): Promise<void> {
  const db = await openChatDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(CHAT_STORE, "readwrite");
    transaction.objectStore(CHAT_STORE).delete(CHAT_RECORD_KEY);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error ?? new Error("IndexedDB delete failed."));
    };
  });
}

export function titleFromMessage(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  if (!compact) return "New conversation";
  return compact.length > 42 ? `${compact.slice(0, 39).trimEnd()}…` : compact;
}

export function createChatThread(
  now = Date.now(),
  id = `thread-${now}`,
  title = "New conversation",
): ChatThread {
  return {
    id,
    title,
    systemPrompt: "You are a helpful assistant.",
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

export function defaultChatWorkspace(now = Date.now()): ChatWorkspace {
  const thread = createChatThread(now);
  return { activeThreadId: thread.id, threads: [thread] };
}

export function mergeHydratedWorkspace(
  persisted: ChatWorkspace,
  current: ChatWorkspace,
  initial: ChatWorkspace,
): ChatWorkspace {
  if (sameWorkspace(current, initial)) return persisted;

  const initialById = new Map(initial.threads.map((thread) => [thread.id, thread]));
  const currentById = new Map(current.threads.map((thread) => [thread.id, thread]));
  const merged = persisted.threads.flatMap((thread) => {
    const local = currentById.get(thread.id);
    const baseline = initialById.get(thread.id);
    if (!local && baseline) return [];
    const localChanged = local && (!baseline || JSON.stringify(local) !== JSON.stringify(baseline));
    return [localChanged ? local : thread];
  });
  for (const local of current.threads) {
    if (!persisted.threads.some((thread) => thread.id === local.id) && !initialById.has(local.id)) merged.push(local);
  }
  const activeThreadId = current.activeThreadId !== initial.activeThreadId && currentById.has(current.activeThreadId)
    ? current.activeThreadId
    : persisted.threads.some((thread) => thread.id === persisted.activeThreadId)
      ? persisted.activeThreadId
      : merged[0]?.id ?? current.activeThreadId;
  return { activeThreadId, threads: merged };
}

/** Removes the pre-migration localStorage copy of the workspace. */
export function dropLegacyChatWorkspace(storage: ChatStorage | null = browserStorage()): void {
  try {
    storage?.removeItem?.(LEGACY_CHAT_WORKSPACE_KEY);
  } catch {
    // Nothing to do when storage is unavailable.
  }
}

/**
 * Erases every stored conversation from all three copies (IndexedDB, the
 * localStorage mirror, and the pre-migration key) and returns a fresh
 * workspace. Deleting a single thread already rewrites the saved blob; this is
 * the "leave nothing behind" path exposed in Settings.
 */
export async function clearChatWorkspace(): Promise<ChatWorkspace> {
  const fresh = defaultChatWorkspace();
  const storage = browserStorage();
  try {
    storage?.removeItem?.(CHAT_WORKSPACE_KEY);
  } catch {
    // Continue; the remaining copies still need clearing.
  }
  dropLegacyChatWorkspace(storage);
  try {
    await storageAdapter.remove(CHAT_WORKSPACE_KEY);
  } catch {
    // The adapter is optional; the dedicated database is cleared below.
  }
  try {
    await deleteIndexedWorkspace();
  } catch {
    // No IndexedDB copy to clear.
  }
  return fresh;
}

export function loadChatWorkspace(storage: ChatStorage | null = browserStorage()): ChatWorkspace {
  if (!storage) return defaultChatWorkspace();
  try {
    return persistedWorkspace(parseWorkspace(storage.getItem(CHAT_WORKSPACE_KEY))
      ?? parseWorkspace(storage.getItem(LEGACY_CHAT_WORKSPACE_KEY))
      ?? defaultChatWorkspace());
  } catch {
    return defaultChatWorkspace();
  }
}

export function saveChatWorkspace(
  workspace: ChatWorkspace,
  storage: ChatStorage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(CHAT_WORKSPACE_KEY, JSON.stringify(persistedWorkspace(workspace)));
  } catch {
    // A full/blocked localStorage must not break chatting.
  }
}

export async function loadChatWorkspaceAsync(): Promise<ChatWorkspace> {
  try {
    const stored = await storageAdapter.get<unknown>(CHAT_WORKSPACE_KEY);
    const normalized = normalizeWorkspace(stored);
    if (normalized) return persistedWorkspace(normalized);
    const legacy = parseWorkspace(browserStorage()?.getItem(LEGACY_CHAT_WORKSPACE_KEY) ?? null);
    if (legacy) {
      const migrated = persistedWorkspace(legacy);
      await storageAdapter.set(CHAT_WORKSPACE_KEY, migrated);
      // Drop the pre-migration copy; otherwise conversations the user later
      // deletes stay readable in localStorage forever.
      dropLegacyChatWorkspace();
      return migrated;
    }
  } catch {
    // Fall through to the dedicated IndexedDB/localStorage compatibility path.
  }
  try {
    const indexed = await readIndexedWorkspace();
    if (indexed) return indexed;
  } catch {
    // Fall back to the synchronous localStorage copy below.
  }
  return loadChatWorkspace();
}

export async function saveChatWorkspaceAsync(workspace: ChatWorkspace): Promise<ChatPersistenceResult> {
  const safe = persistedWorkspace(workspace);
  saveChatWorkspace(safe);
  try {
    await storageAdapter.set(CHAT_WORKSPACE_KEY, safe);
    return "indexeddb";
  } catch {
    try {
      await writeIndexedWorkspace(safe);
      return "indexeddb";
    } catch {
      return browserStorage() ? "local" : "unavailable";
    }
  }
}

export function threadMatchesQuery(thread: ChatThread, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const fields = [thread.title, thread.systemPrompt];
  for (const message of thread.messages) {
    fields.push(message.content);
    for (const image of message.images ?? []) fields.push(image.name);
    for (const document of message.documents ?? []) fields.push(document.name, document.text);
  }
  return fields.some((field) => field.toLowerCase().includes(normalized));
}
