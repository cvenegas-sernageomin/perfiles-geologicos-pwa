"use strict";
/* =============================================================================
   import.js — capas geológicas desde archivo
   SHP (.zip o .shp/.dbf/.prj/.cpg sueltos) · KML/KMZ · GeoJSON · CSV de puntos
   -----------------------------------------------------------------------------
   1. CRS (proj4) y lectura del .prj
   2. lectores → "capas crudas" {name, fc (GeoJSON), crs, fields}
   3. clasificación automática (rol por valor de atributo)
   4. asistente de mapeo (modal) → capa normalizada en State.layers
   ========================================================================== */

/* ------------------------------ 1. CRS ----------------------------------- */
const CRS = {
  defs: {
    "EPSG:4326":  ["WGS84 geográficas (lat/lon)", "+proj=longlat +datum=WGS84 +no_defs"],
    "EPSG:32719": ["WGS84 / UTM 19S", "+proj=utm +zone=19 +south +datum=WGS84 +units=m +no_defs"],
    "EPSG:32718": ["WGS84 / UTM 18S", "+proj=utm +zone=18 +south +datum=WGS84 +units=m +no_defs"],
    "EPSG:24879": ["PSAD56 / UTM 19S", "+proj=utm +zone=19 +south +ellps=intl +towgs84=-288,175,-376,0,0,0,0 +units=m +no_defs"],
    "EPSG:24878": ["PSAD56 / UTM 18S", "+proj=utm +zone=18 +south +ellps=intl +towgs84=-288,175,-376,0,0,0,0 +units=m +no_defs"],
    "EPSG:29189": ["SAD69 / UTM 19S", "+proj=utm +zone=19 +south +ellps=aust_SA +towgs84=-57,1,-41,0,0,0,0 +units=m +no_defs"],
    "EPSG:29188": ["SAD69 / UTM 18S", "+proj=utm +zone=18 +south +ellps=aust_SA +towgs84=-57,1,-41,0,0,0,0 +units=m +no_defs"],
    "EPSG:4248":  ["PSAD56 geográficas", "+proj=longlat +ellps=intl +towgs84=-288,175,-376,0,0,0,0 +no_defs"],
    "EPSG:4618":  ["SAD69 geográficas", "+proj=longlat +ellps=aust_SA +towgs84=-57,1,-41,0,0,0,0 +no_defs"],
  },

  ready: false,
  init() {
    if (this.ready || !window.proj4) return;
    for (const k in this.defs) proj4.defs(k, this.defs[k][1]);
    this.ready = true;
  },

  options(sel) {
    return Object.keys(this.defs).map((k) =>
      `<option value="${k}"${k === sel ? " selected" : ""}>${this.defs[k][0]}</option>`).join("");
  },

  /** EPSG a partir del texto de un .prj (WKT de ESRI u OGC); null si no lo reconoce */
  fromPrj(txt) {
    if (!txt) return null;
    const t = txt.toUpperCase();
    const m = t.match(/AUTHORITY\["EPSG",\s*"?(\d+)"?\]\s*\]\s*$/);
    if (m && this.defs["EPSG:" + m[1]]) return "EPSG:" + m[1];
    const psad = /PSAD|PROVISIONAL_S(OUTH)?_AMERICAN/.test(t);
    const sad = /SAD_?1969|SAD69|SOUTH_AMERICAN_1969/.test(t);
    const z = t.match(/ZONE[_ ]?(\d{2})\s*S|UTM[_ ]ZONE[_ ]?(\d{2})S?/);
    const zone = z ? Number(z[1] || z[2]) : null;
    const projected = /PROJCS|PROJCRS/.test(t);
    if (projected && zone) {
      if (psad) return `EPSG:${24860 + zone}`;
      if (sad) return `EPSG:${29170 + zone}`;
      // SIRGAS y WGS84 difieren < 1 m: se tratan igual
      if (/WGS_?(19)?84|WGS 84|SIRGAS/.test(t)) return `EPSG:${32700 + zone}`;
    }
    if (!projected) {
      if (psad) return "EPSG:4248";
      if (sad) return "EPSG:4618";
      if (/WGS_?(19)?84|WGS 84|SIRGAS/.test(t)) return "EPSG:4326";
    }
    return null;
  },

  /** zona UTM probable según el mapa (Chile: 18S al oeste de 72° W) */
  guessProjected() {
    const c = View.map ? View.map.getCenter() : { lng: -70.5 };
    return c.lng < -72 ? "EPSG:32718" : "EPSG:32719";
  },

  /** ¿las coordenadas parecen proyectadas (metros)? */
  looksProjected(fc) {
    let n = 0, big = 0;
    walkCoords(fc, (c) => { n++; if (Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90) big++; return n < 200; });
    return n > 0 && big / n > 0.5;
  },

  /** reproyecta en sitio un FeatureCollection a WGS84 [lng,lat] */
  toWgs84(fc, from) {
    if (!from || from === "EPSG:4326") return fc;
    this.init();
    const tr = proj4(from, "EPSG:4326");
    mapCoords(fc, (c) => { const p = tr.forward([c[0], c[1]]); return [p[0], p[1]]; });
    return fc;
  },
};

