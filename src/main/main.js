'use strict';
const { app, BrowserWindow, ipcMain, shell, Menu, Tray, nativeImage, dialog, session, desktopCapturer, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createConcordoServer } = require('../server');
const tunnel = require('./tunnel');
const backup = require('./backup');
const rendezvous = require('./rendezvous');

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

// ---------- endereço fixo (túnel nomeado da Cloudflare) ----------
const DEFAULT_FIXED_PORT = 47800;
const fixedConfigPath = () => path.join(app.getPath('userData'), 'tunnel-config.json');

function readFixedConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(fixedConfigPath(), 'utf8'));
    const url = tunnel.normalizeHostname(raw.hostname);
    if (!url || !raw.token) return null;
    const token = raw.enc ? safeStorage.decryptString(Buffer.from(raw.token, 'base64')) : raw.token;
    const port = Number.isInteger(raw.port) && raw.port > 1023 && raw.port < 65536 ? raw.port : DEFAULT_FIXED_PORT;
    return { url, token, port };
  } catch {
    return null;
  }
}

ipcMain.handle('tunnel:get-fixed', () => {
  const c = readFixedConfig();
  return c ? { hostname: c.url.replace('https://', ''), port: c.port } : null;
});

ipcMain.handle('tunnel:set-fixed', (_event, cfg = {}) => {
  const url = tunnel.normalizeHostname(cfg.hostname);
  if (!url) throw new Error('Endereço inválido. Use algo como chat.seudominio.com');
  const token = String(cfg.token || '').trim();
  const old = readFixedConfig();
  const finalToken = token || (old && old.url === url ? old.token : '');
  if (!/^[A-Za-z0-9+/=_-]{40,}$/.test(finalToken)) throw new Error('Token inválido. Cole o token inteiro do túnel (começa com "eyJ").');
  const port = parseInt(cfg.port, 10) || DEFAULT_FIXED_PORT;
  if (port < 1024 || port > 65535) throw new Error('Porta inválida (use entre 1024 e 65535).');
  const enc = safeStorage.isEncryptionAvailable();
  const stored = enc ? safeStorage.encryptString(finalToken).toString('base64') : finalToken;
  fs.writeFileSync(fixedConfigPath(), JSON.stringify({ hostname: url, token: stored, enc, port }), { mode: 0o600 });
  return { hostname: url.replace('https://', ''), port };
});

ipcMain.handle('tunnel:clear-fixed', () => {
  fs.rmSync(fixedConfigPath(), { force: true });
  return true;
});

// ---------- voz, vídeo e tela ----------
// Servidores STUN/TURN próprios: CONCORDO_ICE_SERVERS='[{"urls":"turn:host:3478","username":"u","credential":"p"}]'
function iceFromEnv() {
  const raw = process.env.CONCORDO_ICE_SERVERS;
  if (!raw) return undefined;
  try {
    const list = JSON.parse(raw);
    if (Array.isArray(list)) return list;
  } catch {
    /* ignora valor inválido */
  }
  console.warn('CONCORDO_ICE_SERVERS inválido; usando os servidores padrão.');
  return undefined;
}

const isAppPage = (url) => typeof url === 'string' && url.startsWith('file://');
const ALLOWED_PERMISSIONS = new Set(['media', 'display-capture', 'notifications', 'clipboard-sanitized-write', 'fullscreen']);

// A interface escolhe a tela no próprio seletor; o Electron só libera a captura da fonte escolhida.
let pendingScreen = null; // { id, audio, at }

function setupMedia() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && isAppPage(details && details.requestingUrl));
  });
  ses.setPermissionCheckHandler((wc, permission, origin, details) =>
    ALLOWED_PERMISSIONS.has(permission) && isAppPage((details && details.requestingUrl) || origin));

  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    const pending = pendingScreen;
    pendingScreen = null;
    if (!pending || Date.now() - pending.at > 30000) return callback({});
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const source = sources.find((x) => x.id === pending.id);
      if (!source) return callback({});
      callback(pending.audio ? { video: source, audio: 'loopback' } : { video: source });
    } catch {
      callback({});
    }
  });
}

