// Agent Deck panel: a small frameless window that stays on top of everything.
const { app, BrowserWindow, ipcMain, screen, Notification, nativeImage, Tray, Menu, globalShortcut, nativeTheme, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
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
const LEVEL = process.platform === 'darwin' ? 'floating' : 'screen-saver';
let win = null;
let config = null; // module from ../src/config.mjs
let tray = null;
let approvals = true;     // mirrors the shield button and the tray checkbox
let shortcutKey = null;   // accelerator registered with globalShortcut, if any
let placed = false;       // true once our own first placement is over; later moves are the user's

if (!relaunching && !app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => showPanel());

// ---------- show / hide (tray, shortcut, `agent-deck toggle`) ----------
function showPanel() {
  if (!win || win.isDestroyed()) return;
  if (process.platform === 'linux') win.show(); else win.showInactive();
  win.setAlwaysOnTop(true, LEVEL);
  if (!placed) setTimeout(() => { placed = true; }, 1000); // ignore the window manager's first placement
  config?.saveConfig({ panelHidden: false });
  updateTray();
}
function hidePanel() {
  if (!win || win.isDestroyed()) return;
  win.hide();
  config?.saveConfig({ panelHidden: true });
  updateTray();
}
const togglePanel = () => (win && !win.isDestroyed() && win.isVisible() ? hidePanel() : showPanel());

function setApprovals(enabled, fromTray) {
  approvals = Boolean(enabled);
  config.saveConfig({ approvalsInWidget: approvals });
  if (fromTray && win && !win.isDestroyed()) win.webContents.send('approvals', approvals);
  updateTray();
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 22, height: 22 }));
    tray.setToolTip('Agent Deck');
    tray.on('click', togglePanel); // where the desktop supports clicks; the menu works everywhere
    updateTray();
  } catch (e) {
    tray = null;
    console.log('[agent-deck] no tray icon: ' + e.message);
  }
}
function updateTray() {
  if (!tray) return;
  const visible = Boolean(win && !win.isDestroyed() && win.isVisible());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: visible ? 'Hide panel' : 'Show panel', click: togglePanel },
    { label: 'Answer approvals here', type: 'checkbox', checked: approvals, click: (item) => setApprovals(item.checked, true) },
    { label: 'Notifications', type: 'checkbox', checked: config?.loadConfig().notifications !== false, click: (item) => { config.saveConfig({ notifications: item.checked }); updateTray(); } },
    { type: 'separator' },
    { label: 'Quit Agent Deck', click: () => app.quit() },
  ]));
}

// The panel grabs its shortcut itself unless GNOME runs it (`agent-deck shortcut`): with
// both, one key press would toggle twice. Under GNOME Wayland a grab by this XWayland
// window only fires while another X11 window has focus, hence the GNOME binding.
function applyShortcut(cfg) {
  const want = cfg.shortcutVia === 'gnome' || !cfg.shortcut ? null : cfg.shortcut;
  if (want === shortcutKey) return;
  if (shortcutKey) globalShortcut.unregister(shortcutKey);
  shortcutKey = null;
  if (!want) return;
  try {
    if (globalShortcut.register(want, togglePanel)) shortcutKey = want;
    else console.log(`[agent-deck] shortcut ${want} is already taken`);
  } catch (e) { console.log(`[agent-deck] shortcut ${want}: ${e.message}`); }
}

// `agent-deck toggle|show|hide` talk to the running panel over this socket.
function startControlSocket() {
  const sock = path.join(config.HOME, 'panel.sock');
  try { fs.unlinkSync(sock); } catch {}
  const srv = net.createServer((c) => {
    c.setEncoding('utf8');
    c.on('error', () => {});
    c.once('data', (d) => {
      const cmd = String(d).trim();
      if (cmd === 'toggle') togglePanel(); else if (cmd === 'show') showPanel(); else if (cmd === 'hide') hidePanel();
      c.end(win && !win.isDestroyed() && win.isVisible() ? 'shown\n' : 'hidden\n');
    });
  });
  srv.on('error', (e) => console.log('[agent-deck] control socket: ' + e.message));
  srv.listen(sock, () => { try { fs.chmodSync(sock, 0o600); } catch {} });
  app.on('will-quit', () => { srv.close(); try { fs.unlinkSync(sock); } catch {} });
}
app.on('will-quit', () => globalShortcut.unregisterAll());

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
  applyTheme(cfg.theme);

  win = new BrowserWindow({
    width: WIDTH, height: 140, x: pos.x, y: pos.y,
    // resizable must stay true: some Linux window managers ignore setSize on fixed-size windows.
    // Width is pinned with min/max instead; height follows the content.
    frame: false, resizable: true, maximizable: false, minimizable: false, fullscreenable: false,
    minWidth: WIDTH, maxWidth: WIDTH,
    alwaysOnTop: true, skipTaskbar: true, show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? BG.dark : BG.light, hasShadow: true, title: 'Agent Deck',
    icon: nativeImage.createFromPath(path.join(__dirname, 'icon.png')),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, LEVEL);
  if (process.platform === 'darwin') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    app.dock?.hide();
  }
  win.loadFile(path.join(__dirname, 'index.html'));
  win.on('show', updateTray);
  win.on('hide', updateTray);

  approvals = cfg.approvalsInWidget !== false;
  createTray();
  applyShortcut(cfg);
  startControlSocket();
  // Stay hidden if it was hidden when it last closed, but only with a way to bring it back.
  const startHidden = cfg.panelHidden && Boolean(tray || shortcutKey || cfg.shortcutVia === 'gnome');

  // Show once the page is ready; fall back to a timer because some Linux setups never
  // fire ready-to-show for a hidden frameless window. showInactive() doesn't map the
  // window under GNOME, so Linux uses a normal show() (in showPanel).
  let shown = false;
  const reveal = (why) => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    if (startHidden) { console.log('[agent-deck] starting hidden (tray, shortcut or "agent-deck show" brings it back)'); return; }
    showPanel();
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

  // Remember where the panel was dragged. 'moved' only exists on macOS and Windows, so use
  // 'move' (fires repeatedly while dragging) and save once it settles.
  let moveTimer = null;
  win.on('move', () => {
    if (!placed) return;
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => { const [x, y] = win.getPosition(); config.saveConfig({ window: { x, y } }); }, 400);
  });

  // Pick up hubs added with "agent-deck add-hub" (and `agent-deck shortcut`) without a restart.
  fs.watchFile(config.CONFIG_PATH, { interval: 2000 }, () => {
    applyShortcut(config.loadConfig());
    if (win && !win.isDestroyed()) win.webContents.send('config-changed', rendererConfig());
  });
}

