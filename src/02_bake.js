// ---------------------------------------------------------------------------
// WGSL: shared helpers + load-time bake shaders (SDF volume, material volume,
// light volume, ambient volume, tiling noise textures, point queries)
// ---------------------------------------------------------------------------
const LNX = 320, LNY = 160, LNZ = 320;      // light volume
const ANX = 96, ANY = 48, ANZ = 96;         // ambient volume
const MNX = NX / 2, MNY = NY / 2, MNZ = NZ / 2;   // material volume
const NN = 128;                             // noise texture size
const MAXL = 64;

const W_COMMON = /*wgsl*/`
const WS = vec3f(${WX}, ${WY}, ${WZ});
const IWS = vec3f(${1 / WX}, ${1 / WY}, ${1 / WZ});
fn h3(c: vec3i, s: u32) -> u32 {
  var h = (u32(c.x) * 0x8da6b343u) ^ (u32(c.y) * 0xd8163841u) ^ (u32(c.z) * 0xcb1ab31fu) ^ (s * 0x9e3779b9u);
  h ^= h >> 15u; h *= 0x2c1b3c6du; h ^= h >> 12u; h *= 0x297a2d39u; h ^= h >> 15u;
  return h;
}
fn h3v(c: vec3i, s: u32) -> vec3f {
  let h = h3(c, s);
  return vec3f(f32(h & 1023u), f32((h >> 10u) & 1023u), f32((h >> 20u) & 1023u)) * (1. / 511.5) - 1.;
}
fn smin(a: f32, b: f32, k: f32) -> f32 { let h = max(k - abs(a - b), 0.) / k; return min(a, b) - h * h * k * 0.25; }
fn smax(a: f32, b: f32, k: f32) -> f32 { let h = max(k - abs(a - b), 0.) / k; return max(a, b) + h * h * k * 0.25; }
struct Light { pos: vec4f, col: vec4f, dir: vec4f }
// xyz = unit direction to light, w = attenuation (0 when out of reach); tmax = occlusion ray length
fn lightAt(L: Light, p: vec3f, tmax: ptr<function, f32>) -> vec4f {
  if (L.col.w > 0.5 && L.col.w < 1.5) {
    let v = p - L.pos.xyz; let al = dot(v, L.dir.xyz);
    if (al < 0. || al > L.pos.w) { return vec4f(0.); }
    let rad = length(v - L.dir.xyz * al); let R = L.dir.w;
    if (rad > R) { return vec4f(0.); }
    *tmax = al;
    return vec4f(-L.dir.xyz, (1. - smoothstep(0.6 * R, R, rad)) * exp(-al * 0.005));
  }
  let v = L.pos.xyz - p; let d2 = dot(v, v); let r = L.pos.w;
  if (d2 > r * r) { return vec4f(0.); }
  let d = sqrt(d2); *tmax = d;
  let w = 1. - d2 / (r * r);
  return vec4f(v / max(d, 1e-4), w * w / (d2 + L.dir.w * L.dir.w));
}
`;

const W_FSTRI = /*wgsl*/`
struct VO { @builtin(position) pos: vec4f, @location(0) @interpolate(flat) sl: u32 }
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  var o: VO; o.pos = vec4f(f32((vi << 1u) & 2u) * 2. - 1., f32(vi & 2u) * 2. - 1., 0., 1.); o.sl = ii; return o;
}
`;

