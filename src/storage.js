/**
 * Storage layer — IndexedDB primary, LocalStorage for boot hints only.
 * Schema version 2. Provides a serialised write queue so concurrent saves
 * never corrupt the database.
 */

const DB_NAME = 'WorkoutFlowDB';
const DB_VERSION = 2;
const STORE_NAME = 'state';

export const LS_BOOT_KEY = 'wf_boot_v2';
const OLD_LS_KEYS = [
  'workoutFlowVerifiedV1',
  'workoutFlowV3',
  'workoutTrackerPro2',
  'homeWorkoutTracker_v2',
];

let _db = null;
let _writeQueue = Promise.resolve();

export let idbActive = false;
export let lastWriteOk = false;
export let lastWriteTime = null;

// ─── IndexedDB ────────────────────────────────────────────────────────────────

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };

      req.onsuccess = () => {
        _db = req.result;
        idbActive = true;
        resolve(_db);
      };

      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IDB blocked by another tab'));
    } catch (err) {
      reject(err);
    }
  });
}

export async function dbGet() {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get('main');
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

/**
 * Enqueue a write. Returns a promise that resolves when the write completes.
 * Writes are serialised — no two writes run concurrently.
 */
export function dbSet(serialisedString) {
  const p = _writeQueue.then(async () => {
    try {
      const db = await openDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const req = tx.objectStore(STORE_NAME).put(serialisedString, 'main');
        req.onsuccess = resolve;
        req.onerror = () => reject(req.error);
      });
      lastWriteOk = true;
      lastWriteTime = new Date();
    } catch {
      lastWriteOk = false;
    }
  });
  _writeQueue = p.catch(() => {}); // keep queue alive on error
  return p;
}

// ─── LocalStorage (boot hints only) ──────────────────────────────────────────

export function lsAvailable() {
  try {
    localStorage.setItem('__wf_probe', '1');
    localStorage.removeItem('__wf_probe');
    return true;
  } catch {
    return false;
  }
}

export function lsGet() {
  try {
    let raw = localStorage.getItem(LS_BOOT_KEY);
    if (!raw) {
      for (const k of OLD_LS_KEYS) {
        raw = localStorage.getItem(k);
        if (raw) break;
      }
    }
    return raw;
  } catch {
    return null;
  }
}

export function lsSet(value) {
  try { localStorage.setItem(LS_BOOT_KEY, value); } catch { /* sandboxed */ }
}