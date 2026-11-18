"use strict";
/* =============================== 1. IndexedDB ============================= */
const DB = (() => {
  const NAME = "perfiles3d", VER = 1, STORE = "kv";
  let p = null;
  const mem = new Map();

  function open() {
    if (p) return p;
    p = new Promise((res, rej) => {
      if (!("indexedDB" in window)) return rej(new Error("sin IndexedDB"));
      const r = indexedDB.open(NAME, VER);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return p;
  }

  return {
    async get(key) {
      try {
        const db = await open();
        return await new Promise((res, rej) => {
          const q = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
          q.onsuccess = () => res(q.result);
          q.onerror = () => rej(q.error);
        });
      } catch { return mem.get(key); }
    },
    async set(key, val) {
      mem.set(key, val);
      try {
        const db = await open();
        await new Promise((res, rej) => {
          const q = db.transaction(STORE, "readwrite").objectStore(STORE).put(val, key);
          q.onsuccess = () => res();
          q.onerror = () => rej(q.error);
        });
        return true;
      } catch { return false; }
    },
    async del(key) {
      mem.delete(key);
      try {
        const db = await open();
        await new Promise((res, rej) => {
          const q = db.transaction(STORE, "readwrite").objectStore(STORE).delete(key);
          q.onsuccess = () => res();
          q.onerror = () => rej(q.error);
        });
      } catch { /* memoria */ }
    },
  };
})();

