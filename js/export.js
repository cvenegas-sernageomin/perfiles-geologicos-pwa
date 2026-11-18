"use strict";
/* =============================================================================
   export.js — salidas de la sección
   -----------------------------------------------------------------------------
   Sheet   lámina vectorial en SVG (milímetros reales: imprime a escala).
           Capas con nombre (inkscape:groupmode="layer") para Illustrator/Inkscape.
   Out     PNG por dpi, PDF por impresión, KMZ 3D, SHP 3D (PolyLineZ), GeoJSON,
           CSV y DXF; proyecto .json para guardar y volver a abrir.
   ========================================================================== */
const n2 = (v) => (Math.round(v * 100) / 100).toString();
const xesc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const PAGES = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594] };
const NICE_SCALES = [5000, 10000, 20000, 25000, 50000, 100000, 200000, 250000, 500000, 1000000];
const CARD16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO"];
const cardinal = (az) => CARD16[Math.round((((az % 360) + 360) % 360) / 22.5) % 16];

/** bandas de unidades entre horizontes como polígonos en (s, z) */
function unitBands(lines, s1, vlo, ncol = 700) {
  const all = lines.filter((l) => l.kind === "horizon");
  if (!all.some((l) => l.unit)) return [];
  const runs = new Map();   // id → [{top:[], bot:[]}]
  const open = new Map();
  for (let j = 0; j <= ncol; j++) {
    const s = s1 * j / ncol;
    const topo = Profile.zAt(s);
    const zs = topo == null ? [] : all.map((l) => ({ l, z: Construct.zAt(l.pts, s) })).filter((q) => q.z != null).sort((a, b) => b.z - a.z);
    const seen = new Set();
    for (let i = 0; i < zs.length; i++) {
      const l = zs[i].l;
      if (!l.unit) continue;
      const zTop = Math.min(zs[i].z, topo), zBot = i + 1 < zs.length ? zs[i + 1].z : vlo;
      if (zTop <= zBot) continue;
      seen.add(l.id);
      let r = open.get(l.id);
      if (!r) { r = { l, top: [], bot: [] }; open.set(l.id, r); if (!runs.has(l.id)) runs.set(l.id, []); runs.get(l.id).push(r); }
      r.top.push([s, zTop]); r.bot.push([s, zBot]);
    }
    for (const id of [...open.keys()]) if (!seen.has(id)) open.delete(id);
  }
  const out = [];
  for (const rs of runs.values()) for (const r of rs) if (r.top.length > 1) out.push({ unit: r.l.unit, color: r.l.color, poly: r.top.concat(r.bot.reverse()) });
  return out;
}

