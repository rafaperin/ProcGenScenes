// ---------------------------------------------------------------------------
// Application: device, bake, frame loop (allocation-free), camera, benchmark
// ---------------------------------------------------------------------------
async function main() {
  const Q = new URLSearchParams(location.search);
  const $ = id => document.getElementById(id);
  const canvas = $('c'), hud = $('hud'), ldEl = $('ld'), ldBar = $('lb'), ldTxt = $('lt'), helpEl = $('help');
  const fail = m => { ldTxt.textContent = m; ldBar.style.display = 'none'; throw new Error(m); };
  if (!navigator.gpu) fail('WebGPU is not available in this browser.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) fail('No WebGPU adapter found.');
  const hasTS = adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({ requiredFeatures: hasTS ? ['timestamp-query'] : [] });
  device.addEventListener('uncapturederror', e => console.error('GPUERR ' + e.error.message));
  const ctx = canvas.getContext('webgpu'), fmt = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format: fmt, alphaMode: 'opaque' });
  const FREEZE = Q.has('tt'), BENCH = Q.has('bench'), CAP = Q.has('cap'), STATS = Q.has('stats') || BENCH;
  const yieldUI = () => new Promise(r => setTimeout(r, 0));
  const progress = async (t, f) => { ldTxt.textContent = t; ldBar.firstChild.style.width = (f * 100).toFixed(0) + '%'; await yieldUI(); };

  async function mod(code, name) {
    const m = device.createShaderModule({ code });
    const info = await m.getCompilationInfo();
    for (const g of info.messages) if (g.type == 'error') console.error('WGSL ' + name + ' ' + g.lineNum + ':' + g.linePos + ' ' + g.message + ' >> ' + (code.split('\n')[g.lineNum - 1] || '').trim().slice(0, 160));
    return m;
  }
  const TU = GPUTextureUsage, BU = GPUBufferUsage, SS = GPUShaderStage;
  const RT = TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING, ST = TU.STORAGE_BINDING | TU.TEXTURE_BINDING;
  const T3 = (w, h, d, format, usage) => device.createTexture({ size: [w, h, d], dimension: '3d', format, usage });
  const sdfTex = T3(NX, NY, NZ, 'r16float', RT), matTex = T3(MNX, MNY, MNZ, 'rgba8unorm', RT);
  const lvTex = T3(LNX, LNY, LNZ, 'rgba16float', RT), avTex = T3(ANX, ANY, ANZ, 'rgba16float', RT), av0Tex = T3(ANX, ANY, ANZ, 'rgba16float', RT);
  const nATex = T3(NN, NN, NN, 'rgba8snorm', ST), nBTex = T3(NN, NN, NN, 'rgba8unorm', ST);
  const sLin = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  const sRep = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat' });
  const buf = (data, usage) => { const b = device.createBuffer({ size: Math.ceil(data.byteLength / 4) * 4, usage: usage | BU.COPY_DST }); device.queue.writeBuffer(b, 0, data); return b; };

  // ------------------------------------------------------------------ bake
  await progress('Compiling shaders', 0.02);
  const [mSdf, mMat, mLight, mAmb, mNoise, mQuery, mMain, mTaa, mPart, mPost, mFinal] = await Promise.all([
    mod(W_BAKE_SDF, 'sdf'), mod(W_BAKE_MAT, 'mat'), mod(W_BAKE_LIGHT, 'light'), mod(W_BAKE_AMB(2.6, 0.022), 'amb'), mod(W_NOISE, 'noise'), mod(W_QUERY, 'query'),
    mod(W_MAIN, 'main'), mod(W_TAA, 'taa'), mod(W_PART, 'part'), mod(W_POST, 'post'), mod(W_FINAL, 'final')]);
  const primBuf = buf(prim.subarray(0, nPrim * PRIM_F), BU.STORAGE), hdrBuf = buf(bhdr, BU.STORAGE), idxBuf = buf(bidx, BU.STORAGE);
  const rp = (module, format, extra) => device.createRenderPipelineAsync(Object.assign({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format }] }, primitive: { topology: 'triangle-list' } }, extra || {}));

  async function bakeSlices(pipe, groups, tex, depth, label, batch) {
    const view = tex.createView();
    for (let z0 = 0; z0 < depth; z0 += batch) {
      const enc = device.createCommandEncoder();
      for (let z = z0; z < Math.min(depth, z0 + batch); z++) {
        const pass = enc.beginRenderPass({ colorAttachments: [{ view, depthSlice: z, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
        pass.setPipeline(pipe); for (let i = 0; i < groups.length; i++) pass.setBindGroup(i, groups[i]);
        pass.draw(3, 1, 0, z); pass.end();
      }
      device.queue.submit([enc.finish()]);
      await device.queue.onSubmittedWorkDone();
      await progress(label, z0 / depth);
    }
  }
  const tBake = performance.now();
  { // noise
    const p = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: mNoise, entryPoint: 'cs' } });
    const g = device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: nATex.createView() }, { binding: 1, resource: nBTex.createView() }] });
    const enc = device.createCommandEncoder(), ps = enc.beginComputePass(); ps.setPipeline(p); ps.setBindGroup(0, g); ps.dispatchWorkgroups(NN / 4, NN / 4, NN / 4); ps.end(); device.queue.submit([enc.finish()]);
  }
  const fieldEntries = [{ binding: 0, resource: { buffer: primBuf } }, { binding: 1, resource: { buffer: hdrBuf } }, { binding: 2, resource: { buffer: idxBuf } }];
  {
    const p = await rp(mSdf, 'r16float');
    await bakeSlices(p, [device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: fieldEntries })], sdfTex, NZ, 'Carving the cave', 24);
  }
  {
    const p = await rp(mMat, 'rgba8unorm');
    await bakeSlices(p, [device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: fieldEntries }),
    device.createBindGroup({ layout: p.getBindGroupLayout(1), entries: [{ binding: 0, resource: sdfTex.createView() }, { binding: 1, resource: sLin }] })], matTex, MNZ, 'Depositing minerals', 32);
  }
  // point queries against the baked field (clearance / gradient)
  const QN = 1024, BOUNCE = 0.42, PTK = 14;
  const qIn = device.createBuffer({ size: QN * 16, usage: BU.STORAGE | BU.COPY_DST }), qOut = device.createBuffer({ size: QN * 16, usage: BU.STORAGE | BU.COPY_SRC }), qRead = device.createBuffer({ size: QN * 16, usage: BU.MAP_READ | BU.COPY_DST });
  const qPipe = await device.createComputePipelineAsync({ layout: 'auto', compute: { module: mQuery, entryPoint: 'cs' } });
  const qGroup = device.createBindGroup({ layout: qPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: sdfTex.createView() }, { binding: 1, resource: sLin }, { binding: 2, resource: { buffer: qIn } }, { binding: 3, resource: { buffer: qOut } }] });
  async function query(arr, n) {
    device.queue.writeBuffer(qIn, 0, arr, 0, n * 4);
    const enc = device.createCommandEncoder(), ps = enc.beginComputePass(); ps.setPipeline(qPipe); ps.setBindGroup(0, qGroup); ps.dispatchWorkgroups(QN / 64); ps.end();
    enc.copyBufferToBuffer(qOut, 0, qRead, 0, QN * 16); device.queue.submit([enc.finish()]);
    await qRead.mapAsync(GPUMapMode.READ); const o = new Float32Array(qRead.getMappedRange().slice(0)); qRead.unmap(); return o;
  }
  async function relax(arr, n, clr, iters, smooth) {
    let minC = 1e9;
    for (let it = 0; it < iters; it++) {
      const r = await query(arr, n); minC = 1e9;
      for (let i = 0; i < n; i++) {
        const f = r[i * 4 + 3], c = typeof clr == 'number' ? clr : clr[i]; minC = Math.min(minC, f);
        if (f < c) { const s = Math.min(c - f, 1.5) * 0.8; arr[i * 4] += r[i * 4] * s; arr[i * 4 + 1] += r[i * 4 + 1] * s; arr[i * 4 + 2] += r[i * 4 + 2] * s; }
      }
      if (smooth && it < iters - 2) for (let k = 0; k < 2; k++) for (let i = 1; i < n - 1; i++) for (let j = 0; j < 3; j++) arr[i * 4 + j] += 0.25 * (0.5 * (arr[i * 4 - 4 + j] + arr[i * 4 + 4 + j]) - arr[i * 4 + j]);
    }
    return minC;
  }
  await progress('Surveying passages', 0.9);
  {
    const sn = lights.filter(l => l.snap), a = new Float32Array(QN * 4);
    sn.forEach((l, i) => a.set([l.p[0], l.p[1], l.p[2], 1], i * 4));
    for (let it = 0; it < 10; it++) { const r = await query(a, sn.length); for (let i = 0; i < sn.length; i++) { const s = Math.max(-1.5, Math.min(1.5, 0.75 - r[i * 4 + 3])) * 0.9; for (let j = 0; j < 3; j++) a[i * 4 + j] += r[i * 4 + j] * s; } }
    sn.forEach((l, i) => { l.p = [a[i * 4], a[i * 4 + 1], a[i * 4 + 2]]; });
    const rc = await relax(routeW, NROUTE, routeC, 14, true);
    const pe = new Float32Array(QN * 4); for (let i = 0; i < NPOSE; i++) pe.set(poseW.subarray(i * 8, i * 8 + 4), i * 4);
    const pc = await relax(pe, NPOSE, 0.55, 8, false);
    for (let i = 0; i < NPOSE; i++) poseW.set(pe.subarray(i * 4, i * 4 + 3), i * 8);
    const st = new Float32Array(QN * 4); st.set([startW[0], startW[1], startW[2], 1]); await relax(st, 1, 0.6, 8, false); startW[0] = st[0]; startW[1] = st[1]; startW[2] = st[2];
    console.log('route min clearance ' + rc.toFixed(2) + ' pose min ' + pc.toFixed(2) + ' prims ' + nPrim + ' lights ' + lights.length);
  }
  { // each sky beam gets a bounce light where it lands
    const bl = lights.filter(l => l.type == 1), a = new Float32Array(QN * 4), t = bl.map(() => 0), done = bl.map(() => false);
    for (let it = 0; it < 70; it++) {
      bl.forEach((l, i) => a.set([l.p[0] + l.dir[0] * t[i], Math.min(WY - 0.3, l.p[1] + l.dir[1] * t[i]), l.p[2] + l.dir[2] * t[i], 1], i * 4));
      const r = await query(a, bl.length);
      bl.forEach((l, i) => { if (done[i]) return; const f = r[i * 4 + 3]; if (f < 0.35 && t[i] > 12) done[i] = true; else t[i] += Math.max(0.3, f * 0.8); });
    }
    bl.forEach((l, i) => { const s = t[i] - 1.6, k = BOUNCE * l.R * l.R; lights.push({ p: [l.p[0] + l.dir[0] * s, l.p[1] + l.dir[1] * s, l.p[2] + l.dir[2] * s], range: 85, col: [l.col[0] * k, l.col[1] * k, l.col[2] * k], type: 0, dir: [0, 1, 0], R: 4, snap: false }); });
  }
  // light data
  const NLT = lights.length; if (NLT > MAXL) throw 'too many lights';
  const LD = new Float32Array(MAXL * 12);
  lights.forEach((l, i) => LD.set([l.p[0], l.p[1], l.p[2], l.range, l.col[0] * (l.type == 2 ? PTK : 1), l.col[1] * (l.type == 2 ? PTK : 1), l.col[2] * (l.type == 2 ? PTK : 1), l.type, l.dir[0], l.dir[1], l.dir[2], l.R], i * 12));
  const NPOOL = pools.length;
  {
    const lu = new Float32Array(4 + 16 + 16 + MAXL * 12);
    lu[0] = NLT; lu[1] = NPOOL; lu[2] = falls.length;
    pools.forEach((p, i) => lu.set(p, 4 + i * 4)); falls.forEach((f, i) => lu.set([f.top[0], f.top[1], f.top[2], f.h], 20 + i * 4)); lu.set(LD, 36);
    const lub = buf(lu, BU.UNIFORM);
    const p = await rp(mLight, 'rgba16float');
    await bakeSlices(p, [device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: lub } }, { binding: 1, resource: sdfTex.createView() }, { binding: 2, resource: sLin }] })], lvTex, LNZ, 'Letting the light in', 16);
    const p2 = await rp(mAmb, 'rgba16float');
    await bakeSlices(p2, [device.createBindGroup({ layout: p2.getBindGroupLayout(0), entries: [{ binding: 0, resource: lvTex.createView() }, { binding: 1, resource: sLin }] })], av0Tex, ANZ, 'Letting the light in', 48);
    const p3 = await rp(await mod(W_BAKE_AMB(6.5, 0.0045), 'amb2'), 'rgba16float');
    await bakeSlices(p3, [device.createBindGroup({ layout: p3.getBindGroupLayout(0), entries: [{ binding: 0, resource: av0Tex.createView() }, { binding: 1, resource: sLin }] })], avTex, ANZ, 'Letting the light in', 48);
    av0Tex.destroy();
  }
  console.log('bake ms ' + (performance.now() - tBake).toFixed(0));

  // ------------------------------------------------------------- pipelines
  await progress('Preparing renderer', 0.97);
  const VF = SS.VERTEX | SS.FRAGMENT, t3 = { viewDimension: '3d', sampleType: 'float' };
  const sceneBGL = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: VF, buffer: {} }, { binding: 1, visibility: VF, texture: t3 }, { binding: 2, visibility: VF, texture: t3 }, { binding: 3, visibility: VF, texture: t3 }, { binding: 4, visibility: VF, texture: t3 }, { binding: 5, visibility: VF, texture: t3 }, { binding: 6, visibility: VF, texture: t3 }, { binding: 7, visibility: VF, sampler: {} }, { binding: 8, visibility: VF, sampler: {} }] });
  const depBGL = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: SS.FRAGMENT, texture: { sampleType: 'unfilterable-float' } }] });
  const ub = new Float32Array(UB_F), ubuf = device.createBuffer({ size: UB_F * 4, usage: BU.UNIFORM | BU.COPY_DST });
  const fu = new Float32Array(8), fubuf = device.createBuffer({ size: 32, usage: BU.UNIFORM | BU.COPY_DST });
  const sceneBG = device.createBindGroup({ layout: sceneBGL, entries: [{ binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: sdfTex.createView() }, { binding: 2, resource: matTex.createView() }, { binding: 3, resource: lvTex.createView() }, { binding: 4, resource: avTex.createView() }, { binding: 5, resource: nATex.createView() }, { binding: 6, resource: nBTex.createView() }, { binding: 7, resource: sLin }, { binding: 8, resource: sRep }] });
  const HF = 'rgba16float', tri = { topology: 'triangle-list' }, addB = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };
  const [pMain, pTaa, pPart, pDown, pUp, pFinal] = await Promise.all([
    device.createRenderPipelineAsync({ layout: device.createPipelineLayout({ bindGroupLayouts: [sceneBGL] }), vertex: { module: mMain, entryPoint: 'vs' }, fragment: { module: mMain, entryPoint: 'fs', targets: [{ format: HF }, { format: 'r32float' }] }, primitive: tri }),
    device.createRenderPipelineAsync({ layout: 'auto', vertex: { module: mTaa, entryPoint: 'vs' }, fragment: { module: mTaa, entryPoint: 'fs', targets: [{ format: HF }, { format: HF }] }, primitive: tri }),
    device.createRenderPipelineAsync({ layout: device.createPipelineLayout({ bindGroupLayouts: [sceneBGL, depBGL] }), vertex: { module: mPart, entryPoint: 'vs' }, fragment: { module: mPart, entryPoint: 'fs', targets: [{ format: HF, blend: addB }] }, primitive: { topology: 'triangle-strip' } }),
    device.createRenderPipelineAsync({ layout: 'auto', vertex: { module: mPost, entryPoint: 'vs' }, fragment: { module: mPost, entryPoint: 'fsDown', targets: [{ format: HF }] }, primitive: tri }),
    device.createRenderPipelineAsync({ layout: 'auto', vertex: { module: mPost, entryPoint: 'vs' }, fragment: { module: mPost, entryPoint: 'fsUp', targets: [{ format: HF, blend: addB }] }, primitive: tri }),
    device.createRenderPipelineAsync({ layout: 'auto', vertex: { module: mFinal, entryPoint: 'vs' }, fragment: { module: mFinal, entryPoint: 'fs', targets: [{ format: fmt }] }, primitive: tri })]);

  // ---------------------------------------------------- size-dependent targets
  const NBL = 5;
  let W = 0, H = 0, targets = [];
  const clr = [0, 0, 0, 0];
  const mainPass = { colorAttachments: [{ view: null, loadOp: 'clear', storeOp: 'store', clearValue: clr }, { view: null, loadOp: 'clear', storeOp: 'store', clearValue: clr }], timestampWrites: undefined };
  const taaPass = [0, 1].map(() => ({ colorAttachments: [{ view: null, loadOp: 'clear', storeOp: 'store', clearValue: clr }, { view: null, loadOp: 'clear', storeOp: 'store', clearValue: clr }] }));
  const partPass = { colorAttachments: [{ view: null, loadOp: 'load', storeOp: 'store' }] };
  const downPass = [], upPass = [];
  for (let i = 0; i < NBL; i++) { downPass.push({ colorAttachments: [{ view: null, loadOp: 'clear', storeOp: 'store', clearValue: clr }] }); upPass.push({ colorAttachments: [{ view: null, loadOp: 'load', storeOp: 'store' }] }); }
  const finalPass = { colorAttachments: [{ view: null, loadOp: 'clear', storeOp: 'store', clearValue: clr }], timestampWrites: undefined };
  let taaBG = [null, null], depBG = null, downBG = [], upBG = [], finalBG = null;
  function resize() {
    const sc = +(Q.get('scale') || 1);
    const w = Math.max(64, Math.min(4096, Math.floor(canvas.clientWidth * devicePixelRatio * sc))), h = Math.max(64, Math.min(4096, Math.floor(canvas.clientHeight * devicePixelRatio * sc)));
    if (w == W && h == H) return;
    W = w; H = h; canvas.width = W; canvas.height = H;
    for (const t of targets) t.destroy(); targets = [];
    const T2 = (w, h, format) => { const t = device.createTexture({ size: [w, h], format, usage: RT }); targets.push(t); return t.createView(); };
    const hdr = T2(W, H, HF), dep = T2(W, H, 'r32float'), hist = [T2(W, H, HF), T2(W, H, HF)], scene = T2(W, H, HF);
    mainPass.colorAttachments[0].view = hdr; mainPass.colorAttachments[1].view = dep;
    for (let i = 0; i < 2; i++) {
      taaPass[i].colorAttachments[0].view = hist[i]; taaPass[i].colorAttachments[1].view = scene;
      taaBG[i] = device.createBindGroup({ layout: pTaa.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: hdr }, { binding: 2, resource: dep }, { binding: 3, resource: hist[1 - i] }, { binding: 4, resource: sLin }] });
    }
    partPass.colorAttachments[0].view = scene;
    depBG = device.createBindGroup({ layout: depBGL, entries: [{ binding: 0, resource: dep }] });
    const bl = []; downBG = []; upBG = [];
    for (let i = 0; i < NBL; i++) bl.push(T2(Math.max(1, W >> (i + 1)), Math.max(1, H >> (i + 1)), HF));
    for (let i = 0; i < NBL; i++) {
      downPass[i].colorAttachments[0].view = bl[i];
      downBG.push(device.createBindGroup({ layout: pDown.getBindGroupLayout(0), entries: [{ binding: 0, resource: i ? bl[i - 1] : scene }, { binding: 1, resource: sLin }] }));
      if (i < NBL - 1) { upPass[i].colorAttachments[0].view = bl[i]; upBG.push(device.createBindGroup({ layout: pUp.getBindGroupLayout(0), entries: [{ binding: 0, resource: bl[i + 1] }, { binding: 1, resource: sLin }] })); }
    }
    finalBG = device.createBindGroup({ layout: pFinal.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: fubuf } }, { binding: 1, resource: scene }, { binding: 2, resource: bl[0] }, { binding: 3, resource: sLin }] });
    resetTAA = 2;
  }

  // ------------------------------------------------------------- fly-through
  const BOUNCE_ = 0; const TOUR = 60, NT = TOUR * 60 + 1;
  const flyP = new Float32Array(NT * 3), flyD = new Float32Array(NT * 3);
  {
    const P = i => { i = Math.max(0, Math.min(NROUTE - 1, i)); return [routeW[i * 4], routeW[i * 4 + 1], routeW[i * 4 + 2]]; };
    const fine = [], fv = [], fb = [], fc = [];
    for (let i = 0; i < NROUTE - 1; i++) for (let j = 0; j < 6; j++) { fine.push(cr(P(i - 1), P(i), P(i + 1), P(i + 2), j / 6)); fv.push(lerp(routeV[i], routeV[i + 1], j / 6)); fb.push(lerp(routeN[i][5] || 0, routeN[i + 1][5] || 0, j / 6)); fc.push(lerp(routeC[i], routeC[i + 1], j / 6)); }
    fine.push(P(NROUTE - 1)); fv.push(routeV[NROUTE - 1]); fb.push(routeN[NROUTE - 1][5] || 0); fc.push(routeC[NROUTE - 1]);
    const n = fine.length, box = (a, r) => a.map((_, i) => { let s = 0, c = 0; for (let k = -r; k <= r; k++) { const q = i + k; if (q >= 0 && q < n) { s += a[q]; c++; } } return s / c; });
    const sv = box(box(fv, 14), 14), sb = box(box(fb, 20), 20), scl = box(fc, 10);
    const T = [0]; for (let i = 1; i < n; i++) T.push(T[i - 1] + dist3(fine[i], fine[i - 1]) / (0.5 * (sv[i] + sv[i - 1])));
    const sc = TOUR / T[n - 1]; let k = 0;
    const pb = new Float32Array(NT), pcl = new Float32Array(NT);
    for (let i = 0; i < NT; i++) {
      const t = i / 60 / sc; while (k < n - 2 && T[k + 1] < t) k++;
      const u = Math.min(1, Math.max(0, (t - T[k]) / Math.max(1e-6, T[k + 1] - T[k])));
      for (let j = 0; j < 3; j++) flyP[i * 3 + j] = lerp(fine[k][j], fine[k + 1][j], u); pb[i] = lerp(sb[k], sb[k + 1], u); pcl[i] = lerp(scl[k], scl[k + 1], u);
    }
    for (let p = 0; p < 2; p++) { const c = flyP.slice(); for (let i = 3; i < NT - 3; i++) for (let j = 0; j < 3; j++) { let s = 0; for (let q = -3; q <= 3; q++) s += c[(i + q) * 3 + j]; flyP[i * 3 + j] = s / 7; } }
    { // push the 60 Hz path samples off the walls, then re-smooth
      const qa = new Float32Array(QN * 4); let minC = 1e9;
      for (let it = 0; it < 12; it++) {
        minC = 1e9;
        for (let o = 0; o < NT; o += QN) {
          const m = Math.min(QN, NT - o);
          for (let i = 0; i < m; i++) { qa[i * 4] = flyP[(o + i) * 3]; qa[i * 4 + 1] = flyP[(o + i) * 3 + 1]; qa[i * 4 + 2] = flyP[(o + i) * 3 + 2]; qa[i * 4 + 3] = 1; }
          const r = await query(qa, m);
          for (let i = 0; i < m; i++) { const f = r[i * 4 + 3], c = pcl[o + i] + 0.12; minC = Math.min(minC, f); if (f < c) { const w = Math.min(c - f, 1.2) * 0.7; for (let j = 0; j < 3; j++) flyP[(o + i) * 3 + j] += r[i * 4 + j] * w; } }
        }
        if (it < 10) { const c = flyP.slice(); for (let i = 4; i < NT - 4; i++) for (let j = 0; j < 3; j++) { let q = 0; for (let d = -4; d <= 4; d++) q += c[(i + d) * 3 + j]; flyP[i * 3 + j] = q / 9; } }
      }
      { const c = flyP.slice(); for (let i = 2; i < NT - 2; i++) for (let j = 0; j < 3; j++) flyP[i * 3 + j] = (c[(i - 2) * 3 + j] + c[(i - 1) * 3 + j] + c[i * 3 + j] + c[(i + 1) * 3 + j] + c[(i + 2) * 3 + j]) / 5; }
      console.log('fly path min clearance ' + minC.toFixed(2));
    }
    const raw = new Float32Array(NT * 3);
    for (let i = 0; i < NT; i++) { const a = Math.min(i, NT - 50), b = a + 48; let d = norm3([flyP[b * 3] - flyP[a * 3], flyP[b * 3 + 1] - flyP[a * 3 + 1], flyP[b * 3 + 2] - flyP[a * 3 + 2]]); d = norm3([d[0], d[1] * 0.75 + pb[i], d[2]]); raw.set(d, i * 3); }
    for (let i = 0; i < NT; i++) { let s = [0, 0, 0]; for (let q = -24; q <= 24; q++) { const m = Math.max(0, Math.min(NT - 1, i + q)), w = 1 - Math.abs(q) / 25; for (let j = 0; j < 3; j++) s[j] += raw[m * 3 + j] * w; } flyD.set(norm3(s), i * 3); }
    console.log('route length ' + (T[n - 1] ? fine.reduce((s, p, i) => i ? s + dist3(p, fine[i - 1]) : 0, 0).toFixed(0) : 0) + ' m');
  }

  // ------------------------------------------------------------------ state
  const keys = new Uint8Array(256);
  let px = startW[0], py = startW[1], pz = startW[2], yaw = 0, pitch = 0, yawT = 0, pitchT = 0, vx = 0, vy = 0, vz = 0;
  let speed = 5, lampOn = Q.get('lamp') == '0' ? 0 : 1, lampI = +(Q.get('lampi') || 5.6), debug = +(Q.get('debug') || 0), tour = BENCH || Q.has('tour') || Q.has('tt') ? 1 : 0, tourT = 0;
  let fx = 0, fy = 0, fz = 1, rx = 1, ry = 0, rz = 0, ux = 0, uy = 1, uz = 0, lx = 0, ly = 0, lz = 1;
  let frame = 0, time = +(Q.get('time') || 0), last = 0, resetTAA = 2, mdx = 0, mdy = 0, hudOn = STATS ? 1 : 0;
  const FOVT = Math.tan(34 * Math.PI / 180), EXPO = +(Q.get('exp') || 1.5);
  const lookAt = (ex, ey, ez, tx, ty, tz) => { const d = norm3([tx - ex, ty - ey, tz - ez]); px = ex; py = ey; pz = ez; yaw = yawT = Math.atan2(d[0], d[2]); pitch = pitchT = Math.asin(d[1]); };
  lookAt(startW[0], startW[1], startW[2], startT[0], startT[1], startT[2]);
  if (Q.has('pose')) { const i = +Q.get('pose') * 8; lookAt(poseW[i], poseW[i + 1], poseW[i + 2], poseW[i + 4], poseW[i + 5], poseW[i + 6]); }
  if (Q.has('cam')) { const c = Q.get('cam').split(',').map(Number); px = c[0]; py = c[1]; pz = c[2]; yaw = yawT = (c[3] || 0) * Math.PI / 180; pitch = pitchT = (c[4] || 0) * Math.PI / 180; }
  if (Q.has('tt')) { tourT = +Q.get('tt'); }
  const jit = new Float32Array(32);
  { const hal = (i, b) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; }; for (let i = 0; i < 16; i++) { jit[i * 2] = hal(i + 1, 2) - 0.5; jit[i * 2 + 1] = hal(i + 1, 3) - 0.5; } }
  // static uniform blocks
  pools.forEach((p, i) => ub.set(p, 48 + i * 4));
  falls.forEach((f, i) => { ub.set([f.top[0], f.top[1], f.top[2], f.h], 64 + i * 4); ub.set([f.dir[0], f.dir[1], f.w, 0], 80 + i * 4); });
  bursts.forEach((b, i) => ub.set([b[0], b[1], b[2], 1], 96 + i * 4));
  if (crys.length > NCRY) throw 'too many crystals';
  crys.forEach((c, i) => { ub.set([c.c[0], c.c[1], c.c[2], c.r, c.q[0], c.q[1], c.q[2], c.h], 400 + i * 8); });
  const actKey = new Float32Array(NACT), actIdx = new Int32Array(NACT);
  let ppx = px, ppy = py, ppz = pz, pfx = 0, pfy = 0, pfz = 1, prx = 1, pry = 0, prz = 0, pux = 0, puy = 1, puz = 0;

  // GPU timing
  const qs = hasTS && STATS ? device.createQuerySet({ type: 'timestamp', count: 2 }) : null;
  const NRB = 8, tsResolve = qs ? device.createBuffer({ size: 16, usage: BU.QUERY_RESOLVE | BU.COPY_SRC }) : null;
  const rb = [], rbFree = new Uint8Array(NRB), rbCb = [], rbT = new Float32Array(NRB);
  let gpuMs = 0, gpuAcc = 0, gpuCnt = 0, tsN = 0, tsBad = 0, tsSkip = 0;
  const BN = 60 * 1200, bGpu = new Float32Array(BN), bDt = new Float32Array(BN), bGT = new Float32Array(BN); let bN = 0, bG = 0, benchState = 0, benchT0 = 0;
  if (qs) {
    mainPass.timestampWrites = { querySet: qs, beginningOfPassWriteIndex: 0 }; finalPass.timestampWrites = { querySet: qs, endOfPassWriteIndex: 1 };
    for (let i = 0; i < NRB; i++) {
      const b = device.createBuffer({ size: 16, usage: BU.MAP_READ | BU.COPY_DST }); rb.push(b); rbFree[i] = 1;
      rbCb.push(() => { const u = new Uint32Array(b.getMappedRange()); const ns = (u[3] - u[1]) * 4294967296 + (u[2] - u[0]); b.unmap(); rbFree[i] = 1; tsN++; if (!(ns > 0 && ns < 1e9) && tsBad < 5) { tsBad++; console.log('TSBAD ' + ns + ' ' + u[0] + ' ' + u[1] + ' ' + u[2] + ' ' + u[3]); } if (ns > 0 && ns < 1e9) { gpuMs = ns * 1e-6; gpuAcc += gpuMs; gpuCnt++; if (benchState == 1 && bG < BN) { bGT[bG] = rbT[i]; bGpu[bG++] = gpuMs; } } });
    }
  }
  const cmds = [null];

  function selectLights() {
    let n = 0;
    for (let i = 0; i < NLT; i++) {
      const o = i * 12; let d;
      const dx = px - LD[o], dy = py - LD[o + 1], dz = pz - LD[o + 2];
      if (LD[o + 7] == 1) { let al = dx * LD[o + 8] + dy * LD[o + 9] + dz * LD[o + 10]; al = al < 0 ? 0 : al > LD[o + 3] ? LD[o + 3] : al; const ex = dx - LD[o + 8] * al, ey = dy - LD[o + 9] * al, ez = dz - LD[o + 10] * al; d = Math.sqrt(ex * ex + ey * ey + ez * ez) - LD[o + 11]; }
      else d = Math.sqrt(dx * dx + dy * dy + dz * dz) - LD[o + 3];
      if (d > 175) continue;
      let k;
      if (n < NACT) k = n++; else if (d < actKey[NACT - 1]) k = NACT - 1; else continue;
      while (k > 0 && actKey[k - 1] > d) { actKey[k] = actKey[k - 1]; actIdx[k] = actIdx[k - 1]; k--; }
      actKey[k] = d; actIdx[k] = i;
    }
    for (let k = 0; k < n; k++) { const s = actIdx[k] * 12, t = 112 + k * 12; for (let j = 0; j < 12; j++) ub[t + j] = LD[s + j]; }
    return n;
  }

  function step(dt) {
    resize();
    time += dt;
    if (tour) {
      const t = Math.min(tourT, TOUR) * 60, i = Math.min(NT - 2, Math.floor(t)), u = t - i, a = i * 3;
      px = flyP[a] + (flyP[a + 3] - flyP[a]) * u; py = flyP[a + 1] + (flyP[a + 4] - flyP[a + 1]) * u; pz = flyP[a + 2] + (flyP[a + 5] - flyP[a + 2]) * u;
      const dx = flyD[a] + (flyD[a + 3] - flyD[a]) * u, dy = flyD[a + 1] + (flyD[a + 4] - flyD[a + 1]) * u, dz = flyD[a + 2] + (flyD[a + 5] - flyD[a + 2]) * u;
      yaw = yawT = Math.atan2(dx, dz); pitch = pitchT = Math.asin(dy / Math.sqrt(dx * dx + dy * dy + dz * dz));
      vx = vy = vz = 0; mdx = mdy = 0;
    } else {
      yawT -= mdx * 0.0022; pitchT -= mdy * 0.0022; mdx = mdy = 0;
      pitchT = pitchT > 1.55 ? 1.55 : pitchT < -1.55 ? -1.55 : pitchT;
      const ka = 1 - Math.exp(-dt * 28);
      yaw += (yawT - yaw) * ka; pitch += (pitchT - pitch) * ka;
    }
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    fx = cp * Math.sin(yaw); fy = sp; fz = cp * Math.cos(yaw);
    rx = -Math.cos(yaw); ry = 0; rz = Math.sin(yaw);                 // cross(f, worldUp) normalised
    ux = ry * fz - rz * fy; uy = rz * fx - rx * fz; uz = rx * fy - ry * fx;
    if (!tour) {
      const s = speed * (keys[16] ? 3.5 : 1), mf = keys[87] - keys[83], mr = keys[68] - keys[65], mu = (keys[69] | keys[32]) - keys[81];
      const tx = (fx * mf + rx * mr) * s, ty = (fy * mf + mu) * s, tz = (fz * mf + rz * mr) * s, kv = 1 - Math.exp(-dt * 6);
      vx += (tx - vx) * kv; vy += (ty - vy) * kv; vz += (tz - vz) * kv;
      px += vx * dt; py += vy * dt; pz += vz * dt;
      px = px < 2 ? 2 : px > WX - 2 ? WX - 2 : px; py = py < 2 ? 2 : py > WY + 30 ? WY + 30 : py; pz = pz < 2 ? 2 : pz > WZ - 2 ? WZ - 2 : pz;
    }
    const kl = frame < 2 || resetTAA > 0 ? 1 : 1 - Math.exp(-dt * 9); lx += (fx - lx) * kl; ly += (fy - ly) * kl; lz += (fz - lz) * kl;
    const ll = 1 / Math.sqrt(lx * lx + ly * ly + lz * lz + 1e-9);
    const tanY = FOVT, tanX = FOVT * W / H, ji = (frame & 15) * 2;
    ub[0] = px; ub[1] = py; ub[2] = pz; ub[3] = time;
    ub[4] = rx * tanX; ub[5] = ry * tanX; ub[6] = rz * tanX; ub[7] = jit[ji];
    ub[8] = ux * tanY; ub[9] = uy * tanY; ub[10] = uz * tanY; ub[11] = jit[ji + 1];
    ub[12] = fx; ub[13] = fy; ub[14] = fz; ub[15] = frame & 1023;
    ub[16] = W; ub[17] = H; ub[18] = 1 / W; ub[19] = 1 / H;
    ub[20] = ppx; ub[21] = ppy; ub[22] = ppz; ub[23] = dt;
    ub[24] = prx; ub[25] = pry; ub[26] = prz; ub[28] = pux; ub[29] = puy; ub[30] = puz; ub[32] = pfx; ub[33] = pfy; ub[34] = pfz;
    ub[36] = px + rx * 0.24 - ux * 0.17 + fx * 0.05; ub[37] = py + ry * 0.24 - uy * 0.17 + fy * 0.05; ub[38] = pz + rz * 0.24 - uz * 0.17 + fz * 0.05; ub[39] = lampI * lampOn;
    ub[40] = lx * ll; ub[41] = ly * ll; ub[42] = lz * ll; ub[43] = crys.length;
    ub[44] = selectLights(); ub[45] = resetTAA > 0 ? 1 : 0; ub[46] = debug; ub[47] = NPOOL;
    if (resetTAA > 0) resetTAA--;
    device.queue.writeBuffer(ubuf, 0, ub);
    fu[0] = W; fu[1] = H; fu[2] = 1 / W; fu[3] = 1 / H; fu[4] = EXPO; fu[5] = frame & 255; fu[6] = 0.42; fu[7] = 0.05;
    device.queue.writeBuffer(fubuf, 0, fu);
    ppx = px; ppy = py; ppz = pz; prx = rx / tanX; pry = ry / tanX; prz = rz / tanX; pux = ux / tanY; puy = uy / tanY; puz = uz / tanY; pfx = fx; pfy = fy; pfz = fz;

    const enc = device.createCommandEncoder(), cur = frame & 1;
    let p = enc.beginRenderPass(mainPass); p.setPipeline(pMain); p.setBindGroup(0, sceneBG); p.draw(3); p.end();
    p = enc.beginRenderPass(taaPass[cur]); p.setPipeline(pTaa); p.setBindGroup(0, taaBG[cur]); p.draw(3); p.end();
    p = enc.beginRenderPass(partPass); p.setPipeline(pPart); p.setBindGroup(0, sceneBG); p.setBindGroup(1, depBG); p.draw(4, ND + NM + NR + NF + NBU); p.end();
    for (let i = 0; i < NBL; i++) { p = enc.beginRenderPass(downPass[i]); p.setPipeline(pDown); p.setBindGroup(0, downBG[i]); p.draw(3); p.end(); }
    for (let i = NBL - 2; i >= 0; i--) { p = enc.beginRenderPass(upPass[i]); p.setPipeline(pUp); p.setBindGroup(0, upBG[i]); p.draw(3); p.end(); }
    finalPass.colorAttachments[0].view = ctx.getCurrentTexture().createView();
    p = enc.beginRenderPass(finalPass); p.setPipeline(pFinal); p.setBindGroup(0, finalBG); p.draw(3); p.end();
    let ri = -1;
    if (qs) { for (let i = 0; i < NRB; i++) if (rbFree[i]) { ri = i; break; } if (ri < 0) tsSkip++; if (ri >= 0) { enc.resolveQuerySet(qs, 0, 2, tsResolve, 0); enc.copyBufferToBuffer(tsResolve, 0, rb[ri], 0, 16); } }
    cmds[0] = enc.finish(); device.queue.submit(cmds);
    if (ri >= 0) { rbFree[ri] = 0; rbT[ri] = tourT; rb[ri].mapAsync(GPUMapMode.READ).then(rbCb[ri]); if (BENCH) device.queue.onSubmittedWorkDone(); }
    frame++;
  }

  let hudT = 0, fpsAcc = 0, fpsCnt = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    const dtr = (now - last) * 0.001; last = now;
    const dt = dtr > 0.1 ? 0.1 : dtr < 0 ? 0 : dtr;
    if (BENCH) {
      if (benchState == 0) { if (now - benchT0 > 2500) { benchState = 1; benchT0 = now; tourT = 0; } }
      else if (benchState == 1) { tourT = (now - benchT0) * 0.001; if (bN < BN) bDt[bN++] = dtr * 1000; if (tourT >= TOUR) { benchState = 2; finishBench(); } }
    } else if (tour && !FREEZE) { tourT += dt; if (tourT > TOUR + 1.5) tourT = 0; }
    step(dt);
    window.__frames = frame; window.__gpu = gpuMs;
    if (hudOn) { fpsAcc += dtr; fpsCnt++; if (now - hudT > 500) { hudT = now; hud.textContent = (fpsCnt / fpsAcc).toFixed(0) + ' fps   ' + (gpuCnt ? (gpuAcc / gpuCnt).toFixed(2) + ' ms gpu   ' : '') + W + 'x' + H + '   pos ' + px.toFixed(1) + ' ' + py.toFixed(1) + ' ' + pz.toFixed(1) + (tour ? '   tour ' + tourT.toFixed(1) + 's' : ''); fpsAcc = fpsCnt = gpuAcc = gpuCnt = 0; } }
  }
  function finishBench() {
    const st = a => { const s = Array.from(a).sort((x, y) => x - y), n = s.length; return { n, avg: s.reduce((x, y) => x + y, 0) / n, p50: s[n >> 1], p99: s[Math.min(n - 1, Math.floor(n * 0.99))], max: s[n - 1] }; };
    const dt = bDt.subarray(1, bN), g = bGpu.subarray(0, bG), sd = st(dt), sg = bG ? st(g) : null;
    let over = 0, worstAt = 0, acc = 0, w = 0; for (let i = 0; i < dt.length; i++) { acc += dt[i]; if (dt[i] > 16.7) over++; if (dt[i] > w) { w = dt[i]; worstAt = acc / 1000; } }
    let gover = 0; for (let i = 0; i < g.length; i++) if (g[i] > 16.7) gover++;
    const sec = []; for (let s = 0; s < TOUR; s++) sec.push([0, 0, 0]); for (let i = 0; i < g.length; i++) { const s = sec[Math.min(TOUR - 1, Math.floor(bGT[i]))]; s[0] += g[i]; s[1]++; s[2] = Math.max(s[2], g[i]); }
    window.__benchSec = sec.map(s => [+(s[0] / Math.max(1, s[1])).toFixed(2), +s[2].toFixed(2)]);
    window.__bench = { res: W + 'x' + H, frames: dt.length, fps: 1000 / sd.avg, frame: sd, gpu: sg, framesOver16_7: over, gpuOver16_7: gover, worstFrameAtSec: worstAt, seconds: TOUR, tsN, tsSkip };
    hud.textContent = JSON.stringify(window.__bench); console.log('BENCH ' + JSON.stringify(window.__bench));
  }

  // ------------------------------------------------------------------ input
  addEventListener('keydown', e => {
    if (e.keyCode < 256) keys[e.keyCode] = 1;
    if (e.code == 'KeyL') lampOn = 1 - lampOn; else if (e.code == 'KeyT') { tour = 1 - tour; tourT = 0; } else if (e.code == 'KeyP') { hudOn = 1 - hudOn; hud.style.display = hudOn ? 'block' : 'none'; } else if (e.code == 'KeyH') helpEl.style.display = helpEl.style.display == 'none' ? 'block' : 'none';
    if (e.code == 'Space' || e.code == 'Tab') e.preventDefault();
  });
  addEventListener('keyup', e => { if (e.keyCode < 256) keys[e.keyCode] = 0; });
  addEventListener('blur', () => keys.fill(0));
  canvas.addEventListener('click', () => { if (document.pointerLockElement != canvas) canvas.requestPointerLock(); });
  document.addEventListener('pointerlockchange', () => { helpEl.style.opacity = document.pointerLockElement == canvas ? 0 : 1; });
  addEventListener('mousemove', e => { if (document.pointerLockElement == canvas) { mdx += e.movementX; mdy += e.movementY; } });
  addEventListener('wheel', e => { speed = Math.min(40, Math.max(0.5, speed * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); }, { passive: true });

  hud.style.display = hudOn ? 'block' : 'none';
  resize();
  ldEl.style.display = 'none';
  if (CAP) {
    helpEl.style.display = 'none';
    // deterministic capture: render n sub-frames ending at tour time t
    tour = Q.has('free') || Q.has('pose') || Q.has('cam') ? 0 : 1;
    window.__cap = async (t, n, dts) => { for (let i = n - 1; i >= 0; i--) { tourT = Math.max(0, t - i * dts); step(dts); } await device.queue.onSubmittedWorkDone(); return frame; };
  } else { last = benchT0 = performance.now(); requestAnimationFrame(loop); }
  window.__ready = true;
}
main().catch(e => { console.error('FATAL ' + (e && e.stack || e)); });
