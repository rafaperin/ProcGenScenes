// Records the scripted 60 s fly-through deterministically.  usage: node record.mjs <html> <outdir> [fps=30] [w=1280] [h=720]
import puppeteer from 'puppeteer';
import fs from 'fs';
import { execSync } from 'child_process';
const [html, dir, fps = '30', w = '1280', h = '720'] = process.argv.slice(2);
fs.rmSync(dir + '/frames', { recursive: true, force: true }); fs.mkdirSync(dir + '/frames', { recursive: true });
const b = await puppeteer.launch({ headless: false, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan', '--ignore-gpu-blocklist', '--window-size=1280,720', '--allow-file-access-from-files'], defaultViewport: { width: +w, height: +h } });
const p = await b.newPage();
p.on('console', m => { const t = m.text(); if (/ERR|FATAL|WGSL/.test(t)) console.log('[page]', t.slice(0, 400)); });
await p.goto('file://' + html + '?cap=1');
await p.waitForFunction('window.__ready===true', { timeout: 180000 });
await p.evaluate(async () => { await window.__cap(0, 16, 1e-4); });
const N = 60 * +fps;
for (let f = 0; f <= N; f++) {
  await p.evaluate(async (t) => { await window.__cap(t, 6, 1 / 180); }, f / +fps);
  await p.screenshot({ path: `${dir}/frames/f${String(f).padStart(4, '0')}.jpg`, type: 'jpeg', quality: 90 });
  if (f % 300 == 0) console.log('frame', f, '/', N);
}
await b.close();
execSync(`ffmpeg -y -loglevel error -framerate ${fps} -i ${dir}/frames/f%04d.jpg -c:v libx264 -pix_fmt yuv420p -crf 18 ${dir}/flythrough.mp4`);
console.log('completed', N + 1, 'frames ->', dir + '/flythrough.mp4');
