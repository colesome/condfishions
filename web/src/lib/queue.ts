/**
 * Offline-first write queue. Every trip/catch/photo write goes here first (IndexedDB), then is
 * flushed to the server in order. Works with no signal; retries on reopen or when back online.
 * Writes are idempotent (rows carry their own ids; photo uploads overwrite), so retries are safe.
 */
import { api } from "./api";

type Op =
  | { kind: "upsert"; table: string; row: Record<string, unknown> }
  | { kind: "update"; table: string; id: string; patch: Record<string, unknown> }
  | { kind: "photo"; path: string };

const DB = "condfishions";
let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore("queue", { autoIncrement: true });
        r.result.createObjectStore("blobs");
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbp;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then((d) => new Promise<T>((resolve, reject) => {
    const req = fn(d.transaction(store, mode).objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export const putBlob = (key: string, blob: Blob) => tx("blobs", "readwrite", (s) => s.put(blob, key));
export const getBlob = (key: string) => tx<Blob | undefined>("blobs", "readonly", (s) => s.get(key));

export async function enqueue(op: Op): Promise<void> {
  await tx("queue", "readwrite", (s) => s.add(op));
  void flush();
}

export async function pendingCount(): Promise<number> {
  return tx<number>("queue", "readonly", (s) => s.count());
}

let flushing = false;
const listeners = new Set<(n: number) => void>();
export function onPending(fn: (n: number) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
async function notify() {
  const n = await pendingCount().catch(() => 0);
  listeners.forEach((f) => f(n));
}

export async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    for (;;) {
      const next = await db().then((d) => new Promise<{ key: IDBValidKey; op: Op } | null>((resolve, reject) => {
        const req = d.transaction("queue", "readonly").objectStore("queue").openCursor();
        req.onsuccess = () => resolve(req.result ? { key: req.result.key, op: req.result.value as Op } : null);
        req.onerror = () => reject(req.error);
      }));
      if (!next) break;
      const { key, op } = next;
      if (op.kind === "upsert") {
        await api.upsert(op.table, op.row);
      } else if (op.kind === "update") {
        await api.update(op.table, op.id, op.patch);
      } else {
        const blob = await getBlob(op.path);
        if (blob) await api.uploadPhoto(op.path, blob);
      }
      await tx("queue", "readwrite", (s) => s.delete(key));
      await notify();
    }
  } catch {
    // offline or server error — leave the rest queued; we'll retry later
  } finally {
    flushing = false;
    await notify();
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => void flush());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void flush(); });
}
