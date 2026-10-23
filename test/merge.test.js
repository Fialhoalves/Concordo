'use strict';
// Cópias que se afastaram (host novo reaberto de uma cópia mais velha) voltam a se juntar por ID, sem perder nem duplicar.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConcordoServer } = require('../src/server');
const { Store } = require('../src/server/store');
const backup = require('../src/main/backup');
const Rendezvous = require('../src/main/rendezvous');

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `concordo-${n}-`));

async function api(srv, token, method, route, body) {
  const res = await fetch(srv.localUrl + route, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function join(srv, name) {
  const inv = srv.store.createInvite({ maxUses: 1, hours: 1 });
  const res = await fetch(srv.localUrl + '/api/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ invite: inv.token, name }),
  });
  return res.json();
}

const texts = (dir) =>
  fs
    .readFileSync(path.join(dir, 'messages.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l).text);

test('geração sobe na troca de host e a linha do tempo muda', () => {
  const dir = tmp('epoch');
  const s = new Store(dir);
  const lineage = s.room.lineage;
  assert.equal(s.epoch, 1);
  assert.equal(s.bumpEpoch(4), 5); // acima de qualquer geração já vista
  assert.notEqual(s.room.lineage, lineage);
  s.flush();
  assert.equal(new Store(dir).epoch, 5);
});

test('importar mensagens: sem duplicar, ordenado por data e sobrevive a reiniciar', () => {
  const dir = tmp('imp');
  const s = new Store(dir);
  const owner = s.createUser('Ana', 'owner');
  const a = s.addMessage({ channel: 'geral', user: owner, text: 'a' });
  const mk = (id, ts, text) => ({ id, channel: 'geral', userId: owner.id, author: 'Ana', text, attachments: [], ts });
  const older = mk('1'.repeat(16), a.ts - 5000, 'mais antiga');
  const newer = mk('2'.repeat(16), a.ts + 5000, 'mais nova');
  assert.equal(s.importMessages([newer, older, a, { ...older }]), 2); // `a` e a repetida são ignoradas
  assert.equal(s.importMessages([older]), 0);
  assert.equal(s.importMessages([mk('zz', a.ts, 'id ruim'), mk('3'.repeat(16), a.ts, 'canal ruim')].map((m, i) => (i ? { ...m, channel: 'nao-existe' } : m))), 0);
  assert.deepEqual(s.getMessages('geral').messages.map((m) => m.text), ['mais antiga', 'a', 'mais nova']);
  s.flush();
  const again = new Store(dir);
  assert.deepEqual(again.getMessages('geral').messages.map((m) => m.text), ['mais antiga', 'a', 'mais nova']);
});

test('junção de estado: acrescenta, edição mais nova vence e removido não ressuscita', () => {
  const s = new Store(tmp('mst'));
  const owner = s.createUser('Ana', 'owner');
  const bia = s.createUser('Bia');
  const m = s.addMessage({ channel: 'geral', user: owner, text: 'oi' });
  s.editMessage(m.id, owner.id, 'versão do host');
  s.state.edits[m.id].at = 1000;
  s.removeUser(bia.id);

  s.mergeState({
    users: {
      [bia.id]: { id: bia.id, name: 'Bia', role: 'owner', tokenHash: 'h'.repeat(64) }, // removida: não volta
      aaaaaaaaaaaa: { id: 'aaaaaaaaaaaa', name: 'Caio', role: 'owner', tokenHash: 'c'.repeat(64), createdAt: 5 },
    },
    channels: [{ id: 'extra', name: 'extra', type: 'text' }, { id: 'geral', name: 'geral', type: 'text' }],
    edits: { [m.id]: { text: 'edição mais nova', at: 2000 } },
    deleted: {},
    pins: {},
    reactions: {},
  });
  assert.equal(s.getUser(bia.id), null);
  const caio = s.getUser('aaaaaaaaaaaa');
  assert.equal(caio.role, 'member', 'quem chega pela junção nunca vira dono');
  assert.equal(s.userByToken('x'), null);
  assert.ok(s.hasChannel('extra', 'text'));
  assert.equal(s.channels.filter((c) => c.id === 'geral').length, 1);
  assert.equal(s.getMessage(m.id).text, 'edição mais nova');
  s.mergeState({ edits: { [m.id]: { text: 'velha', at: 1500 } } });
  assert.equal(s.getMessage(m.id).text, 'edição mais nova');
});

test('X tem a cópia mais nova, Y reabre com a mais velha: ao X voltar nada se perde', async () => {
  const dirH = tmp('host');
  const copyX = tmp('copyX');
  const copyY = tmp('copyY');
  const dirY = tmp('hostY');
  const H = await createConcordoServer({ dataDir: dirH, roomName: 'Sala', ownerName: 'Host', getPublicUrl: () => 'http://h' });
  let Y;
  try {
    const x = await join(H, 'Xavier');
    const y = await join(H, 'Yara');
    for (const t of ['m1', 'm2', 'm3']) H.store.addMessage({ channel: 'geral', user: H.owner, text: t });
    await backup.syncOnce({ dir: copyY, url: H.localUrl, token: y.token }); // Y copia até m3
    H.store.addMessage({ channel: 'geral', user: H.owner, text: 'm4 (só X viu)' });
    await backup.syncOnce({ dir: copyX, url: H.localUrl, token: x.token }); // X copia até m4
    assert.deepEqual(texts(copyX), ['m1', 'm2', 'm3', 'm4 (só X viu)']);
    const roomId = H.store.room.id;
    await H.close();

    // Y reabre com a cópia mais velha: geração nova
    fs.cpSync(copyY, dirY, { recursive: true });
    Y = await createConcordoServer({ dataDir: dirY, takeoverUserId: y.user.id, takeoverToken: y.token, minEpoch: 1, getPublicUrl: () => 'http://y' });
    assert.equal(Y.store.epoch, 2);
    Y.store.addMessage({ channel: 'geral', user: Y.owner, text: 'm5 (Y, já na sala nova)' });

    // X entra na sala de Y: o app devolve o que só ele tem
    const r = await backup.reconcile({ dir: copyX, url: Y.localUrl, token: x.token });
    assert.equal(r.added, 1);
    const seen = (await api(Y, x.token, 'GET', '/api/channels/geral/messages')).json.messages.map((m) => m.text);
    assert.deepEqual(seen, ['m1', 'm2', 'm3', 'm4 (só X viu)', 'm5 (Y, já na sala nova)']);

    // repetir não duplica
    assert.equal((await backup.reconcile({ dir: copyX, url: Y.localUrl, token: x.token })).added, 0);

    // depois X baixa a linha do tempo nova por inteiro (nada de emendar bytes de arquivos diferentes)
    const s = await backup.syncOnce({ dir: copyX, url: Y.localUrl, token: x.token });
    assert.equal(s.changed, true);
    assert.deepEqual(texts(copyX).sort(), ['m1', 'm2', 'm3', 'm4 (só X viu)', 'm5 (Y, já na sala nova)'].sort());
    assert.equal(backup.describe(copyX).epoch, 2);
    assert.equal(backup.describe(copyX).roomId, roomId);

    // com a mesma linha do tempo não há o que devolver
    assert.equal((await backup.reconcile({ dir: copyX, url: Y.localUrl, token: x.token })).skipped, 'mesma linha do tempo');
  } finally {
    if (Y) await Y.close();
    await H.close().catch(() => {});
  }
});

test('host antigo que volta (geração menor) não sobrescreve a cópia nova nem recebe junção', async () => {
  const dirH = tmp('old');
  const copy = tmp('copy');
  const H = await createConcordoServer({ dataDir: dirH, ownerName: 'Host', getPublicUrl: () => 'http://h' });
  try {
    const x = await join(H, 'Xavier');
    H.store.addMessage({ channel: 'geral', user: H.owner, text: 'antiga' });
    await backup.syncOnce({ dir: copy, url: H.localUrl, token: x.token });
    // a cópia de X vem de uma geração mais nova
    const meta = JSON.parse(fs.readFileSync(path.join(copy, 'backup-meta.json'), 'utf8'));
    meta.epoch = 3;
    fs.writeFileSync(path.join(copy, 'backup-meta.json'), JSON.stringify(meta));
    H.store.addMessage({ channel: 'geral', user: H.owner, text: 'nova no host velho' });
    const r = await backup.syncOnce({ dir: copy, url: H.localUrl, token: x.token });
    assert.equal(r.stale, true);
    assert.deepEqual(texts(copy), ['antiga']);
    assert.equal((await backup.reconcile({ dir: copy, url: H.localUrl, token: x.token })).stale, true);
  } finally {
    await H.close();
  }
});

test('anexo que só um membro tem volta para o host junto com a mensagem', async () => {
  const dirH = tmp('fh');
  const copy = tmp('fc');
  const dirY = tmp('fy');
  const H = await createConcordoServer({ dataDir: dirH, ownerName: 'Host', getPublicUrl: () => 'http://h' });
  let Y;
  try {
    const x = await join(H, 'Xavier');
    const y = await join(H, 'Yara');
    const copyY = tmp('fcy');
    await backup.syncOnce({ dir: copyY, url: H.localUrl, token: y.token });
    const up = await fetch(`${H.localUrl}/api/channels/geral/upload?name=foto.png`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${H.owner.token}`, 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('bytes-do-anexo'),
    });
    const { message } = await up.json();
    await backup.syncOnce({ dir: copy, url: H.localUrl, token: x.token });
    await H.close();
    fs.cpSync(copyY, dirY, { recursive: true });
    Y = await createConcordoServer({ dataDir: dirY, takeoverUserId: y.user.id, takeoverToken: y.token, getPublicUrl: () => 'http://y' });
    const r = await backup.reconcile({ dir: copy, url: Y.localUrl, token: x.token });
    assert.equal(r.added, 1);
    assert.equal(r.files, 1);
    const fileId = message.attachments[0].id;
    const dl = await fetch(`${Y.localUrl}/api/files/${fileId}`, { headers: { Authorization: `Bearer ${x.token}` } });
    assert.equal(dl.status, 200);
    assert.equal(Buffer.from(await dl.arrayBuffer()).toString(), 'bytes-do-anexo');
  } finally {
    if (Y) await Y.close();
    await H.close().catch(() => {});
  }
});

test('ponteiro com geração: assinatura cobre geração e dono; formato antigo continua valendo', async () => {
  const http = require('node:http');
  const blobs = new Map();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const m = req.url.match(/^\/api\/jsonBlob(?:\/([\w-]+))?$/);
      if (req.method === 'POST') {
        blobs.set('blob1blob1x', body);
        res.writeHead(201, { Location: `http://${req.headers.host}/api/jsonBlob/blob1blob1x` });
        return res.end(body);
      }
      if (req.method === 'PUT') blobs.set(m[1], body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(blobs.get(m[1]));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api/jsonBlob`;
  try {
    const rv = await Rendezvous.create({ base });
    await Rendezvous.publish(rv, 'https://a.trycloudflare.com', { base, epoch: 3, owner: 'abc123abc123', ownerName: 'Yara' });
    const got = await Rendezvous.resolve(Rendezvous.format(rv), { base });
    assert.equal(got.e, 3);
    assert.equal(got.o, 'abc123abc123');
    assert.equal(got.n, 'Yara');

    // trocar a geração sem a chave invalida a assinatura
    const doc = JSON.parse(blobs.get(rv.id));
    doc.e = 99;
    blobs.set(rv.id, JSON.stringify(doc));
    assert.equal(await Rendezvous.resolve(Rendezvous.format(rv), { base }), null);

    // formato antigo (sem geração) ainda é aceito
    await Rendezvous.publish(rv, 'https://velho.trycloudflare.com', { base });
    const old = await Rendezvous.resolve(Rendezvous.format(rv), { base });
    assert.equal(old.url, 'https://velho.trycloudflare.com');
    assert.equal(old.e, 0);
  } finally {
    server.close();
  }
});
