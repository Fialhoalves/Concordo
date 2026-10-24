'use strict';
// v0.17: mensagens assinadas, cargos e moderação, convites, conversas diretas (só texto cifrado, só os dois enxergam).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { createConcordoServer } = require('../src/server');
const { Store } = require('../src/server/store');
const Invite = require('../src/shared/invite');
const Sig = require('../src/shared/sig');

let dir;
let srv;

const call = async (token, method, route, body) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(srv.localUrl + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* sem corpo */
  }
  return { status: res.status, json };
};

// chaves de verdade: Ed25519 para assinar, X25519 só para ter uma chave de conversa válida
function makeKeys() {
  const ed = crypto.generateKeyPairSync('ed25519');
  const x = crypto.generateKeyPairSync('x25519');
  const raw = (k) => k.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
  return { pub: raw(ed.publicKey), dh: raw(x.publicKey), sign: (payload) => crypto.sign(null, Buffer.from(payload), ed.privateKey).toString('base64') };
}

async function joinAs(name, keys) {
  const inv = await call(srv.owner.token, 'POST', '/api/invites', {});
  const code = Invite.decode(inv.json.code);
  const r = await call(null, 'POST', '/api/join', { invite: code.invite, name, ...(keys ? { pub: keys.pub, dh: keys.dh } : {}) });
  return { ...r, token: r.json && r.json.token, id: r.json && r.json.user.id };
}

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
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concordo-sec-'));
  srv = await createConcordoServer({ dataDir: dir, roomName: 'Sala', ownerName: 'Host', getPublicUrl: () => 'https://exemplo.trycloudflare.com' });
});
after(async () => {
  await srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('assinatura: aceita a verdadeira, recusa falsa e sem assinatura; quem não tem chave ainda passa', async () => {
  const k = makeKeys();
  const ana = await joinAs('Ana', k);
  const ws = await connect(ana.token);
  const room = srv.store.room.id;
  const nonce = 'n1';
  const text = 'olá assinado';
  ws.send(JSON.stringify({ t: 'msg', channel: 'geral', text, nonce, sig: k.sign(Sig.msgPayload({ room, channel: 'geral', user: ana.id, nonce, text })) }));
  const ok = await waitFor(() => ws.events.find((e) => e.t === 'msg' && e.message.text === text));
  assert.equal(ok.message.sig.length > 60, true);
  assert.equal(ok.message.nonce, nonce);

  // texto trocado depois de assinar
  ws.send(JSON.stringify({ t: 'msg', channel: 'geral', text: 'outro texto', nonce, sig: k.sign(Sig.msgPayload({ room, channel: 'geral', user: ana.id, nonce, text })) }));
  await waitFor(() => ws.events.find((e) => e.t === 'error' && /assinatura/.test(e.message)));
  // sem assinatura (alguém com o token da Ana, mas sem a chave privada)
  ws.events.length = 0;
  ws.send(JSON.stringify({ t: 'msg', channel: 'geral', text: 'sem assinar' }));
  await waitFor(() => ws.events.find((e) => e.t === 'error' && /assinatura/.test(e.message)));
  // assinada por outra chave
  const other = makeKeys();
  ws.events.length = 0;
  ws.send(JSON.stringify({ t: 'msg', channel: 'geral', text, nonce: 'n2', sig: other.sign(Sig.msgPayload({ room, channel: 'geral', user: ana.id, nonce: 'n2', text })) }));
  await waitFor(() => ws.events.find((e) => e.t === 'error'));
  // não dá para reaproveitar a assinatura em outro canal
  await call(srv.owner.token, 'POST', '/api/channels', { name: 'outro' });
  ws.events.length = 0;
  ws.send(JSON.stringify({ t: 'msg', channel: 'outro', text, nonce, sig: k.sign(Sig.msgPayload({ room, channel: 'geral', user: ana.id, nonce, text })) }));
  await waitFor(() => ws.events.find((e) => e.t === 'error'));

  // app antigo, sem chave registrada: continua falando
  const velho = await joinAs('Velho');
  const wsV = await connect(velho.token);
  wsV.send(JSON.stringify({ t: 'msg', channel: 'geral', text: 'sou do app antigo' }));
  await waitFor(() => wsV.events.find((e) => e.t === 'msg' && e.message.text === 'sou do app antigo'));
  ws.close();
  wsV.close();
});

test('chave: registra uma vez, não troca sozinha, dono ou moderador liberam', async () => {
  const velho = srv.store.users().find((u) => u.name === 'Velho');
  const k = makeKeys();
  assert.equal((await call(velho.token, 'PATCH', '/api/me', { pub: k.pub, dh: k.dh })).status, 200);
  assert.equal((await call(velho.token, 'PATCH', '/api/me', { pub: makeKeys().pub })).status, 409);
  assert.equal((await call(velho.token, 'PATCH', '/api/me', { pub: 'lixo' })).status, 409);
  const reset = await call(srv.owner.token, 'POST', `/api/users/${velho.id}/reset-keys`);
  assert.equal(reset.status, 200);
  assert.equal(reset.json.user.pub, undefined);
  assert.equal((await call(velho.token, 'PATCH', '/api/me', { pub: makeKeys().pub })).status, 200);
});

test('edição assinada e arquivo assinado depois do envio', async () => {
  const k = makeKeys();
  const bia = await joinAs('Bia', k);
  const ws = await connect(bia.token);
  const room = srv.store.room.id;
  const text = 'primeira';
  ws.send(JSON.stringify({ t: 'msg', channel: 'geral', text, nonce: 'a', sig: k.sign(Sig.msgPayload({ room, channel: 'geral', user: bia.id, nonce: 'a', text })) }));
  const msg = (await waitFor(() => ws.events.find((e) => e.t === 'msg' && e.message.text === text))).message;
  const bad = await call(bia.token, 'PATCH', `/api/messages/${msg.id}`, { text: 'editada', nonce: 'b', sig: k.sign('qualquer coisa') });
  assert.equal(bad.status, 400);
  const edit = await call(bia.token, 'PATCH', `/api/messages/${msg.id}`, { text: 'editada', nonce: 'b', sig: k.sign(Sig.editPayload({ room, id: msg.id, user: bia.id, nonce: 'b', text: 'editada' })) });
  assert.equal(edit.status, 200);
  assert.equal(edit.json.message.editNonce, 'b');
  assert.ok(edit.json.message.editSig);

  // arquivo
  const up = await fetch(`${srv.localUrl}/api/channels/geral/upload?name=a.txt`, { method: 'POST', headers: { Authorization: `Bearer ${bia.token}`, 'Content-Length': '3' }, body: 'abc' });
  const fm = (await up.json()).message;
  assert.equal(fm.sig, undefined);
  const payload = Sig.filePayload({ room, id: fm.id, channel: 'geral', user: bia.id, nonce: 'f', attachments: fm.attachments });
  assert.equal((await call(bia.token, 'POST', `/api/messages/${fm.id}/sig`, { nonce: 'f', sig: k.sign('outra coisa') })).status, 400);
  assert.equal((await call(bia.token, 'POST', `/api/messages/${fm.id}/sig`, { nonce: 'f', sig: k.sign(payload) })).status, 200);
  const got = await call(bia.token, 'GET', '/api/channels/geral/messages?limit=100');
  assert.equal(got.json.messages.find((m) => m.id === fm.id).nonce, 'f');
  assert.equal((await call(bia.token, 'POST', `/api/messages/${fm.id}/sig`, { nonce: 'f', sig: k.sign(payload) })).status, 409);
  ws.close();
});

test('moderação: cargo, expulsar, banir com a chave, apagar mensagens', async () => {
  const km = makeKeys();
  const mod = await joinAs('Moderador', km);
  const kv = makeKeys();
  const vit = await joinAs('Vitima', kv);
  const kn = makeKeys();
  const nov = await joinAs('Novato', kn);

  assert.equal((await call(mod.token, 'POST', `/api/users/${vit.id}/role`, { role: 'mod' })).status, 403); // só o dono promove
  assert.equal((await call(srv.owner.token, 'POST', `/api/users/${mod.id}/role`, { role: 'mod' })).status, 200);
  assert.equal((await call(srv.owner.token, 'POST', `/api/users/${srv.owner.id}/role`, { role: 'member' })).status, 400);
  assert.equal((await call(srv.owner.token, 'POST', `/api/users/${mod.id}/role`, { role: 'chefe' })).status, 400);
  assert.equal((await call(nov.token, 'DELETE', `/api/users/${vit.id}`)).status, 403); // membro comum não expulsa
  assert.equal((await call(mod.token, 'DELETE', `/api/users/${srv.owner.id}`)).status, 403); // ninguém expulsa o dono

  // mensagem do dono: moderador não apaga; de membro, apaga
  const ownerMsg = srv.store.addMessage({ channel: 'geral', user: srv.owner, text: 'do dono' });
  const novMsg = srv.store.addMessage({ channel: 'geral', user: srv.store.getUser(nov.id), text: 'do novato' });
  assert.equal((await call(mod.token, 'DELETE', `/api/messages/${ownerMsg.id}`)).status, 403);
  assert.equal((await call(mod.token, 'DELETE', `/api/messages/${novMsg.id}`)).status, 200);
  assert.equal((await call(nov.token, 'DELETE', `/api/messages/${ownerMsg.id}`)).status, 403);

  // banir: some da sala e a mesma chave não entra de novo, nem com convite novo
  const ban = await call(mod.token, 'DELETE', `/api/users/${vit.id}?ban=1`);
  assert.equal(ban.status, 200);
  assert.equal(ban.json.banned, true);
  const inv = await call(srv.owner.token, 'POST', '/api/invites', {});
  const retry = await call(null, 'POST', '/api/join', { invite: Invite.decode(inv.json.code).invite, name: 'Volta', pub: kv.pub, dh: kv.dh });
  assert.equal(retry.status, 403);
  assert.match(retry.json.error || retry.json.message || JSON.stringify(retry.json), /banido/);
  // o convite não foi gasto pela tentativa barrada
  const again = await call(null, 'POST', '/api/join', { invite: Invite.decode(inv.json.code).invite, name: 'Volta', pub: makeKeys().pub });
  assert.equal(again.status, 201);

  // só expulsar: pode voltar
  const kk = makeKeys();
  const chato = await joinAs('Chato', kk);
  assert.equal((await call(mod.token, 'DELETE', `/api/users/${chato.id}`)).status, 200);
  assert.equal((await joinAs('Chato2', kk)).status, 201);
});

test('convites: dono lista e revoga', async () => {
  const inv = await call(srv.owner.token, 'POST', '/api/invites', { maxUses: 3 });
  const token = Invite.decode(inv.json.code).invite;
  const mod = srv.store.users().find((u) => u.role === 'mod');
  assert.equal((await call(mod.token, 'GET', '/api/invites')).status, 403);
  const list = await call(srv.owner.token, 'GET', '/api/invites');
  assert.equal(list.status, 200);
  assert.ok(list.json.invites.some((i) => i.token === token && i.maxUses === 3));
  assert.equal((await call(srv.owner.token, 'DELETE', `/api/invites/${token}`)).status, 200);
  assert.equal((await call(null, 'POST', '/api/join', { invite: token, name: 'Tarde' })).status, 403);
  assert.equal((await call(srv.owner.token, 'DELETE', `/api/invites/${token}`)).status, 404);
});

test('conversa direta: só texto cifrado, só os dois veem, sem busca, sem arquivo, sem edição', async () => {
  const [ka, kb, kc] = [makeKeys(), makeKeys(), makeKeys()];
  const ana = await joinAs('AnaDM', ka);
  const beto = await joinAs('BetoDM', kb);
  const cris = await joinAs('CrisDM', kc);
  const sem = await joinAs('SemChave');
  const room = srv.store.room.id;

  assert.equal((await call(ana.token, 'POST', '/api/dms', { userId: sem.id })).status, 409); // a outra pessoa ainda não tem chave
  assert.equal((await call(ana.token, 'POST', '/api/dms', { userId: ana.id })).status, 400);
  const wsA = await connect(ana.token);
  const wsB = await connect(beto.token);
  const wsC = await connect(cris.token);
  const dm = await call(ana.token, 'POST', '/api/dms', { userId: beto.id });
  assert.equal(dm.status, 201);
  const id = dm.json.channel.id;
  assert.deepEqual(dm.json.channel.members, [ana.id, beto.id].sort());
  assert.equal((await call(beto.token, 'POST', '/api/dms', { userId: ana.id })).json.channel.id, id); // mesma conversa
  await waitFor(() => wsA.events.find((e) => e.t === 'channel' && e.channel.id === id));
  await waitFor(() => wsB.events.find((e) => e.t === 'channel' && e.channel.id === id));
  await settle();
  assert.equal(wsC.events.some((e) => e.t === 'channel' && e.channel.id === id), false, 'a terceira pessoa não fica sabendo');

  const send = (ws, user, k, channel, text, n) => ws.send(JSON.stringify({ t: 'msg', channel, text, nonce: n, sig: k.sign(Sig.msgPayload({ room, channel, user, nonce: n, text })) }));
  send(wsA, ana.id, ka, id, 'texto puro não passa', 'x1');
  await waitFor(() => wsA.events.find((e) => e.t === 'error' && /cifradas/.test(e.message)));
  send(wsA, ana.id, ka, id, 'enc1:AAAABBBBCCCC', 'x2');
  await waitFor(() => wsB.events.find((e) => e.t === 'msg' && e.message.channel === id));
  await settle();
  assert.equal(wsC.events.some((e) => e.t === 'msg' && e.message.channel === id), false, 'mensagem não vaza para a terceira pessoa');

  // a terceira pessoa não lê, não digita junto, não manda
  assert.equal((await call(cris.token, 'GET', `/api/channels/${id}/messages`)).status, 404);
  assert.equal((await call(beto.token, 'GET', `/api/channels/${id}/messages`)).status, 200);
  send(wsC, cris.id, kc, id, 'enc1:XXXX', 'x3');
  await waitFor(() => wsC.events.find((e) => e.t === 'error'));
  const state = await call(cris.token, 'GET', '/api/state');
  assert.equal(state.json.channels.some((c) => c.type === 'dm'), false);
  assert.equal((await call(ana.token, 'GET', '/api/state')).json.channels.some((c) => c.id === id), true);

  // busca não olha conversa direta; arquivo, edição e fixar não valem nela
  assert.equal((await call(ana.token, 'GET', '/api/search?q=AAAA')).json.messages.length, 0);
  const up = await fetch(`${srv.localUrl}/api/channels/${id}/upload?name=a.txt`, { method: 'POST', headers: { Authorization: `Bearer ${ana.token}`, 'Content-Length': '3' }, body: 'abc' });
  assert.equal(up.status, 400);
  const mid = (await call(ana.token, 'GET', `/api/channels/${id}/messages`)).json.messages[0].id;
  assert.equal((await call(ana.token, 'PATCH', `/api/messages/${mid}`, { text: 'enc1:ZZZ', nonce: 'e', sig: ka.sign('x') })).status, 400);
  assert.equal((await call(ana.token, 'POST', `/api/messages/${mid}/pin`)).status, 400);
  assert.equal((await call(cris.token, 'POST', `/api/messages/${mid}/reactions`, { key: 'e:👍' })).status, 404);
  for (const w of [wsA, wsB, wsC]) w.close();
});

test('junção de cópias: conversa direta, chaves e banimentos viajam com a cópia', () => {
  const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `concordo-sec-${n}-`));
  const a = new Store(tmp('a'));
  const b = new Store(tmp('b'));
  const u1 = a.createUser('Um');
  const u2 = a.createUser('Dois');
  const k = makeKeys();
  a.setKeys(u1, { pub: k.pub, dh: k.dh });
  a.setKeys(u2, { pub: makeKeys().pub, dh: makeKeys().dh });
  a.banUser(u2.id);
  a.addDm(u1.id, u1.id === u2.id ? 'x' : srv.owner.id);
  const dmId = a.channels.find((c) => c.type === 'dm').id;
  a.addMessage({ channel: dmId, user: u1, text: 'enc1:AAAA', nonce: 'n', sig: 's' });
  b.mergeState(JSON.parse(JSON.stringify(a.backupState())));
  assert.equal(b.getUser(u1.id).pub, k.pub);
  assert.equal(b.getUser(u1.id).dh, k.dh);
  assert.equal(Object.keys(b.state.banned).length, 1);
  assert.ok(b.hasChannel(dmId, 'text'));
  const lines = fs.readFileSync(a.messagesPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(b.importMessages(lines), 1);
  assert.equal(b.messages.get(dmId)[0].text, 'enc1:AAAA'); // cifrado não é cortado pelo limite de 4000 caracteres das mensagens normais
  assert.equal(b.messages.get(dmId)[0].sig, 's');
});
