// Ponto de encontro gratuito: guarda o endereço ATUAL da sala num "bloco JSON" público (jsonblob.com),
// assinado com uma chave que só os membros conhecem (vem no código de convite). Assim, quando o túnel
// temporário muda de endereço, os amigos acham o novo sozinhos. Sem Electron: roda no Node e nos testes.
'use strict';
const crypto = require('node:crypto');

const DEFAULT_BASE = 'https://jsonblob.com/api/jsonBlob';

const sign = (key, url, t) => crypto.createHmac('sha256', key).update(`${url}\n${t}`).digest('hex');

function parse(rv) {
  const m = typeof rv === 'string' && rv.match(/^([A-Za-z0-9_-]{6,64})\.([A-Za-z0-9_-]{16,128})$/);
  return m ? { id: m[1], key: m[2] } : null;
}
const format = ({ id, key }) => `${id}.${key}`;

async function withTimeout(fetchImpl, url, opts = {}, ms = 10000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetchImpl(url, { ...opts, signal: ctl.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

// cria o bloco e devolve { id, key }
async function create({ fetchImpl = fetch, base = DEFAULT_BASE } = {}) {
  const res = await withTimeout(fetchImpl, base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ v: 1 }),
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`ponto de encontro: HTTP ${res.status}`);
  const loc = res.headers.get('location') || '';
  const id = loc.split('/').filter(Boolean).pop();
  if (!id || !/^[A-Za-z0-9_-]{6,64}$/.test(id)) throw new Error('ponto de encontro: resposta sem id');
  return { id, key: crypto.randomBytes(24).toString('base64url') };
}

async function publish({ id, key }, url, { fetchImpl = fetch, base = DEFAULT_BASE } = {}) {
  const t = Date.now();
  const res = await withTimeout(fetchImpl, `${base}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ v: 1, u: url, t, s: sign(key, url, t) }),
  });
  if (!res.ok) throw new Error(`ponto de encontro: HTTP ${res.status}`);
}

// devolve o endereço atual (só se a assinatura conferir) ou null
async function resolve(rv, { fetchImpl = fetch, base = DEFAULT_BASE } = {}) {
  const p = parse(rv);
  if (!p) return null;
  const res = await withTimeout(fetchImpl, `${base}/${encodeURIComponent(p.id)}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return null;
  const d = await res.json();
  if (!d || typeof d.u !== 'string' || typeof d.s !== 'string' || typeof d.t !== 'number') return null;
  if (!/^https?:\/\/[^\s]+$/i.test(d.u)) return null;
  const expected = sign(p.key, d.u, d.t);
  const a = Buffer.from(expected);
  const b = Buffer.from(d.s);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { url: d.u.replace(/\/+$/, ''), t: d.t };
}

module.exports = { create, publish, resolve, parse, format, sign, DEFAULT_BASE };
