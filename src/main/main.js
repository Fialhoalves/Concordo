'use strict';
const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('node:path');
const { createConcordoServer } = require('../server');
const tunnel = require('./tunnel');

const PROTOCOL = 'concordo';

let mainWindow = null;
let pendingDeepLink = null;
let host = null; // { server, tunnel, publicUrl, tunnelState, tunnelMessage, owner }
let updater = null;

// ---------- utilidades ----------
function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function isHttpUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function openExternalSafe(url) {
  if (isHttpUrl(url)) shell.openExternal(url);
}

function findDeepLink(argv) {
  return argv.find((a) => typeof a === 'string' && a.startsWith(PROTOCOL + '://')) || null;
}

function deliverDeepLink(link) {
  if (!link) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    send('deeplink', link);
  } else {
    pendingDeepLink = link;
  }
}

// ---------- janela ----------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 820,
    minHeight: 520,
    backgroundColor: '#16171b',
    title: 'Concordo',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      openExternalSafe(url);
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------- anfitrião (servidor + túnel) ----------
function hostSnapshot() {
  if (!host) return null;
  return {
    localUrl: host.server.localUrl,
    publicUrl: host.publicUrl,
    token: host.owner.token,
    user: host.server.store.publicUser(host.owner),
    room: host.server.store.room,
    tunnelState: host.tunnelState,
    tunnelMessage: host.tunnelMessage,
  };
}

function setTunnelState(state, message = '') {
  if (!host) return;
  host.tunnelState = state;
  host.tunnelMessage = message;
  send('host:status', { state, message, publicUrl: host.publicUrl });
}

async function openTunnel() {
  if (!host) return;
  const dataDirs = {
    resourcesPath: process.resourcesPath,
    devDir: path.join(__dirname, '..', '..', 'build', 'bin'),
    userDir: path.join(app.getPath('userData'), 'bin'),
  };
  try {
    setTunnelState('starting', 'Abrindo o túnel…');
    let bin = tunnel.findBinary(dataDirs);
    if (!bin) {
      setTunnelState('downloading', 'Baixando o cloudflared (só na primeira vez)…');
      bin = await tunnel.download(path.join(dataDirs.userDir, tunnel.binaryName()));
      setTunnelState('starting', 'Abrindo o túnel…');
    }
    const current = host;
    const t = await tunnel.startTunnel({
      binPath: bin,
      port: current.server.port,
      onExit: (code) => {
        if (host === current && current.tunnel) {
          current.tunnel = null;
          current.publicUrl = null;
          setTunnelState('error', `O túnel caiu (código ${code}). Tente de novo.`);
        }
      },
    });
    if (host !== current) {
      t.stop();
      return;
    }
    current.tunnel = t;
    current.publicUrl = t.url;
    setTunnelState('ready', '');
  } catch (e) {
    if (host) {
      host.publicUrl = null;
      setTunnelState('error', e.message);
    }
  }
}

async function stopHost() {
  if (!host) return;
  const current = host;
  host = null;
  if (current.tunnel) current.tunnel.stop();
  await current.server.close().catch(() => {});
}

ipcMain.handle('host:start', async (_event, opts = {}) => {
  if (!host) {
    const server = await createConcordoServer({
      dataDir: path.join(app.getPath('userData'), 'host-data'),
      roomName: opts.roomName,
      ownerName: opts.nickname || 'Anfitrião',
      getPublicUrl: () => (host ? host.publicUrl : null),
      version: app.getVersion(),
    });
    host = {
      server,
      owner: server.owner,
      tunnel: null,
      publicUrl: null,
      tunnelState: 'starting',
      tunnelMessage: '',
    };
    openTunnel(); // em segundo plano; a interface acompanha por 'host:status'
  }
  return hostSnapshot();
});

ipcMain.handle('host:info', () => hostSnapshot());

ipcMain.handle('host:retry-tunnel', async () => {
  if (host && !host.tunnel) await openTunnel();
  return hostSnapshot();
});

ipcMain.handle('host:stop', async () => {
  await stopHost();
  return true;
});

// ---------- outros IPCs ----------
ipcMain.handle('app:info', () => ({ version: app.getVersion(), packaged: app.isPackaged }));

ipcMain.handle('app:open-external', (_event, url) => {
  openExternalSafe(url);
});

ipcMain.handle('app:download', (_event, url) => {
  if (isHttpUrl(url) && mainWindow) mainWindow.webContents.downloadURL(url);
});

ipcMain.handle('app:take-deeplink', () => {
  const link = pendingDeepLink;
  pendingDeepLink = null;
  return link;
});

ipcMain.handle('update:install', () => {
  if (updater) updater.quitAndInstall();
});

// ---------- atualização automática (GitHub Releases) ----------
function setupUpdater() {
  if (!app.isPackaged) return;
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch (e) {
    console.error('[concordo] electron-updater indisponível:', e.message);
    return;
  }
  updater.autoDownload = true;
  updater.on('update-available', (info) => send('update:status', { state: 'downloading', version: info.version }));
  updater.on('update-downloaded', (info) => send('update:status', { state: 'downloaded', version: info.version }));
  updater.on('error', (err) => console.error('[concordo] updater:', err && err.message));
  const check = () => updater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 6 * 60 * 60 * 1000).unref();
}

// ---------- ciclo de vida ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  pendingDeepLink = findDeepLink(process.argv);

  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    deliverDeepLink(findDeepLink(argv));
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    deliverDeepLink(url);
  });

  app.whenReady().then(() => {
    if (app.isPackaged) {
      Menu.setApplicationMenu(null);
      app.setAsDefaultProtocolClient(PROTOCOL);
    }
    createWindow();
    setupUpdater();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  let cleaningUp = false;
  app.on('before-quit', (event) => {
    if (cleaningUp || !host) return;
    event.preventDefault();
    cleaningUp = true;
    stopHost().finally(() => app.quit());
  });
}
