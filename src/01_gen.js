// ---------------------------------------------------------------------------
// World generator: seeded cave graph -> SDF primitives, lights, water, route
// ---------------------------------------------------------------------------
const VOX = 0.4, NX = 768, NY = 384, NZ = 768;
const WX = NX * VOX, WY = NY * VOX, WZ = NZ * VOX;
const BRICK_V = 16, BRICK = BRICK_V * VOX, NBX = NX / BRICK_V, NBY = NY / BRICK_V, NBZ = NZ / BRICK_V;
const MROCK = 3, WARP_MAX = 3.5;
const MAXPRIM = 6000, PRIM_F = 24;
const prim = new Float32Array(MAXPRIM * PRIM_F);
let nPrim = 0;
const NOF = -1e9, NOC = 1e9;

let _s = 20261114;
function rnd() { _s = _s + 0x6D2B79F5 | 0; let t = Math.imul(_s ^ _s >>> 15, 1 | _s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }
const rr = (a, b) => a + (b - a) * rnd();
const lerp = (a, b, t) => a + (b - a) * t;
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm3 = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// ---- integer-hash value noise, mirrored exactly in WGSL (domain warp) ----
function h3(x, y, z, s) {
  let h = Math.imul(x | 0, 0x8da6b343) ^ Math.imul(y | 0, 0xd8163841) ^ Math.imul(z | 0, 0xcb1ab31f) ^ Math.imul(s, 0x9e3779b9);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return h >>> 0;
}
const _v = [0, 0, 0], _c = new Float64Array(24);
function vn3(px, py, pz, s) {
  const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
  let fx = px - ix, fy = py - iy, fz = pz - iz;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  for (let k = 0; k < 8; k++) {
    const h = h3(ix + (k & 1), iy + (k >> 1 & 1), iz + (k >> 2), s);
    _c[k * 3] = (h & 1023) / 511.5 - 1; _c[k * 3 + 1] = (h >>> 10 & 1023) / 511.5 - 1; _c[k * 3 + 2] = (h >>> 20 & 1023) / 511.5 - 1;
  }
  for (let j = 0; j < 3; j++) {
    const a = lerp(lerp(_c[j], _c[3 + j], fx), lerp(_c[6 + j], _c[9 + j], fx), fy);
    const b = lerp(lerp(_c[12 + j], _c[15 + j], fx), lerp(_c[18 + j], _c[21 + j], fx), fy);
    _v[j] = lerp(a, b, fz);
  }
  return _v;
}
function warp(p) {
  let a = vn3(p[0] / 31, 0, p[2] / 31, 1); const ax = a[0], az = a[2];
  a = vn3(p[0] / 9.7, 0, p[2] / 9.7, 2); const bx = a[0], bz = a[2];
  a = vn3(p[0] / 27, p[1] / 27, p[2] / 27, 3); const cy = a[1];
  a = vn3(p[0] / 8.3, p[1] / 8.3, p[2] / 8.3, 4); const dy = a[1];
  return [ax * 2.6 + bx * 0.8, cy * 2.4 + dy * 0.7, az * 2.6 + bz * 0.8];
}
// nominal (pre-warp) point -> world point :  p + warp(p) = c
function unwarp(c) {
  let p = c.slice();
  for (let i = 0; i < 8; i++) { const w = warp(p); p = [c[0] - w[0], c[1] - w[1], c[2] - w[2]]; }
  return p;
}

function noiseMax(R) { let n = 0, lam = 24; for (let o = 0; o < 5; o++) { n += 0.09 * lam * Math.min(1, Math.max(0, R / lam * 1.7 - 0.2)); lam *= 0.5; } return n; }

function qAxis(ax, ang) { const a = norm3(ax), s = Math.sin(ang / 2); return [a[0] * s, a[1] * s, a[2] * s, Math.cos(ang / 2)]; }
function qRand(amt = 1) { return qAxis([rr(-1, 1), rr(-1, 1), rr(-1, 1)], rr(-Math.PI, Math.PI) * amt); }
// quaternion rotating +Y onto dir
function qFromY(d) { d = norm3(d); const ax = cross3([0, 1, 0], d); const l = Math.hypot(ax[0], ax[1], ax[2]); if (l < 1e-5) return d[1] > 0 ? [0, 0, 0, 1] : [1, 0, 0, 0]; return qAxis(ax, Math.atan2(l, d[1])); }
function qRot(q, v) { const u = [q[0], q[1], q[2]], c1 = cross3(u, v); const t = [c1[0] + q[3] * v[0], c1[1] + q[3] * v[1], c1[2] + q[3] * v[2]]; const c2 = cross3(u, t); return [v[0] + 2 * c2[0], v[1] + 2 * c2[1], v[2] + 2 * c2[2]]; }

const QI = [0, 0, 0, 1];
// type: 0 air cone, 1 air ellipsoid, 2 rock cone, 3 rock ellipsoid, 4 rock box, 5 crystal ; +8 = not warped
function addPrim(type, a, ra, b, rb, s, k, fy, Rn, cy, q, m) {
  if (nPrim >= MAXPRIM) throw 'too many prims';
  const o = nPrim++ * PRIM_F;
  prim[o] = a[0]; prim[o + 1] = a[1]; prim[o + 2] = a[2]; prim[o + 3] = ra;
  prim[o + 4] = b[0]; prim[o + 5] = b[1]; prim[o + 6] = b[2]; prim[o + 7] = rb;
  prim[o + 8] = s[0]; prim[o + 9] = s[1]; prim[o + 10] = s[2]; prim[o + 11] = k;
  prim[o + 12] = type; prim[o + 13] = fy; prim[o + 14] = Rn; prim[o + 15] = cy;
  prim[o + 16] = q[0]; prim[o + 17] = q[1]; prim[o + 18] = q[2]; prim[o + 19] = q[3];
  prim[o + 20] = m[0]; prim[o + 21] = m[1]; prim[o + 22] = m[2]; prim[o + 23] = m[3] || 0;
}
function cone(type, a, ra, b, rb, s, k, Rn, m, fy = NOF, cy = NOC) {
  const smin = Math.min(s[0], s[1], s[2]);
  let L = Math.hypot((b[0] - a[0]) / s[0], (b[1] - a[1]) / s[1], (b[2] - a[2]) / s[2]);
  if (L <= Math.abs(ra - rb) + 0.02) { const r = Math.max(ra, rb); const c = ra > rb ? a : b; a = c; b = [c[0], c[1] + 0.05 * s[1], c[2]]; ra = rb = r; }
  addPrim(type, a, ra, b, rb, s, k, fy, Rn < 0 ? Math.min(ra, rb) * smin : Rn, cy, QI, m);
}

// ---- paths ----
function cr(p0, p1, p2, p3, u) {
  const o = [0, 0, 0], u2 = u * u, u3 = u2 * u;
  for (let i = 0; i < 3; i++) o[i] = 0.5 * (2 * p1[i] + (-p0[i] + p2[i]) * u + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * u2 + (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * u3);
  return o;
}
function crPath(ctrl, step, wig) {
  const base = [], n = ctrl.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = ctrl[Math.max(i - 1, 0)], p1 = ctrl[i], p2 = ctrl[i + 1], p3 = ctrl[Math.min(i + 2, n - 1)];
    const m = Math.max(1, Math.round(dist3(p1, p2) / step));
    for (let j = 0; j < m; j++) base.push(cr(p0, p1, p2, p3, j / m));
  }
  base.push(ctrl[n - 1].slice());
  if (!(wig > 0)) return base;
  const ph = []; for (let i = 0; i < 8; i++) ph.push(rr(0, 6.283));
  const S = [0]; for (let i = 1; i < base.length; i++) S.push(S[i - 1] + dist3(base[i], base[i - 1]));
  const tot = S[S.length - 1], out = [];
  for (let i = 0; i < base.length; i++) {
    const a = base[Math.max(i - 1, 0)], b = base[Math.min(i + 1, base.length - 1)];
    const t = norm3(sub3(b, a)); let side = cross3(t, [0, 1, 0]); if (Math.hypot(side[0], side[1], side[2]) < 0.05) side = [1, 0, 0]; side = norm3(side);
    const up = cross3(side, t), s = S[i], env = Math.pow(Math.sin(Math.PI * s / tot), 0.6);
    const o1 = wig * env * (Math.sin(s * 0.31 + ph[0]) + 0.6 * Math.sin(s * 0.74 + ph[1]) + 0.3 * Math.sin(s * 1.63 + ph[2]));
    const o2 = wig * 0.45 * env * (Math.sin(s * 0.43 + ph[3]) + 0.5 * Math.sin(s * 1.1 + ph[4]));
    out.push([base[i][0] + side[0] * o1 + up[0] * o2, base[i][1] + side[1] * o1 + up[1] * o2, base[i][2] + side[2] * o1 + up[2] * o2]);
  }
  return out;
}
const M_ = (decor = 0, wet = 0, cry = 0) => [decor, wet, cry, 0];
function tunnel(pts, r0, r1, o = {}) {
  const k = o.k || 1.4, rv = o.rv == null ? 0.22 : o.rv, m = o.m || M_(0.08, 0.25), plain = !!o.s || o.raw;
  const p1 = rr(0, 6.28), p2 = rr(0, 6.28), p3 = rr(0, 6.28), p4 = rr(0, 6.28), p5 = rr(0, 6.28), n = pts.length - 1;
  const rad = i => lerp(r0, r1, i / n) * (1 + rv * (0.6 * Math.sin(i * 0.9 + p1) + 0.4 * Math.sin(i * 2.3 + p2)));
  // irregular cross-section: varying vertical stretch + an offset secondary lobe (keyholes, bedding-plane ellipses, side notches)
  const sy = i => plain ? 1 : 1 + 0.3 * Math.sin(i * 0.37 + p3) + 0.15 * Math.sin(i * 1.1 + p4);
  const off = i => {
    const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, n)], t = norm3(sub3(b, a));
    let side = cross3(t, [0, 1, 0]); if (Math.hypot(side[0], side[1], side[2]) < 0.05) side = [1, 0, 0]; side = norm3(side);
    const up = cross3(side, t), th = p5 + i * 0.23 + 1.3 * Math.sin(i * 0.31 + p1), mg = rad(i) * (0.75 + 0.3 * Math.sin(i * 0.53 + p2));
    return [pts[i][0] + (side[0] * Math.cos(th) + up[0] * Math.sin(th)) * mg, pts[i][1] + (side[1] * Math.cos(th) + up[1] * Math.sin(th)) * mg, pts[i][2] + (side[2] * Math.cos(th) + up[2] * Math.sin(th)) * mg];
  };
  const kf = i => 0.62 + 0.2 * Math.sin(i * 0.7 + p4);
  for (let i = 0; i < n; i++) {
    const s = o.s || [1, 0.5 * (sy(i) + sy(i + 1)), 1];
    cone(o.raw ? 8 : 0, pts[i], rad(i), pts[i + 1], rad(i + 1), s, k, -1, m);
    if (!plain) cone(0, off(i), rad(i) * kf(i), off(i + 1), rad(i + 1) * kf(i + 1), [1, 1, 1], k * 0.8, -1, m);
  }
  if (!plain && !o.noflare) for (const e of [0, n]) for (let j = 0; j < 2; j++) {   // ragged mouths
    const r = rad(e), c = [pts[e][0] + rr(-1, 1) * r, pts[e][1] + rr(-0.6, 0.9) * r, pts[e][2] + rr(-1, 1) * r];
    const lr = [r * rr(1.1, 1.9), r * rr(0.8, 1.6), r * rr(1.1, 1.9)];
    addPrim(1, c, 0, c, 0, lr, 1.3, NOF, Math.min(lr[0], lr[1], lr[2]), NOC, qRand(0.4), m);
  }
  return pts;
}
function chamber(c, r, o = {}) {
  const fy = o.fy == null ? NOF : o.fy, cy = o.cy == null ? NOC : o.cy, k = o.k || 3.5, m = o.m || M_(0.3, 0.3);
  const Rn = Math.min(r[0], r[1], r[2]);
  addPrim(1, c, 0, c, 0, r, k, fy, o.Rn || Rn, cy, o.q || QI, m);
  for (let i = 0; i < (o.lobes || 0); i++) {
    const d = norm3([rr(-1, 1), rr(-0.6, 0.8), rr(-1, 1)]), f = rr(0.55, 0.95);
    const pc = [c[0] + d[0] * r[0] * f, c[1] + d[1] * r[1] * f, c[2] + d[2] * r[2] * f];
    const lr = [r[0] * rr(0.25, 0.5), r[1] * rr(0.25, 0.55), r[2] * rr(0.25, 0.5)];
    addPrim(1, pc, 0, pc, 0, lr, k, fy, Math.min(lr[0], lr[1], lr[2]), cy, qRand(0.25), m);
  }
}
// ceiling / floor of an ellipsoid chamber at (x,z) (nominal space)
function ellY(c, r, x, z, fy) {
  const q = 1 - ((x - c[0]) / r[0]) ** 2 - ((z - c[2]) / r[2]) ** 2; if (q <= 0) return null;
  const h = r[1] * Math.sqrt(q); return [Math.max(c[1] - h, fy == null ? NOF : fy), c[1] + h];
}
const FM = M_(1, 0.55, 0);
function stalactite(x, z, yc, len, r, m = FM) {
  const lx = rr(-0.06, 0.06) * len, lz = rr(-0.06, 0.06) * len, ym = yc - len * rr(0.3, 0.45);
  cone(2, [x, yc + 3.5, z], r * 1.35, [x + lx * 0.4, ym, z + lz * 0.4], r * 0.55, [1, 1, 1], 0.7, r * 0.06, m);
  cone(2, [x + lx * 0.4, ym, z + lz * 0.4], r * 0.55, [x + lx, yc - len, z + lz], Math.max(0.22, r * 0.2), [1, 1, 1], 0.3, r * 0.04, m);
}
function stalagmite(x, z, yf, len, r, m = FM) {
  const lx = rr(-0.05, 0.05) * len, lz = rr(-0.05, 0.05) * len, ym = yf + len * rr(0.35, 0.5);
  cone(2, [x, yf - 3, z], r * 1.5, [x + lx * 0.4, ym, z + lz * 0.4], r * 0.62, [1, 1, 1], 0.9, r * 0.07, m);
  cone(2, [x + lx * 0.4, ym, z + lz * 0.4], r * 0.62, [x + lx, yf + len, z + lz], Math.max(0.24, r * 0.22), [1, 1, 1], 0.35, r * 0.05, m);
}
function column(x, z, yf, yc, r, m = FM) {
  const h = yc - yf, y1 = yf + h * rr(0.28, 0.42), y2 = yf + h * rr(0.6, 0.75);
  const o1 = [rr(-0.5, 0.5) * r, rr(-0.5, 0.5) * r], o2 = [rr(-0.5, 0.5) * r, rr(-0.5, 0.5) * r];
  cone(2, [x, yf - 4, z], r * 1.7, [x + o1[0], y1, z + o1[1]], r * 0.8, [1, 1, 1], 1.5, r * 0.09, m);
  cone(2, [x + o1[0], y1, z + o1[1]], r * 0.8, [x + o2[0], y2, z + o2[1]], r * 0.72, [1, 1, 1], 0.5, r * 0.09, m);
  cone(2, [x + o2[0], y2, z + o2[1]], r * 0.72, [x, yc + 4, z], r * 1.8, [1, 1, 1], 1.5, r * 0.09, m);
}
const BM = M_(0, 0.15, 0);
function boulder(p, r, m = BM) {
  if (rnd() < 0.7) { const h = [r * rr(0.6, 1.1), r * rr(0.42, 0.85), r * rr(0.6, 1.1)]; addPrim(4, p, Math.min(h[0], h[1], h[2]) * rr(0.18, 0.4), p, 0, h, 0.25, NOF, r * 0.1, NOC, qRand(1), m); if (rnd() < 0.5) { const q = [p[0] + rr(-0.6, 0.6) * r, p[1] + rr(-0.3, 0.5) * r, p[2] + rr(-0.6, 0.6) * r], h2 = [r * rr(0.35, 0.7), r * rr(0.3, 0.6), r * rr(0.35, 0.7)]; addPrim(4, q, Math.min(h2[0], h2[1], h2[2]) * 0.3, q, 0, h2, 0.2, NOF, r * 0.08, NOC, qRand(1), m); } }
  else { const rad = [r * rr(0.75, 1.25), r * rr(0.55, 0.95), r * rr(0.75, 1.25)]; addPrim(3, p, 0, p, 0, rad, 0.25, NOF, r * 0.14, NOC, qRand(1), m); }
}
function slab(p, half, q, m = BM) { addPrim(4, p, Math.min(half[0], half[1], half[2]) * 0.35, p, 0, half, 0.3, NOF, 0.12, NOC, q, m); }
const crys = [];
function crystal(p, dir, len, r) { dir = norm3(dir); crys.push({ c: [p[0] + dir[0] * len * 0.5, p[1] + dir[1] * len * 0.5, p[2] + dir[2] * len * 0.5], q: qFromY(dir), r, h: len * 0.5 }); addPrim(5, [p[0] + dir[0] * len * 0.5, p[1] + dir[1] * len * 0.5, p[2] + dir[2] * len * 0.5], 0, p, 0, [r, len * 0.5, r], 0.05, NOF, 0, NOC, qFromY(dir), M_(0, 0.2, 1)); }

