'use strict';
// Cópia local da sala para o sucessor (herdeiro). Não depende do Electron.
// Grava no mesmo formato do servidor (state.json, messages.jsonl, uploads/), então assumir a sala
// é só abrir um servidor apontando para essa pasta.

const fs = require('node:fs');
const path = require('node:path');

const META = 'backup-meta.json';
const FILE_ID = /^[a-f0-9]{24}$/;

function readMeta(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, META), 'utf8'));
  } catch {
    return null;
  }
}

function writeAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// Uma rodada de sincronização. Retorna { changed, rev, files }.
async function syncOnce({ dir, url, token, fetchImpl = fetch }) {
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  const headers = { Authorization: `Bearer ${token}` };
  const meta = readMeta(dir) || { rev: 0, offset: 0 };
  const messagesPath = path.join(dir, 'messages.jsonl');
  const have = fs.existsSync(messagesPath) ? fs.statSync(messagesPath).size : 0;
  const offset = have === meta.offset ? meta.offset : 0;

  const res = await fetchImpl(
    `${url}/api/backup?rev=${meta.rev}&offset=${offset}&lineage=${encodeURIComponent(meta.lineage || '')}`,
    { headers },
  );
  if (!res.ok) throw new Error(`o servidor recusou a cópia (HTTP ${res.status})`);
  const data = await res.json();

  // Servidor de uma geração MAIS ANTIGA que a minha cópia (host antigo que voltou): não sobrescreve nada.
  if (Number.isInteger(data.epoch) && data.epoch < (meta.epoch || 0)) return { changed: false, downloaded: 0, stale: true };

  let changed = false;
  if (!data.unchanged) {
    if (data.reset || offset === 0) fs.writeFileSync(messagesPath, Buffer.from(data.chunk || '', 'latin1'));
    else if (data.chunk) fs.appendFileSync(messagesPath, Buffer.from(data.chunk, 'latin1'));
    writeAtomic(path.join(dir, 'state.json'), JSON.stringify(data.state));
    writeAtomic(path.join(dir, META), JSON.stringify({
      rev: data.rev,
      offset: data.offset,
      epoch: data.epoch || 1,
      lineage: data.lineage || '',
      roomId: data.state.room.id,
      roomName: data.state.room.name,
      at: Date.now(),
    }));
    changed = true;
    meta.files = data.files;
  }

  // arquivos que ainda não temos (ou incompletos)
  const files = changed ? data.files : readFilesFromState(dir);
  let downloaded = 0;
  for (const f of files) {
    if (!FILE_ID.test(f.id)) continue;
    const dest = path.join(dir, 'uploads', f.id);
    if (fs.existsSync(dest) && fs.statSync(dest).size === f.size) continue;
    const r = await fetchImpl(`${url}/api/files/${f.id}`, { headers });
    if (!r.ok) continue;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length !== f.size) continue;
    writeAtomic(dest, buf);
    downloaded += 1;
  }
  return { changed, downloaded };
}

function readFilesFromState(dir) {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    return Object.values(st.files || {}).map((f) => ({ id: f.id, size: f.size }));
  } catch {
    return [];
  }
}

// Quando já existe cópia dessa sala, devolve o resumo (para a interface mostrar "cópia de 2 min atrás").
function describe(dir) {
  const m = readMeta(dir);
  if (!m || !fs.existsSync(path.join(dir, 'state.json'))) return null;
  return { roomId: m.roomId, roomName: m.roomName, at: m.at, epoch: m.epoch || 1, lineage: m.lineage || '' };
}

function readLocalMessages(dir) {
  const out = [];
  let text = '';
  try {
    text = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* linha corrompida */
    }
  }
  return out;
}

// Devolve ao host (que pode ter sido reaberto a partir de uma cópia mais velha) o que só EU tenho:
// mensagens, usuários e canais que ele não conhece, edições e anexos. Tudo por ID, então nada duplica.
async function reconcile({ dir, url, token, fetchImpl = fetch }) {
  const meta = readMeta(dir);
  if (!meta || !fs.existsSync(path.join(dir, 'state.json'))) return { skipped: 'sem cópia' };
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const idsRes = await fetchImpl(`${url}/api/sync/ids`, { headers });
  if (!idsRes.ok) throw new Error(`junção: HTTP ${idsRes.status}`);
  const remote = await idsRes.json();
  if (Number.isInteger(remote.epoch) && remote.epoch < (meta.epoch || 0)) return { stale: true };
  if (meta.lineage && remote.lineage === meta.lineage) return { skipped: 'mesma linha do tempo' }; // minha cópia é só um pedaço da dele

  const have = new Set(remote.messages);
  const mine = readLocalMessages(dir);
  const missing = mine.filter((m) => m && m.id && !have.has(m.id));
  const missingIds = new Set(missing.map((m) => m.id));

  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  } catch {
    /* sem estado legível */
  }
  const only = (obj) => Object.fromEntries(Object.entries(obj || {}).filter(([id]) => missingIds.has(id)));
  const shared = {
    users: state.users,
    removed: state.removed,
    channels: state.channels,
    files: state.files,
    edits: state.edits,
    deleted: state.deleted,
    // fixadas e reações: só das mensagens que o host ainda não tinha (para não ressuscitar o que ele já desfez)
    pins: only(state.pins),
    reactions: only(state.reactions),
  };
  let r = await fetchImpl(`${url}/api/sync/state`, { method: 'POST', headers, body: JSON.stringify({ state: shared }) });
  if (!r.ok) throw new Error(`junção do estado: HTTP ${r.status}`);

  let added = 0;
  for (let i = 0; i < missing.length; i += 200) {
    r = await fetchImpl(`${url}/api/sync/messages`, { method: 'POST', headers, body: JSON.stringify({ messages: missing.slice(i, i + 200) }) });
    if (!r.ok) throw new Error(`junção das mensagens: HTTP ${r.status}`);
    added += (await r.json()).added || 0;
  }

  // anexos que o host não tem os bytes
  let files = 0;
  const hostHas = new Set(remote.files);
  for (const f of Object.values(state.files || {})) {
    if (!FILE_ID.test(f.id)) continue;
    const src = path.join(dir, 'uploads', f.id);
    let size = -1;
    try {
      size = fs.statSync(src).size;
    } catch {
      continue;
    }
    if (size !== f.size || size > 90 * 1024 * 1024) continue;
    if (hostHas.has(f.id)) continue; // o host já tem os bytes
    const put = await fetchImpl(`${url}/api/sync/files/${f.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: fs.readFileSync(src),
    });
    if (put.ok) files += 1;
  }
  return { added, files };
}

module.exports = { syncOnce, describe, readMeta, reconcile };
