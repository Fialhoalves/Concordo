'use strict';
// Perfil: cor, avatar pequeno, situação e frase; invisível some da lista de online; entradas inválidas são recusadas.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConcordoServer } = require('../src/server');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'concordo-profile-'));
const PIXEL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

async function patch(srv, token, body) {
  const res = await fetch(srv.localUrl + '/api/me', {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test('perfil: salva, aparece para os outros e valida', async () => {
  const srv = await createConcordoServer({ dataDir: tmp(), ownerName: 'Ana', getPublicUrl: () => srv.localUrl, iceServers: [] });
  try {
    const ok = await patch(srv, srv.owner.token, { color: '#0E9F8E', status: 'dnd', statusText: '  jogando  ', avatar: PIXEL });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.user.color, '#0e9f8e');
    assert.equal(ok.json.user.status, 'dnd');
    assert.equal(ok.json.user.statusText, 'jogando');
    assert.equal(ok.json.user.avatar, PIXEL);
    const state = await (await fetch(srv.localUrl + '/api/state', { headers: { Authorization: `Bearer ${srv.owner.token}` } })).json();
    assert.equal(state.users.find((u) => u.id === srv.owner.id).statusText, 'jogando');

    for (const bad of [{ color: 'vermelho' }, { status: 'sumido' }, { avatar: 'data:text/html;base64,AAAA' }, { avatar: 'data:image/png;base64,' + 'A'.repeat(70000) }]) {
      assert.equal((await patch(srv, srv.owner.token, bad)).status, 400, JSON.stringify(bad).slice(0, 40));
    }
    const clear = await patch(srv, srv.owner.token, { color: null, avatar: null, status: 'online', statusText: '' });
    assert.equal(clear.json.user.color, undefined);
    assert.equal(clear.json.user.avatar, undefined);
    assert.equal(clear.json.user.status, undefined);
    assert.equal((await fetch(srv.localUrl + '/api/me', { method: 'PATCH' })).status, 401);
  } finally {
    await srv.close();
  }
});

test('perfil: sobrevive a reabrir a sala', async () => {
  const dir = tmp();
  let srv = await createConcordoServer({ dataDir: dir, ownerName: 'Ana', getPublicUrl: () => srv.localUrl, iceServers: [] });
  const token = srv.owner.token;
  await patch(srv, token, { color: '#2f6fdb', statusText: 'oi' });
  await srv.close();
  srv = await createConcordoServer({ dataDir: dir, ownerName: 'Ana', getPublicUrl: () => srv.localUrl, iceServers: [] });
  try {
    const u = srv.store.getUser(srv.owner.id);
    assert.equal(u.color, '#2f6fdb');
    assert.equal(u.statusText, 'oi');
  } finally {
    await srv.close();
  }
});
