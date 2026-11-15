// static GPU cost at fixed views: node perf.mjs <html> q1 q2 ...
import puppeteer from 'puppeteer';
const [html, ...qs] = process.argv.slice(2);
const b = await puppeteer.launch({ headless: false, defaultViewport: { width: 2560, height: 1440 }, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--window-size=1280,720', '--allow-file-access-from-files'] });
const p = await b.newPage();
p.on('console', m => { const t = m.text(); if (/ERR|FATAL|WGSL/.test(t)) console.log('[page]', t.slice(0, 400)); });
for (const q of qs) {
  await p.goto('file://' + html + '?stats=1&' + q); await p.bringToFront();
  await p.waitForFunction('window.__ready===true', { timeout: 180000 });
  await new Promise(r => setTimeout(r, 1500));
  const v = await p.evaluate(async () => { let s = 0, n = 0, mx = 0; for (let i = 0; i < 60; i++) { await new Promise(r => requestAnimationFrame(r)); s += window.__gpu; n++; mx = Math.max(mx, window.__gpu); } return [s / n, mx, document.getElementById('c').width]; });
  console.log(q.padEnd(40), 'avg', v[0].toFixed(2), 'max', v[1].toFixed(2), 'w', v[2]);
}
await b.close();