const lights = [], pools = [], falls = [], bursts = [], poses = [];
// type 0 point, 1 beam, 2 fluorescent point (emissive patches)
function light(p, range, col, I, type = 0, dir = [0, -1, 0], R = 2, snap = true) { lights.push({ p: p.slice(), range, col: [col[0] * I, col[1] * I, col[2] * I], type, dir, R, snap }); }
// sky opening: unwarped straight chimney along the beam, plus a beam light
function skylight(bottom, dir, rB, rT, col, I, reach, beamR) {
  dir = norm3(dir); const len = (WY + 5 - bottom[1]) / -dir[1];
  const top = [bottom[0] - dir[0] * len, WY + 5, bottom[2] - dir[2] * len];
  const lo = [bottom[0] + dir[0] * 7, bottom[1] + dir[1] * 7, bottom[2] + dir[2] * 7];
  const N = Math.ceil((len + 7) / 6);
  for (let i = 0; i < N; i++) {
    const a = [0, 0, 0], b = [0, 0, 0];
    for (let j = 0; j < 3; j++) { a[j] = lerp(top[j], lo[j], i / N); b[j] = lerp(top[j], lo[j], (i + 1) / N); }
    cone(8, a, lerp(rT, rB, i / N), b, lerp(rT, rB, (i + 1) / N), [1, 1, 1], 1.0, Math.min(rB, rT) * 0.8, M_(0.05, 0.4));
  }
  lights.push({ p: top, range: len + reach, col: [col[0] * I, col[1] * I, col[2] * I], type: 1, dir, R: beamR, snap: false });
}

