// Builds the single-file deliverable: ../index.html  (node build.mjs)
import fs from 'fs';
import { transformSync } from 'esbuild';
const src = new URL('../src/', import.meta.url).pathname;
let js = ['01_gen.js', '02_bake.js', '03_render.js', '04_main.js'].map(f => fs.readFileSync(src + f, 'utf8')).join('\n');
// minify WGSL template literals (keep ${...} interpolations intact)
const minW = s => s.split(/(\$\{(?:[^{}]|\{[^{}]*\})*\})/).map((part, i) => i & 1 ? part : part
  .replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ')
  .replace(/ ?([{}();,:=+*/<>|&!\[\]]) ?/g, '$1').replace(/ ?(-) ?(?=[^-])/g, (m, a, off, str) => /[\w.)\]] ?- ?$/.test(str.slice(Math.max(0, off - 2), off + m.length)) ? m.trim() : m)).join('');
js = js.replace(/\/\*wgsl\*\/`([^`]*)`/g, (m, body) => '`' + minW(body).trim() + '`');
const out = transformSync('(()=>{' + js + '})();', { minify: true, target: 'es2022', legalComments: 'none' }).code.trim();
let html = fs.readFileSync(src + 'dev.html', 'utf8');
html = html.replace(/<!--JS-->[\s\S]*<!--\/JS-->/, () => '<script>' + out + '</script>').replace(/\n\s*/g, '\n').replace(/>\n</g, '><');
fs.writeFileSync(new URL('../index.html', import.meta.url), html);
console.log('index.html', Buffer.byteLength(html), 'bytes;  js', out.length);