const W_FIELD = /*wgsl*/`
struct Prim { a: vec4f, b: vec4f, s: vec4f, t: vec4f, q: vec4f, m: vec4f }
@group(0) @binding(0) var<storage, read> prims: array<Prim>;
@group(0) @binding(1) var<storage, read> bhdr: array<u32>;
@group(0) @binding(2) var<storage, read> bidx: array<u32>;
fn vn3(p: vec3f, s: u32) -> vec3f {
  let i = floor(p); let f = p - i; let u = f * f * (3. - 2. * f); let c = vec3i(i);
  return mix(mix(mix(h3v(c, s), h3v(c + vec3i(1, 0, 0), s), u.x), mix(h3v(c + vec3i(0, 1, 0), s), h3v(c + vec3i(1, 1, 0), s), u.x), u.y),
             mix(mix(h3v(c + vec3i(0, 0, 1), s), h3v(c + vec3i(1, 0, 1), s), u.x), mix(h3v(c + vec3i(0, 1, 1), s), h3v(c + vec3i(1, 1, 1), s), u.x), u.y), u.z);
}
fn warp(p: vec3f) -> vec3f {
  let a = vn3(vec3f(p.x, 0., p.z) / 31., 1u); let b = vn3(vec3f(p.x, 0., p.z) / 9.7, 2u);
  let c = vn3(p / 27., 3u); let d = vn3(p / 8.3, 4u);
  return vec3f(a.x * 2.6 + b.x * 0.8, c.y * 2.4 + d.y * 0.7, a.z * 2.6 + b.z * 0.8);
}
fn gn(p: vec3f, s: u32) -> f32 {
  let i = floor(p); let f = p - i; let u = f * f * f * (f * (f * 6. - 15.) + 10.); let c = vec3i(i);
  let a = dot(h3v(c, s), f); let b = dot(h3v(c + vec3i(1, 0, 0), s), f - vec3f(1., 0., 0.));
  let cc = dot(h3v(c + vec3i(0, 1, 0), s), f - vec3f(0., 1., 0.)); let d = dot(h3v(c + vec3i(1, 1, 0), s), f - vec3f(1., 1., 0.));
  let e = dot(h3v(c + vec3i(0, 0, 1), s), f - vec3f(0., 0., 1.)); let g = dot(h3v(c + vec3i(1, 0, 1), s), f - vec3f(1., 0., 1.));
  let h = dot(h3v(c + vec3i(0, 1, 1), s), f - vec3f(0., 1., 1.)); let k = dot(h3v(c + vec3i(1, 1, 1), s), f - vec3f(1., 1., 1.));
  return mix(mix(mix(a, b, u.x), mix(cc, d, u.x), u.y), mix(mix(e, g, u.x), mix(h, k, u.x), u.y), u.z);
}
fn qrot(q: vec4f, v: vec3f) -> vec3f { return v + 2. * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
fn sdRC(p: vec3f, b: vec3f, r1: f32, r2: f32) -> f32 {
  let l2 = dot(b, b); let rr = r1 - r2; let a2 = l2 - rr * rr; let il2 = 1. / l2;
  let y = dot(p, b); let z = y - l2; let xv = p * l2 - b * y; let x2 = dot(xv, xv); let y2 = y * y * l2; let z2 = z * z * l2;
  let k = sign(rr) * rr * rr * x2;
  if (sign(z) * a2 * z2 > k) { return sqrt(x2 + z2) * il2 - r2; }
  if (sign(y) * a2 * y2 < k) { return sqrt(x2 + y2) * il2 - r1; }
  return (sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}
fn sdEll(p: vec3f, r: vec3f) -> f32 {
  let k0 = length(p / r);
  if (k0 < 1.) { return (k0 - 1.) * min(r.x, min(r.y, r.z)); }
  let k1 = length(p / (r * r));
  return k0 * (k0 - 1.) / k1;
}
fn sdPrim(pr: Prim, p: vec3f) -> f32 {
  let ty = u32(pr.t.x) & 7u;
  var d = 0.;
  if (ty == 0u || ty == 2u) {
    let s = pr.s.xyz;
    d = sdRC((p - pr.a.xyz) / s, (pr.b.xyz - pr.a.xyz) / s, pr.a.w, pr.b.w) * min(s.x, min(s.y, s.z));
  } else {
    let pl = qrot(vec4f(-pr.q.xyz, pr.q.w), p - pr.a.xyz);
    if (ty == 4u) {
      let q = abs(pl) - pr.s.xyz + pr.a.w;
      d = length(max(q, vec3f(0.))) + min(max(q.x, max(q.y, q.z)), 0.) - pr.a.w;
    } else if (ty == 5u) {
      let q = abs(pl); let h = pr.s.y; let r = pr.s.x;
      let rr = r * clamp((h - pl.y) / (r * 3.), 0., 1.);
      d = max(max(q.x * 0.866 + q.z * 0.5, q.z) - rr, q.y - h) * 0.8;
    } else {
      d = sdEll(pl, pr.s.xyz);
    }
  }
  if (ty < 2u) { d = smax(d, pr.t.y - p.y, 2.5); d = smax(d, p.y - pr.t.w, 2.5); }
  return d;
}
fn caveNoise(p: vec3f, R: f32) -> f32 {
  var n = 0.; var lam = 24.;
  for (var o = 0u; o < 5u; o++) {
    let amp = 0.09 * lam * clamp(R / lam * 1.7 - 0.2, 0., 1.);
    if (amp > 0.001) {
      var v = gn(p * vec3f(1., 1.45, 1.) / lam + vec3f(f32(o) * 17.3), 20u + o) * 1.25;
      if (o == 2u) { v = 2.2 * abs(v) - 0.7; } else if (o == 3u) { v = 0.6 - 2.2 * abs(v); }
      n += amp * v;
    }
    lam *= 0.5;
  }
  return n;
}
struct FR { f: f32, m: vec3f }
fn field(p: vec3f) -> FR {
  var o: FR; o.f = -${MROCK}.; o.m = vec3f(0.);
  let bc = vec3u(clamp(p / ${BRICK}, vec3f(0.), vec3f(${NBX - 1}., ${NBY - 1}., ${NBZ - 1}.)));
  let bi = (bc.x + ${NBX}u * (bc.y + ${NBY}u * bc.z)) * 2u;
  let off = bhdr[bi]; let cnt = bhdr[bi + 1u]; let nA = cnt & 0xffffu; let nR = cnt >> 16u;
  if (nA + nR == 0u) { return o; }
  let pw = p + warp(p);
  var acc = 1e9; var ws = 0.; var rs = 0.; var ms = vec3f(0.);
  for (var i = 0u; i < nA; i++) {
    let pr = prims[bidx[off + i]];
    let sd = sdPrim(pr, select(pw, p, pr.t.x >= 8.));
    acc = smin(acc, sd, pr.s.w);
    let w = exp(-clamp(sd, -8., 8.) * 1.2);
    ws += w; rs += w * pr.t.z; ms += w * pr.m.xyz;
  }
  var f = -${MROCK}.;
  if (nA > 0u) { f = -acc; o.m = ms / ws; if (f > -6.) { f += caveNoise(p, rs / ws); } }
  if (nR > 0u && f > -2.5) {
    let rn = gn(p * 0.8, 9u) + 0.5 * gn(p * 1.9, 10u);
    for (var i = 0u; i < nR; i++) {
      let pr = prims[bidx[off + nA + i]];
      let sd = sdPrim(pr, pw) + rn * pr.t.z;
      f = smin(f, sd, pr.s.w);
      o.m = max(o.m, pr.m.xyz * clamp(1. - sd / 1.5, 0., 1.));
    }
  }
  o.f = max(f, -${MROCK}.);
  return o;
}
`;

