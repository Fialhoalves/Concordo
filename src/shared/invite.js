// Código de convite do Concordo.
// Formato: concordo://join/<base64url(JSON)>
// Funciona no Node (servidor/testes) e no navegador (interface).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ConcordoInvite = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const PREFIX = 'concordo://join/';

  function toB64Url(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromB64Url(s) {
    let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  // invite é opcional: um código sem convite só serve para quem já é membro.
  function encode({ url, roomId, roomName, invite }) {
    const data = { v: 1, u: url, r: roomId };
    if (roomName) data.n = roomName;
    if (invite) data.i = invite;
    return PREFIX + toB64Url(JSON.stringify(data));
  }

  // Aceita o código completo, só o trecho em base64, ou um texto com o código no meio.
  function decode(input) {
    if (typeof input !== 'string') return null;
    const m =
      input.match(/concordo:\/\/join\/([A-Za-z0-9_-]+)/) ||
      input.trim().match(/^([A-Za-z0-9_-]{20,})$/);
    if (!m) return null;
    try {
      const d = JSON.parse(fromB64Url(m[1]));
      if (!d || d.v !== 1 || typeof d.u !== 'string' || typeof d.r !== 'string') return null;
      if (!/^https?:\/\/[^\s]+$/i.test(d.u)) return null;
      return {
        url: d.u.replace(/\/+$/, ''),
        roomId: d.r,
        roomName: typeof d.n === 'string' ? d.n : '',
        invite: typeof d.i === 'string' ? d.i : '',
      };
    } catch {
      return null;
    }
  }

  return { encode, decode, PREFIX };
});
