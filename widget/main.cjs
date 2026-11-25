// Agent Deck panel: a small frameless window that stays on top of everything.
const { app, BrowserWindow, ipcMain, screen, Notification, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

// Ubuntu's default Wayland session doesn't let apps keep themselves on top.
// Running through XWayland does, so prefer X11 unless asked otherwise.
if (process.platform === 'linux' && !process.env.AGENT_DECK_WAYLAND) {
  app.commandLine.appendSwitch('ozone-platform', 'x11');
}
if (process.env.AGENT_DECK_NO_GPU) app.disableHardwareAcceleration();

const WIDTH = 360;
let win = null;
let config = null; // module from ../src/config.mjs

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });

function hubsFor(cfg) {
  const local = { name: config.machineName(cfg), url: `ws://127.0.0.1:${cfg.port}/ws`, token: null, local: true };
  const remotes = (cfg.hubs || []).map((h) => ({ name: h.name, url: h.url.replace(/\/?$/, '').replace(/\/ws$/, '') + '/ws', token: h.token || null, local: false }));
  return [local, ...remotes];
}

function startPosition(cfg) {
  const area = screen.getPrimaryDisplay().workArea;
  const saved = process.argv.includes('--reset-position') ? null : cfg.window;
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return saved.x >= a.x - 50 && saved.x < a.x + a.width - 50 && saved.y >= a.y - 10 && saved.y < a.y + a.height - 40;
    });
    if (visible) return saved;
  }
  return { x: area.x + area.width - WIDTH - 16, y: area.y + 16 };
}

async function createWindow() {
  config = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'config.mjs')).href);
  const cfg = config.loadConfig();
  const pos = startPosition(cfg);

  win = new BrowserWindow({
    width: WIDTH, height: 140, x: pos.x, y: pos.y,
    // resizable must stay true: some Linux window managers ignore setSize on fixed-size windows.
    // Width is pinned with min/max instead; height follows the content.
    frame: false, resizable: true, maximizable: false, minimizable: false, fullscreenable: false,
    minWidth: WIDTH, maxWidth: WIDTH,
    alwaysOnTop: true, skipTaskbar: true, show: false,
    backgroundColor: '#111315', hasShadow: true, title: 'Agent Deck',
    icon: nativeImage.createFromPath(path.join(__dirname, 'icon.png')),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'screen-saver');
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    app.dock?.hide();
  }
  win.loadFile(path.join(__dirname, 'index.html'));

  // Show once the page is ready; fall back to a timer because some Linux setups never
  // fire ready-to-show for a hidden frameless window. showInactive() doesn't map the
  // window under GNOME, so Linux uses a normal show().
  let shown = false;
  const reveal = (why) => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    if (process.platform === 'linux') win.show(); else win.showInactive();
    win.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'screen-saver');
    console.log(`[agent-deck] window shown (${why}) at ${JSON.stringify(win.getBounds())}; displays: ${JSON.stringify(screen.getAllDisplays().map((d) => ({ bounds: d.bounds, workArea: d.workArea, scale: d.scaleFactor })))}`);
  };
  win.once('ready-to-show', () => reveal('ready'));
  win.webContents.once('did-finish-load', () => setTimeout(() => reveal('loaded'), 300));
  setTimeout(() => reveal('timer'), 2500);
  win.webContents.on('render-process-gone', (_e, d) => console.log('[agent-deck] renderer gone: ' + JSON.stringify(d)));
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) console.log('[agent-deck] page: ' + message); });

  // Development aid: AGENT_DECK_SCREENSHOT=/path.png saves an image of the panel and quits.
  if (process.env.AGENT_DECK_SCREENSHOT) {
    if (process.env.AGENT_DECK_EVAL) {
      setTimeout(() => win.webContents.executeJavaScript(process.env.AGENT_DECK_EVAL).catch(() => {}), Number(process.env.AGENT_DECK_SCREENSHOT_DELAY || 3000) / 2);
    }
    setTimeout(async () => {
      const img = await win.webContents.capturePage();
      fs.writeFileSync(process.env.AGENT_DECK_SCREENSHOT, img.toPNG());
      app.quit();
    }, Number(process.env.AGENT_DECK_SCREENSHOT_DELAY || 3000));
  }

  let moveTimer = null;
  win.on('moved', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => { const [x, y] = win.getPosition(); config.saveConfig({ window: { x, y } }); }, 400);
  });

  // Pick up hubs added with "agent-deck add-hub" without a restart.
  fs.watchFile(config.CONFIG_PATH, { interval: 2000 }, () => {
    if (win && !win.isDestroyed()) win.webContents.send('config-changed', rendererConfig());
  });
}

function rendererConfig() {
  const cfg = config.loadConfig();
  return { hubs: hubsFor(cfg), approvalsInWidget: cfg.approvalsInWidget !== false, platform: process.platform };
}

ipcMain.handle('config', () => rendererConfig());

ipcMain.on('resize', (_e, height) => {
  if (!win || win.isDestroyed()) return;
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  const h = Math.max(48, Math.min(Math.ceil(height), Math.floor(area.height * 0.85)));
  const [, cur] = win.getSize();
  if (cur !== h) win.setBounds({ ...win.getBounds(), width: WIDTH, height: h });
});

ipcMain.on('set-approvals', (_e, enabled) => { config.saveConfig({ approvalsInWidget: Boolean(enabled) }); });

ipcMain.on('notify', (_e, { title, body }) => {
  if (Notification.isSupported()) new Notification({ title: String(title).slice(0, 80), body: String(body).slice(0, 200), silent: false }).show();
});

ipcMain.on('quit', () => app.quit());
ipcMain.on('minimize', () => win && win.minimize());

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
