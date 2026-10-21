// Storage: IndexedDB in this browser (the Python version uses PostgreSQL + ChromaDB).
// Falls back to memory when IndexedDB isn't available (some private windows), so the app still runs;
// in that case nothing survives a reload, and the app says so.

const DB_NAME = "testyourbrain";
const VERSION = 1;

const STORES = {
  users: ["email"],
  documents: ["owner_id"],
  files: [],
  chunks: ["document_id"],
  topics: ["document_id"],
  quizzes: ["owner_id", "share_token"],
  questions: ["quiz_id"],
  attempts: ["quiz_id", "user_id"],
};

const AUTO_ID = new Set(["users", "documents", "topics", "quizzes", "questions", "attempts"]);

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openIndexedDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB is not available"));
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const idb = req.result;
      for (const [name, indexes] of Object.entries(STORES)) {
        if (idb.objectStoreNames.contains(name)) continue;
        const store = idb.createObjectStore(name, { keyPath: "id", autoIncrement: AUTO_ID.has(name) });
        for (const index of indexes) store.createIndex(index, index, { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("The database is open in another tab with an older version."));
  });
}

class IndexedStore {
  constructor(idb) {
    this.idb = idb;
    this.persistent = true;
  }

  async run(store, mode, fn) {
    const tx = this.idb.transaction(store, mode);
    const result = fn(tx.objectStore(store));
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
    });
    return result instanceof IDBRequest ? result.result : result;
  }

  get(store, id) {
    return this.run(store, "readonly", (s) => s.get(id)).then((v) => v ?? null);
  }

  all(store) {
    return this.run(store, "readonly", (s) => s.getAll());
  }

  where(store, index, value) {
    return this.run(store, "readonly", (s) => s.index(index).getAll(value));
  }

  async add(store, obj) {
    const copy = { ...obj };
    if (copy.id === undefined) delete copy.id;
    const id = await this.run(store, "readwrite", (s) => s.add(copy));
    return { ...copy, id };
  }

  async put(store, obj) {
    await this.run(store, "readwrite", (s) => s.put(obj));
    return obj;
  }

  async putMany(store, objs) {
    const out = [];
    await this.run(store, "readwrite", (s) => {
      for (const obj of objs) {
        const copy = { ...obj };
        if (copy.id === undefined) delete copy.id;
        const req = s.put(copy);
        req.onsuccess = () => out.push({ ...copy, id: req.result });
      }
    });
    return out;
  }

  delete(store, id) {
    return this.run(store, "readwrite", (s) => s.delete(id));
  }

  async deleteWhere(store, index, value) {
    await this.run(store, "readwrite", (s) => {
      const req = s.index(index).openKeyCursor(IDBKeyRange.only(value));
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        s.delete(cursor.primaryKey);
        cursor.continue();
      };
    });
  }

  async clearAll() {
    for (const name of Object.keys(STORES)) await this.run(name, "readwrite", (s) => s.clear());
  }
}

/** Same interface, kept in memory. */
class MemoryStore {
  constructor() {
    this.persistent = false;
    this.data = Object.fromEntries(Object.keys(STORES).map((n) => [n, new Map()]));
    this.next = {};
  }

  clone(v) {
    return v === undefined || v === null ? null : structuredClone(v);
  }

  async get(store, id) {
    return this.clone(this.data[store].get(id));
  }

  async all(store) {
    return [...this.data[store].values()].map((v) => this.clone(v));
  }

  async where(store, index, value) {
    return (await this.all(store)).filter((v) => v[index] === value);
  }

  async add(store, obj) {
    const copy = this.clone(obj);
    if (copy.id === undefined || copy.id === null) {
      this.next[store] = (this.next[store] ?? 0) + 1;
      copy.id = this.next[store];
    }
    this.data[store].set(copy.id, copy);
    return this.clone(copy);
  }

  async put(store, obj) {
    if (obj.id === undefined) return this.add(store, obj);
    this.data[store].set(obj.id, this.clone(obj));
    return obj;
  }

  async putMany(store, objs) {
    const out = [];
    for (const o of objs) out.push(await (o.id === undefined ? this.add(store, o) : this.put(store, o)));
    return out;
  }

  async delete(store, id) {
    this.data[store].delete(id);
  }

  async deleteWhere(store, index, value) {
    for (const [id, v] of this.data[store]) if (v[index] === value) this.data[store].delete(id);
  }

  async clearAll() {
    for (const m of Object.values(this.data)) m.clear();
  }
}

let instance = null;

/** The app's database (opened on first use). */
export function getDB() {
  instance ??= openIndexedDB()
    .then((idb) => new IndexedStore(idb))
    .catch((err) => {
      console.warn("IndexedDB unavailable, keeping data in memory only:", err);
      return new MemoryStore();
    });
  return instance;
}

/** For tests: use a fresh in-memory database. */
export function useMemoryDB() {
  instance = Promise.resolve(new MemoryStore());
  return instance;
}

export const STORE_NAMES = Object.keys(STORES);
