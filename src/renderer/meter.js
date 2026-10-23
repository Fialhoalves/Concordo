// Medidor de internet do Concordo: quanto o app enviou e recebeu (estimado), por tipo e por dia.
// Os números ficam só neste computador (localStorage). Não mede o Windows inteiro: é o que o app contou.
(function () {
  const KEY = 'concordo.usage';
  const KINDS = ['chat', 'voice', 'host']; // chat = mensagens e arquivos; voice = voz, vídeo e tela; host = servidor das salas que hospedo

  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || { days: {} };
    } catch {
      return { days: {} };
    }
  };
  let stored = read();
  if (!stored.days) stored.days = {};
  let saveTimer = null;

  const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  function save() {
    saveTimer = null;
    const keys = Object.keys(stored.days).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 62))) delete stored.days[k]; // guarda ~2 meses
    try {
      localStorage.setItem(KEY, JSON.stringify(stored));
    } catch {
      /* sem armazenamento */
    }
  }

  const session = {};
  for (const k of KINDS) session[k] = { up: 0, down: 0 };
  const samples = []; // { t, up, down } com os totais da sessão, para calcular a velocidade

  function add(kind, dir, bytes) {
    if (!session[kind] || !(bytes > 0)) return;
    session[kind][dir] += bytes;
    const day = (stored.days[dayKey()] = stored.days[dayKey()] || {});
    day[kind + (dir === 'up' ? 'Up' : 'Down')] = (day[kind + (dir === 'up' ? 'Up' : 'Down')] || 0) + bytes;
    if (!saveTimer) saveTimer = setTimeout(save, 5000);
  }

  // Para fontes que só dizem "total até agora" (chamada, servidor): soma só o que cresceu desde a leitura anterior.
  const lastAbs = new Map();
  function absolute(kind, key, { up, down }) {
    const prev = lastAbs.get(kind + ':' + key) || { up: 0, down: 0 };
    add(kind, 'up', up >= prev.up ? up - prev.up : up);
    add(kind, 'down', down >= prev.down ? down - prev.down : down);
    lastAbs.set(kind + ':' + key, { up, down });
  }

  const sum = (o) => KINDS.reduce((a, k) => ({ up: a.up + (o[k] ? o[k].up : 0), down: a.down + (o[k] ? o[k].down : 0) }), { up: 0, down: 0 });

  function sample() {
    const t = sum(session);
    samples.push({ t: Date.now(), up: t.up, down: t.down });
    while (samples.length > 3) samples.shift();
  }

  function rate() {
    if (samples.length < 2) return { up: 0, down: 0 };
    const a = samples[0];
    const b = samples[samples.length - 1];
    const dt = Math.max(1, (b.t - a.t) / 1000);
    return { up: Math.max(0, (b.up - a.up) / dt), down: Math.max(0, (b.down - a.down) / dt) };
  }

  function daySum(prefix) {
    const out = {};
    for (const k of KINDS) out[k] = { up: 0, down: 0 };
    for (const [d, v] of Object.entries(stored.days)) {
      if (!d.startsWith(prefix)) continue;
      for (const k of KINDS) {
        out[k].up += v[k + 'Up'] || 0;
        out[k].down += v[k + 'Down'] || 0;
      }
    }
    return out;
  }

  const unit = (n, suffix) => {
    if (n < 1024) return `${Math.round(n)} B${suffix}`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0).replace('.', ',')} KB${suffix}`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0).replace('.', ',')} MB${suffix}`;
    return `${(n / 1073741824).toFixed(2).replace('.', ',')} GB${suffix}`;
  };

  window.ConcordoMeter = {
    KINDS,
    add,
    absolute,
    sample,
    rate,
    bytes: (n) => unit(n, ''),
    speed: (n) => unit(n, '/s'),
    snapshot() {
      const now = new Date();
      return { session: { ...session }, today: daySum(dayKey(now)), month: daySum(dayKey(now).slice(0, 7)), rate: rate(), total: sum };
    },
    sum,
    flush: save,
  };
})();
