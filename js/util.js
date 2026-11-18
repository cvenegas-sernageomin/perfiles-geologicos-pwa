/* =============================================================================
   Perfiles geológicos — PWA
   app.js  ·  un solo archivo, sin build ni dependencias (solo Leaflet local)
   -----------------------------------------------------------------------------
   0  utilidades            4  estado y persistencia
   1  IndexedDB             5  mapa, capas y herramientas
   2  geodesia              6  sección (proyección + dibujo)
   3  DEM (Terrarium)       7  descarga de zona · 8 UI y arranque
   ========================================================================== */
"use strict";

/* =============================== 0. utilidades ============================ */
const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmt = (v, d = 0) => (v === null || v === undefined || !isFinite(v)) ? "—"
  : Number(v).toLocaleString("es-CL", { minimumFractionDigits: d, maximumFractionDigits: d });
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function debounce(fn, ms) {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

let toastTimer = 0;
function toast(msg, kind = "", ms = 3000) {
  const el = $("toast");
  el.textContent = msg;
  el.className = "toast" + (kind ? " " + kind : "");
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function modal({ title, body, actions }) {
  const root = $("modal");
  $("mTitle").textContent = title;
  $("mBody").innerHTML = body;
  const acts = $("mActs");
  acts.innerHTML = "";
  const close = () => { root.hidden = true; };
  (actions || [{ label: "Cerrar" }]).forEach((a) => {
    const b = document.createElement("button");
    b.textContent = a.label;
    if (a.primary) b.className = "primary";
    b.onclick = () => { if (!a.onClick || a.onClick(close) !== false) close(); };
    acts.appendChild(b);
  });
  root.hidden = false;
  return { close, body: $("mBody"), acts };
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

