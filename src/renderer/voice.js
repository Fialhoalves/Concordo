/* Cliente de voz, vídeo e tela do Concordo.
   WebRTC em malha (cada pessoa conecta direto com todas as outras da sala) usando
   "negociação perfeita": os dois lados podem oferecer ao mesmo tempo, e o lado
   "educado" (menor id) desfaz a própria oferta em caso de colisão.
   Este módulo não mexe na interface: expõe estado e avisa mudanças por onChange(). */
(function (root) {
  'use strict';

  // Orçamento de upload de vídeo (bits/s) dividido entre as pessoas da chamada: em malha, cada
  // pessoa recebe uma cópia, e estourar a internet de casa congela vídeo, tela e até a voz.
  const UPLOAD_BUDGET = { cam: 1500000, screen: 3500000 };
  const PER_PEER_MAX = { cam: 1200000, screen: 2500000 };
  const PER_PEER_MIN = { cam: 250000, screen: 600000 };
  const targetBitrate = (kind, peerCount) =>
    Math.round(Math.max(PER_PEER_MIN[kind], Math.min(PER_PEER_MAX[kind], UPLOAD_BUDGET[kind] / Math.max(1, peerCount))));
  const SPEAKING_LEVEL = 0.02;
  const SPEAKING_HOLD_MS = 300;

  function friendlyError(e, what) {
    const name = e && e.name;
    let err;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      err = new Error(`Sem permissão para usar ${what}.`);
      err.cancelled = true; // também é o que acontece quando a pessoa fecha o seletor de tela
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      err = new Error(`Não encontrei ${what}.`);
    } else if (name === 'NotReadableError') {
      err = new Error(`Não consegui acessar ${what}. Outro programa pode estar usando.`);
    } else {
      err = new Error(`Falha ao usar ${what}: ${(e && e.message) || e}`);
    }
    return err;
  }

  const sdpOf = (d) => ({ type: d.type, sdp: d.sdp });

  function createVoiceClient({ myId, send, getIce, getState, onChange, onLocalState, getPrefs }) {
    const prefsNow = () => (getPrefs && getPrefs()) || {};
    const local = {
      // Ids de stream (msid) estáveis durante toda a chamada: ligar e desligar câmera/tela reaproveita
      // o mesmo canal de envio (replaceTrack) em vez de criar uma nova seção SDP a cada vez.
      camMsid: new MediaStream(),
      screenMsid: new MediaStream(),
      channel: null,
      mic: null,
      cam: null,
      screen: null,
      muted: false,
      deafened: false,
      mutedBeforeDeafen: false,
      micError: null,
    };
    const peers = new Map();
    const meters = new Map(); // id do usuário -> medidor de volume
    const speaking = new Set();
    let audioCtx = null;
    let tickTimer = null;
    let audioHost = null;

    const changed = () => onChange && onChange();
    const emitLocal = () =>
      onLocalState &&
      onLocalState({
        muted: local.muted,
        deafened: local.deafened,
        cam: local.cam ? local.camMsid.id : null,
        screen: local.screen ? local.screenMsid.id : null,
      });

    function host() {
      if (!audioHost) {
        audioHost = document.createElement('div');
        audioHost.className = 'voice-audio';
        document.body.append(audioHost);
      }
      return audioHost;
    }

    // ---------- medidor de quem está falando ----------
    function ensureContext() {
      if (!audioCtx) {
        const AC = root.AudioContext || root.webkitAudioContext;
        if (!AC) return null;
        audioCtx = new AC();
        applySink();
      }
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      return audioCtx;
    }

    function startMeter(userId, stream) {
      const existing = meters.get(userId);
      if (existing && existing.streamId === stream.id) return;
      stopMeter(userId);
      const ctx = ensureContext();
      if (!ctx || !stream.getAudioTracks().length) return;
      try {
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        meters.set(userId, { source, analyser, buf: new Uint8Array(analyser.fftSize), until: 0, streamId: stream.id });
        if (!tickTimer) tickTimer = setInterval(tick, 100);
      } catch {
        /* sem WebAudio: só não mostra quem fala */
      }
    }

    function stopMeter(userId) {
      const m = meters.get(userId);
      if (!m) return;
      try {
        m.source.disconnect();
      } catch {
        /* já desconectado */
      }
      meters.delete(userId);
      if (speaking.delete(userId)) changed();
    }

    function tick() {
      const now = Date.now();
      let dirty = false;
      for (const [userId, m] of meters) {
        m.analyser.getByteTimeDomainData(m.buf);
        let sum = 0;
        for (let i = 0; i < m.buf.length; i++) {
          const v = (m.buf[i] - 128) / 128;
          sum += v * v;
        }
        if (Math.sqrt(sum / m.buf.length) > SPEAKING_LEVEL) m.until = now + SPEAKING_HOLD_MS;
        const isOn = now < m.until;
        if (isOn !== speaking.has(userId)) {
          if (isOn) speaking.add(userId);
          else speaking.delete(userId);
          dirty = true;
        }
      }
      if (dirty) changed();
    }

    // ---------- pares ----------
    function classify(peer) {
      const st = getState(peer.id) || {};
      const cam = st.cam ? peer.streams.get(st.cam) || null : null;
      const screen = st.screen ? peer.streams.get(st.screen) || null : null;
      const mic =
        [...peer.streams.values()].find(
          (s) => s !== cam && s !== screen && s.getAudioTracks().length && !s.getVideoTracks().length,
        ) || null;
      return { cam, screen, mic };
    }

    // ---------- volume e saída de som ----------
    const userPrefs = {}; // id -> { mic, screen, muted }  (volume 0..2, 1 = normal)

    function gainFor(id, kind) {
      const p = userPrefs[id] || {};
      if (local.deafened || p.muted) return 0;
      return p[kind] == null ? 1 : p[kind];
    }

    function applyGains() {
      for (const peer of peers.values()) {
        for (const node of peer.audio.values()) {
          const g = gainFor(peer.id, node.kind);
          if (node.gain) node.gain.gain.value = g;
          else node.el.volume = Math.min(1, g);
        }
      }
    }

    function applySink() {
      const id = prefsNow().out || 'default';
      if (audioCtx && typeof audioCtx.setSinkId === 'function') audioCtx.setSinkId(id === 'default' ? '' : id).catch(() => {});
    }

    function syncAudio(peer) {
      const { screen, mic } = classify(peer);
      const want = new Map();
      if (mic) want.set('mic:' + mic.id, { kind: 'mic', stream: mic });
      if (screen) {
        for (const t of screen.getAudioTracks()) {
          const key = 'screen:' + t.id;
          const old = peer.audio.get(key);
          want.set(key, { kind: 'screen', stream: old ? old.stream : new MediaStream([t]) });
        }
      }
      for (const [key, node] of peer.audio) {
        if (!want.has(key)) {
          disposeNode(node);
          peer.audio.delete(key);
        }
      }
      for (const [key, w] of want) {
        if (peer.audio.has(key)) continue;
        const el = document.createElement('audio');
        el.autoplay = true;
        el.srcObject = w.stream;
        host().append(el);
        const node = { kind: w.kind, stream: w.stream, el, src: null, gain: null, probe: null };
        const ctx = ensureContext();
        if (ctx) {
          // o <audio> fica mudo só para manter o fluxo vivo; o som sai pelo WebAudio (permite volume acima de 100%)
          el.muted = true;
          node.src = ctx.createMediaStreamSource(w.stream);
          node.gain = ctx.createGain();
          node.src.connect(node.gain);
          node.gain.connect(ctx.destination);
          node.probe = ctx.createAnalyser();
          node.probe.fftSize = 512;
          node.src.connect(node.probe);
        }
        el.play().catch(() => {});
        peer.audio.set(key, node);
      }
      applyGains();
      if (mic) startMeter(peer.id, mic);
      else stopMeter(peer.id);
    }

    function disposeNode(node) {
      try {
        if (node.src) node.src.disconnect();
        if (node.gain) node.gain.disconnect();
      } catch {
        /* já desconectado */
      }
      node.el.srcObject = null;
      node.el.remove();
    }

    function setUserVolume(id, kind, value) {
      const p = (userPrefs[id] = userPrefs[id] || {});
      p[kind] = Math.max(0, Math.min(2, Number(value)));
      applyGains();
    }

    function setUserMuted(id, muted) {
      const p = (userPrefs[id] = userPrefs[id] || {});
      p.muted = !!muted;
      applyGains();
    }

    function setOutputDevice() {
      applySink();
    }

    // Cada tipo de mídia tem um "slot" fixo por par. Desligar = replaceTrack(null); ligar de novo =
    // replaceTrack(nova faixa). Assim a negociação (SDP) não cresce a cada liga/desliga.
    function attachTrack(peer, kind, track, stream) {
      const key = kind + ':' + track.kind;
      const slot = peer.slots.get(key);
      if (slot) {
        slot.sender.replaceTrack(track).then(() => tuneSenders(peer)).catch(() => {});
        return;
      }
      peer.slots.set(key, { kind, sender: peer.pc.addTrack(track, stream) });
    }

    function addTracksToPeer(peer, kind, stream) {
      const msid = kind === 'cam' ? local.camMsid : kind === 'screen' ? local.screenMsid : stream;
      for (const track of stream.getTracks()) attachTrack(peer, kind, track, msid);
    }

    function removeTracks(kind) {
      for (const peer of peers.values()) {
        for (const slot of peer.slots.values()) {
          if (slot.kind === kind) slot.sender.replaceTrack(null).catch(() => {});
        }
      }
    }

    // ---------- qualidade da transmissão ----------
    const RES_H = { 360: 360, 480: 480, 720: 720, 1080: 1080, 1440: 1440 };
    function quality(kind) {
      const p = prefsNow();
      const isScreen = kind === 'screen';
      const res = String(isScreen ? p.screenRes || '1080' : p.camRes || '720');
      return {
        height: res === 'source' ? 0 : RES_H[res] || 720,
        fps: Number(isScreen ? p.screenFps || 30 : p.camFps || 30),
        kbps: Number(isScreen ? p.screenKbps || 0 : p.camKbps || 0),
      };
    }

    function videoConstraints(kind) {
      const q = quality(kind);
      const out = { frameRate: kind === 'screen' ? { ideal: q.fps, max: q.fps } : { ideal: q.fps } };
      if (q.height) {
        const w = Math.round((q.height * 16) / 9);
        if (kind === 'screen') {
          out.width = { max: w };
          out.height = { max: q.height };
        } else {
          out.width = { ideal: w };
          out.height = { ideal: q.height };
        }
      }
      return out;
    }

    function tuneSenders(peer) {
      for (const { kind, sender } of peer.slots.values()) {
        if (!UPLOAD_BUDGET[kind] || !sender.track || sender.track.kind !== 'video') continue;
        const q = quality(kind);
        const want = q.kbps ? q.kbps * 1000 : targetBitrate(kind, peers.size);
        const height = (sender.track.getSettings && sender.track.getSettings().height) || 0;
        const scale = q.height && height > q.height ? Math.round((height / q.height) * 100) / 100 : 1;
        try {
          const p = sender.getParameters();
          if (!p.encodings || !p.encodings.length) p.encodings = [{}];
          const e = p.encodings[0];
          if (e.maxBitrate === want && e.maxFramerate === q.fps && (e.scaleResolutionDownBy || 1) === scale) continue;
          e.maxBitrate = want;
          e.maxFramerate = q.fps;
          e.scaleResolutionDownBy = scale;
          sender.setParameters(p).catch(() => {});
        } catch {
          /* o navegador ainda não deixa ajustar */
        }
      }
    }

    // Aplica as preferências de qualidade a uma transmissão em andamento.
    function applyQuality() {
      for (const [kind, stream] of [['cam', local.cam], ['screen', local.screen]]) {
        const track = stream && stream.getVideoTracks()[0];
        if (!track) continue;
        track.contentHint = kind === 'screen' ? (quality('screen').fps >= 30 ? 'motion' : 'detail') : '';
        if (track.applyConstraints) track.applyConstraints(videoConstraints(kind)).catch(() => {});
      }
      tuneAll();
    }

    const tuneAll = () => peers.forEach(tuneSenders);

    // ---------- diagnóstico e vigia de travamento ----------
    const eventLog = [];
    function note(msg) {
      eventLog.push(new Date().toLocaleTimeString('pt-BR') + ' ' + msg);
      if (eventLog.length > 60) eventLog.shift();
    }

    async function diagnostics() {
      const lines = ['Concordo — diagnóstico de chamada', 'canal: ' + (local.channel || '-'), 'pares: ' + peers.size];
      for (const peer of peers.values()) {
        lines.push('', '== par ' + peer.id + ' conexão=' + peer.pc.connectionState + ' ice=' + peer.pc.iceConnectionState);
        try {
          const rep = await peer.pc.getStats();
          const byId = new Map();
          rep.forEach((r) => byId.set(r.id, r));
          rep.forEach((r) => {
            if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) {
              const l = byId.get(r.localCandidateId) || {};
              const rm = byId.get(r.remoteCandidateId) || {};
              lines.push(`rota: ${l.candidateType}/${l.protocol} -> ${rm.candidateType}/${rm.protocol}, rtt=${Math.round((r.currentRoundTripTime || 0) * 1000)}ms, disp.saída=${Math.round((r.availableOutgoingBitrate || 0) / 1000)}kbps`);
            }
            if (r.type === 'outbound-rtp' && r.kind === 'video') {
              lines.push(`envio vídeo: ${r.frameWidth || 0}x${r.frameHeight || 0} ${Math.round(r.framesPerSecond || 0)}fps, limitado por=${r.qualityLimitationReason || '-'}, perdas pedidas(nack)=${r.nackCount || 0}`);
            }
            if (r.type === 'inbound-rtp' && r.kind === 'video') {
              lines.push(`recebe vídeo: ${r.frameWidth || 0}x${r.frameHeight || 0} ${Math.round(r.framesPerSecond || 0)}fps, bytes=${r.bytesReceived}, pacotes perdidos=${r.packetsLost}, congelamentos=${r.freezeCount || 0}`);
            }
            if (r.type === 'inbound-rtp' && r.kind === 'audio') {
              lines.push(`recebe áudio: bytes=${r.bytesReceived}, pacotes perdidos=${r.packetsLost}, jitter=${Math.round((r.jitter || 0) * 1000)}ms`);
            }
          });
        } catch (e) {
          lines.push('sem estatísticas: ' + e.message);
        }
      }
      lines.push('', 'eventos recentes:', ...eventLog);
      return lines.join('\n');
    }

    // Se o vídeo recebido para de avançar com a conexão "ok", reinicia o caminho de rede desse par.
    const watch = new Map(); // id do par -> { bytes, stalls }
    let watchTimer = null;
    async function watchdog() {
      for (const peer of peers.values()) {
        if (peer.pc.connectionState !== 'connected') continue;
        const { cam, screen } = classify(peer);
        if (!cam && !screen) {
          watch.delete(peer.id);
          continue;
        }
        let bytes = 0;
        try {
          (await peer.pc.getStats()).forEach((r) => {
            if (r.type === 'inbound-rtp' && r.kind === 'video') bytes += r.bytesReceived;
          });
        } catch {
          continue;
        }
        const w = watch.get(peer.id) || { bytes: -1, stalls: 0 };
        w.stalls = bytes === w.bytes ? w.stalls + 1 : 0;
        w.bytes = bytes;
        watch.set(peer.id, w);
        if (w.stalls >= 3) {
          w.stalls = 0;
          note('vídeo parado de ' + peer.id + ': reiniciando a rota');
          try {
            peer.pc.restartIce();
          } catch {
            /* par fechando */
          }
        }
      }
    }

    function ensurePeer(id, { initiator }) {
      let peer = peers.get(id);
      if (peer) return peer;
      const pc = new RTCPeerConnection({ iceServers: getIce() });
      peer = {
        id,
        pc,
        polite: String(myId) < String(id),
        makingOffer: false,
        ignoreOffer: false,
        queue: Promise.resolve(),
        slots: new Map(),
        streams: new Map(),
        audio: new Map(),
        conn: 'connecting',
      };
      peers.set(id, peer);

      pc.onicecandidate = (e) => {
        if (e.candidate) send(id, { candidate: e.candidate.toJSON() });
      };

      pc.onnegotiationneeded = async () => {
        try {
          peer.makingOffer = true;
          await pc.setLocalDescription();
          send(id, { description: sdpOf(pc.localDescription) });
        } catch (e) {
          console.warn('[voz] negociação:', e && e.message);
        } finally {
          peer.makingOffer = false;
        }
      };

      pc.ontrack = ({ track, streams }) => {
        const stream = streams[0] || new MediaStream([track]);
        peer.streams.set(stream.id, stream);
        stream.onremovetrack = () => {
          if (!stream.getTracks().length) peer.streams.delete(stream.id);
          syncAudio(peer);
          changed();
        };
        syncAudio(peer);
        changed();
      };

      pc.onsignalingstatechange = () => {
        if (pc.signalingState === 'stable') tuneSenders(peer);
      };

      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        peer.conn = s === 'connected' ? 'connected' : s === 'failed' || s === 'closed' ? 'failed' : 'connecting';
        note('par ' + id + ' conexão=' + s);
        clearTimeout(peer.discTimer);
        if (s === 'failed') pc.restartIce();
        else if (s === 'disconnected') peer.discTimer = setTimeout(() => pc.restartIce(), 4000);
        changed();
      };

      if (!watchTimer) watchTimer = setInterval(watchdog, 3000);
      tuneAll();
      let added = 0;
      for (const [kind, stream] of [['mic', local.mic], ['cam', local.cam], ['screen', local.screen]]) {
        if (!stream) continue;
        addTracksToPeer(peer, kind, stream);
        added += stream.getTracks().length;
      }
      // quem inicia precisa ter algo para negociar, mesmo sem microfone (só ouvir)
      if (initiator && !added) pc.addTransceiver('audio', { direction: 'recvonly' });
      return peer;
    }

    function closePeer(id) {
      const peer = peers.get(id);
      if (!peer) return;
      peers.delete(id);
      watch.delete(id);
      clearTimeout(peer.discTimer);
      tuneAll();
      peer.pc.onicecandidate = peer.pc.onnegotiationneeded = peer.pc.ontrack = null;
      peer.pc.onconnectionstatechange = peer.pc.onsignalingstatechange = null;
      try {
        peer.pc.close();
      } catch {
        /* já fechado */
      }
      for (const node of peer.audio.values()) disposeNode(node);
      stopMeter(id);
    }

    async function processSignal(peer, data) {
      const pc = peer.pc;
      if (data.description) {
        const desc = data.description;
        const collision = desc.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;
        await pc.setRemoteDescription(desc);
        if (desc.type === 'offer') {
          await pc.setLocalDescription();
          send(peer.id, { description: sdpOf(pc.localDescription) });
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (e) {
          if (!peer.ignoreOffer) throw e;
        }
      }
    }

    // ---------- dispositivos ----------
    async function openMic() {
      const p = prefsNow();
      const base = {
        echoCancellation: p.echo !== false,
        noiseSuppression: p.noise !== false,
        autoGainControl: p.agc !== false,
      };
      if (p.mic) {
        try {
          return await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: p.mic } } });
        } catch (e) {
          if (e && e.name !== 'OverconstrainedError' && e.name !== 'NotFoundError') throw e;
          /* dispositivo sumiu: usa o padrão */
        }
      }
      return navigator.mediaDevices.getUserMedia({ audio: base });
    }

    async function openCam() {
      const p = prefsNow();
      const base = videoConstraints('cam');
      if (p.cam) {
        try {
          return await navigator.mediaDevices.getUserMedia({ video: { ...base, deviceId: { exact: p.cam } } });
        } catch (e) {
          if (e && e.name !== 'OverconstrainedError' && e.name !== 'NotFoundError') throw e;
        }
      }
      return navigator.mediaDevices.getUserMedia({ video: base });
    }

    // Troca o microfone no meio da chamada, sem renegociar.
    async function restartMic() {
      if (!local.channel) return;
      let next;
      try {
        next = await openMic();
      } catch (e) {
        throw friendlyError(e, 'o microfone');
      }
      const track = next.getAudioTracks()[0];
      track.enabled = !local.muted;
      const had = !!local.mic;
      if (local.mic) local.mic.getTracks().forEach((t) => t.stop());
      stopMeter(myId);
      local.mic = next;
      local.micError = null;
      startMeter(myId, next);
      if (!had) {
        for (const peer of peers.values()) addTracksToPeer(peer, 'mic', next);
      } else {
        for (const peer of peers.values()) {
          const slot = peer.slots.get('mic:audio');
          if (slot) await slot.sender.replaceTrack(track).catch(() => {});
        }
      }
      changed();
    }

    async function restartCamera() {
      if (!local.channel || !local.cam) return;
      let next;
      try {
        next = await openCam();
      } catch (e) {
        throw friendlyError(e, 'a câmera');
      }
      const track = next.getVideoTracks()[0];
      local.cam.getTracks().forEach((t) => {
        t.onended = null;
        t.stop();
      });
      track.onended = () => setCamera(false);
      for (const peer of peers.values()) {
        const slot = peer.slots.get('cam:video');
        if (slot) await slot.sender.replaceTrack(track).catch(() => {});
      }
      tuneAll();
      const old = local.cam;
      for (const t of old.getTracks()) old.removeTrack(t);
      old.addTrack(track);
      tuneAll();
      changed();
    }

    // ---------- API ----------
    async function join(channel, peerIds) {
      if (local.channel) leave();
      local.channel = channel;
      local.muted = false;
      local.deafened = false;
      local.micError = null;
      ensureContext();

      let mic = null;
      try {
        mic = await openMic();
      } catch (e) {
        local.micError = friendlyError(e, 'o microfone').message;
      }
      if (local.channel !== channel) {
        if (mic) mic.getTracks().forEach((t) => t.stop()); // saiu enquanto pedia permissão
        return;
      }
      local.mic = mic;
      if (mic) {
        startMeter(myId, mic);
        // pares criados por sinais que chegaram enquanto o navegador pedia permissão
        for (const peer of peers.values()) addTracksToPeer(peer, 'mic', mic);
      }

      for (const id of peerIds) ensurePeer(id, { initiator: true });
      emitLocal();
      changed();
    }

    function leave() {
      for (const id of [...peers.keys()]) closePeer(id);
      for (const s of [local.mic, local.cam, local.screen]) if (s) s.getTracks().forEach((t) => t.stop());
      stopMeter(myId);
      local.channel = local.mic = local.cam = local.screen = null;
      local.muted = local.deafened = local.mutedBeforeDeafen = false;
      clearInterval(watchTimer);
      watchTimer = null;
      watch.clear();
      if (tickTimer) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
      speaking.clear();
      changed();
    }

    function handleSignal(from, data) {
      if (!local.channel || !data || typeof data !== 'object') return;
      const peer = ensurePeer(from, { initiator: false });
      peer.queue = peer.queue
        .then(() => processSignal(peer, data))
        .catch((e) => console.warn('[voz] sinalização:', e && e.message));
    }

    // Chamado quando o servidor informa quem está na sala: fecha quem saiu e reavalia as mídias.
    function syncRoom(memberIds) {
      const present = new Set(memberIds);
      for (const id of [...peers.keys()]) if (!present.has(id)) closePeer(id);
      for (const peer of peers.values()) syncAudio(peer);
      changed();
    }

    function applyMute() {
      if (local.mic) for (const t of local.mic.getAudioTracks()) t.enabled = !local.muted;
    }

    function setMuted(value) {
      local.muted = !!value;
      if (!local.muted && local.deafened) local.deafened = false; // desmutar tira o "surdo"
      applyMute();
      for (const peer of peers.values()) syncAudio(peer);
      emitLocal();
      changed();
    }

    function setDeafened(value) {
      value = !!value;
      if (value === local.deafened) return;
      local.deafened = value;
      if (value) {
        local.mutedBeforeDeafen = local.muted;
        local.muted = true;
      } else {
        local.muted = local.mutedBeforeDeafen;
      }
      applyMute();
      for (const peer of peers.values()) syncAudio(peer);
      emitLocal();
      changed();
    }

    async function setCamera(on) {
      if (!local.channel) return;
      if (on && !local.cam) {
        let stream;
        try {
          stream = await openCam();
        } catch (e) {
          throw friendlyError(e, 'a câmera');
        }
        if (!local.channel || local.cam) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        local.cam = stream;
        stream.getVideoTracks()[0].onended = () => setCamera(false);
        for (const peer of peers.values()) addTracksToPeer(peer, 'cam', stream);
        tuneAll();
      } else if (!on && local.cam) {
        local.cam.getTracks().forEach((t) => t.stop());
        removeTracks('cam');
        local.cam = null;
      }
      emitLocal();
      changed();
    }

    // prepare(): reativa a captura no processo principal antes de cada tentativa (ele só vale para um pedido).
    async function startScreen({ audio = false, prepare = null } = {}) {
      if (!local.channel || local.screen) return;
      // 1ª tentativa tenta excluir o som do próprio Concordo (voz dos amigos); se o Chromium não entregar áudio assim,
      // a 2ª pede o som do sistema inteiro, que é melhor do que ficar sem.
      const attempts = audio ? [{ suppressLocalAudioPlayback: true, restrictOwnAudio: true }, true] : [false];
      let stream = null;
      let lastError = null;
      for (let i = 0; i < attempts.length; i++) {
        if (prepare) await prepare();
        let got;
        try {
          got = await navigator.mediaDevices.getDisplayMedia({ video: videoConstraints('screen'), audio: attempts[i] });
        } catch (e) {
          lastError = e;
          note('captura de tela falhou (tentativa ' + (i + 1) + '): ' + (e && e.name));
          if (e && e.name === 'NotAllowedError') break; // o usuário cancelou ou o sistema negou: não adianta repetir
          continue;
        }
        const hasAudio = got.getAudioTracks().length > 0;
        note('captura de tela tentativa ' + (i + 1) + ': áudio ' + (hasAudio ? 'sim' : 'não'));
        if (stream) stream.getTracks().forEach((t) => t.stop());
        stream = got;
        if (hasAudio || !audio) break;
      }
      if (!stream) throw friendlyError(lastError, 'a captura de tela');
      local.screenNoAudio = !!audio && !stream.getAudioTracks().length;
      const at = stream.getAudioTracks()[0];
      if (at) note('áudio da tela: ' + (at.label || 'sem rótulo') + ' ' + JSON.stringify(at.getSettings ? at.getSettings() : {}));
      if (!local.channel || local.screen) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      local.screen = stream;
      stream.getVideoTracks()[0].contentHint = quality('screen').fps >= 30 ? 'motion' : 'detail';
      stream.getVideoTracks()[0].onended = () => stopScreen(); // botão "parar compartilhamento" do sistema
      for (const peer of peers.values()) addTracksToPeer(peer, 'screen', stream);
      tuneAll();
      emitLocal();
      changed();
    }

    function stopScreen() {
      if (!local.screen) return;
      local.screen.getTracks().forEach((t) => t.stop());
      removeTracks('screen');
      local.screen = null;
      emitLocal();
      changed();
    }

    return {
      myId,
      join,
      leave,
      setUserVolume,
      setUserMuted,
      setOutputDevice,
      restartMic,
      restartCamera,
      applyQuality,
      // usado nos testes: ganho e sinal de cada fonte de áudio recebida
      diagnostics,
      debugAudio() {
        const out = [];
        for (const peer of peers.values()) {
          for (const [key, node] of peer.audio) {
            let rms = null;
            if (node.probe) {
              const buf = new Uint8Array(node.probe.fftSize);
              node.probe.getByteTimeDomainData(buf);
              let sum = 0;
              for (const b of buf) sum += ((b - 128) / 128) ** 2;
              rms = Math.sqrt(sum / buf.length);
            }
            out.push({ id: peer.id, key, kind: node.kind, gain: node.gain ? node.gain.gain.value : null, rms });
          }
        }
        return out;
      },
      handleSignal,
      syncRoom,
      setMuted,
      setDeafened,
      setCamera,
      startScreen,
      stopScreen,
      state: () => ({
        channel: local.channel,
        muted: local.muted,
        deafened: local.deafened,
        cam: local.cam,
        screen: local.screen,
        micError: local.micError,
        hasMic: !!local.mic,
        screenNoAudio: !!local.screenNoAudio,
      }),
      speaking: (id) => speaking.has(id),
      peerIds: () => [...peers.keys()],
      peer(id) {
        const p = peers.get(id);
        if (!p) return null;
        const { cam, screen } = classify(p);
        return { conn: p.conn, cam, screen };
      },
    };
  }

  root.ConcordoVoice = { createVoiceClient };
})(window);