// ===========================================================================
// LAYOUT
// ===========================================================================
const C_COLD = [0.62, 0.78, 1.0], C_DAY = [1.0, 0.93, 0.8], C_AMB = [1.0, 0.56, 0.2], C_CYAN = [0.25, 0.95, 1.0], C_VIO = [0.6, 0.35, 1.0], C_GRN = [0.35, 1.0, 0.65], C_PALE = [0.75, 0.86, 1.0];
const R = {};   // named tunnel polylines for the route

// --- start passage ---
R.start = tunnel(crPath([[38, 80, 48], [46, 79.5, 55], [54, 80.5, 56], [60, 79, 63], [68, 78, 70]], 2.5, 0.7), 1.3, 1.6, { rv: 0.25, m: M_(0.07, 0.4) });
tunnel(crPath([[38, 80, 48], [31, 80.5, 44], [24, 82, 40]], 2.5, 0.5), 1.25, 1.35, { m: M_(0.2, 0.3) });
chamber([22, 83, 38], [5, 3.2, 4.5], { lobes: 2, k: 2, m: M_(0.4, 0.3) });
light([50, 80.3, 57], 8, C_CYAN, 0.12, 2);

// --- B: stalactite chamber ---
const B = { c: [86, 78, 84], r: [21, 9.5, 17], fy: 72 };
chamber(B.c, B.r, { fy: B.fy, lobes: 6, k: 3, m: M_(0.95, 0.6) });
for (let i = 0; i < 90; i++) {
  const a = rr(0, 6.283), f = Math.sqrt(rnd()) * 0.92, x = B.c[0] + Math.cos(a) * B.r[0] * f, z = B.c[2] + Math.sin(a) * B.r[2] * f;
  const y = ellY(B.c, B.r, x, z, B.fy); if (!y) continue;
  const h = y[1] - y[0], t = rnd();
  if (t < 0.5) stalactite(x, z, y[1], Math.min(h * 0.8, rr(2.5, 9)), rr(0.4, 1.1));
  else if (t < 0.85) stalagmite(x, z, y[0], Math.min(h * 0.75, rr(1.5, 7)), rr(0.45, 1.2));
  else column(x, z, y[0], y[1], rr(0.5, 1.1));
}
skylight([92, 85, 88], [0.33, -1, -0.2], 1.5, 1.2, C_AMB, 18, 22, 2.6);
light([74, 76, 92], 13, C_AMB, 1.6, 2);
light([99, 75, 74], 12, C_AMB, 1.2, 2);

