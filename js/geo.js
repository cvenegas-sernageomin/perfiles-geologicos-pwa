"use strict";
/* ================================ 2. geodesia ============================= */
const Geo = {
  bearing(a, b) {
    const p1 = a[0] * Math.PI / 180, p2 = b[0] * Math.PI / 180;
    const dl = (b[1] - a[1]) * Math.PI / 180;
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  },

  /** UTM WGS84, zona automática */
  utm(lat, lng) {
    const a = 6378137, f = 1 / 298.257223563, e2 = f * (2 - f), k0 = 0.9996;
    const zone = Math.floor((lng + 180) / 6) + 1;
    const l0 = ((zone - 1) * 6 - 180 + 3) * Math.PI / 180;
    const ph = lat * Math.PI / 180, lm = lng * Math.PI / 180;
    const N = a / Math.sqrt(1 - e2 * Math.sin(ph) ** 2);
    const T = Math.tan(ph) ** 2;
    const C = (e2 / (1 - e2)) * Math.cos(ph) ** 2;
    const A = (lm - l0) * Math.cos(ph);
    const M = a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * ph
      - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * ph)
      + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * ph)
      - (35 * e2 ** 3 / 3072) * Math.sin(6 * ph));
    const x = k0 * N * (A + (1 - T + C) * A ** 3 / 6
      + (5 - 18 * T + T ** 2 + 72 * C - 58 * (e2 / (1 - e2))) * A ** 5 / 120) + 500000;
    let y = k0 * (M + N * Math.tan(ph) * (A ** 2 / 2
      + (5 - T + 9 * C + 4 * C ** 2) * A ** 4 / 24
      + (61 - 58 * T + T ** 2 + 600 * C - 330 * (e2 / (1 - e2))) * A ** 6 / 720));
    if (lat < 0) y += 10000000;
    return { e: Math.round(x), n: Math.round(y), zone, hemi: lat < 0 ? "S" : "N" };
  },

  /** vértices de una traza: {pts} nuevo o {a,b} de la v1 */
  tracePts(trace) {
    if (!trace) return null;
    if (Array.isArray(trace.pts) && trace.pts.length >= 2) return trace.pts;
    if (trace.a && trace.b) return [trace.a, trace.b];
    return null;
  },

  /** marco local en metros (equirectangular; error < 0,1 % a 50 km) para una
   *  traza quebrada: cada tramo con su origen, dirección, azimut y chainage s0 */
  frame(trace) {
    const pts = Geo.tracePts(trace);
    if (!pts) return null;
    const lat0 = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const mx = 111320 * Math.cos(lat0 * Math.PI / 180);
    const my = 110540;
    const a = pts[0];
    const xy = pts.map((p) => [(p[1] - a[1]) * mx, (p[0] - a[0]) * my]);
    const segs = [];
    let s0 = 0;
    for (let i = 0; i < xy.length - 1; i++) {
      const dx = xy[i + 1][0] - xy[i][0], dy = xy[i + 1][1] - xy[i][1];
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      segs.push({ x: xy[i][0], y: xy[i][1], ux: dx / len, uy: dy / len, len, s0,
                  az: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360 });
      s0 += len;
    }
    if (!segs.length) return null;
    return { a, pts, mx, my, segs, L: s0, az: segs[0].az, bent: segs.length > 1 };
  },

  /** tramo de la traza que contiene la chainage s */
  segAt(frame, s) {
    const g = frame.segs;
    for (let i = 0; i < g.length; i++) if (s <= g[i].s0 + g[i].len) return g[i];
    return g[g.length - 1];
  },

  /** lat/lng → coordenadas locales (m) */
  toXY(frame, lat, lng) { return [(lng - frame.a[1]) * frame.mx, (lat - frame.a[0]) * frame.my]; },
  fromXY(frame, x, y) { return [frame.a[0] + y / frame.my, frame.a[1] + x / frame.mx]; },

  /** punto de la traza en la chainage s */
  atS(frame, s) {
    const g = Geo.segAt(frame, s);
    const u = s - g.s0;
    return Geo.fromXY(frame, g.x + g.ux * u, g.y + g.uy * u);
  },

  /** proyección perpendicular al tramo más cercano: s (chainage), t (± corredor), seg.
   *  Fuera de los extremos se extrapola el primer/último tramo (s < 0 o s > L). */
  toSection(frame, lat, lng) {
    if (!frame) return null;
    const [x, y] = Geo.toXY(frame, lat, lng);
    let best = null;
    const g = frame.segs;
    for (let i = 0; i < g.length; i++) {
      const sg = g[i];
      const rx = x - sg.x, ry = y - sg.y;
      const along = rx * sg.ux + ry * sg.uy;
      const t = -rx * sg.uy + ry * sg.ux;
      const lo = i === 0 ? -Infinity : 0, hi = i === g.length - 1 ? Infinity : sg.len;
      const a = Math.max(lo, Math.min(hi, along));
      const d = Math.hypot(rx - sg.ux * a, ry - sg.uy * a);
      if (!best || d < best.d) best = { s: sg.s0 + along, t, d, seg: sg, clamped: a !== along };
    }
    return best;
  },

  /** cruces de una polilínea [[lat,lng]…] con la traza: [{s, i (tramo de la línea), seg}] */
  crossTrace(frame, pts) {
    const out = [];
    const xy = pts.map((p) => Geo.toXY(frame, p[0], p[1]));
    for (const sg of frame.segs) {
      const bx = sg.ux * sg.len, by = sg.uy * sg.len;
      for (let i = 0; i < xy.length - 1; i++) {
        const px = xy[i][0], py = xy[i][1];
        const qx = xy[i + 1][0] - px, qy = xy[i + 1][1] - py;
        const den = bx * qy - by * qx;
        if (Math.abs(den) < 1e-12) continue;
        const wx = px - sg.x, wy = py - sg.y;
        const u = (wx * qy - wy * qx) / den;       // a lo largo del tramo de traza (0..1)
        const v = (wx * by - wy * bx) / den;       // a lo largo del tramo de la línea (0..1)
        if (u >= 0 && u < 1 && v >= 0 && v < 1) out.push({ s: sg.s0 + u * sg.len, i, seg: sg });
      }
    }
    return out.sort((a, b) => a.s - b.s);
  },

  /** manteo aparente en el plano de la sección (β entre dirección de manteo y traza) */
  apparentDip(dip, dipDir, azSection) {
    let b = Math.abs(((dipDir - azSection + 540) % 360) - 180);
    b = Math.min(b, 180 - b);
    return Math.atan(Math.tan(dip * Math.PI / 180) * Math.cos(b * Math.PI / 180))
      * 180 / Math.PI;
  },

  /** manteo aparente de una falla de rumbo conocido (θ entre rumbo y traza) */
  apparentDipStrike(dip, strike, azSection) {
    let th = Math.abs(((strike - azSection + 540) % 360) - 180);
    th = Math.min(th, 180 - th);
    return Math.atan(Math.tan(dip * Math.PI / 180) * Math.sin(th * Math.PI / 180))
      * 180 / Math.PI;
  },
};

