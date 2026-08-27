export interface StorageAdapter {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

const DB_NAME = "llama-board-storage";
const DB_VERSION = 1;
const STORE_NAME = "values";

function localStorageSafe(): Storage | null {
  try { return typeof window !== "undefined" ? window.localStorage : null; } catch { return null; }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB unavailable")); return; }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Storage database could not be opened"));
  });
}

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key);
    request.onsuccess = () => { db.close(); resolve((request.result as T | undefined) ?? null); };
    request.onerror = () => { db.close(); reject(request.error ?? new Error("Storage read failed")); };
  });
}

async function idbPut<T>(key: string, value: T): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(value, key);
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => { db.close(); reject(transaction.error ?? new Error("Storage write failed")); };
  });
}

async function idbRemove(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(key);
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => { db.close(); reject(transaction.error ?? new Error("Storage delete failed")); };
  });
}

export const storageAdapter: StorageAdapter = {
  async get<T>(key: string): Promise<T | null> {
    try {
      const value = await idbGet<T>(key);
      if (value !== null) return value;
    } catch { /* fallback below */ }
    const storage = localStorageSafe();
    if (!storage) return null;
    try { return JSON.parse(storage.getItem(key) ?? "null") as T | null; } catch { return null; }
  },
  async set<T>(key: string, value: T): Promise<void> {
    try { await idbPut(key, value); return; } catch { /* fallback below */ }
    const storage = localStorageSafe();
    if (storage) storage.setItem(key, JSON.stringify(value));
  },
  async remove(key: string): Promise<void> {
    try { await idbRemove(key); } catch { /* fallback below */ }
    try { localStorageSafe()?.removeItem(key); } catch { /* optional */ }
  },
};

export function storageSchema(): { name: string; version: number; store: string } {
  return { name: DB_NAME, version: DB_VERSION, store: STORE_NAME };
}

export async function migrateLegacyKey<T>(key: string, legacyKey = key): Promise<T | null> {
  const current = await storageAdapter.get<T>(key);
  if (current !== null) return current;
  const storage = localStorageSafe();
  if (!storage) return null;
  try {
    const legacy = JSON.parse(storage.getItem(legacyKey) ?? "null") as T | null;
    if (legacy !== null) await storageAdapter.set(key, legacy);
    return legacy;
  } catch { return null; }
}
