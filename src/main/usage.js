'use strict';
// Quanto espaço em disco o Concordo está usando (salas que eu hospedo + cópias das salas dos amigos). Sem Electron.
const fs = require('node:fs');
const path = require('node:path');

// Soma o tamanho de uma pasta, sem seguir links e com um teto de arquivos para não travar numa pasta gigante.
async function dirSize(dir, { maxEntries = 200000 } = {}) {
  let total = 0;
  let seen = 0;
  const walk = async (d) => {
    let entries;
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (seen++ > maxEntries) return;
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        try {
          total += (await fs.promises.stat(p)).size;
        } catch {
          /* sumiu no meio */
        }
      }
    }
  };
  await walk(dir);
  return total;
}

const isRoomDir = (n) => /^[a-f0-9]{4,32}$/.test(n);

function roomNameOf(dir) {
  try {
    return (JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).room || {}).name || null;
  } catch {
    return null;
  }
}

// { total, rooms: [{ roomId, name, hosted, copy }] } em bytes; 'hosted' = a sala que eu hospedo, 'copy' = minha cópia da sala de outro
async function diskReport({ hostRoot, backupsRoot }) {
  const rooms = new Map();
  const add = async (root, key) => {
    let names = [];
    try {
      names = await fs.promises.readdir(root);
    } catch {
      return;
    }
    for (const n of names.filter(isRoomDir)) {
      const dir = path.join(root, n);
      const r = rooms.get(n) || { roomId: n, name: null, hosted: 0, copy: 0 };
      r[key] = await dirSize(dir);
      r.name = r.name || roomNameOf(dir);
      rooms.set(n, r);
    }
  };
  await add(hostRoot, 'hosted');
  await add(backupsRoot, 'copy');
  const list = [...rooms.values()].sort((a, b) => b.hosted + b.copy - (a.hosted + a.copy));
  return { total: list.reduce((s, r) => s + r.hosted + r.copy, 0), rooms: list };
}

module.exports = { dirSize, diskReport };
