"use strict";
/* ============================== 5. mapa ================================== */
const FAULT_COLOR = { inversa: "#e06c6c", normal: "#6fa8dc", dextral: "#f0a35e", sinestral: "#f0a35e", indeterminada: "#d94f4f" };

function featPopup(f, l) {
  const k = KIND[f.kind] || { label: f.kind };
  const head = f.kind === "unit" ? esc(f.nombre) : f.kind === "fault" ? `Falla ${f.tipo} · ${f.dip}°`
    : f.kind === "axis" ? `Eje ${f.tipo}` : f.kind === "dip" ? `Manteo ${f.dip}°/${f.dir}°` : k.label;
  const rows = Object.entries(f.props || {}).filter(([, v]) => v != null && v !== "" && typeof v !== "object").slice(0, 14)
    .map(([a, v]) => `<tr><td style="color:#8d98a5;padding-right:8px">${esc(a)}</td><td>${esc(String(v).slice(0, 80))}</td></tr>`).join("");
  return `<b>${head}</b>${f.inferida ? " <i>(inferida)</i>" : ""}<br><span style="color:#8d98a5">${esc(l.name)}</span>` +
    (rows ? `<table style="margin-top:4px;font-size:11px">${rows}</table>` : "") +
    (f.pts && f.kind !== "unit" ? `<div style="display:flex;gap:6px;margin-top:6px">
      <button data-usetrace="${f.id}" style="background:#e8a33d;color:#161a20;border:0;border-radius:5px;padding:4px 9px;font-weight:700;cursor:pointer">Usar como traza</button>
      ${f.kind === "fault" || f.kind === "cline" ? `<button data-fitplane="${f.id}" style="background:#2b313b;color:#e6ebf1;border:1px solid #333b47;border-radius:5px;padding:4px 9px;cursor:pointer" title="Plano de mejor ajuste a la traza sobre el DEM">Ajustar plano</button>` : ""}
      </div>` : "") +
    (f.dip != null && (f.kind === "cline" || f.dipdir != null) ? `<div style="margin-top:4px;color:#8d98a5">${f.fitted ? "plano ajustado: " : ""}${fmt(f.dip)}°${f.dipdir != null ? " / " + fmt(f.dipdir) + "°" : ""}</div>` : "");
}
const ATTR = 'Imágenes © Esri, Maxar, Earthstar Geographics · Sentinel-2 cloudless © EOX ' +
             '(CC BY-NC-SA 4.0) · DEM © AWS Terrain Tiles / Mapzen · Leaflet';

const HOST = {
  esri: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  relief: "https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}",
  s2: "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg",
};
const S2_URL = (z, x, y) => HOST.s2.replace("{z}", z).replace("{y}", y).replace("{x}", x);
const DEM_URL = (z, x, y) => DEM.url(z, x, y);

