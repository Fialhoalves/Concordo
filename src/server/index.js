'use strict';
// Servidor do Concordo: HTTP (API + arquivos) e WebSocket (tempo real).
// Escuta só em 127.0.0.1; quem expõe para os amigos é o túnel.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const { Store } = require('./store');
const Invite = require('../shared/invite');

const OPEN = 1;
const MAX_MESSAGE_LENGTH = 4000;
const SAFE_IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function cleanName(raw, max = 24) {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanFileName(raw) {
  const base = path.basename(String(raw ?? '').replace(/\\/g, '/'));
  const name = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  return name || 'arquivo';
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(httpError(413, 'corpo da requisição grande demais'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(httpError(400, 'JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

async function createConcordoServer(opts = {}) {
  const {
    dataDir,
    port = 0,
    host = '127.0.0.1',
    roomName,
    ownerName,
    getPublicUrl = () => null,
    maxUploadBytes = 90 * 1024 * 1024, // o plano grátis do Cloudflare corta em ~100 MB
    version = '0.0.0',
  } = opts;
  if (!dataDir) throw new Error('dataDir é obrigatório');

  const store = new Store(dataDir);
  if (roomName) store.setRoomName(cleanName(roomName, 40));
  const owner = ownerName ? store.ensureOwner(cleanName(ownerName)) : store.getOwner();

  const pub = (u) => store.publicUser(u);
  const clients = new Map(); // userId -> Set<WebSocket>
  const online = () => [...clients.keys()];

  function broadcast(payload) {
    const data = JSON.stringify(payload);
    for (const set of clients.values()) {
      for (const ws of set) if (ws.readyState === OPEN) ws.send(data);
    }
  }

  function makeCode(inviteToken) {
    const base = getPublicUrl();
    if (!base) throw httpError(409, 'o túnel ainda não está pronto');
    return Invite.encode({
      url: base,
      roomId: store.room.id,
      roomName: store.room.name,
      invite: inviteToken,
    });
  }

  // ---- limites simples ----
  const msgBuckets = new Map();
  function allowMessage(userId) {
    const now = Date.now();
    const recent = (msgBuckets.get(userId) || []).filter((t) => now - t < 5000);
    if (recent.length >= 10) {
      msgBuckets.set(userId, recent);
      return false;
    }
    recent.push(now);
    msgBuckets.set(userId, recent);
    return true;
  }

  let joinFailures = [];
  function joinBlocked() {
    const now = Date.now();
    joinFailures = joinFailures.filter((t) => now - t < 10 * 60 * 1000);
    return joinFailures.length >= 20;
  }

  // ---- HTTP ----
  function authenticate(req, url) {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7).trim() : url.searchParams.get('token') || '';
    return token ? store.userByToken(token) : null;
  }

  function requireOwner(user) {
    if (user.role !== 'owner') throw httpError(403, 'só o dono da sala pode fazer isso');
  }

  async function handleUpload(req, res, user, channelId, url) {
    if (!store.hasChannel(channelId)) throw httpError(404, 'canal não encontrado');
    const name = cleanFileName(url.searchParams.get('name'));
    const len = Number(req.headers['content-length']);
    if (!Number.isFinite(len) || len <= 0) throw httpError(411, 'tamanho do arquivo não informado');
    if (len > maxUploadBytes) {
      throw httpError(413, `arquivo grande demais (máximo ${Math.floor(maxUploadBytes / 1048576)} MB)`);
    }

    const id = crypto.randomBytes(12).toString('hex');
    const dest = path.join(store.uploadsDir, id);
    const out = fs.createWriteStream(dest);
    let received = 0;
    try {
      await new Promise((resolve, reject) => {
        req.on('data', (chunk) => {
          received += chunk.length;
          if (received > maxUploadBytes) {
            reject(httpError(413, 'arquivo grande demais'));
            req.destroy();
            out.destroy();
          }
        });
        req.on('aborted', () => reject(httpError(400, 'envio cancelado')));
        req.on('error', reject);
        out.on('error', reject);
        out.on('finish', resolve);
        req.pipe(out);
      });
    } catch (e) {
      out.destroy();
      fs.rm(dest, { force: true }, () => {});
      throw e;
    }

    const type = SAFE_IMAGE_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream';
    const meta = { id, name, size: received, type, uploader: user.id, ts: Date.now() };
    store.addFile(meta);
    const message = store.addMessage({
      channel: channelId,
      user,
      text: '',
      attachments: [{ id, name, size: received, type }],
    });
    broadcast({ t: 'msg', message });
    sendJson(res, 201, { message });
  }

  function handleDownload(res, fileId) {
    const meta = /^[a-f0-9]{24}$/.test(fileId) ? store.getFile(fileId) : null;
    const file = meta && path.join(store.uploadsDir, meta.id);
    if (!meta || !fs.existsSync(file)) throw httpError(404, 'arquivo não encontrado');
    const isImage = meta.type !== 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': meta.type,
      'Content-Length': meta.size,
      'Content-Disposition': `${isImage ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=3600',
    });
    fs.createReadStream(file).pipe(res);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const p = url.pathname;
    const method = req.method;

    // ---- rotas públicas ----
    if (method === 'GET' && p === '/api/ping') {
      return sendJson(res, 200, {
        app: 'concordo',
        version,
        roomId: store.room.id,
        roomName: store.room.name,
      });
    }

    if (method === 'POST' && p === '/api/join') {
      if (joinBlocked()) throw httpError(429, 'muitas tentativas, espere alguns minutos');
      const body = await readJson(req);
      const name = cleanName(body.name);
      if (!name) throw httpError(400, 'informe um apelido');
      if (store.nameTaken(name)) throw httpError(409, 'esse apelido já está em uso nesta sala');
      if (!store.consumeInvite(body.invite)) {
        joinFailures.push(Date.now());
        throw httpError(403, 'convite inválido, expirado ou já usado');
      }
      const user = store.createUser(name);
      broadcast({ t: 'user', user: pub(user) });
      return sendJson(res, 201, { token: user.token, user: pub(user), room: store.room });
    }

    // ---- rotas autenticadas ----
    const user = authenticate(req, url);
    if (!user) throw httpError(401, 'não autorizado');

    if (method === 'GET' && p === '/api/me') {
      return sendJson(res, 200, { user: pub(user), room: store.room });
    }

    if (method === 'GET' && p === '/api/state') {
      return sendJson(res, 200, {
        room: store.room,
        you: pub(user),
        channels: store.channels,
        users: store.users().map(pub),
        online: online(),
        limits: { maxUploadBytes, maxMessageLength: MAX_MESSAGE_LENGTH },
      });
    }

    let m = p.match(/^\/api\/channels\/([a-z0-9_-]+)\/messages$/);
    if (method === 'GET' && m) {
      if (!store.hasChannel(m[1])) throw httpError(404, 'canal não encontrado');
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 50));
      const before = url.searchParams.get('before') || undefined;
      return sendJson(res, 200, store.getMessages(m[1], { before, limit }));
    }

    m = p.match(/^\/api\/channels\/([a-z0-9_-]+)\/upload$/);
    if (method === 'POST' && m) return handleUpload(req, res, user, m[1], url);

    if (method === 'POST' && p === '/api/channels') {
      requireOwner(user);
      const body = await readJson(req);
      let channel;
      try {
        channel = store.addChannel(body.name);
      } catch (e) {
        throw httpError(400, e.message);
      }
      broadcast({ t: 'channel', channel });
      return sendJson(res, 201, { channel });
    }

    m = p.match(/^\/api\/files\/([a-f0-9]+)$/);
    if (method === 'GET' && m) return handleDownload(res, m[1]);

    if (method === 'POST' && p === '/api/invites') {
      requireOwner(user);
      const body = await readJson(req);
      const maxUses = Math.min(100, Math.max(0, parseInt(body.maxUses, 10) || 0));
      const hours = Math.min(168, Math.max(1, parseInt(body.hours, 10) || 24));
      makeCode('check'); // falha cedo (409) se o túnel não estiver pronto
      const inv = store.createInvite({ maxUses: body.maxUses === undefined ? 1 : maxUses, hours });
      return sendJson(res, 201, {
        code: makeCode(inv.token),
        expiresAt: inv.expiresAt,
        maxUses: inv.maxUses,
      });
    }

    if (method === 'GET' && p === '/api/session-code') {
      requireOwner(user);
      return sendJson(res, 200, { code: makeCode(null) });
    }

    m = p.match(/^\/api\/users\/([a-f0-9]+)$/);
    if (method === 'DELETE' && m) {
      requireOwner(user);
      const target = store.getUser(m[1]);
      if (!target) throw httpError(404, 'usuário não encontrado');
      if (target.id === user.id) throw httpError(400, 'você não pode remover a si mesmo');
      store.removeUser(target.id);
      for (const ws of clients.get(target.id) || []) ws.close(4001, 'removido');
      clients.delete(target.id);
      broadcast({ t: 'user_removed', id: target.id });
      broadcast({ t: 'presence', online: online() });
      return sendJson(res, 200, { ok: true });
    }

    throw httpError(404, 'rota não encontrada');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (res.headersSent) return res.destroy();
      if (e && e.status) return sendJson(res, e.status, { error: e.message });
      console.error('[concordo] erro interno:', e);
      sendJson(res, 500, { error: 'erro interno' });
    });
  });
  server.requestTimeout = 30 * 60 * 1000; // uploads grandes em conexões lentas

  // ---- WebSocket ----
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const user = url.pathname === '/ws' ? authenticate(req, url) : null;
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, user));
  });

  function onConnection(ws, user) {
    let set = clients.get(user.id);
    const wasOffline = !set;
    if (!set) clients.set(user.id, (set = new Set()));
    set.add(ws);
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.send(JSON.stringify({ t: 'presence', online: online() }));
    if (wasOffline) broadcast({ t: 'presence', online: online() });

    ws.on('message', (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      if (!data || typeof data !== 'object') return;

      if (data.t === 'ping') return ws.send(JSON.stringify({ t: 'pong' }));

      if (data.t === 'msg') {
        const text = typeof data.text === 'string' ? data.text.trim() : '';
        if (!text || text.length > MAX_MESSAGE_LENGTH || !store.hasChannel(data.channel)) {
          return ws.send(JSON.stringify({ t: 'error', message: 'mensagem inválida' }));
        }
        if (!store.getUser(user.id)) return; // removido enquanto conectado
        if (!allowMessage(user.id)) {
          return ws.send(JSON.stringify({ t: 'error', message: 'devagar! muitas mensagens seguidas' }));
        }
        const message = store.addMessage({ channel: data.channel, user, text });
        broadcast({ t: 'msg', message });
      }
    });

    ws.on('close', () => {
      const current = clients.get(user.id);
      if (!current) return;
      current.delete(ws);
      if (current.size === 0) {
        clients.delete(user.id);
        broadcast({ t: 'presence', online: online() });
      }
    });
    ws.on('error', () => {});
  }

  const heartbeat = setInterval(() => {
    for (const set of clients.values()) {
      for (const ws of set) {
        if (!ws.isAlive) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }
  }, 30000);
  heartbeat.unref();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;

  async function close() {
    clearInterval(heartbeat);
    for (const set of clients.values()) for (const ws of set) ws.terminate();
    clients.clear();
    wss.close();
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.flush();
  }

  return {
    port: actualPort,
    host,
    localUrl: `http://${host}:${actualPort}`,
    store,
    owner,
    makeCode,
    close,
  };
}

module.exports = { createConcordoServer };
