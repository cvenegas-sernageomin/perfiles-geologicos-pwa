"use strict";
/* =============================================================================
   projection.js — cómo llegan los datos puntuales al plano de la sección
   -----------------------------------------------------------------------------
   perp    perpendicular al tramo más cercano, dentro del corredor ±corr.
   strike  a lo largo del rumbo de cada manteo (rumbo horizontal → conserva la
           cota); recorrido máximo = corredor. Contactos y estaciones: perp.
   plunge  en la dirección del eje de pliegue (trend/plunge): la cota cambia
           z' = z − h·tan(plunge), h = recorrido horizontal en el sentido del
           trend (down-plunge, cilindrismo). Recorrido máximo = corredor.
   En todos los modos el punto se dibuja a SU cota (dato o DEM en el punto),
   no a la del terreno en la traza; sin cota conocida se usa la del terreno.
   ========================================================================== */
const Projection = {
  pending: false,

  /** cota del punto: la del dato, la del DEM ya leída, o null */
  zOf(f) { return f.z != null ? f.z : f.zDem != null ? f.zDem : null; },

  /** intersección del rayo P + h·d (h con signo) con la traza; la de menor |h| */
  alongDir(fr, x, y, dx, dy) {
    let best = null;
    for (const sg of fr.segs) {
      const bx = sg.ux * sg.len, by = sg.uy * sg.len;
      const den = dx * by - dy * bx;
      if (Math.abs(den) < 1e-9) continue;
      const wx = sg.x - x, wy = sg.y - y;
      const h = (wx * by - wy * bx) / den;          // recorrido desde P
      const u = (wx * dy - wy * dx) / den;          // fracción del tramo
      if (u < 0 || u > 1) continue;
      if (!best || Math.abs(h) < Math.abs(best.h)) best = { h, s: sg.s0 + u * sg.len, seg: sg };
    }
    return best;
  },

  point(f, fr, corr) {
    const mode = State.prefs.proj || "perp";
    const z0 = this.zOf(f);

    if (mode === "strike" && f.kind === "dip") {
      const st = ((f.dir - 90) % 360 + 360) % 360;
      const [x, y] = Geo.toXY(fr, f.lat, f.lng);
      const r = this.alongDir(fr, x, y, Math.sin(st * Math.PI / 180), Math.cos(st * Math.PI / 180));
      if (!r) return { inside: false, seg: fr.segs[0], s: null, t: null };
      // rumbo casi paralelo a la traza: el recorrido se dispara → fuera
      return { s: r.s, t: r.h, seg: r.seg, inside: Math.abs(r.h) <= corr, z: z0, via: "rumbo" };
    }

    if (mode === "plunge") {
      const tr = Number(State.prefs.trend) || 0, pl = Number(State.prefs.plunge) || 0;
      const [x, y] = Geo.toXY(fr, f.lat, f.lng);
      const r = this.alongDir(fr, x, y, Math.sin(tr * Math.PI / 180), Math.cos(tr * Math.PI / 180));
      if (!r) return { inside: false, seg: fr.segs[0], s: null, t: null };
      const z = z0 == null ? null : z0 - r.h * Math.tan(pl * Math.PI / 180);
      return { s: r.s, t: r.h, seg: r.seg, inside: Math.abs(r.h) <= corr && z != null, z, via: "eje" };
    }

    const p = Geo.toSection(fr, f.lat, f.lng);
    if (!p) return null;
    return { s: p.s, t: p.t, seg: p.seg, inside: p.s >= 0 && p.s <= fr.L && Math.abs(p.t) <= corr, z: z0, via: "perp" };
  },

  /** lee del DEM la cota de los puntos cercanos a la traza que no la tienen */
  async ensureZ() {
    const fr = View.frame;
    if (!fr || this.pending) return 0;
    this.pending = true;
    const corr = Number(State.prefs.corr);
    const b = bboxOf(fr.pts);
    const padLat = corr / 110540 * 1.2, padLng = corr / fr.mx * 1.2;
    const jobs = [];
    for (const f of State.allFeats()) {
      if (f.lat == null || f.z != null || f.zDem != null) continue;
      if (f.lat < b[0] - padLat || f.lat > b[2] + padLat || f.lng < b[1] - padLng || f.lng > b[3] + padLng) continue;
      jobs.push(DEM.elevation(f.lat, f.lng).then((z) => { if (z != null) f.zDem = Math.round(z); }));
    }
    await Promise.all(jobs);
    this.pending = false;
    if (jobs.length) { State.persistLayers(); State.persist(); }
    return jobs.length;
  },

  /** amarres: chainages donde otras secciones cruzan la activa */
  ties(fr) {
    const out = [];
    for (const o of State.others()) {
      const pts = Geo.tracePts(o.trace);
      for (const c of Geo.crossTrace(fr, pts)) out.push({ s: c.s, name: o.name, id: o.id });
    }
    return out;
  },
};
