"use strict";
/* =============================================================================
   sectionedit.js — construcción e interpretación en el lienzo de la sección
   Las líneas viven en la sección activa: State.active().lines = [{id, kind, pts:[[s,z]…],
   name, unit, color, method}], kind ∈ horizon | fault | guide. Coordenadas reales (m).
   Un horizonte es el TECHO de su unidad: el relleno va desde él hasta el siguiente
   horizonte de abajo.
   ========================================================================== */
const SecEdit = {
  tool: "view",
  draft: null,          // [[s,z]…] de la línea en dibujo
  cursor: null,         // [s,z] bajo el mouse
  sel: null,            // id de la línea seleccionada
  drag: null,           // {line, i}
  meas: null,           // primer punto de la medición
  hist: {},             // por sección: {u:[], r:[]}
  seedOpts: null,       // opciones de construcción para la herramienta «semilla»

  lines() { const a = State.active(); return a ? (a.lines || (a.lines = [])) : []; },
  byId(id) { return this.lines().find((l) => l.id === id); },
  H() { return this.hist[State.secId] || (this.hist[State.secId] = { u: [], r: [] }); },
  snap() {
    const h = this.H();
    h.u.push(JSON.stringify(this.lines()));
    if (h.u.length > 80) h.u.shift();
    h.r = [];
  },
  undo() {
    const h = this.H(), a = State.active();
    if (!h.u.length || !a) return false;
    h.r.push(JSON.stringify(this.lines()));
    a.lines = JSON.parse(h.u.pop());
    this.changed(); return true;
  },
  redo() {
    const h = this.H(), a = State.active();
    if (!h.r.length || !a) return false;
    h.u.push(JSON.stringify(this.lines()));
    a.lines = JSON.parse(h.r.pop());
    this.changed(); return true;
  },
  changed() { State.persist(); Profile.draw(); },
  uid() { return "h" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); },
  add(l) { this.snap(); this.lines().push({ id: this.uid(), ...l }); this.changed(); },

  unitColorOf(name) {
    const u = State.allFeats().find((f) => f.kind === "unit" && f.nombre === name);
    return u ? u.color : unitColor(name || "x");
  },

  /* ---------- datos de la sección ---------- */
  /** manteos proyectados a la sección: {s, z, th (rad), f}. mult = factor del corredor */
  dips(mult = 1) {
    const fr = View.frame;
    if (!fr) return [];
    const save = State.prefs.corr;
    State.prefs.corr = save * mult;
    const out = [];
    for (const f of State.allFeats()) {
      if (f.kind !== "dip") continue;
      const pr = Profile.project(f);
      if (!pr || !pr.inside) continue;
      const z = pr.z != null ? pr.z : Profile.zAt(pr.s);
      if (z == null) continue;
      const side = Math.cos((f.dir - pr.seg.az) * Math.PI / 180) >= 0 ? 1 : -1;
      out.push({ s: pr.s, z, th: -side * Math.abs(pr.ap) * Math.PI / 180, f });
    }
    State.prefs.corr = save;
    return out.sort((a, b) => a.s - b.s);
  },

  /** contactos de superficie: bordes de unidades y cruces de líneas de contacto */
  contacts() {
    const out = Profile.surface().contacts.map((c) => ({ s: c.s, a: c.a, b: c.b, src: "unidades" }));
    for (const x of Profile.intersections()) {
      if (x.kind !== "cline") continue;
      if (out.some((o) => Math.abs(o.s - x.s) < 30)) continue;     // ya está por los polígonos
      out.push({ s: x.s, a: "?", b: "?", src: "línea" });
    }
    return out.map((c) => ({ ...c, z: Profile.zAt(c.s) })).filter((c) => c.z != null).sort((a, b) => a.s - b.s);
  },

  nearestDip(dips, s) {
    let best = null;
    for (const d of dips) if (!best || Math.abs(d.s - s) < Math.abs(best.s - s)) best = d;
    return best;
  },

  box() {
    const p = State.profile, fr = View.frame;
    return { s0: 0, s1: fr.L, zMin: p.vmin - (Number(State.prefs.depth) || 3000) - 2000, zMax: p.vmax + 4000 };
  },

  /* ---------- construcción ---------- */
  buildFrom(seed, method, dips, unit) {
    const box = this.box();
    const topo = (s) => Profile.zAt(s);
    if (method === "busk") return Construct.busk(seed, dips, box);
    return Construct.kink(seed, dips, box, topo);
  },

  constructDialog() {
    if (!State.profile || !View.frame) { toast("Primero traza la sección.", "bad"); return; }
    const dips = this.dips();
    const cts = this.contacts();
    const def = (c) => {   // unidad bajo el horizonte = la del lado aguas arriba del manteo
      const d = this.nearestDip(dips, c.s);
      return d && d.th > 0 ? c.b : c.a;
    };
    const rows = cts.map((c, i) => `<tr><td><input type="checkbox" data-i="${i}" ${c.src === "unidades" ? "checked" : ""}></td>
      <td>${fmt(c.s / 1000, 2)}</td><td>${fmt(c.z)}</td><td>${esc(c.a)} | ${esc(c.b)}</td>
      <td><input class="u" data-u="${i}" value="${esc(def(c) === "?" ? "" : def(c))}" placeholder="unidad"></td></tr>`).join("");
    const m = modal({
      title: "Construir horizontes en profundidad",
      body: `<div class="grid2">
          <label class="field">Método <select id="cMeth">
            <option value="kink">Kink-band / dominios de manteo</option>
            <option value="busk">Busk (arcos concéntricos)</option>
            <option value="hermite">Curva suave por contactos iguales (Hermite)</option>
            <option value="tangent">Solo tangentes (guías)</option></select></label>
          <label class="field">Manteos usados <select id="cMult">
            <option value="1">corredor (${dips.length})</option>
            <option value="2">corredor ×2 (${this.dips(2).length})</option>
            <option value="4">corredor ×4 (${this.dips(4).length})</option></select></label>
        </div>
        ${dips.length ? "" : `<p class="warn">No hay manteos en el corredor: amplíalo, importa manteos o dibújalos con «Manteo».</p>`}
        <p class="hint2">Semillas: contactos en superficie. La unidad indicada queda <b>bajo</b> el horizonte
          (se propone la del lado hacia donde sube la capa). También puedes cerrar este cuadro y usar
          «◎ Semilla» para construir desde un punto cualquiera de la sección.</p>
        <table class="maptbl"><tr><th></th><th>km</th><th>cota</th><th>contacto</th><th>unidad bajo</th></tr>${rows ||
          `<tr><td colspan="5">Sin contactos en superficie: importa unidades o contactos.</td></tr>`}</table>`,
      actions: [
        { label: "Cancelar" },
        { label: "◎ Semilla con clic", onClick: () => {
            this.seedOpts = { method: $("cMeth").value, mult: Number($("cMult").value) };
            this.setTool("seed");
          } },
        { label: "Construir", primary: true, onClick: () => {
            const method = $("cMeth").value, mult = Number($("cMult").value);
            const ds = this.dips(mult);
            if (!ds.length) { toast("Sin manteos para construir.", "bad"); return false; }
            const pick = [...m.body.querySelectorAll("input[data-i]")].filter((x) => x.checked).map((x) => Number(x.dataset.i));
            const unitOf = (i) => m.body.querySelector(`input[data-u="${i}"]`).value.trim();
            this.snap();
            let n = 0;
            if (method === "tangent") {
              for (const t of Construct.tangents(ds, this.box())) { this.lines().push({ id: this.uid(), kind: "guide", pts: t, name: "tangente", method }); n++; }
            } else if (method === "hermite") {
              const groups = new Map();
              for (const i of pick) {
                const c = cts[i]; const k = [c.a, c.b].sort().join("|");
                if (!groups.has(k)) groups.set(k, { unit: unitOf(i), pts: [] });
                const d = this.nearestDip(ds, c.s);
                groups.get(k).pts.push({ s: c.s, z: c.z, th: d ? d.th : 0 });
              }
              for (const [k, g] of groups) {
                if (g.pts.length < 2) continue;
                this.lines().push({ id: this.uid(), kind: "horizon", pts: Construct.hermite(g.pts), name: k, unit: g.unit, color: this.unitColorOf(g.unit), method }); n++;
              }
              if (!n) toast("Hermite necesita al menos dos contactos del mismo par de unidades.", "bad", 4500);
            } else {
              for (const i of pick) {
                const c = cts[i], unit = unitOf(i);
                const pts = this.buildFrom([c.s, c.z], method, ds);
                if (pts && pts.length > 1) { this.lines().push({ id: this.uid(), kind: "horizon", pts, name: `${c.a}|${c.b}`, unit, color: this.unitColorOf(unit), method }); n++; }
              }
            }
            this.changed();
            if (n) toast(`${n} línea(s) construidas (${method}).`, "ok");
          } },
      ],
    });
    $("modal").classList.add("wide");
    const off = () => $("modal").classList.remove("wide");
    m.acts.querySelectorAll("button").forEach((b) => b.addEventListener("click", off));
  },

  parallelDialog() {
    const base = this.byId(this.sel);
    if (!base) { toast("Selecciona primero una línea (✋ y clic sobre ella).", "bad", 3500); return; }
    modal({
      title: "Capas paralelas o similares",
      body: `<p class="hint2">Desde «${esc(base.name || base.unit || "línea")}». Espesores reales en metros,
          separados por coma: cada uno crea una línea a partir de la anterior (como una columna).</p>
        <div class="grid2">
          <label class="field">Espesores (m) <input id="pTh" value="200, 300"></label>
          <label class="field">Unidades (opcional, una por espesor) <input id="pUn" placeholder="Ki, Js"></label>
          <label class="field">Hacia <select id="pDir"><option value="-1">abajo (más antiguas)</option><option value="1">arriba</option></select></label>
          <label class="field">Método <select id="pMeth"><option value="par">paralelo (espesor normal constante)</option>
            <option value="sim">similar (espesor constante en la dirección axial)</option></select></label>
          <label class="field">Ángulo axial para «similar» (° desde la horizontal) <input id="pAx" value="90"></label>
        </div>`,
      actions: [
        { label: "Cancelar" },
        { label: "Crear", primary: true, onClick: () => {
            const th = $("pTh").value.split(/[;,\s]+/).map((x) => Number(x.replace(",", "."))).filter((x) => x > 0);
            const un = $("pUn").value.split(/[,;]+/).map((x) => x.trim());
            const dir = Number($("pDir").value), sim = $("pMeth").value === "sim", ax = Number($("pAx").value) || 90;
            if (!th.length) { toast("Escribe al menos un espesor.", "bad"); return false; }
            this.snap();
            let prev = base.pts;
            th.forEach((t, i) => {
              const pts = sim ? Construct.similar(prev, dir * t, ax) : Construct.offset(prev, dir * t);
              const unit = un[i] || "";
              this.lines().push({ id: this.uid(), kind: "horizon", pts, name: `${sim ? "similar" : "paralela"} ${fmt(t)} m`, unit, color: unit ? this.unitColorOf(unit) : "#c9d3dd", method: sim ? "similar" : "paralela" });
              prev = pts;
            });
            this.changed();
          } },
      ],
    });
  },

  balanceDialog() {
    const hz = this.lines().filter((l) => l.kind === "horizon" && l.pts.length > 1);
    if (!hz.length) { toast("No hay horizontes en esta sección.", "bad"); return; }
    const items = hz.map((l) => {
      const a = l.pts[0], b = l.pts[l.pts.length - 1];
      const zReg = (a[1] + b[1]) / 2;
      return { l, len: Construct.length(l.pts), chord: Math.abs(b[0] - a[0]), zReg, A: Construct.excessArea(l.pts, zReg) };
    });
    const mean = items.reduce((s, x) => s + x.len, 0) / items.length;
    const ad = Construct.areaDepth(items.map((x) => ({ A: x.A, zReg: x.zReg })));
    modal({
      title: "Balance de la sección",
      body: `<table class="maptbl"><tr><th>horizonte</th><th>largo (m)</th><th>Δ vs media</th><th>acort. (m)</th><th>nivel regional</th><th>área en exceso (km²)</th></tr>
        ${items.map((x) => `<tr><td>${esc(x.l.unit || x.l.name || "—")}</td><td>${fmt(x.len)}</td>
          <td style="color:${Math.abs(x.len / mean - 1) > 0.05 ? "var(--bad)" : "var(--ok)"}">${fmt((x.len / mean - 1) * 100, 1)} %</td>
          <td>${fmt(x.len - x.chord)}</td><td>${fmt(x.zReg)}</td><td>${fmt(x.A / 1e6, 3)}</td></tr>`).join("")}</table>
        <p class="hint2">Largo de línea: en una sección balanceada los horizontes plegados deberían tener largos parecidos
          (diferencias &gt; 5 % en rojo). Acortamiento = largo − distancia entre extremos.</p>
        ${ad ? `<p><b>Área-profundidad</b> (Chamberlin 1910; Epard &amp; Groshong 1993): acortamiento
          <b>${fmt(ad.S)} m</b>, despegue a <b>${fmt(ad.zDetach)} m</b> de cota, r² = ${fmt(ad.r2, 3)}.</p>
          <p class="hint2">Supone que el nivel regional de cada horizonte es la media de sus extremos y que la
          sección cubre todo el pliegue. Con r² bajo el resultado no es confiable.</p>
          ${ad.S <= 0 ? `<p class="warn">Acortamiento negativo: el área en exceso no crece con la profundidad del nivel
          regional. Revisa que los horizontes crucen todo el pliegue y que sus extremos estén en el nivel regional.</p>` : ""}` :`<p class="hint2">Área-profundidad necesita al menos dos horizontes a distinta cota regional.</p>`}`,
    });
    $("modal").classList.add("wide");
    $("mActs").querySelector("button").addEventListener("click", () => $("modal").classList.remove("wide"));
  },

  piDialog() {
    if (!View.frame) { toast("Primero traza la sección.", "bad"); return; }
    const ds = this.dips(4);
    const r = Construct.piAxis(ds.map((d) => ({ dip: d.f.dip, dir: d.f.dir })));
    if (!r) { toast("Se necesitan al menos 3 manteos (corredor ×4).", "bad"); return; }
    const q = r.l3 < 0.05 && r.l2 > 0.15 ? "buena (los polos forman una guirnalda)" : r.l3 < 0.12 ? "regular" : "mala: los manteos no definen un pliegue cilíndrico";
    modal({
      title: "Eje de pliegue (π) de los manteos",
      body: `<p>Con ${ds.length} manteos del corredor ×4: eje <b>${fmt(r.trend)}° / ${fmt(r.plunge)}°</b> (trend / plunge).</p>
        <p class="hint2">Autovector menor del tensor de orientación de los polos. Calidad ${q}
          (λ = ${fmt(r.l1, 2)} / ${fmt(r.l2, 2)} / ${fmt(r.l3, 3)}).</p>`,
      actions: [
        { label: "Cerrar" },
        { label: "Usar para proyección por eje", primary: true, onClick: () => {
            State.prefs.proj = "plunge"; State.prefs.trend = Math.round(r.trend); State.prefs.plunge = Math.round(r.plunge);
            App.applyPrefs(); State.persist(); State.rev++; Profile.draw();
            Projection.ensureZ().then((k) => { if (k) Profile.draw(); });
          } },
      ],
    });
  },

  /* ---------- herramientas en el lienzo ---------- */
  setTool(t) {
    this.tool = t;
    this.draft = null; this.meas = null;
    $$("#secBar [data-st]").forEach((b) => b.classList.toggle("on", b.dataset.st === t));
    $("pf").style.cursor = t === "view" ? "" : t === "edit" ? "default" : "crosshair";
    const hint = {
      view: "", horizon: "Clic por vértice; doble clic o Enter termina el horizonte.",
      fault: "Clic por vértice; doble clic o Enter termina la falla.",
      edit: "Arrastra vértices; clic en un tramo agrega un vértice; clic derecho borra el vértice.",
      erase: "Clic sobre una línea para borrarla.", measure: "Clic en dos puntos: distancia y ángulo reales. Clic sobre una línea: su largo.",
      seed: "Clic en la sección: se construye un horizonte por ese punto con los manteos.",
    }[t];
    if (hint) toast(hint, "", 3500);
    Profile.draw();
  },

  ev(e) {
    const g = Profile.geom, cv = $("pf");
    if (!g) return null;
    const r = cv.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    return { px, py, s: g.xToS(px), z: g.yToZ(py), g };
  },

  /** línea y vértice/tramo más cercanos (en píxeles) */
  hit(px, py, g) {
    let best = null;
    for (const l of this.lines()) {
      for (let i = 0; i < l.pts.length; i++) {
        const x = g.X(l.pts[i][0]), y = g.Y(l.pts[i][1]);
        const d = Math.hypot(x - px, y - py);
        // un vértice cercano gana siempre a un tramo (si no, el clic sobre el vértice inserta otro)
        if (d < 8 && (!best || !best.vertex || d < best.d)) best = { l, i, d, vertex: true };
        if (i < l.pts.length - 1) {
          const x2 = g.X(l.pts[i + 1][0]), y2 = g.Y(l.pts[i + 1][1]);
          const dx = x2 - x, dy = y2 - y, L2 = dx * dx + dy * dy || 1;
          const u = Math.max(0, Math.min(1, ((px - x) * dx + (py - y) * dy) / L2));
          const ds = Math.hypot(x + dx * u - px, y + dy * u - py);
          if (ds < 6 && (!best || (!best.vertex && ds < best.d))) best = best && best.vertex ? best : { l, i, d: ds, vertex: false, u };
        }
      }
    }
    return best;
  },

  onDown(e) {
    const p = this.ev(e);
    if (!p || e.button === 2) return;
    if (typeof Analogs !== "undefined" && Analogs && Analogs.cal && Analogs.calClick(p)) return;
    const t = this.tool;
    if (t === "view") {
      const h = this.hit(p.px, p.py, p.g);
      this.sel = h ? h.l.id : null;
      if (!$("kinPanel").hidden && !KinPanel.result) KinPanel.render();
      if (h) toast(`${h.l.kind === "fault" ? "Falla" : h.l.kind === "guide" ? "Guía" : "Horizonte"} ${h.l.unit || h.l.name || ""} · largo ${fmt(Construct.length(h.l.pts))} m${h.l.method ? " · " + h.l.method : ""}`, "", 2500);
      Profile.draw(); return;
    }
    if (t === "horizon" || t === "fault") {
      (this.draft || (this.draft = [])).push([p.s, p.z]);
      Profile.draw(); return;
    }
    if (t === "edit") {
      const h = this.hit(p.px, p.py, p.g);
      if (!h) return;
      this.snap();
      if (!h.vertex) { h.l.pts.splice(h.i + 1, 0, [p.s, p.z]); h.i++; }
      this.drag = { l: h.l, i: h.i };
      return;
    }
    if (t === "erase") {
      const h = this.hit(p.px, p.py, p.g);
      if (!h) return;
      this.snap();
      const a = State.active(); a.lines = a.lines.filter((x) => x !== h.l);
      this.changed(); return;
    }
    if (t === "measure") {
      if (!this.meas) {
        const h = this.hit(p.px, p.py, p.g);
        if (h) { toast(`Largo real de la línea: ${fmt(Construct.length(h.l.pts))} m`, "ok", 4000); return; }
        this.meas = [p.s, p.z]; Profile.draw(); return;
      }
      const a = this.meas, ds = p.s - a[0], dz = p.z - a[1];
      toast(`Distancia ${fmt(Math.hypot(ds, dz))} m · Δs ${fmt(ds)} m · Δz ${fmt(dz)} m · ángulo ${fmt(Math.abs(Math.atan2(dz, Math.abs(ds)) * 180 / Math.PI), 1)}° (real, sin VE)`, "ok", 7000);
      this.meas = null; Profile.draw(); return;
    }
    if (t === "seed") {
      const o = this.seedOpts || { method: "kink", mult: 1 };
      const ds = this.dips(o.mult);
      if (!ds.length) { toast("Sin manteos en el corredor.", "bad"); return; }
      const pts = this.buildFrom([p.s, p.z], o.method, ds);
      const unit = prompt("Unidad bajo este horizonte (opcional):", "") || "";
      if (pts) this.add({ kind: "horizon", pts, name: `semilla ${fmt(p.s / 1000, 2)} km`, unit, color: unit ? this.unitColorOf(unit) : "#c9d3dd", method: o.method });
    }
  },

  onMove(e) {
    const p = this.ev(e);
    if (!p) return;
    this.cursor = [p.s, p.z];
    if (this.drag) { this.drag.l.pts[this.drag.i] = [p.s, p.z]; Profile.draw(); return; }
    if (this.draft || this.meas) Profile.draw();
  },

  onUp() { if (this.drag) { this.drag = null; this.changed(); } },

  onContext(e) {
    if (this.tool !== "edit") return;
    e.preventDefault();
    const p = this.ev(e);
    const h = p && this.hit(p.px, p.py, p.g);
    if (!h || !h.vertex || h.l.pts.length <= 2) return;
    this.snap(); h.l.pts.splice(h.i, 1); this.changed();
  },

  finish() {
    const d = this.draft;
    this.draft = null;
    if (!d) return;
    // el doble clic agrega dos vértices iguales al final
    const pts = d.filter((q, i) => i === 0 || Math.hypot(q[0] - d[i - 1][0], q[1] - d[i - 1][1]) > 1);
    if (pts.length < 2) { Profile.draw(); return; }
    if (this.tool === "fault") this.add({ kind: "fault", pts, name: "falla", color: "#e06c6c" });
    else {
      const unit = prompt("Unidad bajo este horizonte (opcional):", "") || "";
      this.add({ kind: "horizon", pts, name: "horizonte", unit, color: unit ? this.unitColorOf(unit) : "#c9d3dd", method: "dibujo" });
    }
  },

  /* ---------- dibujo ---------- */
  /** rellenos de unidades entre horizontes (columnas de 2 px), recortados por la topografía */
  drawFills(c, g) {
    const hz = this.lines().filter((l) => l.kind === "horizon" && l.unit);
    if (!hz.length) return;
    const all = this.lines().filter((l) => l.kind === "horizon");
    const step = 2;
    for (let x = g.x0; x < g.x1; x += step) {
      const s = g.xToS(x + step / 2);
      const topo = Profile.zAt(s);
      if (topo == null) continue;
      const zs = all.map((l) => ({ l, z: Construct.zAt(l.pts, s) })).filter((q) => q.z != null).sort((a, b) => b.z - a.z);
      for (let i = 0; i < zs.length; i++) {
        if (!zs[i].l.unit) continue;
        const zTop = Math.min(zs[i].z, topo);
        const zBot = i + 1 < zs.length ? zs[i + 1].z : g.vlo;
        if (zTop <= zBot) continue;
        c.fillStyle = zs[i].l.color || "#9c8ac9";
        c.globalAlpha = 0.5;
        c.fillRect(x, g.Y(zTop), step + 0.3, g.Y(zBot) - g.Y(zTop));
      }
    }
    c.globalAlpha = 1;
  },

  drawLines(c, g, topoClip) {
    const path = (pts) => { c.beginPath(); pts.forEach((p, i) => (i ? c.lineTo(g.X(p[0]), g.Y(p[1])) : c.moveTo(g.X(p[0]), g.Y(p[1])))); };
    for (const l of this.lines()) {
      const col = l.kind === "fault" ? "#e06c6c" : l.kind === "guide" ? "#8d98a5" : (l.color || "#c9d3dd");
      const w = l.kind === "fault" ? 2.4 : l.kind === "guide" ? 1 : 1.8;
      // parte erosionada (sobre la topografía): tenue y punteada
      c.strokeStyle = col; c.globalAlpha = 0.35; c.lineWidth = 1; c.setLineDash([3, 4]);
      path(l.pts); c.stroke();
      c.globalAlpha = 1; c.setLineDash(l.kind === "guide" ? [5, 4] : []);
      c.save(); c.clip(topoClip);
      if (l.id === this.sel) { c.strokeStyle = "#fff"; c.lineWidth = w + 3; c.globalAlpha = 0.35; path(l.pts); c.stroke(); c.globalAlpha = 1; }
      c.strokeStyle = col; c.lineWidth = w; path(l.pts); c.stroke();
      c.restore(); c.setLineDash([]);
      if (this.tool === "edit") {
        c.fillStyle = "#e8a33d";
        for (const p of l.pts) c.fillRect(g.X(p[0]) - 2.5, g.Y(p[1]) - 2.5, 5, 5);
      }
    }
    // vista previa del modelo cinemático (naranjo punteado sobre todo)
    if (this.preview) {
      c.lineWidth = 1.6; c.setLineDash([5, 3]);
      c.strokeStyle = "#ffb347";
      for (const pts of this.preview.lines) if (pts.length > 1) { path(pts); c.stroke(); }
      if (this.preview.fault && this.preview.fault.length > 1) { c.strokeStyle = "#ff5a5a"; c.lineWidth = 2.2; path(this.preview.fault); c.stroke(); }
      c.setLineDash([]);
    }
    // línea en dibujo
    if (this.draft && this.draft.length) {
      const pts = this.cursor ? this.draft.concat([this.cursor]) : this.draft;
      c.strokeStyle = "#e8a33d"; c.lineWidth = 1.6; c.setLineDash([6, 4]); path(pts); c.stroke(); c.setLineDash([]);
    }
    if (this.meas && this.cursor) {
      c.strokeStyle = "#fff"; c.lineWidth = 1; c.setLineDash([2, 3]); path([this.meas, this.cursor]); c.stroke(); c.setLineDash([]);
    }
  },

  bind() {
    const cv = $("pf");
    cv.addEventListener("pointerdown", (e) => this.onDown(e));
    cv.addEventListener("pointermove", (e) => this.onMove(e));
    window.addEventListener("pointerup", () => this.onUp());
    cv.addEventListener("dblclick", () => { if (this.draft) this.finish(); });
    cv.addEventListener("contextmenu", (e) => this.onContext(e));
    $("secBar").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.st) this.setTool(b.dataset.st);
      const a = b.dataset.act;
      if (a === "construct") this.constructDialog();
      if (a === "parallel") this.parallelDialog();
      if (a === "balance") this.balanceDialog();
      if (a === "kin") KinPanel.open();
      if (a === "pi") this.piDialog();
      if (a === "undo" && !this.undo()) toast("Nada que deshacer en la sección.");
      if (a === "redo" && !this.redo()) toast("Nada que rehacer.");
      if (a === "big") { document.body.classList.toggle("bigsec"); setTimeout(() => { Profile.draw(); View.map.invalidateSize(); }, 60); }
    });
    $("selDepth").onchange = (e) => { State.prefs.depth = Number(e.target.value); State.persist(); Profile.draw(); };
    $("selDipErr").onchange = (e) => { State.prefs.dipErr = Number(e.target.value); State.persist(); Profile.draw(); };
    document.addEventListener("keydown", (e) => {
      if (this.tool === "view") return;
      if (e.key === "Enter" && this.draft) { e.preventDefault(); this.finish(); }
      if (e.key === "Escape") { this.draft = null; this.meas = null; this.setTool("view"); }
    });
  },
};