function walkCoords(fc, fn) {
  const rec = (a) => {
    if (typeof a[0] === "number") return fn(a) !== false;
    for (const b of a) if (!rec(b)) return false;
    return true;
  };
  for (const f of fc.features) if (f.geometry && f.geometry.coordinates) if (!rec(f.geometry.coordinates)) return;
}

function mapCoords(fc, fn) {
  const rec = (a) => (typeof a[0] === "number" ? fn(a) : a.map(rec));
  for (const f of fc.features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === "GeometryCollection") g.geometries.forEach((h) => { h.coordinates = rec(h.coordinates); });
    else g.coordinates = rec(g.coordinates);
  }
}

/* ---------------------------- 2. lectores -------------------------------- */
const Readers = {
  ext(name) { const m = /\.([^.]+)$/.exec(name.toLowerCase()); return m ? m[1] : ""; },
  stem(name) { return name.replace(/\.[^.]+$/, ""); },

  /** FileList / File[] → capas crudas */
  async read(files) {
    const out = [], shpSets = new Map(), errors = [];
    for (const f of files) {
      const e = this.ext(f.name);
      try {
        if (["shp", "dbf", "prj", "cpg", "shx"].includes(e)) {
          const k = this.stem(f.name).toLowerCase();
          if (!shpSets.has(k)) shpSets.set(k, { name: this.stem(f.name) });
          shpSets.get(k)[e] = e === "prj" || e === "cpg" ? await f.text() : await f.arrayBuffer();
        } else if (e === "zip") out.push(...await this.zip(await f.arrayBuffer(), this.stem(f.name)));
        else if (e === "kmz") out.push(...await this.kmz(await f.arrayBuffer(), this.stem(f.name)));
        else if (e === "kml") out.push(...this.kml(await f.text(), this.stem(f.name)));
        else if (e === "geojson" || e === "json") out.push(...this.geojson(await f.text(), this.stem(f.name)));
        else if (e === "csv" || e === "txt" || e === "tsv") out.push(this.csv(await f.text(), this.stem(f.name)));
        else errors.push(`${f.name}: formato no soportado`);
      } catch (err) {
        console.error(err);
        errors.push(`${f.name}: ${err.message || err}`);
      }
    }
    for (const set of shpSets.values()) {
      if (!set.shp) { if (set.dbf) errors.push(`${set.name}: falta el .shp`); continue; }
      try { out.push(await this.shpSet(set)); }
      catch (err) { console.error(err); errors.push(`${set.name}.shp: ${err.message || err}`); }
    }
    return { layers: out.filter((l) => l && l.fc.features.length), errors };
  },

  /** juego .shp/.dbf/.prj/.cpg → capa cruda. El .prj lo resolvemos nosotros:
   *  los WKT de ESRI para PSAD56/SAD69 no traen TOWGS84 y proj4 los dejaría
   *  ~400 m corridos. Solo si no lo reconocemos se lo pasamos a shpjs. */
  async shpSet(set) {
    const crs = CRS.fromPrj(set.prj);
    const usePrj = set.prj && !crs;
    const parse = async (cpg) => {
      const r = await shp({ shp: set.shp, dbf: set.dbf, cpg, prj: usePrj ? set.prj : undefined });
      return Array.isArray(r) ? r[0] : r;
    };
    let fc = await parse(set.cpg);
    // .dbf sin .cpg de ArcGIS en castellano: suele venir en Windows-1252, no UTF-8
    if (!set.cpg && set.dbf && hasBadChars(fc)) fc = await parse("windows-1252");
    const projected = CRS.looksProjected(fc);
    return {
      name: set.name, fc, src: "shp",
      crs: crs || (projected ? null : "EPSG:4326"),
      needsCrs: !crs && projected,
      prjText: set.prj || "",
      note: !set.prj ? "sin .prj" : crs ? CRS.defs[crs][0] : (usePrj ? "reproyectado por el .prj" : ""),
    };
  },

  async zip(buf, name) {
    const z = await JSZip.loadAsync(buf);
    const sets = new Map(), out = [];
    const entries = Object.values(z.files).filter((f) => !f.dir && !/__MACOSX|\/\._/.test(f.name));
    for (const f of entries) {
      const e = this.ext(f.name);
      const base = f.name.split("/").pop();
      if (["shp", "dbf", "prj", "cpg"].includes(e)) {
        const k = f.name.replace(/\.[^.]+$/, "").toLowerCase();
        if (!sets.has(k)) sets.set(k, { name: this.stem(base) });
        sets.get(k)[e] = e === "prj" || e === "cpg" ? await f.async("string") : await f.async("arraybuffer");
      } else if (e === "kml") out.push(...this.kml(await f.async("string"), this.stem(base)));
      else if (e === "geojson") out.push(...this.geojson(await f.async("string"), this.stem(base)));
    }
    for (const s of sets.values()) if (s.shp) out.push(await this.shpSet(s));
    if (!out.length) throw new Error(`el zip «${name}» no trae .shp, .kml ni .geojson`);
    return out;
  },

  async kmz(buf, name) {
    const z = await JSZip.loadAsync(buf);
    const kmls = Object.values(z.files).filter((f) => !f.dir && /\.kml$/i.test(f.name));
    if (!kmls.length) throw new Error("el KMZ no trae ningún .kml");
    const main = kmls.find((f) => /(^|\/)doc\.kml$/i.test(f.name)) || kmls[0];
    return this.kml(await main.async("string"), name);
  },

  /** KML → una capa cruda por carpeta y tipo de geometría */
  kml(txt, name) {
    const dom = new DOMParser().parseFromString(txt, "text/xml");
    if (dom.getElementsByTagName("parsererror").length) throw new Error("KML mal formado");
    const tree = toGeoJSON.kmlWithFolders(dom);
    const groups = new Map();
    const walk = (node, path) => {
      for (const ch of node.children || []) {
        if (ch.type === "folder") walk(ch, path.concat(ch.meta && ch.meta.name ? ch.meta.name : "carpeta"));
        else if (ch.type === "Feature" && ch.geometry) {
          ch.properties = ch.properties || {};
          if (path.length) ch.properties.carpeta = path[path.length - 1];
          // MultiGeometry primero se separa; si no, queda como capa «other» aparte
          for (const part of explodeCollections(ch)) {
            const gt = geomFamily(part.geometry.type);
            if (gt === "other") continue;
            const key = path.join(" / ") + "|" + gt;
            if (!groups.has(key)) groups.set(key, { path: path.join(" / "), gt, feats: [] });
            groups.get(key).feats.push(part);
          }
        }
      }
    };
    walk(tree, []);
    const multi = new Set([...groups.values()].map((g) => g.path)).size < groups.size;
    return [...groups.values()].map((g) => ({
      name: (g.path ? `${name} · ${g.path}` : name) + (multi || !g.path ? ` · ${GT_LABEL[g.gt]}` : ""),
      fc: { type: "FeatureCollection", features: g.feats },
      src: "kml", crs: "EPSG:4326", needsCrs: false, note: GT_LABEL[g.gt],
    }));
  },

  geojson(txt, name) {
    let o = JSON.parse(txt);
    if (o.type === "Feature") o = { type: "FeatureCollection", features: [o] };
    if (o.type !== "FeatureCollection") throw new Error("no es un FeatureCollection");
    let crs = "EPSG:4326";
    const cn = o.crs && o.crs.properties && o.crs.properties.name;
    if (cn) { const m = /EPSG::?(\d+)/.exec(cn); if (m) crs = CRS.defs["EPSG:" + m[1]] ? "EPSG:" + m[1] : null; }
    const projected = CRS.looksProjected(o);
    if (!projected) crs = crs || "EPSG:4326";
    o.features = o.features.map(explodeCollections).flat();
    // una capa por tipo de geometría
    const by = new Map();
    for (const f of o.features) {
      if (!f.geometry) continue;
      const gt = geomFamily(f.geometry.type);
      if (!by.has(gt)) by.set(gt, []);
      by.get(gt).push(f);
    }
    return [...by.entries()].map(([gt, fs]) => ({
      name: by.size > 1 ? `${name} · ${GT_LABEL[gt]}` : name,
      fc: { type: "FeatureCollection", features: fs },
      src: "geojson", crs: projected ? crs : "EPSG:4326",
      needsCrs: projected && !crs, note: "",
    }));
  },

  /** CSV de puntos: lat/lon o este/norte; separador , ; o tabulación */
  csv(txt, name) {
    txt = txt.replace(/^﻿/, "");
    const lines = txt.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) throw new Error("CSV vacío");
    const head = lines[0];
    const sep = [";", "\t", ","].map((s) => [s, head.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
    const split = (l) => {
      const out = []; let cur = "", q = false;
      for (const ch of l) {
        if (ch === '"') q = !q;
        else if (ch === sep && !q) { out.push(cur); cur = ""; }
        else cur += ch;
      }
      out.push(cur);
      return out.map((s) => s.trim());
    };
    const fields = split(head);
    const rows = lines.slice(1).map(split);
    const find = (re) => fields.findIndex((f) => re.test(f));
    const num = (v) => Number(String(v).replace(",", "."));
    let ix = find(/^(lon|lng|long|longitud|longitude)$/i), iy = find(/^(lat|latitud|latitude)$/i);
    let crs = "EPSG:4326";
    if (ix < 0 || iy < 0) {
      ix = find(/^(este|east|easting|x|(utm|coord|coor)_?(e|este|east|x)|(e|este|x)_?utm)$/i);
      iy = find(/^(norte|north|northing|y|(utm|coord|coor)_?(n|norte|north|y)|(n|norte|y)_?utm)$/i);
      crs = null;
    }
    if (ix < 0 || iy < 0) throw new Error("no encontré columnas de coordenadas (lat/lon o este/norte)");
    // separador decimal "," con separador de campo ";": num() lo resuelve
    const features = rows.map((r) => {
      const x = num(r[ix]), y = num(r[iy]);
      if (!isFinite(x) || !isFinite(y)) return null;
      const props = {};
      fields.forEach((f, i) => { if (i !== ix && i !== iy) props[f] = r[i] === "" ? null : (isFinite(num(r[i])) && r[i] !== "" ? num(r[i]) : r[i]); });
      return { type: "Feature", properties: props, geometry: { type: "Point", coordinates: [x, y] } };
    }).filter(Boolean);
    const fc = { type: "FeatureCollection", features };
    const projected = CRS.looksProjected(fc);
    return {
      name, fc, src: "csv",
      crs: projected ? null : "EPSG:4326",
      needsCrs: projected, note: `${fields[ix]} / ${fields[iy]}`,
    };
  },
};

const GT_LABEL = { line: "líneas", poly: "polígonos", point: "puntos" };
function geomFamily(t) {
  if (/LineString/.test(t)) return "line";
  if (/Polygon/.test(t)) return "poly";
  if (/Point/.test(t)) return "point";
  return "other";
}
/** separa GeometryCollection (KML MultiGeometry) en entidades simples */
function explodeCollections(f) {
  if (!f.geometry || f.geometry.type !== "GeometryCollection") return [f];
  return f.geometry.geometries.map((g) => ({ type: "Feature", properties: f.properties, geometry: g }));
}

/* -------------------------- 3. clasificación ------------------------------ */
const ROLES = {
  line: [
    ["contacto", "Contacto"], ["f_inv", "Falla inversa"], ["f_norm", "Falla normal"],
    ["f_dex", "Falla de rumbo dextral"], ["f_sin", "Falla de rumbo sinestral"],
    ["f_ind", "Falla (sin sentido)"], ["ax_anti", "Eje anticlinal"], ["ax_sinc", "Eje sinclinal"],
    ["ax_anti_v", "Eje anticlinal volcado"], ["ax_sinc_v", "Eje sinclinal volcado"],
    ["ax_mono", "Eje monoclinal"], ["ax_ind", "Traza axial (sin tipo)"],
    ["lineam", "Lineamiento"], ["skip", "— no importar —"],
  ],
  poly: [["unit", "Unidad geológica"], ["skip", "— no importar —"]],
  point: [
    ["dip", "Manteo"], ["station", "Estación / observación"],
    ["contact", "Contacto (punto)"], ["skip", "— no importar —"],
  ],
};

const RE_INF = /inferid|cubiert|supuest|probab|aproxim|infer|fotointerp|conceal|covered|approx|queried/i;

/** "Hacia el NorEste", "NE", "SSW", "45" → azimut (°); null si no se entiende */
function cardinalAz(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(",", "."));
  if (String(v).trim() !== "" && isFinite(n)) return ((n % 360) + 360) % 360;
  const raw = String(v).trim();
  // abreviaturas: N, NE, SSW, NO (= NW en castellano)
  let s = /^[nseow]{1,3}$/i.test(raw) ? raw.toUpperCase().replace(/O/g, "W")
    : raw.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
      .replace(/hacia( el| la)?|direccion|manteo|buza\w*/g, " ")
      // «oeste» antes que «este»: si no, «noroeste» se lee como NE
      .replace(/oeste|west/g, "W").replace(/norte|nor|north/g, "N")
      .replace(/sur|south/g, "S").replace(/este|east/g, "E").replace(/[^NSEW]/g, "");
  const A = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
              S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };
  return s in A ? A[s] : null;
}