// --- C: the squeeze (tight, consecutive sharp turns, progressively tighter) ---
R.squeeze = tunnel(crPath([[104, 76.5, 89], [110, 76, 95.5], [106, 75, 102], [113.5, 74, 106], [110.5, 72.5, 113.5], [119, 71, 117], [117, 69, 124.5], [125, 67, 127.5], [130, 65.5, 133], [137, 64.5, 136.5], [141, 64, 139]], 2.0, 0.25),
  1.25, 0.72, { rv: 0.16, k: 0.9, m: M_(0.05, 0.45) });

// --- D: cathedral ---
const D = { c: [172, 66, 160], r: [44, 32, 38], fy: 42 };
chamber(D.c, D.r, { fy: D.fy, lobes: 9, k: 5, m: M_(0.45, 0.35) });
{
  const cols = [[152, 150, 3.2], [163, 172, 2.6], [176, 146, 3.6], [186, 170, 2.4], [170, 160, 2.0], [194, 154, 3.0], [158, 162, 1.7], [181, 181, 2.8], [166, 139, 2.2], [147, 168, 2.3], [200, 166, 2.0], [188, 140, 1.8]];
  for (const [x, z, r] of cols) { const y = ellY(D.c, D.r, x, z, D.fy); if (y) column(x, z, y[0], y[1], r); }
  for (let i = 0; i < 60; i++) {
    const a = rr(0, 6.283), f = Math.sqrt(rnd()) * 0.9, x = D.c[0] + Math.cos(a) * D.r[0] * f, z = D.c[2] + Math.sin(a) * D.r[2] * f;
    const y = ellY(D.c, D.r, x, z, D.fy); if (!y) continue;
    if (Math.hypot(x - 181, z - 164) < 9) continue;      // keep the light shaft clear
    if (rnd() < 0.55) stalactite(x, z, y[1], rr(4, 16), rr(0.8, 2.2)); else stalagmite(x, z, y[0], rr(2, 11), rr(0.8, 2.4));
  }
  for (let i = 0; i < 22; i++) { const a = rr(0, 6.283), f = rr(0.3, 0.85); boulder([D.c[0] + Math.cos(a) * D.r[0] * f, D.fy + rr(-0.3, 0.8), D.c[2] + Math.sin(a) * D.r[2] * f], rr(0.8, 3)); }
}
skylight([181, 95, 164], [-0.2, -1, 0.11], 5.6, 3.8, C_COLD, 25, 62, 8.5);
light([150, 52, 178], 18, C_CYAN, 1.3, 2);
light([199, 60, 143], 16, C_CYAN, 0.9, 2);

