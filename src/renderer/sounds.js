// Efeitos sonoros do Concordo, sintetizados na hora (sem arquivos de áudio).
(function () {
  let ctx = null;
  const read = (key, fallback) => {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  };

  // cada som é uma lista de notas: [frequência (Hz), início (s), duração (s)]
  const NOTES = {
    join: [[523, 0, 0.09], [784, 0.09, 0.16]],
    leave: [[784, 0, 0.09], [523, 0.09, 0.18]],
    peerJoin: [[587, 0, 0.07], [740, 0.07, 0.12]],
    peerLeave: [[740, 0, 0.07], [587, 0.07, 0.14]],
    mute: [[440, 0, 0.07], [330, 0.07, 0.11]],
    unmute: [[330, 0, 0.07], [494, 0.07, 0.11]],
    deafen: [[392, 0, 0.07], [262, 0.07, 0.13]],
    undeafen: [[262, 0, 0.07], [392, 0.07, 0.13]],
    camOn: [[660, 0, 0.06], [880, 0.06, 0.1]],
    camOff: [[880, 0, 0.06], [660, 0.06, 0.1]],
    screenOn: [[523, 0, 0.06], [659, 0.06, 0.06], [784, 0.12, 0.11]],
    screenOff: [[784, 0, 0.06], [659, 0.06, 0.06], [523, 0.12, 0.11]],
    disconnected: [[330, 0, 0.12], [220, 0.12, 0.22]],
    message: [[880, 0, 0.05], [1175, 0.05, 0.08]],
  };

  const enabled = () => read('concordo.sounds', true) !== false;
  const volume = () => Math.min(1, Math.max(0, Number(read('concordo.soundVolume', 0.6))));

  function play(name) {
    const notes = NOTES[name];
    if (!notes || !enabled()) return;
    try {
      ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') ctx.resume();
      const t0 = ctx.currentTime + 0.01;
      const vol = 0.18 * volume() * volume(); // curva suave: o controle fica útil em volumes baixos
      for (const [freq, at, dur] of notes) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t0 + at);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + at + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0 + at);
        osc.stop(t0 + at + dur + 0.02);
      }
    } catch {
      /* sem áudio disponível: segue sem som */
    }
  }

  window.ConcordoSounds = { play, names: Object.keys(NOTES) };
})();
