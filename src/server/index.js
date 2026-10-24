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
const Reactions = require('../shared/reactions');
const Rendezvous = require('../main/rendezvous');

const OPEN = 1;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_VOICE = 8; // chamadas em malha: cada pessoa envia para todas as outras
const DEFAULT_ICE = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];
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
    iceServers = DEFAULT_ICE, // STUN/TURN que os clientes usam nas chamadas
    version = '0.0.0',
    takeoverUserId, // sucessor assumindo uma sala copiada: vira o dono
    takeoverToken, // token do próprio sucessor (as cópias não trazem tokens)
    minEpoch = 0, // maior geração que o sucessor viu (no ponto de encontro); a nova fica acima dela
  } = opts;
  if (!dataDir) throw new Error('dataDir é obrigatório');

  const store = new Store(dataDir, { roomId: opts.roomId });
  if (roomName) store.setRoomName(cleanName(roomName, 40));
  if (takeoverUserId && !store.transferOwner(takeoverUserId)) throw new Error('usuário da cópia não encontrado');
  if (takeoverUserId && takeoverToken) store.adoptToken(takeoverUserId, takeoverToken);
  if (takeoverUserId) store.bumpEpoch(minEpoch); // nova geração: o host antigo, se voltar, percebe e vira membro
  const owner = ownerName && !takeoverUserId ? store.ensureOwner(cleanName(ownerName)) : store.getOwner();

  const pub = (u) => store.publicUser(u);
  const clients = new Map(); // userId -> Set<WebSocket>
  // quem está invisível não aparece como online para os outros
  const online = () => [...clients.keys()].filter((id) => !(store.getUser(id) && store.getUser(id).status === 'invisible'));

  function broadcast(payload) {
    const data = JSON.stringify(payload);
    for (const set of clients.values()) {
      for (const ws of set) if (ws.readyState === OPEN) ws.send(data);
    }
  }

  // ---- voz: quem está em qual sala de voz (só em memória) ----
  const voice = new Map(); // userId -> { ws, channel, muted, deafened, cam, screen }

  function voiceSnapshot() {
    const rooms = {};
    for (const [id, v] of voice) {
      (rooms[v.channel] = rooms[v.channel] || []).push({
        id,
        muted: v.muted,
        deafened: v.deafened,
        cam: v.cam,
        screen: v.screen,
      });
    }
    return rooms;
  }

  const broadcastVoice = () => broadcast({ t: 'voice', rooms: voiceSnapshot() });

  function leaveVoice(userId) {
    if (!voice.delete(userId)) return false;
    broadcastVoice();
    return true;
  }

  // @apelido no texto -> ids de quem foi mencionado (nomes mais longos primeiro, para "@Ana Maria" ganhar de "@Ana")
  function findMentions(text) {
    const lower = text.toLowerCase();
    const ids = new Set();
    for (const u of store.users().sort((a, b) => b.name.length - a.name.length)) {
      const needle = '@' + u.name.toLowerCase();
      let from = 0;
      for (;;) {
        const i = lower.indexOf(needle, from);
        if (i < 0) break;
        const after = lower[i + needle.length];
        if (!after || !/[\p{L}\p{N}_]/u.test(after)) ids.add(u.id);
        from = i + needle.length;
      }
    }
    return [...ids];
  }

  function makeCode(inviteToken) {
    const base = getPublicUrl();
    if (!base) throw httpError(409, 'o túnel ainda não está pronto');
    return Invite.encode({
      url: base,
      roomId: store.room.id,
      roomName: store.room.name,
      invite: inviteToken,
      rv: store.getRendezvous() ? Rendezvous.format(store.getRendezvous()) : undefined,
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
    if (!store.hasChannel(channelId, 'text')) throw httpError(404, 'canal não encontrado');
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
    res.setHeader('Timing-Allow-Origin', '*'); // deixa o app medir quanto cada arquivo baixado pesou
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
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
        epoch: store.epoch,
        host: (store.getOwner() || {}).name || null,
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
      broadcast({ t: 'heir', id: (store.getHeir() || {}).id || null, succession: store.succession() }); // o sucessor padrão é o primeiro a entrar
      return sendJson(res, 201, { token: user.token, user: pub(user), room: store.room });
    }

    // ---- rotas autenticadas ----
    const user = authenticate(req, url);
    if (!user) throw httpError(401, 'não autorizado');

    if (method === 'GET' && p === '/api/me') {
      const rv = store.getRendezvous();
      return sendJson(res, 200, { user: pub(user), room: store.room, rv: rv ? Rendezvous.format(rv) : null });
    }

    if (method === 'GET' && p === '/api/state') {
      return sendJson(res, 200, {
        room: store.room,
        you: pub(user),
        channels: store.channels,
        users: store.users().map(pub),
        online: online(),
        limits: { maxUploadBytes, maxMessageLength: MAX_MESSAGE_LENGTH, maxVoice: MAX_VOICE },
        voice: voiceSnapshot(),
        ice: iceServers,
        heir: (store.getHeir() || {}).id || null,
        succession: store.succession(),
      });
    }

    let m = p.match(/^\/api\/channels\/([a-z0-9_-]+)\/messages$/);
    if (method === 'GET' && m) {
      if (!store.hasChannel(m[1], 'text')) throw httpError(404, 'canal não encontrado');
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 50));
      const before = url.searchParams.get('before') || undefined;
      const around = url.searchParams.get('around') || undefined;
      return sendJson(res, 200, store.getMessages(m[1], { before, around, limit }));
    }

    m = p.match(/^\/api\/channels\/([a-z0-9_-]+)\/pins$/);
    if (method === 'GET' && m) {
      if (!store.hasChannel(m[1], 'text')) throw httpError(404, 'canal não encontrado');
      return sendJson(res, 200, { messages: store.pinsOf(m[1]) });
    }

    if (method === 'GET' && p === '/api/search') {
      const q = (url.searchParams.get('q') || '').slice(0, 100);
      const channel = url.searchParams.get('channel') || undefined;
      return sendJson(res, 200, { messages: store.search(q, { channel }) });
    }

    m = p.match(/^\/api\/channels\/([a-z0-9_-]+)\/upload$/);
    if (method === 'POST' && m) return handleUpload(req, res, user, m[1], url);

    if (method === 'POST' && p === '/api/channels') {
      requireOwner(user);
      const body = await readJson(req);
      let channel;
      try {
        channel = store.addChannel(body.name, body.type === 'voice' ? 'voice' : 'text');
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

    if (method === 'GET' && p === '/api/backup') {
      // qualquer membro pode manter uma cópia (sem tokens nem convites); ela só serve para assumir a sala
      const offset = parseInt(url.searchParams.get('offset'), 10) || 0;
      const lineage = url.searchParams.get('lineage') || '';
      if (
        parseInt(url.searchParams.get('rev'), 10) === store.rev &&
        offset === store.messageBytes() &&
        lineage === store.room.lineage
      ) {
        return sendJson(res, 200, { unchanged: true, rev: store.rev, epoch: store.epoch, lineage });
      }
      return sendJson(res, 200, store.exportBackup(offset, lineage));
    }

    // ---- junção de cópias: o membro devolve ao host o que só ele tem (por ID, sem duplicar) ----
    if (method === 'GET' && p === '/api/sync/ids') return sendJson(res, 200, store.syncIds());

    if (method === 'POST' && p === '/api/sync/state') {
      const body = await readJson(req, 512 * 1024);
      store.mergeState(body.state);
      broadcast({ t: 'resync' });
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'POST' && p === '/api/sync/messages') {
      const body = await readJson(req, 1024 * 1024);
      const added = store.importMessages(body.messages, { maxLength: MAX_MESSAGE_LENGTH });
      if (added) broadcast({ t: 'resync' });
      return sendJson(res, 200, { added });
    }

    m = p.match(/^\/api\/sync\/files\/([a-f0-9]{24})$/);
    if (method === 'PUT' && m) {
      const meta = store.getFile(m[1]);
      if (!meta) throw httpError(404, 'arquivo desconhecido (envie o estado antes)');
      if (store.fileStored(m[1])) return sendJson(res, 200, { ok: true, had: true });
      const len = Number(req.headers['content-length']);
      if (!Number.isFinite(len) || len !== meta.size || len > maxUploadBytes) throw httpError(400, 'tamanho do arquivo não confere');
      const dest = path.join(store.uploadsDir, m[1]);
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      try {
        await new Promise((resolve, reject) => {
          req.on('aborted', () => reject(httpError(400, 'envio cancelado')));
          req.on('error', reject);
          out.on('error', reject);
          out.on('finish', resolve);
          req.pipe(out);
        });
        if (fs.statSync(tmp).size !== meta.size) throw httpError(400, 'tamanho do arquivo não confere');
        fs.renameSync(tmp, dest);
      } catch (e) {
        out.destroy();
        fs.rm(tmp, { force: true }, () => {});
        throw e;
      }
      store.markFileStored(m[1]);
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'POST' && p === '/api/heir') {
      requireOwner(user);
      const body = await readJson(req);
      if (!store.setHeir(String(body.userId || ''))) throw httpError(400, 'usuário inválido para sucessor');
      broadcast({ t: 'heir', id: store.getHeir().id, succession: store.succession() });
      return sendJson(res, 200, { ok: true });
    }

    m = p.match(/^\/api\/messages\/([a-f0-9]+)$/);
    if (m && method === 'PATCH') {
      const body = await readJson(req);
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > MAX_MESSAGE_LENGTH) throw httpError(400, 'mensagem inválida');
      const r = store.editMessage(m[1], user.id, text);
      if (!r) throw httpError(404, 'mensagem não encontrada');
      if (r === 'forbidden') throw httpError(403, 'só quem enviou pode editar');
      broadcast({ t: 'msg_update', message: r });
      return sendJson(res, 200, { message: r });
    }
    if (m && method === 'DELETE') {
      const r = store.deleteMessage(m[1], user);
      if (!r) throw httpError(404, 'mensagem não encontrada');
      if (r === 'forbidden') throw httpError(403, 'só quem enviou ou o dono pode apagar');
      broadcast({ t: 'msg_update', message: r });
      return sendJson(res, 200, { message: r });
    }

    m = p.match(/^\/api\/messages\/([a-f0-9]+)\/pin$/);
    if (method === 'POST' && m) {
      const r = store.togglePin(m[1], user.id);
      if (!r) throw httpError(404, 'mensagem não encontrada');
      if (r === 'limit') throw httpError(400, 'limite de mensagens fixadas atingido');
      broadcast({ t: 'msg_update', message: r });
      return sendJson(res, 200, { message: r });
    }

    m = p.match(/^\/api\/messages\/([a-f0-9]+)\/reactions$/);
    if (method === 'POST' && m) {
      const body = await readJson(req);
      if (!Reactions.isValid(body.key)) throw httpError(400, 'reação inválida');
      const r = store.toggleReaction(m[1], user.id, body.key);
      if (!r) throw httpError(404, 'mensagem não encontrada');
      broadcast({ t: 'reaction', id: m[1], channel: r.channel, reactions: r.reactions });
      return sendJson(res, 200, { ok: true, reactions: r.reactions });
    }

    if (method === 'GET' && p === '/api/session-code') {
      requireOwner(user);
      return sendJson(res, 200, { code: makeCode(null) });
    }

    if (method === 'PATCH' && p === '/api/me') {
      const body = await readJson(req, 100 * 1024);
      const patch = {};
      for (const k of ['color', 'status', 'statusText', 'avatar']) if (k in body) patch[k] = body[k];
      try {
        store.setProfile(user, patch);
      } catch (e) {
        throw httpError(400, e.message);
      }
      broadcast({ t: 'user', user: pub(user) });
      broadcast({ t: 'presence', online: online() });
      return sendJson(res, 200, { user: pub(user) });
    }

    m = p.match(/^\/api\/users\/([a-f0-9]+)$/);
    if (method === 'DELETE' && m) {
      requireOwner(user);
      const target = store.getUser(m[1]);
      if (!target) throw httpError(404, 'usuário não encontrado');
      if (target.id === user.id) throw httpError(400, 'você não pode remover a si mesmo');
      store.removeUser(target.id);
      voice.delete(target.id);
      for (const ws of clients.get(target.id) || []) ws.close(4001, 'removido');
      clients.delete(target.id);
      broadcast({ t: 'user_removed', id: target.id });
      broadcast({ t: 'heir', id: (store.getHeir() || {}).id || null, succession: store.succession() });
      broadcastVoice();
      broadcast({ t: 'presence', online: online() });
      return sendJson(res, 200, { ok: true });
    }

    throw httpError(404, 'rota não encontrada');
  }

  // Tráfego que passa por este servidor (HTTP + WebSocket, tudo que vem do túnel), somado quando cada conexão fecha.
  let trafficDone = { in: 0, out: 0 };
  const sockets = new Set();
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
  server.on('connection', (sock) => {
    sockets.add(sock);
    sock.on('close', () => {
      sockets.delete(sock);
      trafficDone = { in: trafficDone.in + sock.bytesRead, out: trafficDone.out + sock.bytesWritten };
    });
  });
  const traffic = () => {
    let i = trafficDone.in;
    let o = trafficDone.out;
    for (const sock of sockets) {
      i += sock.bytesRead;
      o += sock.bytesWritten;
    }
    return { in: i, out: o };
  };

  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

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
    ws.send(JSON.stringify({ t: 'voice', rooms: voiceSnapshot() }));
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

      const fail = (message) => ws.send(JSON.stringify({ t: 'error', message }));

      if (data.t === 'voice_join') {
        if (!store.hasChannel(data.channel, 'voice')) return fail('canal de voz inválido');
        if (!store.getUser(user.id)) return;
        const others = [...voice.entries()]
          .filter(([id, v]) => v.channel === data.channel && id !== user.id)
          .map(([id]) => id);
        const previous = voice.get(user.id);
        const alreadyHere = previous && previous.channel === data.channel;
        if (!alreadyHere && others.length >= MAX_VOICE) {
          return fail(`sala de voz cheia (máximo ${MAX_VOICE} pessoas)`);
        }
        if (previous && previous.ws !== ws && previous.ws.readyState === OPEN) {
          previous.ws.send(JSON.stringify({ t: 'voice_left' })); // entrou por outra janela
        }
        voice.set(user.id, { ws, channel: data.channel, muted: false, deafened: false, cam: null, screen: null });
        ws.send(JSON.stringify({ t: 'voice_joined', channel: data.channel, peers: others }));
        return broadcastVoice();
      }

      if (data.t === 'voice_leave') {
        const v = voice.get(user.id);
        if (v && v.ws === ws) leaveVoice(user.id);
        return;
      }

      if (data.t === 'voice_state') {
        const v = voice.get(user.id);
        if (!v || v.ws !== ws) return;
        const id = (x) => (typeof x === 'string' && x.length > 0 && x.length <= 80 ? x : null);
        v.muted = data.muted === true;
        v.deafened = data.deafened === true;
        v.cam = id(data.cam);
        v.screen = id(data.screen);
        return broadcastVoice();
      }

      if (data.t === 'rtc') {
        const me = voice.get(user.id);
        const target = voice.get(String(data.to));
        if (!me || me.ws !== ws || !target || target.channel !== me.channel) return;
        if (!data.data || typeof data.data !== 'object') return;
        if (target.ws.readyState === OPEN) {
          target.ws.send(JSON.stringify({ t: 'rtc', from: user.id, data: data.data }));
        }
        return;
      }

      if (data.t === 'typing') {
        if (!store.hasChannel(data.channel, 'text') || !store.getUser(user.id)) return;
        const out = JSON.stringify({ t: 'typing', channel: data.channel, user: user.id });
        for (const [id, set] of clients) if (id !== user.id) for (const w of set) if (w.readyState === OPEN) w.send(out);
        return;
      }

      if (data.t === 'live_react') {
        const me = voice.get(user.id);
        if (!me || me.ws !== ws || !Reactions.isValid(data.key)) return;
        const now = Date.now();
        if (now - (me.lastReact || 0) < 300) return;
        me.lastReact = now;
        const out = JSON.stringify({ t: 'live_react', from: user.id, key: data.key });
        for (const v of voice.values()) if (v.channel === me.channel && v.ws.readyState === OPEN) v.ws.send(out);
        return;
      }

      if (data.t === 'msg') {
        const text = typeof data.text === 'string' ? data.text.trim() : '';
        if (!text || text.length > MAX_MESSAGE_LENGTH || !store.hasChannel(data.channel, 'text')) {
          return ws.send(JSON.stringify({ t: 'error', message: 'mensagem inválida' }));
        }
        if (!store.getUser(user.id)) return; // removido enquanto conectado
        if (!allowMessage(user.id)) {
          return ws.send(JSON.stringify({ t: 'error', message: 'devagar! muitas mensagens seguidas' }));
        }
        let replyTo;
        if (typeof data.replyTo === 'string') {
          const orig = store.getMessage(data.replyTo);
          if (orig && !orig.deleted && orig.channel === data.channel) {
            replyTo = { id: orig.id, author: orig.author, text: (orig.text || (orig.attachments[0] ? orig.attachments[0].name : '')).slice(0, 120) };
          }
        }
        const message = store.addMessage({ channel: data.channel, user, text, replyTo, mentions: findMentions(text) });
        broadcast({ t: 'msg', message });
      }
    });

    ws.on('close', () => {
      const v = voice.get(user.id);
      if (v && v.ws === ws) leaveVoice(user.id);
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

  // O dono vai sair: avisa todos e dá alguns segundos para o sucessor copiar a versão final.
  async function announceLeaving() {
    const heirId = store.succession().find((id) => id !== owner.id && clients.has(id)) || null;
    broadcast({ t: 'host_leaving', heir: heirId });
    if (heirId) await new Promise((r) => setTimeout(r, 3000));
    return !!heirId;
  }

  async function close() {
    clearInterval(heartbeat);
    for (const set of clients.values()) for (const ws of set) ws.terminate();
    clients.clear();
    voice.clear();
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
    announceLeaving,
    traffic,
    close,
  };
}

module.exports = { createConcordoServer };
