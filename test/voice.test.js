'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { createConcordoServer } = require('../src/server');
const Invite = require('../src/shared/invite');

let dir;
let srv;

const call = async (token, method, route, body) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(srv.localUrl + route, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* sem corpo */
  }
  return { status: res.status, json };
};

const joinAs = async (name) => {
  const r = await call(srv.owner.token, 'POST', '/api/invites', { maxUses: 1 });
  const inv = Invite.decode(r.json.code);
  const j = await call(null, 'POST', '/api/join', { invite: inv.invite, name });
  assert.equal(j.status, 201);
  return j.json;
};

const connect = (token) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?token=${token}`);
    ws.events = [];
    ws.on('message', (d) => ws.events.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });

const send = (ws, obj) => ws.send(JSON.stringify(obj));
const last = (ws, type) => [...ws.events].reverse().find((e) => e.t === type);
const waitFor = async (fn, ms = 2000) => {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error('timeout esperando condição');
    await new Promise((r) => setTimeout(r, 15));
  }
};
const settle = () => new Promise((r) => setTimeout(r, 80));

// usuário com socket já conectado
const person = async (name) => {
  const u = await joinAs(name);
  const ws = await connect(u.token);
  return { ...u, ws };
};

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concordo-voice-'));
  srv = await createConcordoServer({
    dataDir: dir,
    roomName: 'Voz',
    ownerName: 'Host',
    getPublicUrl: () => 'https://x.trycloudflare.com',
    iceServers: [{ urls: 'stun:exemplo.test:3478' }],
  });
});

after(async () => {
  await srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sala nova tem um canal de texto e um de voz; o estado traz ICE e limite de voz', async () => {
  const st = (await call(srv.owner.token, 'GET', '/api/state')).json;
  assert.deepEqual(st.channels.map((c) => [c.id, c.type]), [['geral', 'text'], ['voz', 'voice']]);
  assert.deepEqual(st.voice, {});
  assert.deepEqual(st.ice, [{ urls: 'stun:exemplo.test:3478' }]);
  assert.equal(st.limits.maxVoice, 8);
});

test('salas antigas (sem tipo de canal) são migradas, sem colidir ids', async () => {
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'concordo-legacy-'));
  try {
    fs.writeFileSync(
      path.join(legacyDir, 'state.json'),
      JSON.stringify({
        room: { id: 'abc123', name: 'Antiga' },
        users: {},
        invites: {},
        channels: [{ id: 'geral', name: 'geral' }, { id: 'voz', name: 'voz' }],
        files: {},
      }),
    );
    fs.writeFileSync(
      path.join(legacyDir, 'messages.jsonl'),
      JSON.stringify({ id: 'm1', channel: 'voz', userId: 'u', author: 'x', text: 'oi', attachments: [], ts: 1 }) + '\n',
    );
    const old = await createConcordoServer({ dataDir: legacyDir, ownerName: 'Dono' });
    try {
      assert.deepEqual(
        old.store.channels.map((c) => [c.id, c.type]),
        [['geral', 'text'], ['voz', 'text'], ['voz-2', 'voice']],
      );
      assert.equal(old.store.getMessages('voz').messages[0].text, 'oi'); // histórico preservado
    } finally {
      await old.close();
    }
  } finally {
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }
});

test('canal de voz pode ser criado pelo dono e não aceita texto nem arquivos', async () => {
  const member = await joinAs('Texto');
  assert.equal((await call(member.token, 'POST', '/api/channels', { name: 'x', type: 'voice' })).status, 403);

  const r = await call(srv.owner.token, 'POST', '/api/channels', { name: 'Sala 2', type: 'voice' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.json.channel, { id: 'sala-2', name: 'sala-2', type: 'voice' });

  assert.equal((await call(member.token, 'GET', '/api/channels/sala-2/messages')).status, 404);
  const up = await fetch(`${srv.localUrl}/api/channels/sala-2/upload?name=a.txt`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${member.token}` },
    body: 'x',
  });
  assert.equal(up.status, 404);

  const ws = await connect(member.token);
  try {
    send(ws, { t: 'msg', channel: 'sala-2', text: 'oi' });
    await waitFor(() => ws.events.some((e) => e.t === 'error'));
    send(ws, { t: 'voice_join', channel: 'geral' }); // canal de texto não vira sala de voz
    await waitFor(() => ws.events.filter((e) => e.t === 'error').length === 2);
  } finally {
    ws.close();
  }
});