ipcMain.handle('screen:sources', async () => {
  const own = mainWindow ? mainWindow.getMediaSourceId() : null;
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 480, height: 270 },
    fetchWindowIcons: true,
  });
  return sources
    .filter((x) => x.id !== own && x.name)
    .map((x) => ({ id: x.id, name: x.name, thumbnail: x.thumbnail.toDataURL(), icon: x.appIcon && !x.appIcon.isEmpty() ? x.appIcon.resize({ width: 20, height: 20 }).toDataURL() : null }));
});

ipcMain.handle('screen:prepare', (_event, sel) => {
  if (!sel || typeof sel.id !== 'string') throw new Error('fonte inválida');
  pendingScreen = { id: sel.id, audio: !!sel.audio, at: Date.now() };
});

// ---------- preferências do app e bandeja do sistema ----------
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() {
  const defaults = { closeToTray: true, autoStart: false };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch {
    return defaults;
  }
}
function writeSettings(next) {
  const cur = readSettings();
  const merged = {
    closeToTray: typeof next.closeToTray === 'boolean' ? next.closeToTray : cur.closeToTray,
    autoStart: typeof next.autoStart === 'boolean' ? next.autoStart : cur.autoStart,
  };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(merged));
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: merged.autoStart, args: merged.autoStart ? ['--hidden'] : [] });
  return merged;
}
ipcMain.handle('app:show-window', () => showWindow());

// Mensagens novas sem popup: contador vermelho no ícone da barra de tarefas, ícone piscando e dica na bandeja.
let badgeCount = 0;
ipcMain.handle('app:set-badge', (_event, args = {}) => {
  if (!mainWindow) return false;
  const n = Math.max(0, Math.min(999, Math.floor(Number(args.count)) || 0));
  if (process.platform === 'win32') {
    const icon = typeof args.icon === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]{1,20000}$/.test(args.icon) ? args.icon : null;
    try {
      mainWindow.setOverlayIcon(n && icon ? nativeImage.createFromDataURL(icon) : null, n ? `${n} mensagens não lidas` : '');
    } catch {
      /* sem ícone de sobreposição */
    }
  }
  if (n > badgeCount && !mainWindow.isFocused()) mainWindow.flashFrame(true);
  if (!n) mainWindow.flashFrame(false);
  badgeCount = n;
  if (tray) tray.setToolTip(n ? `Concordo · ${n} não lidas` : 'Concordo');
  return true;
});
ipcMain.handle('app:get-settings', () => readSettings());
ipcMain.handle('app:set-settings', (_event, next) => writeSettings(next || {}));

let tray = null;
let quitting = false;

function showWindow() {
  if (!mainWindow) return createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function confirmQuit() {
  if (!host) return true;
  const r = await dialog.showMessageBox(mainWindow || undefined, {
    type: 'warning',
    buttons: ['Cancelar', 'Sair e encerrar a sala'],
    defaultId: 0,
    cancelId: 0,
    title: 'Concordo',
    message: 'Você está hospedando a sala.',
    detail: 'Se sair agora, os amigos ficam sem a sala (o sucessor assume em instantes, se houver um).',
  });
  return r.response === 1;
}

function setupTray() {
  if (tray) return;
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 16, height: 16 });
    tray = new Tray(img);
  } catch (e) {
    console.error('[concordo] bandeja indisponível:', e.message);
    return;
  }
  tray.setToolTip('Concordo');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir o Concordo', click: showWindow },
    { type: 'separator' },
    { label: 'Sair do Concordo', click: async () => {
      if (await confirmQuit()) {
        quitting = true;
        app.quit();
      }
    } },
  ]));
  tray.on('click', showWindow);
}