const W_BAKE_SDF = W_COMMON + W_FSTRI + W_FIELD + /*wgsl*/`
@fragment fn fs(@builtin(position) fc: vec4f, @location(0) @interpolate(flat) sl: u32) -> @location(0) vec4f {
  let p = vec3f(fc.xy, f32(sl) + 0.5) * ${VOX};
  return vec4f(field(p).f, 0., 0., 1.);
}
`;

const W_BAKE_MAT = W_COMMON + W_FSTRI + W_FIELD + /*wgsl*/`
@group(1) @binding(0) var sdfT: texture_3d<f32>;
@group(1) @binding(1) var sLin: sampler;
fn S(p: vec3f) -> f32 { return textureSampleLevel(sdfT, sLin, p * IWS, 0.).r; }
@fragment fn fs(@builtin(position) fc: vec4f, @location(0) @interpolate(flat) sl: u32) -> @location(0) vec4f {
  let p = vec3f(fc.xy, f32(sl) + 0.5) * ${VOX * 2};
  let fr = field(p);
  let e = 0.8;
  let g = vec3f(S(p + vec3f(e, 0., 0.)) - S(p - vec3f(e, 0., 0.)), S(p + vec3f(0., e, 0.)) - S(p - vec3f(0., e, 0.)), S(p + vec3f(0., 0., e)) - S(p - vec3f(0., 0., e)));
  let ny = g.y / max(length(g), 1e-4);
  let decor = fr.m.x * smoothstep(-0.45, 0.2, gn(p / 6.5, 31u) + 0.5 * gn(p / 2.7, 33u));
  let wet = clamp(fr.m.y + 0.55 * gn(p / 9., 32u) + 0.25 * gn(p / 3.1, 34u), 0., 1.);
  return vec4f(decor, wet, fr.m.z, ny * 0.5 + 0.5);
}
`;