test('entrar na voz: o primeiro recebe lista vazia; o segundo recebe quem já está lá', async () => {
  const a = await person('VozA');
  const b = await person('VozB');
  try {
    send(a.ws, { t: 'voice_join', channel: 'voz' });
    const ja = await waitFor(() => last(a.ws, 'voice_joined'));
    assert.deepEqual(ja.peers, []);

    send(b.ws, { t: 'voice_join', channel: 'voz' });
    const jb = await waitFor(() => last(b.ws, 'voice_joined'));
    assert.deepEqual(jb.peers, [a.user.id]);

    const snap = await waitFor(() => {
      const s = last(a.ws, 'voice');
      return s && s.rooms.voz && s.rooms.voz.length === 2 ? s : null;
    });
    assert.deepEqual(snap.rooms.voz.map((p) => p.id).sort(), [a.user.id, b.user.id].sort());
    // quem estava fora também vê (inclusive o estado inicial para quem conecta depois)
    const late = await person('Tardio');
    const lateSnap = await waitFor(() => last(late.ws, 'voice'));
    assert.equal(lateSnap.rooms.voz.length, 2);
    late.ws.close();
  } finally {
    a.ws.close();
    b.ws.close();
  }
});

test('estado (mudo, fone, câmera, tela) é validado e repassado a todos', async () => {
  const a = await person('EstA');
  const watcher = await person('Observador');
  try {
    send(a.ws, { t: 'voice_join', channel: 'voz' });
    await waitFor(() => last(a.ws, 'voice_joined'));
    send(a.ws, { t: 'voice_state', muted: true, deafened: false, cam: 'stream-cam-1', screen: 42 });
    const snap = await waitFor(() => {
      const s = last(watcher.ws, 'voice');
      const me = s && s.rooms.voz && s.rooms.voz.find((p) => p.id === a.user.id);
      return me && me.muted ? me : null;
    });
    assert.equal(snap.muted, true);
    assert.equal(snap.deafened, false);
    assert.equal(snap.cam, 'stream-cam-1');
    assert.equal(snap.screen, null); // número não é id de stream válido

    // quem não está na voz não consegue mexer no estado de ninguém
    send(watcher.ws, { t: 'voice_state', muted: true });
    await settle();
    assert.equal(last(a.ws, 'voice').rooms.voz.find((p) => p.id === a.user.id).muted, true);
    assert.equal(last(a.ws, 'voice').rooms.voz.some((p) => p.id === watcher.user.id), false);
  } finally {
    a.ws.close();
    watcher.ws.close();
  }
});

test('sinalização WebRTC: chega só para quem está na mesma sala de voz', async () => {
  const a = await person('RtcA');
  const b = await person('RtcB');
  const c = await person('RtcC'); // outra sala
  const d = await person('RtcD'); // fora da voz
  try {
    send(a.ws, { t: 'voice_join', channel: 'voz' });
    await waitFor(() => last(a.ws, 'voice_joined'));
    send(b.ws, { t: 'voice_join', channel: 'voz' });
    await waitFor(() => last(b.ws, 'voice_joined'));
    send(c.ws, { t: 'voice_join', channel: 'sala-2' });
    await waitFor(() => last(c.ws, 'voice_joined'));

    const offer = { description: { type: 'offer', sdp: 'v=0...' } };
    send(a.ws, { t: 'rtc', to: b.user.id, data: offer });
    const got = await waitFor(() => last(b.ws, 'rtc'));
    assert.equal(got.from, a.user.id);
    assert.deepEqual(got.data, offer);

    send(a.ws, { t: 'rtc', to: c.user.id, data: offer }); // sala diferente
    send(a.ws, { t: 'rtc', to: d.user.id, data: offer }); // fora da voz
    send(d.ws, { t: 'rtc', to: a.user.id, data: offer }); // remetente fora da voz
    send(a.ws, { t: 'rtc', to: 'inexistente', data: offer });
    send(a.ws, { t: 'rtc', to: b.user.id, data: 'texto solto' }); // payload inválido
    await settle();
    assert.equal(c.ws.events.filter((e) => e.t === 'rtc').length, 0);
    assert.equal(d.ws.events.filter((e) => e.t === 'rtc').length, 0);
    assert.equal(a.ws.events.filter((e) => e.t === 'rtc').length, 0);
    assert.equal(b.ws.events.filter((e) => e.t === 'rtc').length, 1);
  } finally {
    for (const p of [a, b, c, d]) p.ws.close();
  }
});

