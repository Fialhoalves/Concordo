// Chaves de cada sala neste computador (WebCrypto, nada de bibliotecas):
//   Ed25519 -> assina as mensagens, para ninguém (nem o host, nem uma cópia) falar em nome de outra pessoa;
//   X25519  -> combina uma chave secreta com cada amigo para as conversas diretas (AES-GCM de ponta a ponta).
// As chaves privadas ficam no IndexedDB como "não exportáveis": o app consegue usá-las, mas ninguém consegue copiá-las.
(function () {
  const DB = 'concordo-keys';
  const STORE = 'keys';
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const b64 = (buf) => {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  function db() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function dbGet(key) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const r = d.transaction(STORE).objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    });
  }
  async function dbPut(key, value) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  const supported = () => !!(window.crypto && crypto.subtle && window.indexedDB);

  const cache = new Map(); // roomId -> contexto
  async function load(roomId) {
    if (cache.has(roomId)) return cache.get(roomId);
    const p = (async () => {
      if (!supported()) return null;
      let rec = await dbGet(roomId);
      if (!rec) {
        const ed = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
        const x = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
        rec = { ed, x, createdAt: Date.now() };
        await dbPut(roomId, rec);
      }
      const pub = b64(await crypto.subtle.exportKey('raw', rec.ed.publicKey));
      const dh = b64(await crypto.subtle.exportKey('raw', rec.x.publicKey));
      return {
        pub,
        dh,
        sign: async (payload) => b64(await crypto.subtle.sign({ name: 'Ed25519' }, rec.ed.privateKey, enc.encode(payload))),
        xPrivate: rec.x.privateKey,
      };
    })();
    cache.set(roomId, p);
    try {
      return await p;
    } catch (e) {
      cache.delete(roomId);
      throw e;
    }
  }

  const verifyKeys = new Map();
  async function verify(pubB64, payload, sigB64) {
    try {
      let key = verifyKeys.get(pubB64);
      if (!key) {
        key = await crypto.subtle.importKey('raw', unb64(pubB64), { name: 'Ed25519' }, false, ['verify']);
        verifyKeys.set(pubB64, key);
      }
      return await crypto.subtle.verify({ name: 'Ed25519' }, key, unb64(sigB64), enc.encode(payload));
    } catch {
      return false;
    }
  }

  const nonce = () => b64(crypto.getRandomValues(new Uint8Array(12))).replace(/=+$/, '');

  // ---- conversa direta ----
  const dmKeys = new Map();
  async function dmKey(ctx, theirDhB64, { roomId, me, them }) {
    const id = [roomId, ctx.dh, theirDhB64].join('|');
    if (dmKeys.has(id)) return dmKeys.get(id);
    const theirs = await crypto.subtle.importKey('raw', unb64(theirDhB64), { name: 'X25519' }, false, []);
    const secret = await crypto.subtle.deriveBits({ name: 'X25519', public: theirs }, ctx.xPrivate, 256);
    const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
    const info = enc.encode('concordo-dm-v1|' + [me, them].sort().join('|'));
    const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(roomId), info }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    dmKeys.set(id, key);
    return key;
  }
  async function encrypt(key, plaintext, channel) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(channel) }, key, enc.encode(plaintext)));
    const all = new Uint8Array(iv.length + ct.length);
    all.set(iv);
    all.set(ct, iv.length);
    return 'enc1:' + b64(all);
  }
  async function decrypt(key, cipherText, channel) {
    try {
      const all = unb64(String(cipherText).replace(/^enc1:/, ''));
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12), additionalData: enc.encode(channel) }, key, all.slice(12));
      return dec.decode(pt);
    } catch {
      return null;
    }
  }

  // Código curto para os dois amigos conferirem por fora (ligação, pessoalmente) que ninguém está no meio.
  async function fingerprint(dhA, dhB) {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode('concordo-fp|' + [dhA, dhB].sort().join('|'))));
    const hex = [...h.slice(0, 6)].map((x) => x.toString(16).padStart(2, '0')).join('');
    return hex.match(/.{4}/g).join('-');
  }

  window.ConcordoKeys = { supported, load, verify, nonce, dmKey, encrypt, decrypt, fingerprint };
})();