// --- D -> E : low crawl ---
R.crawl = tunnel(crPath([[190, 45.5, 174.5], [197, 46, 181], [204, 46.3, 187.5], [211, 45.6, 194], [217, 44.5, 200]], 2.5, 0.5), 2.1, 2.3, { s: [1.5, 0.42, 1.5], rv: 0.12, k: 1.0, m: M_(0.25, 0.75) });

// --- E: lake ---
const E = { c: [228, 45, 212], r: [30, 11, 26], fy: 36 };
chamber(E.c, E.r, { fy: E.fy, lobes: 7, k: 3.5, m: M_(0.6, 0.9) });
chamber([242, 56, 225], [9, 17, 9], { lobes: 2, k: 3, m: M_(0.5, 1) });
pools.push([228, 212, 41.5, 40]);
for (let i = 0; i < 40; i++) {
  const a = rr(0, 6.283), f = Math.sqrt(rnd()) * 0.95, x = E.c[0] + Math.cos(a) * E.r[0] * f, z = E.c[2] + Math.sin(a) * E.r[2] * f;
  const y = ellY(E.c, E.r, x, z, E.fy); if (!y) continue;
  const t = rnd();
  if (t < 0.6) stalactite(x, z, y[1], rr(2, 7), rr(0.4, 1.0)); else if (t < 0.85) stalagmite(x, z, y[0], rr(3, 8), rr(0.6, 1.5)); else boulder([x, 41 + rr(-1, 0.6), z], rr(1, 2.6));
}
tunnel(crPath([[263, 69.5, 246], [257, 68, 240], [251, 67, 233.5], [246.5, 66.5, 229]], 2.5, 0.4), 1.5, 1.3, { m: M_(0.3, 1) });
chamber([265, 70.5, 248], [5, 3.5, 4.5], { lobes: 2, k: 2, m: M_(0.5, 1) });
falls.push({ top: [247.2, 66.1, 229.6], h: 24.4, dir: [-0.62, -0.5], w: 1.3 });
skylight([240.5, 70, 222], [0.05, -1, 0.04], 1.6, 1.2, C_PALE, 24, 34, 2.8);
skylight([224, 54, 207], [-0.12, -1, 0.1], 2.4, 1.6, C_COLD, 22, 22, 3.6);
light([212, 44, 222], 20, C_CYAN, 2.6, 2);
light([236, 45, 192], 18, C_GRN, 2.0, 2);
light([248, 44, 214], 16, C_CYAN, 2.0, 2);

// --- E -> F : fissure into the chasm ---
R.fissure = tunnel(crPath([[251, 46, 204.5], [257, 47.5, 199.5], [262.5, 49, 194], [267, 50.5, 189.5], [271, 51.5, 186.5]], 2.0, 0.3), 0.62, 0.55, { s: [1, 5.5, 1], rv: 0.12, k: 1.2, m: M_(0.15, 0.6) });

// --- F: the chasm ---
cone(0, [277, 70, 122], 8.5, [277.5, 70, 164], 9.5, [1, 7.4, 1], 4, 8, M_(0.2, 0.4));
cone(0, [273, 70, 158], 9, [272, 70, 198], 7.5, [1, 7.4, 1], 4, 8, M_(0.2, 0.4));
chamber([281, 96, 150], [9, 20, 14], { k: 4, m: M_(0.2, 0.4) });
chamber([270, 34, 172], [10, 16, 13], { k: 4, m: M_(0.2, 0.5) });
cone(2, [262, 48.3, 181.5], 2.3, [274, 49.6, 180.5], 1.3, [1, 0.7, 1.5], 1.2, 0.4, BM); cone(2, [274, 49.6, 180.5], 1.3, [287, 49.2, 179], 2.4, [1, 0.75, 1.4], 1.2, 0.4, BM);   // natural bridge
for (let i = 0; i < 5; i++) boulder([rr(266, 284), 50.2 + rr(0, 0.6), 180 + rr(-1.4, 1.4)], rr(0.5, 1.1));
cone(2, [266, 76, 150], 2.6, [288, 81, 153], 1.9, [1, 1, 1], 1.5, 0.4, BM);
cone(2, [264, 30, 160], 3.2, [286, 26, 166], 2.4, [1, 1, 1], 1.5, 0.5, BM);
cone(2, [265, 104, 176], 2.2, [284, 99, 171], 2.8, [1, 1, 1], 1.5, 0.4, BM);
for (let i = 0; i < 7; i++) { const y = rr(18, 125), z = rr(130, 194), r = rr(1.6, 3.2); cone(2, [262, y + rr(-3, 3), z + rr(-4, 4)], r * rr(0.8, 1.3), [290, y + rr(-3, 3), z + rr(-4, 4)], r, [1, rr(0.7, 1.3), 1], 1.5, r * 0.18, BM); }   // wedged chockstones spanning the walls
light([275, 12, 162], 95, C_AMB, 800, 0, [0, 1, 0], 6, false);
light([278, 16, 138], 80, [1.0, 0.4, 0.12], 480, 0, [0, 1, 0], 6, false);
skylight([279, 112, 148], [0.05, -1, 0.12], 1.5, 1.1, C_COLD, 26, 110, 3.2);

// --- F -> G ---
R.toG = tunnel(crPath([[270, 71, 127.5], [263, 74, 120.5], [256.5, 78, 111.5], [250, 81, 103]], 2.5, 0.5), 1.45, 1.8, { m: M_(0.06, 0.3) });

