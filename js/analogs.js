"use strict";
/* =============================================================================
   analogs.js — secciones análogas publicadas (catálogo extraído del
   RAG-Bibliografía, tools/perfiles en ese repo).

   · Lista: las andinas por distancia a la traza activa; las mundiales por estilo.
   · Ficha: cita, parámetros (despegue, rampas, acortamiento, P/S…) con la
     evidencia textual de cada uno.
   · Figura de fondo en la sección, calibrada en 3 pasos:
       1) escala horizontal: 2 clics en la barra de escala + su largo en km
       2) escala vertical: 2 clics en dos marcas del eje de cotas + sus cotas
       3) anclaje: clic en un rasgo de la figura y clic donde va en tu sección
     Transformación imagen → sección: s = ax + bx·px ; z = az + bz·py.
   · «Usar parámetros»: P/S y ángulo apical al panel de cinemática, guía del
     despegue en la sección y cotas de la inversión trishear desde las fichas
     del mismo estilo.

   Datos: datos/analogos/catalogo.json (+ img/) publicados (solo fuentes de
   licencia abierta) y un paquete local importado (catalogo-local.zip) que se
   guarda en IndexedDB y no sale del equipo.
   Las funciones puras van en AnalogMath (también se cargan en Node).
   ========================================================================== */

const AnalogMath = (() => {
  const R = 6371;
  const rad = (d) => d * Math.PI / 180;

  function haversine(a, b) {
    const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  /** centro de una ficha: punto medio de la traza, o su `centro` */
  function center(f) {
    const t = f.traza || {};
    if (Array.isArray(t.a) && Array.isArray(t.b)) return [(t.a[0] + t.b[0]) / 2, (t.a[1] + t.b[1]) / 2];
    if (Array.isArray(f.centro)) return f.centro;
    return null;
  }

  /** distancia (km) del centro de la ficha a la traza [[lat,lng]…], al tramo
   *  más cercano (plano local equirectangular: basta para ordenar) */
  function distTo(f, pts) {
    const c = center(f);
    if (!c || !pts || !pts.length) return Infinity;
    const kx = 111.195 * Math.cos(rad(c[0])), ky = 111.195;
    const P = pts.map((p) => [(p[1] - c[1]) * kx, (p[0] - c[0]) * ky]);
    if (P.length === 1) return haversine(c, pts[0]);
    let best = Infinity;
    for (let i = 0; i < P.length - 1; i++) {
      const [x1, y1] = P[i], [x2, y2] = P[i + 1];
      const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy || 1e-12;
      const u = Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / L2));
      best = Math.min(best, Math.hypot(x1 + u * dx, y1 + u * dy));
    }
    return best;
  }

  /** orden: andinas por distancia; mundiales detrás, por coincidencia de estilo */
  function sortFor(fichas, pts, estilo) {
    return fichas
      .map((f) => ({ f, d: distTo(f, pts) }))
      .sort((x, y) => {
        const ax = x.f.ambito === "andes" ? 0 : 1, ay = y.f.ambito === "andes" ? 0 : 1;
        if (ax !== ay) return ax - ay;
        if (ax === 1 && estilo) {
          const ex = x.f.estilo === estilo ? 0 : 1, ey = y.f.estilo === estilo ? 0 : 1;
          if (ex !== ey) return ex - ey;
        }
        return x.d - y.d;
      });
  }

  /** transformación por defecto: la figura ocupa el largo de la sección */
  function defaultCal(imgW, imgH, L, zTop, ve) {
    const bx = L / imgW;
    return { ax: 0, bx, az: zTop, bz: -bx / (ve || 1) };
  }

  const toSec = (cal, px, py) => [cal.ax + cal.bx * px, cal.az + cal.bz * py];
  const toImg = (cal, s, z) => [(s - cal.ax) / cal.bx, (z - cal.az) / cal.bz];

  /** escala horizontal: dos puntos de imagen separados `L` metros; conserva el
   *  punto 1 en su lugar y la proporción vertical/horizontal */
  function calH(cal, p1, p2, L) {
    const dpx = Math.abs(p2[0] - p1[0]);
    if (!(dpx > 0) || !(L > 0)) return cal;
    const [s1] = toSec(cal, p1[0], p1[1]);
    const bx = L / dpx, k = bx / cal.bx;
    const [, z1] = toSec(cal, p1[0], p1[1]);
    const bz = cal.bz * k;
    return { ax: s1 - bx * p1[0], bx, az: z1 - bz * p1[1], bz };
  }

  /** escala vertical: dos puntos de imagen con cotas z1, z2 (m) */
  function calV(cal, p1, p2, z1, z2) {
    const dpy = p2[1] - p1[1];
    if (!dpy || !isFinite(z1) || !isFinite(z2) || z1 === z2) return cal;
    const bz = (z2 - z1) / dpy;
    return { ...cal, bz, az: z1 - bz * p1[1] };
  }

  /** anclaje: el punto de imagen p va a (s, z) de la sección */
  function anchor(cal, p, s, z) {
    return { ...cal, ax: s - cal.bx * p[0], az: z - cal.bz * p[1] };
  }

  /** cotas para la inversión trishear desde fichas del mismo estilo */
  function bounds(fichas) {
    const take = (get) => fichas.map(get).filter((v) => typeof v === "number" && isFinite(v));
    const rng = (v, lo, hi, pad) => (v.length ? [Math.max(lo, Math.min(...v) - pad), Math.min(hi, Math.max(...v) + pad)] : null);
    const dips = take((f) => (f.fallas || [])[0] && f.fallas[0].manteo_rampa);
    return {
      ps: rng(take((f) => f.ps), 0.3, 5, 0.3),
      apical: rng(take((f) => f.angulo_apical), 20, 120, 10),
      dip: rng(dips, 5, 85, 5),
      n: fichas.length,
    };
  }

  return { haversine, center, distTo, sortFor, defaultCal, toSec, toImg, calH, calV, anchor, bounds };
})();