/** de las dos direcciones de manteo posibles (rumbo ± 90°), la más cercana a la indicada */
function nearestDir(strike, hint) {
  const a = (strike + 90) % 360, b = (strike + 270) % 360;
  const d = (x) => Math.abs(((x - hint + 540) % 360) - 180);
  return d(a) <= d(b) ? a : b;
}

/** rol sugerido para un texto (valor de atributo o nombre de capa) */
function guessRole(txt, gt) {
  const s = String(txt == null ? "" : txt).toLowerCase();
  if (!s) return null;
  if (gt === "line") {
    const volc = /volcad|overturn|invertid/.test(s);
    if (/anticl/.test(s)) return volc ? "ax_anti_v" : "ax_anti";
    if (/sincl|syncl/.test(s)) return volc ? "ax_sinc_v" : "ax_sinc";
    if (/monocl/.test(s)) return "ax_mono";
    if (/falla|fault|corrimient|thrust|cabalg|retrocorr/.test(s)) {
      if (/inversa|reverse|thrust|corrimient|cabalg|retrocorr/.test(s)) return "f_inv";
      if (/normal/.test(s)) return "f_norm";
      if (/dextr/.test(s)) return "f_dex";
      if (/sinestr|sinistr/.test(s)) return "f_sin";
      return "f_ind";
    }
    if (/contact/.test(s)) return "contacto";
    if (/lineam|lineament/.test(s)) return "lineam";
    if (/eje|axis|axial|pliegue|fold/.test(s)) return "ax_ind";
    return null;
  }
  if (gt === "point") {
    // actitudes de fallas o de planos axiales no son manteos de estratos
    if (/falla|fault|axial|pliegue|fold/.test(s)) return null;
    if (/manteo|dip|buzam|rumbo|strike|estrat|bedding|folia|actitud/.test(s)) return "dip";
    if (/estaci|station|obs/.test(s)) return "station";
    if (/contact/.test(s)) return "contact";
    return null;
  }
  if (gt === "poly") return "unit";
  return null;
}