// --- G: collapsed cavern ---
const G = { c: [232, 84, 94], r: [26, 12, 22], fy: 77 };
chamber(G.c, G.r, { fy: G.fy, lobes: 6, k: 3, m: M_(0.08, 0.2) });
chamber([236, 95, 96], [10, 10, 9], { lobes: 3, k: 3, m: M_(0.05, 0.2) });
for (let i = 0; i < 70; i++) {
  const a = rr(0, 6.283), f = Math.pow(rnd(), 0.7), x = 236 + Math.cos(a) * 17 * f, z = 97 + Math.sin(a) * 15 * f;
  const pile = Math.max(0, 1 - f) * 7; boulder([x, G.fy + rr(-0.5, 0.5) + pile * rnd(), z], rr(0.9, 3.6) * (rnd() < 0.12 ? 1.6 : 1));
}
for (let i = 0; i < 14; i++) {
  const a = rr(0, 6.283), f = rr(0.1, 0.8);
  slab([232 + Math.cos(a) * 20 * f, G.fy + rr(0.5, 5), 94 + Math.sin(a) * 17 * f], [rr(2.5, 5.5), rr(0.5, 1.1), rr(1.8, 4)], qAxis([rr(-1, 1), rr(-0.3, 0.3), rr(-1, 1)], rr(0.25, 1.1)));
}
for (let i = 0; i < 6; i++) { const a = rr(0, 6.283); slab([234 + Math.cos(a) * 9, 98 + rr(0, 5), 96 + Math.sin(a) * 8], [rr(3, 6), rr(0.6, 1.2), rr(2, 4)], qAxis([rr(-1, 1), 0, rr(-1, 1)], rr(0.2, 0.7))); }
skylight([238, 101, 97], [-0.1, -1, 0.06], 1.9, 1.2, C_PALE, 17, 26, 3.2);
skylight([226, 94, 88], [0.07, -1, -0.09], 1.3, 0.9, C_PALE, 15, 20, 2.4);
bursts.push([238, 98, 99], [228, 93, 90], [243, 94, 92], [233, 95, 101]);

// --- D -> G : high gallery ---
tunnel(crPath([[196, 84, 143], [205, 85, 128], [214, 85.5, 113], [222, 85, 104]], 2.5, 1.2), 1.5, 1.7, { m: M_(0.2, 0.2) });

// --- G -> H ---
R.toH = tunnel(crPath([[212, 86, 85], [206.5, 89, 79.5], [201, 93, 73.5], [196.5, 98, 68.5]], 2.0, 0.4), 1.2, 1.05, { k: 1, m: M_(0.05, 0.35, 0.3) });

// --- H: crystal chamber ---
const H = { c: [190, 100.5, 64], r: [13, 8, 11], fy: 95.5 };
chamber(H.c, H.r, { fy: H.fy, lobes: 4, k: 2.5, m: M_(0.1, 0.35, 1) });
for (let c = 0; c < 17; c++) {
  const d = norm3([rr(-1, 1), c % 3 == 0 ? rr(0.2, 1) : rr(-1, 0.3), rr(-1, 1)]);
  const p = [H.c[0] + d[0] * H.r[0] * 0.97, Math.max(H.fy - 0.4, H.c[1] + d[1] * H.r[1] * 0.97), H.c[2] + d[2] * H.r[2] * 0.97];
  const base = norm3([-d[0], -d[1] + (p[1] < H.fy ? 1.4 : 0), -d[2]]), nc = 3 + Math.floor(rnd() * 1.7);
  for (let i = 0; i < nc; i++) {
    const inn = norm3([base[0] + rr(-0.75, 0.75), base[1] + rr(-0.75, 0.75), base[2] + rr(-0.75, 0.75)]), big = i == 0;
    const q = [p[0] + rr(-1.1, 1.1) - inn[0] * 1.3, p[1] + rr(-0.6, 0.6) - inn[1] * 1.3, p[2] + rr(-1.1, 1.1) - inn[2] * 1.3];
    crystal(q, inn, big ? rr(5.5, 9) : rr(2.8, 5), big ? rr(0.7, 1.0) : rr(0.45, 0.65));
  }
}
light([184, 98, 60], 16, [0.5, 0.92, 1], 1.2, 2); light([196, 103, 69], 15, [0.72, 0.6, 1], 1.2, 2); light([190, 97, 71], 14, [0.5, 0.92, 1], 0.8, 2); light([195, 99, 57], 14, [0.72, 0.6, 1], 0.8, 2); light([183, 103, 68], 13, [0.6, 1, 0.85], 0.6, 2);

// --- H -> I ---
R.toI = tunnel(crPath([[179.5, 99.5, 62], [169, 98.5, 57], [158, 97.5, 62], [147, 96.5, 58], [138, 95.5, 60], [129, 95, 60]], 2.5, 0.6), 1.5, 1.7, { m: M_(0.06, 0.35, 0.15) });

// --- I: the great shaft (open to the sky) ---
cone(0, [120, 20, 60], 14.5, [120, 96, 60], 11, [1, 1, 1], 4, 11, M_(0.15, 0.6), 22);
cone(0, [120, 96, 60], 11, [120, 160, 60], 6.2, [1, 1, 1], 4, 6.5, M_(0.1, 0.5));
chamber([127, 70, 66], [10, 14, 9], { k: 4, m: M_(0.2, 0.5) });
chamber([113, 118, 55], [8, 13, 8], { k: 4, m: M_(0.2, 0.5) });
cone(2, [108, 84, 49], 3.2, [118, 82.5, 52], 1.6, [1, 1, 1], 1.5, 0.4, BM);
cone(2, [133, 108, 66], 3.4, [124, 106, 63], 1.5, [1, 1, 1], 1.5, 0.4, BM);
for (let i = 0; i < 16; i++) { const a = rr(0, 6.283), f = Math.sqrt(rnd()) * 11; boulder([120 + Math.cos(a) * f, 22 + rr(-0.5, 1.2), 60 + Math.sin(a) * f], rr(0.8, 2.8)); }
pools.push([120, 60, 22.7, 17]);
{ const top = unwarp([120, WY + 3, 60]); lights.push({ p: top, range: 150, col: [C_DAY[0] * 15, C_DAY[1] * 15, C_DAY[2] * 15], type: 1, dir: norm3([0.045, -1, 0.035]), R: 5.2, snap: false }); }
// shaft bottom -> back of the start passage (loop)
tunnel(crPath([[110, 25.5, 52], [98, 29, 42], [84, 36, 34], [68, 46, 29], [52, 58, 28], [38, 70, 32], [27, 79, 37], [23, 82, 39]], 2.5, 1.5), 1.7, 1.3, { m: M_(0.2, 0.5) });

