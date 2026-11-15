// ---------------------------------------------------------------------------
// WGSL: runtime shaders (scene ray-march, TAA, particles, bloom, final grade)
// ---------------------------------------------------------------------------
const ND = 30000, NM = 192, NR = 400, NF = 20000, NBU = 640;
const NACT = 24;                 // active lights per frame
const NCRY = 64;
const UB_F = 400 + NCRY * 8;                // uniform floats
function m3(q) { const x = qRot(q, [1, 0, 0]), y = qRot(q, [0, 1, 0]), z = qRot(q, [0, 0, 1]); return `mat3x3f(${[...x, ...y, ...z].map(v => v.toFixed(6)).join(',')})`; }

const W_UB = /*wgsl*/`
struct UB {
  cp: vec4f, cr: vec4f, cu: vec4f, cf: vec4f, res: vec4f,
  pp: vec4f, pr: vec4f, pu: vec4f, pf: vec4f,
  lp: vec4f, ld: vec4f, mi: vec4f,
  pools: array<vec4f, 4>, falls: array<vec4f, 4>, fal2: array<vec4f, 4>, burst: array<vec4f, 4>,
  lights: array<Light, ${NACT}>,
  crys: array<vec4f, ${NCRY * 2}>,
}
`;

const W_SCENE = W_COMMON + W_UB + /*wgsl*/`
@group(0) @binding(0) var<uniform> U: UB;
@group(0) @binding(1) var sdfT: texture_3d<f32>;
@group(0) @binding(2) var matT: texture_3d<f32>;
@group(0) @binding(3) var lvT: texture_3d<f32>;
@group(0) @binding(4) var avT: texture_3d<f32>;
@group(0) @binding(5) var nA: texture_3d<f32>;
@group(0) @binding(6) var nB: texture_3d<f32>;
@group(0) @binding(7) var sLin: sampler;
@group(0) @binding(8) var sRep: sampler;
const M1 = ${m3(qAxis([0.3, 1, 0.2], 0.7))};
const M2 = ${m3(qAxis([1, 0.2, -0.5], 1.9))};
const M3 = ${m3(qAxis([-0.4, 0.3, 1], 2.6))};
const M4 = ${m3(qAxis([0.7, -0.6, 0.4], 1.2))};
const LAMPC = vec3f(1.0, 0.86, 0.68);
const SKY = vec3f(9., 12., 16.);
fn sdfS(p: vec3f) -> f32 { return textureSampleLevel(sdfT, sLin, p * IWS, 0.).r; }
fn NA(q: vec3f) -> vec4f { let t = textureSampleLevel(nA, sRep, q, 0.); return vec4f(t.rgb * ${GS}., t.a); }
fn h2(c: vec2i) -> vec4f { let h = h3(vec3i(c, 7), 77u); return vec4f(f32(h & 255u), f32((h >> 8u) & 255u), f32((h >> 16u) & 255u), f32(h >> 24u)) * (1. / 255.); }
fn lampAt(p: vec3f) -> vec4f {
  let v = U.lp.xyz - p; let d2 = dot(v, v); let d = sqrt(d2); let l = v / max(d, 1e-4);
  let cone = smoothstep(0.3, 0.82, dot(-l, U.ld.xyz));
  let w = max(1. - d2 / (36. * 36.), 0.);
  return vec4f(l, U.lp.w * (0.06 + 0.94 * cone) * w * w / (d2 + 6.));
}
`;

