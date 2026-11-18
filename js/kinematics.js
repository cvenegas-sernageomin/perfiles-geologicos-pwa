"use strict";
/* =============================================================================
   kinematics.js — modelado cinemático directo, restauración e inversión
   Coordenadas de la sección [s, z] en metros. Sin DOM: corre en Node y en el navegador.
   -----------------------------------------------------------------------------
   Falla = polilínea ordenada de lo profundo a la punta (la punta es el extremo
   más alto). Bloque colgante = lado «de arriba» de cada tramo.
   · fpf      fault-parallel flow (Egan et al. 1997; Kane et al. 1997): el bloque
              colgante se mueve paralelo al tramo de falla de su dominio; los
              dominios se separan por la bisectriz de cada quiebre. Una falla
              rampa-plano da un pliegue por flexión de falla (fault-bend fold).
   · trishear (Erslev 1991; Zehnder & Allmendinger 2000): zona triangular de
              cizalla delante de la punta, que avanza P/S veces el desplazamiento.
              Detrás de la punta el bloque colgante sigue el fault-parallel flow,
              así funciona con fallas planas, lístricas o con rampas.
   · shear    cizalla simple inclinada (White et al. 1986): falla normal lístrica;
              el colgante se traslada el rechazo horizontal y colapsa a lo largo de
              líneas de cizalla a α° de la vertical (0 = vertical). Conserva área.
   Restaurar = correr el mismo modelo con desplazamiento negativo (en cizalla
   inclinada es la inversa exacta; en los demás, la integración inversa).
   ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Kin = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const D2R = Math.PI / 180;
  const unit = (v) => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
  const upN = (t) => { const n = [-t[1], t[0]]; return n[1] < 0 ? [-n[0], -n[1]] : n; };
  const cross = (a, b) => a[0] * b[1] - a[1] * b[0];

  /** ordena la falla de lo profundo a la punta y precalcula tramos y bisectrices */
  function faultGeom(pts) {
    let P = pts.map((q) => [q[0], q[1]]);
    if (P[0][1] > P[P.length - 1][1]) P = P.reverse();
    const seg = [];
    for (let i = 0; i < P.length - 1; i++) {
      const t = unit([P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]]);
      seg.push({ a: P[i], b: P[i + 1], t, n: upN(t) });
    }
    // bisectriz en cada quiebre interior j (entre tramo j−1 y j)
    const bis = [];
    for (let j = 1; j < seg.length; j++) {
      const b = unit([seg[j - 1].n[0] + seg[j].n[0], seg[j - 1].n[1] + seg[j].n[1]]);
      const sgn = Math.sign(cross(b, seg[j].t)) || 1;
      bis.push({ V: seg[j].a, b, sgn });
    }
    return { pts: P, seg, bis, tip: P[P.length - 1] };
  }

  /** dominio (índice de tramo) de un punto según las bisectrices */
  function domainOf(G, x, y) {
    let d = 0;
    for (let j = 0; j < G.bis.length; j++) {
      const B = G.bis[j];
      if (Math.sign(cross(B.b, [x - B.V[0], y - B.V[1]])) === B.sgn) d = j + 1;
    }
    return d;
  }

  /** ¿bloque colgante? (por encima del tramo de su dominio) */
  function isHW(G, x, y, d) {
    const S = G.seg[d];
    return (x - S.a[0]) * S.n[0] + (y - S.a[1]) * S.n[1] > 0;
  }

  /* ---------------- campos de velocidad (por unidad de «tiempo» = desplazamiento total) */
  function vFPF(G, x, y, rate) {
    const d = domainOf(G, x, y);
    if (!isHW(G, x, y, d)) return [0, 0];
    const t = G.seg[d].t;
    return [rate * t[0], rate * t[1]];
  }

  /** trishear en la punta + FPF detrás. tip y tramo de la punta se pasan aparte (la punta avanza) */
  function vTrishear(G, x, y, rate, tip, k) {
    const S = G.seg[G.seg.length - 1];
    const dir = S.t, nrm = S.n;
    const dx = x - tip[0], dy = y - tip[1];
    const xi = dx * dir[0] + dy * dir[1];
    if (xi > 0) {
      // delante de la punta: zona triangular (perfil de velocidad lineal, incompresible)
      const eta = dx * nrm[0] + dy * nrm[1];
      const W = xi * k;
      if (eta >= W) return [rate * dir[0], rate * dir[1]];
      if (eta <= -W) return [0, 0];
      const t = eta / W;
      const u = rate * 0.5 * (1 + t), w = -rate * k * (1 - t * t) * 0.25;
      return [u * dir[0] + w * nrm[0], u * dir[1] + w * nrm[1]];
    }
    return vFPF(G, x, y, rate);
  }

  /* ---------------- cizalla simple inclinada ---------------- */
  /** z de la falla en la coordenada de línea de cizalla q = x − z·tanα (falla monótona en q) */
  function shearFault(pts, ta) {
    const Q = pts.map((p) => [p[0] - p[1] * ta, p[1]]).sort((a, b) => a[0] - b[0]);
    return (q) => {
      if (q <= Q[0][0]) return Q[0][1] + (q - Q[0][0]) * slope(0);
      if (q >= Q[Q.length - 1][0]) return Q[Q.length - 1][1] + (q - Q[Q.length - 1][0]) * slope(Q.length - 2);
      let i = 0;
      while (i < Q.length - 2 && Q[i + 1][0] < q) i++;
      return Q[i][1] + (Q[i + 1][1] - Q[i][1]) * (q - Q[i][0]) / ((Q[i + 1][0] - Q[i][0]) || 1);
    };
    function slope(i) { return (Q[i + 1][1] - Q[i][1]) / ((Q[i + 1][0] - Q[i][0]) || 1); }
  }

  /** heave d (m, + hacia el bloque colgante que se aleja) — exacto, sin pasos */
  function shearStep(lines, faultPts, d, alphaDeg) {
    const ta = Math.tan(alphaDeg * D2R);
    const zf = shearFault(faultPts, ta);
    // el colgante se aleja del yacente: sentido hacia donde la falla baja
    const P = faultPts[0][1] > faultPts[faultPts.length - 1][1] ? faultPts : faultPts.slice().reverse();
    const away = Math.sign(P[P.length - 1][0] - P[0][0]) || 1;   // de la parte alta a la baja
    const dd = d * away;
    return lines.map((ln) => ln.map(([x, z]) => {
      const q = x - z * ta;
      if (z <= zf(q)) return [x, z];                      // yacente
      const dz = zf(q + dd) - zf(q);
      const z2 = z + dz;
      return [q + dd + z2 * ta, z2];
    }));
  }

  /* ---------------- integración ---------------- */
  function densify(pts, maxSeg) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / maxSeg));
      for (let k = 1; k <= n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
    }
    return out;
  }

  /**
   * Modelo directo (o restauración con slip < 0).
   * p = {model:"fpf"|"trishear"|"shear", fault:[[s,z]…], slip, ps, apical, alpha, steps,
   *      growth:{every, z0, dz, s0, s1}, frames}
   * lines = [[[s,z]…]…] (se copian)
   * → {lines, fault, frames:[{lines, fault}], growth:[índices de líneas nuevas]}
   */
  function run(p, lines) {
    const steps = Math.max(1, Math.round(p.steps || 40));
    const slip = Number(p.slip) || 0;
    const L = lines.map((ln) => ln.map((q) => [q[0], q[1]]));
    const frames = [];
    const keep = (Lc, F) => frames.push({ lines: Lc.map((l) => l.map((q) => [q[0], q[1]])), fault: F.map((q) => [q[0], q[1]]) });
    const nFrames = p.frames || 0, every = nFrames ? Math.max(1, Math.floor(steps / nFrames)) : 0;
    const grown = [];
    const addGrowth = (k) => {
      const g = p.growth;
      if (!g || !g.every || k % g.every !== 0 || k === 0) return;
      const z = g.z0 + g.dz * (k / g.every - 1);
      L.push(densify([[g.s0, z], [g.s1, z]], (g.s1 - g.s0) / 200));
      grown.push(L.length - 1);
    };

    if (p.model === "shear") {
      let F = p.fault.map((q) => [q[0], q[1]]);
      const h = slip / steps;
      for (let k = 0; k < steps; k++) {
        addGrowth(k);
        const moved = shearStep(L, F, h, p.alpha || 0);
        for (let i = 0; i < L.length; i++) L[i] = moved[i];
        if (every && k % every === 0) keep(L, F);
      }
      if (every) keep(L, F);
      return { lines: L, fault: F, frames, growth: grown };
    }

    const G = faultGeom(p.fault);
    const k = Math.tan(((p.apical || 60) * D2R) / 2);
    const tipDir = G.seg[G.seg.length - 1].t;
    const ps = p.model === "trishear" ? (Number(p.ps) || 0) : 0;
    const h = 1 / steps;
    // la punta: en directo arranca en la falla dibujada y avanza P/S·slip; en restauración retrocede
    let tip = [G.tip[0], G.tip[1]];
    const vTip = [ps * slip * tipDir[0], ps * slip * tipDir[1]];
    const V = p.model === "trishear" ? (x, y, tp) => vTrishear(G, x, y, slip, tp, k) : (x, y) => vFPF(G, x, y, slip);
    const faultNow = () => p.model === "trishear" && ps > 0 && slip > 0
      ? G.pts.concat([[tip[0], tip[1]]]) : G.pts.map((q) => [q[0], q[1]]);

    for (let s = 0; s < steps; s++) {
      addGrowth(s);
      const tm = [tip[0] + vTip[0] * h * 0.5, tip[1] + vTip[1] * h * 0.5];
      for (const ln of L) {
        for (const q of ln) {
          const v1 = V(q[0], q[1], tm);
          const v2 = V(q[0] + v1[0] * h * 0.5, q[1] + v1[1] * h * 0.5, tm);
          q[0] += v2[0] * h; q[1] += v2[1] * h;
        }
      }
      tip = [tip[0] + vTip[0] * h, tip[1] + vTip[1] * h];
      if (every && s % every === 0) keep(L, faultNow());
    }
    if (every) keep(L, faultNow());
    return { lines: L, fault: faultNow(), frames, growth: grown };
  }

  /** corta las líneas por encima de una cota (superficie de erosión) */
  function erode(lines, zE) {
    const out = [];
    for (const ln of lines) {
      let cur = [];
      for (let i = 0; i < ln.length; i++) {
        const q = ln[i], prev = ln[i - 1];
        if (prev && (prev[1] - zE) * (q[1] - zE) < 0) {
          const t = (zE - prev[1]) / (q[1] - prev[1]);
          const c = [prev[0] + (q[0] - prev[0]) * t, zE];
          if (q[1] > zE) { cur.push(c); if (cur.length > 1) out.push(cur); cur = []; }
          else cur = [c];
        }
        if (q[1] <= zE) cur.push(q);
      }
      if (cur.length > 1) out.push(cur);
    }
    return out;
  }

  /* ---------------- inversión trishear (Allmendinger 1998) ----------------
     Busca la falla (posición de la punta, manteo de la rampa) y P/S, ángulo
     apical y desplazamiento tales que al restaurar el horizonte deformado
     quede lo más recto posible (residuo RMS de una recta ajustada).
     Optimización por evolución diferencial con límites. */
  function straightness(pts) {
    const n = pts.length;
    if (n < 3) return Infinity;
    let mx = 0, my = 0;
    for (const q of pts) { mx += q[0]; my += q[1]; }
    mx /= n; my /= n;
    let sxx = 0, sxy = 0, syy = 0;
    for (const q of pts) { const dx = q[0] - mx, dy = q[1] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    // distancia ortogonal a la recta de mejor ajuste: menor autovalor de la covarianza
    const tr = sxx + syy, det = sxx * syy - sxy * sxy;
    const lmin = tr / 2 - Math.sqrt(Math.max(0, tr * tr / 4 - det));
    return Math.sqrt(Math.max(0, lmin) / n);
  }

  /** θ = {tipS, tipZ, dip (°, hacia +s si dirS=+1), ps, apical, slip}; rampa recta desde la punta */
  function rampFault(th, dirS, zBase) {
    const dz = th.tipZ - zBase, dx = dz / Math.tan(th.dip * D2R);
    return [[th.tipS - dirS * dx, zBase], [th.tipS, th.tipZ]];
  }

  /**
   * bed: horizonte deformado [[s,z]…]; spec: [{k, min, max}] sobre tipS, tipZ, dip, ps, apical, slip
   * opts: {dirS (+1 rampa sube hacia +s), zBase, steps, pop, gens, fixed, onGen(g, best)}
   * Devuelve una promesa (cede el hilo entre generaciones si `yieldFn` está).
   */
  async function invertTrishear(beds, spec, opts) {
    const steps = opts.steps || 30, NP = opts.pop || Math.max(24, spec.length * 6), G = opts.gens || 80;
    const fixed = opts.fixed || {};
    // uno o varios horizontes: con uno solo, manteo y desplazamiento se compensan
    // (solo queda fijo el alzamiento slip·sen(manteo)); varios a distinta cota lo resuelven
    const list = (Array.isArray(beds[0][0]) ? beds : [beds]).map((b) => densify(b, 50));
    const cost = (th) => {
      const q = { ...fixed, ...th };
      if (q.ps < 0 || q.apical <= 1 || q.dip <= 1 || q.slip <= 0) return Infinity;
      const F = rampFault(q, opts.dirS, opts.zBase);
      // para restaurar, la punta parte desde su posición FINAL y retrocede
      const back = run({ model: "trishear", fault: F, slip: -q.slip, ps: q.ps, apical: q.apical, steps }, list).lines;
      let s2 = 0;
      for (const b of back) { const r = straightness(b); s2 += r * r; }
      return Math.sqrt(s2 / back.length);
    };
    const rnd = (s) => s.min + Math.random() * (s.max - s.min);
    let pop = Array.from({ length: NP }, () => { const th = {}; for (const s of spec) th[s.k] = rnd(s); return { th, c: cost(th) }; });
    const F_ = 0.6, CR = 0.85;
    let best = pop.reduce((a, b) => (b.c < a.c ? b : a));
    for (let g = 0; g < G; g++) {
      for (let i = 0; i < NP; i++) {
        let a, b, c;
        do { a = (Math.random() * NP) | 0; } while (a === i);
        do { b = (Math.random() * NP) | 0; } while (b === i || b === a);
        do { c = (Math.random() * NP) | 0; } while (c === i || c === a || c === b);
        const jr = (Math.random() * spec.length) | 0;
        const th = {};
        spec.forEach((s, j) => {
          let v = Math.random() < CR || j === jr ? pop[a].th[s.k] + F_ * (pop[b].th[s.k] - pop[c].th[s.k]) : pop[i].th[s.k];
          if (v < s.min) v = s.min + Math.random() * (pop[i].th[s.k] - s.min);
          if (v > s.max) v = s.max - Math.random() * (s.max - pop[i].th[s.k]);
          th[s.k] = v;
        });
        const cc = cost(th);
        if (cc <= pop[i].c) { pop[i] = { th, c: cc }; if (cc < best.c) best = pop[i]; }
      }
      if (opts.onGen) await opts.onGen(g, best);
    }
    const q = { ...fixed, ...best.th };
    const F = rampFault(q, opts.dirS, opts.zBase);
    const restored = run({ model: "trishear", fault: F, slip: -q.slip, ps: q.ps, apical: q.apical, steps }, list).lines;
    return { params: q, rms: best.c, fault: F, restored };
  }

  return { run, erode, densify, faultGeom, domainOf, vFPF, shearStep, straightness, rampFault, invertTrishear, D2R };
});