const W_LIGHTS_U = /*wgsl*/`
struct LU { n: vec4f, pools: array<vec4f, 4>, falls: array<vec4f, 4>, lights: array<Light, ${MAXL}> }
@group(0) @binding(0) var<uniform> lu: LU;
@group(0) @binding(1) var sdfT: texture_3d<f32>;
@group(0) @binding(2) var sLin: sampler;
fn S(p: vec3f) -> f32 { return textureSampleLevel(sdfT, sLin, p * IWS, 0.).r; }
`;

const W_BAKE_LIGHT = W_COMMON + W_FSTRI + W_LIGHTS_U + /*wgsl*/`
fn vis(ro: vec3f, rd: vec3f, tmax: f32) -> f32 {
  var res = 1.; var t = 0.35;
  for (var i = 0; i < 220; i++) {
    let h = S(ro + rd * t);
    res = min(res, 6. * h / min(t, 5.));
    if (res < 0.01 || t > tmax) { break; }
    t += clamp(h * 0.75, 0.12, 8.);
  }
  if (t < tmax) { res = min(res, 0.); }
  return smoothstep(0.02, 0.9, res);
}
@fragment fn fs(@builtin(position) fc: vec4f, @location(0) @interpolate(flat) sl: u32) -> @location(0) vec4f {
  var p = vec3f(fc.xy, f32(sl) + 0.5) * vec3f(${WX / LNX}, ${WY / LNY}, ${WZ / LNZ});
  let d = S(p);
  if (d < -0.9) { return vec4f(0.); }
  if (d < 0.7) {
    let e = 0.4;
    let g = normalize(vec3f(S(p + vec3f(e, 0., 0.)) - S(p - vec3f(e, 0., 0.)), S(p + vec3f(0., e, 0.)) - S(p - vec3f(0., e, 0.)), S(p + vec3f(0., 0., e)) - S(p - vec3f(0., 0., e))) + 1e-5);
    p += g * (0.7 - d);
  }
  var c = vec3f(0.);
  let n = u32(lu.n.x);
  for (var i = 0u; i < n; i++) {
    let L = lu.lights[i]; var tm = 0.;
    let la = lightAt(L, p, &tm);
    if (la.w <= 0.) { continue; }
    let v = vis(p, la.xyz, tm);
    c += L.col.rgb * la.w * v * select(1., 0.22, L.col.w > 0.5 && L.col.w < 1.5);
  }
  var mist = 0.;
  for (var i = 0u; i < u32(lu.n.y); i++) {
    let pl = lu.pools[i]; let h = p.y - pl.z;
    if (h > -0.5 && length(p.xz - pl.xy) < pl.w) { mist = max(mist, exp(-max(h, 0.) * 0.55)); }
  }
  for (var i = 0u; i < u32(lu.n.z); i++) {
    let f = lu.falls[i]; let b = f.xyz - vec3f(0., f.w, 0.);
    let q = p - b; let r = length(q.xz);
    mist = max(mist, 3. * exp(-r * 0.22) * exp(-max(q.y, 0.) * 0.12) * step(q.y, f.w + 2.));
  }
  return vec4f(c, mist);
}
`;

