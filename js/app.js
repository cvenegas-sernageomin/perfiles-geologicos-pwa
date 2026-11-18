"use strict";
/* ============================== 8. UI y app ============================== */
const App = {
  installEvent: null,
  building: false,

  async init() {
    await State.restore();
    await DEM.restoreUser();
    State.syncActive();          // siempre hay una sección activa

    View.init();
    this.applyPrefs();
    this.bind();
    this.renderRows();
    this.renderLayerList();
    this.renderSecSel();
    this.renderDemInfo();
    this.refreshInfo();
    Profile.draw();
    Importer.bindDrop();
    SecEdit.bind();
    KinPanel.bind();

    if (State.trace) {
      // al abrir, el mapa va a la sección activa (no a la vista por defecto)
      if (View.frame) View.map.fitBounds(L.latLngBounds(View.frame.pts), { padding: [60, 60], maxZoom: 15 });
      await this.buildProfile();
    }

    this.updateNet();
    this.registerSW();

    State.on((what) => {
      if (what === "trace") { View.drawTrace(); this.refreshInfo(); this.renderSecSel(); }
      if (what === "feats" || what === "all") {
        View.renderAll(); this.renderRows(); View.drawTrace();
      }
      if (what === "layers" || what === "all") { View.renderLayers(); this.renderLayerList(); }
      Profile.draw();
      this.refreshInfo();
    });
  },

  applyPrefs() {
    const p = State.prefs;
    $("selBase").value = p.base;
    $("cHillEsri").checked = !!p.hillEsri;
    $("cHillLocal").checked = !!p.hillLocal;
    $("cTrace").checked = !!p.traceKm;
    $("cCursor").checked = !!p.cursor;
    $("selVE").value = String(p.ve);
    $("selCorr").value = String(p.corr);
    $("selProj").value = p.proj || "perp";
    $("selDepth").value = String(p.depth ?? 3000);
    $("selDipErr").value = String(p.dipErr || 0);
    $("inTrend").value = p.trend; $("inPlunge").value = p.plunge;
    $("plungeRow").hidden = p.proj !== "plunge";
    View.applyBase(p.base);
    View.setHillEsri(p.hillEsri);
    View.setHillLocal(p.hillLocal);
  },

  bind() {
    $$("#tools .tool").forEach((b) => b.addEventListener("click", () => View.setTool(b.dataset.tool)));
    $("rows").addEventListener("input", (e) => this.onRowInput(e));
    $("rows").addEventListener("click", (e) => this.onRowClick(e));

    $("btnUndo").onclick = () => { if (!State.undo()) toast("Nada que deshacer."); };
    $("btnDelAll").onclick = () => {
      if (!State.feats.length) return;
      modal({
        title: "Borrar datos",
        body: `<p>Se borrarán los <b>${State.feats.length}</b> datos digitalizados. La traza y la caché de mapas se conservan.</p>`,
        actions: [
          { label: "Cancelar" },
          { label: "Borrar todo", primary: true, onClick: () => { State.clear(); toast("Datos borrados.", "ok"); } },
        ],
      });
    };

    $("selBase").onchange = (e) => {
      View.applyBase(e.target.value);
      State.persist(); Profile.draw();
    };
    $("cHillEsri").onchange = (e) => View.setHillEsri(e.target.checked);
    $("cHillLocal").onchange = (e) => {
      View.setHillLocal(e.target.checked);
      State.persist();
      if (e.target.checked) toast("Calculando relieve local desde el DEM…", "", 1600);
    };
    $("cTrace").onchange = (e) => {
      State.prefs.traceKm = e.target.checked; View.drawTrace(); State.persist();
    };
    $("cCursor").onchange = (e) => {
      State.prefs.cursor = e.target.checked;
      if (!e.target.checked) View.hideTip();
      State.persist();
    };
    $("selVE").onchange = (e) => { State.prefs.ve = e.target.value; State.persist(); Profile.draw(); };
    $("selCorr").onchange = (e) => {
      State.prefs.corr = Number(e.target.value); State.persist(); Profile.draw(); this.renderRows();
      Projection.ensureZ().then((k) => { if (k) Profile.draw(); });
    };

    $("btnMenu").onclick = () => $("panel").classList.toggle("open");
    $("btnClosePanel").onclick = () => $("panel").classList.remove("open");

    $("btnZona").onclick = () => this.zoneDialog();
    $("btnImport").onclick = () => Importer.open();
    $("selSec").onchange = (e) => this.switchSection(e.target.value);
    $("layers").addEventListener("click", async (e) => {
      if (e.target.id !== "btnDemOff") return;
      await DEM.clearUser(); this.renderDemInfo();
      toast("DEM propio quitado: vuelve Terrarium 30 m.");
      if (State.trace) this.buildProfile();
    });
    $("btnSecMenu").onclick = () => this.sectionMenu();
    $("btnTraceXY").onclick = () => this.traceDialog();
    const projChanged = () => {
      State.prefs.proj = $("selProj").value;
      State.prefs.trend = clamp(Number($("inTrend").value) || 0, 0, 360);
      State.prefs.plunge = clamp(Number($("inPlunge").value) || 0, 0, 90);
      $("plungeRow").hidden = State.prefs.proj !== "plunge";
      State.persist(); State.rev++;
      Profile.draw(); this.renderRows();
      Projection.ensureZ().then((k) => { if (k) Profile.draw(); });
    };
    $("selProj").onchange = projChanged;
    $("inTrend").onchange = projChanged;
    $("inPlunge").onchange = projChanged;
    // botón «Usar como traza» dentro de la ficha de una línea
    $("map").addEventListener("click", (e) => {
      const b = e.target.closest && e.target.closest("[data-usetrace]");
      if (b) { e.stopPropagation(); this.traceFromFeature(b.dataset.usetrace); }
      const fp = e.target.closest && e.target.closest("[data-fitplane]");
      if (fp) { e.stopPropagation(); this.fitPlaneFor(fp.dataset.fitplane); }
    });
    $("lyrs").addEventListener("click", (e) => this.onLayerClick(e));
    $("lyrs").addEventListener("change", (e) => {
      const id = e.target.dataset.vis;
      const l = id && State.layers.find((x) => x.id === id);
      if (!l) return;
      l.visible = e.target.checked;
      State.emit("layers"); State.persistLayers();
    });
    $("btnExport").onclick = () => this.exportDialog();
    $("btnInstall").onclick = () => this.promptInstall();

    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      this.installEvent = e;
      $("btnInstall").hidden = false;
    });
    window.addEventListener("online", () => this.updateNet());
    window.addEventListener("offline", () => this.updateNet());

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { View.cancelDraft(); $("panel").classList.remove("open"); }
      if (e.key === "Enter" && View.draft) View.finishDraft();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (!State.undo()) toast("Nada que deshacer.");
      }
    });

    window.addEventListener("resize", debounce(() => { Profile.draw(); View.buildHill(); }, 220));

    const cv = $("pf");
    cv.addEventListener("mousemove", (e) => {
      const g = Profile.geom;
      if (!g) return;
      const r = cv.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      if (x < g.x0 || x > g.x1 || y < g.y0 || y > g.y1) { $("pfTip").hidden = true; return; }
      const s = g.xToS(x), z = g.yToZ(y);
      const zt = Profile.zAt(s);
      const tip = $("pfTip");
      tip.innerHTML = `${fmt(s / 1000, 1)} km · ${fmt(z)} m` +
        (zt == null ? "" : ` <span style="color:#8d98a5">(terreno ${fmt(zt)} m)</span>`);
      tip.style.left = x + "px";
      tip.style.top = Math.min(y, g.y1 - 6) + "px";
      tip.hidden = false;
    });
    cv.addEventListener("mouseleave", () => { $("pfTip").hidden = true; });
  },

  /* ---------- perfil ---------- */
  async buildProfile() {
    const t = State.trace;
    if (!t) { State.profile = null; Profile.draw(); return; }
    const fr = Geo.frame(t);
    if (!fr) return;
    const token = this.buildSeq = (this.buildSeq || 0) + 1;   // una traza nueva invalida lecturas viejas
    $("iHint").innerHTML = '<span style="color:#e8a33d">leyendo DEM…</span>';

    const total = fr.L;
    const n = clamp(Math.round(total / 25), 40, 800);
    const ss = Array.from({ length: n + 1 }, (_, i) => total * i / n);
    // los vértices de la traza entran como muestras exactas
    for (const sg of fr.segs) if (sg.s0 > 0) ss.push(sg.s0);
    ss.sort((a, b) => a - b);

    let zs;
    try { zs = await Promise.all(ss.map((s) => { const p = Geo.atS(fr, s); return DEM.elevation(p[0], p[1]); })); }
    catch { zs = []; }
    if (token !== this.buildSeq) return;

    const ok = zs.filter((v) => v != null);
    if (ok.length < ss.length * 0.5) {
      toast("No pude leer el DEM en esta zona. Prueba «Descargar zona» o revisa la conexión.", "bad", 4200);
      $("iHint").textContent = "Sin DEM para esta traza.";
      return;
    }

    State.profile = {
      d: ss.map((s) => s / 1000),
      z: zs.map((v) => (v == null ? null : Math.round(v))),
      vmin: Math.round(Math.min(...ok)),
      vmax: Math.round(Math.max(...ok)),
      total, az: fr.az, fuente: DEM.label(),
    };
    State.syncActive();
    State.persist();
    this.refreshInfo();
    Profile.draw();
    // cotas de los puntos cercanos (para dibujarlos a su altura y proyectar por eje)
    Projection.ensureZ().then((k) => { if (k) Profile.draw(); });
  },

  renderDemInfo() {
    const el = $("demInfo");
    if (!el) return;
    const u = DEM.user;
    el.hidden = !u;
    if (u) el.innerHTML = `<span title="${esc(u.epsg)}">DEM: ${esc(u.name)} · ${fmt(u.resM, 1)} m</span>
      <button id="btnDemOff" title="quitar el DEM propio">✕</button>`;
  },

  /* ---------- secciones ---------- */
  renderSecSel() {
    const sel = $("selSec");
    if (!sel) return;
    sel.innerHTML = State.sections.map((x) => `<option value="${x.id}"${x.id === State.secId ? " selected" : ""}>${esc(x.name)}${x.trace ? "" : " (sin traza)"}</option>`).join("");
  },

  async switchSection(id) {
    SecEdit.draft = null; SecEdit.sel = null;
    State.activate(id);
    this.renderSecSel();
    View.drawTrace();
    const fr = View.frame;
    if (fr) View.map.fitBounds(L.latLngBounds(fr.pts), { padding: [60, 60], maxZoom: 15 });
    if (State.trace && !State.profile) await this.buildProfile();
    else Profile.draw();
    this.refreshInfo();
  },

  sectionMenu() {
    const a = State.active();
    const redraw = () => { this.renderSecSel(); View.drawTrace(); Profile.draw(); this.refreshInfo(); };
    modal({
      title: "Secciones del proyecto",
      body: `<label class="field">Nombre de la sección activa
          <input id="secName" value="${esc(a ? a.name : "")}"></label>
        <p class="hint2">Cada sección guarda su traza y su perfil. Las demás se ven en el mapa
          en azul y, donde cruzan a la activa, aparecen como amarres en la sección.</p>
        <p class="hint2">${State.sections.length} sección(es): ${State.sections.map((x) => esc(x.name)).join(", ")}</p>`,
      actions: [
        { label: "Borrar esta", onClick: () => {
            if (!a) return;
            State.removeSection(a.id); redraw();
            if (State.trace && !State.profile) this.buildProfile();
          } },
        { label: "Nueva sección", onClick: () => {
            State.newSection(); redraw();
            View.setTool("trace");
            toast("Sección nueva: marca su traza en el mapa.", "", 3000);
          } },
        { label: "Guardar nombre", primary: true, onClick: () => {
            const v = $("secName").value.trim();
            if (a && v) { a.name = v; State.persist(); redraw(); }
          } },
      ],
    });
  },

  /** traza desde un punto, un azimut y un largo */
  traceDialog() {
    const c = View.map.getCenter();
    const u = Geo.utm(c.lat, c.lng);
    modal({
      title: "Traza por coordenadas",
      body: `<div class="grid2">
          <label class="field">Este UTM (m) <input id="tE" value="${u.e}" inputmode="decimal"></label>
          <label class="field">Norte UTM (m) <input id="tN" value="${u.n}" inputmode="decimal"></label>
          <label class="field">Datum y zona <select id="tZ"><option value="EPSG:32719"${u.zone === 19 ? " selected" : ""}>WGS84 / UTM 19S</option>
            <option value="EPSG:32718"${u.zone === 18 ? " selected" : ""}>WGS84 / UTM 18S</option>
            <option value="EPSG:24879">PSAD56 / UTM 19S</option><option value="EPSG:24878">PSAD56 / UTM 18S</option></select></label>
          <label class="field">El punto es <select id="tP"><option value="c">el centro</option><option value="a">el extremo A</option></select></label>
          <label class="field">Azimut (°) <input id="tAz" value="90" inputmode="decimal"></label>
          <label class="field">Largo (km) <input id="tL" value="10" inputmode="decimal"></label>
        </div>
        <p class="hint2">Azimut 90 = sección W–E. También puedes usar una línea de una capa
          importada: con «Mover», clic sobre ella → «Usar como traza».</p>`,
      actions: [
        { label: "Cancelar" },
        { label: "Trazar", primary: true, onClick: () => {
            const num = (id) => Number(String($(id).value).replace(",", "."));
            const E = num("tE"), N = num("tN"), az = num("tAz"), Lm = num("tL") * 1000;
            if (![E, N, az, Lm].every(isFinite) || Lm <= 0) { toast("Revisa los valores.", "bad"); return false; }
            CRS.init();
            const [lng, lat] = proj4($("tZ").value, "EPSG:4326", [E, N]);
            const r = (d) => d * Math.PI / 180;
            // desplazamiento en el mismo marco local que usa la sección
            const mx = 111320 * Math.cos(r(lat)), my = 110540;
            const off = (dist) => [lat + dist * Math.cos(r(az)) / my, lng + dist * Math.sin(r(az)) / mx];
            const pts = $("tP").value === "c" ? [off(-Lm / 2), off(Lm / 2)] : [[lat, lng], off(Lm)];
            State.setTrace(pts);
            View.map.fitBounds(L.latLngBounds(pts), { padding: [60, 60] });
            this.buildProfile();
          } },
      ],
    });
  },

  /** plano de mejor ajuste a una traza (contacto o falla) sobre el DEM: problema de
   *  tres puntos generalizado a todos los vértices. Solo vale si la traza «se curva»
   *  con el relieve; una traza recta deja el plano indeterminado. */
  async fitPlaneFor(id) {
    const f = State.allFeats().find((x) => x.id === id);
    if (!f || !f.pts) return;
    View.map.closePopup();
    // densifica a ~30 m para que la traza «lea» el relieve
    const pts = [];
    for (let i = 0; i < f.pts.length - 1; i++) {
      const a = f.pts[i], b = f.pts[i + 1];
      const d = L.latLng(a).distanceTo(b), n = Math.max(1, Math.ceil(d / 30));
      for (let k = 0; k < n; k++) pts.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
    }
    pts.push(f.pts[f.pts.length - 1]);
    const sample = pts.length > 400 ? pts.filter((_, i) => i % Math.ceil(pts.length / 400) === 0) : pts;
    toast("Leyendo cotas del DEM…", "", 2000);
    const zs = await Promise.all(sample.map((p) => DEM.elevation(p[0], p[1])));
    const lat0 = sample[0][0], mx = 111320 * Math.cos(lat0 * Math.PI / 180), my = 110540;
    const xyz = sample.map((p, i) => [(p[1] - sample[0][1]) * mx, (p[0] - lat0) * my, zs[i]]).filter((q) => q[2] != null);
    const r = Construct.fitPlane(xyz);
    if (!r) { toast("Sin cotas suficientes.", "bad"); return; }
    const relief = Math.max(...xyz.map((q) => q[2])) - Math.min(...xyz.map((q) => q[2]));
    // plano del TERRENO alrededor de la traza: si el ajuste se le parece, la traza no
    // restringe el manteo (sigue la ladera o el pedimento) y el resultado es engañoso
    const la = sample.map((p) => p[0]), lo = sample.map((p) => p[1]);
    const pad = 400 / my, la0 = Math.min(...la) - pad, la1 = Math.max(...la) + pad;
    const lo0 = Math.min(...lo) - 400 / mx, lo1 = Math.max(...lo) + 400 / mx;
    const grid = [];
    for (let i = 0; i <= 9; i++) for (let j = 0; j <= 9; j++) grid.push([la0 + (la1 - la0) * i / 9, lo0 + (lo1 - lo0) * j / 9]);
    const gz = await Promise.all(grid.map((p) => DEM.elevation(p[0], p[1])));
    const gxyz = grid.map((p, i) => [(p[1] - sample[0][1]) * mx, (p[0] - lat0) * my, gz[i]]).filter((q) => q[2] != null);
    const terr = Construct.fitPlane(gxyz);
    const nrm = (d, a) => [Math.sin(d * Math.PI / 180) * Math.sin(a * Math.PI / 180), Math.sin(d * Math.PI / 180) * Math.cos(a * Math.PI / 180), Math.cos(d * Math.PI / 180)];
    const ang = terr ? Math.acos(Math.min(1, nrm(r.dip, r.dir).reduce((s, v, i) => s + v * nrm(terr.dip, terr.dir)[i], 0))) * 180 / Math.PI : 99;
    const likeTerrain = ang < 15;          // umbral empírico (GB-105: trazas en pedimentos dan 3–20° hacia el lado errado)
    const hintTxt = f.dipHint != null ? Math.abs(((r.dir - f.dipHint + 540) % 360) - 180) : null;
    let warn = "";
    if (!r.ok || relief < 40) warn += `<p class="warn">La traza es casi recta o corre por terreno plano (desnivel ${fmt(relief)} m): el plano queda mal determinado.</p>`;
    if (likeTerrain) warn += `<p class="warn">El plano ajustado difiere solo ${fmt(ang, 1)}° del plano del terreno que rodea la traza
      (${fmt(terr.dip)}° hacia ${fmt(terr.dir)}°): la traza sigue la ladera y <b>no restringe el manteo</b>. No lo asignes.</p>`;
    if (hintTxt != null && hintTxt > 90) warn += `<p class="warn">La carta indica que mantea hacia ${fmt(f.dipHint)}°; el ajuste da el sentido contrario.</p>`;
    modal({
      title: "Plano ajustado a la traza",
      body: `<p><b>${fmt(r.dip)}° hacia ${fmt(r.dir)}°</b> (manteo / dirección de manteo), con ${xyz.length} puntos
          sobre el DEM, desnivel ${fmt(relief)} m, residuo RMS ${fmt(r.rms, 1)} m, ${fmt(ang, 1)}° respecto del plano del terreno.</p>${warn}
        <p class="hint2">Regla de la «V»: es el plano que mejor explica cómo la traza corta el relieve.
          Supone un plano (no curvo) y un DEM correcto; solo es confiable cuando la traza cruza valles
          y lomas con buen desnivel. Plano del terreno alrededor: ${terr ? `${fmt(terr.dip)}° hacia ${fmt(terr.dir)}°` : "—"}.</p>`,
      actions: [
        { label: "Cerrar" },
        { label: "Asignar a la entidad", primary: true, onClick: () => {
            f.dip = Math.round(r.dip); f.dipdir = Math.round(r.dir); f.fitted = true;
            State.rev++; State.persistLayers(); State.persist(); Profile.draw();
            toast(`Asignado: ${f.dip}°/${f.dipdir}°. La sección lo usa para el manteo aparente.`, "ok");
          } },
      ],
    });
  },

  /** usa una línea de una capa importada como traza */
  traceFromFeature(id) {
    const f = State.allFeats().find((x) => x.id === id);
    if (!f || !f.pts) return;
    View.map.closePopup();
    State.setTrace(f.pts);
    this.buildProfile();
    toast(`Traza tomada de la línea (${f.pts.length} vértices).`, "ok");
  },

  refreshInfo() {
    const p = State.profile, t = State.trace;
    if (!t) {
      ["iLen", "iAz", "iA", "iB", "iRel"].forEach((k) => { $(k).textContent = "—"; });
      if (View.tool !== "trace") $("iHint").textContent = "Elige «Traza» y marca los vértices de la sección (doble clic cierra), o usa ⌖ para darla por coordenadas.";
      return;
    }
    const tp = Geo.tracePts(t), fr = View.frame;
    const ua = Geo.utm(tp[0][0], tp[0][1]), ub = Geo.utm(tp[tp.length - 1][0], tp[tp.length - 1][1]);
    $("iA").textContent = `${fmt(ua.e)} E ${fmt(ua.n)} N`;
    $("iB").textContent = `${fmt(ub.e)} E ${fmt(ub.n)} N`;
    if (!p) return;
    $("iLen").textContent = fmt(p.total / 1000, 1) + " km";
    $("iAz").textContent = fr && fr.bent ? `${fr.segs.map((g) => fmt(g.az)).join("° · ")}°` : fmt(p.az, 0) + "°";
    $("iRel").textContent = `${fmt(p.vmin)} – ${fmt(p.vmax)} m`;
    $("iHint").textContent =
      `UTM ${ua.zone}${ua.hemi} · ${fmt(p.total / 1000, 1)} km con ` +
      `${fmt(p.vmax - p.vmin)} m de desnivel.`;
  },

  /* ---------- capas importadas ---------- */
  renderLayerList() {
    const box = $("lyrs");
    if (!State.layers.length) {
      box.innerHTML = `<div class="lyempty">Sin capas. <b>⤒ Importar</b> o arrastra aquí un SHP (.zip),
        KML/KMZ, GeoJSON o CSV con contactos, fallas, ejes, unidades o manteos.</div>`;
      return;
    }
    box.innerHTML = State.layers.map((l) => `<div class="lyrow">
        <input type="checkbox" data-vis="${l.id}" ${l.visible ? "checked" : ""} title="mostrar">
        <div class="txt"><b title="${esc(l.name)}">${esc(l.name)}</b><em>${esc(l.resumen || l.feats.length + " entidades")}</em></div>
        <button class="del" data-zoom="${l.id}" title="acercar a la capa">⌖</button>
        <button class="del" data-dell="${l.id}" title="quitar la capa">×</button>
      </div>`).join("");
  },

  onLayerClick(e) {
    const z = e.target.dataset.zoom, d = e.target.dataset.dell;
    if (z) Importer.zoomTo(State.layers.find((l) => l.id === z));
    if (d) {
      const l = State.layers.find((x) => x.id === d);
      if (!l) return;
      modal({
        title: "Quitar capa",
        body: `<p>Se quitará <b>${esc(l.name)}</b> (${l.feats.length} entidades). El archivo original no se toca.</p>`,
        actions: [{ label: "Cancelar" }, { label: "Quitar", primary: true, onClick: () => State.removeLayer(d) }],
      });
    }
  },

  /* ---------- panel de datos ---------- */
  renderRows() {
    const box = $("rows");
    const n = State.feats.length;
    $("cnt").textContent = `${n} dato${n === 1 ? "" : "s"}`;
    $("cnt2").textContent = n;

    if (!n) {
      box.innerHTML = `<div class="empty">Sin datos todavía.<br>
        Elige una herramienta (<b>Contacto</b>, <b>Manteo</b>, <b>Falla</b>, <b>Unidad</b> o
        <b>Estación</b>) y haz clic en el mapa.</div>`;
      return;
    }

    box.innerHTML = State.feats.map((f) => {
      const k = KIND[f.kind];
      const pr = Profile.project(f);
      const out = pr && pr.inside === false;
      let extra = "", info = "";

      if (f.kind === "contact") {
        extra = `<input class="wide" data-id="${f.id}" data-k="nota" value="${esc(f.nota || "")}" placeholder="unidad / nota">`;
        info = f.z == null ? "sin cota" : `${fmt(f.z)} m`;
        if (pr && pr.s != null) info += ` · s ${fmt(pr.s / 1000, 2)} km`;
        if (pr && pr.t != null) info += ` · ±${fmt(Math.abs(pr.t))} m`;
      } else if (f.kind === "station") {
        info = `n.º ${f.n}${f.z == null ? "" : " · " + fmt(f.z) + " m"}`;
        if (pr && pr.s != null) info += ` · s ${fmt(pr.s / 1000, 2)} km`;
      } else if (f.kind === "dip") {
        extra = `<input data-id="${f.id}" data-k="dip" value="${f.dip}" title="manteo (°)" inputmode="numeric">` +
                `<span style="color:var(--muted);margin:0 1px">/</span>` +
                `<input data-id="${f.id}" data-k="dir" value="${f.dir}" title="dirección de manteo (°)" inputmode="numeric">`;
        info = `aparente ${pr && pr.ap != null ? fmt(pr.ap, 1) + "°" : "—"}`;
        if (pr && pr.s != null) info += ` · s ${fmt(pr.s / 1000, 2)} km`;
      } else if (f.kind === "fault") {
        extra = `<input data-id="${f.id}" data-k="dip" value="${f.dip}" title="manteo de la falla (°)" inputmode="numeric">` +
                `<button class="del" data-toggle="${f.id}" title="inversa / normal">⇄</button>` +
                `<button class="del" data-inf="${f.id}" title="marcar como inferida">${f.inferida ? "≈" : "—"}</button>`;
        info = `${f.tipo} · ${f.pts.length} vért.` +
               (pr && pr.ap != null ? ` · ${fmt(pr.ap, 0)}°ap` : " · sin intersección");
        if (pr && pr.s != null) info += ` · s ${fmt(pr.s / 1000, 2)} km`;
      } else if (f.kind === "unit") {
        extra = `<input class="wide" data-id="${f.id}" data-k="nombre" value="${esc(f.nombre)}">`;
        info = `${f.pts.length} vért.`;
        if (pr && pr.inside) info += ` · s ${fmt(pr.s0 / 1000, 2)}–${fmt(pr.s1 / 1000, 2)} km`;
      }
      if (out) info = `fuera del corredor · ${info}`;

      return `<div class="drow${out ? " out" : ""}">
        <div class="badge" style="background:${k.color}">${k.badge}</div>
        <div class="txt"><b>${k.label}</b> ${extra}<em>${info}</em></div>
        <button class="del" data-del="${f.id}" title="borrar">×</button>
      </div>`;
    }).join("");
  },

  onRowInput(e) {
    const el = e.target, id = el.dataset.id;
    if (!id) return;
    const f = State.feats.find((x) => x.id === id);
    if (!f) return;
    const k = el.dataset.k;
    if (k === "dip" || k === "dir") {
      f[k] = clamp(Number(el.value) || 0, 0, k === "dip" ? 90 : 360);
    } else {
      f[k] = el.value;
    }
    View.renderFeature(f);
    Profile.draw();
    State.persist();
  },

  onRowClick(e) {
    const del = e.target.dataset.del;
    if (del) { State.remove(del); return; }
    const tg = e.target.dataset.toggle;
    if (tg) {
      const f = State.feats.find((x) => x.id === tg);
      if (f) { f.tipo = f.tipo === "inversa" ? "normal" : "inversa"; View.renderFeature(f); this.renderRows(); State.persist(); }
      return;
    }
    const inf = e.target.dataset.inf;
    if (inf) {
      const f = State.feats.find((x) => x.id === inf);
      if (f) { f.inferida = !f.inferida; View.renderFeature(f); this.renderRows(); State.persist(); }
    }
  },

  /* ---------- ejemplo ---------- */
  example(fit = true) {
    State.setTrace([[-33.505, -70.375], [-33.360, -70.155]]);
    if (fit) View.map.fitBounds(L.latLngBounds(State.trace.pts), { padding: [60, 60] });
    this.buildProfile();
  },

  /* ---------- red ---------- */
  updateNet() {
    const on = navigator.onLine;
    const el = $("net");
    el.textContent = on ? "en línea" : "sin conexión";
    el.className = "pill net " + (on ? "on" : "off");
    if (!on && State.prefs.base === "esri") {
      View.applyBase("s2");
      toast("Sin conexión: cambié el fondo a Sentinel-2 (cacheado).", "", 3600);
    }
  },

  /* ---------- service worker ---------- */
  async registerSW() {
    if (!("serviceWorker" in navigator)) return;
    // en desarrollo (localhost) sin SW, salvo ?sw=1: evita servir código viejo al editar
    if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname) && !/[?&]sw=1/.test(location.search)) {
      for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
      return;
    }
    // en desarrollo (localhost) sin SW, salvo ?sw=1: evita servir código viejo al editar
    if (/^(localhost|127.0.0.1)$/.test(location.hostname) && !/[?&]sw=1/.test(location.search)) {
      for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
      return;
    }
    try {
      const reg = await navigator.serviceWorker.register("sw.js", { scope: "./" });
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller) {
            toast("Nueva versión lista.", "", 8000);
            reg.waiting && reg.waiting.postMessage({ type: "SKIP_WAITING" });
          }
        });
      });
      navigator.serviceWorker.addEventListener("controllerchange", () => location.reload());
    } catch { /* sin SW: la app igual funciona en línea */ }
  },

  async promptInstall() {
    if (!this.installEvent) return;
    this.installEvent.prompt();
    const r = await this.installEvent.userChoice;
    if (r.outcome === "accepted") $("btnInstall").hidden = true;
    this.installEvent = null;
  },

  /* ---------- zona offline ---------- */
  async zoneDialog() {
    const b = View.map.getBounds();
    const z = View.map.getZoom();
    const jobs = Zone.plan(b, z, 1);
    const s2n = jobs.filter((j) => j.kind === "s2").length;
    const demn = jobs.filter((j) => j.kind === "dem").length;
    const est = Zone.estimate(jobs);
    const heavy = jobs.length > 1200;
    const u = await Zone.usage();

    const m = modal({
      title: "Descargar zona para uso sin conexión",
      body: `
        <p>Recuadro visible: <b>${b.getSouth().toFixed(3)}°–${b.getNorth().toFixed(3)}°</b>,
           <b>${b.getWest().toFixed(3)}°–${b.getEast().toFixed(3)}°</b> · zoom ${z}.</p>
        <p>Se guardarán <b>${demn} teselas de DEM</b> (dominio público, z${DEM.Z}) y
           <b>${s2n} de Sentinel-2</b> (CC BY-NC-SA 4.0, con atribución).</p>
        <p>Estimación: <b>${est.toFixed(1)} MB</b>. Ya hay en caché
           <b>${u.tiles} teselas (${u.mb.toFixed(1)} MB)</b>.</p>
        ${heavy ? `<p style="color:#e8a33d">Son muchas teselas (${jobs.length}).
          Acerca el mapa a la zona de interés para bajar el peso.</p>` : ""}
        <p style="color:#8d98a5;font-size:11.5px">Las imágenes Esri de alta resolución no se
           descargan: sus términos no permiten cacheo masivo. Con Sentinel-2 y el DEM
           (más el relieve calculado en el equipo) tienes la sección completa sin señal.</p>`,
      actions: [
        { label: "Cerrar" },
        { label: "Borrar caché", onClick: async () => {
            await Zone.clear();
            toast("Caché de mapas borrada.", "ok");
          } },
        { label: heavy ? "Descargar igual" : "Descargar", primary: true, onClick: (close) => {
            close();
            let cancel = false;
            const mm = modal({
              title: "Descargando zona…",
              body: `<div class="bar"><i id="zbar2"></i></div><div class="mono" id="zinfo2">0 %</div>`,
              actions: [{ label: "Cancelar", onClick: () => { cancel = true; } }],
            });
            Zone.download(jobs, (p) => {
              const b2 = $("zbar2"), i2 = $("zinfo2");
              if (b2) b2.style.width = p.pct + "%";
              if (i2) i2.innerHTML = `${p.pct} % · ${p.done}/${p.total} · ${p.mb.toFixed(1)} MB` +
                (p.failed ? ` · <span style="color:#e06c6c">${p.failed} fallidas</span>` : "");
            }, () => cancel).then((r) => {
              mm.close();
              toast(`Zona lista: ${r.cached} ya estaban, ${r.failed} fallidas, ${r.mb.toFixed(1)} MB nuevos.`,
                    r.failed ? "bad" : "ok", 6000);
            });
            return false;
          } },
      ],
    });
    return m;
  },

  /* ---------- exportación ---------- */
  exportDialog() { Export.dialog(); },

  exportJson() {
    const t = State.trace, p = State.profile, fr = View.frame;
    const out = {
      formato: "geosec/0.1",
      app: "perfiles-geologicos-pwa/1.2",
      secciones: State.sections.map((x) => ({ nombre: x.name, vertices: Geo.tracePts(x.trace) })),
      creado: new Date().toISOString(),
      crs: fr ? `EPSG:${32700 + Geo.utm(fr.a[0], fr.a[1]).zone}` : null,
      atribucion: ATTR,
      seccion: fr ? {
        nombre: (State.active() || {}).name || null,
        vertices: fr.pts,
        tramos: fr.segs.map((g) => ({ desde_m: Math.round(g.s0), largo_m: Math.round(g.len), azimut: Math.round(g.az * 10) / 10 })),
        largo_m: Math.round(fr.L),
        corredor_m: Number(State.prefs.corr),
        proyeccion: State.prefs.proj === "plunge" ? `eje ${State.prefs.trend}/${State.prefs.plunge}` : State.prefs.proj,
        fuente_dem: p ? p.fuente || "Terrarium 30 m" : null,
        amarres: Projection.ties(fr).map((x) => ({ seccion: x.name, s_m: Math.round(x.s) })),
        cota_min: p ? p.vmin : null,
        cota_max: p ? p.vmax : null,
        perfil: p ? p.d.map((d, i) => [Math.round(d * 1000), p.z[i]]) : [],
      } : null,
      capas: State.layers.map((l) => ({ nombre: l.name, origen: l.src, crs_origen: l.crs, resumen: l.resumen, visible: l.visible })),
      intersecciones: Profile.intersections().map((x) => ({ ...x, s: Math.round(x.s), z: x.z == null ? null : Math.round(x.z) })),
      superficie: Profile.surface().runs.map((r) => ({ unidad: r.f.nombre, s0_m: Math.round(r.s0), s1_m: Math.round(r.s1) })),
      datos: State.feats.map((f) => {
        const pr = Profile.project(f);
        const base = { id: f.id, kind: f.kind };
        if (f.kind === "contact") Object.assign(base, { lat: f.lat, lng: f.lng, z: f.z, nota: f.nota, color: f.color });
        if (f.kind === "station") Object.assign(base, { lat: f.lat, lng: f.lng, z: f.z, n: f.n });
        if (f.kind === "dip") Object.assign(base, { lat: f.lat, lng: f.lng, z: f.z, dip: f.dip, dir: f.dir, dip_aparente: pr ? pr.ap : null });
        if (f.kind === "fault") Object.assign(base, { pts: f.pts, tipo: f.tipo, dip: f.dip, inferida: f.inferida, dip_aparente: pr ? pr.ap : null });
        if (f.kind === "unit") Object.assign(base, { pts: f.pts, nombre: f.nombre, color: f.color });
        if (pr) base.seccion = { s_m: pr.s != null ? Math.round(pr.s) : null, t_m: pr.t != null ? Math.round(pr.t) : null, dentro: !!pr.inside };
        return base;
      }),
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    downloadBlob(blob, "seccion-geologica.json");
    if (!fr) toast("Exportado sin traza: no hay proyección a la sección.", "", 3200);
  },

  exportPng() {
    const src = $("pf");
    if (!State.profile) { toast("Todavía no hay perfil que exportar.", "bad"); return; }
    const pad = 26;
    const cv = document.createElement("canvas");
    cv.width = src.width; cv.height = src.height + pad;
    const c = cv.getContext("2d");
    c.fillStyle = "#14181e"; c.fillRect(0, 0, cv.width, cv.height);
    c.drawImage(src, 0, 0);
    const dpr = src.width / Math.max(1, src.clientWidth);
    c.fillStyle = "#6d7784";
    c.font = `${Math.round(9 * dpr)}px 'Segoe UI', sans-serif`;
    c.fillText("Sentinel-2 cloudless © EOX (CC BY-NC-SA 4.0) · DEM © AWS Terrain Tiles / Mapzen · Esri World Imagery (atribución)",
               10 * dpr, cv.height - 9 * dpr);
    cv.toBlob((blob) => downloadBlob(blob, "seccion-geologica.png"), "image/png");
  },
};

/* ------------------------------- arranque -------------------------------- */
function boot() {
  App.init().catch((err) => {
    console.error(err);
    toast("Error al iniciar: " + err.message, "bad", 6000);
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}

/* puente de depuración / pruebas */
window.__geopwa = { State, View, Profile, DEM, Geo, Zone, App, DB };
