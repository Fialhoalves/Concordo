'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tunnel = require('../src/main/tunnel');

// Usa um "cloudflared" falso (script de shell), então só roda em Linux/macOS.
const skip = process.platform === 'win32' ? 'script de shell não roda no Windows' : false;

function fakeBinary(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concordo-tunnel-'));
  const file = path.join(dir, 'fake-cloudflared');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { file, dir };
}

test('URL_RE encontra o endereço no meio do log do cloudflared', () => {
  const log = '2026-10-23T14:00:00Z INF |  https://funny-name-123.trycloudflare.com  |';
  assert.equal(log.match(tunnel.URL_RE)[0], 'https://funny-name-123.trycloudflare.com');
  assert.equal('https://api.trycloudflare.com/tunnel'.match(tunnel.URL_RE)[0], 'https://api.trycloudflare.com');
});

test('startTunnel resolve com a URL e repassa os argumentos certos', { skip }, async () => {
  const { file, dir } = fakeBinary(
    'echo "args: $@" >&2\necho "https://abc-def.trycloudflare.com" >&2\nsleep 30',
  );
  try {
    let argsSeen = '';
    const t = await tunnel.startTunnel({ binPath: file, port: 4321, timeoutMs: 5000 });
    assert.equal(t.url, 'https://abc-def.trycloudflare.com');
    t.stop();
    // roda de novo só para checar os argumentos
    const { file: f2, dir: d2 } = fakeBinary('echo "$@" >&2\necho "https://x.trycloudflare.com"\nsleep 30');
    const probe = await new Promise((resolve) => {
      const { spawn } = require('node:child_process');
      const c = spawn(f2, ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:4321']);
      c.stderr.on('data', (d) => (argsSeen += d));
      setTimeout(() => {
        c.kill();
        resolve(argsSeen);
      }, 300);
    });
    assert.match(probe, /tunnel --no-autoupdate --url http:\/\/127\.0\.0\.1:4321/);
    fs.rmSync(d2, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('startTunnel rejeita por timeout se a URL nunca aparece', { skip }, async () => {
  const { file, dir } = fakeBinary('echo "iniciando..." >&2\nsleep 30');
  try {
    await assert.rejects(tunnel.startTunnel({ binPath: file, port: 1, timeoutMs: 300 }), /demorou demais/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('startTunnel rejeita se o processo fecha antes de dar a URL', { skip }, async () => {
  const { file, dir } = fakeBinary('echo "falha de rede" >&2\nexit 3');
  try {
    await assert.rejects(tunnel.startTunnel({ binPath: file, port: 1, timeoutMs: 3000 }), /código 3.*falha de rede/s);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('startTunnel avisa quando o túnel cai depois de pronto', { skip }, async () => {
  const { file, dir } = fakeBinary('echo "https://cai.trycloudflare.com" >&2\nsleep 0.3\nexit 1');
  try {
    const exited = new Promise((resolve) => {
      tunnel
        .startTunnel({ binPath: file, port: 1, timeoutMs: 3000, onExit: resolve })
        .then((t) => assert.equal(t.url, 'https://cai.trycloudflare.com'));
    });
    assert.equal(await exited, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('startTunnel falha com mensagem clara se o executável não existe', async () => {
  await assert.rejects(
    tunnel.startTunnel({ binPath: '/caminho/que/nao/existe/cloudflared', port: 1, timeoutMs: 2000 }),
    /não consegui iniciar o cloudflared/,
  );
});

test('findBinary prioriza a variável de ambiente e depois a pasta de recursos', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concordo-bin-'));
  try {
    const name = tunnel.binaryName();
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'bin', name), '');
    assert.equal(tunnel.findBinary({ resourcesPath: dir }), path.join(dir, 'bin', name));
    assert.equal(tunnel.findBinary({ resourcesPath: path.join(dir, 'nada') }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
