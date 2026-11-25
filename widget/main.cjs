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
// In Electron 45 the switch above comes too late: the panel still connected to Wayland
// (checked on Ubuntu 24.04 / GNOME 46), where always-on-top is ignored. Only a real
// --ozone-platform=x11 on the command line works, and `agent-deck widget` and autostart
// pass it. If the panel was started some other way, start it again once with the flag.
const relaunching = process.platform === 'linux' && !process.env.AGENT_DECK_WAYLAND
  && !process.env.AGENT_DECK_RELAUNCHED && !process.argv.some((a) => a.startsWith('--ozone-platform'));
if (relaunching) {
  // app.relaunch() does nothing when called before "ready", so start the new process directly.
  const env = { ...process.env, AGENT_DECK_RELAUNCHED: '1' }; // never relaunches twice
  require('node:child_process').spawn(process.execPath, [...process.argv.slice(1), '--ozone-platform=x11'], { detached: true, stdio: 'inherit', env }).unref();
  app.exit(0);
}
// On Ubuntu 24.04+ the separate GPU process crashes inside its sandbox (Mesa can't open
// dri_gbm.so), and then the window is never drawn, so it never appears. Running the
// GPU work inside the main process avoids that; the renderer sandbox stays on.
if (process.platform === 'linux' && !process.env.AGENT_DECK_GPU) {
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  app.commandLine.appendSwitch('in-process-gpu');
}
// A small panel doesn't need the GPU, and on Ubuntu the GPU process often can't load
// the Mesa driver from inside Chromium's sandbox, which leaves the window blank or
// invisible. Software rendering is the safe default on Linux (AGENT_DECK_GPU=1 to opt in).
if (process.env.AGENT_DECK_NO_GPU || (process.platform === 'linux' && !process.env.AGENT_DECK_GPU)) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
}

const WIDTH = 360;
let win = null;
let config = null; // module from ../src/config.mjs

if (!relaunching && !app.requestSingleInstanceLock()) { app.quit(); }
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
    // GNOME (mutter) often ignores the position a new X11 window asks for and places it
    // itself, so move it to the saved (or default) spot once it is on screen.
    if (process.platform === 'linux') setTimeout(() => { if (!win.isDestroyed()) win.setPosition(pos.x, pos.y); }, 250);
    console.log(`[agent-deck] window shown (${why}) at ${JSON.stringify(win.getBounds())}; displays: ${JSON.stringify(screen.getAllDisplays().map((d) => ({ bounds: d.bounds, workArea: d.workArea, scale: d.scaleFactor })))}`);
  };
  win.once('ready-to-show', () => reveal('ready'));
  win.webContents.once('did-finish-load', () => setTimeout(() => reveal('loaded'), 300));
  setTimeout(() => reveal('timer'), 2500);
  win.webContents.on('render-process-gone', (_e, d) => console.log('[agent-deck] renderer gone: ' + JSON.stringify(d)));
  win.webContents.on('console-message', (e) => { if (e.level === 'warning' || e.level === 'error') console.log('[agent-deck] page: ' + e.message); });

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

if (!relaunching) app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
