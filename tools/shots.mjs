// usage: node shots.mjs <html> <outdir> [w h settle] -- name=query name=query ...
import puppeteer from 'puppeteer';
const a = process.argv.slice(2); const html = a[0], dir = a[1]; const i = a.indexOf('--');
const [w = '2560', h = '1440', settle = '80'] = a.slice(2, i);
const b = await puppeteer.launch({ headless: false, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--window-size=1280,720', '--window-position=40,40', '--allow-file-access-from-files'], defaultViewport: { width: +w, height: +h } });
for (const it of a.slice(i + 1)) {
  const k = it.indexOf('='), name = it.slice(0, k), q = it.slice(k + 1);
  const p = await b.newPage();
  p.on('console', m => { const t = m.text(); if (/ERR|FATAL|WGSL/.test(t)) console.log('[page]', t.slice(0, 500)); });
  p.on('pageerror', e => console.log('[pageerror]', e.message));
  await p.goto('file://' + html + '?cap=1&' + q);
  try {
    await p.waitForFunction('window.__ready===true', { timeout: 180000 });
    const m = /tt=([\d.]+)/.exec(q);
    await p.evaluate(async (n, t) => { for (let i = 0; i < n; i += 8) await window.__cap(t, 8, 1e-4); }, +settle, m ? +m[1] : 0);
    await p.screenshot({ path: `${dir}/${name}.png` });
  } catch (e) { console.log('ERR', name, e.message); }
  await p.close();
}
await b.close();
