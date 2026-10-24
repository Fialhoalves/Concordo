// Sons do soundboard da chamada. Quem aperta manda só o id; cada um toca o som no próprio computador
// (sintetizado na hora: não passa áudio pela rede e não tem arquivo de som para ocupar espaço).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ConcordoSoundboardList = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const CLIPS = [
    { id: 'buzina', label: 'Buzina', emoji: '📣' },
    { id: 'tambor', label: 'Tambor', emoji: '🥁' },
    { id: 'palmas', label: 'Palmas', emoji: '👏' },
    { id: 'triste', label: 'Trombone triste', emoji: '🎺' },
    { id: 'sirene', label: 'Sirene', emoji: '🚨' },
    { id: 'sino', label: 'Sino', emoji: '🔔' },
    { id: 'laser', label: 'Laser', emoji: '🔫' },
    { id: 'tada', label: 'Tchan!', emoji: '🎉' },
  ];
  const ids = new Set(CLIPS.map((c) => c.id));
  return { CLIPS, isValid: (id) => typeof id === 'string' && ids.has(id) };
});
