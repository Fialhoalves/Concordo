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
const CHANNEL_TYPES = ['text', 'voice', 'dm'];
const ID12 = /^[a-f0-9]{12}$/;
const MAX_DM_CIPHER = 20000; // texto cifrado (base64) é maior que o original

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

// Ed25519: a chave pública chega crua (32 bytes em base64); o Node precisa dela no formato SPKI.
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
function verifySig(pubB64, payload, sigB64) {
  try {
    const raw = Buffer.from(String(pubB64), 'base64');
    const sig = Buffer.from(String(sigB64), 'base64');
    if (raw.length !== 32 || sig.length !== 64) return false;
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(String(payload), 'utf8'), key, sig);
  } catch {
    return false;
  }
}
// enquete: 2 a 6 opções (até 80 caracteres cada), resposta única ou múltipla
function cleanPoll(p) {
  if (!p || typeof p !== 'object' || !Array.isArray(p.options)) return null;
  const options = p.options.map((o) => String(o ?? '').replace(/\s+/g, ' ').trim().slice(0, 80));
  if (options.length < 2 || options.length > 6 || options.some((o) => !o) || new Set(options.map((o) => o.toLowerCase())).size !== options.length) return null;
  return { options, multi: p.multi === true };
}
const isKey32 = (s) => typeof s === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(s); // 32 bytes em base64
const keyHash = (pub) => crypto.createHash('sha256').update(String(pub)).digest('hex').slice(0, 32);

const hashToken = (t) => crypto.createHash('sha256').update(String(t || '')).digest('hex');

class Store {
  constructor(dir, { roomId } = {}) {
    this.dir = dir;
    this._newRoomId = roomId;
    this.uploadsDir = path.join(dir, 'uploads');
    fs.mkdirSync(this.uploadsDir, { recursive: true });
    this.statePath = path.join(dir, 'state.json');
    this.messagesPath = path.join(dir, 'messages.jsonl');

    this.state = this._loadState();
    this.tokenIndex = new Map();
    // O índice usa o HASH do token: cópias da sala (que vão para todos os membros) só levam o hash,
    // então ninguém consegue se passar por outro membro com a cópia em mãos.
    for (const u of Object.values(this.state.users)) {
      if (u.token) u.tokenHash = hashToken(u.token);
      if (u.tokenHash) this.tokenIndex.set(u.tokenHash, u.id);
    }

    this._normalizeChannels();
    this.messages = new Map();
    for (const ch of this.state.channels) if (ch.type === 'text' || ch.type === 'dm') this.messages.set(ch.id, []);
    this._loadMessages();
    if (!Number.isInteger(this.state.room.epoch) || this.state.room.epoch < 1) this.state.room.epoch = 1;
    if (!this.state.room.lineage) this.state.room.lineage = rid(6);

    this._timer = null;
    this.rev = Date.now(); // sobe a cada mudança (e continua subindo se o host reabrir a sala)
    this._writeNow(); // garante que o id da sala fique salvo desde o início
  }

