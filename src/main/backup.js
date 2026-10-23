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

  const res = await fetchImpl(`${url}/api/backup?rev=${meta.rev}&offset=${offset}`, { headers });
  if (!res.ok) throw new Error(`o servidor recusou a cópia (HTTP ${res.status})`);
  const data = await res.json();

  let changed = false;
  if (!data.unchanged) {
    if (data.reset || offset === 0) fs.writeFileSync(messagesPath, Buffer.from(data.chunk || '', 'latin1'));
    else if (data.chunk) fs.appendFileSync(messagesPath, Buffer.from(data.chunk, 'latin1'));
    writeAtomic(path.join(dir, 'state.json'), JSON.stringify(data.state));
    writeAtomic(path.join(dir, META), JSON.stringify({
      rev: data.rev,
      offset: data.offset,
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
  return { roomId: m.roomId, roomName: m.roomName, at: m.at };
}

module.exports = { syncOnce, describe, readMeta };
