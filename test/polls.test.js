'use strict';
// v0.18: enquetes (assinadas, votos, encerrar) e soundboard da chamada.
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
const Soundboard = require('../src/shared/soundboard');

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

function makeKeys() {
  const ed = crypto.generateKeyPairSync('ed25519');
  const x = crypto.generateKeyPairSync('x25519');
  const raw = (k) => k.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
  return { pub: raw(ed.publicKey), dh: raw(x.publicKey), sign: (payload) => crypto.sign(null, Buffer.from(payload), ed.privateKey).toString('base64') };
}
async function joinAs(name, keys) {
  const inv = await call(srv.owner.token, 'POST', '/api/invites', {});
  const r = await call(null, 'POST', '/api/join', { invite: Invite.decode(inv.json.code).invite, name, ...(keys ? { pub: keys.pub, dh: keys.dh } : {}) });
  return { token: r.json.token, id: r.json.user.id };
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concordo-poll-'));
  srv = await createConcordoServer({ dataDir: dir, roomName: 'Sala', ownerName: 'Host', getPublicUrl: () => 'https://exemplo.trycloudflare.com' });
});
after(async () => {
  await srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('enquete: assinada, valida opções, votos e encerramento', async () => {
  const k = makeKeys();
  const ana = await joinAs('Ana', k);
  const beto = await joinAs('Beto', makeKeys());
  const cris = await joinAs('Cris');
  const ws = await connect(ana.token);
  const room = srv.store.room.id;
  const sendPoll = (text, poll, n) => ws.send(JSON.stringify({ t: 'msg', channel: 'geral', text, poll, nonce: n, sig: k.sign(Sig.pollPayload({ room, channel: 'geral', user: ana.id, nonce: n, text, options: poll.options, multi: poll.multi })) }));

  // opções inválidas: 1 opção, repetidas, vazia, demais
  for (const bad of [{ options: ['só uma'] }, { options: ['a', 'A'] }, { options: ['a', ''] }, { options: ['1', '2', '3', '4', '5', '6', '7'] }]) {
    ws.events.length = 0;
    sendPoll('Pergunta?', bad, 'x');
    await waitFor(() => ws.events.find((e) => e.t === 'error' && /enquete/.test(e.message)));
  }
  // assinatura de texto comum não vale para enquete (outra etiqueta)
  ws.events.length = 0;
  ws.send(JSON.stringify({ t: 'msg', channel: 'geral', text: 'Pergunta?', poll: { options: ['sim', 'não'] }, nonce: 'n', sig: k.sign(Sig.msgPayload({ room, channel: 'geral', user: ana.id, nonce: 'n', text: 'Pergunta?' })) }));
  await waitFor(() => ws.events.find((e) => e.t === 'error' && /assinatura/.test(e.message)));
  // opções trocadas depois de assinar
  ws.events.length = 0;
  ws.send(JSON.stringify({ t: 'msg', channel: 'geral', text: 'Pergunta?', poll: { options: ['sim', 'talvez'] }, nonce: 'n', sig: k.sign(Sig.pollPayload({ room, channel: 'geral', user: ana.id, nonce: 'n', text: 'Pergunta?', options: ['sim', 'não'], multi: false })) }));
  await waitFor(() => ws.events.find((e) => e.t === 'error' && /assinatura/.test(e.message)));

  ws.events.length = 0;
  sendPoll('Pizza hoje?', { options: ['sim', 'não', 'talvez'], multi: false }, 'ok1');
  const msg = (await waitFor(() => ws.events.find((e) => e.t === 'msg' && e.message.poll))).message;
  assert.deepEqual(msg.poll, { options: ['sim', 'não', 'talvez'], multi: false });

  // votos
  assert.equal((await call(beto.token, 'POST', `/api/messages/${msg.id}/vote`, { options: [0] })).status, 200);
  assert.equal((await call(cris.token, 'POST', `/api/messages/${msg.id}/vote`, { options: [0] })).status, 200);
  assert.equal((await call(ana.token, 'POST', `/api/messages/${msg.id}/vote`, { options: [1] })).status, 200);
  assert.equal((await call(ana.token, 'POST', `/api/messages/${msg.id}/vote`, { options: [0, 1] })).status, 400, 'enquete de resposta única não aceita duas');
  assert.equal((await call(ana.token, 'POST', `/api/messages/${msg.id}/vote`, { options: [9] })).status, 400);
  const got = (await call(beto.token, 'GET', '/api/channels/geral/messages?limit=100')).json.messages.find((m) => m.id === msg.id);
  assert.deepEqual(got.votes[0].sort(), [beto.id, cris.id].sort());
  assert.deepEqual(got.votes[1], [ana.id]);
  // mudar o voto e tirar o voto
  await call(beto.token, 'POST', `/api/messages/${msg.id}/vote`, { options: [2] });
  const changed = (await call(beto.token, 'POST', `/api/messages/${msg.id}/vote`, { options: [2] })).json.message;
  assert.deepEqual(changed.votes[2], [beto.id]);
  assert.deepEqual(changed.votes[0], [cris.id]);
  const removed = (await call(beto.token, 'POST', `/api/messages/${msg.id}/vote`, { options: [] })).json.message;
  assert.equal(removed.votes[2], undefined);

  // encerrar: quem criou, dono ou moderador; outro membro não
  assert.equal((await call(cris.token, 'POST', `/api/messages/${msg.id}/close`)).status, 403);
  assert.equal((await call(ana.token, 'POST', `/api/messages/${msg.id}/close`)).status, 200);
  assert.equal((await call(cris.token, 'POST', `/api/messages/${msg.id}/vote`, { options: [2] })).status, 409);
  assert.equal((await call(cris.token, 'GET', '/api/channels/geral/messages?limit=100')).json.messages.find((m) => m.id === msg.id).pollClosed, true);

  // enquete não se edita
  const edit = await call(ana.token, 'PATCH', `/api/messages/${msg.id}`, { text: 'outra', nonce: 'e', sig: k.sign('x') });
  assert.equal(edit.status, 400);
  // mensagem comum não é enquete
  const plain = srv.store.addMessage({ channel: 'geral', user: srv.owner, text: 'oi' });
  assert.equal((await call(ana.token, 'POST', `/api/messages/${plain.id}/vote`, { options: [0] })).status, 404);
  ws.close();
});

test('enquete: moderador encerra a de membro; apagar some com os votos; cópias juntam votos', async () => {
  const ben = await joinAs('Ben');
  const wsB = await connect(ben.token);
  wsB.send(JSON.stringify({ t: 'msg', channel: 'geral', text: 'Jogar hoje?', poll: { options: ['sim', 'não'], multi: true } }));
  const msg = (await waitFor(() => wsB.events.find((e) => e.t === 'msg' && e.message.poll && e.message.text === 'Jogar hoje?'))).message;
  assert.equal((await call(ben.token, 'POST', `/api/messages/${msg.id}/vote`, { options: [0, 1] })).status, 200, 'múltipla aceita duas');

  // cópias: votos mais recentes vencem
  const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `concordo-poll-${n}-`));
  const a = new Store(tmp('a'));
  const u = a.createUser('Um');
  const m1 = a.addMessage({ channel: 'geral', user: u, text: 'q', poll: { options: ['x', 'y'], multi: false } });
  a.votePoll(m1.id, u.id, [0]);
  const b = new Store(tmp('b'));
  b.mergeState(JSON.parse(JSON.stringify(a.backupState())));
  b.importMessages(fs.readFileSync(a.messagesPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
  assert.deepEqual(b.getMessage(m1.id).votes, { 0: [u.id] });
  assert.equal(b.getMessage(m1.id).poll.options.length, 2);
  a.closePoll(m1.id, { id: u.id, role: 'member' });
  b.mergeState(JSON.parse(JSON.stringify(a.backupState())));
  assert.equal(b.getMessage(m1.id).pollClosed, true);
  b.deleteMessage(m1.id, { id: u.id, role: 'member' });
  assert.equal(b.getMessage(m1.id).votes, undefined);
  wsB.close();
});

test('soundboard: só dentro da chamada, só ids válidos, com intervalo mínimo, vai para quem está na sala de voz', async () => {
  const a = await joinAs('Som1');
  const b = await joinAs('Som2');
  const c = await joinAs('Som3');
  const [wa, wb, wc] = [await connect(a.token), await connect(b.token), await connect(c.token)];
  const hear = (ws) => ws.events.filter((e) => e.t === 'soundboard');
  wa.send(JSON.stringify({ t: 'soundboard', id: 'buzina' }));
  await settle();
  assert.equal(hear(wb).length, 0, 'fora da chamada não toca');
  wa.send(JSON.stringify({ t: 'voice_join', channel: 'voz' }));
  wb.send(JSON.stringify({ t: 'voice_join', channel: 'voz' }));
  await waitFor(() => wb.events.find((e) => e.t === 'voice_joined'));
  wa.send(JSON.stringify({ t: 'soundboard', id: 'nao-existe' }));
  wa.send(JSON.stringify({ t: 'soundboard', id: Soundboard.CLIPS[0].id }));
  const heard = await waitFor(() => hear(wb)[0]);
  assert.equal(heard.from, a.id);
  assert.equal(heard.id, Soundboard.CLIPS[0].id);
  wa.send(JSON.stringify({ t: 'soundboard', id: 'tambor' })); // dentro do intervalo
  await settle();
  assert.equal(hear(wb).length, 1, 'rajada é cortada');
  assert.equal(hear(wc).length, 0, 'quem não está na chamada não ouve');
  assert.equal(hear(wa).length, 1, 'quem apertou também recebe (e toca)');
  for (const w of [wa, wb, wc]) w.close();
});

test('confirmação de leitura: só sobe, vai para quem vê o canal e entra no /api/state', async () => {
  const a = await joinAs('Lia');
  const b = await joinAs('Davi');
  const wa = await connect(a.token);
  const wb = await connect(b.token);
  const now = Date.now();
  wa.send(JSON.stringify({ t: 'read', channel: 'geral', ts: now - 1000 }));
  const ev = await waitFor(() => wb.events.find((e) => e.t === 'read' && e.user === a.id));
  assert.equal(ev.channel, 'geral');
  assert.equal(ev.ts, now - 1000);
  wa.send(JSON.stringify({ t: 'read', channel: 'geral', ts: now - 5000 })); // voltar atrás é ignorado
  wa.send(JSON.stringify({ t: 'read', channel: 'geral', ts: now + 10 * 60 * 1000 })); // futuro é cortado em "agora"
  await waitFor(() => wb.events.filter((e) => e.t === 'read' && e.user === a.id).length >= 2);
  const reads = wb.events.filter((e) => e.t === 'read' && e.user === a.id);
  assert.equal(reads.length, 2);
  assert.ok(reads[1].ts <= Date.now());
  const st = await call(b.token, 'GET', '/api/state');
  assert.equal(st.json.reads.geral[a.id], reads[1].ts);
  wa.close();
  wb.close();
});

test('sons personalizados: valida o áudio, limita por pessoa, toca na chamada e só quem pode apaga', async () => {
  const a = await joinAs('Rui');
  const b = await joinAs('Zeca');
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.from([36, 0, 0, 0]), Buffer.from('WAVEfmt '), Buffer.alloc(40)]);
  const up = (token, body, q = 'name=Aplauso&emoji=%F0%9F%91%8F') =>
    fetch(`${srv.localUrl}/api/sounds?${q}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body });
  assert.equal((await up(a.token, Buffer.from('isto não é áudio de jeito nenhum'))).status, 400);
  assert.equal((await up(a.token, Buffer.concat([wav, Buffer.alloc(210 * 1024)]))).status, 413);
  const ok = await up(a.token, wav);
  assert.equal(ok.status, 201);
  const { id } = await ok.json();
  const st = await call(b.token, 'GET', '/api/state');
  const snd = st.json.sounds.find((s) => s.id === id);
  assert.equal(snd.name, 'Aplauso');
  const audio = await fetch(`${srv.localUrl}/api/sounds/${id}/audio`, { headers: { Authorization: `Bearer ${b.token}` } });
  assert.equal(audio.status, 200);
  assert.equal(Buffer.from(await audio.arrayBuffer()).length, wav.length);
  assert.equal((await up(a.token, wav)).status, 201);
  assert.equal((await up(a.token, wav)).status, 201);
  assert.equal((await up(a.token, wav)).status, 409, 'membro tem no máximo 3');
  // toca na chamada: o relay aceita o id personalizado e rejeita um inexistente
  const wa = await connect(a.token);
  const wb = await connect(b.token);
  wa.send(JSON.stringify({ t: 'voice_join', channel: 'voz' }));
  wb.send(JSON.stringify({ t: 'voice_join', channel: 'voz' }));
  await waitFor(() => wb.events.find((e) => e.t === 'voice_joined'));
  wa.send(JSON.stringify({ t: 'soundboard', id: 'c-0000000000000000' }));
  wa.send(JSON.stringify({ t: 'soundboard', id: 'c-' + id }));
  const got = await waitFor(() => wb.events.find((e) => e.t === 'soundboard' && e.id === 'c-' + id));
  assert.equal(got.from, a.id);
  assert.ok(!wb.events.some((e) => e.t === 'soundboard' && e.id === 'c-0000000000000000'));
  // apagar
  assert.equal((await call(b.token, 'DELETE', `/api/sounds/${id}`)).status, 403);
  const del = await call(srv.owner.token, 'DELETE', `/api/sounds/${id}`);
  assert.equal(del.status, 200);
  assert.ok(!(await call(b.token, 'GET', '/api/state')).json.sounds.some((s) => s.id === id));
  assert.equal((await fetch(`${srv.localUrl}/api/sounds/${id}/audio`, { headers: { Authorization: `Bearer ${b.token}` } })).status, 404);
  wa.close();
  wb.close();
});
