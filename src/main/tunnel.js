'use strict';
// Túnel público via cloudflared ("quick tunnel": grátis, sem conta, URL muda a cada execução).
// Este módulo não depende do Electron, para poder ser testado sozinho.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';

function binaryName() {
  return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

function downloadUrl() {
  const arch = process.arch;
  if (process.platform === 'win32' && arch === 'x64') return BASE + 'cloudflared-windows-amd64.exe';
  if (process.platform === 'linux' && arch === 'x64') return BASE + 'cloudflared-linux-amd64';
  if (process.platform === 'linux' && arch === 'arm64') return BASE + 'cloudflared-linux-arm64';
  return null; // macOS vem em .tgz: não suportado no download automático
}

// Procura o executável em: variável de ambiente, pasta de recursos do app, build/bin (dev), pasta do usuário.
function findBinary({ resourcesPath, devDir, userDir } = {}) {
  const name = binaryName();
  const candidates = [
    process.env.CONCORDO_CLOUDFLARED,
    resourcesPath && path.join(resourcesPath, 'bin', name),
    devDir && path.join(devDir, name),
    userDir && path.join(userDir, name),
  ].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c)) || null;
}

function fetchToFile(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('redirecionamentos demais'));
    https
      .get(url, { headers: { 'User-Agent': 'concordo' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(fetchToFile(new URL(res.headers.location, url).toString(), dest, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`download falhou (HTTP ${res.statusCode})`));
        }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(resolve));
        out.on('error', reject);
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

async function download(destFile) {
  const url = downloadUrl();
  if (!url) throw new Error('não há download automático do cloudflared para este sistema');
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  const tmp = destFile + '.part';
  try {
    await fetchToFile(url, tmp);
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, destFile);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return destFile;
}

const READY_RE = /registered tunnel connection|connection [0-9a-f-]+ registered/i;

// Endereço fixo digitado pelo usuário -> "https://host" ou null.
function normalizeHostname(raw) {
  let v = String(raw || '').trim();
  if (!v) return null;
  if (!/^https?:\/\//i.test(v)) v = 'https://' + v;
  try {
    const u = new URL(v);
    if (!u.hostname.includes('.') || /[^a-z0-9.-]/i.test(u.hostname)) return null;
    return 'https://' + u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Sobe o túnel apontando para a porta local. Resolve com { url, stop } quando a URL pública aparece.
// Com `named: { token, url }` usa um túnel nomeado da Cloudflare (endereço fixo): o token vai por
// variável de ambiente (não aparece na lista de processos) e a URL é a configurada no painel da Cloudflare.
function startTunnel({ binPath, port, timeoutMs = 45000, onExit, named }) {
  return new Promise((resolve, reject) => {
    const args = named
      ? ['tunnel', '--no-autoupdate', 'run']
      : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`];
    const env = named ? { ...process.env, TUNNEL_TOKEN: named.token } : process.env;
    const child = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });

    let settled = false;
    let tail = '';
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        child.kill();
        reject(err);
      } else {
        resolve(value);
      }
    };

    const timer = setTimeout(
      () => finish(new Error('o túnel demorou demais para ficar pronto')),
      timeoutMs,
    );

    const onData = (buf) => {
      const text = buf.toString();
      tail = (tail + text).slice(-2000);
      const m = named ? (READY_RE.test(tail) ? [named.url] : null) : text.match(URL_RE);
      if (m) {
        finish(null, {
          url: m[0],
          stop: () => child.kill(),
        });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (e) => finish(new Error(`não consegui iniciar o cloudflared: ${e.message}`)));
    child.on('exit', (code) => {
      if (!settled) {
        finish(new Error(`o cloudflared fechou (código ${code}). ${tail.trim().split('\n').pop() || ''}`));
      } else if (onExit) {
        onExit(code);
      }
    });
  });
}

module.exports = { normalizeHostname, binaryName, downloadUrl, findBinary, download, startTunnel, URL_RE };
