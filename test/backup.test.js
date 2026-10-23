'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConcordoServer } = require('../src/server');
const backup = require('../src/main/backup');

const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `concordo-${n}-`));

async function api(srv, token, method, route, body, raw) {
  const res = await fetch(srv.localUrl + route, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body && !raw ? { 'Content-Type': 'application/json' } : {}) },
    body: raw ? body : body ? JSON.stringify(body) : undefined,
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
  return (await res.json());
}

test('sucessor copia a sala de forma incremental e assume como dono', async () => {
  const dirA = tmp('host');
  const copy = tmp('copy');
  const dirB = tmp('b');
  const A = await createConcordoServer({ dataDir: dirA, roomName: 'Sala', ownerName: 'Ana', getPublicUrl: () => 'http://x' });
  let B;
  try {
    const beto = await join(A, 'Beto');
    const cris = await join(A, 'Cris');
    const ana = A.owner;

    // o herdeiro padrão é o primeiro a entrar
    const st = await api(A, beto.token, 'GET', '/api/state');
    assert.equal(st.json.heir, beto.user.id);

    // só o herdeiro pode copiar
    assert.equal((await api(A, cris.token, 'GET', '/api/backup')).status, 403);
    assert.equal((await api(A, ana.token, 'GET', '/api/backup')).status, 403);

    // conteúdo: mensagem com acento + arquivo
    A.store.addMessage({ channel: 'geral', user: ana, text: 'olá, avó ✓' });
    const up = await api(A, ana.token, 'POST', '/api/channels/geral/upload?name=foto.png', Buffer.from('conteudo-do-arquivo'), true);
    assert.equal(up.status, 201, JSON.stringify(up.json));

    const r1 = await backup.syncOnce({ dir: copy, url: A.localUrl, token: beto.token });
    assert.equal(r1.changed, true);
    assert.equal(r1.downloaded, 1);
    assert.match(fs.readFileSync(path.join(copy, 'messages.jsonl'), 'utf8'), /olá, avó ✓/);

    // sem mudanças: nada a fazer
    const r2 = await backup.syncOnce({ dir: copy, url: A.localUrl, token: beto.token });
    assert.deepEqual(r2, { changed: false, downloaded: 0 });

    // incremental: só a mensagem nova é acrescentada
    A.store.addMessage({ channel: 'geral', user: ana, text: 'segunda' });
    const r3 = await backup.syncOnce({ dir: copy, url: A.localUrl, token: beto.token });
    assert.equal(r3.changed, true);
    const lines = fs.readFileSync(path.join(copy, 'messages.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);

    // o host cai
    await A.close();

    // o sucessor assume usando a cópia
    fs.cpSync(copy, dirB, { recursive: true });
    B = await createConcordoServer({ dataDir: dirB, takeoverUserId: beto.user.id, getPublicUrl: () => 'http://y' });
    assert.equal(B.owner.id, beto.user.id);
    const me = await api(B, beto.token, 'GET', '/api/me');
    assert.equal(me.json.user.role, 'owner');
    // os outros reconhecem a sala com o mesmo token
    const crisMe = await api(B, cris.token, 'GET', '/api/me');
    assert.equal(crisMe.status, 200);
    assert.equal(crisMe.json.user.role, 'member');
    const anaMe = await api(B, ana.token, 'GET', '/api/me');
    assert.equal(anaMe.json.user.role, 'member');
    // histórico e arquivo preservados
    const hist = await api(B, cris.token, 'GET', '/api/channels/geral/messages');
    assert.equal(hist.json.messages.length, 3);
    const fileId = hist.json.messages[1].attachments[0].id;
    const dl = await fetch(B.localUrl + '/api/files/' + fileId, { headers: { Authorization: `Bearer ${cris.token}` } });
    assert.equal(await dl.text(), 'conteudo-do-arquivo');
    // e o dono novo já pode gerar o código de sessão
    assert.equal((await api(B, beto.token, 'GET', '/api/session-code')).status, 200);
  } finally {
    await A.close().catch(() => {});
    if (B) await B.close().catch(() => {});
    for (const d of [dirA, copy, dirB]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('o dono escolhe o sucessor e não pode escolher a si mesmo', async () => {
  const dir = tmp('heir');
  const A = await createConcordoServer({ dataDir: dir, ownerName: 'Ana', getPublicUrl: () => 'http://x' });
  try {
    const beto = await join(A, 'Beto');
    const cris = await join(A, 'Cris');
    assert.equal((await api(A, A.owner.token, 'POST', '/api/heir', { userId: cris.user.id })).status, 200);
    assert.equal((await api(A, beto.token, 'GET', '/api/state')).json.heir, cris.user.id);
    assert.equal((await api(A, A.owner.token, 'POST', '/api/heir', { userId: A.owner.id })).status, 400);
    assert.equal((await api(A, beto.token, 'POST', '/api/heir', { userId: beto.user.id })).status, 403);
    // se o sucessor é removido, vale o próximo mais antigo
    await api(A, A.owner.token, 'DELETE', '/api/users/' + cris.user.id);
    assert.equal((await api(A, beto.token, 'GET', '/api/state')).json.heir, beto.user.id);
  } finally {
    await A.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
