"use strict";
/* ========================== 4. estado y persistencia ====================== */
const UNIT_COLORS = ["#8fb56a", "#c9a15a", "#b4765c", "#7fa0b5", "#9b8ac9", "#b57fa0"];
const KIND = {
  contact: { label: "Contacto", badge: "C", color: "#c9d3dd" },
  dip:     { label: "Manteo",   badge: "∠", color: "#7fe0c0" },
  fault:   { label: "Falla",    badge: "F", color: "#e06c6c" },
  unit:    { label: "Unidad",   badge: "U", color: "#9c8ac9" },
  station: { label: "Estación", badge: "E", color: "#e8c15a" },
  cline:   { label: "Contacto (traza)", badge: "C", color: "#c9d3dd" },
  axis:    { label: "Traza axial", badge: "A", color: "#e58ad6" },
  lineament: { label: "Lineamiento", badge: "L", color: "#9fb4c8" },
};

const State = {
  feats: [],
  seq: 1,
  trace: null,             // sección activa: {pts:[[lat,lng],…]} (quebrada si > 2)
  profile: null,           // {d:[km de chainage], z:[m], vmin, vmax, total, az, fuente}
  sections: [],            // [{id, name, trace, profile}] — la activa se sincroniza al guardar
  secId: null,
  prefs: {
    base: "s2", hillEsri: false, hillLocal: true, traceKm: true, cursor: true,
    ve: "2", corr: 300,
    proj: "perp", trend: 0, plunge: 0,     // proyección: perp | strike | plunge (eje de pliegue)
    depth: 3000, dipErr: 0,                // profundidad bajo el relieve; ± error de manteos
  },
  layers: [],              // capas importadas: {id,name,src,visible,feats[],resumen}
  rev: 0,                  // sube con cada cambio de datos (invalida cachés de la sección)
  history: [],
  subs: [],
  saving: false,

  on(fn) { this.subs.push(fn); },
  emit(what = "all") { this.rev++; for (const fn of this.subs) fn(what); },

  /** entidades dibujadas + las de capas visibles */
  allFeats() {
    const out = [];
    for (const l of this.layers) if (l.visible) for (const f of l.feats) out.push(f);
    for (const f of this.feats) out.push(f);
    return out;
  },

  addLayer(l) { this.layers.push(l); this.emit("layers"); this.persistLayers(); },
  removeLayer(id) {
    this.layers = this.layers.filter((l) => l.id !== id);
    this.emit("layers"); this.persistLayers();
  },
  async persistLayers() {
    try {
      await DB.set("layers", this.layers.map((l) => ({
        ...l, feats: l.feats.map(({ _layer, _label, ...r }) => r),
      })));
    } catch { /* cuota llena */ }
  },

  snapshot() {
    // las claves "_" son capas de Leaflet (circulares): fuera del historial
    this.history.push(JSON.stringify(this.feats, (k, v) => (k[0] === "_" ? undefined : v)));
    if (this.history.length > 80) this.history.shift();
  },

  undo() {
    if (!this.history.length) return false;
    this.feats = JSON.parse(this.history.pop());
    this.seq = Math.max(1, ...this.feats.map((f) => Number(String(f.id).slice(1)) || 0)) + 1;
    this.emit("feats");
    this.persist();
    return true;
  },

  nextId() { return "f" + (this.seq++); },

  add(f) { this.snapshot(); this.feats.push(f); this.emit("feats"); this.persist(); },

  remove(id) {
    const i = this.feats.findIndex((x) => x.id === id);
    if (i < 0) return;
    this.snapshot();
    this.feats.splice(i, 1);
    this.emit("feats");
    this.persist();
  },

  clear() {
    if (!this.feats.length) return;
    this.snapshot();
    this.feats = []; this.seq = 1;
    this.emit("feats");
    this.persist();
  },

  /** fija la traza de la sección activa: lista de vértices [[lat,lng],…] */
  setTrace(pts) {
    this.trace = Array.isArray(pts) && pts.length >= 2 ? { pts: pts.map((p) => [p[0], p[1]]) } : null;
    this.profile = null;
    this.syncActive();
    this.emit("trace");
    this.persist();
  },

  /* ---------- varias secciones ---------- */
  active() { return this.sections.find((x) => x.id === this.secId) || null; },
  syncActive() {
    let a = this.active();
    if (!a) {
      a = { id: "s" + Date.now().toString(36), name: this.nextSecName() };
      this.sections.push(a); this.secId = a.id;
    }
    a.trace = this.trace; a.profile = this.profile;
  },
  nextSecName() {
    const used = new Set(this.sections.map((x) => x.name));
    for (let i = 0; i < 26; i++) {
      const c = String.fromCharCode(65 + i);
      const n = `${c}–${c}'`;
      if (!used.has(n)) return n;
    }
    return "Sección " + (this.sections.length + 1);
  },
  newSection() {
    this.syncActive();
    const s = { id: "s" + Date.now().toString(36), name: this.nextSecName(), trace: null, profile: null };
    this.sections.push(s);
    this.activate(s.id);
    return s;
  },
  activate(id) {
    if (id !== this.secId) this.syncActive();
    const s = this.sections.find((x) => x.id === id);
    if (!s) return;
    this.secId = id;
    this.trace = s.trace || null;
    this.profile = s.profile || null;
    this.emit("trace");
    this.persist();
  },
  removeSection(id) {
    this.sections = this.sections.filter((x) => x.id !== id);
    if (!this.sections.length) { this.secId = null; this.trace = null; this.profile = null; this.syncActive(); }
    else if (this.secId === id) { this.secId = null; this.activate(this.sections[0].id); return; }
    this.emit("trace"); this.persist();
  },
  /** secciones distintas de la activa que tienen traza (para amarres) */
  others() { return this.sections.filter((x) => x.id !== this.secId && x.trace); },

  touch() { this.emit("feats"); this.persist(); },

  persist: debounce(async function () {
    try {
      await DB.set("state", {
        // sin las capas de Leaflet: no se pueden clonar a IndexedDB
        feats: State.feats.map(({ _layer, _label, ...r }) => r), seq: State.seq, trace: State.trace,
        profile: State.profile, prefs: State.prefs, savedAt: Date.now(),
        sections: (State.syncActive(), State.sections), secId: State.secId,
      });
    } catch { /* cuota llena */ }
  }, 350),

  async restore() {
    try {
      const ls = await DB.get("layers");
      if (Array.isArray(ls)) this.layers = ls;
      const o = await DB.get("state");
      if (!o) return this.layers.length > 0;
      if (Array.isArray(o.feats)) this.feats = o.feats;
      if (o.seq) this.seq = o.seq;
      const fixTrace = (t) => { const p = Geo.tracePts(t); return p ? { pts: p } : null; };   // v1: {a,b}
      if (o.trace) this.trace = fixTrace(o.trace);
      if (o.profile && Array.isArray(o.profile.d)) this.profile = o.profile;
      if (o.prefs) Object.assign(this.prefs, o.prefs);
      if (Array.isArray(o.sections) && o.sections.length) {
        this.sections = o.sections.map((x) => ({ ...x, trace: fixTrace(x.trace) }));
        this.secId = o.secId && this.sections.some((x) => x.id === o.secId) ? o.secId : this.sections[0].id;
        const a = this.active();
        this.trace = a.trace; this.profile = a.profile;
      }
      return true;
    } catch { return false; }
  },
};

