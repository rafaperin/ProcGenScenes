// 60 s scripted fly-through benchmark at native resolution.  usage: node bench.mjs <html> [out.json]
import puppeteer from 'puppeteer';
import fs from 'fs';
const [html, out, extra = ''] = process.argv.slice(2);
const b = await puppeteer.launch({ headless: false, defaultViewport: null, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--ignore-gpu-blocklist', ...(process.env.UNCAP ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []), '--kiosk', '--window-position=1080,223', '--window-size=2560,1440', '--allow-file-access-from-files', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
const p = (await b.pages())[0];
p.on('console', m => { const t = m.text(); if (/ERR|FATAL|WGSL|clearance|TSBAD/.test(t)) console.log('[page]', t.slice(0, 400)); });
await p.goto('file://' + html + '?bench=1' + extra);
await p.bringToFront();
await p.waitForFunction('window.__bench', { timeout: 240000, polling: 500 });
const r = await p.evaluate(() => ({ b: window.__bench, sec: JSON.stringify(window.__benchSec), dpr: devicePixelRatio, iw: innerWidth, ih: innerHeight, ua: navigator.userAgent }));
console.log(JSON.stringify(r, null, 1));
if (out) fs.writeFileSync(out, JSON.stringify(r, null, 1));
await b.close();
