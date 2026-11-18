"use strict";
/* ================================= 3. DEM ================================ */
const DEM = {
  Z: 13,                        // ~15–19 m/píxel en Chile
  promise: new Map(),           // clave -> Promise<datos|null>
  ready: new Map(),             // clave -> Uint8ClampedArray (ya decodificada)

  url(z, x, y) {
    return `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
  },

  /** proyección Web Mercator a píxel global del zoom z */
  project(lat, lng, z) {
    const n = 256 * Math.pow(2, z);
    const s = Math.sin(lat * Math.PI / 180);
    return {
      x: ((lng + 180) / 360) * n,
      y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n,
    };
  },

  async tile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (this.promise.has(key)) return this.promise.get(key);
    const p = (async () => {
      let blob = null;
      try {
        const r = await fetch(this.url(z, x, y), { mode: "cors", credentials: "omit" });
        if (r.ok) blob = await r.blob();
      } catch { /* sin red */ }
      if (!blob) {
        try {
          const c = await caches.open("perfil-tiles-v1");
          const r = await c.match(this.url(z, x, y));
          if (r) blob = await r.blob();
        } catch { /* sin caché */ }
      }
      if (!blob) return null;
      try {
        const bmp = await createImageBitmap(blob);
        const cv = document.createElement("canvas");
        cv.width = 256; cv.height = 256;
        const cx = cv.getContext("2d", { willReadFrequently: true });
        cx.drawImage(bmp, 0, 0);
        const d = cx.getImageData(0, 0, 256, 256).data;
        this.ready.set(key, d);
        return d;
      } catch { return null; }
    })();
    this.promise.set(key, p);
    return p;
  },

  px(data, x, y) {
    const i = ((y & 255) * 256 + (x & 255)) * 4;
    return (data[i] * 256 + data[i + 1] + data[i + 2] / 256) - 32768;
  },

  /** cota bilineal; null si falta la tesela. Si hay un DEM propio que cubre el
   *  punto, manda ese. */
  async elevation(lat, lng, z = this.Z) {
    if (this.user) {
      const v = this.userAt(lat, lng);
      if (v != null) return v;
    }
    const p = this.project(lat, lng, z);
    const tx = Math.floor(p.x / 256), ty = Math.floor(p.y / 256);
    const d = await this.tile(z, tx, ty);
    if (!d) return null;
    const fx = p.x - tx * 256, fy = p.y - ty * 256;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const dx = fx - x0, dy = fy - y0;
    // en el borde de la tesela el vecino +1 se queda en el borde (no da la vuelta)
    const x1 = Math.min(x0 + 1, 255), y1 = Math.min(y0 + 1, 255);
    const z00 = this.px(d, x0, y0), z10 = this.px(d, x1, y0);
    const z01 = this.px(d, x0, y1), z11 = this.px(d, x1, y1);
    return (z00 * (1 - dx) + z10 * dx) * (1 - dy) + (z01 * (1 - dx) + z11 * dx) * dy;
  },

  /* ---------- DEM propio (GeoTIFF) ---------- */
  user: null,       // {name, epsg, w, h, data, ox, oy, rx, ry, nodata, fwd}

  label() {
    return this.user ? `DEM ${this.user.name} (${fmt(Math.abs(this.user.rx), 1)} m) + Terrarium fuera` : "DEM Terrarium 30 m";
  },

  /** lee un GeoTIFF de una banda (cotas) y lo deja como DEM prioritario */
  async loadUser(buf, name, persist = true) {
    if (!window.GeoTIFF) throw new Error("falta geotiff.js");
    const tiff = await GeoTIFF.fromArrayBuffer(buf);
    const img = await tiff.getImage();
    const w = img.getWidth(), h = img.getHeight();
    if (w * h > 64e6) throw new Error(`el DEM es muy grande (${w}×${h}); recórtalo a la zona`);
    const gk = img.getGeoKeys() || {};
    const code = gk.ProjectedCSTypeGeoKey || gk.GeographicTypeGeoKey;
    if (!code || code === 32767) throw new Error("el GeoTIFF no declara su EPSG");
    const epsg = "EPSG:" + code;
    CRS.init();
    if (!proj4.defs(epsg)) {
      const m = /^32([67])(\d\d)$/.exec(String(code));       // WGS84 UTM de cualquier zona
      if (m) proj4.defs(epsg, `+proj=utm +zone=${Number(m[2])}${m[1] === "7" ? " +south" : ""} +datum=WGS84 +units=m +no_defs`);
      else throw new Error(`sistema ${epsg} no soportado (usa WGS84, UTM, PSAD56 o SAD69)`);
    }
    const [ox, oy] = img.getOrigin();
    const [rx, ry] = img.getResolution();
    const ras = await img.readRasters({ samples: [0] });
    const nd = img.getGDALNoData();
    let res = Math.abs(rx);
    if (/4326|4248|4618/.test(epsg)) res *= 111320;          // grados → m aprox. para la etiqueta
    this.user = { name, epsg, w, h, data: ras[0], ox, oy, rx, ry, nodata: nd, fwd: proj4("EPSG:4326", epsg).forward, resM: res };
    if (persist) { try { await DB.set("demUser", { name, buf }); } catch { /* cuota */ } }
    return { w, h, epsg, res };
  },

  async restoreUser() {
    try {
      const o = await DB.get("demUser");
      if (o && o.buf) await this.loadUser(o.buf, o.name, false);
    } catch (e) { console.warn("DEM propio no restaurado", e); }
  },

  async clearUser() { this.user = null; await DB.del("demUser"); },

  /** cota bilineal del DEM propio; null fuera de él o en nodata */
  userAt(lat, lng) {
    const u = this.user;
    const [x, y] = u.fwd([lng, lat]);
    const fx = (x - u.ox) / u.rx - 0.5, fy = (y - u.oy) / u.ry - 0.5;   // centro de píxel
    if (fx < 0 || fy < 0 || fx > u.w - 1 || fy > u.h - 1) return null;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(x0 + 1, u.w - 1), y1 = Math.min(y0 + 1, u.h - 1);
    const dx = fx - x0, dy = fy - y0, d = u.data, W = u.w;
    const v = [d[y0 * W + x0], d[y0 * W + x1], d[y1 * W + x0], d[y1 * W + x1]];
    if (v.some((q) => !isFinite(q) || (u.nodata != null && q === u.nodata) || q < -1000)) return null;
    return (v[0] * (1 - dx) + v[1] * dx) * (1 - dy) + (v[2] * (1 - dx) + v[3] * dx) * dy;
  },

  /** cota sincrónica sobre teselas ya decodificadas (para hillshade) */
  sampleGlobal(gx, gy, z = this.Z) {
    const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256);
    const d = this.ready.get(`${z}/${tx}/${ty}`);
    if (!d) return null;
    return this.px(d, Math.floor(gx) - tx * 256, Math.floor(gy) - ty * 256);
  },

  /** asegura las teselas del recuadro; devuelve cuántas faltaron */
  async ensure(bounds, z = this.Z) {
    const nw = this.project(bounds.getNorth(), bounds.getWest(), z);
    const se = this.project(bounds.getSouth(), bounds.getEast(), z);
    const x0 = Math.floor(nw.x / 256), x1 = Math.floor(se.x / 256);
    const y0 = Math.floor(nw.y / 256), y1 = Math.floor(se.y / 256);
    const jobs = [];
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) jobs.push(this.tile(z, x, y));
    }
    const res = await Promise.all(jobs);
    return res.filter((r) => !r).length;
  },

  /** hillshade del recuadro; devuelve {canvas, missing} */
  async hillshade(bounds, width, zLevel = this.Z) {
    const z = clamp(Math.round(zLevel), 9, this.Z);
    const w = clamp(Math.round(width), 64, 820);
    const ratio = (bounds.getNorth() - bounds.getSouth()) /
                  Math.max(1e-9, bounds.getEast() - bounds.getWest());
    const h = clamp(Math.round(w * ratio / Math.cos(((bounds.getNorth() + bounds.getSouth()) / 2) * Math.PI / 180)), 64, 820);

    const missing = await this.ensure(bounds, z);   // no bloquea si falla parte
    const p1 = this.project(bounds.getNorth(), bounds.getWest(), z);
    const p2 = this.project(bounds.getSouth(), bounds.getEast(), z);
    const res = 156543.03392 * Math.cos(((bounds.getNorth() + bounds.getSouth()) / 2) * Math.PI / 180) / Math.pow(2, z);

    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const cx = cv.getContext("2d");
    const img = cx.createImageData(w, h);
    const sunAz = (360 - 315 + 90) * Math.PI / 180;
    const sunZen = (90 - 45) * Math.PI / 180;

    for (let j = 0; j < h; j++) {
      const gy = p1.y + (p2.y - p1.y) * (j / (h - 1));
      for (let i = 0; i < w; i++) {
        const gx = p1.x + (p2.x - p1.x) * (i / (w - 1));
        const zl = this.sampleGlobal(gx - 1, gy, z), zr = this.sampleGlobal(gx + 1, gy, z);
        const zu = this.sampleGlobal(gx, gy - 1, z), zd = this.sampleGlobal(gx, gy + 1, z);
        if (zl == null || zr == null || zu == null || zd == null) continue;
        const dx = (zr - zl) / (2 * res), dy = (zd - zu) / (2 * res);
        const slope = Math.atan(Math.hypot(dx, dy));
        const aspect = Math.atan2(dy, -dx);
        let hs = Math.cos(sunZen) * Math.cos(slope)
               + Math.sin(sunZen) * Math.sin(slope) * Math.cos(sunAz - aspect);
        hs = clamp(hs, 0, 1);
        const v = Math.round(255 * (0.32 + 0.68 * hs));
        const k = (j * w + i) * 4;
        img.data[k] = v; img.data[k + 1] = v; img.data[k + 2] = v; img.data[k + 3] = 255;
      }
    }
    cx.putImageData(img, 0, 0);
    return { canvas: cv, missing };
  },
};

