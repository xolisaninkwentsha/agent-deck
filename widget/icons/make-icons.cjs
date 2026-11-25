// Draw the tray and app icons from Bolt, the robot on the cards (BOLT_SVG in renderer.js, styled by
// style.css), so they always match the panel. Dev only; the PNGs are committed. Run from the repo:
//   node_modules/electron/dist/electron --ozone-platform=x11 widget/icons/make-icons.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const WIDGET = path.join(__dirname, '..');
const svg = /const BOLT_SVG = `([\s\S]*?)`;/.exec(fs.readFileSync(path.join(WIDGET, 'renderer.js'), 'utf8'))[1];
const css = fs.readFileSync(path.join(WIDGET, 'style.css'), 'utf8');

// A still frame of one state, at `size` px, on a transparent background or a navy plate.
function page(state, size, plate) {
  const inner = Math.round(size * (plate ? 0.78 : 1));
  return `<!doctype html><meta charset="utf-8"><style>${css}
    html, body { height: auto !important; width: ${size}px; margin: 0 !important; border: 0 !important; border-radius: 0 !important;
      background: transparent !important; background-image: none !important; display: block !important; overflow: hidden; }
    .m, .m * { animation: none !important; transition: none !important; }
    .m .fx-z { display: none !important; }
    .wrap { width: ${size}px; height: ${size}px; display: grid; place-items: center;
      ${plate ? `background: #163256; border-radius: ${Math.round(size * 0.22)}px;` : ''} }
    .m { width: ${inner}px; height: ${inner}px; }
  </style><div class="wrap"><div class="m" data-s="${state}" style="--tint:#c9d3e2">${svg}</div></div>`;
}

async function shoot(state, size, plate, out) {
  const w = new BrowserWindow({ width: size, height: size, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page(state, size, plate)));
  await new Promise((r) => setTimeout(r, 300));
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  fs.writeFileSync(out, img.toPNG());
  w.destroy();
  console.log('wrote', path.relative(process.cwd(), out));
}

app.on('window-all-closed', () => {}); // each shot closes its window; quit only when all are done
app.whenReady().then(async () => {
  for (const state of ['idle', 'working', 'needs', 'error']) await shoot(state, 44, false, path.join(__dirname, `tray-${state}.png`));
  await shoot('working', 256, true, path.join(WIDGET, 'icon.png'));
  app.quit();
});