const W_MAIN = W_SCENE + /*wgsl*/`
const S1 = ${1 / 7.3}; const S2 = ${1 / 1.9}; const A1 = 0.3; const A2 = 0.1;
fn ledge(x: f32) -> f32 { let f = fract(x); return smoothstep(0., 0.1, f) * (1. - smoothstep(0.35, 1., f)); }
// fine displacement: xyz = world gradient, w = height
fn dispH(p: vec3f, decor: f32, lg: ptr<function, f32>) -> vec4f {
  let a = NA(M1 * p * S1); let b = NA(M2 * p * S2);
  let ro = max(1. - 0.65 * decor, 0.1);
  let ga = (a.xyz * M1) * S1; let gb = (b.xyz * M2) * S2;
  var h = (a.w * A1 + b.w * A2) * ro;
  var g = (ga * A1 + gb * A2) * ro;
  let sy = p.y * 0.85 + p.x * 0.06 + p.z * 0.04 + a.w * 1.3;
  let gsy = vec3f(0.06, 0.85, 0.04) + 1.3 * ga;
  let A3 = 0.085 * ro * (1. - min(decor, 1.));
  let lv_ = A3 * ledge(sy); *lg = lv_;
  h += lv_; g += A3 * (ledge(sy + 0.01) - ledge(sy - 0.01)) * 50. * gsy;
  return vec4f(g, h);
}
fn pebH(p: vec3f) -> f32 {
  let w = textureSampleLevel(nB, sRep, M3 * p * ${1 / 1.5}, 0.).r;
  let w2 = textureSampleLevel(nB, sRep, M1 * p * ${1 / 0.42}, 0.).r;
  return (0.42 - w) * 0.075 + (0.42 - w2) * 0.022;
}
fn pudL(wet: f32, ny: f32) -> f32 { return -0.34 + 0.4 * smoothstep(0.45, 0.85, wet) * smoothstep(0.82, 0.95, ny); }
// small speleothems: cones in (xz, distance-from-surface) space -> stalactites, stalagmites, flowstone ribs
fn spk(p: vec3f, u: f32, ub: f32, decor: f32, ny: f32) -> f32 {
  if (u > 1.12) { return min(u, max(0.4, u - 1.06)); }
  let g = p.xz * ${1 / 0.85}; let ic = vec2i(floor(g - 0.5));
  let cw = smoothstep(0.25, 0.6, -ny); let fw = smoothstep(0.25, 0.6, ny);
  var d = u;
  for (var j = 0; j < 2; j++) { for (var i = 0; i < 2; i++) {
    let c = ic + vec2i(i, j); let r = h2(c);
    if (r.x > decor * 0.75) { continue; }
    let ctr = (vec2f(c) + 0.5 + (r.yz - 0.5) * 0.5) * 0.85;
    let dl = length(p.xz - ctr);
    let big = r.w * r.w;
    let wv = 0.62 + 0.38 * sin(p.y * (0.6 + r.y) + r.z * 40.);
    let Hw = 0. * wv; let Rw = 0.05;
    let H = Hw + cw * (0.2 + 0.85 * big - Hw) + fw * (0.14 + 0.55 * big - Hw);
    let R = Rw + cw * (0.05 + 0.09 * r.w - Rw) + fw * (0.09 + 0.15 * r.w - Rw);
    if (H < 0.03) { continue; }
    let e = vec2f(-R, H); let w = vec2f(dl - R, ub);
    let tt = clamp(dot(w, e) / dot(e, e), 0., 1.);
    let dd = length(w - e * tt);
    let s = select(1., -1., (e.x * w.y - e.y * w.x) > 0.);
    d = smin(d, dd * s - 0.022, 0.14);
  }}
  return min(d, 0.4);
}
fn surf(p: vec3f, d0: f32, m: vec4f) -> f32 {
  let ny = m.a * 2. - 1.;
  var lg = 0.;
  var h = dispH(p, m.r + m.b * 1.3, &lg).w;
  let fl = smoothstep(0.45, 0.8, ny);
  if (fl > 0.01) { h = max(h + fl * pebH(p), pudL(m.g, ny)); }
  var u = d0 - h;
  if (m.r > 0.03) { u = spk(p, u, u + lg, m.r, ny); }
  return u;
}
fn map(p: vec3f) -> f32 {
  let d0 = sdfS(p);
  if (U.mi.z < -0.5) { return d0; }
  if (d0 > 1.45) { return (d0 - 1.08) * 1.12; }
  if (d0 < -0.7) { return d0 + 0.45; }
  let m = textureSampleLevel(matT, sLin, p * IWS, 0.);
  if (d0 > 0.6) { if (m.r <= 0.03) { return d0 - 0.47; } let s = spk(p, d0 - 0.47, d0 - 0.47, m.r, m.a * 2. - 1.); if (s > 0.12) { return s; } }
  return surf(p, d0, m);
}
// cheap variant for shadow rays: base field + speleothems only
fn mapS(p: vec3f) -> f32 {
  let d0 = sdfS(p);
  if (d0 > 1.45) { return d0 - 1.08; }
  if (d0 < 0.) { return d0; }
  let m = textureSampleLevel(matT, sLin, p * IWS, 0.);
  if (m.r <= 0.03) { return d0; }
  return spk(p, d0, d0, m.r, m.a * 2. - 1.);
}
fn ign(p: vec2f) -> f32 { return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715)))); }

fn trace(ro: vec3f, rd: vec3f, t0: f32, tmax: f32, steps: ptr<function, f32>) -> vec2f {
  var t = t0;
  for (var i = 0; i < 150; i++) {
    let p = ro + rd * t;
    if (p.y > WS.y) { return vec2f(t, 0.); }
    let d = map(p);
    if (d < 0.0007 * t + 0.0012) { *steps = f32(i); return vec2f(t, 1.); }
    t += d * 0.72;
    if (t > tmax) { *steps = f32(i); return vec2f(t, 0.); }
  }
  *steps = 150.;
  return vec2f(t, 1.);
}
fn traceB(ro: vec3f, rd: vec3f, tmax: f32, n: i32) -> vec2f {
  var t = 0.06;
  for (var i = 0; i < n; i++) {
    let p = ro + rd * t;
    if (p.y > WS.y) { return vec2f(t, 0.); }
    let d = sdfS(p);
    if (d < 0.012 + 0.002 * t) { return vec2f(t, 1.); }
    t += d * 0.85;
    if (t > tmax) { return vec2f(t, 0.); }
  }
  return vec2f(t, 1.);
}
fn shadowB(ro: vec3f, rd: vec3f, tmax: f32, k: f32, dith: f32) -> f32 {
  var res = 1.; var t = 0.08 + 0.1 * dith;
  for (var i = 0; i < 40; i++) {
    let h = sdfS(ro + rd * t);
    res = min(res, k * h / min(t, 5.));
    if (res < 0.015 || t > tmax) { break; }
    t += clamp(h * 0.8, 0.07, 9.);
  }
  res = clamp(res, 0., 1.);
  return res * res * (3. - 2. * res);
}
// lamp shadow: includes fine detail so small formations cast moving shadows
fn shadowD(ro: vec3f, rd: vec3f, tmax: f32, k: f32, dith: f32) -> f32 {
  var res = 1.; var t = 0.03 + 0.04 * dith;
  for (var i = 0; i < 30; i++) {
    let h = mapS(ro + rd * t);
    res = min(res, k * h / t);
    if (res < 0.015 || t > tmax) { break; }
    t += clamp(h * 0.8, 0.025, 6.);
  }
  res = clamp(res, 0., 1.);
  return res * res * (3. - 2. * res);
}
fn spec(n: vec3f, v: vec3f, l: vec3f, rough: f32, f0: f32) -> f32 {
  let h = normalize(v + l); let nh = max(dot(n, h), 0.); let a = rough * rough; let a2 = a * a;
  let dd = nh * nh * (a2 - 1.) + 1.; let D = a2 / (3.14159 * dd * dd);
  let vh = max(dot(v, h), 0.); let F = f0 + (1. - f0) * pow(1. - vh, 5.);
  let nv = max(dot(n, v), 1e-3); let nl = max(dot(n, l), 1e-3); let k = a * 0.5 + 0.02;
  return min(D * F * 0.25 / ((nv * (1. - k) + k) * (nl * (1. - k) + k)), 12.);
}
fn palette(zA: f32, zB: f32) -> vec3f {
  var alb = mix(vec3f(0.050, 0.052, 0.058), vec3f(0.105, 0.118, 0.14), smoothstep(-0.35, 0.4, zA));
  alb = mix(alb, vec3f(0.16, 0.11, 0.072), smoothstep(0.0, 0.5, zB) * 0.85);
  alb = mix(alb, vec3f(0.23, 0.075, 0.05), smoothstep(0.3, 0.62, -zB - zA * 0.5) * 0.32);
  return alb;
}
fn scatter(ro: vec3f, rd: vec3f, t0: f32, t1: f32, dith: f32, n: i32) -> vec4f {
  let tm = min(t1, 170.) - t0;
  var acc = vec3f(0.);
  let fn_ = f32(n);
  for (var i = 0; i < n; i++) {
    let u = (f32(i) + dith) / fn_;
    let s = t0 + tm * u * u; let ds = 2. * u * tm / fn_;
    let p = ro + rd * s;
    let lv = textureSampleLevel(lvT, sLin, p * IWS, 0.);
    let dn = textureSampleLevel(nA, sRep, p * 0.043 + U.cp.w * vec3f(0.004, -0.0025, 0.003), 0.).a;
    let dn2 = textureSampleLevel(nA, sRep, p * 0.17 + U.cp.w * vec3f(-0.006, 0.004, 0.005), 0.).a;
    let dens = 0.0021 * max(1. + 1.3 * dn + 0.9 * dn2, 0.15) + lv.a * 0.006 * (1. + 0.8 * dn);
    let la = lampAt(p);
    acc += exp(-0.009 * (s - t0)) * dens * ds * (lv.rgb + LAMPC * la.w * 0.05);
  }
  return vec4f(acc, exp(-0.009 * (t1 - t0)));
}
fn shadeLite(p: vec3f) -> vec3f {
  let e = vec2f(1., -1.) * 0.25;
  let n = normalize(e.xyy * sdfS(p + e.xyy) + e.yyx * sdfS(p + e.yyx) + e.yxy * sdfS(p + e.yxy) + e.xxx * sdfS(p + e.xxx) + 1e-6);
  let alb = palette(NA(M4 * p * ${1 / 97}).w * 1.6, NA(M3 * p * ${1 / 23}).w * 1.4) * 0.6;
  let q = (p + n * 0.9) * IWS;
  let lv = textureSampleLevel(lvT, sLin, q, 0.).rgb; let av = textureSampleLevel(avT, sLin, q, 0.).rgb;
  let la = lampAt(p);
  return alb * (lv * 0.4 + av * 2. + vec3f(0.003, 0.0035, 0.0045) + LAMPC * la.w * max(dot(n, la.xyz), 0.));
}

fn shadeRock(p: vec3f, rd: vec3f, t: f32, dith: f32) -> vec3f {
  let uvw = p * IWS;
  let m = textureSampleLevel(matT, sLin, uvw, 0.);
  let decor = m.r; let ny = m.a * 2. - 1.;
  let e = vec2f(1., -1.) * 0.2;
  let d0 = sdfS(p);
  let g0 = normalize(e.xyy * sdfS(p + e.xyy) + e.yyx * sdfS(p + e.yyx) + e.yxy * sdfS(p + e.yxy) + e.xxx * sdfS(p + e.xxx) + 1e-6);
  var lg = 0.;
  let hv = dispH(p, decor + m.b * 1.3, &lg);
  var h = hv.w; var gh = hv.xyz;
  let fl = smoothstep(0.45, 0.8, ny);
  var water = 0.;
  if (fl > 0.01) {
    let e2 = 0.012; let p0 = pebH(p);
    let gp = vec3f(pebH(p + vec3f(e2, 0., 0.)) - p0, pebH(p + vec3f(0., e2, 0.)) - p0, pebH(p + vec3f(0., 0., e2)) - p0) / e2;
    h += fl * p0; gh += fl * gp;
    let pl = pudL(m.g, ny);
    if (h < pl) { water = smoothstep(0., 0.01, pl - h); gh *= (1. - water); h = pl; }
  }
  let gu = g0 - gh;
  var n = normalize(gu);
  var spike = 0.;
  if (decor > 0.03) {
    let u0 = d0 - h; let es = max(0.004, t * 0.0012); let k = vec2f(1., -1.);
    n = normalize(k.xyy * spk(p + k.xyy * es, u0 + dot(gu, k.xyy) * es, u0 + lg + dot(gu, k.xyy) * es, decor, ny) + k.yyx * spk(p + k.yyx * es, u0 + dot(gu, k.yyx) * es, u0 + lg + dot(gu, k.yyx) * es, decor, ny)
      + k.yxy * spk(p + k.yxy * es, u0 + dot(gu, k.yxy) * es, u0 + lg + dot(gu, k.yxy) * es, decor, ny) + k.xxx * spk(p + k.xxx * es, u0 + dot(gu, k.xxx) * es, u0 + lg + dot(gu, k.xxx) * es, decor, ny) + gu * 1e-4);
    spike = smoothstep(0.02, 0.12, u0);
  }
  let pf = t * length(U.cu.xyz) * 2. * U.res.w;
  let c3 = NA(M3 * p * ${1 / 0.47}); let c4 = NA(M4 * p * ${1 / 0.11});
  let gm = (c3.xyz * M3) * ${0.02 / 0.47} * (1. - smoothstep(0.012, 0.05, pf)) + (c4.xyz * M4) * ${0.0055 / 0.11} * (1. - smoothstep(0.003, 0.012, pf));
  n = normalize(n - (gm - n * dot(gm, n)) * (1. - 0.6 * decor) * (1. - water));

  // ---- material ----
  let a1 = NA(M1 * p * S1).w; let b1 = NA(M2 * p * S2).w;
  let zA = NA(M4 * p * ${1 / 97}).w * 1.6; let zB = NA(M3 * p * ${1 / 23}).w * 1.4;
  let wB = textureSampleLevel(nB, sRep, M2 * (p * vec3f(1., 2.3, 1.)) * ${1 / 5.3}, 0.);
  let sy = p.y * 0.85 + p.x * 0.06 + p.z * 0.04 + a1 * 1.3;
  let bh = mix(fract(sin(floor(sy) * 91.7 + 3.1) * 43758.5), fract(sin(floor(sy + 1.) * 91.7 + 3.1) * 43758.5), smoothstep(0.3, 0.7, fract(sy)));
  var alb = palette(zA, zB);
  alb = mix(alb, vec3f(0.22, 0.155, 0.075), smoothstep(0.55, 0.9, bh) * smoothstep(-0.25, 0.3, zA + zB) * 0.38);
  alb *= (0.88 + 0.24 * fract(bh * 7.3)) * (0.94 + 0.07 * sin(sy * 23. + b1 * 5.)) * (0.8 + 0.55 * (b1 + 0.3) + 0.3 * c3.w);
  alb *= (0.8 + 0.4 * wB.a) * (0.84 + 0.5 * c4.w * (1. - smoothstep(0.003, 0.012, pf)));
  // calcite / flowstone on formations
  let form = max(smoothstep(0.45, 0.9, decor), spike * 0.7);
  // angular fracture facets + crack lines
  let fq = textureSampleLevel(nB, sRep, M4 * (p * vec3f(1., 1.8, 1.)) * ${1 / 1.25}, 0.);
  let fw = (1. - 0.85 * form) * (1. - water); let fw2 = fw * (1. - smoothstep(0.01, 0.04, pf));
  let fa1 = sin(vec3f(wB.b * 6.283, wB.b * 12.566 + 1., wB.b * 18.85 + 2.)); let fa2 = sin(vec3f(fq.b * 6.283, fq.b * 12.566 + 1., fq.b * 18.85 + 2.));
  n = normalize(n + (fa1 * 0.03 + fa2 * 0.05) * fw2);
  let crack = clamp((1. - smoothstep(0.0, 0.025, fq.g)) * 0.35 * fw2 * smoothstep(0.45, 0.6, wB.a), 0., 1.);
  alb *= 1. - 0.65 * crack;
  let calc = vec3f(0.25, 0.195, 0.135) * (0.88 + 0.12 * sin(sy * 7. + b1 * 7.)) * (0.8 + 0.35 * zB) * (0.75 + 0.5 * wB.a);
  alb = mix(alb, mix(calc, alb * 1.25, 0.3), form * 0.85);
  // mineral veins
  let vz = smoothstep(0.45, 0.8, NA(M1 * p * ${1 / 41}).w * 1.6);
  let vein = (1. - smoothstep(0.004, 0.016, wB.g)) * vz * (1. - form);
  alb = mix(alb, vec3f(0.42, 0.43, 0.4), vein * 0.6);
  // wetness: seep streaks + damp zones
  let stre = NA(vec3f(p.x * 0.23, p.y * 0.021, p.z * 0.23)).w;
  var wet = clamp(m.g * 1.25 - 0.3 + stre * 1.1 + 0.25 * form, 0., 1.);
  wet = max(wet, water);
  for (var i = 0; i < i32(U.mi.w); i++) { let pl = U.pools[i]; if (length(p.xz - pl.xy) < pl.w) { wet = max(wet, 1. - smoothstep(0.1, 1.3, p.y - pl.z)); } }
  alb *= mix(1., 0.42, wet) * mix(0.55, 1., smoothstep(-0.2, 0.12, h));
  var rough = mix(0.9 - 0.25 * vein, 0.2 + 0.12 * c3.w, wet);
  var f0 = 0.04;
  // crystal crust
  let cry = smoothstep(0.3, 0.75, m.b + (wB.a - 0.5) * 0.5);
  var emis = vec3f(0.); var facet = 0.; var xt = 0.; var xe = 0.; var xin = 0.;
  if (cry > 0.01) {
    let cc = textureSampleLevel(nB, sRep, M1 * p * ${1 / 2.6}, 0.);
    let fa = sin(vec3f(cc.b * 6.283, cc.b * 12.566 + 1., cc.b * 18.85 + 2.));
    n = normalize(n + fa * 0.1 * cry);
    // large crystals: exact prism facet normals
    var bd = 1e9; var bn = vec3f(0.); var bi = 0.;
    for (var i = 0; i < i32(U.ld.w); i++) {
      let c = U.crys[i * 2]; let qv = U.crys[i * 2 + 1];
      let v = p - c.xyz; let hh = qv.w;
      if (dot(v, v) > (hh + 1.5) * (hh + 1.5)) { continue; }
      let qw = sqrt(max(1. - dot(qv.xyz, qv.xyz), 0.));
      let pl = v + 2. * cross(-qv.xyz, cross(-qv.xyz, v) + qw * v);
      let a = abs(pl); let rr = c.w * clamp((hh - pl.y) / (c.w * 3.), 0., 1.);
      let sa = a.x * 0.866 + a.z * 0.5; let side = max(sa, a.z) - rr;
      let d = max(side, a.y - hh);
      if (d < bd) {
        bd = d; bi = f32(i); xe = 1. - smoothstep(0.0, 0.05, min(abs(sa - a.z), abs(side - (a.y - hh))));
        var ln = vec3f(0., sign(pl.y), 0.);
        if (side > a.y - hh) {
          if (sa > a.z) { ln = vec3f(sign(pl.x) * 0.866, 0., sign(pl.z) * 0.5); } else { ln = vec3f(0., 0., sign(pl.z)); }
          if (hh - pl.y < c.w * 3.) { ln = normalize(ln + vec3f(0., 0.33, 0.)); }
        }
        bn = ln + 2. * cross(qv.xyz, cross(qv.xyz, ln) + qw * ln);
      }
    }
    xt = 1. - smoothstep(0.15, 0.5, bd);
    if (xt > 0.) {
      n = normalize(mix(n, bn + (n - g0) * 0.25, xt * 0.94));
      let tint = mix(vec3f(0.55, 0.9, 1.), vec3f(0.75, 0.6, 1.), fract(bi * 0.381));
      alb = mix(alb, tint * 0.06, xt); rough = mix(rough, 0.06 + 0.05 * xe, xt); f0 = mix(f0, 0.14, xt);
      let ip = p + refract(rd, n, 0.7) * 0.45;
      let inc = NA(M3 * ip * ${1 / 1.7}).w; let inc2 = NA(M2 * ip * ${1 / 0.31}).w;
      xin = (smoothstep(0.1, 0.6, inc) * 0.6 + smoothstep(0.35, 0.6, inc2) * 0.5 + pow(1. - max(dot(n, -rd), 0.), 3.) * 0.6 + xe * 0.9) * xt;
      xe *= xt;
    }
    alb = mix(alb, vec3f(0.17, 0.23, 0.26) * (0.92 + 0.16 * cc.b), cry * 0.9);
    rough = mix(rough, 0.13, cry); f0 = mix(f0, 0.09, cry); facet = smoothstep(0.5, 0.8, cc.b);
  }
  if (water > 0.) { n = normalize(mix(n, vec3f(0., 1., 0.) + 0.015 * vec3f(sin(p.x * 9. + U.cp.w * 1.3), 0., cos(p.z * 8. - U.cp.w)), water)); alb *= mix(1., 0.5, water); rough = mix(rough, 0.035, water); f0 = mix(f0, 0.02, water); }

  // ---- lighting ----
  let V = -rd;
  var ao = 0.; var sc = 1.;
  for (var i = 1; i < 5; i++) { let hh = 0.07 * f32(i * i) + 0.06 * f32(i); ao += (hh - sdfS(p + g0 * hh)) * sc; sc *= 0.62; }
  ao = clamp(1. - 0.9 * ao, 0., 1.);
  let cav = clamp(0.5 + 1.7 * (h + 0.14), 0.22, 1.) * mix(1., 0.72 + 0.56 * c3.w, 0.7);
  let aoF = ao * cav * (1. - 0.5 * crack);
  let glowMask = vein * 1.5 + xt * 0.03 + xin * 0.3 + cry * (0.1 + 0.02 * facet + 0.6 * pow(1. - max(dot(n, -rd), 0.), 2.)) + smoothstep(0.64, 0.8, wB.a) * smoothstep(-0.15, 0.3, b1) * (0.35 + c3.w) * 0.6;
  var col = vec3f(0.);
  let ps = p + n * 0.05;
  let nl_ = select(i32(U.mi.x), 0, U.mi.z > 1.5);
  for (var i = 0; i < nl_; i++) {
    let L = U.lights[i]; var tm = 0.;
    let la = lightAt(L, p, &tm);
    if (la.w <= 0.) { continue; }
    if (L.col.w > 1.5) { let re = min(L.pos.w * 0.42, 6.); let q = max(1. - tm / re, 0.); emis += L.col.rgb * glowMask * q * q * 0.03; }
    let nl = dot(n, la.xyz);
    if (nl <= 0.) { continue; }
    let k = select(7., 26., L.col.w > 0.5 && L.col.w < 1.5);
    let sh = shadowB(ps + g0 * 0.1, la.xyz, tm, k, dith);
    if (sh <= 0.) { continue; }
    col += L.col.rgb * (la.w * sh * nl) * (alb + spec(n, V, la.xyz, rough, f0));
  }
  {
    let la = lampAt(p); let nl = dot(n, la.xyz);
    if (la.w > 1e-4 && nl > 0.) {
      let sh = shadowD(ps + g0 * 0.06, la.xyz, length(U.lp.xyz - p), 18., dith);
      col += LAMPC * (la.w * sh * nl) * (alb + spec(n, V, la.xyz, rough, f0));
    }
  }
  let aq = (p + g0 * 1.3) * IWS;
  let amb = textureSampleLevel(avT, sLin, aq, 0.).rgb * 2.2 + textureSampleLevel(lvT, sLin, aq, 0.).rgb * 0.06 + vec3f(0.0036, 0.0042, 0.0054);
  col += alb * amb * aoF;
  col *= mix(1., aoF, 0.55);
  // smooth wet / water surfaces reflect their surroundings
  let fr = f0 + (1. - f0) * pow(1. - max(dot(n, V), 0.), 5.);
  if (water > 0.3) {
    let rdir = reflect(rd, n);
    let rt = traceB(p + n * 0.06, rdir, 40., 28);
    var rc = vec3f(0.);
    let q = p + rdir * rt.x;
    if (rt.y > 0.5) { rc = shadeLite(q); } else if (q.y >= WS.y) { rc = SKY; }
    col += rc * fr * water * exp(-0.011 * rt.x);
  } else {
    col += amb * fr * wet * ao * 0.6;
  }
  return col + emis;
}

fn waterN(p: vec3f) -> vec3f {
  let tm = U.cp.w;
  var g = 0.011 * vec2f(cos(p.x * 1.7 + tm * 0.9 + sin(p.z * 0.6)), cos(p.z * 2.1 - tm * 0.7 + sin(p.x * 0.8)));
  g += 0.006 * vec2f(cos(p.x * 5.3 - tm * 1.6 + p.z * 2.), cos(p.z * 4.7 + tm * 1.3 - p.x * 1.5));
  let gc = p.xz / 3.2; let ic = vec2i(floor(gc - 0.5));
  for (var j = 0; j < 2; j++) { for (var i = 0; i < 2; i++) {
    let c = ic + vec2i(i, j); let r = h2(c + vec2i(131, 57));
    let ctr = (vec2f(c) + 0.5 + (r.xy - 0.5) * 0.6) * 3.2;
    let per = 2.5 + 3. * r.z; let age = fract(tm / per + r.w) * per;
    let dv = p.xz - ctr; let dl = length(dv); let x = dl - age * 0.85;
    g += dv / max(dl, 1e-3) * cos(x * 15.) * exp(-x * x * 9.) * exp(-age * 0.9) * smoothstep(0., 0.25, age) * 0.1;
  }}
  // waterfall churn
  for (var i = 0; i < 4; i++) {
    let f = U.falls[i]; if (f.w <= 0.) { continue; }
    let land = f.xz + U.fal2[i].xy * 2.2 * sqrt(2. * f.w / 9.81);
    let dv = p.xz - land; let dl = length(dv);
    g += dv / max(dl, 1e-3) * cos(dl * 7. - tm * 6.) * 0.12 * exp(-dl * 0.3) + 0.05 * exp(-dl * 0.5) * vec2f(sin(p.x * 23. + tm * 9.), cos(p.z * 21. - tm * 8.));
  }
  return normalize(vec3f(-g.x, 1., -g.y));
}
fn shadeWater(p: vec3f, rd: vec3f, dith: f32) -> vec3f {
  let n = waterN(p); let V = -rd;
  let F = 0.02 + 0.98 * pow(1. - max(dot(V, n), 0.), 5.);
  var rdir = reflect(rd, n); rdir.y = abs(rdir.y) + 0.002; rdir = normalize(rdir);
  let rt = traceB(p + vec3f(0., 0.04, 0.), rdir, 80., 48);
  var refl = vec3f(0.);
  let q = p + rdir * rt.x;
  if (rt.y > 0.5) { refl = shadeLite(q); } else if (q.y >= WS.y) { refl = SKY; }
  let rs = scatter(p, rdir, 0., min(rt.x, 80.), dith, 6);
  refl = refl * rs.w + rs.xyz;
  let fdir = refract(rd, n, 0.75);
  let ft = traceB(p - vec3f(0., 0.03, 0.), fdir, 18., 22);
  var under = vec3f(0.);
  if (ft.y > 0.5) { under = shadeLite(p + fdir * ft.x); }
  let ab = exp(-ft.x * vec3f(0.45, 0.12, 0.1));
  let lv = textureSampleLevel(lvT, sLin, (p + vec3f(0., 0.6, 0.)) * IWS, 0.).rgb;
  under = under * ab + (lv * 0.4 + vec3f(0.002)) * vec3f(0.01, 0.05, 0.055) * (1. - ab.g);
  var col = mix(under, refl, F);
  let ps = p + vec3f(0., 0.05, 0.);
  for (var i = 0; i < i32(U.mi.x); i++) {
    let L = U.lights[i]; var tm = 0.;
    let la = lightAt(L, p, &tm);
    if (la.w <= 0. || la.y <= 0.) { continue; }
    let sp = spec(n, V, la.xyz, 0.06, 0.02);
    if (sp < 0.003) { continue; }
    col += L.col.rgb * la.w * la.y * sp * shadowB(ps, la.xyz, tm, 16., dith);
  }
  let la = lampAt(p);
  col += LAMPC * la.w * max(la.y, 0.) * spec(n, V, la.xyz, 0.06, 0.02);
  return col;
}

struct FO { @location(0) c: vec4f, @location(1) d: vec4f }
@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f { return vec4f(f32((vi << 1u) & 2u) * 2. - 1., f32(vi & 2u) * 2. - 1., 0., 1.); }
@fragment fn fs(@builtin(position) fc: vec4f) -> FO {
  var o: FO;
  let ndc = (fc.xy + vec2f(U.cr.w, U.cu.w)) * U.res.zw * 2. - 1.;
  let rd = normalize(U.cf.xyz + ndc.x * U.cr.xyz - ndc.y * U.cu.xyz);
  let ro = U.cp.xyz;
  let dith = fract(ign(fc.xy) + U.cf.w * 0.61803399);
  var t0 = 0.; var dark = 1.;
  let dc = map(ro);
  if (dc < 0.) {
    var d = dc;
    for (var i = 0; i < 28; i++) { t0 += max(-d, 0.12); d = map(ro + rd * t0); if (d > 0.01) { break; } }
    if (d <= 0.01) { o.c = vec4f(0., 0., 0., 1.); o.d = vec4f(t0); return o; }
    dark = exp(-t0 * 1.4);
  }
  var tw = -1.; var uw = 0.;
  for (var i = 0; i < i32(U.mi.w); i++) {
    let pl = U.pools[i];
    if (ro.y > pl.z) {
      if (rd.y < 0.) { let tt = (pl.z - ro.y) / rd.y; if (tt > t0 && length(ro.xz + rd.xz * tt - pl.xy) < pl.w && (tw < 0. || tt < tw)) { tw = tt; } }
    } else if (length(ro.xz - pl.xy) < pl.w && ro.y > pl.z - 30.) { uw = 1.; }
  }
  var steps = 0.;
  let tr = trace(ro, rd, t0, select(260., tw, tw > 0.), &steps);
  var col = vec3f(0.); var t = tr.x;
  if (U.mi.z > 3.5) { col = vec3f(fract(t)); } else if (tr.y > 0.5) { col = shadeRock(ro + rd * t, rd, t, dith); }
  else if (tw > 0. && t >= tw) { t = tw; col = shadeWater(ro + rd * tw, rd, dith); }
  else if ((ro + rd * t).y >= WS.y) { col = SKY; t = min(t, 400.); }
  else { t = 260.; }
  var sc = vec4f(0., 0., 0., 1.); if (U.mi.z < 2.5) { sc = scatter(ro, rd, t0, t, dith, 16); }
  col = col * sc.w + sc.xyz;
  if (uw > 0.5) { col = col * exp(-t * vec3f(0.5, 0.14, 0.12)) * 0.7; }
  col *= dark;
  if (U.mi.z > 0.5 && U.mi.z < 1.5) { col = vec3f(steps / 150., steps / 60., steps / 25.) * 0.5; }
  o.c = vec4f(max(col, vec3f(0.)), 1.); o.d = vec4f(t);
  return o;
}
`;