test('sair da voz (explícito ou fechando o socket) tira a pessoa da sala', async () => {
  const a = await person('SaiA');
  const b = await person('SaiB');
  const watcher = await person('Vigia');
  const inRoom = (id) => {
    const s = last(watcher.ws, 'voice');
    return !!(s && s.rooms.voz && s.rooms.voz.some((p) => p.id === id));
  };
  try {
    send(a.ws, { t: 'voice_join', channel: 'voz' });
    send(b.ws, { t: 'voice_join', channel: 'voz' });
    await waitFor(() => inRoom(a.user.id) && inRoom(b.user.id));

    send(a.ws, { t: 'voice_leave' });
    await waitFor(() => !inRoom(a.user.id));
    assert.equal(inRoom(b.user.id), true);

    b.ws.close(); // caiu a conexão
    await waitFor(() => !inRoom(b.user.id));
    assert.deepEqual(last(watcher.ws, 'voice').rooms.voz || [], []);
  } finally {
    a.ws.close();
    watcher.ws.close();
  }
});

test('limite de 8 pessoas por sala de voz', async () => {
  const people = [];
  try {
    for (let i = 0; i < 9; i++) people.push(await person(`Lot${i}`));
    for (let i = 0; i < 8; i++) {
      send(people[i].ws, { t: 'voice_join', channel: 'sala-2' });
      await waitFor(() => last(people[i].ws, 'voice_joined'));
    }
    assert.equal(last(people[7].ws, 'voice_joined').peers.length, 7);
    send(people[8].ws, { t: 'voice_join', channel: 'sala-2' });
    const err = await waitFor(() => people[8].ws.events.find((e) => e.t === 'error'));
    assert.match(err.message, /cheia/);
    assert.equal(last(people[8].ws, 'voice_joined'), undefined);
    // quem já está dentro pode reentrar sem ser barrado
    send(people[0].ws, { t: 'voice_join', channel: 'sala-2' });
    await waitFor(() => people[0].ws.events.filter((e) => e.t === 'voice_joined').length === 2);
  } finally {
    for (const p of people) p.ws.close();
  }
});

test('trocar de sala de voz move a pessoa; entrar por outra janela avisa a primeira', async () => {
  const a = await person('Troca');
  const watcher = await person('Vigia2');
  try {
    send(a.ws, { t: 'voice_join', channel: 'voz' });
    await waitFor(() => last(a.ws, 'voice_joined'));
    send(a.ws, { t: 'voice_join', channel: 'sala-2' });
    await waitFor(() => {
      const s = last(watcher.ws, 'voice');
      return s && s.rooms['sala-2'] && s.rooms['sala-2'].some((p) => p.id === a.user.id);
    });
    const rooms = last(watcher.ws, 'voice').rooms;
    assert.equal((rooms.voz || []).some((p) => p.id === a.user.id), false);

    const second = await connect(a.token);
    try {
      send(second, { t: 'voice_join', channel: 'voz' });
      await waitFor(() => last(a.ws, 'voice_left'));
    } finally {
      second.close();
    }
  } finally {
    a.ws.close();
    watcher.ws.close();
  }
});

test('remover um membro também o tira da voz', async () => {
  const a = await person('Expulso');
  const watcher = await person('Vigia3');
  try {
    send(a.ws, { t: 'voice_join', channel: 'voz' });
    await waitFor(() => {
      const s = last(watcher.ws, 'voice');
      return s && s.rooms.voz && s.rooms.voz.some((p) => p.id === a.user.id);
    });
    assert.equal((await call(srv.owner.token, 'DELETE', `/api/users/${a.user.id}`)).status, 200);
    await waitFor(() => {
      const s = last(watcher.ws, 'voice');
      return s && !(s.rooms.voz || []).some((p) => p.id === a.user.id);
    });
  } finally {
    a.ws.close();
    watcher.ws.close();
  }
});
