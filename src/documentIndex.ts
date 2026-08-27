import type { DocumentChunk } from "./chatUtils";

const INDEX_DB_NAME = "llama-board-document-index";
const INDEX_DB_VERSION = 1;
const INDEX_STORE = "embeddings";
const INDEX_PREFIX = "llama-board.document-index.v1.";
const MAX_RECORDS = 256;
const MAX_VECTOR_VALUES = 2_000_000;

export interface DocumentIndexRecord {
  key: string;
  model: string;
  namespace: string;
  path: string;
  fingerprint: string;
  offsets: number[];
  vectors: number[][];
  updatedAt: number;
}

export function boundedIndexRecords(records: DocumentIndexRecord[]): { records: DocumentIndexRecord[]; removedKeys: string[] } {
  const sorted = [...records].sort((left, right) => left.updatedAt - right.updatedAt);
  const kept = sorted.slice(-MAX_RECORDS);
  const keptKeys = new Set(kept.map((record) => record.key));
  return {
    records: kept,
    removedKeys: sorted.filter((record) => !keptKeys.has(record.key)).map((record) => record.key),
  };
}

function hashText(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function documentFingerprint(text: string): string {
  return `${text.length}:${hashText(text)}`;
}

function recordKey(model: string, path: string, namespace: string): string {
  return `${hashText(`${namespace}\u0000${model}\u0000${path}`)}:${namespace.slice(-96)}:${model.slice(0, 96)}:${path.slice(-192)}`;
}

function validVector(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function validRecord(value: unknown): value is DocumentIndexRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<DocumentIndexRecord>;
  return typeof record.key === "string"
    && typeof record.model === "string"
    && typeof record.namespace === "string"
    && typeof record.path === "string"
    && typeof record.fingerprint === "string"
    && Array.isArray(record.offsets)
    && record.offsets.every((offset) => Number.isInteger(offset) && offset >= 0)
    && Array.isArray(record.vectors)
    && record.vectors.length === record.offsets.length
    && record.vectors.every(validVector)
    && record.vectors.reduce((total, vector) => total + vector.length, 0) <= MAX_VECTOR_VALUES;
}

export function indexRecordForChunks(
  model: string,
  chunks: DocumentChunk[],
  vectors: number[][],
  updatedAt = Date.now(),
  namespace = "",
): DocumentIndexRecord {
  if (chunks.length === 0 || chunks.length !== vectors.length) {
    throw new Error("Document index chunks and vectors must have the same non-zero length.");
  }
  const path = chunks[0].document.path;
  if (chunks.some((chunk) => chunk.document.path !== path)) {
    throw new Error("Document index records can contain one document at a time.");
  }
  if (vectors.some((vector) => !validVector(vector))) {
    throw new Error("Document index contains an invalid embedding vector.");
  }
  return {
    key: recordKey(model, path, namespace),
    model,
    namespace,
    path,
    fingerprint: documentFingerprint(chunks[0].document.text),
    offsets: chunks.map((chunk) => chunk.offset),
    vectors: vectors.map((vector) => [...vector]),
    updatedAt,
  };
}

export function indexRecordsForChunks(
  model: string,
  chunks: DocumentChunk[],
  vectors: number[][],
  updatedAt = Date.now(),
  namespace = "",
): DocumentIndexRecord[] {
  if (chunks.length !== vectors.length) throw new Error("Document index chunks and vectors must have the same length.");
  const grouped = new Map<string, { chunks: DocumentChunk[]; vectors: number[][] }>();
  chunks.forEach((chunk, index) => {
    const current = grouped.get(chunk.document.path) ?? { chunks: [], vectors: [] };
    current.chunks.push(chunk);
    current.vectors.push(vectors[index]);
    grouped.set(chunk.document.path, current);
  });
  return Array.from(grouped.values()).map((group) => indexRecordForChunks(model, group.chunks, group.vectors, updatedAt, namespace));
}

export function mergeCachedVectors(
  model: string,
  chunks: DocumentChunk[],
  records: DocumentIndexRecord[],
  namespace = "",
): number[][] | null {
  if (chunks.length === 0) return null;
  const byPath = new Map(records.filter((record) => record.model === model && record.namespace === namespace).map((record) => [record.path, record]));
  const vectors: number[][] = [];
  for (const chunk of chunks) {
    const record = byPath.get(chunk.document.path);
    if (!record || record.fingerprint !== documentFingerprint(chunk.document.text)) return null;
    const index = record.offsets.indexOf(chunk.offset);
    if (index < 0 || !record.vectors[index]) return null;
    vectors.push(record.vectors[index]);
  }
  return vectors.length === chunks.length ? vectors : null;
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readLocalRecords(storage = browserStorage()): DocumentIndexRecord[] {
  if (!storage) return [];
  const records: DocumentIndexRecord[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(INDEX_PREFIX)) continue;
    try {
      const parsed: unknown = JSON.parse(storage.getItem(key) ?? "null");
      if (validRecord(parsed)) records.push(parsed);
    } catch {
      // Ignore corrupt cache entries; the next successful index replaces them.
    }
  }
  return boundedIndexRecords(records).records;
}

function writeLocalRecords(records: DocumentIndexRecord[], storage = browserStorage()): void {
  if (!storage) return;
  const bounded = boundedIndexRecords(records);
  for (const key of bounded.removedKeys) storage.removeItem(`${INDEX_PREFIX}${key}`);
  // `records` is the complete set, so anything still stored under the prefix
  // that is not in it has been deleted and must not linger on disk.
  const keep = new Set(bounded.records.map((record) => `${INDEX_PREFIX}${record.key}`));
  const stale: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(INDEX_PREFIX) && !keep.has(key)) stale.push(key);
  }
  for (const key of stale) storage.removeItem(key);
  for (const record of bounded.records) {
    try {
      storage.setItem(`${INDEX_PREFIX}${record.key}`, JSON.stringify(record));
    } catch {
      // Cache is an optimization. Quota errors must not block chat.
      return;
    }
  }
}

function openIndexDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable."));
      return;
    }
    const request = indexedDB.open(INDEX_DB_NAME, INDEX_DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(INDEX_STORE)) request.result.createObjectStore(INDEX_STORE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Document index database could not be opened."));
  });
}

async function readIndexedRecords(): Promise<DocumentIndexRecord[]> {
  const db = await openIndexDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(INDEX_STORE, "readonly").objectStore(INDEX_STORE).getAll();
    request.onsuccess = () => {
      db.close();
      resolve(request.result.filter(validRecord).slice(-MAX_RECORDS));
    };
    request.onerror = () => {
      db.close();
      reject(request.error ?? new Error("Document index read failed."));
    };
  });
}

async function writeIndexedRecords(records: DocumentIndexRecord[]): Promise<void> {
  const db = await openIndexDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(INDEX_STORE, "readwrite");
    const store = transaction.objectStore(INDEX_STORE);
    const bounded = boundedIndexRecords(records);
    for (const key of bounded.removedKeys) store.delete(key);
    for (const record of bounded.records) store.put(record);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error ?? new Error("Document index write failed."));
    };
  });
}

let indexMutationQueue: Promise<void> = Promise.resolve();

function enqueueIndexMutation<T>(task: () => Promise<T>): Promise<T> {
  const operation = indexMutationQueue.then(task, task);
  indexMutationQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

export async function loadDocumentVectors(model: string, chunks: DocumentChunk[], namespace = ""): Promise<number[][] | null> {
  try {
    const records = await readIndexedRecords();
    return mergeCachedVectors(model, chunks, records, namespace);
  } catch {
    return mergeCachedVectors(model, chunks, readLocalRecords(), namespace);
  }
}

export function saveDocumentVectors(model: string, chunks: DocumentChunk[], vectors: number[][], namespace = ""): Promise<void> {
  return enqueueIndexMutation(async () => {
    const next = indexRecordsForChunks(model, chunks, vectors, Date.now(), namespace);
    try {
      const existing = await readIndexedRecords();
      const keys = new Set(next.map((record) => record.key));
      await writeIndexedRecords([...existing.filter((record) => !keys.has(record.key)), ...next]);
    } catch {
      const existing = readLocalRecords();
      const keys = new Set(next.map((record) => record.key));
      writeLocalRecords([...existing.filter((record) => !keys.has(record.key)), ...next]);
    }
  });
}

/**
 * Drops every cached embedding for the given document paths.
 *
 * The cache is shared across conversations on purpose — re-embedding a document
 * is expensive — so the caller is responsible for passing only paths that no
 * remaining conversation still references.
 */
export function removeDocumentVectorsForPaths(paths: string[]): Promise<number> {
  const doomed = new Set(paths);
  if (doomed.size === 0) return Promise.resolve(0);
  return enqueueIndexMutation(async () => {
    const keep = (record: DocumentIndexRecord) => !doomed.has(record.path);
    try {
      const existing = await readIndexedRecords();
      const remaining = existing.filter(keep);
      if (remaining.length !== existing.length) await writeIndexedRecords(remaining);
      return existing.length - remaining.length;
    } catch {
      const existing = readLocalRecords();
      const remaining = existing.filter(keep);
      if (remaining.length !== existing.length) writeLocalRecords(remaining);
      return existing.length - remaining.length;
    }
  });
}

export function clearDocumentIndex(): Promise<void> {
  return enqueueIndexMutation(async () => {
  const storage = browserStorage();
  if (storage) {
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key?.startsWith(INDEX_PREFIX)) storage.removeItem(key);
    }
  }
  try {
    const db = await openIndexDb();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(INDEX_STORE, "readwrite");
      transaction.objectStore(INDEX_STORE).clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Document index clear failed."));
    });
    db.close();
  } catch {
    // No persistent store available; localStorage was cleared above.
  }
  });
}