const W_TAA = W_COMMON + W_UB + /*wgsl*/`
@group(0) @binding(0) var<uniform> U: UB;
@group(0) @binding(1) var curT: texture_2d<f32>;
@group(0) @binding(2) var depT: texture_2d<f32>;
@group(0) @binding(3) var hisT: texture_2d<f32>;
@group(0) @binding(4) var sLin: sampler;
fn tm(c: vec3f) -> vec3f { return c / (1. + max(c.r, max(c.g, c.b))); }
fn itm(c: vec3f) -> vec3f { return c / max(1. - max(c.r, max(c.g, c.b)), 1e-3); }
fn HS(uv: vec2f) -> vec3f { return textureSampleLevel(hisT, sLin, uv, 0.).rgb; }
fn hist(uv: vec2f) -> vec3f {
  let sp = uv * U.res.xy; let tc = floor(sp - 0.5) + 0.5; let f = sp - tc;
  let w0 = f * (-0.5 + f * (1. - 0.5 * f)); let w1 = 1. + f * f * (-2.5 + 1.5 * f); let w2 = f * (0.5 + f * (2. - 1.5 * f)); let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2; let t0 = (tc - 1.) * U.res.zw; let t3 = (tc + 2.) * U.res.zw; let t12 = (tc + w2 / w12) * U.res.zw;
  let r = HS(vec2f(t12.x, t0.y)) * (w12.x * w0.y) + HS(vec2f(t0.x, t12.y)) * (w0.x * w12.y) + HS(t12) * (w12.x * w12.y) + HS(vec2f(t3.x, t12.y)) * (w3.x * w12.y) + HS(vec2f(t12.x, t3.y)) * (w12.x * w3.y);
  let ws = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return max(r / ws, vec3f(0.));
}
struct TO { @location(0) h: vec4f, @location(1) s: vec4f }
@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f { return vec4f(f32((vi << 1u) & 2u) * 2. - 1., f32(vi & 2u) * 2. - 1., 0., 1.); }
@fragment fn fs(@builtin(position) fc: vec4f) -> TO {
  let ip = vec2i(fc.xy); let mxp = vec2i(U.res.xy) - 1;
  let c = tm(textureLoad(curT, ip, 0).rgb);
  var mn = c; var mx = c; var m1 = c; var m2 = c * c;
  var dm = textureLoad(depT, ip, 0).r;
  for (var j = -1; j <= 1; j++) { for (var i = -1; i <= 1; i++) {
    if (i == 0 && j == 0) { continue; }
    let q = clamp(ip + vec2i(i, j), vec2i(0), mxp);
    let s = tm(textureLoad(curT, q, 0).rgb);
    mn = min(mn, s); mx = max(mx, s); m1 += s; m2 += s * s;
    dm = min(dm, textureLoad(depT, q, 0).r);
  }}
  let mu = m1 / 9.; let sg = sqrt(max(m2 / 9. - mu * mu, vec3f(0.)));
  mn = max(mn, mu - 1.6 * sg); mx = min(mx, mu + 1.6 * sg);
  let ndc = fc.xy * U.res.zw * 2. - 1.;
  let rd = normalize(U.cf.xyz + ndc.x * U.cr.xyz - ndc.y * U.cu.xyz);
  let v = U.cp.xyz + rd * min(dm, 5000.) - U.pp.xyz;
  let z = dot(v, U.pf.xyz);
  let uv = vec2f(dot(v, U.pr.xyz), -dot(v, U.pu.xyz)) / z * 0.5 + 0.5;
  var a = 0.09;
  if (z <= 0. || uv.x < 0. || uv.y < 0. || uv.x > 1. || uv.y > 1. || U.mi.y > 0.5) { a = 1.; }
  let h = clamp(tm(hist(uv)), mn, mx);
  let r = itm(mix(h, c, a));
  var o: TO; o.h = vec4f(r, 1.); o.s = vec4f(r, 1.); return o;
}
`;

