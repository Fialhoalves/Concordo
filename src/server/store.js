'use strict';
// Persistência do servidor: tudo em disco, dentro da pasta de dados do host.
//   state.json     -> sala, usuários, convites, canais, metadados de arquivos
//   messages.jsonl -> uma mensagem por linha (append-only)
//   uploads/       -> arquivos enviados (nome = id aleatório)

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const rid = (bytes = 8) => crypto.randomBytes(bytes).toString('hex');

const MAX_CHANNELS = 30;
const CHANNEL_TYPES = ['text', 'voice'];

function slugChannel(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.uploadsDir = path.join(dir, 'uploads');
    fs.mkdirSync(this.uploadsDir, { recursive: true });
    this.statePath = path.join(dir, 'state.json');
    this.messagesPath = path.join(dir, 'messages.jsonl');

    this.state = this._loadState();
    this.tokenIndex = new Map();
    for (const u of Object.values(this.state.users)) this.tokenIndex.set(u.token, u.id);

    this._normalizeChannels();
    this.messages = new Map();
    for (const ch of this.state.channels) if (ch.type === 'text') this.messages.set(ch.id, []);
    this._loadMessages();

    this._timer = null;
    this._writeNow(); // garante que o id da sala fique salvo desde o início
  }

  _loadState() {
    const defaults = {
      room: { id: rid(6), name: 'Concordo' },
      users: {},
      invites: {},
      channels: [
        { id: 'geral', name: 'geral', type: 'text' },
        { id: 'voz', name: 'voz', type: 'voice' },
      ],
      files: {},
    };
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      return { ...defaults, ...raw, room: { ...defaults.room, ...raw.room } };
    } catch {
      return defaults;
    }
  }

  // Salas criadas na v0.1 não tinham tipo de canal nem canal de voz.
  _normalizeChannels() {
    const channels = this.state.channels;
    for (const ch of channels) if (!CHANNEL_TYPES.includes(ch.type)) ch.type = 'text';
    if (!channels.some((c) => c.type === 'voice')) {
      let id = 'voz';
      for (let i = 2; channels.some((c) => c.id === id); i++) id = `voz-${i}`;
      channels.push({ id, name: id, type: 'voice' });
    }
  }

  _loadMessages() {
    let text;
    try {
      text = fs.readFileSync(this.messagesPath, 'utf8');
    } catch {
      return;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        if (!this.messages.has(m.channel)) this.messages.set(m.channel, []);
        this.messages.get(m.channel).push(m);
      } catch {
        /* linha corrompida: ignora */
      }
    }
  }

  save() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._writeNow();
    }, 200);
    if (this._timer.unref) this._timer.unref();
  }

  _writeNow() {
    const tmp = this.statePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.statePath);
  }

  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._writeNow();
  }

  // ---- sala ----
  get room() {
    return this.state.room;
  }

  setRoomName(name) {
    if (name && name !== this.state.room.name) {
      this.state.room.name = name;
      this.save();
    }
  }

  // ---- usuários ----
  publicUser(u) {
    return { id: u.id, name: u.name, role: u.role };
  }

  users() {
    return Object.values(this.state.users);
  }

  userByToken(token) {
    const id = this.tokenIndex.get(String(token || ''));
    return id ? this.state.users[id] || null : null;
  }

  getUser(id) {
    return this.state.users[id] || null;
  }

  getOwner() {
    return this.users().find((u) => u.role === 'owner') || null;
  }

  nameTaken(name, exceptId) {
    const n = name.toLowerCase();
    return this.users().some((u) => u.id !== exceptId && u.name.toLowerCase() === n);
  }

  createUser(name, role = 'member') {
    const user = { id: rid(6), name, token: rid(24), role, createdAt: Date.now() };
    this.state.users[user.id] = user;
    this.tokenIndex.set(user.token, user.id);
    this.save();
    return user;
  }

  ensureOwner(name) {
    let owner = this.getOwner();
    if (!owner) return this.createUser(name, 'owner');
    if (name && name !== owner.name && !this.nameTaken(name, owner.id)) {
      owner.name = name;
      this.save();
    }
    return owner;
  }

  removeUser(id) {
    const u = this.state.users[id];
    if (!u) return false;
    this.tokenIndex.delete(u.token);
    delete this.state.users[id];
    this.save();
    return true;
  }

  // ---- convites ----
  createInvite({ maxUses = 1, hours = 24 } = {}) {
    const now = Date.now();
    for (const [t, inv] of Object.entries(this.state.invites)) {
      if (inv.expiresAt < now) delete this.state.invites[t];
    }
    const token = rid(16);
    this.state.invites[token] = {
      token,
      maxUses, // 0 = ilimitado
      uses: 0,
      createdAt: now,
      expiresAt: now + hours * 3600 * 1000,
    };
    this.save();
    return { token, expiresAt: this.state.invites[token].expiresAt, maxUses };
  }

  consumeInvite(token) {
    const inv = this.state.invites[String(token || '')];
    if (!inv) return false;
    if (inv.expiresAt < Date.now()) {
      delete this.state.invites[inv.token];
      this.save();
      return false;
    }
    inv.uses += 1;
    if (inv.maxUses > 0 && inv.uses >= inv.maxUses) delete this.state.invites[inv.token];
    this.save();
    return true;
  }

  // ---- canais ----
  get channels() {
    return this.state.channels;
  }

  // type é opcional: sem ele, basta o canal existir.
  hasChannel(id, type) {
    return this.state.channels.some((c) => c.id === id && (!type || c.type === type));
  }

  addChannel(rawName, type = 'text') {
    if (!CHANNEL_TYPES.includes(type)) throw new Error('tipo de canal inválido');
    const name = slugChannel(rawName);
    if (!name) throw new Error('nome de canal inválido');
    if (this.hasChannel(name)) throw new Error('já existe um canal com esse nome');
    if (this.state.channels.length >= MAX_CHANNELS) throw new Error('limite de canais atingido');
    const ch = { id: name, name, type };
    this.state.channels.push(ch);
    if (type === 'text') this.messages.set(ch.id, []);
    this.save();
    return ch;
  }

  // ---- mensagens ----
  addMessage({ channel, user, text, attachments }) {
    const msg = {
      id: rid(8),
      channel,
      userId: user.id,
      author: user.name,
      text: text || '',
      attachments: attachments || [],
      ts: Date.now(),
    };
    fs.appendFileSync(this.messagesPath, JSON.stringify(msg) + '\n');
    if (!this.messages.has(channel)) this.messages.set(channel, []);
    this.messages.get(channel).push(msg);
    return msg;
  }

  getMessages(channel, { before, limit = 50 } = {}) {
    const list = this.messages.get(channel) || [];
    let end = list.length;
    if (before) {
      const idx = list.findIndex((m) => m.id === before);
      if (idx >= 0) end = idx;
    }
    const start = Math.max(0, end - limit);
    return { messages: list.slice(start, end), hasMore: start > 0 };
  }

  // ---- arquivos ----
  addFile(meta) {
    this.state.files[meta.id] = meta;
    this.save();
  }

  getFile(id) {
    return this.state.files[id] || null;
  }
}

module.exports = { Store, slugChannel, rid };