// ---------- janela ----------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 820,
    minHeight: 520,
    backgroundColor: '#0f111a',
    title: 'Concordo',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    show: !process.argv.includes('--hidden'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // voz e vídeo continuam normais com a janela na bandeja
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
  mainWindow.on('close', (event) => {
    if (quitting || !tray || !readSettings().closeToTray) return;
    event.preventDefault();
    mainWindow.hide(); // sem aviso: o ícone na bandeja já mostra que o app continua aberto
  });
  mainWindow.on('focus', () => mainWindow && mainWindow.flashFrame(false));
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

// "A sala está de pé?": pergunta ao endereço se ele responde e é a mesma sala.
async function pingRoom(url, roomId) {
  if (!isHttpUrl(url)) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(`${url.replace(/\/+$/, '')}/api/ping`, { signal: ctl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    if (j.app !== 'concordo' || (roomId && j.roomId !== roomId)) return null;
    return j;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Lê o ponto de encontro e vê se alguém está mesmo respondendo lá.
async function lookPointer(rv, roomId) {
  if (!rv) return null;
  let p = null;
  try {
    p = await rendezvous.resolve(rv);
  } catch {
    return null;
  }
  if (!p) return null;
  const info = await pingRoom(p.url, roomId);
  return { ...p, alive: !!info, host: (info && info.host) || p.n || null, epoch: info && Number.isInteger(info.epoch) ? info.epoch : p.e };
}

// Quem manda quando dois hosts existem ao mesmo tempo: maior geração; na igualdade, o menor id de dono.
function losesTo(mine, other) {
  if (other.epoch !== mine.epoch) return other.epoch > mine.epoch;
  return !!other.o && other.o !== mine.owner && other.o < mine.owner;
}

async function supersede(current, pointer) {
  if (host !== current) return;
  host = null;
  if (current.watch) clearInterval(current.watch);
  if (current.tunnel) current.tunnel.stop();
  await current.server.close().catch(() => {});
  send('host:superseded', { url: pointer.url, host: pointer.host, epoch: pointer.epoch });
}

// Publica o endereço atual da sala no ponto de encontro (em segundo plano; falhar não atrapalha nada).
// Antes, confere se outro host já está de pé com geração maior: nesse caso este host se rende e vira membro.
async function publishAddress(current) {
  const store = current.server.store;
  const attempt = async () => {
    let rv = store.getRendezvous();
    if (!rv) {
      rv = await rendezvous.create();
      store.setRendezvous(rv);
    }
    if (host !== current || !current.publicUrl) return;
    const other = await lookPointer(rendezvous.format(rv), store.room.id);
    if (other && other.url !== current.publicUrl) {
      if (other.alive && losesTo({ epoch: store.epoch, owner: current.owner.id }, other)) {
        await supersede(current, other);
        return;
      }
      if (!other.alive && other.e >= store.epoch) store.bumpEpoch(other.e); // o host dessa geração sumiu: eu assumo uma acima
    }
    if (host !== current || !current.publicUrl) return;
    await rendezvous.publish(rv, current.publicUrl, { epoch: store.epoch, owner: current.owner.id, ownerName: current.owner.name });
    watchPointer(current, rv);
  };
  for (const wait of [0, 8000, 30000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    if (host !== current || !current.publicUrl) return;
    try {
      await attempt();
      return;
    } catch (e) {
      console.warn('[concordo] ponto de encontro:', e.message);
    }
  }
}

// Enquanto hospeda, vigia o ponteiro: se aparecer um host mais novo (ex.: o sucessor assumiu enquanto eu estava sem rede),
// este vira membro em vez de manter uma sala paralela.
function watchPointer(current, rv) {
  if (current.watch) clearInterval(current.watch);
  const tick = async () => {
    if (host !== current || !current.publicUrl) return;
    const other = await lookPointer(rendezvous.format(rv), current.server.store.room.id);
    if (host !== current || !other || other.url === current.publicUrl || !other.alive) return;
    if (losesTo({ epoch: current.server.store.epoch, owner: current.owner.id }, other)) await supersede(current, other);
  };
  current.watch = setInterval(tick, 40000);
  if (current.watch.unref) current.watch.unref();
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
      named: readFixedConfig() ? { token: readFixedConfig().token, url: readFixedConfig().url } : undefined,
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
    publishAddress(current);
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
  // avisa o sucessor (e todos) antes de cair: ele copia a versão final e assume na hora
  if (current.server.announceLeaving) await current.server.announceLeaving().catch(() => {});
  if (host !== current) return;
  host = null;
  if (current.watch) clearInterval(current.watch);
  if (current.tunnel) current.tunnel.stop();
  await current.server.close().catch(() => {});
}

async function startHost({ dataDir, roomName, ownerName, takeoverUserId, takeoverToken, minEpoch }) {
  const fixed = readFixedConfig();
  let server;
  try {
    server = await createConcordoServer({
      port: fixed ? fixed.port : 0,
      dataDir,
      roomName,
      ownerName,
      takeoverUserId,
      takeoverToken,
      minEpoch,
      getPublicUrl: () => (host ? host.publicUrl : null),
      version: app.getVersion(),
      iceServers: iceFromEnv(),
    });
  } catch (e) {
    if (e && e.code === 'EADDRINUSE') {
      throw new Error(`A porta ${fixed ? fixed.port : ''} já está em uso. Feche o outro Concordo ou troque a porta do endereço fixo.`);
    }
    throw e;
  }
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

ipcMain.handle('host:start', async (_event, opts = {}) => {
  if (!host) {
    await startHost({
      dataDir: path.join(app.getPath('userData'), 'host-data'),
      roomName: opts.roomName,
      ownerName: opts.nickname || 'Anfitrião',
    });
  }
  return hostSnapshot();
});

// ---------- cópia da sala e migração de host ----------
// Todo membro guarda uma cópia (sem tokens nem convites) de cada sala em que está. Se o host sumir,
// quem tem a cópia e é o próximo na ordem de sucessão assume. Um trabalho de cópia por sala.
const SYNC_EVERY_MS = 45000;
const backupJobs = new Map(); // roomId -> { roomId, url, token, running, timer, tick }
const backupInfos = new Map(); // roomId -> { roomId, at, error }
const roomIdOk = (id) => typeof id === 'string' && /^[a-f0-9]{4,32}$/.test(id);
const backupDir = (roomId) => path.join(app.getPath('userData'), 'backups', roomId);

function stopBackup(roomId) {
  const ids = roomId ? [roomId] : [...backupJobs.keys()];
  for (const id of ids) {
    const job = backupJobs.get(id);
    if (job) clearInterval(job.timer);
    backupJobs.delete(id);
  }
}

function startBackup({ url, token, roomId }) {
  const prev = backupJobs.get(roomId);
  if (prev && prev.url === url && prev.token === token) return;
  stopBackup(roomId);
  const job = { roomId, url, token, running: false, timer: null };
  const tick = async () => {
    if (job.running) return;
    job.running = true;
    try {
      await backup.syncOnce({ dir: backupDir(roomId), url: job.url, token: job.token });
      const d = backup.describe(backupDir(roomId));
      backupInfos.set(roomId, { roomId, at: d ? d.at : Date.now(), error: null });
    } catch (e) {
      const d = backup.describe(backupDir(roomId));
      backupInfos.set(roomId, { roomId, at: d ? d.at : null, error: e.message });
    } finally {
      job.running = false;
      send('backup:status', backupInfos.get(roomId));
    }
  };
  job.tick = tick;
  job.timer = setInterval(tick, SYNC_EVERY_MS);
  backupJobs.set(roomId, job);
  tick();
}

ipcMain.handle('backup:start', (_event, args = {}) => {
  if (!roomIdOk(args.roomId) || !isHttpUrl(args.url) || typeof args.token !== 'string') return false;
  if (host && host.server.store.room.id === args.roomId) return false; // a sala que eu mesmo hospedo não precisa de cópia
  startBackup(args);
  return true;
});
ipcMain.handle('backup:sync-now', async (_event, roomId) => {
  const job = backupJobs.get(roomId);
  if (job && job.tick) await job.tick();
  return true;
});
ipcMain.handle('backup:stop', (_event, roomId) => {
  stopBackup(roomIdOk(roomId) ? roomId : undefined);
  return true;
});
ipcMain.handle('backup:status', (_event, roomId) => {
  if (!roomIdOk(roomId)) return null;
  return backup.describe(backupDir(roomId));
});

// Lê o ponteiro da sala guardado na cópia (a chave é a mesma que todo membro já conhece).
function copyPointer(roomId) {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(backupDir(roomId), 'state.json'), 'utf8'));
    return st.rendezvous ? rendezvous.format(st.rendezvous) : '';
  } catch {
    return '';
  }
}

// O sucessor assume a sala a partir da cópia local: vira o dono e abre um túnel novo.
// Se a sala já está de pé em outro computador, não abre uma segunda: devolve o endereço para entrar nela.
ipcMain.handle('backup:takeover', async (_event, args = {}) => {
  if (host) throw new Error('Você já está hospedando uma sala.');
  if (!roomIdOk(args.roomId) || typeof args.userId !== 'string') throw new Error('Dados inválidos.');
  const dir = backupDir(args.roomId);
  const mine = backup.describe(dir);
  if (!mine) throw new Error('Ainda não há cópia desta sala neste computador.');
  if (typeof args.token !== 'string' || !args.token) throw new Error('Dados inválidos.');
  const other = await lookPointer(copyPointer(args.roomId), args.roomId);
  if (other && other.alive && !args.force) return { online: true, url: other.url, host: other.host, epoch: other.epoch };
  stopBackup(args.roomId);
  await startHost({
    dataDir: dir,
    takeoverUserId: args.userId,
    takeoverToken: args.token,
    minEpoch: Math.max(mine.epoch || 1, other ? other.e || 0 : 0),
  });
  return hostSnapshot();
});

// Salas que este computador tem guardadas (cópias) e o estado de cada uma agora.
ipcMain.handle('backup:list', () => {
  const root = path.join(app.getPath('userData'), 'backups');
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names.filter(roomIdOk).map((id) => backup.describe(path.join(root, id))).filter(Boolean);
});

// "A sala está aberta?" para uma lista de salas ({ roomId, rv, url }).
ipcMain.handle('rooms:status', async (_event, list = []) => {
  const jobs = (Array.isArray(list) ? list : []).slice(0, 20).map(async (r) => {
    if (!roomIdOk(r.roomId)) return { roomId: r.roomId, state: 'unknown' };
    if (host && host.server.store.room.id === r.roomId) return { roomId: r.roomId, state: 'online', url: host.publicUrl, host: host.owner.name, mine: true };
    const p = await lookPointer(typeof r.rv === 'string' ? r.rv : copyPointer(r.roomId), r.roomId);
    if (p && p.alive) return { roomId: r.roomId, state: 'online', url: p.url, host: p.host, epoch: p.epoch };
    // sem ponteiro: tenta o último endereço conhecido
    if (isHttpUrl(r.url)) {
      const info = await pingRoom(r.url, r.roomId);
      if (info) return { roomId: r.roomId, state: 'online', url: r.url, host: info.host || null, epoch: info.epoch };
    }
    return { roomId: r.roomId, state: 'offline' };
  });
  return Promise.all(jobs);
});

// Devolve ao host o que só a minha cópia tem (mensagens, anexos, usuários); roda ao entrar numa sala.
ipcMain.handle('backup:reconcile', async (_event, args = {}) => {
  if (!roomIdOk(args.roomId) || !isHttpUrl(args.url) || typeof args.token !== 'string') return null;
  if (host && host.server.store.room.id === args.roomId) return null;
  try {
    return await backup.reconcile({ dir: backupDir(args.roomId), url: args.url, token: args.token });
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('rendezvous:resolve', async (_event, rv) => {
  try {
    const r = await rendezvous.resolve(rv);
    return r ? r.url : null;
  } catch {
    return null;
  }
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
  quitting = true;
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
    showWindow();
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
    setupMedia();
    setupTray();
    createWindow();
    setupUpdater();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (quitting || !tray) app.quit(); // com a bandeja ativa, o app continua rodando
  });

  let cleaningUp = false;
  app.on('before-quit', (event) => {
    quitting = true;
    if (cleaningUp || !host) return;
    event.preventDefault();
    cleaningUp = true;
    stopHost().finally(() => app.quit());
  });
}
