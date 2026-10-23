/* Cliente de voz, vídeo e tela do Concordo.
   WebRTC em malha (cada pessoa conecta direto com todas as outras da sala) usando
   "negociação perfeita": os dois lados podem oferecer ao mesmo tempo, e o lado
   "educado" (menor id) desfaz a própria oferta em caso de colisão.
   Este módulo não mexe na interface: expõe estado e avisa mudanças por onChange(). */
(function (root) {
  'use strict';

  const MAX_BITRATE = { cam: 1200000, screen: 3000000 }; // bits/s enviados a CADA pessoa
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

  function createVoiceClient({ myId, send, getIce, getState, onChange, onLocalState }) {
    const local = {
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
        cam: local.cam ? local.cam.id : null,
        screen: local.screen ? local.screen.id : null,
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

    function syncAudio(peer) {
      const { screen, mic } = classify(peer);
      const want = new Map();
      if (mic) want.set('mic:' + mic.id, mic);
      if (screen) {
        for (const t of screen.getAudioTracks()) {
          const key = 'screen:' + t.id;
          want.set(key, (peer.audio.get(key) && peer.audio.get(key).srcObject) || new MediaStream([t]));
        }
      }
      for (const [key, el] of peer.audio) {
        if (!want.has(key)) {
          el.srcObject = null;
          el.remove();
          peer.audio.delete(key);
        }
      }
      for (const [key, stream] of want) {
        let el = peer.audio.get(key);
        if (!el) {
          el = document.createElement('audio');
          el.autoplay = true;
          el.srcObject = stream;
          host().append(el);
          peer.audio.set(key, el);
          el.play().catch(() => {});
        }
        el.muted = local.deafened;
      }
      if (mic) startMeter(peer.id, mic);
      else stopMeter(peer.id);
    }

    function addTracksToPeer(peer, kind, stream) {
      for (const track of stream.getTracks()) {
        if (kind === 'screen' && track.kind === 'video') track.contentHint = 'motion';
        peer.senders.push({ kind, sender: peer.pc.addTrack(track, stream) });
      }
    }

    function tuneSenders(peer) {
      for (const { kind, sender } of peer.senders) {
        if (!MAX_BITRATE[kind] || !sender.track || sender.track.kind !== 'video') continue;
        try {
          const p = sender.getParameters();
          if (!p.encodings || !p.encodings.length) p.encodings = [{}];
          if (p.encodings[0].maxBitrate === MAX_BITRATE[kind]) continue;
          p.encodings[0].maxBitrate = MAX_BITRATE[kind];
          sender.setParameters(p).catch(() => {});
        } catch {
          /* o navegador ainda não deixa ajustar */
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
        senders: [],
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
        if (s === 'failed') pc.restartIce();
        changed();
      };

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
      peer.pc.onicecandidate = peer.pc.onnegotiationneeded = peer.pc.ontrack = null;
      peer.pc.onconnectionstatechange = peer.pc.onsignalingstatechange = null;
      try {
        peer.pc.close();
      } catch {
        /* já fechado */
      }
      for (const el of peer.audio.values()) {
        el.srcObject = null;
        el.remove();
      }
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
        mic = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
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

    function removeTracks(kind) {
      for (const peer of peers.values()) {
        peer.senders = peer.senders.filter((s) => {
          if (s.kind !== kind) return true;
          try {
            peer.pc.removeTrack(s.sender);
          } catch {
            /* par já fechado */
          }
          return false;
        });
      }
    }

    async function setCamera(on) {
      if (!local.channel) return;
      if (on && !local.cam) {
        let stream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
          });
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
      } else if (!on && local.cam) {
        local.cam.getTracks().forEach((t) => t.stop());
        removeTracks('cam');
        local.cam = null;
      }
      emitLocal();
      changed();
    }

    async function startScreen({ audio = false } = {}) {
      if (!local.channel || local.screen) return;
      let stream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio });
      } catch (e) {
        throw friendlyError(e, 'a captura de tela');
      }
      if (!local.channel || local.screen) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      local.screen = stream;
      stream.getVideoTracks()[0].onended = () => stopScreen(); // botão "parar compartilhamento" do sistema
      for (const peer of peers.values()) addTracksToPeer(peer, 'screen', stream);
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
