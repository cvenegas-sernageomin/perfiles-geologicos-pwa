"use strict";
/* =============================================================================
   construct.js — construcción geométrica de la sección (funciones puras)
   Coordenadas de la sección: [s, z] en metros, s a lo largo de la traza, z cota.
   Todo se calcula a escala real (VE = 1); la exageración es solo de dibujo.
   Un manteo en la sección es {s, z, th}: th = ángulo de la capa en la sección
   (dz/ds = tan th; th > 0 sube hacia +s, th < 0 baja hacia +s).
   -----------------------------------------------------------------------------
   kink   dominios de manteo (Suppe 1985): límites axiales en la bisectriz de
          los dos dominios, anclados en la superficie a medio camino entre
          estaciones; la capa es recta en cada dominio y se quiebra en el límite.
   busk   arcos concéntricos (Busk 1929): centro = cruce de las normales de dos
          estaciones vecinas; los límites de dominio son esas normales.
   hermite curva suave z(s) por puntos con tangente impuesta (manteo).
   offset capas paralelas (espesor constante, normal a la capa).
   similar copia trasladada en la dirección axial (espesor axial constante).
   ========================================================================== */
const Construct = {
  D2R: Math.PI / 180,

  /* ---------------- utilidades ---------------- */
  dir(th) { return [Math.cos(th), Math.sin(th)]; },
  /** ¿P a la derecha (+s) de la recta por M con dirección v (v hacia arriba)? */
  rightOf(M, v, P) { return (P[0] - M[0]) * v[1] - (P[1] - M[1]) * v[0] > 0; },
  /** igual, pero un punto SOBRE la recta cuenta como a la derecha (semillas en una estación) */
  rightOrOn(M, v, P) { return (P[0] - M[0]) * v[1] - (P[1] - M[1]) * v[0] > -1e-6; },
  /** intersección del rayo P + t·u (t > eps) con la recta M + w·v; null si no hay */
  rayLine(P, u, M, v) {
    const den = u[0] * v[1] - u[1] * v[0];
    if (Math.abs(den) < 1e-12) return null;
    const t = ((M[0] - P[0]) * v[1] - (M[1] - P[1]) * v[0]) / den;
    return t > 1e-6 ? { t, p: [P[0] + u[0] * t, P[1] + u[1] * t] } : null;
  },
  /** recorta un tramo P→Q a la caja s ∈ [s0,s1], z ≥ zMin; devuelve el punto final y si se salió */
  clipStep(P, Q, box) {
    let t = 1;
    const dx = Q[0] - P[0], dz = Q[1] - P[1];
    if (Q[0] > box.s1 && dx > 0) t = Math.min(t, (box.s1 - P[0]) / dx);
    if (Q[0] < box.s0 && dx < 0) t = Math.min(t, (box.s0 - P[0]) / dx);
    if (Q[1] < box.zMin && dz < 0) t = Math.min(t, (box.zMin - P[1]) / dz);
    if (Q[1] > box.zMax && dz > 0) t = Math.min(t, (box.zMax - P[1]) / dz);
    t = Math.max(0, t);
    return { p: [P[0] + dx * t, P[1] + dz * t], out: t < 1 };
  },

  /* ---------------- dominios de manteo (kink) ---------------- */
  /** límites axiales entre manteos vecinos. topo(s) → cota de superficie */
  kinkBounds(dips, topo) {
    const out = [];
    for (let i = 0; i < dips.length - 1; i++) {
      const a = dips[i], b = dips[i + 1];
      const ua = this.dir(a.th), ub = this.dir(b.th);
      let m = [ua[0] + ub[0], ua[1] + ub[1]];
      const l = Math.hypot(m[0], m[1]) || 1;
      m = [m[0] / l, m[1] / l];
      let v = [-m[1], m[0]];                    // perpendicular a la capa media
      if (v[1] < 0) v = [-v[0], -v[1]];          // apuntando hacia arriba
      const sm = (a.s + b.s) / 2;
      const zm = topo ? topo(sm) : (a.z + b.z) / 2;
      out.push({ M: [sm, zm == null ? (a.z + b.z) / 2 : zm], v });
    }
    return out;
  },

  /** horizonte por kink desde una semilla, hasta los bordes de la caja */
  kink(seed, dips, box, topo) {
    if (!dips.length) return null;
    const B = this.kinkBounds(dips, topo);
    let k0 = 0;
    for (const b of B) if (this.rightOrOn(b.M, b.v, seed)) k0++;
    const walk = (sgn) => {
      const pts = [];
      let P = seed, k = k0;
      for (let guard = 0; guard < 400; guard++) {
        const u0 = this.dir(dips[k].th);
        const u = [u0[0] * sgn, u0[1] * sgn];
        const bi = sgn > 0 ? k : k - 1;          // límite que viene en esa dirección
        let next = null;
        if (bi >= 0 && bi < B.length) next = this.rayLine(P, u, B[bi].M, B[bi].v);
        const far = [P[0] + u[0] * 1e7, P[1] + u[1] * 1e7];
        const c = this.clipStep(P, next ? next.p : far, box);
        pts.push(c.p);
        if (c.out || !next) break;
        P = c.p; k += sgn;
      }
      return pts;
    };
    const left = walk(-1).reverse(), right = walk(1);
    return [...left, seed, ...right];
  },

  /* ---------------- Busk (arcos concéntricos) ---------------- */
  buskSetup(dips) {
    const N = dips.map((d) => {
      let n = [-Math.sin(d.th), Math.cos(d.th)];     // normal a la capa, hacia arriba
      return { S: [d.s, d.z], n };
    });
    const C = [];
    for (let i = 0; i < N.length - 1; i++) {
      const a = N[i], b = N[i + 1];
      const den = a.n[0] * b.n[1] - a.n[1] * b.n[0];
      if (Math.abs(den) < 1e-9) { C.push(null); continue; }   // manteos iguales: tramo recto
      const t = ((b.S[0] - a.S[0]) * b.n[1] - (b.S[1] - a.S[1]) * b.n[0]) / den;
      C.push([a.S[0] + a.n[0] * t, a.S[1] + a.n[1] * t]);
    }
    return { N, C };
  },

  busk(seed, dips, box) {
    if (!dips.length) return null;
    const { N, C } = this.buskSetup(dips);
    let k0 = 0;
    for (let i = 0; i < N.length; i++) if (this.rightOrOn(N[i].S, N[i].n, seed)) k0++;
    // dominio k: 0 = antes de la 1.ª normal (recto), n = después de la última (recto),
    // 1..n−1 = entre normales k−1 y k (arco con centro C[k−1])
    const walk = (sgn) => {
      const pts = [];
      let P = seed, k = k0;
      for (let guard = 0; guard < 400; guard++) {
        const endDom = k === 0 || k === N.length;
        const center = endDom ? null : C[k - 1];
        const nextN = sgn > 0 ? k : k - 1;        // normal que se cruza al avanzar
        if (endDom || !center) {
          const th = endDom ? dips[k === 0 ? 0 : N.length - 1].th : dips[k - 1].th;
          const u0 = this.dir(th), u = [u0[0] * sgn, u0[1] * sgn];
          let next = null;
          if (nextN >= 0 && nextN < N.length) next = this.rayLine(P, u, N[nextN].S, N[nextN].n);
          const c = this.clipStep(P, next ? next.p : [P[0] + u[0] * 1e7, P[1] + u[1] * 1e7], box);
          pts.push(c.p);
          if (c.out || !next) break;
          P = c.p; k += sgn; continue;
        }
        // arco: el punto debe estar del lado de las estaciones (si no, «problema de espacio»)
        // Sref = estación de la normal de salida; Sin = la de entrada (donde está P).
        // P debe quedar del lado de las estaciones respecto del centro (no más allá del centro).
        const cs = center, Sref = N[sgn > 0 ? k : k - 1].S, Sin = N[sgn > 0 ? k - 1 : k].S;
        const toS = [Sref[0] - cs[0], Sref[1] - cs[1]];
        const toP = [P[0] - cs[0], P[1] - cs[1]];
        const r = Math.hypot(toP[0], toP[1]);
        const lS = Math.hypot(toS[0], toS[1]) || 1;
        if (toP[0] * (Sin[0] - cs[0]) + toP[1] * (Sin[1] - cs[1]) <= 0 || r < 1e-6) break;
        const Q = [cs[0] + toS[0] / lS * r, cs[1] + toS[1] / lS * r];
        const a0 = Math.atan2(toP[1], toP[0]);
        let da = Math.atan2(Q[1] - cs[1], Q[0] - cs[0]) - a0;
        while (da > Math.PI) da -= 2 * Math.PI;
        while (da < -Math.PI) da += 2 * Math.PI;
        const nseg = Math.max(2, Math.ceil(Math.abs(da) / 0.03));
        let prev = P, out = false;
        for (let j = 1; j <= nseg; j++) {
          const a = a0 + da * j / nseg;
          const q = [cs[0] + r * Math.cos(a), cs[1] + r * Math.sin(a)];
          const c = this.clipStep(prev, q, box);
          pts.push(c.p);
          if (c.out) { out = true; break; }
          prev = q;
        }
        if (out) break;
        P = Q; k += sgn;
      }
      return pts;
    };
    const left = walk(-1).reverse(), right = walk(1);
    return [...left, seed, ...right];
  },

  /* ---------------- tangentes (guías) ---------------- */
  tangents(dips, box, len = 1500) {
    return dips.map((d) => {
      const u = this.dir(d.th);
      return [[d.s - u[0] * len, d.z - u[1] * len], [d.s + u[0] * len, d.z + u[1] * len]];
    });
  },

  /* ---------------- Hermite ---------------- */
  /** pts [{s,z,th}] ordenados por s → polilínea z(s) con tangente dz/ds = tan th */
  hermite(pts, step = 25) {
    const P = pts.slice().sort((a, b) => a.s - b.s);
    if (P.length < 2) return P.map((p) => [p.s, p.z]);
    const out = [[P[0].s, P[0].z]];
    for (let i = 0; i < P.length - 1; i++) {
      const a = P[i], b = P[i + 1], h = b.s - a.s;
      if (h <= 0) continue;
      const ma = Math.tan(a.th), mb = Math.tan(b.th);
      const n = Math.max(4, Math.ceil(h / step));
      for (let j = 1; j <= n; j++) {
        const t = j / n, t2 = t * t, t3 = t2 * t;
        const z = (2 * t3 - 3 * t2 + 1) * a.z + (t3 - 2 * t2 + t) * h * ma
                + (-2 * t3 + 3 * t2) * b.z + (t3 - t2) * h * mb;
        out.push([a.s + h * t, z]);
      }
    }
    return out;
  },

  /* ---------------- capas paralelas y similares ---------------- */
  /** desplaza una polilínea d metros por su normal (d > 0 hacia arriba) */
  offset(pts, d) {
    const n = pts.length;
    if (n < 2) return pts.slice();
    const segN = [];
    for (let i = 0; i < n - 1; i++) {
      const dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1];
      const l = Math.hypot(dx, dz) || 1;
      let nn = [-dz / l, dx / l];
      if (dx < 0) nn = [-nn[0], -nn[1]];        // «arriba» aunque el tramo vaya hacia −s
      segN.push(nn);
    }
    const raw = pts.map((p, i) => {
      const a = segN[Math.max(0, i - 1)], b = segN[Math.min(n - 2, i)];
      let m = [a[0] + b[0], a[1] + b[1]];
      const l = Math.hypot(m[0], m[1]);
      if (l < 1e-9) m = b; else m = [m[0] / l, m[1] / l];
      const cos = m[0] * b[0] + m[1] * b[1];
      const k = d / Math.max(0.25, cos);         // inglete limitado (ángulos muy agudos)
      return [p[0] + m[0] * k, p[1] + m[1] * k];
    });
    // quita los bucles: vértices que invierten el sentido del tramo original
    const out = [raw[0]];
    for (let i = 1; i < n; i++) {
      const o = [pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]];
      const q = out[out.length - 1];
      const r = [raw[i][0] - q[0], raw[i][1] - q[1]];
      if (o[0] * r[0] + o[1] * r[1] > 0) out.push(raw[i]);
    }
    return out;
  },

  /** copia trasladada d metros en la dirección axial (ángulo desde la horizontal; 90 = vertical) */
  similar(pts, d, axialDeg = 90) {
    const a = axialDeg * this.D2R;
    return pts.map((p) => [p[0] + d * Math.cos(a), p[1] + d * Math.sin(a)]);
  },

  /* ---------------- medidas ---------------- */
  length(pts) {
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return L;
  },
  area(pts) {      // polígono cerrado implícito (shoelace), valor absoluto
    let A = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) A += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    return Math.abs(A) / 2;
  },
  /** cota de una polilínea en s (máxima si la cruza varias veces); null si no la cubre */
  zAt(pts, s) {
    let best = null;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if ((a[0] - s) * (b[0] - s) > 0 || a[0] === b[0] && a[0] !== s) continue;
      const z = a[0] === b[0] ? Math.max(a[1], b[1]) : a[1] + (b[1] - a[1]) * (s - a[0]) / (b[0] - a[0]);
      if (best == null || z > best) best = z;
    }
    return best;
  },

  /** área sobre el nivel regional zReg entre los extremos de la capa (integral de z − zReg) */
  excessArea(pts, zReg) {
    let A = 0;
    for (let i = 1; i < pts.length; i++) {
      const ds = pts[i][0] - pts[i - 1][0];
      A += ds * ((pts[i][1] + pts[i - 1][1]) / 2 - zReg);
    }
    return Math.abs(A);
  },

  /** área-profundidad (Chamberlin 1910; Epard & Groshong 1993):
   *  A_i = S · (zReg_i − zDesp) → regresión: S = pendiente (acortamiento), zDesp = −b/S */
  areaDepth(items) {    // [{A, zReg}]
    const n = items.length;
    if (n < 2) return null;
    const mx = items.reduce((s, x) => s + x.zReg, 0) / n, my = items.reduce((s, x) => s + x.A, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (const x of items) { sxy += (x.zReg - mx) * (x.A - my); sxx += (x.zReg - mx) ** 2; syy += (x.A - my) ** 2; }
    if (sxx < 1e-9) return null;
    const S = sxy / sxx, b = my - S * mx;
    return { S, zDetach: -b / S, r2: syy > 0 ? (sxy * sxy) / (sxx * syy) : 1 };
  },

  /* ---------------- orientación: eje β/π y ajuste de plano ---------------- */
  /** autovalores/vectores de una matriz simétrica 3×3 (Jacobi). Ordenados de mayor a menor */
  eig3(A) {
    const a = A.map((r) => r.slice());
    let V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let sweep = 0; sweep < 50; sweep++) {
      let off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
      if (off < 1e-14) break;
      for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
        if (Math.abs(a[p][q]) < 1e-15) continue;
        const th = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
        const c = Math.cos(th), s = Math.sin(th);
        for (let k = 0; k < 3; k++) {          // A' = Jᵀ A J
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
        }
      }
    }
    const res = [0, 1, 2].map((i) => ({ val: a[i][i], vec: [V[0][i], V[1][i], V[2][i]] }));
    return res.sort((x, y) => y.val - x.val);
  },

  /** vector (E, N, arriba) → {trend, plunge} hacia abajo */
  toTP(v) {
    let [e, n, u] = v;
    if (u > 0) { e = -e; n = -n; u = -u; }     // hemisferio inferior
    return { trend: (Math.atan2(e, n) / this.D2R + 360) % 360, plunge: Math.asin(Math.min(1, -u / Math.hypot(e, n, u))) / this.D2R };
  },

  /** polo de un plano (manteo, dirección de manteo) como vector (E, N, arriba) */
  pole(dip, dir) {
    const t = (dir + 180) * this.D2R, p = (90 - dip) * this.D2R;
    return [Math.sin(t) * Math.cos(p), Math.cos(t) * Math.cos(p), -Math.sin(p)];
  },

  /** eje π de un pliegue cilíndrico: el autovector menor del tensor de orientación de los polos.
   *  Devuelve también la «calidad» (forma de guirnalda): λ2/λ1 alto y λ3 bajo = buen ajuste. */
  piAxis(planes) {
    if (planes.length < 3) return null;
    const T = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const p of planes) {
      const v = this.pole(p.dip, p.dir);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) T[i][j] += v[i] * v[j];
    }
    const e = this.eig3(T);
    const n = planes.length;
    return { ...this.toTP(e[2].vec), l1: e[0].val / n, l2: e[1].val / n, l3: e[2].val / n };
  },

  /** plano de mejor ajuste por puntos [[E, N, z]…] (tres puntos = problema de tres puntos).
   *  `ok` falso si los puntos están casi en línea recta (el plano queda indeterminado). */
  fitPlane(xyz) {
    const n = xyz.length;
    if (n < 3) return null;
    const c = [0, 1, 2].map((k) => xyz.reduce((s, p) => s + p[k], 0) / n);
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const p of xyz) {
      const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += d[i] * d[j];
    }
    const e = this.eig3(C);
    let nv = e[2].vec;
    if (nv[2] < 0) nv = nv.map((x) => -x);          // normal hacia arriba
    const h = Math.hypot(nv[0], nv[1]);
    const dip = Math.atan2(h, nv[2]) / this.D2R;
    const dir = (Math.atan2(nv[0], nv[1]) / this.D2R + 360) % 360;
    const rms = Math.sqrt(Math.max(0, e[2].val) / n);
    return { dip, dir, rms, ok: e[1].val > 0.01 * e[0].val, spread: Math.sqrt(e[1].val / n) };
  },
};

if (typeof module === "object" && module.exports) module.exports = Construct;
