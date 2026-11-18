"use strict";
/* ============================ 7. descarga de zona ======================== */
const Zone = {
  ranges(bounds, z) {
    const nw = DEM.project(bounds.getNorth(), bounds.getWest(), z);
    const se = DEM.project(bounds.getSouth(), bounds.getEast(), z);
    return {
      x0: Math.floor(nw.x / 256), x1: Math.floor(se.x / 256),
      y0: Math.floor(nw.y / 256), y1: Math.floor(se.y / 256),
    };
  },

  plan(bounds, zBase, extra) {
    const jobs = [];
    const zDem = DEM.Z;
    // DEM (dominio público)
    const r1 = this.ranges(bounds, zDem);
    for (let x = r1.x0; x <= r1.x1; x++)
      for (let y = r1.y0; y <= r1.y1; y++)
        jobs.push({ url: DEM_URL(zDem, x, y), kind: "dem", bytes: 80 * 1024 });

    // Sentinel-2 (CC BY-NC-SA)
    const zTop = Math.min(14, zBase + extra);
    for (let z = Math.min(zTop, 11); z <= zTop; z++) {
      const r = this.ranges(bounds, z);
      for (let x = r.x0; x <= r.x1; x++)
        for (let y = r.y0; y <= r.y1; y++)
          jobs.push({ url: S2_URL(z, x, y), kind: "s2", bytes: 32 * 1024 });
    }
    const seen = new Set();
    return jobs.filter((j) => seen.has(j.url) ? false : (seen.add(j.url), true));
  },

  estimate(jobs) {
    return jobs.reduce((s, j) => s + j.bytes, 0) / 1048576;
  },

  async download(jobs, onProgress, isCancelled) {
    const cache = await caches.open("perfil-tiles-v1");
    let cached = 0, failed = 0, bytes = 0, processed = 0;
    const total = jobs.length;
    const queue = jobs.slice();

    const report = () => onProgress({
      total, done: processed, cached, failed,
      mb: bytes / 1048576,
      pct: Math.round((processed / total) * 100),
    });

    const CONCURRENCY = 6;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        if (isCancelled()) return;
        const j = queue.shift();
        try {
          const hit = await cache.match(j.url);
          if (hit) {
            cached++;
          } else {
            const r = await fetch(j.url, { mode: "cors", credentials: "omit" });
            if (!r.ok) throw new Error(String(r.status));
            const buf = await r.clone().arrayBuffer();
            bytes += buf.byteLength;
            await cache.put(j.url, r);
          }
        } catch { failed++; }
        processed++;
        report();
      }
    }));
    return { total, cached, failed, mb: bytes / 1048576, cancelled: isCancelled() };
  },

  async usage() {
    try {
      const cache = await caches.open("perfil-tiles-v1");
      const keys = await cache.keys();
      let bytes = 0;
      for (const k of keys) {
        const r = await cache.match(k);
        if (r) bytes += (await r.clone().arrayBuffer()).byteLength;
      }
      return { tiles: keys.length, mb: bytes / 1048576 };
    } catch { return { tiles: 0, mb: 0 }; }
  },

  async clear() {
    await caches.delete("perfil-tiles-v1");
  },
};