const W_BAKE_AMB = (AMB_SP, AMB_K) => W_COMMON + W_FSTRI + /*wgsl*/`
@group(0) @binding(0) var lvT: texture_3d<f32>;
@group(0) @binding(1) var sLin: sampler;
@fragment fn fs(@builtin(position) fc: vec4f, @location(0) @interpolate(flat) sl: u32) -> @location(0) vec4f {
  let p = vec3f(fc.xy, f32(sl) + 0.5) * vec3f(${WX / ANX}, ${WY / ANY}, ${WZ / ANZ});
  var c = vec3f(0.); var ws = 0.;
  for (var k = -3; k <= 3; k++) { for (var j = -3; j <= 3; j++) { for (var i = -3; i <= 3; i++) {
    let o = vec3f(f32(i), f32(j), f32(k)) * ${AMB_SP};
    let w = exp(-dot(o, o) * ${AMB_K});
    c += textureSampleLevel(lvT, sLin, (p + o) * IWS, 0.).rgb * w; ws += w;
  }}}
  return vec4f(c / ws, 1.);
}
`;

// tiling noise textures.  A (rgba8snorm): rgb = analytic gradient / GS, a = fbm value.  B (rgba8unorm): r = F1, g = F2-F1, b = cell id, a = blotch
const GS = 24;
const W_NOISE = W_COMMON + /*wgsl*/`
@group(0) @binding(0) var outA: texture_storage_3d<rgba8snorm, write>;
@group(0) @binding(1) var outB: texture_storage_3d<rgba8unorm, write>;
fn hp(c: vec3i, per: i32, s: u32) -> vec3f { return h3v(((c % per) + per) % per, s); }
fn gnd(p: vec3f, per: i32, s: u32) -> vec4f {
  let i = floor(p); let f = p - i; let c = vec3i(i);
  let u = f * f * f * (f * (f * 6. - 15.) + 10.); let du = 30. * f * f * (f * (f - 2.) + 1.);
  let ga = hp(c, per, s); let gb = hp(c + vec3i(1, 0, 0), per, s); let gc = hp(c + vec3i(0, 1, 0), per, s); let gd = hp(c + vec3i(1, 1, 0), per, s);
  let ge = hp(c + vec3i(0, 0, 1), per, s); let gf = hp(c + vec3i(1, 0, 1), per, s); let gg = hp(c + vec3i(0, 1, 1), per, s); let gh = hp(c + vec3i(1, 1, 1), per, s);
  let va = dot(ga, f); let vb = dot(gb, f - vec3f(1., 0., 0.)); let vc = dot(gc, f - vec3f(0., 1., 0.)); let vd = dot(gd, f - vec3f(1., 1., 0.));
  let ve = dot(ge, f - vec3f(0., 0., 1.)); let vf = dot(gf, f - vec3f(1., 0., 1.)); let vg = dot(gg, f - vec3f(0., 1., 1.)); let vh = dot(gh, f - vec3f(1., 1., 1.));
  let v = va + u.x * (vb - va) + u.y * (vc - va) + u.z * (ve - va) + u.x * u.y * (va - vb - vc + vd) + u.y * u.z * (va - vc - ve + vg) + u.z * u.x * (va - vb - ve + vf) + u.x * u.y * u.z * (vb - va + vc - vd + ve - vf - vg + vh);
  let d = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.z * (ge - ga) + u.x * u.y * (ga - gb - gc + gd) + u.y * u.z * (ga - gc - ge + gg) + u.z * u.x * (ga - gb - ge + gf) + u.x * u.y * u.z * (gb - ga + gc - gd + ge - gf - gg + gh)
    + du * (vec3f(vb - va, vc - va, ve - va) + u.yzx * vec3f(va - vb - vc + vd, va - vc - ve + vg, va - vb - ve + vf) + u.zxy * vec3f(va - vb - ve + vf, va - vb - vc + vd, va - vc - ve + vg) + u.yzx * u.zxy * (vb - va + vc - vd + ve - vf - vg + vh));
  return vec4f(d, v);
}
@compute @workgroup_size(4, 4, 4) fn cs(@builtin(global_invocation_id) id: vec3u) {
  let p = (vec3f(id) + 0.5) / ${NN}.;
  let o0 = gnd(p * 4., 4, 40u); let o1 = gnd(p * 8., 8, 41u); let o2 = gnd(p * 16., 16, 42u); let o3 = gnd(p * 32., 32, 43u);
  let v = 0.55 * o0.w + 0.13 * (0.45 - 2.2 * abs(o1.w)) + 0.22 * o1.w + 0.2 * o2.w + 0.1 * o3.w;
  let g = 0.55 * 4. * o0.xyz + (0.22 - 0.13 * 2.2 * sign(o1.w)) * 8. * o1.xyz + 0.2 * 16. * o2.xyz + 0.1 * 32. * o3.xyz;
  textureStore(outA, id, vec4f(g / ${GS}., v));
  // worley, 8 cells per tile
  let q = p * 8.; let ci = vec3i(floor(q)); let fq = fract(q);
  var f1 = 9.; var f2 = 9.; var idc = vec3i(0);
  for (var k = -1; k <= 1; k++) { for (var j = -1; j <= 1; j++) { for (var i = -1; i <= 1; i++) {
    let o = vec3i(i, j, k); let c = ci + o;
    let r = hp(c, 8, 50u) * 0.5 + 0.5;
    let dv = vec3f(o) + r - fq; let dd = dot(dv, dv);
    if (dd < f1) { f2 = f1; f1 = dd; idc = c; } else if (dd < f2) { f2 = dd; }
  }}}
  f1 = sqrt(f1); f2 = sqrt(f2);
  let idr = hp(idc, 8, 51u).x * 0.5 + 0.5;
  let bl = gnd(p * 5., 5, 52u).w * 0.7 + gnd(p * 11., 11, 53u).w * 0.35;
  textureStore(outB, id, vec4f(clamp(f1 / 1.2, 0., 1.), clamp(f2 - f1, 0., 1.), idr, clamp(bl * 0.9 + 0.5, 0., 1.)));
}
`;

const W_QUERY = W_COMMON + /*wgsl*/`
@group(0) @binding(0) var sdfT: texture_3d<f32>;
@group(0) @binding(1) var sLin: sampler;
@group(0) @binding(2) var<storage, read> qi: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> qo: array<vec4f>;
fn S(p: vec3f) -> f32 { return textureSampleLevel(sdfT, sLin, p * IWS, 0.).r; }
@compute @workgroup_size(64) fn cs(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&qi)) { return; }
  let p = qi[id.x].xyz; let e = 0.4;
  let g = vec3f(S(p + vec3f(e, 0., 0.)) - S(p - vec3f(e, 0., 0.)), S(p + vec3f(0., e, 0.)) - S(p - vec3f(0., e, 0.)), S(p + vec3f(0., 0., e)) - S(p - vec3f(0., 0., e)));
  qo[id.x] = vec4f(normalize(g + 1e-6), S(p));
}
`;
