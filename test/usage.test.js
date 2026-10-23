'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createConcordoServer } = require('../src/server');
const backup = require('../src/main/backup');
const usage = require('../src/main/usage');

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `concordo-${n}-`));

test('disco: soma pastas por sala (hospedada e cópia) e ignora o que não é sala', async () => {
  const root = tmp('disk');
  const host = path.join(root, 'host');
  const bk = path.join(root, 'backups');
  fs.mkdirSync(path.join(host, 'aaaa1111bbbb', 'uploads'), { recursive: true });
  fs.writeFileSync(path.join(host, 'aaaa1111bbbb', 'state.json'), JSON.stringify({ room: { name: 'Minha' } }));
  fs.writeFileSync(path.join(host, 'aaaa1111bbbb', 'uploads', 'f'), Buffer.alloc(1000));
  fs.mkdirSync(path.join(bk, 'cccc2222dddd'), { recursive: true });
  fs.writeFileSync(path.join(bk, 'cccc2222dddd', 'messages.jsonl'), Buffer.alloc(500));
  fs.mkdirSync(path.join(bk, 'lixo-qualquer'), { recursive: true });
  fs.writeFileSync(path.join(bk, 'lixo-qualquer', 'x'), Buffer.alloc(9999));
  const r = await usage.diskReport({ hostRoot: host, backupsRoot: bk });
  assert.equal(r.rooms.length, 2);
  const mine = r.rooms.find((x) => x.roomId === 'aaaa1111bbbb');
  assert.equal(mine.name, 'Minha');
  assert.ok(mine.hosted >= 1000 && mine.copy === 0);
  assert.equal(r.rooms.find((x) => x.roomId === 'cccc2222dddd').copy, 500);
  assert.equal(r.total, r.rooms.reduce((s, x) => s + x.hosted + x.copy, 0));
  assert.equal((await usage.diskReport({ hostRoot: path.join(root, 'nada'), backupsRoot: path.join(root, 'nada2') })).total, 0);
});

test('servidor conta o tráfego que passou por ele e libera a medição de arquivos', async () => {
  const srv = await createConcordoServer({ dataDir: tmp('tr'), ownerName: 'Ana', getPublicUrl: () => 'http://x' });
  try {
    const before = srv.traffic();
    const res = await fetch(srv.localUrl + '/api/ping');
    assert.equal(res.headers.get('timing-allow-origin'), '*');
    await res.text();
    await new Promise((r) => setTimeout(r, 50));
    const after = srv.traffic();
    assert.ok(after.out > before.out && after.in > before.in, JSON.stringify({ before, after }));
  } finally {
    await srv.close();
  }
});

test('cópia respeita o limite de anexos (0 = nenhum, valor = até aquele tamanho)', async () => {
  const dirH = tmp('capH');
  const H = await createConcordoServer({ dataDir: dirH, ownerName: 'Ana', getPublicUrl: () => 'http://x' });
  try {
    const inv = H.store.createInvite({ maxUses: 1, hours: 1 });
    const { token } = await (await fetch(H.localUrl + '/api/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ invite: inv.token, name: 'Beto' }) })).json();
    const up = (name, size) => fetch(`${H.localUrl}/api/channels/geral/upload?name=${name}`, { method: 'POST', headers: { Authorization: `Bearer ${H.owner.token}` }, body: Buffer.alloc(size, 1) });
    await up('pequeno.bin', 100);
    await up('grande.bin', 5000);
    const c1 = tmp('c1');
    assert.equal((await backup.syncOnce({ dir: c1, url: H.localUrl, token, maxFileBytes: 1000 })).downloaded, 1);
    const c0 = tmp('c0');
    assert.equal((await backup.syncOnce({ dir: c0, url: H.localUrl, token, maxFileBytes: 0 })).downloaded, 0);
    const cAll = tmp('cAll');
    assert.equal((await backup.syncOnce({ dir: cAll, url: H.localUrl, token })).downloaded, 2);
    // as mensagens e os metadados dos anexos vêm sempre, só os bytes grandes ficam de fora
    assert.match(fs.readFileSync(path.join(c0, 'messages.jsonl'), 'utf8'), /grande\.bin/);
  } finally {
    await H.close();
  }
});

test('medidor: soma o que cresceu, trata reinício de contador e guarda por dia', () => {
  const store = {};
  const win = {};
  const ctx = { window: win, localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => (store[k] = v) }, setTimeout: () => 0, Date };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/meter.js'), 'utf8'), ctx);
  const M = win.ConcordoMeter;
  M.add('chat', 'down', 1000);
  M.add('chat', 'up', 200);
  M.absolute('voice', 'c1', { up: 500, down: 700 });
  M.absolute('voice', 'c1', { up: 800, down: 1000 }); // só a diferença
  M.absolute('voice', 'c1', { up: 100, down: 50 }); // contador reiniciou
  const snap = M.snapshot();
  assert.equal(snap.session.chat.down, 1000);
  assert.equal(snap.session.voice.up, 500 + 300 + 100);
  assert.equal(snap.session.voice.down, 700 + 300 + 50);
  assert.equal(snap.today.chat.down, 1000);
  assert.equal(M.bytes(1536), '1,5 KB');
  assert.equal(M.speed(3 * 1048576), '3,0 MB/s');
  M.flush();
  assert.equal(Object.keys(JSON.parse(store['concordo.usage']).days).length, 1);
});