const View = {
  map: null,
  frame: null,
  layers: {},
  base: null,
  hillEsri: null,
  hillLocal: null,
  hillTimer: 0,
  gTrace: null,
  gFeat: null,
  draft: null,
  tool: "move",
  editor: null,           // input de edición de la traza abierto

  init() {
    const map = this.map = L.map("map", {
      zoomControl: false, attributionControl: true, preferCanvas: true,
    }).setView([-33.40, -70.45], 11);

    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.control.scale({ imperial: false, position: "bottomleft" }).addTo(map);

    // pane de sombras (multiply sobre las teselas)
    map.createPane("hill");
    const hp = map.getPane("hill");
    hp.style.zIndex = 250;
    hp.style.pointerEvents = "none";
    hp.style.mixBlendMode = "multiply";

    this.layers = {
      esri: L.tileLayer(HOST.esri, { maxZoom: 19, maxNativeZoom: 19, attribution: ATTR }),
      s2: L.tileLayer(HOST.s2, { maxZoom: 18, maxNativeZoom: 14, attribution: ATTR }),
      relieve: L.tileLayer(HOST.relief, { maxZoom: 16, attribution: ATTR }),
    };
    this.hillEsri = L.tileLayer(HOST.relief, {
      maxZoom: 16, maxNativeZoom: 13, opacity: 0.8, pane: "hill", attribution: ATTR,
    });

    // las trazas en su propio panel (SVG) para quedar sobre las capas importadas (canvas)
    map.createPane("traces").style.zIndex = 450;
    this.rTrace = L.svg({ pane: "traces" });
    this.gLayers = L.layerGroup().addTo(map);   // capas importadas (debajo de lo dibujado)
    this.gTrace = L.layerGroup().addTo(map);
    this.gFeat = L.layerGroup().addTo(map);

    map.on("click", (e) => this.onClick(e));
    map.on("dblclick", () => { if (this.draft) this.finishDraft(); });
    map.on("mousemove", (e) => this.onMove(e));
    map.on("mouseout", () => this.hideTip());
    map.on("moveend", () => this.scheduleHill());

    this.tip = L.DomUtil.create("div", "", map.getContainer());
    this.tip.style.cssText = "position:absolute;z-index:700;pointer-events:none;" +
      "background:rgba(20,24,30,.9);border:1px solid #333b47;border-radius:4px;" +
      "padding:2px 6px;font:10.5px 'Segoe UI';color:#e6ebf1;display:none;" +
      "transform:translate(10px,10px);white-space:nowrap";

    this.applyBase(State.prefs.base);
    this.setTool("move");
    this.drawTrace();
    this.renderLayers();
    this.renderAll();
    this.scheduleHill();
  },

  /* ---------- capas importadas ---------- */
  lineStyle(f) {
    const dash = f.inferida ? "7 5" : null;
    if (f.kind === "fault") return { color: FAULT_COLOR[f.tipo] || "#d94f4f", weight: 2.4, dashArray: dash };
    if (f.kind === "axis") return { color: /sincl/.test(f.tipo) ? "#7fd0e8" : /anticl/.test(f.tipo) ? "#e58ad6" : "#d8b4f0", weight: 2, dashArray: dash || (/volcad/.test(f.tipo) ? "10 3 2 3" : null) };
    if (f.kind === "lineament") return { color: "#9fb4c8", weight: 1.3, dashArray: "2 4" };
    return { color: "#eef2f6", weight: 1.4, dashArray: dash };   // contacto
  },

  renderLayers() {
    const g = this.gLayers;
    g.clearLayers();
    const order = { unit: 0, cline: 1, lineament: 1, axis: 2, fault: 3, contact: 4, station: 4, dip: 5 };
    for (const l of State.layers) {
      if (!l.visible) continue;
      const fs = l.feats.slice().sort((a, b) => order[a.kind] - order[b.kind]);
      const manyDips = fs.filter((f) => f.kind === "dip").length > 400;
      for (const f of fs) {
        let lay;
        if (f.kind === "unit") {
          lay = L.polygon(f.rings, { color: f.color, weight: 0.7, opacity: .9, fillColor: f.color, fillOpacity: .32 });
        } else if (f.pts) {
          lay = L.polyline(f.pts, { opacity: .95, ...this.lineStyle(f) });
        } else if (f.kind === "dip" && !manyDips) {
          lay = L.marker([f.lat, f.lng], { icon: this.dipIcon(f), interactive: true });
        } else {
          lay = L.circleMarker([f.lat, f.lng], { radius: f.kind === "dip" ? 3 : 4.5, color: "#14181e", weight: 1.2,
            fillColor: (KIND[f.kind] || {}).color || "#ccc", fillOpacity: 1 });
        }
        // ficha solo con «Mover»: al dibujar, el clic es un vértice
        lay.on("click", (e) => {
          if (this.tool !== "move") return;
          L.popup({ maxWidth: 300 }).setLatLng(e.latlng).setContent(featPopup(f, l)).openOn(this.map);
        });
        lay.addTo(g);
      }
    }
  },

  /* ---------- capas ---------- */
  applyBase(key) {
    const map = this.map;
    for (const k in this.layers) {
      if (map.hasLayer(this.layers[k])) map.removeLayer(this.layers[k]);
    }
    if (key !== "none" && this.layers[key]) {
      this.base = this.layers[key].addTo(map);
      this.base.bringToBack();
    } else this.base = null;
    State.prefs.base = key;
    $("selBase").value = key;
  },

  setHillEsri(on) {
    if (on) this.hillEsri.addTo(this.map); else this.map.removeLayer(this.hillEsri);
    State.prefs.hillEsri = !!on;
    this.scheduleHill();
  },

  setHillLocal(on) {
    State.prefs.hillLocal = !!on;
    if (!on && this.hillLocal) { this.map.removeLayer(this.hillLocal); this.hillLocal = null; }
    this.scheduleHill();
  },

  scheduleHill() {
    clearTimeout(this.hillTimer);
    this.hillTimer = setTimeout(() => { this.buildHill(); }, 420);
  },

  async buildHill() {
    const map = this.map;
    if (!State.prefs.hillLocal) {
      if (this.hillLocal) { map.removeLayer(this.hillLocal); this.hillLocal = null; }
      return;
    }
    if (map.getZoom() < 9) return;
    const b = map.getBounds().pad(0.02);
    if (!b.isValid()) return;
    const w = map.getSize().x;
    // zoom del DEM acorde al del mapa: evita pedir cientos de teselas
    const z = clamp(Math.round(map.getZoom()), 10, DEM.Z);
    try {
      const { canvas } = await DEM.hillshade(b, w, z);
      const url = canvas.toDataURL("image/png");
      if (this.hillLocal) this.hillLocal.setUrl(url).setBounds(b);
      else this.hillLocal = L.imageOverlay(url, b,
        { pane: "hill", opacity: 0.62, interactive: false, className: "hillimg" }).addTo(map);
    } catch { /* sin DEM */ }
  },

  /* ---------- traza ---------- */
  drawTrace() {
    const g = this.gTrace;
    g.clearLayers();
    this.frame = Geo.frame(State.trace);

    // otras secciones del proyecto, en gris, con su nombre
    for (const o of State.others()) {
      const pts = Geo.tracePts(o.trace);
      L.polyline(pts, { color: "#0d1117", weight: 5, opacity: .55, renderer: this.rTrace, interactive: false }).addTo(g);
      L.polyline(pts, { color: "#8fb6e6", weight: 2.6, opacity: .95, dashArray: "7 4", renderer: this.rTrace })
        .on("click", () => { if (this.tool === "move") App.switchSection(o.id); })
        .bindTooltip(`${o.name} · clic para activarla`, { sticky: true }).addTo(g);
      L.marker(pts[0], { interactive: false, icon: L.divIcon({ className: "",
        html: `<div style="color:#8fb6e6;font:600 10px 'Segoe UI';white-space:nowrap;
          transform:translate(-50%,-160%);text-shadow:0 0 3px #000,0 0 3px #000">${esc(o.name)}</div>` }) }).addTo(g);
    }

    const fr = this.frame;
    if (!fr) return;
    const pts = fr.pts;
    L.polyline(pts, { color: "#0d1117", weight: 5.5, opacity: .55, renderer: this.rTrace, interactive: false }).addTo(g);
    L.polyline(pts, { color: "#e8a33d", weight: 2.8, opacity: 1, renderer: this.rTrace, interactive: false }).addTo(g);

    const sec = State.active();
    const nm = sec ? sec.name.split("–") : ["A", "A'"];
    const badge = (p, txt) => L.marker(p, { interactive: false, icon: L.divIcon({ className: "",
      html: `<div style="background:#14181e;color:#e8a33d;border:1px solid #e8a33d;
        border-radius:4px;padding:1px 5px;font:600 10px 'Segoe UI';white-space:nowrap;
        transform:translate(-50%,-150%)">${esc(txt)}</div>` }) }).addTo(g);
    badge(pts[0], nm[0] || "A"); badge(pts[pts.length - 1], nm[1] || "B");

    // vértices arrastrables (con «Mover»): se edita la traza y se recalcula el perfil
    pts.forEach((p, i) => {
      const m = L.marker(p, { draggable: true, icon: L.divIcon({ className: "",
        iconSize: [12, 12], iconAnchor: [6, 6],
        html: `<div style="width:12px;height:12px;border-radius:50%;background:#e8a33d;
          border:2px solid #14181e;cursor:move"></div>` }) });
      m.on("dragend", () => {
        const ll = m.getLatLng();
        const np = pts.map((q) => [q[0], q[1]]);
        np[i] = [ll.lat, ll.lng];
        State.setTrace(np);
        App.buildProfile();
      });
      m.on("contextmenu", () => {          // clic derecho quita un vértice intermedio
        if (pts.length <= 2) return;
        State.setTrace(pts.filter((_, k) => k !== i));
        App.buildProfile();
      });
      m.addTo(g);
    });

    if (State.prefs.traceKm) {
      for (let km = 1; km * 1000 < fr.L; km++) {
        const p = Geo.atS(fr, km * 1000);
        L.circleMarker(p, { radius: 2.4, color: "#14181e", weight: 1, fillColor: "#fff", fillOpacity: .9, interactive: false, renderer: this.rTrace }).addTo(g);
        if (fr.L > 12000 && km % 5 === 0) {
          L.marker(p, { interactive: false, icon: L.divIcon({ className: "",
            html: `<div style="color:#dbe3ea;font:10px 'Segoe UI';
              transform:translate(-50%,-50%);text-shadow:0 0 3px #000,0 0 3px #000">${km}</div>` }) }).addTo(g);
        }
      }
    }
  },

  /* ---------- entidades ---------- */
  renderAll() {
    this.gFeat.clearLayers();
    for (const f of State.feats) this.renderFeature(f);
  },

  dipIcon(f) {
    const half = 15, tick = 6 + Number(f.dip) * 0.24;
    return L.divIcon({
      className: "", iconSize: [36, 36], iconAnchor: [18, 18],
      html: `<div style="width:36px;height:36px;cursor:move">
        <svg width="36" height="36" viewBox="-18 -18 36 36" style="overflow:visible">
          <g transform="rotate(${f.dir})">
            <line x1="${-half}" y1="0" x2="${half}" y2="0" stroke="#0b0e12" stroke-width="4"/>
            <line x1="${-half}" y1="0" x2="${half}" y2="0" stroke="#7fe0c0" stroke-width="2"/>
            <line x1="0" y1="0" x2="0" y2="${-tick}" stroke="#0b0e12" stroke-width="4"/>
            <line x1="0" y1="0" x2="0" y2="${-tick}" stroke="#7fe0c0" stroke-width="2"/>
            <line x1="-3.2" y1="${-tick}" x2="3.2" y2="${-tick}" stroke="#7fe0c0" stroke-width="2"/>
          </g>
        </svg>
        <div style="position:absolute;left:50%;top:100%;transform:translate(-50%,-1px);
          font:600 10px 'Segoe UI';color:#dff7ee;text-shadow:0 0 3px #000,0 0 2px #000;
          white-space:nowrap">${f.dip}°/${f.dir}°</div>
      </div>`,
    });
  },

  renderFeature(f) {
    if (f._layer) { this.gFeat.removeLayer(f._layer); f._layer = null; }
    if (f._label) { this.gFeat.removeLayer(f._label); f._label = null; }

    if (f.kind === "contact") {
      f._layer = L.circleMarker([f.lat, f.lng], {
        radius: 6.5, color: "#14181e", weight: 2.5,
        fillColor: f.color || "#c9d3dd", fillOpacity: 1,
      }).bindTooltip(`Contacto · ${f.z == null ? "s/elev" : fmt(f.z) + " m"}${f.nota ? " · " + esc(f.nota) : ""}`);

    } else if (f.kind === "station") {
      f._layer = L.marker([f.lat, f.lng], {
        icon: L.divIcon({
          className: "", iconSize: [22, 22], iconAnchor: [11, 11],
          html: `<div style="width:22px;height:22px;border-radius:50%;background:#e8c15a;
            color:#161a20;border:2px solid #14181e;display:grid;place-items:center;
            font:700 10px 'Segoe UI'">${f.n}</div>`,
        }),
      }).bindTooltip(`Estación ${f.n}${f.z == null ? "" : " · " + fmt(f.z) + " m"}`);

    } else if (f.kind === "dip") {
      f._layer = L.marker([f.lat, f.lng], { icon: this.dipIcon(f), draggable: true });
      f._layer.on("dragend", () => {
        const p = f._layer.getLatLng();
        f.lat = p.lat; f.lng = p.lng;
        State.touch();
      });

    } else if (f.kind === "fault") {
      f._layer = L.polyline(f.pts, {
        color: FAULT_COLOR[f.tipo] || "#d94f4f",
        weight: 3, opacity: .95, dashArray: f.inferida ? "7 5" : null,
      }).bindTooltip(`${f.tipo} · ${f.dip}°${f.inferida ? " (inferida)" : ""}`);

    } else if (f.kind === "unit") {
      f._layer = L.polygon(f.pts, {
        color: f.color, weight: 2, opacity: .95, fillColor: f.color, fillOpacity: .24,
      });
      const n = f.pts.length;
      const cl = f.pts.reduce((s, p) => s + p[0], 0) / n;
      const cg = f.pts.reduce((s, p) => s + p[1], 0) / n;
      f._label = L.marker([cl, cg], {
        icon: L.divIcon({
          className: "", iconSize: [10, 10], iconAnchor: [5, 5],
          html: `<div style="transform:translate(-50%,-50%);white-space:nowrap;
            font:700 11px 'Segoe UI';color:${f.color};
            text-shadow:0 0 4px #000,0 0 4px #000">${esc(f.nombre)}</div>`,
        }),
        interactive: false,
      });
    }

    if (f._layer) f._layer.addTo(this.gFeat);
    if (f._label) f._label.addTo(this.gFeat);
  },

  /* ---------- herramientas ---------- */
  setTool(t) {
    this.cancelDraft();
    this._first = null;
    this.tool = t;
    $$("#tools .tool").forEach((b) => b.classList.toggle("on", b.dataset.tool === t));
    this.map.doubleClickZoom[t === "fault" || t === "unit" || t === "trace" ? "disable" : "enable"]();
    this.map.getContainer().style.cursor = t === "move" ? "" : "crosshair";
    $("iHint").textContent = {
      move: "Arrastra el mapa. Los símbolos de manteo se mueven con el mouse.",
      trace: "Clic por vértice de la traza (puede ser quebrada); doble clic o Enter la cierra. Con «Mover» arrastras los vértices; clic derecho quita uno.",
      contact: "Un clic por contacto entre unidades; toma la cota del DEM.",
      dip: "Un clic por estación de manteo; edita manteo/dirección en el panel.",
      fault: "Clic por vértice; doble clic cierra la falla.",
      unit: "Clic por vértice; doble clic cierra el polígono.",
      station: "Un clic por estación o punto de observación.",
    }[t];
  },

  startDraft(kind, latlng) {
    this.draft = { kind, pts: [[latlng.lat, latlng.lng]], line: null, rubber: null };
    this.updateDraft();
  },

  updateDraft() {
    const d = this.draft;
    if (!d) return;
    if (d.line) this.gFeat.removeLayer(d.line);
    d.line = L.polyline(d.pts, {
      color: "#e8a33d", weight: 2, dashArray: "6 4", opacity: .9,
    }).addTo(this.gFeat);
  },

  updateRubber(latlng) {
    const d = this.draft;
    if (!d || !d.pts.length) return;
    const last = d.pts[d.pts.length - 1];
    const ll = [latlng.lat, latlng.lng];
    if (!d.rubber) {
      d.rubber = L.polyline([last, ll], {
        color: "#e8a33d", weight: 1, dashArray: "3 5", opacity: .55,
      }).addTo(this.gFeat);
    } else d.rubber.setLatLngs([last, ll]);
  },

  dedupe(pts) {
    const out = [];
    for (const p of pts) {
      const q = out[out.length - 1];
      if (!q || L.latLng(q).distanceTo(L.latLng(p)) > 3) out.push(p);
    }
    return out;
  },

  finishDraft() {
    const d = this.draft;
    if (!d) return;
    d.pts = this.dedupe(d.pts);
    if (d.line) this.gFeat.removeLayer(d.line);
    if (d.rubber) this.gFeat.removeLayer(d.rubber);

    if (d.kind === "trace") {
      if (d.pts.length >= 2) {
        State.setTrace(d.pts);
        App.buildProfile();
      } else toast("La traza necesita al menos 2 vértices.");
    } else if (d.kind === "fault" && d.pts.length >= 2) {
      State.add({
        id: State.nextId(), kind: "fault", pts: d.pts.map((p) => [p[0], p[1]]),
        tipo: "inversa", dip: 45, inferida: false,
      });
    } else if (d.kind === "unit" && d.pts.length >= 3) {
      const n = State.feats.filter((x) => x.kind === "unit").length;
      State.add({
        id: State.nextId(), kind: "unit", pts: d.pts.map((p) => [p[0], p[1]]),
        nombre: `Unidad ${String.fromCharCode(65 + (n % 26))}`,
        color: UNIT_COLORS[n % UNIT_COLORS.length],
      });
    } else if (d.kind === "fault") {
      toast("Una falla necesita al menos 2 vértices.");
    }
    this.draft = null;
  },

  cancelDraft() {
    const d = this.draft;
    if (d) {
      if (d.line) this.gFeat.removeLayer(d.line);
      if (d.rubber) this.gFeat.removeLayer(d.rubber);
    }
    this.draft = null;
  },

  async onClick(e) {
    const t = this.tool;
    if (t === "move") return;
    const tgt = e.originalEvent && e.originalEvent.target;
    if (tgt && tgt.closest && tgt.closest(".leaflet-marker-icon")) return;

    if (t === "trace") {
      if (!this.draft) this.startDraft("trace", e.latlng);
      else { this.draft.pts.push([e.latlng.lat, e.latlng.lng]); this.updateDraft(); }
      $("iHint").textContent = `${this.draft.pts.length} vértice(s). Doble clic o Enter cierra la traza.`;
      return;
    }

    if (t === "contact" || t === "dip" || t === "station") {
      const z = await DEM.elevation(e.latlng.lat, e.latlng.lng);
      const f = { id: State.nextId(), kind: t, lat: e.latlng.lat, lng: e.latlng.lng, z };
      if (t === "contact") {
        f.nota = "";
        f.color = UNIT_COLORS[State.feats.filter((x) => x.kind === "contact").length % UNIT_COLORS.length];
      } else if (t === "station") {
        f.n = State.feats.filter((x) => x.kind === "station").length + 1;
      } else { f.dip = 30; f.dir = 90; }
      State.add(f);
      if (z == null) toast("Sin DEM en este punto: la cota queda vacía.", "bad", 2200);
      return;
    }

    if (t === "fault" || t === "unit") {
      if (!this.draft) this.startDraft(t, e.latlng);
      else { this.draft.pts.push([e.latlng.lat, e.latlng.lng]); this.updateDraft(); }
    }
  },

  async onMove(e) {
    if (this.draft) this.updateRubber(e.latlng);
    if (!State.prefs.cursor) { this.hideTip(); return; }
    const z = await DEM.elevation(e.latlng.lat, e.latlng.lng);
    if (z == null) { this.hideTip(); return; }
    const cp = e.containerPoint;
    this.tip.textContent = `${fmt(z)} m`;
    this.tip.style.left = cp.x + "px";
    this.tip.style.top = cp.y + "px";
    this.tip.style.display = "block";
  },

  hideTip() { if (this.tip) this.tip.style.display = "none"; },
};