function rendererConfig() {
  const cfg = config.loadConfig();
  return {
    hubs: hubsFor(cfg), approvalsInWidget: cfg.approvalsInWidget !== false, platform: process.platform,
    notifyAfterSeconds: Number(cfg.notifyAfterSeconds) || 30, holdSeconds: Number(cfg.holdSeconds) || 300,
    notifications: cfg.notifications !== false, contextWarnPercent: Number(cfg.contextWarnPercent) || 80,
    theme: cfg.theme || 'system', shortcut: cfg.shortcut || '', shortcutVia: cfg.shortcutVia || null,
  };
}

// Theme: Electron's themeSource also drives prefers-color-scheme inside the page.
const BG = { dark: '#111315', light: '#f4f5f7' };
function applyTheme(theme) {
  nativeTheme.themeSource = theme === 'light' || theme === 'dark' ? theme : 'system';
  if (win && !win.isDestroyed()) win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? BG.dark : BG.light);
}

// Settings view in the panel: only these keys, only these values.
const SETTINGS = {
  approvalsInWidget: (v) => typeof v === 'boolean',
  holdSeconds: (v) => [60, 120, 300, 540].includes(v),
  notifications: (v) => typeof v === 'boolean',
  notifyAfterSeconds: (v) => [10, 30, 60, 120].includes(v),
  contextWarnPercent: (v) => [70, 80, 90].includes(v),
  theme: (v) => ['system', 'dark', 'light'].includes(v),
};
ipcMain.on('save-settings', (_e, patch) => {
  const clean = {};
  for (const [k, v] of Object.entries(patch || {})) if (SETTINGS[k]?.(v)) clean[k] = v;
  if ('approvalsInWidget' in clean) { setApprovals(clean.approvalsInWidget, false); delete clean.approvalsInWidget; }
  if (Object.keys(clean).length) config.saveConfig(clean);
  if ('theme' in clean) applyTheme(clean.theme);
  updateTray();
});

ipcMain.handle('config', () => rendererConfig());

ipcMain.on('resize', (_e, height) => {
  if (!win || win.isDestroyed()) return;
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  const h = Math.max(48, Math.min(Math.ceil(height), Math.floor(area.height * 0.85)));
  const [, cur] = win.getSize();
  // setSize, not setBounds: a height change should never write a (possibly stale) position back.
  if (cur !== h) win.setSize(WIDTH, h);
});

ipcMain.on('set-approvals', (_e, enabled) => setApprovals(enabled, false));

// Notifications from the renderer. Clicking one shows the panel and jumps to the session.
const liveNotifications = new Set(); // keep references, or a click can't reach a collected object
ipcMain.on('notify', (_e, { title, body, target }) => {
  if (config.loadConfig().notifications === false || !Notification.isSupported()) return;
  title = String(title).slice(0, 80);
  body = String(body).slice(0, 200);
  console.log(`[agent-deck] notify: ${title} | ${body}`);
  const n = new Notification({ title, body, silent: false });
  liveNotifications.add(n);
  const done = () => liveNotifications.delete(n);
  n.on('close', done);
  n.on('click', () => {
    done();
    showPanel();
    if (target && win && !win.isDestroyed()) win.webContents.send('jump', target);
  });
  n.show();
});

// Links from service agents (a Chat thread, an email) open in the browser: web links only.
ipcMain.on('open-link', (_e, url) => {
  let u;
  try { u = new URL(String(url)); } catch { return; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return;
  console.log(`[agent-deck] open link: ${u.origin}${process.env.AGENT_DECK_NO_OPEN ? ' (not opened: AGENT_DECK_NO_OPEN)' : ''}`);
  if (!process.env.AGENT_DECK_NO_OPEN) shell.openExternal(u.href);
});

ipcMain.on('quit', () => app.quit());
ipcMain.on('minimize', () => win && win.minimize());

if (!relaunching) app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
