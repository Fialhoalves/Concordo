// Reações disponíveis (mensagens e ao vivo na chamada). Funciona no Node e no navegador.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ConcordoReactions = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // figurinhas do mascote: o arquivo fica em assets/mascot/<id>.png
  const STICKERS = [
    { id: 'feliz', label: 'Feliz' },
    { id: 'oculos', label: 'Maneiro' },
    { id: 'surpreso', label: 'Surpreso' },
    { id: 'pensativo', label: 'Pensativo' },
    { id: 'comendo', label: 'Palmas' },
    { id: 'acenando', label: 'Oi!' },
  ];
  const EMOJI = ['👍', '❤️', '😂', '🔥', '🎉'];
  const keys = new Set([...STICKERS.map((s) => 's:' + s.id), ...EMOJI.map((e) => 'e:' + e)]);
  const isValid = (key) => typeof key === 'string' && keys.has(key);
  return { STICKERS, EMOJI, isValid };
});