// --- J: the void ---
const J = { c: [84, 74, 222], r: [36, 62, 40] };
chamber(J.c, J.r, { lobes: 8, k: 6, m: M_(0.25, 0.4) });
for (let i = 0; i < 26; i++) {
  const a = rr(0, 6.283), f = Math.sqrt(rnd()) * 0.85, x = J.c[0] + Math.cos(a) * J.r[0] * f, z = J.c[2] + Math.sin(a) * J.r[2] * f;
  const y = ellY(J.c, J.r, x, z); if (!y) continue;
  if (i & 1) stalactite(x, z, y[1], rr(14, 48), rr(2, 5)); else stalagmite(x, z, y[0], rr(12, 44), rr(2.2, 5.5));
}
R.toJ = tunnel(crPath([[130, 68, 168], [125, 70, 180], [121, 71.5, 193], [116, 72, 204], [111, 72, 209]], 2.5, 0.8), 1.6, 2.3, { m: M_(0.2, 0.3) });
cone(2, [117, 68.5, 205], 3.5, [106, 69, 212], 2.2, [1, 0.6, 1], 1.2, 0.3, BM);                 // ledge
tunnel(crPath([[84, 76, 99], [81, 74.5, 113], [73, 77, 128], [78, 80, 146], [70, 83, 163], [73, 86, 178], [74, 88, 191]], 2.5, 1.3), 1.3, 1.1, { rv: 0.3, m: M_(0.2, 0.3) });
light([60, 96, 200], 33, C_GRN, 5.7, 2); light([108, 48, 238], 33, C_CYAN, 5.7, 2); light([66, 40, 246], 31, C_CYAN, 4.2, 2);
light([98, 118, 204], 31, C_GRN, 4.2, 2); light([56, 70, 236], 29, C_VIO, 3.9, 2); light([104, 84, 250], 31, C_CYAN, 4.7, 2); light([84, 22, 214], 33, C_GRN, 3.9, 2);

// --- random side worms: dead ends, pockets, hidden openings ---
function worm(p, d, len, r) {
  const ctrl = [p.slice()]; d = norm3(d);
  for (let s = 0; s < len; s += 9) {
    d = norm3([d[0] + rr(-0.7, 0.7), d[1] * 0.6 + rr(-0.35, 0.35), d[2] + rr(-0.7, 0.7)]);
    const q = ctrl[ctrl.length - 1], n = [q[0] + d[0] * 9, q[1] + d[1] * 9, q[2] + d[2] * 9];
    n[0] = Math.min(WX - 26, Math.max(26, n[0])); n[1] = Math.min(132, Math.max(14, n[1])); n[2] = Math.min(WZ - 26, Math.max(26, n[2]));
    ctrl.push(n);
  }
  tunnel(crPath(ctrl, 2.5, 0.8), r, r * rr(0.5, 1.0), { rv: 0.3, m: M_(rr(0.05, 0.4), rr(0.1, 0.6)) });
  const e = ctrl[ctrl.length - 1];
  if (rnd() < 0.6) { chamber(e, [rr(4, 8), rr(2.5, 5), rr(4, 8)], { lobes: 3, k: 2, m: M_(rr(0.2, 0.9), rr(0.2, 0.7), rnd() < 0.3 ? 0.8 : 0) }); if (rnd() < 0.6) light([e[0], e[1], e[2]], 10, [C_CYAN, C_GRN, C_VIO, C_AMB][i4()], 0.9, 2); }
  return e;
}
function i4() { return Math.floor(rnd() * 4); }
worm([56, 80, 58], [0.3, 0.2, -1], 40, 1.0);
worm([70, 76, 92], [-1, -0.2, 0.4], 50, 1.2);
worm([150, 60, 196], [-0.2, -0.3, 1], 60, 1.5);
worm([212, 50, 160], [1, 0.4, -0.3], 45, 1.3);
worm([216, 80, 138], [0.2, 0.3, 1], 40, 1.1);
worm([160, 98, 60], [0, 0.4, -1], 35, 1.0);
worm([206, 44, 232], [-0.6, -0.1, 1], 50, 1.3);
worm([247, 84, 78], [1, 0.1, -0.5], 40, 1.2);
worm([120, 70, 122], [-0.4, 0.5, -1], 40, 0.9);
worm([150, 44, 150], [-1, -0.4, -0.2], 45, 1.4);
worm([262, 60, 205], [0.6, 0.5, 1], 30, 0.9);

// ===========================================================================
// brick lists
// ===========================================================================
const NBR = NBX * NBY * NBZ;
const bhdr = new Uint32Array(NBR * 2);
let bidx;
{
  const bb = new Int32Array(nPrim * 6), cntA = new Uint16Array(NBR), cntR = new Uint16Array(NBR);
  for (let i = 0; i < nPrim; i++) {
    const o = i * PRIM_F, ty = prim[o + 12] & 7, air = ty < 2, raw = prim[o + 12] >= 8;
    let lo = [0, 0, 0], hi = [0, 0, 0];
    if (ty == 0 || ty == 2) {
      for (let j = 0; j < 3; j++) {
        const ea = prim[o + 3] * prim[o + 8 + j], eb = prim[o + 7] * prim[o + 8 + j];
        lo[j] = Math.min(prim[o + j] - ea, prim[o + 4 + j] - eb); hi[j] = Math.max(prim[o + j] + ea, prim[o + 4 + j] + eb);
      }
    } else {
      const q = [prim[o + 16], prim[o + 17], prim[o + 18], prim[o + 19]];
      const ex = qRot(q, [1, 0, 0]), ey = qRot(q, [0, 1, 0]), ez = qRot(q, [0, 0, 1]);
      for (let j = 0; j < 3; j++) { const e = Math.hypot(ex[j] * prim[o + 8], ey[j] * prim[o + 9], ez[j] * prim[o + 10]); lo[j] = prim[o + j] - e; hi[j] = prim[o + j] + e; }
    }
    const mg = (air ? MROCK + noiseMax(prim[o + 14]) + 0.6 : 2.0) + prim[o + 11] + (raw ? 0 : WARP_MAX);
    const nb = [NBX, NBY, NBZ];
    for (let j = 0; j < 3; j++) { bb[i * 6 + j] = Math.max(0, Math.floor((lo[j] - mg) / BRICK)); bb[i * 6 + 3 + j] = Math.min(nb[j] - 1, Math.floor((hi[j] + mg) / BRICK)); }
    const c = air ? cntA : cntR;
    for (let z = bb[i * 6 + 2]; z <= bb[i * 6 + 5]; z++) for (let y = bb[i * 6 + 1]; y <= bb[i * 6 + 4]; y++) for (let x = bb[i * 6]; x <= bb[i * 6 + 3]; x++) c[x + NBX * (y + NBY * z)]++;
  }
  let tot = 0;
  for (let b = 0; b < NBR; b++) { bhdr[b * 2] = tot; bhdr[b * 2 + 1] = cntA[b] | cntR[b] << 16; tot += cntA[b] + cntR[b]; }
  bidx = new Uint32Array(Math.max(tot, 4));
  const curA = new Uint16Array(NBR), curR = new Uint16Array(NBR);
  for (let i = 0; i < nPrim; i++) {
    const air = (prim[i * PRIM_F + 12] & 7) < 2;
    for (let z = bb[i * 6 + 2]; z <= bb[i * 6 + 5]; z++) for (let y = bb[i * 6 + 1]; y <= bb[i * 6 + 4]; y++) for (let x = bb[i * 6]; x <= bb[i * 6 + 3]; x++) {
      const b = x + NBX * (y + NBY * z);
      if (air) bidx[bhdr[b * 2] + curA[b]++] = i; else bidx[bhdr[b * 2] + cntA[b] + curR[b]++] = i;
    }
  }
}

