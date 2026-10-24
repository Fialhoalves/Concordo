// Assinaturas das mensagens: o que exatamente é assinado. O mesmo texto é montado no servidor (Node) e nos
// clientes (navegador), então os dois lados concordam byte a byte. Funciona no Node e no navegador.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ConcordoSig = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const str = (v) => (v === undefined || v === null ? '' : String(v));
  // texto novo: sala, canal, autor, número único, texto e (se for resposta) o id da mensagem respondida
  const msgPayload = ({ room, channel, user, nonce, text, replyTo }) =>
    JSON.stringify(['concordo-msg-v1', str(room), str(channel), str(user), str(nonce), str(text), str(replyTo)]);
  // edição de uma mensagem
  const editPayload = ({ room, id, user, nonce, text }) =>
    JSON.stringify(['concordo-edit-v1', str(room), str(id), str(user), str(nonce), str(text)]);
  // mensagem com arquivo (assinada depois do envio, quando o id do arquivo já existe)
  const filePayload = ({ room, id, channel, user, nonce, attachments }) =>
    JSON.stringify(['concordo-file-v1', str(room), str(id), str(channel), str(user), str(nonce),
      (attachments || []).map((a) => [str(a.id), str(a.name), Number(a.size) || 0])]);
  const b64 = { re: /^[A-Za-z0-9+/]+=*$/ };
  return { msgPayload, editPayload, filePayload, isB64: (s) => typeof s === 'string' && s.length > 0 && s.length < 400 && b64.re.test(s) };
});
