'use strict';

// Generates assets/icon.png — the duck-with-sunglasses app/.exe icon — by
// rasterizing an SVG on a candy gradient tile via Electron (run with electron).
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const DUCK = `
<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="58" cy="86" rx="40" ry="29" fill="#FFC107"/>
  <circle cx="58" cy="54" r="36" fill="#FFD740"/>
  <path d="M52 18 q3 -12 11 -7 q2 5 -1 10 q-5 -3 -10 -3z" fill="#FFB300"/>
  <path d="M60 17 q5 -9 11 -2 q1 5 -3 9 q-4 -5 -8 -7z" fill="#FFC107"/>
  <path d="M86 58 q23 -1 28 7 q-4 9 -28 8 q-7 -8 0 -15z" fill="#FF7A1A"/>
  <path d="M88 67 q21 0 26 3 q-5 6 -26 5z" fill="#E85D04"/>
  <path d="M26 46 h54 q7 0 7 7 q0 3 -4 3 h-3 q-1 0 -2 2 q-3 12 -15 12 q-12 0 -14 -12 q0 -2 -3 -2 q-3 0 -3 2 q-2 12 -14 12 q-12 0 -15 -12 q-1 -2 -2 -2 h-1 q-4 0 -4 -4 q0 -6 7 -6z" fill="#16121f"/>
  <circle cx="34" cy="55" r="4" fill="#18e0ff"/>
  <circle cx="68" cy="55" r="4" fill="#ff2db5"/>
</svg>`;

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:512px;height:512px;overflow:hidden}
  .tile{width:512px;height:512px;border-radius:112px;
    background:linear-gradient(135deg,#ff9e7d,#e8b6d0 48%,#9dc3e6);
    display:flex;align-items:center;justify-content:center;
    box-shadow:inset 0 8px 40px rgba(255,255,255,.45);}
  .glow{position:absolute;width:300px;height:300px;border-radius:50%;
    background:radial-gradient(circle,rgba(255,255,255,.5),transparent 70%);top:40px}
  .duck{width:330px;height:330px;filter:drop-shadow(0 14px 26px rgba(0,0,0,.35));position:relative}
  .duck svg{width:100%;height:100%}
</style></head><body>
  <div class="tile"><div class="glow"></div><div class="duck">${DUCK}</div></div>
</body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, frame: false,
    webPreferences: { offscreen: false } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML));
  await new Promise((r) => setTimeout(r, 600));
  const img = await win.webContents.capturePage();
  const out = path.join(__dirname, '..', 'assets', 'icon.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, img.toPNG());
  console.log('wrote', out);
  app.quit();
});
