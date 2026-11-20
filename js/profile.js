"use strict";
/* ============================== 6. sección ===============================
   Proyección de entidades a la sección A–B y dibujo del perfil.
   - Puntos (contacto, manteo, estación): perpendicular dentro del corredor.
   - Líneas (contacto, falla, eje, lineamiento): TODOS sus cruces con la traza.
   - Polígonos de unidad: geología en superficie muestreando la traza; los
     cambios de unidad son contactos derivados (posición refinada por bisección).
   ========================================================================= */
const LINE_KINDS = new Set(["fault", "cline", "axis", "lineament"]);

const Profile = {
  geom: null,
  _surf: null,          // caché de geología en superficie {key, runs, contacts}

  /** cruces de una polilínea con la traza (quebrada o no) */
  crossings(f, fr) {
    // descarte rápido por recuadro
    const b = f.bbox || (f.bbox = bboxOf(f.pts));
    const tb = fr.bbox || (fr.bbox = bboxOf(fr.pts));
    if (b[2] < tb[0] || b[0] > tb[2] || b[3] < tb[1] || b[1] > tb[3]) return [];
    return Geo.crossTrace(fr, f.pts);
  },

  /** proyección de una entidad al plano de la sección */
  project(f) {
    const fr = View.frame;
    if (!fr) return null;
    const corr = Number(State.prefs.corr);

    if (f.kind === "contact" || f.kind === "dip" || f.kind === "station") {
      const p = Projection.point(f, fr, corr);
      if (!p) return null;
      const ap = f.kind === "dip" ? Geo.apparentDip(f.dip, f.dir, p.seg.az) : null;
      return { ...p, ap };
    }

    if (LINE_KINDS.has(f.kind)) {
      const cr = this.crossings(f, fr).map((c) => {
        const strike = Geo.bearing(f.pts[c.i], f.pts[c.i + 1]);
        const o = { s: c.s, strike, az: c.seg.az };
        if (f.kind === "fault") {
          // con plano conocido (dirección de manteo) manda ese; si no, el rumbo del tramo cortado
          o.ap = f.dipdir != null ? Geo.apparentDip(f.dip, f.dipdir, c.seg.az) : Geo.apparentDipStrike(f.dip, strike, c.seg.az);
          o.side = this.faultSide(f, strike, c.seg.az);
        }
        return o;
      });
      if (!cr.length) return { inside: false, crosses: [] };
      return { inside: true, crosses: cr, s: cr[0].s, t: 0, ap: cr[0].ap, strike: cr[0].strike };
    }

    if (f.kind === "unit") {
      const ps = f.pts.map((p) => Geo.toSection(fr, p[0], p[1])).filter(Boolean);
      if (!ps.length) return null;
      const s0 = Math.min(...ps.map((p) => p.s));
      const s1 = Math.max(...ps.map((p) => p.s));
      const inside = s1 > 0 && s0 < fr.L;
      return { s0: clamp(s0, 0, fr.L), s1: clamp(s1, 0, fr.L), inside };
    }
    return null;
  },

  /** +1 si la falla mantea hacia B, −1 hacia A.
   *  Con dirección de manteo conocida se usa; las importadas siguen la regla de
   *  la mano derecha (mantea a la derecha del sentido de digitalización);
   *  las dibujadas a mano conservan el criterio de la v1 (normal → B). */
  faultSide(f, strike, az) {
    let dd = f.dipdir;
    if (dd == null && f.dipHint != null) dd = nearestDir(strike, f.dipHint);
    if (dd == null && f.layer) dd = (strike + 90) % 360;
    if (dd != null) return Math.cos((dd - az) * Math.PI / 180) >= 0 ? 1 : -1;
    return f.tipo === "normal" ? 1 : -1;
  },

  /** punto de la traza a s metros de A */
  latlngAt(s) { return Geo.atS(View.frame, s); },

  /** unidad (la de más arriba en el orden de dibujo) que contiene un punto */
  unitAt(lat, lng, units) {
    for (let k = units.length - 1; k >= 0; k--) {
      const f = units[k];
      const b = f.bbox;
      if (b && (lat < b[0] || lat > b[2] || lng < b[1] || lng > b[3])) continue;
      const rings = f.rings || [f.pts];
      if (!pip(lat, lng, rings[0])) continue;
      let hole = false;
      for (let r = 1; r < rings.length; r++) if (pip(lat, lng, rings[r])) { hole = true; break; }
      if (!hole) return f;
    }
    return null;
  },

  /** geología en superficie a lo largo de la traza (con caché) */
  surface() {
    const fr = View.frame, p = State.profile;
    if (!fr || !p) return { runs: [], contacts: [] };
    const key = `${State.rev}|${fr.pts.join(";")}|${p.d.length}`;
    if (this._surf && this._surf.key === key) return this._surf;

    // solo las unidades cuyo recuadro toca el de la traza
    const tb = bboxOf(fr.pts);
    const la0 = tb[0], la1 = tb[2], lo0 = tb[1], lo1 = tb[3];
    const units = State.allFeats().filter((f) => {
      if (f.kind !== "unit") return false;
      const b = f.bbox || (f.bbox = bboxOf(f.pts));
      return !(b[2] < la0 || b[0] > la1 || b[3] < lo0 || b[1] > lo1);
    });

    const runs = [], contacts = [];
    if (units.length) {
      const n = clamp(Math.round(fr.L / 20), 60, 1500);
      const at = (s) => { const ll = this.latlngAt(s); return this.unitAt(ll[0], ll[1], units); };
      let prev = at(0), prevS = 0, start = 0;
      for (let i = 1; i <= n; i++) {
        const s = fr.L * i / n;
        const cur = at(s);
        if (cur !== prev) {
          // bisección del borde: precisión < 1 m
          let lo = prevS, hi = s;
          for (let k = 0; k < 14 && hi - lo > 0.5; k++) {
            const mid = (lo + hi) / 2;
            if (at(mid) === prev) lo = mid; else hi = mid;
          }
          const sb = (lo + hi) / 2;
          if (prev) runs.push({ s0: start, s1: sb, f: prev });
          if (prev && cur && prev.nombre !== cur.nombre) contacts.push({ s: sb, a: prev.nombre, b: cur.nombre });
          start = sb; prev = cur;
        }
        prevS = s;
      }
      if (prev) runs.push({ s0: start, s1: fr.L, f: prev });
    }
    // une tramos contiguos de la misma unidad (polígonos partidos)
    const merged = [];
    for (const r of runs) {
      const m = merged[merged.length - 1];
      if (m && m.f.nombre === r.f.nombre && Math.abs(m.s1 - r.s0) < 1) m.s1 = r.s1;
      else merged.push({ ...r });
    }
    this._surf = { key, runs: merged, contacts };
    return this._surf;
  },

  /** intersecciones de la sección, para tabla y exportación */
  intersections() {
    if (!View.frame) return [];
    const out = [];
    for (const f of State.allFeats()) {
      if (!LINE_KINDS.has(f.kind)) continue;
      const pr = this.project(f);
      if (!pr || !pr.crosses) continue;
      for (const c of pr.crosses) {
        out.push({
          s: c.s, z: this.zAt(c.s), az_tramo: Math.round(c.az), kind: f.kind, tipo: f.tipo || null,
          inferida: !!f.inferida, nombre: f.label || f.nombre || "",
          rumbo: c.strike, manteo: f.dip ?? null, manteo_aparente: c.ap ?? null,
          mantea_hacia: c.side == null ? null : c.side > 0 ? "B" : "A",
          capa: f.layer || null,
        });
      }
    }
    for (const c of this.surface().contacts) {
      out.push({ s: c.s, z: this.zAt(c.s), kind: "contacto_unidades", tipo: null, nombre: `${c.a} | ${c.b}` });
    }
    return out.sort((a, b) => a.s - b.s);
  },

  /** cota del terreno en s (m, desde A) */
  zAt(s) {
    const p = State.profile;
    if (!p) return null;
    const km = s / 1000;
    const d = p.d, z = p.z;
    if (km <= d[0]) return z[0];
    if (km >= d[d.length - 1]) return z[z.length - 1];
    let lo = 0, hi = d.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (d[mid] <= km) lo = mid; else hi = mid;
    }
    if (z[lo] == null || z[hi] == null) return z[lo] ?? z[hi];
    const u = (km - d[lo]) / (d[hi] - d[lo] || 1);
    return z[lo] + (z[hi] - z[lo]) * u;
  },

  draw() {
    const cv = $("pf");
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = cv.clientWidth, H = cv.clientHeight;
    if (W < 40 || H < 40) return;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const c = cv.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    c.font = "10px 'Segoe UI', system-ui, sans-serif";

    const p = State.profile;
    if (!p || !State.trace || !View.frame) {
      c.fillStyle = "#5d6874";
      c.textAlign = "left";
      c.fillText("Sección: marca la traza con dos clics para ver el perfil y los datos proyectados.", 14, 20);
      this.geom = null;
      return;
    }

    const padL = 62, padR = 16, padT = 24, padB = 26;
    const x0 = padL, x1 = W - padR, y0 = padT, y1 = H - padB;
    const dmax = Math.max(0.001, p.d[p.d.length - 1]);
    const vmin = p.vmin, vmax = p.vmax;
    const zr = Math.max(200, vmax - vmin);
    // profundidad bajo el relieve (para construir): preferencia «depth» en metros
    const vlo = vmin - zr * 0.08 - (Number(State.prefs.depth) || 0), vhi = vmax + zr * 0.10;

    const X = (s) => x0 + (s / (dmax * 1000)) * (x1 - x0);

    // exageración vertical
    const vx = (x1 - x0) / dmax;                 // px por km
    const spanM = vhi - vlo;
    const avail = y1 - y0;
    const veWant = parseFloat(State.prefs.ve) || 0;
    const veMax = (avail * 1000) / (spanM * vx);
    const ve = veWant === 0 ? veMax : Math.min(veWant, veMax);
    const pxPerM = (vx * ve) / 1000;
    const vmid = (vlo + vhi) / 2, ymid = (y0 + y1) / 2;
    const Y = (z) => ymid - (z - vmid) * pxPerM;

    this.geom = { x0, x1, y0, y1, X, Y, ve, pxPerM, xToS: (px) => (px - x0) / (x1 - x0) * dmax * 1000, yToZ: (py) => vmid + (ymid - py) / pxPerM, dmax, vlo, vhi };
    const fr = View.frame;
    const all = fr ? State.allFeats() : [];

    // ---- rejilla ----
    c.strokeStyle = "#242b35"; c.lineWidth = 1;
    const span = vhi - vlo;
    const step = span > 12000 ? 2000 : span > 5000 ? 1000 : span > 2000 ? 500 : span > 800 ? 250 : 100;
    for (let z = Math.ceil(vlo / step) * step; z <= vhi; z += step) {
      c.beginPath(); c.moveTo(x0, Y(z)); c.lineTo(x1, Y(z)); c.stroke();
      c.fillStyle = "#6d7784"; c.textAlign = "right";
      c.fillText(fmt(z), x0 - 6, Y(z) + 3);
    }

    // ---- figura de una sección análoga, de fondo ----
    if (typeof Analogs !== "undefined" && Analogs) Analogs.drawBg(c, this.geom);

    // ---- techo topográfico ----
    const path = new Path2D();
    let started = false;
    for (let i = 0; i < p.d.length; i++) {
      if (p.z[i] == null) continue;
      const px = X(p.d[i] * 1000), py = Y(p.z[i]);
      if (!started) { path.moveTo(px, py); started = true; } else path.lineTo(px, py);
    }
    if (!started) { c.fillStyle = "#5d6874"; c.fillText("Sin datos de DEM en la traza.", x0 + 6, y0 + 14); return; }

    const fill = new Path2D(path);
    fill.lineTo(X(p.d[p.d.length - 1] * 1000), y1);
    fill.lineTo(X(p.d[0] * 1000), y1);
    fill.closePath();
    const g = c.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, "rgba(232,163,61,0.30)");
    g.addColorStop(1, "rgba(232,163,61,0.04)");
    c.fillStyle = g; c.fill(fill);
    c.save();
    c.beginPath(); c.rect(x0, y0, x1 - x0, y1 - y0); c.clip();

    // ---- interpretación: rellenos de unidades entre horizontes ----
    SecEdit.drawFills(c, this.geom);

    // ---- geología en superficie: banda bajo el techo ----
    const BAND = 11;
    const surf = this.surface();
    const topAt = (s) => { const z = this.zAt(s); return z == null ? null : Y(z); };
    for (const r of surf.runs) {
      const xa = X(r.s0), xb = X(r.s1);
      if (xb - xa < 0.3) continue;
      c.fillStyle = r.f.color || "#9c8ac9";
      c.globalAlpha = 0.8;
      c.beginPath();
      const nseg = Math.max(2, Math.ceil((xb - xa) / 4));
      const top = [];
      for (let k = 0; k <= nseg; k++) {
        const s = r.s0 + (r.s1 - r.s0) * k / nseg;
        const y = topAt(s);
        if (y != null) top.push([X(s), y]);
      }
      if (top.length < 2) { c.globalAlpha = 1; continue; }
      c.moveTo(top[0][0], top[0][1]);
      for (const q of top) c.lineTo(q[0], q[1]);
      for (let k = top.length - 1; k >= 0; k--) c.lineTo(top[k][0], top[k][1] + BAND);
      c.closePath(); c.fill();
      c.globalAlpha = 1;
      if (xb - xa > 34) {
        c.fillStyle = "#e6ebf1"; c.textAlign = "center";
        const ym = Math.min(...top.map((q) => q[1]));
        c.fillText(String(r.f.nombre).slice(0, 18), (xa + xb) / 2, ym + BAND + 11);
      }
    }
    // contactos derivados de los bordes de unidades
    for (const k of surf.contacts) {
      const y = topAt(k.s);
      if (y == null) continue;
      const xa = X(k.s);
      c.strokeStyle = "#0d1117"; c.lineWidth = 3;
      c.beginPath(); c.moveTo(xa, y - 5); c.lineTo(xa, y + BAND + 3); c.stroke();
      c.strokeStyle = "#eef2f6"; c.lineWidth = 1.2;
      c.beginPath(); c.moveTo(xa, y - 5); c.lineTo(xa, y + BAND + 3); c.stroke();
    }

    // ---- líneas cortadas por la traza ----
    for (const f of all) {
      if (!LINE_KINDS.has(f.kind)) continue;
      const pr = this.project(f);
      if (!pr || !pr.crosses) continue;
      for (const cr of pr.crosses) {
        const zs = this.zAt(cr.s);
        if (zs == null) continue;
        const xa = X(cr.s), ya = Y(zs);

        if (f.kind === "fault") {
          // la falla nace en la superficie y mantea al ángulo aparente,
          // dibujado con la misma exageración vertical que el perfil
          const ang = (cr.ap || 0) * Math.PI / 180;
          const depthPx = y1 - ya;
          const dxPx = Math.tan(ang) > 1e-3 ? (depthPx / ve) / Math.tan(ang) : 0;
          const xb = xa + dxPx * cr.side, yb = y1;
          c.strokeStyle = FAULT_COLOR[f.tipo] || "#d94f4f";
          c.lineWidth = 2.2;
          c.setLineDash(f.inferida ? [6, 4] : []);
          c.beginPath(); c.moveTo(xa, ya); c.lineTo(xb, yb); c.stroke();
          c.setLineDash([]);
          c.fillStyle = c.strokeStyle;
          c.textAlign = "left";
          c.fillText(`F${f.tipo === "inversa" ? "i" : f.tipo === "normal" ? "n" : ""} ${fmt(cr.ap, 0)}°`, xa + 3, ya - 4);
        } else if (f.kind === "axis") {
          const anti = /anticl/.test(f.tipo), sin = /sincl/.test(f.tipo);
          const col = sin ? "#7fd0e8" : anti ? "#e58ad6" : "#d8b4f0";
          c.strokeStyle = "#0d1117"; c.lineWidth = 4;
          axisGlyph(c, xa, ya - 9, anti, sin); c.stroke();
          c.strokeStyle = col; c.lineWidth = 2;
          axisGlyph(c, xa, ya - 9, anti, sin); c.stroke();
          c.fillStyle = col; c.textAlign = "center";
          c.fillText(anti ? "A" : sin ? "S" : "ax", xa, ya - 20);
        } else if (f.kind === "cline" && f.dip != null && f.dipdir != null) {
          // contacto con plano ajustado: tramo a su manteo aparente, hacia su lado
          const ap = Geo.apparentDip(f.dip, f.dipdir, cr.az);
          const sd = Math.cos((f.dipdir - cr.az) * Math.PI / 180) >= 0 ? 1 : -1;
          const ph = Math.atan(ve * Math.tan(ap * Math.PI / 180)), LL = 46;
          c.strokeStyle = "#eef2f6"; c.lineWidth = 1.6; c.setLineDash([4, 3]);
          c.beginPath(); c.moveTo(xa, ya); c.lineTo(xa + sd * LL * Math.cos(ph), ya + LL * Math.sin(ph)); c.stroke();
          c.setLineDash([]);
          c.fillStyle = "#eef2f6"; c.textAlign = "left"; c.fillText(`${fmt(ap)}°`, xa + 3, ya - 4);
        } else {
          // contacto o lineamiento: marca vertical en la superficie
          const col = f.kind === "lineament" ? "#9fb4c8" : "#eef2f6";
          c.strokeStyle = "#0d1117"; c.lineWidth = 3.5;
          c.beginPath(); c.moveTo(xa, ya - 7); c.lineTo(xa, ya + 7); c.stroke();
          c.strokeStyle = col; c.lineWidth = 1.8;
          c.setLineDash(f.inferida ? [3, 2] : []);
          c.beginPath(); c.moveTo(xa, ya - 7); c.lineTo(xa, ya + 7); c.stroke();
          c.setLineDash([]);
        }
      }
    }

    // ---- contactos (puntos) ----
    for (const f of all) {
      if (f.kind !== "contact") continue;
      const pr = this.project(f);
      if (!pr || !pr.inside) continue;
      const zs = pr.z != null ? pr.z : this.zAt(pr.s);
      if (zs == null) continue;
      const xa = X(pr.s), ya = Y(zs);
      c.strokeStyle = "#0d1117"; c.lineWidth = 3.5;
      c.beginPath(); c.moveTo(xa, ya - 7); c.lineTo(xa, ya + 7); c.stroke();
      c.strokeStyle = f.color || "#c9d3dd"; c.lineWidth = 2;
      c.beginPath(); c.moveTo(xa, ya - 7); c.lineTo(xa, ya + 7); c.stroke();
      c.fillStyle = f.color || "#c9d3dd";
      c.beginPath(); c.arc(xa, ya, 2.6, 0, 7); c.fill();
    }

    // ---- manteos: ángulo aparente, coherente con la exageración ----
    for (const f of all) {
      if (f.kind !== "dip") continue;
      const pr = this.project(f);
      if (!pr || !pr.inside) continue;
      const zs = pr.z != null ? pr.z : this.zAt(pr.s);
      if (zs == null) continue;
      const xa = X(pr.s), ya = Y(zs);
      // ángulo en pantalla con VE: atan(VE·tan δap); hacia dónde mantea en la sección
      const side = Math.cos((f.dir - pr.seg.az) * Math.PI / 180) >= 0 ? 1 : -1;
      const a = Math.atan(ve * Math.tan(Math.abs(pr.ap) * Math.PI / 180));
      const L = 20;
      const dx = L * Math.cos(a) * side, dy = L * Math.sin(a);
      c.strokeStyle = "#7fe0c0"; c.lineWidth = 2;
      c.beginPath();
      c.moveTo(xa - dx * 0.5, ya - dy * 0.5);
      c.lineTo(xa + dx, ya + dy);
      c.stroke();
      c.fillStyle = "#dff7ee";
      c.textAlign = "left";
      c.fillText(`${fmt(Math.abs(pr.ap), 0)}°`, xa + 4, ya - 4);
      // abanico de incertidumbre: manteo y dirección ± error → rango de manteos aparentes
      const err = Number(State.prefs.dipErr) || 0;
      if (err > 0) {
        const az = pr.seg.az, R = Math.PI / 180;
        const sig = (dp, dd) => Math.atan(Math.tan(clamp(dp, 0, 89.9) * R) * Math.cos((dd - az) * R));
        const v = [];
        for (const a1 of [-err, err]) for (const a2 of [-err, 0, err]) v.push(sig(f.dip + a1, f.dir + a2));
        const LL = 70;
        c.strokeStyle = "rgba(127,224,192,.45)"; c.lineWidth = 1;
        for (const th of [Math.min(...v), Math.max(...v)]) {
          const ph = Math.atan(ve * Math.tan(Math.abs(th))), sg = th >= 0 ? 1 : -1;
          c.beginPath(); c.moveTo(xa, ya); c.lineTo(xa + sg * LL * Math.cos(ph), ya + LL * Math.sin(ph)); c.stroke();
        }
      }
    }

    // ---- interpretación: horizontes, fallas y guías de la sección ----
    SecEdit.drawLines(c, this.geom, fill);

    // ---- estaciones ----
    for (const f of all) {
      if (f.kind !== "station") continue;
      const pr = this.project(f);
      if (!pr || !pr.inside) continue;
      const zs = pr.z != null ? pr.z : this.zAt(pr.s);
      if (zs == null) continue;
      const xa = X(pr.s), ya = Y(zs);
      c.fillStyle = "#e8c15a";
      c.strokeStyle = "#14181e"; c.lineWidth = 1.6;
      c.beginPath(); c.arc(xa, ya, 4.6, 0, 7); c.fill(); c.stroke();
      c.fillStyle = "#161a20"; c.textAlign = "center";
      c.font = "700 8px 'Segoe UI'";
      c.fillText(String(f.n).slice(0, 3), xa, ya + 2.8);
      c.font = "10px 'Segoe UI'";
    }

    // ---- quiebres de la traza: línea vertical y azimut de cada tramo ----
    c.font = "9.5px 'Segoe UI', system-ui, sans-serif";
    for (let i = 0; i < fr.segs.length; i++) {
      const sg = fr.segs[i];
      const xa = X(sg.s0), xb = X(sg.s0 + sg.len);
      if (i > 0) {
        c.strokeStyle = "rgba(232,163,61,.55)"; c.lineWidth = 1; c.setLineDash([2, 3]);
        c.beginPath(); c.moveTo(xa, y0); c.lineTo(xa, y1); c.stroke(); c.setLineDash([]);
      }
      if (fr.bent && xb - xa > 40) {
        c.fillStyle = "#c79a52"; c.textAlign = "center";
        c.fillText(`${fmt(sg.az)}°`, (xa + xb) / 2, y0 + 10);
      }
    }
    // ---- amarres con otras secciones ----
    for (const t of Projection.ties(fr)) {
      const xa = X(t.s);
      c.strokeStyle = "rgba(143,182,230,.85)"; c.lineWidth = 1.2; c.setLineDash([5, 3]);
      c.beginPath(); c.moveTo(xa, y0 + 14); c.lineTo(xa, y1); c.stroke(); c.setLineDash([]);
      c.fillStyle = "#8fb6e6"; c.textAlign = "center";
      c.fillText(t.name, xa, y0 + 24);
    }
    c.font = "10px 'Segoe UI', system-ui, sans-serif";

    c.restore();

    // ---- contorno del techo ----
    c.strokeStyle = "#e8a33d"; c.lineWidth = 1.8; c.stroke(path);

    // ---- ejes ----
    c.strokeStyle = "#2b333e";
    c.beginPath(); c.moveTo(x0, y1); c.lineTo(x1, y1); c.stroke();
    c.fillStyle = "#6d7784"; c.textAlign = "center";
    const kstep = dmax > 40 ? 10 : dmax > 15 ? 5 : 1;
    for (let d = 0; d <= dmax + 1e-9; d += kstep) c.fillText(fmt(d), X(d * 1000), y1 + 14);
    c.textAlign = "left";
    c.fillStyle = "#5d6874";
    c.fillText(`km a lo largo de la traza · A → B   (corredor ±${fmt(State.prefs.corr)} m)`, x0 + 4, y1 + 14);

    // ---- encabezado ----
    c.fillStyle = "#5d6874"; c.textAlign = "left";
    const sec = State.active();
    const proj = { perp: "", strike: " · proyección por rumbo", plunge: ` · proyección por eje ${fmt(State.prefs.trend)}°/${fmt(State.prefs.plunge)}°` }[State.prefs.proj] || "";
    c.fillText(`Sección ${sec ? sec.name : "A–B"} · ${fr.bent ? `quebrada (${fr.segs.length} tramos)` : `az ${fmt(fr.az)}°`} · VE ${ve.toFixed(1)}× · ${p.fuente || "DEM 30 m"}${proj}`, 12, 14);
    c.textAlign = "right";
    c.fillStyle = "#8d98a5";
    const nIn = this.countInside();
    c.fillText(`${nIn} datos en sección`, x1, 14);
  },

  countInside() {
    if (!View.frame) return 0;
    let n = 0;
    for (const f of State.allFeats()) {
      if (f.kind === "unit") continue;          // las unidades cuentan como contactos derivados
      const p = this.project(f);
      if (!p || !p.inside) continue;
      n += p.crosses ? p.crosses.length : 1;
    }
    return n + this.surface().contacts.length;
  },
};

/** punto dentro de un anillo [[lat,lng]…] (par-impar) */
function pip(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][0], xi = ring[i][1], yj = ring[j][0], xj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** símbolo de eje en sección: ∩ anticlinal, ∪ sinclinal, | sin tipo */
function axisGlyph(c, x, y, anti, sin) {
  c.beginPath();
  if (anti) { c.moveTo(x - 6, y + 5); c.quadraticCurveTo(x, y - 7, x + 6, y + 5); }
  else if (sin) { c.moveTo(x - 6, y - 5); c.quadraticCurveTo(x, y + 7, x + 6, y - 5); }
  else { c.moveTo(x, y - 6); c.lineTo(x, y + 6); }
}