  _loadState() {
    const defaults = {
      // epoch: sobe a cada troca de host (o maior vence); lineage: identifica a "linha do tempo" do arquivo de
      // mensagens (muda a cada troca de host, então cópias antigas baixam tudo de novo em vez de emendar bytes)
      room: { id: this._newRoomId || rid(6), name: 'Concordo', epoch: 1, lineage: rid(6) },
      removed: {},
      users: {},
      invites: {},
      channels: [
        { id: 'geral', name: 'geral', type: 'text' },
        { id: 'voz', name: 'voz', type: 'voice' },
      ],
      files: {},
      reactions: {},
      edits: {},
      deleted: {},
      pins: {},
      votes: {}, // id da enquete -> { userId: { o: [índices], at } }
      pollClosed: {},
      sigs: {}, // assinaturas de mensagens com arquivo (assinadas depois do envio)
      banned: {}, // hash da chave pública -> { name, at }
      rendezvous: null,
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
    // mensagens importadas de outras cópias podem estar fora de ordem no arquivo
    for (const list of this.messages.values()) list.sort((a, b) => a.ts - b.ts); // estável: mensagens do mesmo milissegundo mantêm a ordem do arquivo
  }

  save() {
    this.rev += 1;
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
    const out = { id: u.id, name: u.name, role: u.role };
    if (u.color) out.color = u.color;
    if (u.avatar) out.avatar = u.avatar;
    if (u.status && u.status !== 'online') out.status = u.status;
    if (u.statusText) out.statusText = u.statusText;
    if (u.pub) out.pub = u.pub;
    if (u.dh) out.dh = u.dh;
    if (u.pubAt) out.pubAt = u.pubAt;
    return out;
  }

  // Chaves do membro: pub (assina mensagens, Ed25519) e dh (conversas diretas, X25519). Uma vez registradas não
  // mudam sozinhas: quem trocar de computador precisa que o dono ou um moderador libere (resetKeys).
  setKeys(u, { pub, dh } = {}) {
    const bad = (m) => Object.assign(new Error(m), { keys: true });
    if (pub !== undefined && pub !== null) {
      if (!isKey32(pub)) throw bad('chave inválida');
      if (u.pub && u.pub !== pub) throw bad('esta conta já tem uma chave registrada');
      if (this.isBanned(pub)) throw bad('você foi banido desta sala');
      if (!u.pub) {
        u.pub = pub;
        u.pubAt = Date.now();
      }
    }
    if (dh !== undefined && dh !== null) {
      if (!isKey32(dh)) throw bad('chave inválida');
      if (u.dh && u.dh !== dh) throw bad('esta conta já tem uma chave registrada');
      u.dh = dh;
    }
    this.save();
    return u;
  }

  resetKeys(u) {
    delete u.pub;
    delete u.pubAt;
    delete u.dh;
    this.save();
  }

  isBanned(pub) {
    return !!pub && !!this.state.banned[keyHash(pub)];
  }

  // expulsar e impedir de voltar com a mesma chave (convite novo + chave nova ainda entra: o convite é a porta)
  banUser(id) {
    const u = this.state.users[id];
    if (!u) return false;
    if (u.pub) this.state.banned[keyHash(u.pub)] = { name: u.name, at: Date.now() };
    return this.removeUser(id);
  }

  setRole(id, role) {
    const u = this.state.users[id];
    if (!u || u.role === 'owner' || !['mod', 'member'].includes(role)) return false;
    u.role = role;
    this.save();
    return true;
  }

  listInvites() {
    const now = Date.now();
    return Object.values(this.state.invites)
      .filter((i) => i.expiresAt >= now)
      .map((i) => ({ token: i.token, uses: i.uses, maxUses: i.maxUses, createdAt: i.createdAt, expiresAt: i.expiresAt }));
  }

  revokeInvite(token) {
    if (!this.state.invites[token]) return false;
    delete this.state.invites[token];
    this.save();
    return true;
  }

  // Perfil: cor, avatar (imagem pequena), situação e frase. Valida tudo; campos ausentes ficam como estão.
  setProfile(u, patch = {}) {
    const bad = (m) => Object.assign(new Error(m), { profile: true });
    if ('color' in patch) {
      if (patch.color === null || patch.color === '') delete u.color;
      else if (/^#[0-9a-fA-F]{6}$/.test(String(patch.color))) u.color = String(patch.color).toLowerCase();
      else throw bad('cor inválida');
    }
    if ('status' in patch) {
      if (!['online', 'away', 'dnd', 'invisible'].includes(patch.status)) throw bad('situação inválida');
      u.status = patch.status;
    }
    if ('statusText' in patch) {
      const t = String(patch.statusText || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (t) u.statusText = t;
      else delete u.statusText;
    }
    if ('avatar' in patch) {
      if (patch.avatar === null || patch.avatar === '') delete u.avatar;
      else if (typeof patch.avatar === 'string' && patch.avatar.length <= 60000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(patch.avatar)) u.avatar = patch.avatar;
      else throw bad('imagem inválida ou grande demais');
    }
    this.save();
    return u;
  }

  users() {
    return Object.values(this.state.users);
  }

  userByToken(token) {
    const id = this.tokenIndex.get(hashToken(token));
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
    user.tokenHash = hashToken(user.token);
    this.state.users[user.id] = user;
    this.tokenIndex.set(user.tokenHash, user.id);
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
    this.tokenIndex.delete(u.tokenHash || hashToken(u.token));
    delete this.state.users[id];
    this.state.removed[id] = Date.now(); // lápide: junção com cópias antigas não ressuscita quem foi removido
    this.save();
    return true;
  }

  // Quem assume a sala precisa de um token só seu para falar com o próprio servidor.
  adoptToken(id, token) {
    const u = this.state.users[id];
    if (!u || !token) return false;
    u.token = String(token);
    u.tokenHash = hashToken(u.token);
    this.tokenIndex.set(u.tokenHash, id);
    this.save();
    return true;
  }

  // ordem de sucessão: o escolhido primeiro, depois quem entrou antes (nunca o dono)
  succession() {
    const heir = this.getHeir();
    const rest = this.users().filter((u) => u.role !== 'owner' && (!heir || u.id !== heir.id)).sort((a, b) => a.createdAt - b.createdAt);
    return (heir ? [heir, ...rest] : rest).map((u) => u.id);
  }

  // ---- sucessor (herdeiro) e transferência da sala ----
  // O herdeiro guarda uma cópia da sala e pode assumi-la se o host sumir.
  getHeir() {
    const chosen = this.state.heirId && this.state.users[this.state.heirId];
    if (chosen && chosen.role !== 'owner') return chosen;
    return this.users()
      .filter((u) => u.role !== 'owner')
      .sort((a, b) => a.createdAt - b.createdAt)[0] || null;
  }

  setHeir(id) {
    const u = this.state.users[id];
    if (!u || u.role === 'owner') return false;
    this.state.heirId = id;
    this.save();
    return true;
  }

  // Passa o dono da sala para outro usuário (usado quando o herdeiro assume).
  transferOwner(id) {
    const next = this.state.users[id];
    if (!next) return false;
    for (const u of this.users()) if (u.role === 'owner') u.role = 'member';
    next.role = 'owner';
    delete this.state.heirId;
    this.save();
    return true;
  }

  // ---- geração (epoch) ----
  get epoch() {
    return this.state.room.epoch;
  }

  // Troca de host: a geração sobe (acima de qualquer uma que o novo host já viu) e o arquivo de mensagens
  // ganha uma nova "linha do tempo".
  bumpEpoch(atLeast = 0) {
    this.state.room.epoch = Math.max(this.state.room.epoch, Number(atLeast) || 0) + 1;
    this.state.room.lineage = rid(6);
    this.save();
    return this.state.room.epoch;
  }

  // ---- junção de cópias (por ID: nada some, nada duplica) ----
  syncIds() {
    const messages = [];
    for (const list of this.messages.values()) for (const m of list) messages.push(m.id);
    return { epoch: this.epoch, lineage: this.state.room.lineage, messages, files: Object.keys(this.state.files).filter((id) => this.fileStored(id)) };
  }

  // Recebe mensagens de outra cópia. Retorna quantas entraram.
  importMessages(list, { maxLength = 4000 } = {}) {
    let added = 0;
    const known = new Set();
    for (const l of this.messages.values()) for (const m of l) known.add(m.id);
    const lines = [];
    for (const raw of Array.isArray(list) ? list : []) {
      if (!raw || typeof raw !== 'object') continue;
      const id = String(raw.id || '');
      if (!/^[a-f0-9]{16}$/.test(id) || known.has(id)) continue;
      if (!this.hasChannel(raw.channel, 'text')) continue;
      const ts = Number(raw.ts);
      if (!Number.isFinite(ts) || ts <= 0 || ts > Date.now() + 86400000) continue;
      const isDm = (this.getChannel(raw.channel) || {}).type === 'dm';
      const text = typeof raw.text === 'string' ? raw.text.slice(0, isDm ? MAX_DM_CIPHER : maxLength) : '';
      const attachments = (Array.isArray(raw.attachments) ? raw.attachments : [])
        .filter((a) => a && /^[a-f0-9]{24}$/.test(String(a.id)))
        .slice(0, 10)
        .map((a) => ({ id: String(a.id), name: String(a.name || 'arquivo').slice(0, 120), size: Number(a.size) || 0, type: String(a.type || 'application/octet-stream').slice(0, 80) }));
      const msg = { id, channel: raw.channel, userId: String(raw.userId || '').slice(0, 24), author: String(raw.author || '?').slice(0, 40), text, attachments, ts };
      if (raw.replyTo && typeof raw.replyTo === 'object') {
        msg.replyTo = { id: String(raw.replyTo.id || '').slice(0, 24), author: String(raw.replyTo.author || '').slice(0, 40), text: String(raw.replyTo.text || '').slice(0, 200) };
      }
      if (Array.isArray(raw.mentions)) msg.mentions = raw.mentions.map(String).slice(0, 20);
      const poll = cleanPoll(raw.poll);
      if (poll) msg.poll = poll;
      if (typeof raw.sig === 'string' && typeof raw.nonce === 'string') {
        msg.nonce = raw.nonce.slice(0, 64);
        msg.sig = raw.sig.slice(0, 100);
      }
      known.add(id);
      lines.push(JSON.stringify(msg));
      const arr = this.messages.get(msg.channel);
      // inserção ordenada por data; no empate, depois das que já estavam
      let i = arr.length;
      while (i > 0 && arr[i - 1].ts > ts) i--;
      arr.splice(i, 0, msg);
      added += 1;
    }
    if (lines.length) {
      fs.appendFileSync(this.messagesPath, lines.join('\n') + '\n');
      this.rev += 1;
    }
    return added;
  }

  // Junta o estado de outra cópia ao meu: só acrescenta; edição mais recente vence; apagado/fixado/removido são união.
  mergeState(other) {
    if (!other || typeof other !== 'object') return;
    const st = this.state;
    const own = (o) => (o && typeof o === 'object' ? o : {});
    // lápides primeiro
    for (const [id, ts] of Object.entries(own(other.removed))) {
      if (/^[a-f0-9]{12}$/.test(id) && !st.removed[id]) st.removed[id] = Number(ts) || Date.now();
    }
    for (const [id, u] of Object.entries(own(other.users))) {
      if (!/^[a-f0-9]{12}$/.test(id) || st.users[id] || st.removed[id] || !u || !u.tokenHash) continue;
      const name = String(u.name || '').slice(0, 24).trim();
      if (!name || this.nameTaken(name)) continue;
      st.users[id] = { id, name, role: 'member', tokenHash: String(u.tokenHash), createdAt: Number(u.createdAt) || Date.now() };
      try {
        this.setProfile(st.users[id], { color: u.color || null, avatar: u.avatar || null, status: u.status || 'online', statusText: u.statusText || '' });
        if (isKey32(u.pub)) {
          st.users[id].pub = u.pub;
          st.users[id].pubAt = Number(u.pubAt) || Date.now();
        }
        if (isKey32(u.dh)) st.users[id].dh = u.dh;
      } catch {
        /* perfil inválido na cópia: ignora */
      }
      this.tokenIndex.set(st.users[id].tokenHash, id);
    }
    for (const c of Array.isArray(other.channels) ? other.channels : []) {
      if (!c || !CHANNEL_TYPES.includes(c.type)) continue;
      if (c.type === 'dm') {
        const mem = Array.isArray(c.members) ? c.members.map(String) : [];
        if (mem.length !== 2 || !mem.every((x) => ID12.test(x)) || mem[0] === mem[1] || c.id !== this.dmId(mem[0], mem[1]) || this.hasChannel(c.id)) continue;
        st.channels.push({ id: c.id, name: 'dm', type: 'dm', members: [...mem].sort() });
        this.messages.set(c.id, []);
        continue;
      }
      const id = slugChannel(c.id);
      if (!id || id !== c.id || this.hasChannel(id) || st.channels.filter((x) => x.type !== 'dm').length >= MAX_CHANNELS) continue;
      st.channels.push({ id, name: id, type: c.type });
      if (c.type === 'text') this.messages.set(id, []);
    }
    for (const [id, f] of Object.entries(own(other.files))) {
      if (!/^[a-f0-9]{24}$/.test(id) || st.files[id] || !f) continue;
      st.files[id] = { id, name: String(f.name || 'arquivo').slice(0, 120), size: Number(f.size) || 0, type: String(f.type || 'application/octet-stream').slice(0, 80), uploader: String(f.uploader || ''), ts: Number(f.ts) || Date.now(), missing: true };
    }
    for (const [id, e] of Object.entries(own(other.edits))) {
      if (!e || typeof e.text !== 'string') continue;
      if (!st.edits[id] || (Number(e.at) || 0) > st.edits[id].at) {
        st.edits[id] = { text: e.text.slice(0, 4000), at: Number(e.at) || Date.now() };
        if (typeof e.sig === 'string' && typeof e.nonce === 'string') {
          st.edits[id].nonce = e.nonce.slice(0, 64);
          st.edits[id].sig = e.sig.slice(0, 100);
        }
      }
    }
    for (const [id, g] of Object.entries(own(other.sigs))) {
      if (/^[a-f0-9]{16}$/.test(id) && !st.sigs[id] && g && typeof g.sig === 'string' && typeof g.nonce === 'string') st.sigs[id] = { nonce: g.nonce.slice(0, 64), sig: g.sig.slice(0, 100) };
    }
    for (const [id, byUser] of Object.entries(own(other.votes))) {
      if (!/^[a-f0-9]{16}$/.test(id) || st.deleted[id]) continue;
      const mine = (st.votes[id] = st.votes[id] || {});
      for (const [uid, v] of Object.entries(own(byUser))) {
        if (!ID12.test(uid) || !v || !Array.isArray(v.o) || v.o.length > 6) continue;
        if (!mine[uid] || (Number(v.at) || 0) > mine[uid].at) mine[uid] = { o: v.o.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 6), at: Number(v.at) || Date.now() };
      }
      if (!Object.keys(mine).length) delete st.votes[id];
    }
    for (const id of Object.keys(own(other.pollClosed))) if (/^[a-f0-9]{16}$/.test(id)) st.pollClosed[id] = true;
    for (const [h, b] of Object.entries(own(other.banned))) {
      if (/^[a-f0-9]{32}$/.test(h) && !st.banned[h]) st.banned[h] = { name: String((b || {}).name || '').slice(0, 24), at: Number((b || {}).at) || Date.now() };
    }
    for (const id of Object.keys(own(other.deleted))) if (/^[a-f0-9]{16}$/.test(id)) st.deleted[id] = true;
    for (const [id, p] of Object.entries(own(other.pins))) {
      if (/^[a-f0-9]{16}$/.test(id) && !st.pins[id] && !st.deleted[id] && Object.keys(st.pins).length < 200) st.pins[id] = { by: String((p || {}).by || ''), at: Number((p || {}).at) || Date.now() };
    }
    for (const id of Object.keys(st.deleted)) delete st.pins[id];
    for (const [id, byKey] of Object.entries(own(other.reactions))) {
      if (!/^[a-f0-9]{16}$/.test(id) || st.deleted[id]) continue;
      const mine = (st.reactions[id] = st.reactions[id] || {});
      for (const [key, users] of Object.entries(own(byKey))) {
        if (!Array.isArray(users) || (!mine[key] && Object.keys(mine).length >= 20)) continue;
        const set = new Set(mine[key] || []);
        for (const u of users.slice(0, 50)) set.add(String(u).slice(0, 24));
        mine[key] = [...set];
      }
      if (!Object.keys(mine).length) delete st.reactions[id];
    }
    this.save();
  }

  fileStored(id) {
    const f = this.state.files[id];
    if (!f) return false;
    try {
      return fs.statSync(path.join(this.uploadsDir, id)).size === f.size;
    } catch {
      return false;
    }
  }

  // arquivos que chegaram só como metadado (a cópia de quem não tinha os bytes)
  markFileStored(id) {
    const f = this.state.files[id];
    if (f) {
      delete f.missing;
      this.save();
    }
  }

  messageBytes() {
    try {
      return fs.statSync(this.messagesPath).size;
    } catch {
      return 0;
    }
  }

  // Estado que vai para as cópias dos membros: sem tokens de acesso nem convites abertos.
  backupState() {
    const users = {};
    for (const [id, u] of Object.entries(this.state.users)) {
      const { token, ...rest } = u; // eslint-disable-line no-unused-vars
      users[id] = { ...rest, tokenHash: u.tokenHash || hashToken(u.token) };
    }
    return { ...this.state, users, invites: {} };
  }

  // Cópia incremental: o estado inteiro (pequeno) + só o que foi acrescentado em messages.jsonl.
  exportBackup(offset = 0, lineage = '') {
    this.flush();
    let size = 0;
    try {
      size = fs.statSync(this.messagesPath).size;
    } catch {
      /* sem mensagens ainda */
    }
    const reset = offset > size || offset < 0 || (lineage && lineage !== this.state.room.lineage) || (!lineage && offset > 0);
    const from = reset ? 0 : offset;
    let chunk = '';
    if (size > from) {
      const fd = fs.openSync(this.messagesPath, 'r');
      try {
        const buf = Buffer.alloc(size - from);
        fs.readSync(fd, buf, 0, buf.length, from);
        chunk = buf.toString('latin1'); // bytes preservados; o cliente regrava como binário
      } finally {
        fs.closeSync(fd);
      }
    }
    return {
      v: 2,
      rev: this.rev,
      epoch: this.epoch,
      lineage: this.state.room.lineage,
      state: this.backupState(),
      reset,
      offset: size,
      chunk,
      files: Object.values(this.state.files).map((f) => ({ id: f.id, size: f.size })),
    };
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
  // 'text' também vale para conversa direta (dm): as duas guardam mensagens
  hasChannel(id, type) {
    return this.state.channels.some((c) => c.id === id && (!type || c.type === type || (type === 'text' && c.type === 'dm')));
  }

  getChannel(id) {
    return this.state.channels.find((c) => c.id === id) || null;
  }

  // só quem participa enxerga uma conversa direta
  canSee(userId, channelId) {
    const ch = this.getChannel(channelId);
    if (!ch) return false;
    return ch.type !== 'dm' || (ch.members || []).includes(userId);
  }

  channelsFor(userId) {
    return this.state.channels.filter((c) => c.type !== 'dm' || (c.members || []).includes(userId));
  }

  dmId(a, b) {
    return 'dm-' + [a, b].sort().join('-');
  }

  addDm(a, b) {
    if (!ID12.test(a) || !ID12.test(b) || a === b) throw new Error('conversa inválida');
    const id = this.dmId(a, b);
    let ch = this.getChannel(id);
    if (ch) return { channel: ch, created: false };
    ch = { id, name: 'dm', type: 'dm', members: [a, b].sort() };
    this.state.channels.push(ch);
    this.messages.set(id, []);
    this.save();
    return { channel: ch, created: true };
  }

  addChannel(rawName, type = 'text') {
    if (!CHANNEL_TYPES.includes(type)) throw new Error('tipo de canal inválido');
    const name = slugChannel(rawName);
    if (!name) throw new Error('nome de canal inválido');
    if (this.hasChannel(name)) throw new Error('já existe um canal com esse nome');
    if (this.state.channels.filter((c) => c.type !== 'dm').length >= MAX_CHANNELS) throw new Error('limite de canais atingido');
    const ch = { id: name, name, type };
    this.state.channels.push(ch);
    if (type === 'text') this.messages.set(ch.id, []);
    this.save();
    return ch;
  }

  // ---- mensagens ----
  addMessage({ channel, user, text, attachments, replyTo, mentions, nonce, sig, poll }) {
    const msg = {
      id: rid(8),
      channel,
      userId: user.id,
      author: user.name,
      text: text || '',
      attachments: attachments || [],
      ts: Date.now(),
    };
    if (replyTo) msg.replyTo = replyTo; // { id, author, text }: resumo da mensagem respondida
    if (mentions && mentions.length) msg.mentions = mentions;
    if (poll) msg.poll = poll;
    if (sig && nonce) {
      msg.nonce = String(nonce).slice(0, 64);
      msg.sig = String(sig).slice(0, 100);
    }
    fs.appendFileSync(this.messagesPath, JSON.stringify(msg) + '\n');
    this.rev += 1;
    if (!this.messages.has(channel)) this.messages.set(channel, []);
    this.messages.get(channel).push(msg);
    return msg;
  }

  // Mensagem como os clientes veem: com reações, edição, exclusão e fixação aplicadas.
  // (messages.jsonl é só de acréscimo; as alterações ficam no state.json e entram na cópia do sucessor.)
  decorate(m) {
    const st = this.state;
    const out = { ...m };
    if (st.reactions[m.id]) out.reactions = st.reactions[m.id];
    if (st.edits[m.id]) {
      out.text = st.edits[m.id].text;
      out.editedAt = st.edits[m.id].at;
      if (st.edits[m.id].sig) {
        out.editNonce = st.edits[m.id].nonce;
        out.editSig = st.edits[m.id].sig;
      }
    }
    if (!m.sig && st.sigs[m.id]) {
      out.nonce = st.sigs[m.id].nonce;
      out.sig = st.sigs[m.id].sig;
    }
    if (st.deleted[m.id]) {
      out.deleted = true;
      out.text = '';
      out.attachments = [];
      delete out.reactions;
      delete out.sig;
      delete out.nonce;
      delete out.editSig;
      delete out.editNonce;
      delete out.poll;
    }
    if (m.poll && !st.deleted[m.id]) {
      const votes = {};
      for (const [uid, v] of Object.entries(st.votes[m.id] || {})) for (const o of v.o) (votes[o] = votes[o] || []).push(uid);
      out.votes = votes;
      if (st.pollClosed[m.id]) out.pollClosed = true;
    }
    if (st.pins[m.id]) out.pinned = true;
    return out;
  }

  getMessage(id) {
    const m = this._findMessage(id);
    return m ? this.decorate(m) : null;
  }

  editMessage(id, userId, text, { nonce, sig } = {}) {
    const m = this._findMessage(id);
    if (!m || this.state.deleted[id]) return null;
    if (m.userId !== userId) return 'forbidden';
    this.state.edits[id] = { text, at: Date.now() };
    if (nonce && sig) {
      this.state.edits[id].nonce = String(nonce).slice(0, 64);
      this.state.edits[id].sig = String(sig).slice(0, 100);
    }
    this.save();
    return this.decorate(m);
  }

  deleteMessage(id, user) {
    const m = this._findMessage(id);
    if (!m) return null;
    const author = this.state.users[m.userId];
    const mayModerate = user.role === 'owner' || (user.role === 'mod' && (!author || author.role === 'member'));
    if (m.userId !== user.id && !mayModerate) return 'forbidden';
    this.state.deleted[id] = true;
    delete this.state.pins[id];
    this.save();
    return this.decorate(m);
  }

  votePoll(id, userId, options) {
    const m = this._findMessage(id);
    if (!m || !m.poll || this.state.deleted[id]) return null;
    if (this.state.pollClosed[id]) return 'closed';
    const picks = [...new Set((Array.isArray(options) ? options : []).map(Number))];
    if (picks.some((n) => !Number.isInteger(n) || n < 0 || n >= m.poll.options.length) || (!m.poll.multi && picks.length > 1)) return 'invalid';
    const mine = (this.state.votes[id] = this.state.votes[id] || {});
    if (picks.length) mine[userId] = { o: picks.sort((a, b) => a - b), at: Date.now() };
    else delete mine[userId];
    if (!Object.keys(mine).length) delete this.state.votes[id];
    this.save();
    return this.decorate(m);
  }

  closePoll(id, user) {
    const m = this._findMessage(id);
    if (!m || !m.poll || this.state.deleted[id]) return null;
    const author = this.state.users[m.userId];
    const may = m.userId === user.id || user.role === 'owner' || (user.role === 'mod' && (!author || author.role === 'member'));
    if (!may) return 'forbidden';
    this.state.pollClosed[id] = true;
    this.save();
    return this.decorate(m);
  }

  // assinatura de mensagem com arquivo (o texto é vazio; o que vale é a lista de anexos)
  setFileSig(id, nonce, sig) {
    const m = this._findMessage(id);
    if (!m || m.sig || this.state.sigs[id]) return false;
    this.state.sigs[id] = { nonce: String(nonce).slice(0, 64), sig: String(sig).slice(0, 100) };
    this.save();
    return true;
  }

  togglePin(id, userId) {
    const m = this._findMessage(id);
    if (!m || this.state.deleted[id]) return null;
    if (this.state.pins[id]) delete this.state.pins[id];
    else if (Object.keys(this.state.pins).length >= 200) return 'limit';
    else this.state.pins[id] = { by: userId, at: Date.now() };
    this.save();
    return this.decorate(m);
  }

  pinsOf(channel) {
    return (this.messages.get(channel) || []).filter((m) => this.state.pins[m.id]).map((m) => this.decorate(m));
  }

  // busca simples por texto (sem acento e sem diferenciar maiúsculas), das mais novas para as mais antigas
  search(query, { channel, limit = 40 } = {}) {
    const norm = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const q = norm(query).trim();
    if (!q) return [];
    const out = [];
    for (const [ch, list] of this.messages) {
      if (channel && ch !== channel) continue;
      if ((this.getChannel(ch) || {}).type === 'dm') continue; // conversa direta é cifrada: não dá para buscar
      for (let i = list.length - 1; i >= 0; i--) {
        const d = this.decorate(list[i]);
        if (d.deleted) continue;
        const hay = norm(d.text) + ' ' + norm((d.attachments || []).map((a) => a.name).join(' '));
        if (hay.includes(q)) out.push(d);
      }
    }
    return out.sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  getMessages(channel, { before, around, limit = 50 } = {}) {
    const list = this.messages.get(channel) || [];
    let end = list.length;
    if (around) {
      const idx = list.findIndex((m) => m.id === around);
      if (idx >= 0) end = Math.min(list.length, idx + Math.ceil(limit / 2));
    } else if (before) {
      const idx = list.findIndex((m) => m.id === before);
      if (idx >= 0) end = idx;
    }
    const start = Math.max(0, end - limit);
    return { messages: list.slice(start, end).map((m) => this.decorate(m)), hasMore: start > 0 };
  }

  // ---- reações ----
  // { chave: [ids de quem reagiu] }; fica no state.json, então entra na cópia do sucessor
  _findMessage(id) {
    for (const list of this.messages.values()) {
      const m = list.find((x) => x.id === id);
      if (m) return m;
    }
    return null;
  }

  reactionsOf(messageId) {
    return this.state.reactions[messageId] || {};
  }

  toggleReaction(messageId, userId, key) {
    const m = this._findMessage(messageId);
    if (!m) return null;
    const all = this.state.reactions;
    const mine = (all[messageId] = all[messageId] || {});
    const list = (mine[key] = mine[key] || []);
    const i = list.indexOf(userId);
    if (i >= 0) list.splice(i, 1);
    else if (Object.keys(mine).length < 20 || list.length) list.push(userId);
    if (!list.length) delete mine[key];
    if (!Object.keys(mine).length) delete all[messageId];
    this.save();
    return { channel: m.channel, reactions: this.reactionsOf(messageId) };
  }

  // ---- ponto de encontro (endereço atual da sala) ----
  getRendezvous() {
    return this.state.rendezvous || null;
  }

  setRendezvous(value) {
    this.state.rendezvous = value;
    this.save();
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

module.exports = { Store, slugChannel, rid, verifySig, isKey32, cleanPoll, MAX_DM_CIPHER };