function fieldsOf(fc) {
  const set = new Map();
  for (const f of fc.features.slice(0, 500)) for (const k in (f.properties || {})) {
    if (k === "styleUrl" || k === "styleHash" || k === "styleMapHash" || /^(stroke|fill|icon|label)/.test(k)) continue;
    set.set(k, (set.get(k) || 0) + 1);
  }
  return [...set.keys()];
}

function distinct(fc, field, max = 80) {
  const m = new Map();
  for (const f of fc.features) {
    const v = f.properties ? f.properties[field] : undefined;
    const k = v == null ? "" : String(v);
    m.set(k, (m.get(k) || 0) + 1);
    if (m.size > max) return null;
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/** campo que mejor separa roles (más entidades clasificadas) */
function bestRoleField(fc, gt, fields) {
  let best = null, bestScore = 0;
  for (const k of fields) {
    const d = distinct(fc, k, 60);
    if (!d || d.length < 1) continue;
    let sc = 0;
    for (const [v, n] of d) if (guessRole(v, gt)) sc += n;
    if (sc > bestScore) { bestScore = sc; best = k; }
  }
  return best;
}

function pickField(fields, re) { return fields.find((f) => re.test(f)) || ""; }
function sampleVals(fc, k) {
  return fc.features.slice(0, 200).map((f) => f.properties && f.properties[k]).filter((v) => v != null && v !== "");
}
function numericField(fc, fields, re) {
  return fields.find((f) => re.test(f) && sampleVals(fc, f).some((v) => isFinite(Number(String(v).replace(",", "."))))) || "";
}
function textField(fc, fields, re) {
  return fields.find((f) => re.test(f) && sampleVals(fc, f).some((v) => cardinalAz(v) != null)) || "";
}

/** color estable por nombre de unidad */
function unitColor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = h % 360, sat = 38 + (h >> 9) % 22, lig = 52 + (h >> 13) % 14;
  return hslHex(hue, sat, lig);
}
function hslHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return "#" + [f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
}

/* ----------------------- 4. asistente y armado ---------------------------- */
const Importer = {
  seq: 0,

  async open() {
    let inp = $("fileImport");
    if (!inp) {
      inp = document.createElement("input");
      inp.type = "file"; inp.id = "fileImport"; inp.multiple = true; inp.hidden = true;
      inp.accept = ".zip,.shp,.dbf,.prj,.cpg,.shx,.kml,.kmz,.geojson,.json,.csv,.txt,.tsv,.tif,.tiff";
      inp.onchange = () => { const fs = [...inp.files]; inp.value = ""; this.handle(fs); };
      document.body.appendChild(inp);
    }
    inp.click();
  },

  async handle(files) {
    if (!files.length) return;
    // GeoTIFF = DEM propio, no capa
    const tifs = files.filter((f) => /\.tiff?$/i.test(f.name));
    files = files.filter((f) => !/\.tiff?$/i.test(f.name));
    for (const t of tifs) await this.loadDem(t);
    // un proyecto guardado (.json con formato «perfiles-proyecto») se abre, no se importa como capa
    for (const f of files.filter((x) => /\.json$/i.test(x.name))) {
      let o = null;
      try { o = JSON.parse(await f.text()); } catch { /* no es JSON válido: que lo lea el lector */ }
      if (o && o.formato === "perfiles-proyecto/1") {
        files = files.filter((x) => x !== f);
        const ok = await new Promise((res) => modal({ title: "Abrir proyecto",
          body: `<p>Se reemplazará el proyecto actual (capas, secciones e interpretación) por <b>${esc(f.name)}</b>.</p>`,
          actions: [{ label: "Cancelar", onClick: () => res(false) }, { label: "Abrir", primary: true, onClick: () => res(true) }] }));
        if (ok) { await Out.openProject(o); toast(`Proyecto abierto: ${State.sections.length} sección(es), ${State.layers.length} capa(s).`, "ok"); }
      }
    }
    if (!files.length) return;
    toast(`Leyendo ${files.length} archivo${files.length > 1 ? "s" : ""}…`, "", 2500);
    let res;
    try { res = await Readers.read(files); }
    catch (e) { toast("No pude leer los archivos: " + e.message, "bad", 6000); return; }
    if (res.errors.length) toast(res.errors.join(" · "), "bad", 7000);
    if (!res.layers.length) { if (!res.errors.length) toast("Los archivos no traen entidades.", "bad"); return; }
    let added = 0;
    for (let i = 0; i < res.layers.length; i++) {
      const l = await this.wizard(res.layers[i], i + 1, res.layers.length);
      if (l === "stop") break;
      if (l) { State.addLayer(l); added++; }
    }
    if (added) {
      this.zoomTo(State.layers[State.layers.length - 1]);
      toast(`${added} capa${added > 1 ? "s" : ""} importada${added > 1 ? "s" : ""}.`, "ok");
    }
  },

  /** una capa cruda → modal de mapeo → capa normalizada (o null) */
  wizard(raw, k, n) {
    return new Promise((resolve) => {
      const fc = raw.fc;
      const gts = new Set(fc.features.map((f) => f.geometry && geomFamily(f.geometry.type)));
      gts.delete("other"); gts.delete(undefined);
      const gt = gts.has("line") ? "line" : gts.has("poly") ? "poly" : "point";
      const fields = fieldsOf(fc);
      const guessField = gt === "poly" ? "" : bestRoleField(fc, gt, fields);
      const layerGuess = guessRole(raw.name, gt);
      const st = {
        crs: raw.crs || CRS.guessProjected(),
        mode: guessField ? "field" : "fixed",
        fixed: layerGuess || (gt === "line" ? "contacto" : gt === "point" ? "dip" : "unit"),
        field: guessField || fields[0] || "",
        values: {},
        unitField: pickField(fields, /^(unidad|unit|simbolo|símbolo|sigla|cod_?unid|codigo|label|nombre_?u|formacion|name|nombre)$/i)
          || pickField(fields, /unid|simb|sigla|form|name|nombre/i) || fields[0] || "",
        // «manteo» antes que «buzamiento»: en las cartas SERNAGEOMIN BUZAMIENTO es la inmersión
        dipField: pickField(fields, /^(manteo|dip|mant)$/i) || pickField(fields, /mante|^dip$/i) || pickField(fields, /^buz/i),
        // dirección de manteo numérica explícita; AZIMUTH se trata como rumbo
        dirField: numericField(fc, fields, /^(dipdir|dip_dir|dd|dir_mant|dirmant|dir_manteo|direccion|dirección)$/i),
        strikeField: pickField(fields, /^(rumbo|strike|rmb|azimuth|azimut|az)$/i) || pickField(fields, /rumbo|strike|azim/i),
        cardField: textField(fc, fields, /dir_?mant|dir_?buz|sentido|dip_?dir/i),
        rhr: true,
        faultDipField: numericField(fc, fields, /^(manteo|dip|mant)$/i),
        faultDip: 60,
        lineCardField: textField(fc, fields, /dir_?mant|dip_?dir|sentido/i),
        infField: pickField(fields, /tp_?infor|certeza|tipo_?info|confiab/i),
      };
      if (st.dirField) st.strikeField = "";

      const roleSel = (cur, attr) => `<select ${attr}>${ROLES[gt].map(([v, t]) =>
        `<option value="${v}"${v === cur ? " selected" : ""}>${t}</option>`).join("")}</select>`;
      const fieldSel = (cur, attr, blank) => `<select ${attr}>${blank ? `<option value="">${blank}</option>` : ""}${fields.map((f) =>
        `<option${f === cur ? " selected" : ""}>${esc(f)}</option>`).join("")}</select>`;

      const valuesTable = () => {
        const d = distinct(fc, st.field, 80);
        if (!d) return `<p style="color:var(--bad)">El campo «${esc(st.field)}» tiene más de 80 valores distintos: elige otro o usa un rol fijo.</p>`;
        return `<table class="maptbl"><tr><th>Valor</th><th>n</th><th>Importar como</th></tr>${d.map(([v, c]) => {
          if (!(v in st.values)) st.values[v] = guessRole(v, gt) || (gt === "line" ? (layerGuess || "contacto") : gt === "point" ? "skip" : "unit");
          return `<tr><td title="${esc(v)}">${esc(v || "(vacío)")}${RE_INF.test(v) ? ' <span class="tag">inferida</span>' : ""}</td><td>${c}</td>
            <td>${roleSel(st.values[v], `data-val="${esc(v)}"`)}</td></tr>`;
        }).join("")}</table>`;
      };

      const body = () => `
        <p class="mono" style="margin:0 0 8px">${esc(raw.name)} · ${fc.features.length} ${GT_LABEL[gt]}${raw.note ? " · " + esc(raw.note) : ""}</p>
        ${raw.needsCrs || raw.crs !== "EPSG:4326" ? `<label class="field">Sistema de coordenadas del archivo
          <select id="wCrs">${CRS.options(st.crs)}</select></label>
          ${raw.needsCrs ? `<p class="warn">El archivo no dice su sistema de coordenadas. Revisa el datum: PSAD56 y WGS84 difieren ~400 m en Chile.</p>` : ""}` : ""}
        ${gt === "poly" ? `
          <div class="grid2">
            <label class="field">Campo con el nombre de la unidad ${fieldSel(st.unitField, 'id="wUnit"')}</label>
            <label class="field">Rol ${roleSel(st.fixed, 'id="wFixed"')}</label>
          </div>
          <p class="hint2">Cada polígono queda como unidad; los bordes entre unidades distintas se
            leen como contactos al cortar la sección.</p>` : `
          <div class="grid2">
            <label class="field">Clasificar
              <select id="wMode"><option value="fixed"${st.mode === "fixed" ? " selected" : ""}>todas iguales</option>
              <option value="field"${st.mode === "field" ? " selected" : ""}>según un campo</option></select></label>
            ${st.mode === "fixed"
              ? `<label class="field">Rol ${roleSel(st.fixed, 'id="wFixed"')}</label>`
              : `<label class="field">Campo ${fieldSel(st.field, 'id="wField"')}</label>`}
          </div>
          ${st.mode === "field" ? valuesTable() : ""}`}
        ${gt === "point" ? `
          <div class="grid2" style="margin-top:8px">
            <label class="field">Manteo (°) ${fieldSel(st.dipField, 'id="wDip"', "—")}</label>
            <label class="field">Dirección de manteo (°) ${fieldSel(st.dirField, 'id="wDir"', "— usar rumbo —")}</label>
            ${!st.dirField ? `<label class="field">Rumbo (°) ${fieldSel(st.strikeField, 'id="wStrike"', "—")}</label>
              <label class="field">Sentido del manteo (texto: «Hacia el NE») ${fieldSel(st.cardField, 'id="wCard"', "— usar convención —")}</label>
              ${!st.cardField ? `<label class="field">Convención <select id="wRhr"><option value="1"${st.rhr ? " selected" : ""}>mano derecha (dir = rumbo + 90°)</option>
              <option value="0"${!st.rhr ? " selected" : ""}>mano izquierda (dir = rumbo − 90°)</option></select></label>` : ""}` : ""}
          </div>` : ""}
        ${gt === "line" ? `
          <div class="grid2" style="margin-top:8px">
            <label class="field">Manteo de las fallas ${fieldSel(st.faultDipField, 'id="wFDip"', "— fijo —")}</label>
            <label class="field">Manteo fijo (°) <input id="wFDipV" type="number" min="1" max="90" value="${st.faultDip}"></label>
            <label class="field">Sentido del manteo de las fallas ${fieldSel(st.lineCardField, 'id="wLCard"', "— regla de la mano derecha —")}</label>
            <label class="field">Campo «inferida/cubierta» ${fieldSel(st.infField, 'id="wInf"', "— del valor clasificado —")}</label>
          </div>` : ""}`;

      const m = modal({
        title: `Importar capa ${n > 1 ? `${k} de ${n}` : ""}`,
        body: body(),
        actions: [
          ...(n > 1 && k < n ? [{ label: "Saltar todas", onClick: () => resolve("stop") }] : []),
          { label: "No importar", onClick: () => resolve(null) },
          { label: "Importar", primary: true, onClick: () => {
              try { resolve(this.build(raw, gt, st)); }
              catch (e) { console.error(e); toast("Error al armar la capa: " + e.message, "bad", 6000); resolve(null); }
            } },
        ],
      });
      $("modal").classList.add("wide");
      const rerender = () => { m.body.innerHTML = body(); };
      m.body.onchange = (e) => {
        const t = e.target;
        if (t.id === "wCrs") st.crs = t.value;
        else if (t.id === "wMode") { st.mode = t.value; rerender(); }
        else if (t.id === "wFixed") st.fixed = t.value;
        else if (t.id === "wField") { st.field = t.value; st.values = {}; rerender(); }
        else if (t.id === "wUnit") st.unitField = t.value;
        else if (t.id === "wDip") st.dipField = t.value;
        else if (t.id === "wDir") { st.dirField = t.value; rerender(); }
        else if (t.id === "wStrike") st.strikeField = t.value;
        else if (t.id === "wCard") { st.cardField = t.value; rerender(); }
        else if (t.id === "wLCard") st.lineCardField = t.value;
        else if (t.id === "wRhr") st.rhr = t.value === "1";
        else if (t.id === "wFDip") st.faultDipField = t.value;
        else if (t.id === "wFDipV") st.faultDip = clamp(Number(t.value) || 60, 1, 90);
        else if (t.id === "wInf") st.infField = t.value;
        else if (t.dataset.val !== undefined) st.values[t.dataset.val] = t.value;
      };
    }).finally(() => $("modal").classList.remove("wide"));
  },

  /** capa cruda + mapeo → capa normalizada */
  build(raw, gt, st) {
    const fc = raw.crs === "EPSG:4326" && !raw.needsCrs ? raw.fc : CRS.toWgs84(raw.fc, st.crs);
    const id = "L" + Date.now().toString(36) + (this.seq++);
    const feats = [];
    const counts = {};
    let i = 0;
    const num = (v) => { const x = Number(String(v).replace(",", ".")); return isFinite(x) ? x : null; };

    for (const f of fc.features) {
      const g = f.geometry;
      if (!g || geomFamily(g.type) !== gt) continue;
      const p = f.properties || {};
      const key = st.mode === "field" ? String(p[st.field] == null ? "" : p[st.field]) : null;
      const role = gt === "poly" ? st.fixed : st.mode === "field" ? (st.values[key] || "skip") : st.fixed;
      if (role === "skip") continue;
      const label = p.name || p.nombre || p.NOMBRE || p.Name || "";
      const infTxt = st.infField ? String(p[st.infField] ?? "") : (key ?? label);
      const inferida = RE_INF.test(infTxt);
      const base = { layer: id, label: String(label || key || ""), props: p };

      if (gt === "line") {
        const parts = g.type === "MultiLineString" ? g.coordinates : [g.coordinates];
        for (const part of parts) {
          if (part.length < 2) continue;
          const pts = part.map((c) => [c[1], c[0]]);
          const fid = `${id}_${i++}`;
          if (role === "contacto") feats.push({ ...base, id: fid, kind: "cline", pts, inferida, tipo: key || "" });
          else if (role === "lineam") feats.push({ ...base, id: fid, kind: "lineament", pts });
          else if (role.startsWith("f_")) {
            const tipo = { f_inv: "inversa", f_norm: "normal", f_dex: "dextral", f_sin: "sinestral", f_ind: "indeterminada" }[role];
            const dip = (st.faultDipField && num(p[st.faultDipField])) || st.faultDip;
            const hint = st.lineCardField ? cardinalAz(p[st.lineCardField]) : null;
            const ff = { ...base, id: fid, kind: "fault", pts, tipo, dip: clamp(dip, 1, 90), inferida };
            if (hint != null) ff.dipHint = hint;   // sentido aproximado; el rumbo sale de cada tramo
            feats.push(ff);
          } else if (role.startsWith("ax_")) {
            const tipo = { ax_anti: "anticlinal", ax_sinc: "sinclinal", ax_anti_v: "anticlinal volcado",
                           ax_sinc_v: "sinclinal volcado", ax_mono: "monoclinal", ax_ind: "indeterminado" }[role];
            feats.push({ ...base, id: fid, kind: "axis", pts, tipo, inferida });
          }
          counts[role] = (counts[role] || 0) + 1;
        }
      } else if (gt === "poly") {
        const polys = g.type === "MultiPolygon" ? g.coordinates : [g.coordinates];
        const nombre = String(p[st.unitField] ?? "sin nombre");
        for (const poly of polys) {
          const rings = poly.map((r) => r.map((c) => [c[1], c[0]]));
          if (!rings.length || rings[0].length < 3) continue;
          feats.push({ ...base, id: `${id}_${i++}`, kind: "unit", rings, pts: rings[0],
            nombre, color: p.fill && /^#/.test(p.fill) ? p.fill : unitColor(nombre), bbox: bboxOf(rings[0]) });
          counts.unit = (counts.unit || 0) + 1;
        }
      } else {
        const pts = g.type === "MultiPoint" ? g.coordinates : [g.coordinates];
        for (const c of pts) {
          const fid = `${id}_${i++}`;
          const ll = { lat: c[1], lng: c[0], z: c.length > 2 && isFinite(c[2]) && c[2] !== 0 ? c[2] : null };
          if (role === "dip") {
            const dip = st.dipField ? num(p[st.dipField]) : null;
            let dir = st.dirField ? num(p[st.dirField]) : null;
            if (dir == null && st.strikeField) {
              const s = num(p[st.strikeField]);
              const hint = st.cardField ? cardinalAz(p[st.cardField]) : null;
              if (s != null) dir = hint != null ? nearestDir(s, hint) : (s + (st.rhr ? 90 : 270)) % 360;
            }
            if (dip == null || dir == null) { counts.sin_dato = (counts.sin_dato || 0) + 1; continue; }
            feats.push({ ...base, ...ll, id: fid, kind: "dip", dip: clamp(dip, 0, 90), dir: ((dir % 360) + 360) % 360 });
          } else if (role === "station") feats.push({ ...base, ...ll, id: fid, kind: "station", n: label || i });
          else if (role === "contact") feats.push({ ...base, ...ll, id: fid, kind: "contact", nota: label, color: "#c9d3dd" });
          counts[role] = (counts[role] || 0) + 1;
        }
      }
    }
    if (!feats.length) { toast(`«${raw.name}»: nada que importar con ese mapeo.`, "bad", 4000); return null; }
    if (counts.sin_dato) toast(`${counts.sin_dato} manteos sin valor numérico quedaron fuera.`, "", 4000);
    const resumen = Object.entries(counts).filter(([k]) => k !== "sin_dato")
      .map(([k, v]) => `${v} ${(ROLES[gt].find((r) => r[0] === k) || [k, k])[1].toLowerCase()}`).join(", ");
    return { id, name: raw.name, src: raw.src, crs: st.crs, gt, visible: true, feats, resumen };
  },

  async loadDem(file) {
    toast(`Leyendo DEM ${file.name}…`, "", 4000);
    try {
      const r = await DEM.loadUser(await file.arrayBuffer(), file.name.replace(/\.[^.]+$/, ""));
      toast(`DEM propio cargado: ${r.w}×${r.h} px, ${fmt(r.res, 1)} m, ${r.epsg}. Manda sobre Terrarium donde cubre.`, "ok", 6000);
      App.renderDemInfo();
      if (State.trace) App.buildProfile();
    } catch (e) {
      console.error(e);
      toast("No pude leer el GeoTIFF: " + e.message, "bad", 7000);
    }
  },

  zoomTo(l) {
    if (!l || !l.feats.length) return;
    const b = L.latLngBounds([]);
    for (const f of l.feats) {
      if (f.pts) f.pts.forEach((p) => b.extend(p));
      else if (f.lat != null) b.extend([f.lat, f.lng]);
    }
    if (b.isValid()) View.map.fitBounds(b, { padding: [40, 40], maxZoom: 15 });
  },

  /** arrastrar y soltar archivos sobre la app */
  bindDrop() {
    const root = document.body;
    let depth = 0;
    root.addEventListener("dragenter", (e) => { if (hasFiles(e)) { depth++; root.classList.add("dropping"); e.preventDefault(); } });
    root.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
    root.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) root.classList.remove("dropping"); });
    root.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); depth = 0; root.classList.remove("dropping");
      this.handle([...e.dataTransfer.files]);
    });
    function hasFiles(e) { return e.dataTransfer && [...e.dataTransfer.types].includes("Files"); }
  },
};

function hasBadChars(fc) {
  for (const f of fc.features.slice(0, 2000)) {
    for (const v of Object.values(f.properties || {})) if (typeof v === "string" && v.includes("�")) return true;
  }
  return false;
}

function bboxOf(pts) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const p of pts) { if (p[0] < a) a = p[0]; if (p[1] < b) b = p[1]; if (p[0] > c) c = p[0]; if (p[1] > d) d = p[1]; }
  return [a, b, c, d];   // [latMin, lngMin, latMax, lngMax]
}