const W_PART = W_SCENE + /*wgsl*/`
@group(1) @binding(0) var depT: texture_2d<f32>;
struct PO { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) col: vec3f, @location(2) dist: f32, @location(3) soft: f32 }
fn r3(i: u32, s: u32) -> vec3f { return h3v(vec3i(i32(i), i32(s), 3), 5u) * 0.5 + 0.5; }
fn proj(q: vec3f) -> vec3f { let v = q - U.cp.xyz; let z = dot(v, U.cf.xyz); return vec3f(dot(v, U.cr.xyz) / dot(U.cr.xyz, U.cr.xyz), dot(v, U.cu.xyz) / dot(U.cu.xyz, U.cu.xyz), z); }
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> PO {
  var o: PO; o.pos = vec4f(3., 3., 0., 1.); o.uv = vec2f(0.); o.col = vec3f(0.); o.dist = 0.; o.soft = 0.;
  let cx = f32(vi & 1u) * 2. - 1.; let cy = f32((vi >> 1u) & 1u) * 2. - 1.;
  let tm = U.cp.w; let c = U.cp.xyz;
  var q = vec3f(0.); var ax = vec3f(0., 1., 0.); var hl = 0.; var size = 0.005; var br = 1.; var alpha = 1.; var soft = 0.; var check = 0.06;
  if (ii < ${ND}u) {
    let a = r3(ii, 1u); let b = r3(ii, 2u);
    q = a * 26. + vec3f(sin(tm * 0.13 + b.x * 50.) * 0.5 + tm * 0.03 * (b.z - 0.5), -tm * 0.018 * (0.4 + b.y) + sin(tm * 0.21 + b.y * 50.) * 0.2, cos(tm * 0.11 + b.z * 50.) * 0.5 + tm * 0.03 * (b.x - 0.5));
    q = c + (fract((q - c) / 26. + 0.5) - 0.5) * 26.;
    size = 0.0012 + 0.0032 * b.x * b.x;
    br = (0.55 + 0.45 * sin(tm * (1.5 + 4. * b.y) + b.z * 60.)) * 1.5;
    alpha = 1. - smoothstep(10., 13., length(q - c));
    if (b.z > 0.8) { size *= 0.5; br *= 2.; }
  } else if (ii < ${ND + NM}u) {
    let i = ii - ${ND}u; let k = i / ${NM / 4}u; let f = U.falls[k];
    if (f.w <= 0.) { return o; }
    let a = r3(i, 3u); let b = r3(i, 4u);
    let land = f.xyz + vec3f(U.fal2[k].x, 0., U.fal2[k].y) * 2.2 * sqrt(2. * f.w / 9.81) - vec3f(0., f.w, 0.);
    let life = fract(tm * 0.06 * (0.6 + b.x) + a.x); let ang = a.y * 6.283 + life * 1.5; let rad = (0.4 + life * 6.) * (0.3 + a.z);
    q = land + vec3f(cos(ang) * rad, 0.3 + life * 7. * b.y, sin(ang) * rad);
    size = 0.7 + 2. * life; alpha = sin(3.1416 * life) * 0.03; soft = 1.; check = -0.5;
  } else if (ii < ${ND + NM + NR}u) {
    let i = ii - ${ND + NM}u;
    let cell = vec2i(i32(i % 20u), i32(i / 20u)) - 10 + vec2i(floor(c.xz / 2.5));
    let r = h2(cell + vec2i(17, 91)); let r2 = h2(cell + vec2i(53, 11));
    let x = (f32(cell.x) + r.x) * 2.5; let z = (f32(cell.y) + r.y) * 2.5;
    var yu = c.y + (r.z - 0.5) * 2.;
    if (sdfS(vec3f(x, yu, z)) < 0.3) { return o; }
    var yd = yu; var du = 0.; var dd = 0.;
    for (var s = 0; s < 12; s++) { du = sdfS(vec3f(x, yu, z)); yu += max(du * 0.9, 0.03); dd = sdfS(vec3f(x, yd, z)); yd -= max(dd * 0.9, 0.03); }
    if (du > 0.5) { return o; }
    let m = textureSampleLevel(matT, sLin, vec3f(x, yu, z) * IWS, 0.);
    if (m.g + m.r * 0.5 < 0.4 + 0.4 * r2.x) { return o; }
    let T = 1.6 + 3.5 * r.w; let ta = fract(tm / T + r2.y * 7.) * T;
    let y = yu - 0.1 - 4.905 * ta * ta;
    if (y < yd) { return o; }
    q = vec3f(x, y, z); hl = clamp(9.81 * ta * 0.011, 0.012, 0.16); size = 0.0055; br = 2.6; check = -1.;
  } else if (ii < ${ND + NM + NR + NF}u) {
    let i = ii - ${ND + NM + NR}u; let k = i / ${NF / 4}u; let f = U.falls[k];
    if (f.w <= 0.) { return o; }
    let a = r3(i, 5u); let b = r3(i, 6u);
    let Tf = sqrt(2. * f.w / 9.81); let cyc = Tf * (1.02 + 0.2 * a.y); let ta = fract(tm / cyc + a.x * 31.) * cyc;
    if (ta > Tf) { return o; }
    let D = vec3f(U.fal2[k].x, 0., U.fal2[k].y); let P = vec3f(-D.z, 0., D.x);
    let hv = 1.5 + 1.4 * b.x;
    q = f.xyz + D * hv * ta + P * (b.y - 0.5) * U.fal2[k].z * (1. + ta * 0.4) + vec3f(0., -4.905 * ta * ta + (a.z - 0.5) * 0.3, 0.) + (P * sin(ta * 6. + b.z * 40.) + D * cos(ta * 5. + a.z * 40.)) * 0.06 * ta;
    let vel = D * hv - vec3f(0., 9.81 * ta, 0.); let sp = length(vel);
    ax = vel / sp; hl = 0.04 + 0.028 * sp; size = 0.018 + 0.03 * b.z; br = 1.1; alpha = 0.55; check = -1.;
  } else {
    let i = ii - ${ND + NM + NR + NF}u; let k = i / ${NBU / 4}u; let e = U.burst[k];
    if (e.w <= 0.) { return o; }
    let a = r3(i, 7u); let b = r3(i, 8u);
    let per = 8. + 5. * fract(f32(k) * 0.37 + 0.2); let ph = fract(tm / per + f32(k) * 0.41) * per; let ta = ph - a.x * 1.1;
    if (ta < 0. || ta > 5.) { return o; }
    let vt = 2.5 + 5. * b.x;
    q = e.xyz + vec3f(a.y - 0.5, 0., a.z - 0.5) * 1.8 + vec3f(b.y - 0.5, 0., b.z - 0.5) * 0.5 * ta - vec3f(0., vt * ta - vt * 0.5 * (1. - exp(-2. * ta)), 0.);
    size = 0.004 + 0.012 * b.y * b.y; br = 1.6; hl = 0.01 + vt * 0.004; alpha = 1. - smoothstep(3.5, 5., ta);
  }
  if (check > -0.9 && sdfS(q) < check) { return o; }
  let pc = proj(q);
  if (pc.z < 0.2) { return o; }
  let ty = length(U.cu.xyz);
  let pa = proj(q - ax * hl); let pb = proj(q + ax * hl);
  var dp = (pb.xy / max(pb.z, 0.05) - pa.xy / max(pa.z, 0.05)) * U.res.xy * 0.5;
  let dl = length(dp);
  if (dl < 1e-3) { dp = vec2f(0., 1.); } else { dp /= dl; }
  let pp = vec2f(-dp.y, dp.x);
  let tpx = size / (pc.z * ty) * U.res.y * 0.5;
  let wpx = max(tpx, 1.25);
  alpha *= min(1., tpx / 1.25) * select(min(1., tpx / 1.25), 1., hl > 0.);
  alpha *= smoothstep(0.2, 0.9, pc.z);
  let ctr = mix(pa.xy / max(pa.z, 0.05), pb.xy / max(pb.z, 0.05), cy * 0.5 + 0.5);
  let ndc = ctr + (pp * cx * wpx + dp * cy * wpx) * 2. * U.res.zw;
  let lv = textureSampleLevel(lvT, sLin, q * IWS, 0.).rgb;
  let la = lampAt(q);
  o.col = min((lv + LAMPC * la.w * 0.7) * (br * alpha * 0.1), vec3f(1.2));
  o.pos = vec4f(ndc * pc.z, pc.z * 0.5, pc.z);
  o.dist = length(q - c); o.soft = soft;
  o.uv = vec2f(cx, cy);
  return o;
}
@fragment fn fs(i: PO) -> @location(0) vec4f {
  let ts = textureLoad(depT, vec2i(i.pos.xy), 0).r;
  if (i.dist > ts) { discard; }
  let r2 = dot(i.uv, i.uv);
  let a = exp(-r2 * 3.2) * (1. - smoothstep(0.6, 1., r2)) * mix(1., clamp((ts - i.dist) / 0.8, 0., 1.), i.soft);
  return vec4f(i.col * a, 0.);
}
`;