// ===========================================================================
// scripted route (nominal space -> world space) and fixed poses
// ===========================================================================
const routeN = [];   // [x,y,z,speed,clearance]
function rPts(pts, v, cl, pb = 0) { for (const p of pts) routeN.push([p[0], p[1], p[2], v, cl, pb]); }
function rLeg(ctrl, v, cl, pb = 0) { rPts(crPath(ctrl, 3, 0).slice(1, -1), v, cl, pb); }
rPts(R.start, 4.2, 0.55);
rLeg([[68, 78, 70], [75, 77.2, 76], [83, 77.6, 80], [92, 77.8, 84.5], [99, 77.2, 87.5], [104, 76.5, 89]], 6, 1.0);
rPts(R.squeeze, 4.6, 0.4);
rLeg([[141, 64, 139], [150, 62.5, 143], [160, 59, 148], [170, 57, 156], [177, 57, 166], [184, 53, 171], [190, 45.5, 174.5]], 12, 1.6);
rPts(R.crawl, 6.2, 0.4);
rLeg([[217, 44.5, 200], [222, 43.4, 205], [229, 43.2, 212], [236, 43.8, 219], [241, 45, 219], [246, 46, 211], [251, 46, 204.5]], 8.5, 1.0);
rPts(R.fissure, 4.2, 0.35);
rLeg([[271, 51.5, 186.5], [276, 54, 182.5], [277.5, 58, 172], [277, 63, 158], [276.5, 68, 143], [274, 71, 132], [270, 71, 127.5]], 9, 1.6, -0.45);
rPts(R.toG, 6.2, 0.6);
rLeg([[250, 81, 103], [243, 83.2, 99], [236, 86, 93], [227, 86.5, 90], [219, 86.5, 87.5], [212, 86, 85]], 7, 1.2);
rPts(R.toH, 5, 0.5);
rLeg([[196.5, 98, 68.5], [192, 99.5, 65.5], [186, 100, 63], [179.5, 99.5, 62]], 4.6, 0.8);
rPts(R.toI, 8, 0.6);
rLeg([[129, 95, 60], [124, 96, 60.5], [120, 99, 61], [118.5, 104, 60], [120, 110, 59], [121, 117, 60]], 5.5, 1.6, 0.55);
routeN.push([121, 117, 60, 5, 1.6, 0.55]);
const NROUTE = routeN.length;
const routeW = new Float32Array(NROUTE * 4), routeV = new Float32Array(NROUTE), routeC = new Float32Array(NROUTE);
for (let i = 0; i < NROUTE; i++) { const w = unwarp(routeN[i]); routeW[i * 4] = w[0]; routeW[i * 4 + 1] = w[1]; routeW[i * 4 + 2] = w[2]; routeW[i * 4 + 3] = 1; routeV[i] = routeN[i][3]; routeC[i] = routeN[i][4]; }

// poses: eye / target in nominal space
const poseN = [
  [[113.2, 72.8, 113.0], [119, 71, 117]],            // 0 squeeze
  [[134.5, 64.9, 135.2], [172, 60, 160]],            // 1 squeeze mouth -> cathedral
  [[128.5, 58, 64], [112, 118, 55]],                   // 2 great shaft, looking up
  [[110.5, 73.2, 209.5], [78, 60, 226]],             // 3 the void
  [[73, 76.5, 75], [93, 78.5, 86]],                  // 4 stalactite chamber
  [[220, 43.6, 203], [246, 52, 228]],                // 5 lake + waterfall
  [[152, 60, 145], [182, 72, 164]],                  // 6 cathedral
  [[276, 55, 181], [276.5, 30, 150]],                // 7 chasm
  [[190.5, 99, 65], [183, 98.5, 59]],                 // 8 crystal chamber
  [[246, 83, 100.5], [232, 85, 94]],                 // 9 collapse
];
const NPOSE = poseN.length;
const poseW = new Float32Array(NPOSE * 8);
for (let i = 0; i < NPOSE; i++) { const a = unwarp(poseN[i][0]), b = unwarp(poseN[i][1]); poseW.set([a[0], a[1], a[2], 1, b[0], b[1], b[2], 1], i * 8); }
const startW = unwarp([38, 80, 48]), startT = unwarp([46, 79.5, 55]);
for (const f of falls) { f.top = unwarp(f.top); }
for (let i = 0; i < bursts.length; i++) bursts[i] = unwarp(bursts[i]);
for (const l of lights) if (l.type != 1) l.p = unwarp(l.p);

for (const c of crys) { c.c = unwarp(c.c); if (c.q[3] < 0) c.q = c.q.map(v => -v); }
