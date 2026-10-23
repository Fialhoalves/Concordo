'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { createConcordoServer } = require('../src/server');
const Invite = require('../src/shared/invite');

const PUBLIC = 'https://exemplo.trycloudflare.com';
let dir;
let srv;
let publicUrl = PUBLIC;

const call = async (token, method, route, body, extraHeaders = {}) => {
  const headers = { ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined && !(body instanceof Buffer)) headers['Content-Type'] = 'application/json';
  const res = await fetch(srv.localUrl + route, {
    method,
    headers,
    body: body === undefined ? undefined : body instanceof Buffer ? body : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* sem corpo JSON */
  }
  return { status: res.status, json, res };
};

const newInvite = async (opts = {}) => {
  const r = await call(srv.owner.token, 'POST', '/api/invites', opts);
  assert.equal(r.status, 201);
  return Invite.decode(r.json.code);
};

const joinAs = async (name) => {
  const inv = await newInvite();
  const r = await call(null, 'POST', '/api/join', { invite: inv.invite, name });
  assert.equal(r.status, 201);
  return r.json;
};

const connect = (token) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?token=${token}`);
    ws.events = [];
    ws.on('message', (d) => ws.events.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });

const waitFor = async (fn, ms = 2000) => {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timeout esperando condição');
    await new Promise((r) => setTimeout(r, 15));
  }
};

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concordo-test-'));
  srv = await createConcordoServer({
    dataDir: dir,
    roomName: 'Sala de teste',
    ownerName: 'Host',
    getPublicUrl: () => publicUrl,
    maxUploadBytes: 1024 * 1024,
  });
});

after(async () => {
  await srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('convite: codifica e decodifica, inclusive com acentos e texto em volta', () => {
  const code = Invite.encode({ url: PUBLIC, roomId: 'abc', roomName: 'Galera do açaí', invite: 'tok' });
  const d = Invite.decode(`olha o convite: ${code} bora!`);
  assert.deepEqual(d, { url: PUBLIC, roomId: 'abc', roomName: 'Galera do açaí', invite: 'tok', rv: '' });
  assert.equal(Invite.decode(code.replace(Invite.PREFIX, '')).roomId, 'abc');
  assert.equal(Invite.decode('lixo qualquer'), null);
  const evil = Invite.encode({ url: 'javascript:alert(1)', roomId: 'x' });
  assert.equal(Invite.decode(evil), null);
});

test('ping é público e informa a sala', async () => {
  const r = await call(null, 'GET', '/api/ping');
  assert.equal(r.status, 200);
  assert.equal(r.json.app, 'concordo');
  assert.equal(r.json.roomName, 'Sala de teste');
});

test('rotas autenticadas exigem token', async () => {
  assert.equal((await call(null, 'GET', '/api/state')).status, 401);
  assert.equal((await call('token-falso', 'GET', '/api/state')).status, 401);
  const ok = await call(srv.owner.token, 'GET', '/api/state');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.you.role, 'owner');
  assert.equal(ok.json.channels[0].id, 'geral');
});

test('convite de uso único: entra uma vez, depois é recusado', async () => {
  const inv = await newInvite();
  const first = await call(null, 'POST', '/api/join', { invite: inv.invite, name: 'Ana' });
  assert.equal(first.status, 201);
  assert.ok(first.json.token);
  const again = await call(null, 'POST', '/api/join', { invite: inv.invite, name: 'Bruno' });
  assert.equal(again.status, 403);
  const fake = await call(null, 'POST', '/api/join', { invite: 'naoexiste', name: 'Carla' });
  assert.equal(fake.status, 403);
});

test('apelido repetido é recusado sem gastar o convite', async () => {
  const inv = await newInvite();
  const dup = await call(null, 'POST', '/api/join', { invite: inv.invite, name: 'ana' });
  assert.equal(dup.status, 409);
  const ok = await call(null, 'POST', '/api/join', { invite: inv.invite, name: 'Diego' });
  assert.equal(ok.status, 201);
});

test('convite ilimitado (maxUses 0) aceita várias pessoas', async () => {
  const inv = await newInvite({ maxUses: 0 });
  for (const n of ['Lia', 'Teo']) {
    const r = await call(null, 'POST', '/api/join', { invite: inv.invite, name: n });
    assert.equal(r.status, 201);
  }
});

test('sem túnel pronto, convites e código de sessão dão 409', async () => {
  publicUrl = null;
  try {
    assert.equal((await call(srv.owner.token, 'POST', '/api/invites', {})).status, 409);
    assert.equal((await call(srv.owner.token, 'GET', '/api/session-code')).status, 409);
  } finally {
    publicUrl = PUBLIC;
  }
});

test('código de sessão não carrega convite', async () => {
  const r = await call(srv.owner.token, 'GET', '/api/session-code');
  const d = Invite.decode(r.json.code);
  assert.equal(d.invite, '');
  assert.equal(d.roomId, srv.store.room.id);
});

test('só o dono cria convites, canais e remove gente', async () => {
  const member = await joinAs('Membro1');
  assert.equal((await call(member.token, 'POST', '/api/invites', {})).status, 403);
  assert.equal((await call(member.token, 'POST', '/api/channels', { name: 'x' })).status, 403);
  assert.equal((await call(member.token, 'DELETE', `/api/users/${srv.owner.id}`)).status, 403);
});

test('canais: cria, normaliza o nome e recusa duplicado', async () => {
  const r = await call(srv.owner.token, 'POST', '/api/channels', { name: '  Jogos & Diversão!  ' });
  assert.equal(r.status, 201);
  assert.equal(r.json.channel.id, 'jogos-diversao');
  assert.equal((await call(srv.owner.token, 'POST', '/api/channels', { name: 'jogos-diversao' })).status, 400);
  assert.equal((await call(srv.owner.token, 'POST', '/api/channels', { name: '!!!' })).status, 400);
});

test('websocket: mensagem chega para todos, com presença', async () => {
  const a = await joinAs('WsA');
  const b = await joinAs('WsB');
  const wa = await connect(a.token);
  const wb = await connect(b.token);
  try {
    await waitFor(() => wa.events.some((e) => e.t === 'presence' && e.online.includes(b.user.id)));
    wa.send(JSON.stringify({ t: 'msg', channel: 'geral', text: '  oi, galera  ' }));
    const got = await waitFor(() => wb.events.find((e) => e.t === 'msg'));
    assert.equal(got.message.text, 'oi, galera');
    assert.equal(got.message.userId, a.user.id);
    assert.equal(got.message.author, 'WsA');
    // o remetente também recebe o eco
    await waitFor(() => wa.events.find((e) => e.t === 'msg'));
  } finally {
    wa.close();
    wb.close();
  }
});

test('websocket: recusa token inválido e mensagens inválidas', async () => {
  await assert.rejects(connect('token-falso'));
  const a = await joinAs('WsC');
  const ws = await connect(a.token);
  try {
    ws.send(JSON.stringify({ t: 'msg', channel: 'inexistente', text: 'oi' }));
    ws.send(JSON.stringify({ t: 'msg', channel: 'geral', text: '   ' }));
    ws.send(JSON.stringify({ t: 'msg', channel: 'geral', text: 'x'.repeat(5000) }));
    await waitFor(() => ws.events.filter((e) => e.t === 'error').length === 3);
  } finally {
    ws.close();
  }
});

test('websocket: limite de mensagens seguidas', async () => {
  const a = await joinAs('Spammer');
  const ws = await connect(a.token);
  try {
    for (let i = 0; i < 14; i++) ws.send(JSON.stringify({ t: 'msg', channel: 'geral', text: `spam ${i}` }));
    await waitFor(() => ws.events.some((e) => e.t === 'error' && /devagar/.test(e.message)));
    assert.equal(ws.events.filter((e) => e.t === 'msg').length, 10);
  } finally {
    ws.close();
  }
});

test('histórico com paginação', async () => {
  const owner = srv.owner;
  for (let i = 0; i < 7; i++) srv.store.addMessage({ channel: 'jogos-diversao', user: owner, text: `m${i}` });
  const page1 = await call(owner.token, 'GET', '/api/channels/jogos-diversao/messages?limit=3');
  assert.deepEqual(page1.json.messages.map((m) => m.text), ['m4', 'm5', 'm6']);
  assert.equal(page1.json.hasMore, true);
  const before = page1.json.messages[0].id;
  const page2 = await call(owner.token, 'GET', `/api/channels/jogos-diversao/messages?limit=10&before=${before}`);
  assert.deepEqual(page2.json.messages.map((m) => m.text), ['m0', 'm1', 'm2', 'm3']);
  assert.equal(page2.json.hasMore, false);
  assert.equal((await call(owner.token, 'GET', '/api/channels/nao-existe/messages')).status, 404);
});

test('upload e download de arquivo, com tipo seguro', async () => {
  const member = await joinAs('Uploader');
  const ws = await connect(srv.owner.token);
  try {
    const payload = Buffer.from('conteúdo do arquivo de teste');
    const up = await call(member.token, 'POST', '/api/channels/geral/upload?name=' + encodeURIComponent('relatório final.txt'), payload);
    assert.equal(up.status, 201);
    const att = up.json.message.attachments[0];
    assert.equal(att.name, 'relatório final.txt');
    assert.equal(att.size, payload.length);
    assert.equal(att.type, 'application/octet-stream');
    await waitFor(() => ws.events.find((e) => e.t === 'msg' && e.message.attachments.length));

    const down = await fetch(`${srv.localUrl}/api/files/${att.id}?token=${member.token}`);
    assert.equal(down.status, 200);
    assert.equal(Buffer.from(await down.arrayBuffer()).toString(), payload.toString());
    assert.match(down.headers.get('content-disposition'), /^attachment;/);
    assert.equal(down.headers.get('x-content-type-options'), 'nosniff');

    // HTML enviado nunca é servido como HTML
    const html = await call(member.token, 'POST', '/api/channels/geral/upload?name=evil.html', Buffer.from('<script>alert(1)</script>'));
    const dh = await fetch(`${srv.localUrl}/api/files/${html.json.message.attachments[0].id}?token=${member.token}`);
    assert.equal(dh.headers.get('content-type'), 'application/octet-stream');

    // PNG pode aparecer inline
    const png = await call(member.token, 'POST', '/api/channels/geral/upload?name=foto.PNG', Buffer.from('89504e47', 'hex'));
    const dp = await fetch(`${srv.localUrl}/api/files/${png.json.message.attachments[0].id}?token=${member.token}`);
    assert.equal(dp.headers.get('content-type'), 'image/png');
    assert.match(dp.headers.get('content-disposition'), /^inline;/);

    // sem token não baixa; id malformado não vaza nada
    assert.equal((await fetch(`${srv.localUrl}/api/files/${att.id}`)).status, 401);
    assert.equal((await call(member.token, 'GET', '/api/files/..%2f..%2fstate.json')).status, 404);
  } finally {
    ws.close();
  }
});

test('upload acima do limite é recusado e não deixa lixo em disco', async () => {
  const member = await joinAs('Pesado');
  const before = fs.readdirSync(srv.store.uploadsDir).length;
  const big = Buffer.alloc(1024 * 1024 + 1, 1);
  const r = await call(member.token, 'POST', '/api/channels/geral/upload?name=grande.bin', big);
  assert.equal(r.status, 413);
  assert.equal(fs.readdirSync(srv.store.uploadsDir).length, before);
});

test('upload sanitiza o nome do arquivo (sem caminhos)', async () => {
  const member = await joinAs('Caminhos');
  const r = await call(member.token, 'POST', '/api/channels/geral/upload?name=' + encodeURIComponent('..\\..\\etc/passwd'), Buffer.from('x'));
  assert.equal(r.json.message.attachments[0].name, 'passwd');
});

test('remover membro: token deixa de valer e o socket é fechado', async () => {
  const victim = await joinAs('Vitima');
  const ws = await connect(victim.token);
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  const owner = await connect(srv.owner.token);
  try {
    const r = await call(srv.owner.token, 'DELETE', `/api/users/${victim.user.id}`);
    assert.equal(r.status, 200);
    assert.equal(await closed, 4001);
    assert.equal((await call(victim.token, 'GET', '/api/me')).status, 401);
    await waitFor(() => owner.events.find((e) => e.t === 'user_removed' && e.id === victim.user.id));
    assert.equal((await call(srv.owner.token, 'DELETE', `/api/users/${srv.owner.id}`)).status, 400);
  } finally {
    owner.close();
  }
});

test('persistência: reiniciar o servidor mantém usuários, canais e mensagens', async () => {
  const member = await joinAs('Persistente');
  const ws = await connect(member.token);
  ws.send(JSON.stringify({ t: 'msg', channel: 'geral', text: 'sobrevive ao reinício' }));
  await waitFor(() => ws.events.find((e) => e.t === 'msg'));
  ws.close();
  const roomId = srv.store.room.id;
  await srv.close();

  srv = await createConcordoServer({
    dataDir: dir,
    ownerName: 'Host',
    getPublicUrl: () => publicUrl,
    maxUploadBytes: 1024 * 1024,
  });
  assert.equal(srv.store.room.id, roomId);
  const me = await call(member.token, 'GET', '/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.user.name, 'Persistente');
  const hist = await call(member.token, 'GET', '/api/channels/geral/messages?limit=100');
  assert.ok(hist.json.messages.some((m) => m.text === 'sobrevive ao reinício'));
  const state = await call(srv.owner.token, 'GET', '/api/state');
  assert.ok(state.json.channels.some((c) => c.id === 'jogos-diversao'));
});

test('JSON inválido e rota inexistente têm respostas limpas', async () => {
  const res = await fetch(srv.localUrl + '/api/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{quebrado',
  });
  assert.equal(res.status, 400);
  assert.equal((await call(srv.owner.token, 'GET', '/api/nada')).status, 404);
  const pre = await fetch(srv.localUrl + '/api/state', { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
});

test('reações em mensagens: alterna, aparece no histórico e persiste no estado', async () => {
  const a = await joinAs('Reage1');
  const b = await joinAs('Reage2');
  const wsB = await connect(b.token);
  const wsA = await connect(a.token);
  wsA.send(JSON.stringify({ t: 'msg', channel: 'geral', text: 'reaja aqui' }));
  const m = (await waitFor(() => wsB.events.find((e) => e.t === 'msg' && e.message.text === 'reaja aqui'))).message;

  let r = await call(b.token, 'POST', `/api/messages/${m.id}/reactions`, { key: 's:feliz' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.reactions['s:feliz'], [b.user.id]);
  const ev = await waitFor(() => wsA.events.find((e) => e.t === 'reaction' && e.id === m.id));
  assert.equal(ev.channel, 'geral');

  await call(a.token, 'POST', `/api/messages/${m.id}/reactions`, { key: 's:feliz' });
  const hist = await call(a.token, 'GET', '/api/channels/geral/messages');
  const got = hist.json.messages.find((x) => x.id === m.id);
  assert.equal(got.reactions['s:feliz'].length, 2);

  // tirar a reação de novo
  r = await call(b.token, 'POST', `/api/messages/${m.id}/reactions`, { key: 's:feliz' });
  assert.deepEqual(r.json.reactions['s:feliz'], [a.user.id]);

  assert.equal((await call(a.token, 'POST', `/api/messages/${m.id}/reactions`, { key: 'x:invalida' })).status, 400);
  assert.equal((await call(a.token, 'POST', '/api/messages/ffffffff/reactions', { key: 'e:🔥' })).status, 404);
  wsA.close();
  wsB.close();
});

test('reação ao vivo na chamada: só chega a quem está no mesmo canal de voz', async () => {
  const a = await joinAs('Live1');
  const b = await joinAs('Live2');
  const c = await joinAs('Live3');
  const [wa, wb, wc] = [await connect(a.token), await connect(b.token), await connect(c.token)];
  wa.send(JSON.stringify({ t: 'voice_join', channel: 'voz' }));
  wb.send(JSON.stringify({ t: 'voice_join', channel: 'voz' }));
  await waitFor(() => wb.events.find((e) => e.t === 'voice_joined'));
  wa.send(JSON.stringify({ t: 'live_react', key: 's:oculos' }));
  const got = await waitFor(() => wb.events.find((e) => e.t === 'live_react'));
  assert.equal(got.from, a.user.id);
  assert.equal(got.key, 's:oculos');
  wc.send(JSON.stringify({ t: 'live_react', key: 's:oculos' })); // fora da chamada: ignorado
  wa.send(JSON.stringify({ t: 'live_react', key: 'qualquer' })); // inválida: ignorada
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(wb.events.filter((e) => e.t === 'live_react').length, 1);
  assert.equal(wc.events.filter((e) => e.t === 'live_react').length, 0);
  [wa, wb, wc].forEach((w) => w.close());
});

test('/api/me entrega o ponto de encontro só a membros e os códigos o levam junto', async () => {
  srv.store.setRendezvous({ id: 'abcdef123', key: 'k'.repeat(24) });
  const me = await call(srv.owner.token, 'GET', '/api/me');
  assert.equal(me.json.rv, 'abcdef123.' + 'k'.repeat(24));
  assert.equal((await call(null, 'GET', '/api/me')).status, 401);
  const code = (await call(srv.owner.token, 'GET', '/api/session-code')).json.code;
  assert.equal(Invite.decode(code).rv, me.json.rv);
});