const W_POST = /*wgsl*/`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var sLin: sampler;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f { return vec4f(f32((vi << 1u) & 2u) * 2. - 1., f32(vi & 2u) * 2. - 1., 0., 1.); }
fn T(uv: vec2f) -> vec3f { return textureSampleLevel(src, sLin, uv, 0.).rgb; }
@fragment fn fsDown(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let ts = 1. / vec2f(textureDimensions(src)); let uv = fc.xy * 2. * ts;
  let a = T(uv + ts * vec2f(-2., -2.)); let b = T(uv + ts * vec2f(0., -2.)); let c = T(uv + ts * vec2f(2., -2.));
  let d = T(uv + ts * vec2f(-2., 0.)); let e = T(uv); let f = T(uv + ts * vec2f(2., 0.));
  let g = T(uv + ts * vec2f(-2., 2.)); let h = T(uv + ts * vec2f(0., 2.)); let i = T(uv + ts * vec2f(2., 2.));
  let j = T(uv + ts * vec2f(-1., -1.)); let k = T(uv + ts * vec2f(1., -1.)); let l = T(uv + ts * vec2f(-1., 1.)); let m = T(uv + ts * vec2f(1., 1.));
  let r = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  return vec4f(min(r, vec3f(40.)), 1.);
}
@fragment fn fsUp(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let ts = 1. / vec2f(textureDimensions(src)); let uv = fc.xy * 0.5 * ts;
  let r = T(uv) * 4. + (T(uv + ts * vec2f(-1., 0.)) + T(uv + ts * vec2f(1., 0.)) + T(uv + ts * vec2f(0., -1.)) + T(uv + ts * vec2f(0., 1.))) * 2.
    + T(uv + ts * vec2f(-1., -1.)) + T(uv + ts * vec2f(1., -1.)) + T(uv + ts * vec2f(-1., 1.)) + T(uv + ts * vec2f(1., 1.));
  return vec4f(r / 16., 1.);
}
`;