const Sheet = {
  /** calcula la geometría de la lámina; devuelve {ok, msg, …} */
  layout(o) {
    const fr = View.frame, p = State.profile;
    const [PW, PH] = PAGES[o.page] || PAGES.A3;
    const m = 12, axL = 16, axR = 16, top = 26, bottom = o.legend ? 58 : 20;
    const W = PW - 2 * m - axL - axR, Havail = PH - 2 * m - top - bottom;
    let N = o.scale === "auto" ? NICE_SCALES.find((s) => fr.L * 1000 / s <= W) || NICE_SCALES[NICE_SCALES.length - 1] : Number(o.scale);
    const k = 1000 / N;                         // mm de papel por metro de terreno
    const ve = Number(o.ve) || 1;
    const zr = Math.max(200, p.vmax - p.vmin);
    // el techo es el relieve: lo proyectado por encima (erosionado) se recorta en el marco
    const vhi = p.vmax + zr * 0.12;
    let vlo = p.vmin - zr * 0.05 - (Number(State.prefs.depth) || 0);
    let msg = "";
    const needH = (vhi - vlo) * k * ve;
    if (needH > Havail) {                        // no cabe: se recorta la profundidad
      vlo = vhi - Havail / (k * ve);
      msg = `A esta escala y VE la sección no cabe completa en altura: se muestra hasta ${fmt(vlo)} m.`;
    }
    const secW = fr.L * k, secH = (vhi - vlo) * k * ve;
    if (secW > W + 0.5) msg = `A 1:${fmt(N)} la sección mide ${fmt(secW)} mm y la hoja deja ${fmt(W)} mm: elige otra escala u hoja.`;
    return { PW, PH, m, axL, axR, top, bottom, W, Havail, N, k, ve, vlo, vhi, secW, secH,
      x0: m + axL, y0: m + top, ok: secW <= W + 0.5, msg };
  },

  build(o) {
    const L = this.layout(o);
    const fr = View.frame, p = State.profile, sec = State.active();
    const X = (s) => L.x0 + s * L.k, Y = (z) => L.y0 + (L.vhi - z) * L.k * L.ve;
    const pathOf = (pts) => pts.map((q, i) => `${i ? "L" : "M"}${n2(X(q[0]))},${n2(Y(q[1]))}`).join("");
    const out = [];
    const layer = (id, label, body) => out.push(`<g id="${id}" inkscape:groupmode="layer" inkscape:label="${xesc(label)}">${body}</g>`);
    const x1 = L.x0 + L.secW, y1 = L.y0 + L.secH;
    const font = `font-family="Arial, Helvetica, sans-serif"`;

    // topografía como polígono de recorte y relleno de fondo
    const topoPts = p.d.map((d, i) => [d * 1000, p.z[i]]).filter((q) => q[1] != null);
    const topoPath = pathOf(topoPts);
    const below = `${topoPath}L${n2(X(topoPts[topoPts.length - 1][0]))},${n2(y1)}L${n2(X(topoPts[0][0]))},${n2(y1)}Z`;

    const defs = `<defs><clipPath id="cBox"><rect x="${n2(L.x0)}" y="${n2(L.y0)}" width="${n2(L.secW)}" height="${n2(L.secH)}"/></clipPath>
      <clipPath id="cTopo"><path d="${below}"/></clipPath></defs>`;

    // 1. rellenos de unidades
    const bands = unitBands(SecEdit.lines(), fr.L, L.vlo);
    layer("unidades", "Unidades (relleno)", `<g clip-path="url(#cBox)">${bands.map((b) =>
      `<path d="${pathOf(b.poly)}Z" fill="${b.color || "#9c8ac9"}" fill-opacity="0.55" stroke="none"><title>${xesc(b.unit)}</title></path>`).join("")}</g>`);

    // 2. geología en superficie (franja bajo el relieve, 2,5 mm)
    const surf = Profile.surface();
    const band = 2.5 / (L.k * L.ve);
    const sb = surf.runs.map((r) => {
      const n = Math.max(2, Math.ceil((r.s1 - r.s0) / (fr.L / 400)));
      const top = [];
      for (let i = 0; i <= n; i++) { const s = r.s0 + (r.s1 - r.s0) * i / n; const z = Profile.zAt(s); if (z != null) top.push([s, z]); }
      if (top.length < 2) return "";
      const poly = top.concat(top.slice().reverse().map((q) => [q[0], q[1] - band]));
      return `<path d="${pathOf(poly)}Z" fill="${r.f.color || "#999"}" stroke="none"><title>${xesc(r.f.nombre)}</title></path>`;
    }).join("");
    const sc = surf.contacts.map((c) => { const z = Profile.zAt(c.s); return z == null ? "" : `<line x1="${n2(X(c.s))}" y1="${n2(Y(z) - 1.2)}" x2="${n2(X(c.s))}" y2="${n2(Y(z) + 2.5 + 0.6)}" stroke="#000" stroke-width="0.25"/>`; }).join("");
    layer("superficie", "Geología en superficie", `<g clip-path="url(#cBox)">${sb}${sc}</g>`);

    // 3. horizontes y fallas de la interpretación (erosionado punteado y tenue)
    const lines = SecEdit.lines();
    const ln = (l, solid) => {
      const col = l.kind === "fault" ? "#c62828" : l.kind === "guide" ? "#888" : (l.color || "#444");
      const w = l.kind === "fault" ? 0.5 : l.kind === "guide" ? 0.18 : 0.35;
      return solid
        ? `<path d="${pathOf(l.pts)}" fill="none" stroke="${l.kind === "horizon" ? "#222" : col}" stroke-width="${w}"${l.kind === "guide" ? ' stroke-dasharray="1.5,1"' : ""}><title>${xesc(l.unit || l.name || l.kind)}</title></path>`
        : `<path d="${pathOf(l.pts)}" fill="none" stroke="${col}" stroke-width="0.18" stroke-dasharray="0.8,0.8" opacity="0.6"/>`;
    };
    layer("erosionado", "Proyección sobre el relieve (erosionado)", `<g clip-path="url(#cBox)">${lines.filter((l) => l.kind !== "guide").map((l) => ln(l, false)).join("")}</g>`);
    layer("horizontes", "Horizontes", `<g clip-path="url(#cBox)"><g clip-path="url(#cTopo)">${lines.filter((l) => l.kind !== "fault").map((l) => ln(l, true)).join("")}</g></g>`);
    layer("fallas", "Fallas", `<g clip-path="url(#cBox)"><g clip-path="url(#cTopo)">${lines.filter((l) => l.kind === "fault").map((l) => ln(l, true)).join("")}</g></g>`);

    // 4. datos proyectados: cruces de fallas y ejes, contactos de líneas, manteos
    const sym = [];
    const used = { fault: new Set(), axis: new Set(), dip: false, contact: false };
    for (const f of State.allFeats()) {
      const pr = Profile.project(f);
      if (!pr || !pr.inside) continue;
      if (pr.crosses) {
        for (const cr of pr.crosses) {
          const z = Profile.zAt(cr.s); if (z == null) continue;
          const xa = X(cr.s), ya = Y(z);
          if (f.kind === "fault") {
            used.fault.add(f.tipo);
            const ang = (cr.ap || 0) * Math.PI / 180, dep = y1 - ya;
            const dx = Math.tan(ang) > 1e-3 ? (dep / L.ve) / Math.tan(ang) : 0;
            sym.push(`<line x1="${n2(xa)}" y1="${n2(ya)}" x2="${n2(xa + dx * cr.side)}" y2="${n2(y1)}" stroke="#c62828" stroke-width="0.4"${f.inferida ? ' stroke-dasharray="1.6,1"' : ""}/>`);
          } else if (f.kind === "axis") {
            const a = /anticl/.test(f.tipo), s = /sincl/.test(f.tipo);
            used.axis.add(a ? "anticlinal" : s ? "sinclinal" : "eje");
            sym.push(a ? `<path d="M${n2(xa - 1.8)},${n2(ya - 1.2)}Q${n2(xa)},${n2(ya - 4.6)} ${n2(xa + 1.8)},${n2(ya - 1.2)}" fill="none" stroke="#b03a9a" stroke-width="0.4"/>`
              : s ? `<path d="M${n2(xa - 1.8)},${n2(ya - 4.2)}Q${n2(xa)},${n2(ya - 0.8)} ${n2(xa + 1.8)},${n2(ya - 4.2)}" fill="none" stroke="#2a8db0" stroke-width="0.4"/>`
              : `<line x1="${n2(xa)}" y1="${n2(ya - 4)}" x2="${n2(xa)}" y2="${n2(ya - 1)}" stroke="#7a5ea8" stroke-width="0.4"/>`);
          } else if (f.kind === "cline" && !surf.contacts.some((c) => Math.abs(c.s - cr.s) < 30)) {
            used.contact = true;
            sym.push(`<line x1="${n2(xa)}" y1="${n2(ya - 1.2)}" x2="${n2(xa)}" y2="${n2(ya + 3)}" stroke="#000" stroke-width="0.25"${f.inferida ? ' stroke-dasharray="0.6,0.5"' : ""}/>`);
          }
        }
      } else if (f.kind === "dip") {
        used.dip = true;
        const z = pr.z != null ? pr.z : Profile.zAt(pr.s); if (z == null) continue;
        const xa = X(pr.s), ya = Y(z);
        const side = Math.cos((f.dir - pr.seg.az) * Math.PI / 180) >= 0 ? 1 : -1;
        const a = Math.atan(L.ve * Math.tan(Math.abs(pr.ap) * Math.PI / 180)), LL = 4;
        sym.push(`<line x1="${n2(xa - LL * 0.4 * Math.cos(a) * side)}" y1="${n2(ya - LL * 0.4 * Math.sin(a))}" x2="${n2(xa + LL * Math.cos(a) * side)}" y2="${n2(ya + LL * Math.sin(a))}" stroke="#00796b" stroke-width="0.45"/>`);
        sym.push(`<text x="${n2(xa + 0.8)}" y="${n2(ya - 1)}" font-size="1.9" ${font} fill="#00695c">${fmt(Math.abs(pr.ap))}°</text>`);
      }
    }
    layer("simbolos", "Datos proyectados", `<g clip-path="url(#cBox)">${sym.join("")}</g>`);

    // 5. topografía, quiebres, amarres
    const bends = fr.segs.slice(1).map((g) => `<line x1="${n2(X(g.s0))}" y1="${n2(L.y0)}" x2="${n2(X(g.s0))}" y2="${n2(y1)}" stroke="#b58a3a" stroke-width="0.2" stroke-dasharray="1,1"/>`).join("");
    const ties = Projection.ties(fr).map((t) => `<line x1="${n2(X(t.s))}" y1="${n2(L.y0 + 4)}" x2="${n2(X(t.s))}" y2="${n2(y1)}" stroke="#3b6ea5" stroke-width="0.25" stroke-dasharray="2,1"/>
      <text x="${n2(X(t.s))}" y="${n2(L.y0 + 3.2)}" font-size="2.2" ${font} text-anchor="middle" fill="#3b6ea5">${xesc(t.name)}</text>`).join("");
    layer("topografia", "Topografía", `<path d="${topoPath}" fill="none" stroke="#000" stroke-width="0.45"/>${bends}${ties}`);

    // 6. marco, ejes y rótulos
    const ax = [];
    ax.push(`<rect x="${n2(L.x0)}" y="${n2(L.y0)}" width="${n2(L.secW)}" height="${n2(L.secH)}" fill="none" stroke="#000" stroke-width="0.3"/>`);
    const span = L.vhi - L.vlo;
    const zs = span > 12000 ? 2000 : span > 5000 ? 1000 : span > 2000 ? 500 : span > 800 ? 250 : 100;
    for (let z = Math.ceil(L.vlo / zs) * zs; z <= L.vhi; z += zs) {
      const y = Y(z);
      ax.push(`<line x1="${n2(L.x0 - 1.5)}" y1="${n2(y)}" x2="${n2(L.x0)}" y2="${n2(y)}" stroke="#000" stroke-width="0.25"/><line x1="${n2(x1)}" y1="${n2(y)}" x2="${n2(x1 + 1.5)}" y2="${n2(y)}" stroke="#000" stroke-width="0.25"/>`);
      ax.push(`<text x="${n2(L.x0 - 2.2)}" y="${n2(y + 0.8)}" font-size="2.3" ${font} text-anchor="end">${z}</text><text x="${n2(x1 + 2.2)}" y="${n2(y + 0.8)}" font-size="2.3" ${font}>${z}</text>`);
    }
    ax.push(`<text transform="translate(${n2(L.m + 3)},${n2(L.y0 + L.secH / 2)}) rotate(-90)" font-size="2.4" ${font} text-anchor="middle">m s.n.m.</text>`);
    const km = fr.L > 40000 ? 10 : fr.L > 15000 ? 5 : fr.L > 4000 ? 1 : 0.5;
    for (let d = 0; d * 1000 <= fr.L + 1; d += km) {
      ax.push(`<line x1="${n2(X(d * 1000))}" y1="${n2(y1)}" x2="${n2(X(d * 1000))}" y2="${n2(y1 + 1.5)}" stroke="#000" stroke-width="0.25"/><text x="${n2(X(d * 1000))}" y="${n2(y1 + 4)}" font-size="2.3" ${font} text-anchor="middle">${fmt(d, km < 1 ? 1 : 0)}</text>`);
    }
    ax.push(`<text x="${n2(x1)}" y="${n2(y1 + 7)}" font-size="2.3" ${font} text-anchor="end">km a lo largo de la traza</text>`);
    const nm = (sec ? sec.name : "A–A'").split("–");
    const azA = fr.segs[0].az + 180, azB = fr.segs[fr.segs.length - 1].az;
    ax.push(`<text x="${n2(L.x0)}" y="${n2(L.y0 - 2)}" font-size="4.2" font-weight="bold" ${font}>${xesc(nm[0] || "A")}</text>
      <text x="${n2(L.x0 + 6)}" y="${n2(L.y0 - 2)}" font-size="2.6" ${font}>${cardinal(azA)}</text>
      <text x="${n2(x1)}" y="${n2(L.y0 - 2)}" font-size="4.2" font-weight="bold" ${font} text-anchor="end">${xesc(nm[1] || "A'")}</text>
      <text x="${n2(x1 - 7)}" y="${n2(L.y0 - 2)}" font-size="2.6" ${font} text-anchor="end">${cardinal(azB)}</text>`);
    layer("marco", "Marco y ejes", ax.join(""));

    // 7. título
    const tp = Geo.tracePts(State.trace), ua = Geo.utm(tp[0][0], tp[0][1]), ub = Geo.utm(tp[tp.length - 1][0], tp[tp.length - 1][1]);
    const title = [`<text x="${n2(L.m)}" y="${n2(L.m + 6)}" font-size="6" font-weight="bold" ${font}>${xesc(o.title || "Sección geológica " + (sec ? sec.name : ""))}</text>`,
      `<text x="${n2(L.m)}" y="${n2(L.m + 11.5)}" font-size="2.8" ${font}>Escala horizontal 1:${fmt(L.N)} · exageración vertical ${fmt(L.ve, 1)}× (escala vertical 1:${fmt(L.N / L.ve)}) · largo ${fmt(fr.L / 1000, 2)} km${fr.bent ? ` · traza quebrada (${fr.segs.length} tramos)` : ` · azimut ${fmt(fr.az)}°`}</text>`,
      `<text x="${n2(L.m)}" y="${n2(L.m + 16)}" font-size="2.4" ${font} fill="#444">${xesc(nm[0] || "A")}: ${fmt(ua.e)} E ${fmt(ua.n)} N · ${xesc(nm[1] || "A'")}: ${fmt(ub.e)} E ${fmt(ub.n)} N · UTM ${ua.zone}${ua.hemi} WGS84${o.author ? " · " + xesc(o.author) : ""}</text>`];
    layer("titulo", "Título", title.join(""));

    // 8. pie: escalas, leyenda, ubicación, créditos
    if (o.legend) {
      const fy = L.PH - L.m - L.bottom + 12;
      const foot = [];
      // escala gráfica horizontal
      const barM = [100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000].reverse().find((b) => b * L.k <= 50) || 100;
      const bw = barM * L.k;
      foot.push(`<g transform="translate(${n2(L.m)},${n2(fy)})"><text y="-2" font-size="2.4" ${font}>Escala gráfica</text>`);
      for (let i = 0; i < 4; i++) foot.push(`<rect x="${n2(i * bw / 4)}" y="0" width="${n2(bw / 4)}" height="1.4" fill="${i % 2 ? "#fff" : "#000"}" stroke="#000" stroke-width="0.2"/>`);
      foot.push(`<text x="0" y="4.5" font-size="2.2" ${font}>0</text><text x="${n2(bw)}" y="4.5" font-size="2.2" ${font} text-anchor="middle">${barM >= 1000 ? fmt(barM / 1000) + " km" : barM + " m"}</text>`);
      const vb = barM * L.k * L.ve;
      foot.push(`<line x1="${n2(bw + 12)}" y1="${n2(1.4)}" x2="${n2(bw + 12)}" y2="${n2(1.4 - Math.min(vb, 20))}" stroke="#000" stroke-width="0.4"/>
        <text x="${n2(bw + 13.5)}" y="0" font-size="2.2" ${font}>${vb <= 20 ? (barM >= 1000 ? fmt(barM / 1000) + " km" : barM + " m") : fmt(20 / (L.k * L.ve)) + " m"} (vertical)</text></g>`);
      // leyenda
      const units = new Map();
      for (const r of surf.runs) units.set(r.f.nombre, r.f.color);
      for (const b of bands) units.set(b.unit, b.color);
      let lx = L.m + 78, ly = fy - 4;
      foot.push(`<text x="${n2(lx)}" y="${n2(ly - 2)}" font-size="2.6" font-weight="bold" ${font}>Leyenda</text>`);
      let i = 0;
      const colW = 38;
      const item = (sw, label) => {
        const cx = lx + Math.floor(i / 8) * colW, cy = ly + (i % 8) * 4.6;
        foot.push(`<g transform="translate(${n2(cx)},${n2(cy)})">${sw}<text x="7" y="2.3" font-size="2.2" ${font}>${xesc(label)}</text></g>`);
        i++;
      };
      for (const [u, c] of units) item(`<rect width="5" height="3" fill="${c || "#999"}" fill-opacity="0.8" stroke="#000" stroke-width="0.15"/>`, u);
      for (const t of used.fault) item(`<line x1="0" y1="1.5" x2="5" y2="1.5" stroke="#c62828" stroke-width="0.5"/>`, `Falla ${t}`);
      if (used.axis.has("anticlinal")) item(`<path d="M0.5,2.6Q2.5,-1 4.5,2.6" fill="none" stroke="#b03a9a" stroke-width="0.4"/>`, "Eje anticlinal");
      if (used.axis.has("sinclinal")) item(`<path d="M0.5,0.4Q2.5,4 4.5,0.4" fill="none" stroke="#2a8db0" stroke-width="0.4"/>`, "Eje sinclinal");
      if (used.dip) item(`<line x1="0.5" y1="0.5" x2="4.5" y2="2.5" stroke="#00796b" stroke-width="0.45"/>`, "Manteo aparente");
      if (lines.some((l) => l.kind === "horizon")) item(`<line x1="0" y1="1.5" x2="5" y2="1.5" stroke="#222" stroke-width="0.35"/>`, "Horizonte interpretado");
      item(`<line x1="0" y1="1.5" x2="5" y2="1.5" stroke="#555" stroke-width="0.18" stroke-dasharray="0.8,0.8"/>`, "Proyección erosionada");
      if (Projection.ties(fr).length) item(`<line x1="2.5" y1="0" x2="2.5" y2="3" stroke="#3b6ea5" stroke-width="0.25" stroke-dasharray="1,0.6"/>`, "Cruce con otra sección");
      // mapa de ubicación
      foot.push(this.inset(L.PW - L.m - 62, fy - 6, 62, 42));
      // créditos
      const fuentes = State.layers.filter((l) => l.visible).map((l) => l.name).join(", ");
      foot.push(`<text x="${n2(L.m)}" y="${n2(L.PH - L.m + 1)}" font-size="1.9" ${font} fill="#555">Topografía: ${xesc(p.fuente || "DEM Terrarium")} (AWS Terrain Tiles / Mapzen). Datos: ${xesc(fuentes || "digitalizados")}. Proyección ${
        { perp: "perpendicular", strike: "por rumbo", plunge: `por eje ${State.prefs.trend}°/${State.prefs.plunge}°` }[State.prefs.proj] || ""}, corredor ±${fmt(State.prefs.corr)} m. ${new Date().toLocaleDateString("es-CL")}. Perfiles geológicos (PWA).</text>`);
      layer("pie", "Escala, leyenda y ubicación", foot.join(""));
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${L.PW}mm" height="${L.PH}mm" viewBox="0 0 ${L.PW} ${L.PH}">
<rect width="${L.PW}" height="${L.PH}" fill="#fff"/>${defs}
${out.join("\n")}
</svg>`;
  },

  /** mapa de ubicación vectorial: unidades, fallas y trazas de todas las secciones */
  inset(x, y, w, h) {
    const traces = State.sections.filter((s) => s.trace).map((s) => ({ s, pts: Geo.tracePts(s.trace) }));
    // centrado en la sección activa, con el triple de su extensión (las demás se ven si caen dentro)
    const b = bboxOf(Geo.tracePts(State.trace));
    const cl = (b[0] + b[2]) / 2, mx = Math.cos(cl * Math.PI / 180);
    let dLat = Math.max((b[2] - b[0]) * 3, 0.03), dLng = Math.max((b[3] - b[1]) * 3, 0.03 / mx);
    // misma escala en x e y (equirectangular)
    const sc = Math.min(w / (dLng * mx), h / dLat);
    dLng = w / sc / mx; dLat = h / sc;
    const lat1 = cl + dLat / 2, lng0 = (b[1] + b[3]) / 2 - dLng / 2;
    const P = (q) => `${n2(x + (q[1] - lng0) * mx * sc)},${n2(y + (lat1 - q[0]) * sc)}`;
    const inBox = (bb) => !(bb[2] < lat1 - dLat || bb[0] > lat1 || bb[3] < lng0 || bb[1] > lng0 + dLng);
    const tol = 0.25 / sc;   // simplificación: ~0,25 mm
    const simp = (pts) => pts.filter((q, i) => i === 0 || i === pts.length - 1 || Math.abs(q[0] - pts[i - 1][0]) + Math.abs(q[1] - pts[i - 1][1]) > tol);
    const body = [];
    for (const f of State.allFeats()) {
      if (f.kind === "unit") {
        const bb = f.bbox || bboxOf(f.pts);
        if (!inBox(bb)) continue;
        body.push(`<path d="M${simp(f.pts).map(P).join("L")}Z" fill="${f.color}" fill-opacity="0.6" stroke="none"/>`);
      }
    }
    for (const f of State.allFeats()) {
      if (f.kind !== "fault" || !f.pts) continue;
      if (!inBox(f.bbox || bboxOf(f.pts))) continue;
      body.push(`<path d="M${simp(f.pts).map(P).join("L")}" fill="none" stroke="#c62828" stroke-width="0.25"/>`);
    }
    for (const t of traces) {
      const act = t.s.id === State.secId;
      body.push(`<path d="M${t.pts.map(P).join("L")}" fill="none" stroke="${act ? "#000" : "#3b6ea5"}" stroke-width="${act ? 0.6 : 0.4}"/>`);
      const p0 = P(t.pts[0]).split(",");
      body.push(`<text x="${p0[0]}" y="${n2(Number(p0[1]) - 1)}" font-size="2" font-family="Arial" fill="${act ? "#000" : "#3b6ea5"}">${xesc(t.s.name.split("–")[0])}</text>`);
    }
    // norte y escala
    const kmMm = 1000 / 110540 * sc;
    const bar = [0.5, 1, 2, 5, 10, 20].find((k) => k * kmMm > w / 5) || 1;
    return `<g><text x="${n2(x)}" y="${n2(y - 1.5)}" font-size="2.4" font-weight="bold" font-family="Arial">Ubicación</text>
      <clipPath id="cIns"><rect x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="${n2(h)}"/></clipPath>
      <rect x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="${n2(h)}" fill="#f4f2ec"/>
      <g clip-path="url(#cIns)">${body.join("")}</g>
      <rect x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="${n2(h)}" fill="none" stroke="#000" stroke-width="0.25"/>
      <path d="M${n2(x + w - 5)},${n2(y + 8)}L${n2(x + w - 3.5)},${n2(y + 3)}L${n2(x + w - 2)},${n2(y + 8)}Z" fill="#000"/>
      <text x="${n2(x + w - 3.5)}" y="${n2(y + 2.6)}" font-size="2.2" font-family="Arial" text-anchor="middle">N</text>
      <line x1="${n2(x + 2)}" y1="${n2(y + h - 2)}" x2="${n2(x + 2 + bar * kmMm)}" y2="${n2(y + h - 2)}" stroke="#000" stroke-width="0.5"/>
      <text x="${n2(x + 2)}" y="${n2(y + h - 3)}" font-size="1.9" font-family="Arial">${bar} km</text></g>`;
  },
};

/* ------------------------------ formatos ---------------------------------- */
const Out = {
  base() {
    const sec = State.active();
    return ("seccion-" + (sec ? sec.name : "A")).replace(/[–'’\s]+/g, "_").replace(/[^\w-]/g, "");
  },

  svg(o) { downloadBlob(new Blob([Sheet.build(o)], { type: "image/svg+xml" }), this.base() + ".svg"); },

  async png(o, dpi) {
    const svg = Sheet.build(o), L = Sheet.layout(o);
    let w = Math.round(L.PW / 25.4 * dpi), h = Math.round(L.PH / 25.4 * dpi);
    const maxSide = 16000, maxArea = 180e6;
    let f = Math.min(1, maxSide / Math.max(w, h), Math.sqrt(maxArea / (w * h)));
    if (f < 1) { toast(`A ${dpi} dpi la imagen supera el máximo del navegador: se genera a ${Math.floor(dpi * f)} dpi.`, "", 5000); w = Math.floor(w * f); h = Math.floor(h * f); }
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      const c = cv.getContext("2d"); c.fillStyle = "#fff"; c.fillRect(0, 0, w, h); c.drawImage(img, 0, 0, w, h);
      const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
      if (!blob) throw new Error("el navegador no pudo generar la imagen");
      downloadBlob(blob, `${this.base()}-${Math.round(dpi * f)}dpi.png`);
    } finally { URL.revokeObjectURL(url); }
  },

  /** PDF: hoja a escala en una ventana nueva → Imprimir → Guardar como PDF */
  pdf(o) {
    const svg = Sheet.build(o).replace(/^<\?xml[^>]*>/, ""), L = Sheet.layout(o);
    const w = window.open("", "_blank");
    if (!w) { toast("El navegador bloqueó la ventana: permite ventanas emergentes para este sitio.", "bad", 5000); return; }
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${xesc(this.base())}</title>
      <style>@page{size:${L.PW}mm ${L.PH}mm;margin:0}html,body{margin:0;background:#fff}svg{display:block}</style></head>
      <body>${svg}<script>setTimeout(function(){print()},400)<\/script></body></html>`);
    w.document.close();
  },

  /** líneas de la sección en el terreno: s → (lat, lng), con su cota */
  geoLines() {
    const fr = View.frame;
    const items = SecEdit.lines().map((l) => ({ name: l.unit || l.name || l.kind, kind: l.kind, unit: l.unit || "", method: l.method || "",
      pts: l.pts.filter((q) => q[0] >= 0 && q[0] <= fr.L).map((q) => { const ll = Geo.atS(fr, q[0]); return [ll[0], ll[1], q[1]]; }) }));
    const p = State.profile;
    items.push({ name: "topografía", kind: "topo", unit: "", method: p.fuente || "",
      pts: p.d.map((d, i) => [...Geo.atS(fr, d * 1000), p.z[i]]).filter((q) => q[2] != null) });
    return items.filter((x) => x.pts.length > 1);
  },

  kmlColor(hex, a = "ff") {   // #rrggbb → aabbggrr
    const h = (hex || "#888888").replace("#", "");
    return a + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2);
  },

  async kmz() {
    const fr = View.frame, sec = State.active();
    const coord = (q) => `${q[1].toFixed(7)},${q[0].toFixed(7)},${Math.round(q[2] * 10) / 10}`;
    const pm = [];
    // trazas
    pm.push(`<Folder><name>Trazas</name>${State.sections.filter((s) => s.trace).map((s) => `<Placemark><name>${xesc(s.name)}</name>
      <Style><LineStyle><color>${s.id === State.secId ? "ff3da3e8" : "ffe6b68f"}</color><width>3</width></LineStyle></Style>
      <LineString><tessellate>1</tessellate><altitudeMode>clampToGround</altitudeMode><coordinates>${Geo.tracePts(s.trace).map((q) => `${q[1]},${q[0]},0`).join(" ")}</coordinates></LineString></Placemark>`).join("")}</Folder>`);
    // sección vertical 3D (cortina): rellenos como polígonos verticales y líneas a cota absoluta
    const bands = unitBands(SecEdit.lines(), fr.L, State.profile.vmin - (Number(State.prefs.depth) || 0), 300);
    const toGeo = (q) => { const ll = Geo.atS(fr, q[0]); return [ll[0], ll[1], q[1]]; };
    pm.push(`<Folder><name>Sección ${xesc(sec ? sec.name : "")} en 3D</name>
      ${bands.map((b) => `<Placemark><name>${xesc(b.unit)}</name><Style><LineStyle><width>0</width></LineStyle><PolyStyle><color>${this.kmlColor(b.color, "b3")}</color></PolyStyle></Style>
        <Polygon><altitudeMode>absolute</altitudeMode><outerBoundaryIs><LinearRing><coordinates>${b.poly.concat([b.poly[0]]).map(toGeo).map(coord).join(" ")}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`).join("")}
      ${this.geoLines().map((l) => `<Placemark><name>${xesc(l.name)}</name><Style><LineStyle><color>${l.kind === "fault" ? "ff2828c6" : l.kind === "topo" ? "ff3da3e8" : "ff222222"}</color><width>${l.kind === "fault" ? 3 : 2}</width></LineStyle></Style>
        <LineString><altitudeMode>absolute</altitudeMode><coordinates>${l.pts.map(coord).join(" ")}</coordinates></LineString></Placemark>`).join("")}</Folder>`);
    // intersecciones
    pm.push(`<Folder><name>Intersecciones</name>${Profile.intersections().map((x) => { const ll = Geo.atS(fr, x.s);
      return `<Placemark><name>${xesc(x.kind === "fault" ? "Falla " + (x.tipo || "") : x.kind === "axis" ? "Eje " + (x.tipo || "") : x.nombre || x.kind)}</name>
        <description>s = ${Math.round(x.s)} m · z = ${x.z == null ? "—" : Math.round(x.z)} m${x.manteo_aparente != null ? " · manteo aparente " + Math.round(x.manteo_aparente) + "°" : ""}</description>
        <Point><altitudeMode>clampToGround</altitudeMode><coordinates>${ll[1]},${ll[0]},0</coordinates></Point></Placemark>`; }).join("")}</Folder>`);
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${xesc(this.base())}</name>
<description>Perfiles geológicos (PWA). La sección 3D usa cota absoluta (msnm) a escala real: desactiva la exageración del relieve de Google Earth para verla calzada.</description>
${pm.join("\n")}</Document></kml>`;
    const z = new JSZip(); z.file("doc.kml", kml);
    downloadBlob(await z.generateAsync({ type: "blob", mimeType: "application/vnd.google-earth.kmz" }), this.base() + ".kmz");
  },

  /** SHP 3D (PolyLineZ) en UTM WGS84 de la zona de la sección, en un .zip */
  async shp() {
    const fr = View.frame;
    const zone = Geo.utm(fr.a[0], fr.a[1]).zone, epsg = `EPSG:${32700 + zone}`;
    CRS.init();
    if (!proj4.defs(epsg)) proj4.defs(epsg, `+proj=utm +zone=${zone} +south +datum=WGS84 +units=m +no_defs`);
    const tr = proj4("EPSG:4326", epsg).forward;
    const items = this.geoLines().map((l) => ({ ...l, xyz: l.pts.map((q) => { const p = tr([q[1], q[0]]); return [p[0], p[1], q[2]]; }) }));
    const sec = State.active();
    const groups = { horizontes: items.filter((x) => x.kind === "horizon" || x.kind === "guide"), fallas: items.filter((x) => x.kind === "fault"), topografia: items.filter((x) => x.kind === "topo") };
    const prj = `PROJCS["WGS_1984_UTM_Zone_${zone}S",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",10000000.0],PARAMETER["Central_Meridian",${zone * 6 - 183}.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]`;
    const z = new JSZip();
    let n = 0;
    for (const [g, list] of Object.entries(groups)) {
      if (!list.length) continue;
      const f = ShpWriter.polylineZ(list.map((x) => x.xyz),
        [{ name: "NOMBRE", len: 60 }, { name: "TIPO", len: 12 }, { name: "UNIDAD", len: 40 }, { name: "METODO", len: 20 }, { name: "SECCION", len: 20 }],
        list.map((x) => [x.name, x.kind, x.unit, x.method, sec ? sec.name : ""]));
      const stem = `${this.base()}_${g}`;
      z.file(stem + ".shp", f.shp); z.file(stem + ".shx", f.shx); z.file(stem + ".dbf", f.dbf);
      z.file(stem + ".prj", prj); z.file(stem + ".cpg", "UTF-8");
      n++;
    }
    if (!n) { toast("No hay líneas que exportar.", "bad"); return; }
    downloadBlob(await z.generateAsync({ type: "blob" }), this.base() + "_shp3d.zip");
  },

  geojson() {
    const fr = View.frame;
    const feats = this.geoLines().map((l) => ({ type: "Feature", properties: { nombre: l.name, tipo: l.kind, unidad: l.unit, metodo: l.method },
      geometry: { type: "LineString", coordinates: l.pts.map((q) => [q[1], q[0], q[2]]) } }));
    for (const x of Profile.intersections()) {
      const ll = Geo.atS(fr, x.s);
      feats.push({ type: "Feature", properties: { ...x, s: Math.round(x.s), z: x.z == null ? null : Math.round(x.z) }, geometry: { type: "Point", coordinates: [ll[1], ll[0], x.z == null ? 0 : Math.round(x.z)] } });
    }
    feats.push({ type: "Feature", properties: { nombre: "traza", seccion: (State.active() || {}).name }, geometry: { type: "LineString", coordinates: fr.pts.map((q) => [q[1], q[0]]) } });
    downloadBlob(new Blob([JSON.stringify({ type: "FeatureCollection", features: feats }, null, 1)], { type: "application/geo+json" }), this.base() + ".geojson");
  },

  csv() {
    const fr = View.frame, p = State.profile;
    const surf = Profile.surface().runs;
    const unitAt = (s) => (surf.find((r) => s >= r.s0 && s <= r.s1) || { f: { nombre: "" } }).f.nombre;
    const rows = [["s_m", "lat", "lon", "este", "norte", "cota_m", "unidad_superficie"].join(";")];
    p.d.forEach((d, i) => {
      const s = d * 1000, ll = Geo.atS(fr, s), u = Geo.utm(ll[0], ll[1]);
      rows.push([Math.round(s), ll[0].toFixed(6), ll[1].toFixed(6), u.e, u.n, p.z[i] ?? "", unitAt(s)].join(";"));
    });
    const dips = [["s_m", "distancia_traza_m", "cota_m", "manteo", "dir_manteo", "manteo_aparente", "mantea_hacia", "lat", "lon"].join(";")];
    for (const d of SecEdit.dips()) {
      const pr = Profile.project(d.f);
      dips.push([Math.round(d.s), Math.round(pr.t), Math.round(d.z), d.f.dip, d.f.dir, (Math.abs(pr.ap)).toFixed(1), d.th < 0 ? "B" : "A", d.f.lat.toFixed(6), d.f.lng.toFixed(6)].join(";"));
    }
    downloadBlob(new Blob(["﻿" + rows.join("\r\n")], { type: "text/csv" }), this.base() + "_perfil.csv");
    setTimeout(() => downloadBlob(new Blob(["﻿" + dips.join("\r\n")], { type: "text/csv" }), this.base() + "_manteos.csv"), 400);
  },

  /** DXF R12 de la sección en (s, z) metros reales: una capa por tipo */
  dxf() {
    const out = ["0", "SECTION", "2", "ENTITIES"];
    const poly = (layer, pts) => {
      out.push("0", "POLYLINE", "8", layer, "66", "1", "70", "0");
      for (const q of pts) out.push("0", "VERTEX", "8", layer, "10", q[0].toFixed(2), "20", q[1].toFixed(2), "30", "0.0");
      out.push("0", "SEQEND", "8", layer);
    };
    const p = State.profile;
    poly("TOPOGRAFIA", p.d.map((d, i) => [d * 1000, p.z[i]]).filter((q) => q[1] != null));
    for (const l of SecEdit.lines()) poly(l.kind === "fault" ? "FALLAS" : l.kind === "guide" ? "GUIAS" : ("H_" + (l.unit || "SIN_UNIDAD")).replace(/[^\w-]/g, "_").slice(0, 30), l.pts);
    out.push("0", "ENDSEC", "0", "EOF");
    downloadBlob(new Blob([out.join("\r\n")], { type: "application/dxf" }), this.base() + ".dxf");
  },

  /* ---------- proyecto ---------- */
  project() {
    State.syncActive();
    const strip = (fs) => fs.map(({ _layer, _label, ...r }) => r);
    const o = { formato: "perfiles-proyecto/1", guardado: new Date().toISOString(), prefs: State.prefs, secId: State.secId,
      sections: State.sections, feats: strip(State.feats), seq: State.seq,
      layers: State.layers.map((l) => ({ ...l, feats: strip(l.feats) })) };
    downloadBlob(new Blob([JSON.stringify(o)], { type: "application/json" }), `proyecto-perfiles-${new Date().toISOString().slice(0, 10)}.json`);
  },

  async openProject(o) {
    if (!o || o.formato !== "perfiles-proyecto/1") throw new Error("no es un proyecto de Perfiles geológicos");
    State.feats = o.feats || []; State.seq = o.seq || 1;
    State.layers = o.layers || [];
    State.sections = (o.sections || []).map((x) => ({ ...x, trace: Geo.tracePts(x.trace) ? { pts: Geo.tracePts(x.trace) } : null }));
    Object.assign(State.prefs, o.prefs || {});
    // se fija la activa directamente: activate() guardaría antes una «activa» inexistente (sección extra vacía)
    if (State.sections.length) {
      const a = State.sections.find((x) => x.id === o.secId) || State.sections[0];
      State.secId = a.id; State.trace = a.trace || null; State.profile = a.profile || null;
    } else { State.secId = null; State.trace = null; State.profile = null; State.syncActive(); }
    await State.persistLayers(); State.persist();
    App.applyPrefs(); App.renderSecSel();
    State.emit("all");
    if (View.frame) View.map.fitBounds(L.latLngBounds(View.frame.pts), { padding: [60, 60] });
    if (State.trace && !State.profile) await App.buildProfile();
  },
};

/* --------------------- escritor de shapefile PolyLineZ --------------------- */
const ShpWriter = {
  polylineZ(lines, fields, rows) {
    const recs = lines.map((pts) => {
      const n = pts.length;
      const len = 4 + 32 + 4 + 4 + 4 + 16 * n + 16 + 8 * n + 16 + 8 * n;   // 1 parte; Z y M
      const b = new DataView(new ArrayBuffer(len));
      const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]), zs = pts.map((q) => q[2]);
      let o = 0;
      b.setInt32(o, 13, true); o += 4;
      for (const v of [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]) { b.setFloat64(o, v, true); o += 8; }
      b.setInt32(o, 1, true); o += 4; b.setInt32(o, n, true); o += 4; b.setInt32(o, 0, true); o += 4;
      for (const q of pts) { b.setFloat64(o, q[0], true); b.setFloat64(o + 8, q[1], true); o += 16; }
      b.setFloat64(o, Math.min(...zs), true); b.setFloat64(o + 8, Math.max(...zs), true); o += 16;
      for (const z of zs) { b.setFloat64(o, z, true); o += 8; }
      b.setFloat64(o, 0, true); b.setFloat64(o + 8, 0, true); o += 16;
      for (let i = 0; i < n; i++) { b.setFloat64(o, 0, true); o += 8; }
      return { buf: b.buffer, xs, ys, zs };
    });
    const all = recs.flatMap((r) => r.xs.map((x, i) => [x, r.ys[i], r.zs[i]]));
    const bbox = [Math.min(...all.map((q) => q[0])), Math.min(...all.map((q) => q[1])), Math.max(...all.map((q) => q[0])), Math.max(...all.map((q) => q[1])),
      Math.min(...all.map((q) => q[2])), Math.max(...all.map((q) => q[2]))];
    const header = (lenBytes) => {
      const h = new DataView(new ArrayBuffer(100));
      h.setInt32(0, 9994, false); h.setInt32(24, lenBytes / 2, false); h.setInt32(28, 1000, true); h.setInt32(32, 13, true);
      [bbox[0], bbox[1], bbox[2], bbox[3], bbox[4], bbox[5], 0, 0].forEach((v, i) => h.setFloat64(36 + i * 8, v, true));
      return new Uint8Array(h.buffer);
    };
    const shpLen = 100 + recs.reduce((s, r) => s + 8 + r.buf.byteLength, 0);
    const shp = new Uint8Array(shpLen), shx = new Uint8Array(100 + 8 * recs.length);
    shp.set(header(shpLen), 0); shx.set(header(shx.length), 0);
    let off = 100;
    const sx = new DataView(shx.buffer);
    recs.forEach((r, i) => {
      const rh = new DataView(new ArrayBuffer(8));
      rh.setInt32(0, i + 1, false); rh.setInt32(4, r.buf.byteLength / 2, false);
      sx.setInt32(100 + i * 8, off / 2, false); sx.setInt32(104 + i * 8, r.buf.byteLength / 2, false);
      shp.set(new Uint8Array(rh.buffer), off); shp.set(new Uint8Array(r.buf), off + 8);
      off += 8 + r.buf.byteLength;
    });
    return { shp, shx, dbf: this.dbf(fields, rows) };
  },

  dbf(fields, rows) {
    const enc = new TextEncoder();
    const recLen = 1 + fields.reduce((s, f) => s + f.len, 0), hLen = 32 + 32 * fields.length + 1;
    const buf = new Uint8Array(hLen + recLen * rows.length + 1);
    const dv = new DataView(buf.buffer);
    const d = new Date();
    buf[0] = 3; buf[1] = d.getFullYear() - 1900; buf[2] = d.getMonth() + 1; buf[3] = d.getDate();
    dv.setInt32(4, rows.length, true); dv.setInt16(8, hLen, true); dv.setInt16(10, recLen, true);
    fields.forEach((f, i) => {
      const o = 32 + 32 * i;
      buf.set(enc.encode(f.name.slice(0, 10)), o);
      buf[o + 11] = 67;                // 'C'
      buf[o + 16] = f.len;
    });
    buf[hLen - 1] = 0x0d;
    rows.forEach((r, i) => {
      let o = hLen + i * recLen;
      buf[o++] = 0x20;
      fields.forEach((f, j) => {
        let b = enc.encode(String(r[j] == null ? "" : r[j]));
        if (b.length > f.len) {          // corta sin romper un carácter UTF-8
          let k = f.len;
          while (k > 0 && (b[k] & 0xc0) === 0x80) k--;
          b = b.slice(0, k);
        }
        buf.fill(0x20, o, o + f.len); buf.set(b, o); o += f.len;
      });
    });
    buf[buf.length - 1] = 0x1a;
    return buf;
  },
};

/* ------------------------------- diálogo ---------------------------------- */
const Export = {
  opts: { page: "A3", scale: "auto", ve: "2", title: "", author: "", legend: true },

  read() {
    const o = this.opts;
    o.page = $("xPage").value; o.scale = $("xScale").value; o.ve = $("xVe").value;
    o.title = $("xTitle").value; o.author = $("xAuthor").value; o.legend = $("xLeg").checked;
    return o;
  },

  preview() {
    const o = this.read(), L = Sheet.layout(o);
    $("xMsg").textContent = L.msg || `Hoja ${o.page} · 1:${fmt(L.N)} · VE ${o.ve}× · sección de ${fmt(L.secW)} × ${fmt(L.secH)} mm.`;
    $("xMsg").className = L.msg ? "warn" : "hint2";
    $("xPrev").innerHTML = Sheet.build(o).replace(/^<\?xml[^>]*>/, "").replace(/width="[\d.]+mm" height="[\d.]+mm"/, 'width="100%"');
  },

  dialog() {
    if (!State.profile || !View.frame) {
      modal({ title: "Exportar", body: `<p>Traza una sección primero. Igual puedes guardar el proyecto.</p>`,
        actions: [{ label: "Cerrar" }, { label: "Guardar proyecto", primary: true, onClick: () => Out.project() }] });
      return;
    }
    const o = this.opts;
    const sel = (id, opts, v) => `<select id="${id}">${opts.map(([a, b]) => `<option value="${a}"${String(a) === String(v) ? " selected" : ""}>${b}</option>`).join("")}</select>`;
    const m = modal({
      title: "Exportar la sección",
      body: `<div class="grid2">
          <label class="field">Título <input id="xTitle" value="${esc(o.title)}" placeholder="Sección geológica ${esc((State.active() || {}).name || "")}"></label>
          <label class="field">Autor / institución <input id="xAuthor" value="${esc(o.author)}"></label>
          <label class="field">Hoja ${sel("xPage", Object.keys(PAGES).map((k) => [k, k + " horizontal"]), o.page)}</label>
          <label class="field">Escala horizontal ${sel("xScale", [["auto", "ajustar a la hoja"], ...NICE_SCALES.map((s) => [s, "1:" + fmt(s)])], o.scale)}</label>
          <label class="field">Exageración vertical ${sel("xVe", [["1", "1× (real)"], ["1.5", "1,5×"], ["2", "2×"], ["3", "3×"], ["5", "5×"]], o.ve)}</label>
          <label class="field" style="flex-direction:row;align-items:center;gap:6px;margin-top:16px"><input type="checkbox" id="xLeg" ${o.legend ? "checked" : ""}> Leyenda, escalas y ubicación</label>
        </div>
        <p id="xMsg" class="hint2"></p>
        <div id="xPrev" class="xprev"></div>
        <div class="xrow"><b>Lámina</b>
          <button data-x="svg">SVG (capas)</button>
          <button data-x="png150">PNG 150 dpi</button><button data-x="png300">PNG 300 dpi</button><button data-x="png600">PNG 600 dpi</button>
          <button data-x="pdf">PDF (imprimir)</button></div>
        <div class="xrow"><b>Datos</b>
          <button data-x="kmz">KMZ 3D</button><button data-x="shp">SHP 3D</button><button data-x="geojson">GeoJSON</button>
          <button data-x="csv">CSV</button><button data-x="dxf">DXF</button><button data-x="json">JSON sección</button>
          <button data-x="project">Proyecto completo</button></div>
        <p class="hint2">El SVG está en milímetros reales: impreso al 100 % queda a la escala indicada. El proyecto
          completo (.json) guarda capas, secciones e interpretación; se abre arrastrándolo a la app.</p>`,
      actions: [{ label: "Cerrar" }],
    });
    $("modal").classList.add("wide", "xl");
    m.acts.querySelector("button").addEventListener("click", () => $("modal").classList.remove("wide", "xl"));
    m.body.addEventListener("change", () => this.preview());
    m.body.addEventListener("click", async (e) => {
      const b = e.target.closest("button[data-x]");
      if (!b) return;
      const x = b.dataset.x, oo = this.read();
      try {
        if (x === "svg") Out.svg(oo);
        else if (x.startsWith("png")) { b.disabled = true; await Out.png(oo, Number(x.slice(3))); b.disabled = false; }
        else if (x === "pdf") Out.pdf(oo);
        else if (x === "kmz") await Out.kmz();
        else if (x === "shp") await Out.shp();
        else if (x === "geojson") Out.geojson();
        else if (x === "csv") Out.csv();
        else if (x === "dxf") Out.dxf();
        else if (x === "json") App.exportJson();
        else if (x === "project") Out.project();
      } catch (err) { console.error(err); toast("Error al exportar: " + err.message, "bad", 6000); b.disabled = false; }
    });
    this.preview();
  },
};
