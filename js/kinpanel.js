"use strict";
/* =============================================================================
   kinpanel.js — panel de modelado cinemático sobre la sección activa
   Usa la falla seleccionada en la sección (✋ + clic) y deforma las líneas.
   Vista previa con pasos (deslizador) → Aplicar (con deshacer) · Restaurar ·
   Inversión trishear.
   ========================================================================== */
const KinPanel = {
  o: { model: "trishear", sense: "inv", slip: 500, ps: 2, apical: 60, alpha: 0, steps: 60,
       horizons: true, guides: false, faults: true, gEvery: 0, gZ0: 0, gDz: 50, erosion: "" },
  result: null,      // {frames, lines, fault, ids, growthIdx, restore}

  fault() {
    const l = SecEdit.byId(SecEdit.sel);
    return l && l.kind === "fault" ? l : null;
  },

  open() {
    const p = $("kinPanel");
    p.hidden = !p.hidden;
    if (!p.hidden) this.render();
    else this.clearPreview();
  },

  render() {
    const o = this.o, f = this.fault();
    const sel = (id, opts, v) => `<select id="${id}">${opts.map(([a, b]) => `<option value="${a}"${String(a) === String(v) ? " selected" : ""}>${b}</option>`).join("")}</select>`;
    const num = (id, v, step = 1, title = "") => `<input id="${id}" type="number" step="${step}" value="${v}" title="${title}">`;
    $("kinPanel").innerHTML = `
      <div class="kh"><b>Modelado cinemático</b><button id="kClose" title="cerrar">✕</button></div>
      <div class="kf ${f ? "ok" : "warn"}">${f ? `Falla: ${f.pts.length} vértices, punta a ${fmt(Math.max(...f.pts.map((q) => q[1])))} m`
        : "Selecciona una falla en la sección (✋ y clic sobre ella), o dibújala con ⌁ Falla."}</div>
      <label class="kr"><span>Modelo</span>${sel("kModel", [["trishear", "Trishear (+ flujo paralelo detrás)"], ["fpf", "Flujo paralelo a la falla (rampa-plano = fault-bend)"], ["shear", "Cizalla inclinada (normal lístrica)"]], o.model)}</label>
      ${o.model !== "shear" ? `<label class="kr"><span>Sentido</span>${sel("kSense", [["inv", "inverso (colgante sube)"], ["nor", "normal (colgante baja)"]], o.sense)}</label>` : ""}
      <label class="kr"><span>${o.model === "shear" ? "Rechazo horizontal (m)" : "Desplazamiento (m)"}</span>${num("kSlip", o.slip, 10)}</label>
      ${o.model === "trishear" ? `<label class="kr"><span>P/S (propagación/desliz.)</span>${num("kPs", o.ps, 0.1)}</label>
        <label class="kr"><span>Ángulo apical (°)</span>${num("kAp", o.apical, 1)}</label>` : ""}
      ${o.model === "shear" ? `<label class="kr"><span>Cizalla desde la vertical (°)</span>${num("kAl", o.alpha, 1, "0 = vertical; negativo = antitético hacia el yacente")}</label>` : ""}
      <label class="kr"><span>Pasos</span>${num("kSteps", o.steps, 1)}</label>
      <div class="kr chk"><label><input type="checkbox" id="kH" ${o.horizons ? "checked" : ""}> horizontes</label>
        <label><input type="checkbox" id="kG" ${o.guides ? "checked" : ""}> guías</label>
        <label title="las demás fallas se mueven con el colgante (pasivas)"><input type="checkbox" id="kF" ${o.faults ? "checked" : ""}> otras fallas</label></div>
      <details ${o.gEvery || o.erosion !== "" ? "open" : ""}><summary>Sintectónicos y erosión</summary>
        <label class="kr"><span>Estrato nuevo cada (pasos, 0 = no)</span>${num("kGe", o.gEvery, 1)}</label>
        <label class="kr"><span>Cota del primero (m)</span>${num("kGz", o.gZ0, 10)}</label>
        <label class="kr"><span>Subida entre estratos (m)</span>${num("kGd", o.gDz, 5)}</label>
        <label class="kr"><span>Erosión: cortar sobre cota (m)</span><input id="kEr" type="number" step="10" value="${o.erosion}" placeholder="—"></label>
      </details>
      <div class="kb"><button id="kRun" class="pri">▶ Vista previa</button><button id="kRest" title="Correr el modelo hacia atrás (restaurar)">⏮ Restaurar</button></div>
      <input id="kFrame" type="range" min="0" max="0" value="0" ${this.result ? "" : "disabled"}>
      <div class="kb"><button id="kApply" ${this.result ? "" : "disabled"}>✓ Aplicar a la sección</button><button id="kCancel" ${this.result ? "" : "disabled"}>Descartar</button></div>
      <div class="kb"><button id="kInv" title="Ajusta la falla para que los horizontes restaurados queden rectos">🎯 Inversión trishear…</button></div>
      <div id="kMsg" class="kmsg"></div>`;
    if (this.result) { $("kFrame").max = String(this.result.frames.length - 1); $("kFrame").value = $("kFrame").max; }
  },

  read() {
    const o = this.o, v = (id, d) => { const e = $(id); return e ? e.value : d; }, c = (id, d) => { const e = $(id); return e ? e.checked : d; };
    o.model = v("kModel", o.model); o.sense = v("kSense", o.sense);
    o.slip = Math.abs(Number(v("kSlip", o.slip)) || 0); o.ps = Number(v("kPs", o.ps)) || 0; o.apical = Number(v("kAp", o.apical)) || 60;
    o.alpha = Number(v("kAl", o.alpha)) || 0; o.steps = clamp(Number(v("kSteps", o.steps)) || 40, 1, 400);
    o.horizons = c("kH", o.horizons); o.guides = c("kG", o.guides); o.faults = c("kF", o.faults);
    o.gEvery = Math.max(0, Math.round(Number(v("kGe", o.gEvery)) || 0)); o.gZ0 = Number(v("kGz", o.gZ0)) || 0; o.gDz = Number(v("kGd", o.gDz)) || 0;
    o.erosion = v("kEr", o.erosion);
    return o;
  },

  targets(f) {
    const o = this.o;
    return SecEdit.lines().filter((l) => l !== f && ((l.kind === "horizon" && o.horizons) || (l.kind === "guide" && o.guides) || (l.kind === "fault" && o.faults)));
  },

  compute(restore) {
    const f = this.fault();
    if (!f) { this.msg("Primero selecciona una falla en la sección.", true); return; }
    const o = this.read();
    const T = this.targets(f);
    const sign = o.model === "shear" ? 1 : (o.sense === "inv" ? 1 : -1);
    const slip = (restore ? -1 : 1) * sign * o.slip;
    const fr = View.frame;
    const growth = !restore && o.gEvery > 0 ? { every: o.gEvery, z0: o.gZ0, dz: o.gDz, s0: 0, s1: fr.L } : null;
    const t0 = performance.now();
    const r = Kin.run({ model: o.model, fault: f.pts, slip, ps: o.ps, apical: o.apical, alpha: o.alpha, steps: o.steps,
      growth, frames: Math.min(40, o.steps) }, T.map((l) => Kin.densify(l.pts, Math.max(10, fr.L / 600))));
    this.result = { ...r, ids: T.map((l) => l.id), restore, faultId: f.id };
    this.render();
    this.showFrame(this.result.frames.length - 1);
    this.msg(`${restore ? "Restauración" : "Modelo"} ${o.model}: ${T.length} línea(s), ${o.steps} pasos, ${fmt(performance.now() - t0)} ms.${r.growth.length ? ` ${r.growth.length} estrato(s) sintectónico(s).` : ""}`);
  },

  showFrame(i) {
    const r = this.result;
    if (!r) return;
    const fr = r.frames[clamp(i, 0, r.frames.length - 1)] || { lines: r.lines, fault: r.fault };
    SecEdit.preview = { lines: fr.lines, fault: fr.fault };
    Profile.draw();
  },

  apply() {
    const r = this.result;
    if (!r) return;
    const o = this.o;
    SecEdit.snap();
    const all = SecEdit.lines();
    const zE = o.erosion === "" ? null : Number(o.erosion);
    r.ids.forEach((id, i) => {
      const l = all.find((x) => x.id === id);
      if (!l) return;
      l.pts = r.lines[i];
      l.method = (l.method ? l.method + " → " : "") + (r.restore ? "restaurado " : "") + o.model;
    });
    r.growth.forEach((gi, k) => {
      all.push({ id: SecEdit.uid(), kind: "horizon", pts: r.lines[gi], name: `sintectónico ${k + 1}`, unit: `Sintectónico ${k + 1}`,
        color: hslHex(45, 55, 72 - k * 6), method: "sintectónico " + o.model });
    });
    // la falla: en trishear directo la punta se propaga
    const f = all.find((x) => x.id === r.faultId);
    if (f && o.model === "trishear" && !r.restore) f.pts = r.fault;
    // erosión: corta horizontes sobre la cota
    if (zE != null && isFinite(zE)) {
      const a = State.active();
      const out = [];
      for (const l of a.lines) {
        if (l.kind !== "horizon") { out.push(l); continue; }
        const parts = Kin.erode([l.pts], zE);
        parts.forEach((pp, j) => out.push({ ...l, id: j ? SecEdit.uid() : l.id, pts: pp }));
      }
      a.lines = out;
    }
    this.clearPreview();
    SecEdit.changed();
    this.msg("Aplicado. ↶ en la barra de la sección lo deshace.");
  },

  clearPreview() { this.result = null; SecEdit.preview = null; Profile.draw(); if (!$("kinPanel").hidden) this.render(); },

  msg(t, bad) { const m = $("kMsg"); if (m) { m.textContent = t; m.className = "kmsg" + (bad ? " bad" : ""); } },

  /* ---------- inversión trishear ---------- */
  invertDialog() {
    const f = this.fault();
    const hz = SecEdit.lines().filter((l) => l.kind === "horizon" && l.pts.length > 2);
    if (!hz.length) { this.msg("La inversión necesita al menos un horizonte deformado en la sección.", true); return; }
    let tipS = 0, tipZ = 0, dip = 30, dirS = 1;
    if (f) {
      const G = Kin.faultGeom(f.pts), t = G.seg[G.seg.length - 1].t;
      tipS = G.tip[0]; tipZ = G.tip[1]; dip = Math.atan2(t[1], Math.abs(t[0])) * 180 / Math.PI; dirS = t[0] >= 0 ? 1 : -1;
    } else {
      const s = hz[0].pts; tipS = (s[0][0] + s[s.length - 1][0]) / 2; tipZ = (s[0][1] + s[s.length - 1][1]) / 2 - 300;
    }
    modal({
      title: "Inversión trishear (Allmendinger 1998)",
      body: `<p class="hint2">Busca la falla y los parámetros con que los horizontes restaurados quedan lo más rectos
          posible (evolución diferencial). Con <b>un solo horizonte</b> el manteo y el desplazamiento se compensan
          (solo queda fijo el alzamiento); usa dos o más horizontes a distinta profundidad, o fija el manteo si lo conoces.</p>
        <table class="maptbl"><tr><th></th><th>horizonte</th><th>largo</th></tr>${hz.map((l, i) => `<tr><td><input type="checkbox" data-h="${i}" ${i < 3 ? "checked" : ""}></td><td>${esc(l.unit || l.name)}</td><td>${fmt(Construct.length(l.pts))} m</td></tr>`).join("")}</table>
        <div class="grid2">
          <label class="field">Rampa sube hacia <select id="iDir"><option value="1"${dirS > 0 ? " selected" : ""}>+s (hacia ${esc(((State.active() || {}).name || "A–B").split("–")[1] || "B")})</option><option value="-1"${dirS < 0 ? " selected" : ""}>−s</option></select></label>
          <label class="field">Punta: s (m) ± ${"1500"} <input id="iS" value="${Math.round(tipS)}"></label>
          <label class="field">Punta: cota (m) ± 1000 <input id="iZ" value="${Math.round(tipZ)}"></label>
          <label class="field">Manteo (°) <input id="iDip" value="${Math.round(dip)}"></label>
          <label class="field" style="flex-direction:row;gap:6px;align-items:center"><input type="checkbox" id="iFix"> fijar el manteo</label>
          ${this.bounds ? `<label class="field" style="flex-direction:row;gap:6px;align-items:center" title="P/S, apical y manteo acotados por ${esc(this.bounds.from)}"><input type="checkbox" id="iAna" checked> cotas de análogos (${[this.bounds.ps && "P/S " + this.bounds.ps.map((v) => fmt(v, 1)).join("–"), this.bounds.apical && "apical " + this.bounds.apical.map((v) => fmt(v)).join("–") + "°", this.bounds.dip && "manteo " + this.bounds.dip.map((v) => fmt(v)).join("–") + "°"].filter(Boolean).join(", ") || "sin datos"})</label>` : ""}
          <label class="field">Desplazamiento máx. (m) <input id="iSlip" value="3000"></label>
          <label class="field">Generaciones <input id="iGen" value="80"></label>
        </div>
        <div class="bar"><i id="iBar"></i></div><div id="iInfo" class="mono">—</div>`,
      actions: [
        { label: "Cerrar" },
        { label: "Invertir", primary: true, onClick: () => { this.runInversion(hz); return false; } },
      ],
    });
    $("modal").classList.add("wide");
    $("mActs").querySelector("button").addEventListener("click", () => $("modal").classList.remove("wide"));
  },

  async runInversion(hz) {
    const pick = [...document.querySelectorAll("#mBody input[data-h]")].filter((x) => x.checked).map((x) => hz[Number(x.dataset.h)]);
    if (!pick.length) { toast("Marca al menos un horizonte.", "bad"); return; }
    const nv = (id) => Number(String($(id).value).replace(",", "."));
    const S = nv("iS"), Z = nv("iZ"), dip = nv("iDip"), G = clamp(nv("iGen") || 80, 10, 400), fixDip = $("iFix").checked;
    // cotas desde secciones análogas (📚 → «Usar parámetros»), si se marcó la casilla
    const B = this.bounds && $("iAna") && $("iAna").checked ? this.bounds : {};
    const spec = [{ k: "tipS", min: S - 1500, max: S + 1500 }, { k: "tipZ", min: Z - 1000, max: Z + 1000 },
      { k: "ps", min: B.ps ? B.ps[0] : 0.3, max: B.ps ? B.ps[1] : 5 }, { k: "apical", min: B.apical ? B.apical[0] : 20, max: B.apical ? B.apical[1] : 120 },
      { k: "slip", min: 50, max: Math.max(100, nv("iSlip") || 3000) }];
    if (!fixDip) spec.push(B.dip ? { k: "dip", min: B.dip[0], max: B.dip[1] } : { k: "dip", min: Math.max(5, dip - 20), max: Math.min(85, dip + 20) });
    const zBase = Profile.geom ? Profile.geom.vlo : Z - 4000;
    const btn = [...$("mActs").querySelectorAll("button")].find((b) => b.textContent === "Invertir");
    if (btn) btn.disabled = true;
    const t0 = performance.now();
    const res = await Kin.invertTrishear(pick.map((l) => l.pts), spec, {
      dirS: Number($("iDir").value), zBase, steps: 30, gens: G, fixed: fixDip ? { dip } : {},
      onGen: (g, best) => new Promise((r) => {
        const b = $("iBar"), i = $("iInfo");
        if (b) b.style.width = `${Math.round((g + 1) / G * 100)}%`;
        if (i) i.textContent = `gen ${g + 1}/${G} · RMS ${fmt(best.c, 1)} m · manteo ${fmt(best.th.dip ?? dip, 1)}° · desplaz. ${fmt(best.th.slip)} m · P/S ${fmt(best.th.ps, 2)} · apical ${fmt(best.th.apical)}°`;
        setTimeout(r, 0);
      }),
    });
    if (btn) btn.disabled = false;
    const q = res.params;
    $("iInfo").innerHTML = `<b>Mejor ajuste</b> en ${fmt((performance.now() - t0) / 1000, 1)} s: punta (${fmt(q.tipS)} m, ${fmt(q.tipZ)} m), manteo ${fmt(q.dip, 1)}°,
      P/S ${fmt(q.ps, 2)}, apical ${fmt(q.apical)}°, desplazamiento ${fmt(q.slip)} m · RMS ${fmt(res.rms, 1)} m.
      <br><button id="iApply" class="primary" style="margin-top:6px">Usar esta falla y estos parámetros</button>`;
    $("iApply").onclick = () => {
      SecEdit.snap();
      const lines = SecEdit.lines();
      let f = this.fault();
      if (!f) { f = { id: SecEdit.uid(), kind: "fault", name: "falla (inversión)", color: "#e06c6c" }; lines.push(f); }
      f.pts = res.fault; f.method = "inversión trishear";
      SecEdit.sel = f.id;
      Object.assign(this.o, { model: "trishear", sense: "inv", slip: Math.round(q.slip), ps: Math.round(q.ps * 100) / 100, apical: Math.round(q.apical) });
      SecEdit.changed();
      modal({ title: "Inversión aplicada", body: `<p>La falla de la sección quedó con la rampa ajustada. En el panel de cinemática,
        «⏮ Restaurar» con estos parámetros muestra los horizontes restaurados.</p>` });
      $("modal").classList.remove("wide");
      $("kinPanel").hidden = false; this.render();
    };
  },

  bind() {
    $("kinPanel").addEventListener("click", (e) => {
      const id = e.target.id;
      if (id === "kClose") { $("kinPanel").hidden = true; this.clearPreview(); }
      if (id === "kRun") this.compute(false);
      if (id === "kRest") this.compute(true);
      if (id === "kApply") this.apply();
      if (id === "kCancel") this.clearPreview();
      if (id === "kInv") this.invertDialog();
    });
    $("kinPanel").addEventListener("change", (e) => {
      if (e.target.id === "kModel") { this.read(); this.result = null; SecEdit.preview = null; this.render(); Profile.draw(); }
    });
    $("kinPanel").addEventListener("input", (e) => { if (e.target.id === "kFrame") this.showFrame(Number(e.target.value)); });
  },
};