const W_FINAL = /*wgsl*/`
struct FU { res: vec4f, p: vec4f }
@group(0) @binding(0) var<uniform> F: FU;
@group(0) @binding(1) var scT: texture_2d<f32>;
@group(0) @binding(2) var blT: texture_2d<f32>;
@group(0) @binding(3) var sLin: sampler;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f { return vec4f(f32((vi << 1u) & 2u) * 2. - 1., f32(vi & 2u) * 2. - 1., 0., 1.); }
fn L(ip: vec2i) -> vec3f { return textureLoad(scT, clamp(ip, vec2i(0), vec2i(F.res.xy) - 1), 0).rgb; }
fn tmc(c: vec3f) -> vec3f { return c / (1. + dot(c, vec3f(0.3, 0.55, 0.15))); }
fn aces(x: vec3f) -> vec3f { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.), vec3f(1.)); }
fn hsh(p: vec2f) -> f32 { var q = fract(vec3f(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let ip = vec2i(fc.xy); let uv = fc.xy * F.res.zw;
  let c0 = L(ip);
  let nb = (tmc(L(ip + vec2i(1, 0))) + tmc(L(ip - vec2i(1, 0))) + tmc(L(ip + vec2i(0, 1))) + tmc(L(ip - vec2i(0, 1)))) * 0.25;
  let tc = tmc(c0); let sh = max(tc + (tc - nb) * F.p.z, vec3f(0.));
  var c = sh / max(1. - dot(sh, vec3f(0.3, 0.55, 0.15)), 1e-3);
  let bl = textureSampleLevel(blT, sLin, uv, 0.).rgb;
  c = c + bl * F.p.w;
  c *= F.p.x;
  let q = uv - 0.5; c *= 1. - 0.42 * smoothstep(0.25, 0.95, length(q * vec2f(1.15, 1.)) * 1.25);
  c = aces(c * 0.9);
  let lum = dot(c, vec3f(0.3, 0.55, 0.15));
  c = mix(c, c * vec3f(0.9, 1.0, 1.1), (1. - smoothstep(0., 0.35, lum)) * 0.5);
  c = pow(c, vec3f(1. / 2.2));
  let g = hsh(fc.xy + F.p.y * 17.13) + hsh(fc.xy * 1.37 + F.p.y * 7.7) - 1.;
  c += g * (1.4 / 255.) + g * 0.012 * (1. - lum) * lum;
  return vec4f(c, 1.);
}
`;
