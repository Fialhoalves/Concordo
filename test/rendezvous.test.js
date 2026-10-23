'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Rendezvous = require('../src/main/rendezvous');
const Invite = require('../src/shared/invite');

// imita a API do jsonblob.com: POST cria (Location), GET lê, PUT substitui
function fakeBlobServer() {
  const blobs = new Map();
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const m = req.url.match(/^\/api\/jsonBlob(?:\/([\w-]+))?$/);
      if (!m) return res.writeHead(404).end();
      if (req.method === 'POST' && !m[1]) {
        const id = 'b' + (blobs.size + 1) + 'x'.repeat(10);
        blobs.set(id, body);
        res.writeHead(201, { Location: `http://${req.headers.host}/api/jsonBlob/${id}`, 'Content-Type': 'application/json' });
        return res.end(body);
      }
      if (!blobs.has(m[1])) return res.writeHead(404).end();
      if (req.method === 'PUT') blobs.set(m[1], body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(blobs.get(m[1]));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ server, blobs, base: `http://127.0.0.1:${server.address().port}/api/jsonBlob` })));
}

test('ponto de encontro: publica o endereço e os membros o encontram', async () => {
  const { server, base } = await fakeBlobServer();
  try {
    const rv = await Rendezvous.create({ base });
    await Rendezvous.publish(rv, 'https://um.trycloudflare.com', { base });
    assert.equal((await Rendezvous.resolve(Rendezvous.format(rv), { base })).url, 'https://um.trycloudflare.com');
    await Rendezvous.publish(rv, 'https://dois.trycloudflare.com/', { base });
    assert.equal((await Rendezvous.resolve(Rendezvous.format(rv), { base })).url, 'https://dois.trycloudflare.com');
  } finally {
    server.close();
  }
});

test('ponto de encontro: recusa endereço sem assinatura válida e chave errada', async () => {
  const { server, blobs, base } = await fakeBlobServer();
  try {
    const rv = await Rendezvous.create({ base });
    await Rendezvous.publish(rv, 'https://ok.trycloudflare.com', { base });
    // alguém que só conhece o id tenta redirecionar os amigos
    blobs.set(rv.id, JSON.stringify({ v: 1, u: 'https://mal.example.com', t: Date.now(), s: 'f'.repeat(64) }));
    assert.equal(await Rendezvous.resolve(Rendezvous.format(rv), { base }), null);
    await Rendezvous.publish(rv, 'https://ok.trycloudflare.com', { base });
    const wrong = Rendezvous.format({ id: rv.id, key: 'chave-errada-1234567890' });
    assert.equal(await Rendezvous.resolve(wrong, { base }), null);
    assert.equal(await Rendezvous.resolve('lixo', { base }), null);
  } finally {
    server.close();
  }
});

test('código de convite carrega o ponto de encontro e continua compatível com códigos antigos', () => {
  const code = Invite.encode({ url: 'https://a.trycloudflare.com', roomId: 'r1', roomName: 'Sala', rv: 'abc123.chavechavechavechave' });
  assert.equal(Invite.decode(code).rv, 'abc123.chavechavechavechave');
  assert.equal(Invite.decode(Invite.encode({ url: 'https://a.b', roomId: 'r1' })).rv, '');
});
