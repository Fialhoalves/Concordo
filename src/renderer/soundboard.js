// Sons do soundboard da chamada, sintetizados na hora (sem arquivos de áudio).
// Quem aperta manda só o id do som; cada pessoa toca no próprio computador, com o próprio volume.
(function () {
  let ctx = null;
  let noiseBuf = null;
  const read = (key, fallback) => {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  };
  const enabled = () => read('concordo.soundboardOn', true) !== false;
  const volume = () => Math.min(1, Math.max(0, Number(read('concordo.soundboardVolume', 0.6))));

  function audio() {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return ctx;
  }

  // nota: type, frequência inicial e final (varredura), duração, volume e entrada/saída suaves
  function tone(out, t, { type = 'sine', f0, f1 = f0, dur, gain = 1, attack = 0.012 }) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }

  function noise(out, t, { dur, gain = 1, freq = 2000, q = 0.7, kind = 'bandpass' }) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = kind;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.0002, gain), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(out);
    src.start(t, Math.random());
    src.stop(t + dur + 0.03);
  }

  const CLIPS = {
    buzina(o, t) {
      for (const f of [466, 622, 740]) tone(o, t, { type: 'sawtooth', f0: f, dur: 0.75, gain: 0.35, attack: 0.03 });
      tone(o, t + 0.85, { type: 'sawtooth', f0: 466, dur: 0.5, gain: 0.35 });
    },
    tambor(o, t) {
      tone(o, t, { type: 'sine', f0: 180, f1: 70, dur: 0.18, gain: 0.9 });
      tone(o, t + 0.2, { type: 'sine', f0: 150, f1: 60, dur: 0.2, gain: 0.9 });
      noise(o, t + 0.45, { dur: 0.5, gain: 0.6, freq: 7000, kind: 'highpass' });
      tone(o, t + 0.45, { type: 'triangle', f0: 320, f1: 180, dur: 0.12, gain: 0.5 });
    },
    palmas(o, t) {
      for (let i = 0; i < 28; i++) noise(o, t + Math.random() * 1.6, { dur: 0.07, gain: 0.5 + Math.random() * 0.4, freq: 1800 + Math.random() * 2500, q: 1.2 });
    },
    triste(o, t) {
      const notes = [[311, 0, 0.4], [294, 0.45, 0.4], [277, 0.9, 0.4], [247, 1.35, 0.9]];
      for (const [f, at, dur] of notes) {
        tone(o, t + at, { type: 'sawtooth', f0: f, f1: f * 0.94, dur, gain: 0.3, attack: 0.04 });
        tone(o, t + at, { type: 'square', f0: f / 2, dur, gain: 0.1, attack: 0.04 });
      }
    },
    sirene(o, t) {
      for (let i = 0; i < 3; i++) {
        tone(o, t + i * 0.7, { type: 'sine', f0: 600, f1: 1100, dur: 0.35, gain: 0.5 });
        tone(o, t + i * 0.7 + 0.35, { type: 'sine', f0: 1100, f1: 600, dur: 0.35, gain: 0.5 });
      }
    },
    sino(o, t) {
      tone(o, t, { type: 'sine', f0: 1319, dur: 1.4, gain: 0.6, attack: 0.004 });
      tone(o, t, { type: 'sine', f0: 2637, dur: 0.8, gain: 0.25, attack: 0.004 });
      tone(o, t, { type: 'sine', f0: 3951, dur: 0.4, gain: 0.12, attack: 0.004 });
    },
    laser(o, t) {
      tone(o, t, { type: 'square', f0: 1500, f1: 160, dur: 0.28, gain: 0.3, attack: 0.004 });
      tone(o, t + 0.32, { type: 'square', f0: 1300, f1: 140, dur: 0.28, gain: 0.3, attack: 0.004 });
    },
    tada(o, t) {
      const seq = [[523, 0], [659, 0.1], [784, 0.2], [1047, 0.35]];
      for (const [f, at] of seq) tone(o, t + at, { type: 'triangle', f0: f, dur: at === 0.35 ? 0.9 : 0.14, gain: 0.5 });
      for (const f of [523, 659, 784]) tone(o, t + 0.35, { type: 'triangle', f0: f, dur: 0.9, gain: 0.25 });
    },
  };

  // sons enviados pelo pessoal da sala: baixa uma vez, decodifica e guarda; toca no máximo 6 s
  const custom = new Map();
  const MAX_SECONDS = 6;
  async function playCustom(id, load) {
    if (!enabled()) return;
    try {
      audio();
      if (!custom.has(id)) custom.set(id, load().then((bytes) => ctx.decodeAudioData(bytes)));
      const buf = await custom.get(id);
      const src = ctx.createBufferSource();
      const master = ctx.createGain();
      const v = volume();
      master.gain.value = Math.min(1, 1.2 * v * v);
      src.buffer = buf;
      src.connect(master).connect(ctx.destination);
      src.start();
      src.stop(ctx.currentTime + MAX_SECONDS);
    } catch {
      custom.delete(id);
    }
  }
  async function inspect(bytes) {
    audio();
    const buf = await ctx.decodeAudioData(bytes.slice(0));
    return buf.duration;
  }
  const forget = (id) => custom.delete(id);

  function play(id) {
    const clip = CLIPS[id];
    if (!clip || !enabled()) return;
    try {
      audio();
      const master = ctx.createGain();
      const v = volume();
      master.gain.value = 0.5 * v * v; // curva suave, como nos sons do app
      master.connect(ctx.destination);
      clip(master, ctx.currentTime + 0.02);
    } catch {
      /* sem áudio disponível */
    }
  }

  window.ConcordoSoundboard = { play, playCustom, inspect, forget, MAX_SECONDS, ids: Object.keys(CLIPS) };
})();