if (typeof module !== "undefined") module.exports = AnalogMath;

/* ------------------------------- interfaz ---------------------------------- */
const Analogs = (typeof window === "undefined") ? null : {
  fichas: [],          // publicadas + locales
  imgs: new Map(),     // nombre → objectURL (locales) o ruta
  _img: new Map(),     // nombre → HTMLImageElement cargada
  loaded: false,
  cal: null,           // {step: "h"|"v"|"a", pts: [...]} durante la calibración
  view: { q: "", ambito: "", estilo: "", sel: null },

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    let pub = [];
    try {
      const r = await fetch("datos/analogos/catalogo.json");
      if (r.ok) pub = (await r.json()).fichas || [];
    } catch { /* sin conexión y sin caché */ }
    pub.forEach((f) => { f._src = "pub"; if (f.figura && f.figura.img) this.imgs.set(f.figura.img, "datos/analogos/img/" + f.figura.img); });
    let loc = [];
    try {
      const pk = await DB.get("analogos-local");
      if (pk && Array.isArray(pk.fichas)) {
        loc = pk.fichas.map((f) => ({ ...f, _src: "local" }));
        for (const [n, blob] of Object.entries(pk.imgs || {})) this.imgs.set(n, URL.createObjectURL(blob));
      }
    } catch { /* nada */ }
    const ids = new Set(loc.map((f) => f.id));
    this.fichas = loc.concat(pub.filter((f) => !ids.has(f.id)));
  },

  byId(id) { return this.fichas.find((f) => f.id === id) || null; },

  async importZip(file) {
    const zip = await JSZip.loadAsync(file);
    const cj = zip.file(/catalogo\.json$/i)[0];
    if (!cj) throw new Error("el zip no trae catalogo.json");
    const fichas = JSON.parse(await cj.async("string")).fichas || [];
    const imgs = {};
    for (const e of zip.file(/\.(jpe?g|png|webp)$/i)) imgs[e.name.split("/").pop()] = await e.async("blob");
    await DB.set("analogos-local", { fichas, imgs, at: Date.now() });
    this.loaded = false; this.imgs.clear(); this._img.clear();
    await this.load();
    return fichas.length;
  },

  /* ------------------------------ panel ------------------------------------ */
  async open() {
    const p = $("anaPanel");
    p.hidden = !p.hidden;
    if (p.hidden) { this.cal = null; return; }
    p.innerHTML = `<div class="kh"><b>Secciones análogas</b><button id="aClose">✕</button></div><div class="kmsg">Cargando catálogo…</div>`;
    $("aClose").onclick = () => this.open();
    await this.load();
    this.render();
  },

  estilos: { piel_delgada: "piel delgada", piel_gruesa: "piel gruesa", mixto: "mixto", inversion: "inversión tectónica", extensional: "extensional" },

  render() {
    const p = $("anaPanel");
    if (p.hidden) return;
    const v = this.view;
    if (v.sel) return this.renderFicha(this.byId(v.sel));
    const pts = View.frame ? View.frame.pts : null;
    let list = AnalogMath.sortFor(this.fichas, pts, v.estilo);
    if (v.ambito) list = list.filter((x) => x.f.ambito === v.ambito);
    if (v.estilo) list = list.filter((x) => x.f.estilo === v.estilo);
    if (v.q) {
      const q = v.q.toLowerCase();
      list = list.filter((x) => [x.f.cita, x.f.region, x.f.cordillera, x.f.resumen].join(" ").toLowerCase().includes(q));
    }
    const bg = (State.active() || {}).bg;
    p.innerHTML = `
      <div class="kh"><b>Secciones análogas</b><button id="aClose" title="cerrar">✕</button></div>
      <div class="kr"><input id="aQ" placeholder="buscar: autor, región…" value="${esc(v.q)}"></div>
      <div class="kr"><select id="aAmb"><option value="">Andes y mundo</option><option value="andes"${v.ambito === "andes" ? " selected" : ""}>Andes</option><option value="mundial"${v.ambito === "mundial" ? " selected" : ""}>análogos mundiales</option></select>
        <select id="aEst"><option value="">todo estilo</option>${Object.entries(this.estilos).map(([k, t]) => `<option value="${k}"${v.estilo === k ? " selected" : ""}>${t}</option>`).join("")}</select></div>
      ${bg ? `<div class="kf ok">Figura de fondo: ${esc((this.byId(bg.id) || {}).cita || bg.id)} <button id="aBgGo">ajustar</button></div>` : ""}
      <div class="alist">${list.length ? list.map(({ f, d }) => `
        <button class="aitem" data-id="${esc(f.id)}">
          <b>${esc(f.cita || "?")}</b> <span class="adist">${isFinite(d) && f.ambito === "andes" ? fmt(d) + " km" : esc(f.ambito === "mundial" ? (f.cordillera || "mundo") : "")}</span><br>
          <span>${esc(f.region || "")}</span> · <i>${esc(this.estilos[f.estilo] || f.estilo || "")}</i>${f.acortamiento && f.acortamiento.km != null ? ` · acort. ${fmtKm(f.acortamiento.km)} km` : ""}${f._src === "local" ? ' <span class="pill">local</span>' : ""}
        </button>`).join("") : `<div class="kmsg">${this.fichas.length ? "Nada con esos filtros." : "Catálogo vacío: importa el paquete local con «⤒ Importar paquete»."}</div>`}</div>
      <div class="kb"><button id="aImp" title="Importar catalogo-local.zip (fichas y figuras que no se publican)">⤒ Importar paquete</button></div>
      <div class="kmsg">Las fichas salen de la bibliografía y se revisaron contra el PDF, pero úsalas como hipótesis: cada valor trae su cita.</div>`;
    $("aClose").onclick = () => this.open();
    $("aQ").oninput = (e) => { v.q = e.target.value; this.render(); const i = $("aQ"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); };
    $("aAmb").onchange = (e) => { v.ambito = e.target.value; this.render(); };
    $("aEst").onchange = (e) => { v.estilo = e.target.value; this.render(); };
    p.querySelectorAll(".aitem").forEach((b) => (b.onclick = () => { v.sel = b.dataset.id; this.render(); }));
    if ($("aBgGo")) $("aBgGo").onclick = () => { v.sel = bg.id; this.render(); };
    $("aImp").onclick = () => {
      const inp = document.createElement("input");
      inp.type = "file"; inp.accept = ".zip";
      inp.onchange = async () => {
        try { const n = await this.importZip(inp.files[0]); toast(`${n} fichas locales importadas.`, "ok"); this.render(); }
        catch (e) { toast("No se pudo importar: " + e.message, "bad"); }
      };
      inp.click();
    };
  },

  renderFicha(f) {
    const p = $("anaPanel");
    if (!f) { this.view.sel = null; return this.render(); }
    const ev = f.evidencia || {};
    const evi = (k) => ev[k] ? ` <span class="aev" title="${esc(ev[k].texto || ev[k])}${ev[k].pagina ? " (p. " + ev[k].pagina + ")" : ""}">❝</span>` : "";
    // valores interpretativos o numéricos sin cita: se muestran, pero marcados
    const NEED = new Set(["despegues", "fallas", "acortamiento", "ps", "angulo_apical", "edad_deformacion", "ve"]);
    const mark = (k) => (ev[k] ? evi(k) : NEED.has(k) ? ' <span class="anoev" title="La fuente no da una frase que respalde este valor: no está verificado.">sin cita</span>' : "");
    const row = (k, label, val) => (val == null || val === "" ? "" : `<div class="row"><span class="k">${label}</span><span class="v">${val}${mark(k)}</span></div>`);
    const desp = (f.despegues || []).map((d) => `${d.prof_km != null ? fmtKm(d.prof_km) + " km" : "?"}${d.nivel ? " en " + esc(d.nivel) : ""}`).join("; ");
    const fallas = (f.fallas || []).filter((x) => x.manteo_rampa != null || x.desplazamiento_km != null)
      .map((x) => `${esc(x.nombre || x.tipo || "falla")}${x.manteo_rampa != null ? " " + fmt(x.manteo_rampa) + "°" : ""}${x.desplazamiento_km != null ? ", " + fmtKm(x.desplazamiento_km) + " km" : ""}`).join("; ");
    const ac = f.acortamiento || {};
    const bg = (State.active() || {}).bg;
    const mine = bg && bg.id === f.id;
    p.innerHTML = `
      <div class="kh"><button id="aBack" title="volver">‹</button><b>${esc(f.cita || "")}</b><button id="aClose" title="cerrar">✕</button></div>
      <div class="kmsg">${esc(f.resumen || "")}</div>
      ${f.revision_geologica ? `<div class="kmsg">✓ Revisada por geólogo (${esc(f.revision_geologica.fecha || "")})${f.revision_geologica.nota ? ": " + esc(f.revision_geologica.nota) : ""}</div>` : `<div class="kmsg">Sin revisión geológica.</div>`}
      ${row("region", "Región", esc([f.region, f.cordillera].filter(Boolean).join(" · ")))}
      ${row("estilo", "Estilo", esc(this.estilos[f.estilo] || f.estilo || ""))}
      ${row("vergencia", "Vergencia", esc(f.vergencia || ""))}
      ${row("despegues", "Despegue", desp)}
      ${row("fallas", "Rampas", fallas)}
      ${row("acortamiento", "Acortamiento", ac.km != null || ac.pct != null ? `${ac.km != null ? fmtKm(ac.km) + " km" : ""}${ac.pct != null ? " (" + fmt(ac.pct) + " %)" : ""}` : "")}
      ${row("ps", "P/S", f.ps != null ? fmt(f.ps, 1) : "")}
      ${row("angulo_apical", "Ángulo apical", f.angulo_apical != null ? fmt(f.angulo_apical) + "°" : "")}
      ${row("edad_deformacion", "Edad", esc(f.edad_deformacion || ""))}
      ${row("metodo", "Método", esc((f.metodo || []).join(", ")))}
      ${row("ve", "Exag. vertical", f.ve != null ? fmt(f.ve, 1) + "×" : "")}
      <div class="kmsg">Fig. ${esc(f.figura && f.figura.num || "?")}, p. ${esc(f.figura && f.figura.pagina || "?")}${f.doi ? ` · <a href="https://doi.org/${esc(f.doi)}" target="_blank" rel="noopener">doi:${esc(f.doi)}</a>` : ""}${f.traza && f.traza.confianza ? ` · ubicación ${esc(f.traza.confianza)}` : ""}</div>
      ${f.figura && f.figura.img ? `<img class="athumb" src="${esc(this.imgs.get(f.figura.img) || "")}" alt="figura">` : ""}
      <div class="kb">${f.figura && f.figura.img ? `<button id="aBg" class="pri">${mine ? "Quitar figura" : "▣ Figura de fondo"}</button>` : ""}<button id="aUse">⚙ Usar parámetros</button></div>
      ${mine ? `<div class="kr"><span>Transparencia</span><input id="aAlpha" type="range" min="0.1" max="1" step="0.05" value="${bg.alpha ?? 0.55}"></div>
        <div class="kb"><button id="aCH" title="2 clics en los extremos de la barra de escala">↔ Escala H</button><button id="aCV" title="2 clics en dos marcas del eje de cotas">↕ Escala V</button><button id="aCA" title="clic en un rasgo de la figura y luego donde va en tu sección">⌖ Anclar</button></div>
        <div id="aCalMsg" class="kmsg">${this.calHint()}</div>` : ""}`;
    $("aClose").onclick = () => this.open();
    $("aBack").onclick = () => { this.view.sel = null; this.cal = null; this.render(); };
    if ($("aBg")) $("aBg").onclick = () => (mine ? this.clearBg() : this.setBg(f));
    $("aUse").onclick = () => this.useParams(f);
    if (mine) {
      $("aAlpha").oninput = (e) => { bg.alpha = Number(e.target.value); State.persist(); Profile.draw(); };
      $("aCH").onclick = () => this.startCal("h");
      $("aCV").onclick = () => this.startCal("v");
      $("aCA").onclick = () => this.startCal("a");
    }
  },

  /* ---------------------------- figura de fondo ---------------------------- */
  image(name) {
    if (!name) return null;
    let im = this._img.get(name);
    if (!im) {
      const url = this.imgs.get(name);
      if (!url) return null;          // catálogo aún sin cargar: no guardar una imagen rota
      im = new Image();
      im.onload = () => Profile.draw();
      im.src = url;
      this._img.set(name, im);
    }
    return im.complete && im.naturalWidth ? im : null;
  },

  setBg(f) {
    const sec = State.active();
    const g = Profile.geom;
    if (!sec || !g) { toast("Primero traza una sección.", "bad"); return; }
    const im = new Image();
    im.onload = () => {
      this._img.set(f.figura.img, im);
      sec.bg = { id: f.id, img: f.figura.img, alpha: 0.55,
        cal: AnalogMath.defaultCal(im.naturalWidth, im.naturalHeight, g.dmax * 1000, g.vhi, f.ve || 1) };
      State.persist(); Profile.draw(); this.render();
      toast("Ajusta la figura: Escala H, Escala V y Anclar.", "", 4000);
    };
    im.onerror = () => toast("No se pudo cargar la figura (¿sin conexión?).", "bad");
    im.src = this.imgs.get(f.figura.img) || "";
  },

  clearBg() {
    const sec = State.active();
    if (sec) delete sec.bg;
    this.cal = null;
    State.persist(); Profile.draw(); this.render();
  },

  /** dibuja la figura de fondo (Profile.draw, tras la rejilla) */
  drawBg(c, g) {
    const sec = State.active();
    const bg = sec && sec.bg;
    if (!bg || !bg.cal) return;
    const im = this.image(bg.img);
    if (!im) return;
    const [s0, z0] = AnalogMath.toSec(bg.cal, 0, 0);
    const [s1, z1] = AnalogMath.toSec(bg.cal, im.naturalWidth, im.naturalHeight);
    c.save();
    c.globalAlpha = bg.alpha ?? 0.55;
    c.drawImage(im, g.X(s0), g.Y(z0), g.X(s1) - g.X(s0), g.Y(z1) - g.Y(z0));
    c.restore();
    if (this.cal) {
      c.save(); c.fillStyle = "#ffd166"; c.strokeStyle = "#14181e";
      for (const q of this.cal.pts) {
        const [s, z] = q.img ? AnalogMath.toSec(bg.cal, q.img[0], q.img[1]) : [q.s, q.z];
        c.beginPath(); c.arc(g.X(s), g.Y(z), 4, 0, Math.PI * 2); c.fill(); c.stroke();
      }
      c.restore();
    }
  },

  calHint() {
    const c = this.cal;
    if (!c) return "Calibra con la barra de escala y el eje de cotas de la figura; luego ánclala a tu sección.";
    const n = c.pts.length;
    if (c.step === "h") return n === 0 ? "Clic en un extremo de la barra de escala." : "Clic en el otro extremo.";
    if (c.step === "v") return n === 0 ? "Clic en una marca del eje de cotas." : "Clic en otra marca del eje (lejos de la primera).";
    return n === 0 ? "Clic en un rasgo de la FIGURA (p. ej., una falla en superficie)." : "Clic donde ese rasgo va en TU sección.";
  },

  startCal(step) {
    this.cal = { step, pts: [] };
    if (typeof SecEdit !== "undefined") SecEdit.setTool("view");
    const m = $("aCalMsg");
    if (m) m.textContent = this.calHint();
    Profile.draw();
  },

  /** clic en la sección durante la calibración; true si lo consumió */
  calClick(p) {
    const sec = State.active();
    if (!this.cal || !sec || !sec.bg) return false;
    const cal = sec.bg.cal;
    const st = this.cal;
    const img = AnalogMath.toImg(cal, p.s, p.z);
    if (st.step === "a" && st.pts.length === 1) st.pts.push({ s: p.s, z: p.z });
    else st.pts.push({ img });
    if (st.pts.length === 2) {
      const [a, b] = st.pts;
      if (st.step === "h") {
        const km = Number(String(prompt("Largo de la barra de escala (km):", "5") || "").replace(",", "."));
        sec.bg.cal = AnalogMath.calH(cal, a.img, b.img, km * 1000);
      } else if (st.step === "v") {
        const r = String(prompt("Cotas de las dos marcas en m, separadas por «;» (primera; segunda). Bajo el nivel del mar con signo menos:", "0; -5000") || "");
        const [z1, z2] = r.split(/[;\s]+/).filter(Boolean).map((x) => Number(x.replace(",", ".")));
        sec.bg.cal = AnalogMath.calV(cal, a.img, b.img, z1, z2);
      } else {
        sec.bg.cal = AnalogMath.anchor(cal, a.img, b.s, b.z);
      }
      this.cal = null;
      State.persist();
    }
    const m = $("aCalMsg");
    if (m) m.textContent = this.calHint();
    Profile.draw();
    return true;
  },

  /* ------------------------- parámetros a la cinemática --------------------- */
  useParams(f) {
    const notes = [];
    if (typeof KinPanel !== "undefined") {
      if (f.ps != null) { KinPanel.o.ps = f.ps; notes.push(`P/S ${fmt(f.ps, 1)}`); }
      if (f.angulo_apical != null) { KinPanel.o.apical = f.angulo_apical; notes.push(`apical ${fmt(f.angulo_apical)}°`); }
      const same = this.fichas.filter((x) => x.estilo === f.estilo);
      const b = AnalogMath.bounds(same.length >= 2 ? same : [f]);
      KinPanel.bounds = { ...b, from: `${b.n} ficha(s) de estilo ${this.estilos[f.estilo] || f.estilo || "?"}` };
      if (b.dip) notes.push(`rampa ${fmt(b.dip[0])}–${fmt(b.dip[1])}° (cotas de inversión)`);
    }
    const d = (f.despegues || []).find((x) => x.prof_km != null);
    const g = Profile.geom;
    if (d && g && typeof SecEdit !== "undefined") {
      // profundidad bajo el nivel del mar salvo que la ficha diga «bajo la superficie»
      const ref = d.referencia === "superficie" ? (State.profile ? avgZ(State.profile) : 0) : 0;
      const z = ref - d.prof_km * 1000;
      SecEdit.add({ kind: "guide", pts: [[0, z], [g.dmax * 1000, z]], name: `despegue ${fmtKm(d.prof_km)} km (${f.cita || ""})`, color: "#9b8cff" });
      notes.push(`guía de despegue a ${fmt(z)} m`);
    }
    toast(notes.length ? "Desde la ficha: " + notes.join(" · ") : "La ficha no trae parámetros numéricos.", notes.length ? "ok" : "", 5000);
    if (typeof KinPanel !== "undefined" && !$("kinPanel").hidden) KinPanel.render();
  },

  bind() {
    const b = document.querySelector('#secBar [data-act="analogs"]');
    if (b) b.onclick = () => this.open();
    // una sección guardada con figura de fondo: cargar el catálogo para poder dibujarla
    if (State.sections.some((s) => s.bg)) this.load().then(() => Profile.draw());
    State.on((what) => { if (what === "trace" && !$("anaPanel").hidden && !this.view.sel) this.render(); });
  },
};

/** km con un decimal solo si lo tiene */
function fmtKm(v) { return fmt(v, Math.abs(v % 1) > 1e-9 ? 1 : 0); }

function avgZ(p) {
  const z = (p.z || []).filter((v) => v != null);
  return z.length ? z.reduce((a, b) => a + b, 0) / z.length : 0;
}
