/* Interface do Concordo. JavaScript puro, sem build.
   Todo texto vindo da rede entra na página via textContent/createTextNode (nunca innerHTML). */
(() => {
  'use strict';

  const bridge = window.concordo;
  const Invite = window.ConcordoInvite;
  const $app = document.getElementById('app');
  const $banner = document.getElementById('banner');
  const $toasts = document.getElementById('toasts');
  // ícones do kit (SVG inline, herdam a cor do texto)
  const mascot = (name, size, alt = '') => h('img', { class: 'mascot', src: `assets/mascot/${name}.png`, width: size, height: size, alt, draggable: 'false' });
  const sfx = (name) => window.ConcordoSounds && window.ConcordoSounds.play(name);

  // ---- medidor de internet: só conta tráfego que sai da máquina (conexões locais do próprio host não contam) ----
  const Meter = window.ConcordoMeter;
  const isLocalUrl = (u) => /^(https?|wss?):\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(String(u || ''));
  const byteLen = (d) => (typeof d === 'string' ? new TextEncoder().encode(d).length : (d && (d.byteLength || d.size)) || 0);
  function meterWs(ws, url) {
    if (!Meter || isLocalUrl(url)) return;
    const send = ws.send.bind(ws);
    ws.send = (d) => {
      Meter.add('chat', 'up', byteLen(d));
      return send(d);
    };
    ws.addEventListener('message', (ev) => Meter.add('chat', 'down', byteLen(ev.data)));
  }
  const ico = (name, size = 20, cls) => window.ConcordoIcons.icon(name, { size, class: cls });

  // ============================================================
  // utilidades
  // ============================================================
  const LS = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v ? JSON.parse(v) : fallback;
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* sem armazenamento: segue sem salvar */
      }
    },
  };

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') Object.assign(el.style, v);
      else if (k === 'value') el.value = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.append(typeof c === 'object' ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function toast(text, kind = '') {
    const t = h('div', { class: 'toast ' + kind }, text);
    $toasts.append(t);
    setTimeout(() => t.remove(), 4800);
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${(bytes / 1073741824).toFixed(2)} GB`;
  }

  function hhmm(ts) {
    return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function dayLabel(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yesterday = new Date(Date.now() - 86400000);
    if (d.toDateString() === today.toDateString()) return 'Hoje';
    if (d.toDateString() === yesterday.toDateString()) return 'Ontem';
    return d.toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' });
  }

  function colorFor(id) {
    // cores de avatar/nome derivadas da paleta da marca (contraste suficiente com texto branco)
    const PALETTE = ['#6d4aff', '#0e9f8e', '#c0457a', '#b7791f', '#2f6fdb', '#8b5cf6', '#0891b2', '#be4b4b'];
    let n = 0;
    for (const ch of String(id)) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
    return PALETTE[n % PALETTE.length];
  }

  // cor do usuário: a que ele escolheu ou uma derivada do id
  function userColor(id) {
    const u = S.users && S.users.get(id);
    return (u && u.color) || colorFor(id);
  }

  function avatar(id, name, { big = false, presence = false } = {}) {
    const u = S.users && S.users.get(id);
    const initial = Array.from((name || '?').trim())[0] || '?';
    const el = h('div', { class: 'avatar' + (big ? ' big' : '') }, initial.toUpperCase());
    el.style.background = userColor(id);
    if (u && u.avatar) {
      el.textContent = '';
      el.style.backgroundImage = `url("${u.avatar}")`;
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
    }
    if (presence) {
      const self = S.session && id === S.session.user.id;
      const on = self ? !(u && u.status === 'invisible') : S.online.has(id);
      const st = on && u && u.status && u.status !== 'invisible' ? ' ' + u.status : '';
      const label = !on ? 'Offline' : u && u.status === 'away' ? 'Ausente' : u && u.status === 'dnd' ? 'Não perturbe' : 'Online';
      el.append(h('span', { class: 'presence' + (on ? ' on' : '') + st, title: label }));
    }
    return el;
  }

  function meButton() {
    const me = S.session.user;
    return h('button', { class: 'who-btn', 'data-act': 'profile', title: 'Meu perfil', onclick: openProfile },
      avatar(me.id, me.name, { presence: true }), h('span', null, me.name));
  }

  function renderMeBar() {
    const old = S.ui.meBar && S.ui.meBar.querySelector('.who-btn');
    if (old) old.replaceWith(meButton());
  }

  // Perfil: foto, cor, situação e frase. A foto é reduzida para 96x96 antes de ir para a sala.
  function resizeAvatar(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const c = document.createElement('canvas');
        c.width = c.height = 96;
        const side = Math.min(img.width, img.height);
        c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 96, 96);
        resolve(c.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Não consegui ler essa imagem.'));
      };
      img.src = url;
    });
  }

  function openProfile() {
    const me = S.session.user;
    const draft = { color: me.color || null, avatar: me.avatar || null };
    const preview = h('div', { class: 'profile-preview' });
    const paint = () => {
      const el = h('div', { class: 'avatar xl' }, Array.from(me.name.trim())[0].toUpperCase());
      el.style.background = draft.color || colorFor(me.id);
      if (draft.avatar) {
        el.textContent = '';
        el.style.backgroundImage = `url("${draft.avatar}")`;
        el.style.backgroundSize = 'cover';
        el.style.backgroundPosition = 'center';
      }
      preview.replaceChildren(el);
    };
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true, 'data-role': 'avatar-file' });
    file.addEventListener('change', async () => {
      if (!file.files[0]) return;
      try {
        draft.avatar = await resizeAvatar(file.files[0]);
        paint();
      } catch (e) {
        toast(e.message, 'error');
      }
      file.value = '';
    });
    const swatches = h('div', { class: 'swatches' });
    const COLORS = [null, '#6d4aff', '#0e9f8e', '#c0457a', '#b7791f', '#2f6fdb', '#8b5cf6', '#0891b2', '#be4b4b', '#4d9a2f'];
    const paintSwatches = () => {
      swatches.replaceChildren(...COLORS.map((c) => {
        const b = h('button', { type: 'button', class: 'swatch' + ((draft.color || null) === c ? ' on' : ''), title: c || 'Automática', 'aria-label': c || 'Cor automática', onclick: () => { draft.color = c; paintSwatches(); paint(); } });
        b.style.background = c || colorFor(me.id);
        if (!c) b.textContent = 'A';
        return b;
      }));
    };
    const status = h('select', { class: 'input', 'data-role': 'profile-status' },
      h('option', { value: 'online' }, 'Online'),
      h('option', { value: 'away' }, 'Ausente'),
      h('option', { value: 'dnd' }, 'Não perturbe (sem sons)'),
      h('option', { value: 'invisible' }, 'Invisível (aparece offline para os outros)'));
    status.value = me.status || 'online';
    const text = h('input', { class: 'input', maxlength: '60', placeholder: 'O que você está fazendo? (opcional)', 'data-role': 'profile-text' });
    text.value = me.statusText || '';
    paint();
    paintSwatches();
    const close = modal([
      h('h3', null, 'Meu perfil'),
      h('div', { class: 'row' }, preview,
        h('div', { class: 'col' },
          h('button', { class: 'btn small', type: 'button', onclick: () => file.click() }, 'Escolher foto'),
          h('button', { class: 'btn small ghost', type: 'button', 'data-act': 'avatar-clear', onclick: () => { draft.avatar = null; paint(); } }, 'Remover foto'))),
      file,
      h('div', { class: 'field' }, h('label', null, 'Cor do seu nome e do avatar nesta sala'), swatches),
      h('div', { class: 'field' }, h('label', null, 'Situação'), status),
      h('div', { class: 'field' }, h('label', null, 'Frase de situação'), text),
      h('div', { class: 'row end' },
        h('button', { class: 'btn', onclick: () => close() }, 'Cancelar'),
        h('button', { class: 'btn primary', 'data-act': 'profile-save', onclick: async () => {
          try {
            await api('PATCH', '/api/me', { color: draft.color, avatar: draft.avatar, status: status.value, statusText: text.value });
            close();
          } catch (e) {
            toast(e.message, 'error');
          }
        } }, 'Salvar')),
    ]);
  }

  function hostOf(url) {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  function cleanNick(raw) {
    return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 24);
  }

  function linkify(text) {
    const out = [];
    const re = /https?:\/\/[^\s<>"']+/g;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      let url = m[0];
      const trail = url.match(/[).,;!?]+$/);
      const tail = trail ? trail[0] : '';
      if (tail) url = url.slice(0, -tail.length);
      out.push(
        h('a', {
          href: url,
          onclick: (e) => {
            e.preventDefault();
            bridge.openExternal(url);
          },
        }, url),
      );
      if (tail) out.push(tail);
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  async function copyText(text, sourceEl) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      if (sourceEl) {
        sourceEl.select();
        document.execCommand('copy');
      }
    }
    toast('Copiado!', 'ok');
  }

  function modal(content) {
    const close = () => overlay.remove();
    const overlay = h('div', {
      class: 'overlay',
      onclick: (e) => {
        if (e.target === overlay) close();
      },
    }, h('div', { class: 'modal' }, content));
    document.body.append(overlay);
    return close;
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const all = document.querySelectorAll('.overlay');
      if (all.length) all[all.length - 1].remove();
    }
  });
  // soltar um arquivo fora da área de upload não pode navegar a janela
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  // ============================================================
  // estado
  // ============================================================
  const S = {
    session: null, // { url, token, user, room }
    isHost: false,
    tunnel: { state: 'starting', message: '' },
    publicUrl: null,
    channels: [],
    users: new Map(),
    online: new Set(),
    limits: { maxUploadBytes: 0, maxMessageLength: 4000 },
    current: null,
    msgs: new Map(), // canal -> { list, hasMore }
    hostedList: [], // salas que eu hospedo: { roomId, name, running, info }
    unread: new Map(),
    away: 0, // mensagens recebidas com a janela sem foco (canal aberto)
    ws: null,
    retry: 0,
    timer: null,
    leaving: false,
    hasConnected: false,
    ui: {},
    update: null,
    ice: [],
    heir: null,
    backup: null, // { at, error } da cópia local da sala (quando sou o sucessor)
    afterTakeover: false,
    succession: [], // ids dos membros na ordem em que assumem a sala se o host sumir
    replyTo: null, // { id, author, text, channel }
    typing: new Map(), // canal -> Map(userId -> timer)
    voice: { rooms: {}, client: null, channel: null, joining: null, focus: null },
  };

  // ============================================================
  // rede
  // ============================================================
  async function request(base, token, method, route, body) {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (Meter && !isLocalUrl(base)) Meter.add('chat', 'up', byteLen(payload) + 300);
    try {
      res = await fetch(base + route, {
        method,
        headers,
        body: payload,
      });
    } catch {
      throw Object.assign(new Error('Não consegui conectar ao servidor. O host está com o Concordo aberto?'), { network: true });
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* sem corpo */
    }
    if (!res.ok) {
      if ([502, 503, 504, 530].includes(res.status) && !(data && data.error)) {
        // a Cloudflare responde assim quando o computador do host fechou o app
        throw Object.assign(new Error('A sala está offline: o host fechou o Concordo ou ficou sem internet.'), { network: true, offline: true });
      }
      throw Object.assign(new Error((data && data.error) || `erro ${res.status}`), { status: res.status });
    }
    return data;
  }

  const api = (method, route, body) => request(S.session.url, S.session.token, method, route, body);
  const fileUrl = (id) => `${S.session.url}/api/files/${id}?token=${encodeURIComponent(S.session.token)}`;

  // ============================================================
  // salas salvas (para reconectar sem convite)
  // ============================================================
  const getRooms = () => LS.get('concordo.rooms', {});

  function saveRoom(session) {
    const rooms = getRooms();
    rooms[session.room.id] = {
      roomId: session.room.id,
      roomName: session.room.name,
      url: session.url,
      token: session.token,
      name: session.user.name,
      userId: session.user.id,
      rv: session.rv || (rooms[session.room.id] && rooms[session.room.id].rv) || '',
      savedAt: Date.now(),
    };
    LS.set('concordo.rooms', rooms);
  }

  // Procura o endereço novo da sala no ponto de encontro. Só vale se a sala responder e reconhecer o seu token.
  async function followAddress(rv, token, currentUrl) {
    if (!rv || !bridge.rendezvousResolve) return null;
    const url = await bridge.rendezvousResolve(rv);
    if (!url || url === currentUrl) return null;
    try {
      const me = await request(url, token, 'GET', '/api/me');
      return { url, me };
    } catch (e) {
      return e && e.status === 401 ? { url, unauthorized: true } : null;
    }
  }

  function forgetRoom(roomId) {
    const rooms = getRooms();
    delete rooms[roomId];
    LS.set('concordo.rooms', rooms);
    if (bridge.backupStop) bridge.backupStop(roomId).catch(() => {});
  }

  // ============================================================
  // telas iniciais
  // ============================================================
  const mount = (...nodes) => $app.replaceChildren(...nodes);

  function showWelcome() {
    teardownChat();
    const hostedRooms = S.hostedList;
    const hostedSig = JSON.stringify(hostedRooms.map((r) => [r.roomId, r.name, r.running]));
    const rooms = Object.values(getRooms()).filter((r) => !hostedRooms.some((x) => x.roomId === r.roomId)).sort((a, b) => b.savedAt - a.savedAt);

    // salas que eu hospedo: abertas neste computador ou fechadas (os dados continuam aqui)
    const hostedRows = hostedRooms.map((r) => {
      const open = h('button', { class: 'btn small primary', 'data-act': 'open-hosted' }, r.running ? 'Voltar' : 'Abrir');
      open.addEventListener('click', async () => {
        open.disabled = true;
        try {
          enterHost(r.running && r.info ? r.info : await bridge.hostOpen(r.roomId));
        } catch (e) {
          toast(e.message, 'error');
          open.disabled = false;
        }
      });
      return h('div', { class: 'saved-item', 'data-hosted': r.roomId },
        h('div', null,
          h('div', { class: 'name' }, r.name || 'Sala'),
          h('div', { class: 'hint' }, 'você hospeda'),
          h('div', { class: 'room-status', 'data-state': r.running ? 'online' : 'offline' }, r.running ? 'aberta neste computador' : 'fechada: abre quando você quiser')),
        h('div', { class: 'row' }, open));
    });

    const rows = new Map(); // roomId -> { status, enter, reopen, note }
    const savedList = rooms.length || hostedRows.length
      ? h('div', { class: 'saved' },
          h('h4', null, 'Suas salas'),
          hostedRows,
          rooms.map((r) => {
            const enter = h('button', { class: 'btn small primary' }, 'Entrar');
            enter.addEventListener('click', () => reconnect(r, enter));
            const status = h('div', { class: 'room-status', 'data-state': 'checking' }, 'verificando…');
            const reopen = h('button', { class: 'btn small primary', 'data-act': 'reopen', hidden: true }, 'Reabrir com a minha cópia');
            const note = h('div', { class: 'hint', hidden: true });
            rows.set(r.roomId, { status, enter, reopen, note, room: r });
            return h('div', { class: 'saved-item' },
              h('div', null,
                h('div', { class: 'name' }, r.roomName || 'Sala'),
                h('div', { class: 'hint' }, `como ${r.name}`),
                status, note),
              h('div', { class: 'row' },
                reopen,
                enter,
                h('button', {
                  class: 'btn small ghost',
                  title: 'Esquecer esta sala',
                  onclick: () => {
                    if (confirm(`Esquecer a sala "${r.roomName}"? Para voltar você vai precisar de um novo convite.`)) {
                      forgetRoom(r.roomId);
                      showWelcome();
                    }
                  },
                }, ico('close', 16))));
          }),
        )
      : null;

    // Quais salas estão abertas agora e de quais eu tenho cópia para reabrir.
    if (rooms.length && bridge.roomsStatus) {
      Promise.all([
        bridge.roomsStatus(rooms.map((r) => ({ roomId: r.roomId, rv: r.rv, url: r.url }))).catch(() => []),
        bridge.backupList ? bridge.backupList().catch(() => []) : [],
      ]).then(([states, copies]) => {
        if (!rows.size || !document.body.contains(Array.from(rows.values())[0].status)) return; // saiu da tela
        const copyOf = new Map((copies || []).map((c) => [c.roomId, c]));
        for (const st of states || []) {
          const row = rows.get(st.roomId);
          if (!row) continue;
          const copy = copyOf.get(st.roomId);
          if (st.state === 'online') {
            row.status.dataset.state = 'online';
            row.status.textContent = st.mine ? 'aberta neste computador' : `aberta${st.host ? ' · hospedada por ' + st.host : ''}`;
          } else {
            row.status.dataset.state = 'offline';
            row.status.textContent = 'fechada: ninguém está hospedando';
            if (copy && row.room.userId && row.room.token) {
              row.reopen.hidden = false;
              row.reopen.textContent = `Reabrir com a minha cópia (${ago(copy.at)})`;
              row.reopen.addEventListener('click', () => reopenRoom(row.room, row.reopen));
              row.enter.className = 'btn small ghost';
              row.enter.textContent = 'Tentar entrar';
            } else {
              row.note.hidden = false;
              row.note.textContent = 'Sem cópia neste computador: espere alguém que tenha reabrir a sala.';
            }
          }
        }
      });
    }

    const version = h('div', { class: 'version' });
    bridge.appInfo().then((i) => (version.textContent = `Concordo v${i.version}`));

    mount(
      h('div', { class: 'center' },
        h('div', { class: 'brand' },
          mascot('acenando-grande', 150, 'Mascote do Concordo acenando'),
          h('div', { class: 'brand-name' }, h('img', { class: 'brand-symbol', src: 'assets/brand/concordo-symbol.svg', alt: '' }), 'Concordo'),
          h('div', { class: 'brand-sign' }, 'Converse · Compartilhe · Juntos')),
        h('p', { class: 'tagline' }, 'Bate-papo entre amigos que roda no seu PC. Sem cadastro e sem servidor de terceiros.'),
        h('div', { class: 'cards' },
          h('button', { class: 'card', onclick: showHostSetup },
            ico('chat', 26),
            h('h3', null, 'Hospedar'),
            h('p', null, 'Crie uma sala. Seu computador vira o servidor e você convida a galera.')),
          h('button', { class: 'card', onclick: () => showJoin() },
            ico('invite', 26),
            h('h3', null, 'Entrar'),
            h('p', null, 'Tem um código de convite? Cole aqui e entre na sala de um amigo.'))),
        savedList,
        version),
    );
    syncBackground();
  }

  async function reconnect(room, button) {
    button.disabled = true;
    try {
      const me = await request(room.url, room.token, 'GET', '/api/me');
      enterGuest({ url: room.url, token: room.token, user: me.user, room: me.room, rv: me.rv || room.rv });
    } catch (e) {
      if (e.status === 401) {
        forgetRoom(room.roomId);
        toast('Você não faz mais parte dessa sala.', 'error');
        showWelcome();
      } else {
        const found = await followAddress(room.rv, room.token, room.url);
        if (found && found.me) {
          return enterGuest({ url: found.url, token: room.token, user: found.me.user, room: found.me.room, rv: found.me.rv || room.rv });
        }
        toast(room.rv
          ? 'A sala está offline agora. Se o host fechou o app, o sucessor assume sozinho em instantes; tente de novo em um minuto.'
          : 'A sala está offline ou mudou de endereço. Peça ao host um novo código de sessão e cole em "Entrar".', 'error');
        button.disabled = false;
      }
    }
  }

  // Reabre a sala a partir da cópia local, mas só se ninguém já tiver aberto (o app confere o ponto de encontro).
  async function reopenRoom(room, button) {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Verificando se alguém já abriu…';
    try {
      await new Promise((r) => setTimeout(r, 4000)); // folga: se outro membro clicou junto, o endereço dele aparece
      const info = await bridge.backupTakeover({ roomId: room.roomId, userId: room.userId, token: room.token });
      if (info && info.online) {
        toast(`${info.host || 'Alguém'} já abriu a sala. Entrando nela…`, 'ok');
        const me = await request(info.url, room.token, 'GET', '/api/me');
        return enterGuest({ url: info.url, token: room.token, user: me.user, room: me.room, rv: me.rv || room.rv });
      }
      S.afterTakeover = true;
      enterHost(info);
    } catch (e) {
      toast(e.message, 'error');
      button.disabled = false;
      button.textContent = label;
    }
  }

  function showHostSetup() {
    const nick = h('input', { class: 'input', maxlength: '24', placeholder: 'Como os amigos vão te ver', value: LS.get('concordo.nick', '') });
    const room = h('input', { class: 'input', maxlength: '40', value: LS.get('concordo.roomName', 'Concordo') });
    const msg = h('div', { class: 'hint' }, 'Cria uma sala nova (você pode hospedar várias ao mesmo tempo). Deixe o Concordo aberto enquanto a galera estiver conversando.');
    const go = h('button', { class: 'btn primary' }, 'Iniciar sala');

    // endereço fixo (opcional): túnel nomeado da Cloudflare
    const fxHost = h('input', { class: 'input', placeholder: 'chat.seudominio.com', 'data-role': 'fixed-host' });
    const fxToken = h('input', { class: 'input', type: 'password', placeholder: 'Token do túnel (eyJ…)', 'data-role': 'fixed-token' });
    const fxPort = h('input', { class: 'input', placeholder: '47800', 'data-role': 'fixed-port' });
    const fxState = h('div', { class: 'hint' });
    const fxClear = h('button', { class: 'btn small ghost', hidden: true }, 'Voltar ao endereço temporário');
    const fixedBox = h('details', { class: 'fixed-box' },
      h('summary', null, 'Endereço fixo (avançado)'),
      h('p', { class: 'hint' }, 'Sem isso, o endereço da sala muda toda vez que você reinicia. Com um túnel nomeado da Cloudflare (precisa de um domínio no Cloudflare), o convite passa a valer sempre e seus amigos reconectam sozinhos.'),
      h('ol', { class: 'hint steps' },
        h('li', null, 'No painel Cloudflare Zero Trust: Networks → Tunnels → Create tunnel (Cloudflared).'),
        h('li', null, 'Copie o token que aparece no comando de instalação (o texto grande depois de --token).'),
        h('li', null, 'Em Public hostname, use seu endereço e aponte para HTTP, URL localhost:47800 (ou a porta abaixo).')),
      h('div', { class: 'field' }, h('label', null, 'Endereço'), fxHost),
      h('div', { class: 'field' }, h('label', null, 'Token'), fxToken),
      h('div', { class: 'field' }, h('label', null, 'Porta local'), fxPort),
      fxState, fxClear);
    if (bridge.getFixedAddress) {
      bridge.getFixedAddress().then((cfg) => {
        if (!cfg) return;
        fxHost.value = cfg.hostname;
        fxPort.value = String(cfg.port);
        fxToken.placeholder = 'Token salvo (deixe em branco para manter)';
        fxState.textContent = 'Endereço fixo ativo: https://' + cfg.hostname;
        fxClear.hidden = false;
        fixedBox.open = true;
      }).catch(() => {});
    }
    fxClear.addEventListener('click', async () => {
      await bridge.clearFixedAddress();
      fxHost.value = fxToken.value = fxPort.value = '';
      fxClear.hidden = true;
      fxState.textContent = 'Voltou ao endereço temporário.';
    });

    go.addEventListener('click', async () => {
      const nickname = cleanNick(nick.value);
      const roomName = room.value.trim() || 'Concordo';
      if (!nickname) {
        msg.className = 'hint error';
        msg.textContent = 'Escolha um apelido.';
        return;
      }
      LS.set('concordo.nick', nickname);
      LS.set('concordo.roomName', roomName);
      go.disabled = true;
      msg.className = 'hint';
      msg.textContent = 'Iniciando…';
      try {
        if (bridge.setFixedAddress && (fxHost.value.trim() || fxToken.value.trim())) {
          await bridge.setFixedAddress({ hostname: fxHost.value, token: fxToken.value, port: fxPort.value });
        }
        enterHost(await bridge.hostStart({ roomName, nickname }));
      } catch (e) {
        go.disabled = false;
        msg.className = 'hint error';
        msg.textContent = 'Não foi possível iniciar: ' + e.message;
      }
    });

    mount(
      h('div', { class: 'center' },
        h('div', { class: 'panel' },
          h('h2', null, 'Hospedar uma sala'),
          h('div', { class: 'field' }, h('label', null, 'Seu apelido'), nick),
          h('div', { class: 'field' }, h('label', null, 'Nome da sala'), room),
          fixedBox,
          msg,
          h('div', { class: 'row between', style: { marginTop: '16px' } },
            h('button', { class: 'btn ghost', onclick: showWelcome }, 'Voltar'),
            go)),
      ),
    );
    nick.focus();
  }

  function showJoin(prefill = '') {
    const code = h('textarea', { class: 'input', placeholder: 'concordo://join/…', value: prefill });
    const nick = h('input', { class: 'input', maxlength: '24', placeholder: 'Como os amigos vão te ver', value: LS.get('concordo.nick', '') });
    const preview = h('div', { class: 'hint' });
    const go = h('button', { class: 'btn primary' }, 'Entrar na sala');

    const updatePreview = () => {
      const d = Invite.decode(code.value);
      preview.className = 'hint';
      if (!code.value.trim()) preview.textContent = '';
      else if (!d) {
        preview.className = 'hint error';
        preview.textContent = 'Código não reconhecido. Cole o código inteiro.';
      } else {
        const known = getRooms()[d.roomId];
        preview.textContent = `Sala "${d.roomName || 'sem nome'}" em ${hostOf(d.url)}` +
          (known ? ` — você já faz parte, como ${known.name}.` : '');
      }
    };
    code.addEventListener('input', updatePreview);
    updatePreview();

    go.addEventListener('click', async () => {
      go.disabled = true;
      preview.className = 'hint';
      preview.textContent = 'Conectando…';
      try {
        await joinWithCode(code.value, nick.value);
      } catch (e) {
        go.disabled = false;
        preview.className = 'hint error';
        preview.textContent = e.message;
      }
    });

    mount(
      h('div', { class: 'center' },
        h('div', { class: 'panel' },
          h('h2', null, 'Entrar numa sala'),
          h('div', { class: 'field' }, h('label', null, 'Código de convite'), code),
          h('div', { class: 'field' }, h('label', null, 'Seu apelido'), nick),
          preview,
          h('div', { class: 'row between', style: { marginTop: '16px' } },
            h('button', { class: 'btn ghost', onclick: showWelcome }, 'Voltar'),
            go)),
      ),
    );
    (prefill ? nick : code).focus();
  }

  async function joinWithCode(codeText, nickname) {
    const d = Invite.decode(codeText);
    if (!d) throw new Error('Código inválido. Cole o código inteiro que o host te mandou.');

    const saved = getRooms()[d.roomId];
    if (saved) {
      try {
        const me = await request(d.url, saved.token, 'GET', '/api/me');
        return enterGuest({ url: d.url, token: saved.token, user: me.user, room: me.room, rv: me.rv || d.rv || saved.rv });
      } catch (e) {
        if (e.status !== 401) throw e;
        forgetRoom(d.roomId); // o host removeu você; tenta de novo como novo membro
      }
    }

    if (!d.invite) {
      throw new Error('Esse código é só para quem já entrou antes. Peça um convite novo ao host.');
    }
    const name = cleanNick(nickname);
    if (!name) throw new Error('Escolha um apelido.');
    LS.set('concordo.nick', name);
    const res = await request(d.url, null, 'POST', '/api/join', { invite: d.invite, name });
    enterGuest({ url: d.url, token: res.token, user: res.user, room: res.room, rv: d.rv });
  }

  function enterGuest(session) {
    S.isHost = false;
    S.session = session;
    saveRoom(session);
    showChat();
  }

  function enterHost(info) {
    S.isHost = true;
    S.session = { url: info.localUrl, token: info.token, user: info.user, room: info.room };
    S.hosted = { roomId: info.room.id, name: info.room.name, localUrl: info.localUrl, token: info.token, userId: info.user.id };
    S.tunnel = { state: info.tunnelState, message: info.tunnelMessage };
    S.publicUrl = info.publicUrl;
    if (!S.hostedList.some((r) => r.roomId === info.room.id)) S.hostedList.push({ roomId: info.room.id, name: info.room.name, running: true, info });
    refreshHosted().then(() => { renderRail(); syncBackground(); });
    showChat();
  }

  // ============================================================
  // chat: montagem da tela
  // ============================================================
  function buildChatDom() {
    const ui = (S.ui = {});
    ui.roomName = h('div', { class: 'room-name' }, S.session.room.name);
    ui.tunnel = h('div', { class: 'status-line' });
    ui.channelList = h('div');
    ui.memberList = h('div');
    ui.chName = h('div', { class: 'ch' }, '#');
    ui.conn = h('div', { class: 'conn' });
    ui.messages = h('div', { class: 'messages' });
    ui.uploadStatus = h('div', { class: 'upload-status' });
    ui.textarea = h('textarea', { rows: '1', placeholder: 'Escreva uma mensagem…', maxlength: '4000' });
    ui.replyBar = h('div', { class: 'reply-bar', hidden: true });
    ui.typing = h('div', { class: 'typing', 'aria-live': 'polite' });
    ui.mentionPop = h('div', { class: 'mention-pop', hidden: true, role: 'listbox' });
    ui.inviteBtn = h('button', { class: 'btn small with-icon', onclick: openInviteModal }, ico('invite', 16), 'Convidar');

    ui.textarea.addEventListener('keydown', (e) => {
      if (S.mention) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          return moveMention(e.key === 'ArrowDown' ? 1 : -1);
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          return chooseMention(S.mention.index);
        }
        if (e.key === 'Escape') return closeMentionPop();
      }
      if (e.key === 'Escape' && S.replyTo) return cancelReply();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    ui.textarea.addEventListener('input', () => {
      autosize();
      updateMentionPop();
      if (ui.textarea.value.trim()) notifyTyping();
    });
    ui.textarea.addEventListener('blur', () => setTimeout(closeMentionPop, 120));
    ui.textarea.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData ? e.clipboardData.files : [])];
      if (files.length) {
        e.preventDefault();
        uploadFiles(files);
      }
    });

    const fileInput = h('input', { type: 'file', multiple: true, style: { display: 'none' } });
    fileInput.addEventListener('change', () => {
      uploadFiles([...fileInput.files]);
      fileInput.value = '';
    });

    const me = S.session.user;
    const meBar = (S.ui.meBar = h('div', { class: 'me-bar' },
      h('div', { class: 'who' }, meButton(),
        h('button', { class: 'btn ghost small', title: 'Áudio e vídeo', 'data-act': 'settings', onclick: openVoiceSettings, 'aria-label': 'Configurações' }, ico('settings', 18))),
      S.isHost
        ? h('div', { class: 'row' },
            ui.inviteBtn,
            h('button', { class: 'btn small danger', onclick: endRoom }, 'Encerrar'))
        : h('div', { class: 'row' }, h('button', { class: 'btn small with-icon', onclick: () => leave() }, ico('log-out', 16), 'Sair da sala'))));

    const addChannelBtn = h('button', { class: 'btn ghost', title: 'Novo canal', 'aria-label': 'Novo canal', onclick: openChannelModal }, ico('plus', 16));

    ui.stage = h('div', { class: 'stage' });
    ui.voicePanel = h('div', { class: 'voice-panel', hidden: true });
    ui.heirNote = h('div', { class: 'heir-note', hidden: true });
    ui.meter = h('button', { class: 'meter', type: 'button', 'data-act': 'usage', title: 'Uso de internet e de disco (clique para ver os detalhes)', onclick: openUsage });
    ui.takeover = h('div', { class: 'takeover', hidden: true });
    ui.main = h('div', { class: 'main' },
      h('div', { class: 'main-head' }, ui.chName,
        h('div', { class: 'head-tools' },
          h('button', { class: 'icon-btn', title: 'Mensagens fixadas', 'aria-label': 'Mensagens fixadas', 'data-act': 'pins', onclick: openPins }, ico('pin', 18)),
          h('button', { class: 'icon-btn', title: 'Buscar mensagens', 'aria-label': 'Buscar mensagens', 'data-act': 'search', onclick: openSearch }, ico('search', 18)),
          ui.conn)),
      ui.takeover,
      ui.stage,
      ui.messages,
      h('div', { class: 'composer-wrap' },
        ui.uploadStatus,
        ui.mentionPop,
        ui.replyBar,
        h('div', { class: 'composer' },
          h('button', { class: 'btn ghost', title: 'Enviar arquivo', onclick: () => fileInput.click(), 'aria-label': 'Enviar arquivo' }, ico('paperclip', 20)),
          fileInput,
          ui.textarea,
          h('button', { class: 'btn primary with-icon', onclick: sendMessage }, ico('send', 16), 'Enviar')),
        ui.typing),
      h('div', { class: 'drop' }, 'Solte os arquivos para enviar'));

    const dragHasFiles = (e) => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files');
    ui.main.addEventListener('dragenter', (e) => dragHasFiles(e) && ui.main.classList.add('dragging'));
    ui.main.addEventListener('dragover', (e) => dragHasFiles(e) && ui.main.classList.add('dragging'));
    ui.main.addEventListener('dragleave', (e) => {
      if (!ui.main.contains(e.relatedTarget)) ui.main.classList.remove('dragging');
    });
    ui.main.addEventListener('drop', (e) => {
      ui.main.classList.remove('dragging');
      if (e.dataTransfer && e.dataTransfer.files.length) uploadFiles([...e.dataTransfer.files]);
    });

    ui.rail = h('nav', { class: 'rail', 'aria-label': 'Salas' });
    mount(
      h('div', { class: 'chat' },
        ui.rail,
        h('aside', { class: 'sidebar' },
          h('div', { class: 'room-head' }, ui.roomName, S.isHost ? ui.tunnel : null),
          h('div', { class: 'side-scroll' },
            h('div', { class: 'section' }, h('span', null, 'Canais'), S.session.user.role === 'owner' ? addChannelBtn : null),
            ui.channelList,
            h('div', { class: 'section' }, h('span', null, 'Membros')),
            ui.memberList),
          ui.voicePanel,
          ui.heirNote,
          ui.meter,
          meBar),
        ui.main),
    );
    renderTunnel();
    renderRail();
    syncBackground();
    setConn(S.ws && S.ws.readyState === 1 ? 'online' : 'connecting');
  }

  // ============================================================
  // várias salas: barra de salas + conexões em segundo plano (só para avisos de mensagens novas)
  // ============================================================
  S.bg = new Map(); // roomId -> { ws, timer, retry }
  S.bgUnread = new Map(); // roomId -> quantidade

  async function refreshHosted() {
    if (!bridge.hostList) return S.hostedList;
    try {
      S.hostedList = (await bridge.hostList()) || [];
    } catch {
      /* mantém a lista anterior */
    }
    return S.hostedList;
  }

  function knownRooms() {
    const list = [];
    for (const r of S.hostedList) list.push({ roomId: r.roomId, name: r.name, hosted: true, running: r.running });
    for (const r of Object.values(getRooms()).sort((a, b) => b.savedAt - a.savedAt)) {
      if (!list.some((x) => x.roomId === r.roomId)) list.push({ ...r, name: r.roomName || r.name, hosted: false });
    }
    return list;
  }

  const initials = (name) => (String(name || '?').trim().match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase();

  function renderRail() {
    const rail = S.ui && S.ui.rail;
    if (!rail || !S.session) return;
    const current = S.session.room.id;
    const items = knownRooms().map((r) => {
      const unread = S.bgUnread.get(r.roomId) || 0;
      const active = r.roomId === current;
      const tile = h('span', { class: 'rail-tile', style: { background: colorFor(r.roomId) } }, initials(r.name));
      return h('button', {
        class: 'rail-item' + (active ? ' active' : ''), 'data-room': r.roomId,
        title: r.name + (r.hosted ? ' (hospedada por você)' : ''), 'aria-label': r.name, 'aria-current': active ? 'true' : 'false',
        onclick: () => switchRoom(r),
      }, tile,
      r.hosted ? h('span', { class: 'rail-crown' }, ico('crown', 12)) : null,
      !active && unread ? h('span', { class: 'rail-badge' }, unread > 99 ? '99+' : String(unread)) : null);
    });
    rail.replaceChildren(...items,
      h('button', { class: 'rail-item add', title: 'Entrar em outra sala ou hospedar', 'aria-label': 'Adicionar sala', 'data-act': 'add-room',
        onclick: () => {
          if (S.voice.client && !confirm('Você está numa chamada. Sair dela para trocar de tela?')) return;
          showWelcome();
        } }, h('span', { class: 'rail-tile plain' }, ico('plus', 20))));
  }

  async function switchRoom(target) {
    if (S.session && target.roomId === S.session.room.id) return;
    if (S.voice.client && !confirm('Você está numa chamada. Trocar de sala tira você dela. Continuar?')) return;
    try {
      let enter;
      if (target.hosted) {
        let info = bridge.hostInfo ? await bridge.hostInfo(target.roomId) : null;
        if (!info) info = await bridge.hostOpen(target.roomId); // estava fechada: abre de novo
        enter = () => enterHost(info);
      } else {
        let url = target.url;
        let me;
        try {
          me = await request(url, target.token, 'GET', '/api/me');
        } catch (e) {
          if (e.status === 401) {
            forgetRoom(target.roomId);
            renderRail();
            throw new Error('Você não faz mais parte dessa sala.');
          }
          const found = await followAddress(target.rv, target.token, target.url);
          if (!found || !found.me) throw e;
          url = found.url;
          me = found.me;
        }
        enter = () => enterGuest({ url, token: target.token, user: me.user, room: me.room, rv: me.rv || target.rv });
      }
      teardownChat();
      S.bgUnread.delete(target.roomId);
      updateBadge();
      enter();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  // Mantém um socket leve em cada sala que NÃO está aberta, só para contar mensagens novas e avisar.
  function syncBackground() {
    const current = S.session ? S.session.room.id : null;
    const wanted = new Map();
    for (const r of Object.values(getRooms())) if (r.roomId !== current) wanted.set(r.roomId, { url: r.url, token: r.token, rv: r.rv, name: r.roomName, userId: r.userId });
    for (const r of S.hostedList) {
      if (r.running && r.info && r.roomId !== current) {
        wanted.set(r.roomId, { url: r.info.localUrl, token: r.info.token, name: r.name, userId: r.info.user.id, local: true });
      }
    }
    for (const [id, c] of S.bg) {
      if (!wanted.has(id)) {
        clearTimeout(c.timer);
        if (c.ws) {
          c.ws.onclose = null;
          c.ws.close();
        }
        S.bg.delete(id);
      }
    }
    for (const [id, info] of wanted) if (!S.bg.has(id)) connectBackground(id, info);
  }

  function connectBackground(id, info) {
    const c = { ws: null, timer: null, retry: 0, info };
    S.bg.set(id, c);
    const open = () => {
      if (S.bg.get(id) !== c) return;
      let ws;
      try {
        ws = new WebSocket(c.info.url.replace(/^http/i, 'ws') + '/ws?token=' + encodeURIComponent(c.info.token));
        meterWs(ws, c.info.url);
      } catch {
        return later();
      }
      c.ws = ws;
      ws.onopen = () => {
        c.retry = 0;
        if (!c.info.local && keepCopy() && bridge.backupStart) {
          bridge.backupStart({ url: c.info.url, token: c.info.token, roomId: id, maxFileBytes: copyCap() }).catch(() => {});
        }
      };
      ws.onmessage = (ev) => {
        let d;
        try {
          d = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (d.t !== 'msg' || !d.message) return;
        const m = d.message;
        if (S.bg.get(id) !== c || m.userId === c.info.userId) return;
        S.bgUnread.set(id, (S.bgUnread.get(id) || 0) + 1);
        renderRail();
        if (notifyMode() === 'none') return;
        sfx('message');
        if (notifyMode() === 'all' || (notifyMode() === 'mentions' && (m.mentions || []).includes(c.info.userId))) {
          try {
            const body = m.text || (m.attachments && m.attachments[0] ? 'Arquivo: ' + m.attachments[0].name : '');
            const n = new Notification(`${m.author} · ${c.info.name || 'outra sala'} · #${m.channel}`, { body });
            n.onclick = () => (bridge.showWindow ? bridge.showWindow() : window.focus());
          } catch {
            /* notificações indisponíveis */
          }
        }
        updateBadge();
      };
      ws.onclose = () => {
        c.ws = null;
        later();
      };
      ws.onerror = () => {};
    };
    const later = async () => {
      if (S.bg.get(id) !== c) return;
      c.retry += 1;
      if (c.retry >= 2 && !c.info.local && c.info.rv) {
        const found = await followAddress(c.info.rv, c.info.token, c.info.url).catch(() => null);
        if (found && found.me) {
          c.info.url = found.url;
          const rooms = getRooms();
          if (rooms[id]) {
            rooms[id].url = found.url;
            LS.set('concordo.rooms', rooms);
          }
        } else if (found && found.unauthorized) {
          forgetRoom(id);
          S.bg.delete(id);
          return renderRail();
        }
      }
      c.timer = setTimeout(open, Math.min(60000, 4000 * 2 ** Math.min(c.retry, 4)));
    };
    open();
  }

  function autosize() {
    const t = S.ui.textarea;
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 160) + 'px';
  }

  // ---- túnel (só o anfitrião) ----
  function renderTunnel() {
    const ui = S.ui;
    if (!S.isHost || !ui.tunnel) return;
    const t = S.tunnel;
    const dotClass = t.state === 'ready' ? 'ok' : t.state === 'error' ? 'bad' : 'warn';
    const label =
      t.state === 'ready' ? 'Online: amigos podem entrar'
      : t.state === 'error' ? t.message || 'Sem túnel'
      : t.message || 'Abrindo o túnel…';
    const nodes = [h('span', { class: 'dot ' + dotClass }), h('span', null, label)];
    if (t.state === 'error') {
      nodes.push(h('button', {
        class: 'btn small',
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            await bridge.hostRetryTunnel(S.session.room.id);
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      }, 'Tentar de novo'));
    }
    ui.tunnel.replaceChildren(...nodes);
    ui.inviteBtn.disabled = t.state !== 'ready';
  }

  function setConn(state) {
    const ui = S.ui;
    if (!ui.conn) return;
    const map = {
      online: ['ok', 'Conectado'],
      connecting: ['warn', 'Conectando…'],
      reconnecting: ['warn', S.retry >= 5
        ? (S.session && S.session.rv ? 'Sem resposta do host. Procurando o novo endereço da sala…' : 'Sem resposta. O host pode ter reiniciado; peça um novo código de sessão.')
        : 'Reconectando…'],
    };
    const [cls, text] = map[state] || map.connecting;
    ui.conn.replaceChildren(h('span', { class: 'dot ' + cls }), text);
  }

  // ============================================================
  // chat: carregamento e renderização
  // ============================================================
  async function showChat() {
    S.leaving = false;
    S.hasConnected = false;
    S.autoTakeover = false;
    S.retry = 0;
    S.msgs = new Map();
    S.unread = new Map();
    S.current = null;
    buildChatDom();
    try {
      await loadState();
      await selectChannel(S.channels[0].id);
    } catch (e) {
      toast(e.message, 'error');
      return leave();
    }
    openSocket();
  }

  async function loadState() {
    const st = await api('GET', '/api/state');
    S.channels = st.channels;
    S.users = new Map(st.users.map((u) => [u.id, u]));
    S.online = new Set(st.online);
    S.limits = st.limits;
    S.ice = st.ice || [];
    S.heir = st.heir || null;
    S.succession = st.succession || [];
    S.voice.rooms = st.voice || {};
    S.session.user = st.you;
    S.session.room = st.room;
    S.ui.roomName.textContent = st.room.name;
    renderChannels();
    renderMembers();
    syncBackup();
  }

  function renderChannels() {
    if (!S.ui.channelList) return;
    S.ui.channelList.replaceChildren(
      ...S.channels.map((ch) => {
        const unread = S.unread.get(ch.id) || 0;
        const isVoice = ch.type === 'voice';
        const row = h('div', {
          class: 'channel' + (ch.id === S.current ? ' active' : '') + (isVoice ? ' voice' : ''),
          'data-channel': ch.id,
          onclick: () => selectChannel(ch.id),
        }, h('span', { class: 'hash' }, ico(isVoice ? 'voice' : 'channels', 18)), h('span', null, ch.name), unread ? h('span', { class: 'badge' }, unread > 99 ? '99+' : unread) : null,
          isVoice ? null : h('button', { class: 'mute-btn', type: 'button', 'data-act': 'mute-channel', title: isMuted(ch.id) ? 'Reativar avisos deste canal' : 'Silenciar este canal', 'aria-label': 'Silenciar canal', onclick: (e) => { e.stopPropagation(); toggleMuteChannel(ch.id); } }, ico('notifications', 14)));
        if (!isVoice && isMuted(ch.id)) row.classList.add('muted');
        if (!isVoice) return row;
        const people = S.voice.rooms[ch.id] || [];
        return h('div', null, row,
          ...people.map((p) => {
            const u = S.users.get(p.id);
            const name = u ? u.name : '?';
            return h('div', {
              class: 'voice-user' + (voiceSpeaking(p.id) ? ' speaking' : ''),
              'data-user': p.id,
            }, avatar(p.id, name), h('span', { class: 'name' }, name),
              p.screen ? h('span', { class: 'live', title: 'Compartilhando a tela' }, 'AO VIVO') : null,
              p.cam ? h('span', { title: 'Câmera ligada' }, ico('camera', 14)) : null,
              voiceSpeaking(p.id) ? eqEl() : null,
              signalEl(p.id),
              p.deafened ? h('span', { title: 'Sem áudio' }, ico('headphones-off', 14)) : p.muted ? h('span', { title: 'Microfone desligado' }, ico('microphone-off', 14)) : null);
          }));
      }),
    );
  }

  function renderMembers() {
    if (!S.ui.memberList) return;
    const me = S.session.user;
    const users = [...S.users.values()].sort((a, b) => {
      const ao = S.online.has(a.id) ? 0 : 1;
      const bo = S.online.has(b.id) ? 0 : 1;
      return ao - bo || a.name.localeCompare(b.name, 'pt-BR');
    });
    S.ui.memberList.replaceChildren(
      ...users.map((u) =>
        h('div', { class: 'member' + (S.online.has(u.id) ? '' : ' offline'), 'data-user': u.id },
          avatar(u.id, u.name, { presence: true }),
          h('span', { class: 'name' }, u.name, u.statusText ? h('small', { class: 'status-text', title: u.statusText }, u.statusText) : null),
          u.role === 'owner' ? h('span', { class: 'crown', title: 'Dono da sala' }, ico('crown', 14)) : null,
          u.id === S.heir ? h('span', { class: 'heir', title: 'Sucessor: guarda uma cópia e assume a sala se o host sair' }, ico('shield-lock', 14)) : null,
          me.role === 'owner' && u.role !== 'owner' && u.id !== S.heir
            ? h('button', {
                class: 'btn small ghost kick',
                title: 'Tornar sucessor (assume a sala se você sair)',
                onclick: () => makeHeir(u),
              }, ico('shield-lock', 14))
            : null,
          me.role === 'owner' && u.id !== me.id
            ? h('button', {
                class: 'btn small ghost kick',
                title: 'Remover da sala',
                onclick: () => removeMember(u),
              }, ico('close', 14))
            : null),
      ),
    );
  }

  async function makeHeir(u) {
    try {
      await api('POST', '/api/heir', { userId: u.id });
      toast(`${u.name} agora é o sucessor da sala.`, 'ok');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function removeMember(u) {
    if (!confirm(`Remover ${u.name} da sala? A pessoa precisará de um novo convite para voltar.`)) return;
    try {
      await api('DELETE', `/api/users/${u.id}`);
      toast(`${u.name} foi removido(a).`, 'ok');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function selectChannel(id) {
    S.current = id;
    S.unread.delete(id);
    updateBadge();
    renderChannels();
    const ch = S.channels.find((c) => c.id === id);
    const isVoice = !!ch && ch.type === 'voice';
    S.ui.chName.replaceChildren(ico(isVoice ? 'voice' : 'channels', 20), document.createTextNode(ch ? ch.name : id));
    S.ui.main.classList.toggle('is-voice', isVoice);
    if (isVoice) {
      renderStage();
      return;
    }
    S.ui.messages.replaceChildren();
    renderTyping();
    if (S.msgs.has(id) && !S.msgs.get(id).partial) renderMessages();
    else {
      try {
        await loadHistory(id);
      } catch (e) {
        toast(e.message, 'error');
      }
    }
    if (S.ui.textarea) S.ui.textarea.focus();
  }

  async function loadHistory(id, { older = false } = {}) {
    const entry = S.msgs.get(id) || { list: [], hasMore: false };
    const q = new URLSearchParams({ limit: '50' });
    if (older && entry.list.length) q.set('before', entry.list[0].id);
    const data = await api('GET', `/api/channels/${id}/messages?${q}`);
    entry.list = older ? [...data.messages, ...entry.list] : data.messages;
    entry.hasMore = data.hasMore;
    if (!older) entry.partial = false;
    S.msgs.set(id, entry);
    if (S.current === id) renderMessages({ keepScroll: older });
  }

  async function loadOlder() {
    try {
      await loadHistory(S.current, { older: true });
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function renderMessages({ keepScroll = false } = {}) {
    const entry = S.msgs.get(S.current);
    const box = S.ui.messages;
    if (!entry || !box) return;
    const prevHeight = box.scrollHeight;
    const prevTop = box.scrollTop;
    const nodes = [];
    if (entry.hasMore) nodes.push(h('button', { class: 'btn small load-older', onclick: loadOlder }, 'Carregar mensagens anteriores'));
    if (!entry.list.length) nodes.push(h('div', { class: 'empty' }, mascot('feliz', 96), h('div', null, 'Nada por aqui ainda. Mande a primeira mensagem!')));
    let prev = null;
    for (const m of entry.list) {
      nodes.push(...messageNodes(m, prev));
      prev = m;
    }
    box.replaceChildren(...nodes);
    box.scrollTop = keepScroll ? box.scrollHeight - prevHeight + prevTop : box.scrollHeight;
  }

  function messageNodes(m, prev) {
    const out = [];
    const sameDay = prev && new Date(prev.ts).toDateString() === new Date(m.ts).toDateString();
    if (!sameDay) out.push(h('div', { class: 'day-sep' }, dayLabel(m.ts)));
    const grouped = !!sameDay && prev.userId === m.userId && m.ts - prev.ts < 5 * 60 * 1000 && !m.replyTo;
    out.push(msgElement(m, grouped));
    return out;
  }

  // texto da mensagem com links e @menções destacadas
  function richText(text) {
    if (!text.includes('@')) return linkify(text);
    const users = [...S.users.values()];
    const names = users.map((u) => u.name).sort((x, y) => y.length - x.length);
    const lower = text.toLowerCase();
    const out = [];
    let buf = '';
    for (let i = 0; i < text.length;) {
      if (text[i] === '@') {
        const hit = names.find((n) => lower.startsWith('@' + n.toLowerCase(), i) && !/[\p{L}\p{N}_]/u.test(text[i + 1 + n.length] || ' '));
        if (hit) {
          if (buf) out.push(...linkify(buf));
          buf = '';
          const u = users.find((x) => x.name === hit);
          out.push(h('span', { class: 'mention' + (u && u.id === S.session.user.id ? ' me' : '') }, text.slice(i, i + 1 + hit.length)));
          i += 1 + hit.length;
          continue;
        }
      }
      buf += text[i];
      i += 1;
    }
    if (buf) out.push(...linkify(buf));
    return out;
  }

  function msgElement(m, grouped) {
    const me = S.session.user;
    const user = S.users.get(m.userId);
    const name = user ? user.name : m.author;
    const author = h('span', { class: 'author' }, name);
    author.style.color = userColor(m.userId);
    const mentioned = !m.deleted && (m.mentions || []).includes(me.id);
    const body = h('div', { class: 'body' },
      grouped ? null : h('div', { class: 'meta' }, author, h('span', { class: 'time' }, hhmm(m.ts)),
        m.pinned ? h('span', { class: 'pin-mark', title: 'Mensagem fixada' }, ico('pin', 13)) : null),
      m.replyTo && !m.deleted
        ? h('button', { class: 'reply-ref', title: 'Ir para a mensagem', onclick: () => jumpToMessage(m.channel, m.replyTo.id) },
          ico('reply', 13), h('b', null, m.replyTo.author), h('span', null, m.replyTo.text || 'anexo'))
        : null,
      m.deleted
        ? h('div', { class: 'text deleted' }, 'Mensagem apagada')
        : (m.text ? h('div', { class: 'text' }, richText(m.text),
          m.editedAt ? h('span', { class: 'edited', title: 'Editada às ' + hhmm(m.editedAt) }, ' (editada)') : null) : null),
      ...(m.deleted ? [] : (m.attachments || []).map(attachmentEl)),
      m.deleted ? null : reactionsEl(m));
    const el = h('div', {
      class: 'msg' + (grouped ? '' : ' head') + (mentioned ? ' mentioned' : '') + (m.pinned ? ' pinned' : '') + (m.deleted ? ' is-deleted' : ''),
      'data-id': m.id,
    }, grouped ? h('div', { class: 'gutter' }, hhmm(m.ts)) : avatar(m.userId, name, { big: true }), body, m.deleted ? null : msgTools(m));
    el.dataset.grouped = grouped ? '1' : '';
    return el;
  }

  function msgTools(m) {
    const me = S.session.user;
    const mine = m.userId === me.id;
    const tool = (act, label, icon, onclick, extra = '') =>
      h('button', { class: 'msg-tool' + extra, title: label, 'aria-label': label, 'data-act': act, onclick }, ico(icon, 16));
    return h('div', { class: 'msg-tools' },
      tool('react-msg', 'Reagir', 'smile', (e) => openReactionPicker(e.currentTarget, (key) => toggleReaction(m.id, key)), ' msg-react'),
      tool('reply-msg', 'Responder', 'reply', () => startReply(m)),
      mine && m.text ? tool('edit-msg', 'Editar', 'edit', () => startEdit(m)) : null,
      tool('pin-msg', m.pinned ? 'Desafixar' : 'Fixar', 'pin', () => msgCall('POST', m.id, '/pin')),
      mine || me.role === 'owner'
        ? tool('delete-msg', 'Apagar', 'trash', () => {
          if (confirm('Apagar esta mensagem para todos?')) msgCall('DELETE', m.id, '');
        }, ' danger')
        : null);
  }

  async function msgCall(method, id, suffix, body) {
    try {
      await api(method, `/api/messages/${id}${suffix}`, body);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function applyMessageUpdate(m) {
    const entry = S.msgs.get(m.channel);
    if (entry) {
      const i = entry.list.findIndex((x) => x.id === m.id);
      if (i >= 0) entry.list[i] = m;
    }
    const el = document.querySelector(`.msg[data-id="${m.id}"]`);
    if (el) el.replaceWith(msgElement(m, el.dataset.grouped === '1'));
    if (S.replyTo && S.replyTo.id === m.id && m.deleted) cancelReply();
  }

  // ---------- responder ----------
  function startReply(m) {
    S.replyTo = { id: m.id, author: m.author, text: (m.text || (m.attachments[0] ? m.attachments[0].name : '')).slice(0, 120), channel: m.channel };
    renderReplyBar();
    if (S.ui.textarea) S.ui.textarea.focus();
  }

  function cancelReply() {
    S.replyTo = null;
    renderReplyBar();
  }

  function renderReplyBar() {
    const bar = S.ui && S.ui.replyBar;
    if (!bar) return;
    const r = S.replyTo;
    bar.hidden = !r;
    bar.replaceChildren(...(r ? [
      ico('reply', 14),
      h('span', { class: 'reply-text' }, 'Respondendo a ', h('b', null, r.author), ': ' + r.text),
      h('button', { class: 'btn small ghost', title: 'Cancelar resposta', 'aria-label': 'Cancelar resposta', onclick: cancelReply }, ico('close', 14)),
    ] : []));
  }

  // ---------- editar ----------
  function startEdit(m) {
    const el = document.querySelector(`.msg[data-id="${m.id}"] .text`);
    if (!el) return;
    const box = h('textarea', { class: 'input edit-box', rows: '2', maxlength: '4000', 'aria-label': 'Editar mensagem' });
    box.value = m.text;
    const done = (save) => {
      const text = box.value.trim();
      if (save && text && text !== m.text) msgCall('PATCH', m.id, '', { text });
      applyMessageUpdate(S.msgs.get(m.channel)?.list.find((x) => x.id === m.id) || m);
    };
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        done(true);
      } else if (e.key === 'Escape') {
        done(false);
      }
    });
    el.replaceChildren(box, h('div', { class: 'hint' }, 'Enter salva · Esc cancela'));
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  }

  // ---------- ir até uma mensagem (respostas, busca, fixadas) ----------
  async function jumpToMessage(channel, id) {
    try {
      if (S.current !== channel) await selectChannel(channel);
      let el = document.querySelector(`.msg[data-id="${id}"]`);
      if (!el) {
        const data = await api('GET', `/api/channels/${channel}/messages?around=${id}&limit=50`);
        S.msgs.set(channel, { list: data.messages, hasMore: data.hasMore, partial: true });
        renderMessages();
        el = document.querySelector(`.msg[data-id="${id}"]`);
      }
      if (!el) return toast('Não encontrei essa mensagem.', 'error');
      el.scrollIntoView({ block: 'center' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 2200);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  // ---------- digitando… ----------
  let lastTypingSent = 0;
  function notifyTyping() {
    const now = Date.now();
    if (now - lastTypingSent < 3000 || !S.current) return;
    lastTypingSent = now;
    wsSend({ t: 'typing', channel: S.current });
  }

  function onTyping(d) {
    if (!S.typing.has(d.channel)) S.typing.set(d.channel, new Map());
    const map = S.typing.get(d.channel);
    clearTimeout(map.get(d.user));
    map.set(d.user, setTimeout(() => {
      map.delete(d.user);
      renderTyping();
    }, 5000));
    renderTyping();
  }

  function renderTyping() {
    const box = S.ui && S.ui.typing;
    if (!box) return;
    const names = [...(S.typing.get(S.current) || new Map()).keys()].map(nameOf);
    box.textContent = !names.length ? '' : names.length === 1 ? `${names[0]} está digitando…`
      : names.length === 2 ? `${names[0]} e ${names[1]} estão digitando…` : 'Várias pessoas estão digitando…';
  }

  // ---------- @menção: sugestões ----------
  function updateMentionPop() {
    const ta = S.ui.textarea;
    const pop = S.ui.mentionPop;
    const before = ta.value.slice(0, ta.selectionStart);
    const m = before.match(/(?:^|\s)@([^\s@]{0,24})$/);
    if (!m) return closeMentionPop();
    const q = m[1].toLowerCase();
    const matches = [...S.users.values()].filter((u) => u.id !== S.session.user.id && u.name.toLowerCase().startsWith(q)).slice(0, 6);
    if (!matches.length) return closeMentionPop();
    S.mention = { items: matches, index: 0, start: ta.selectionStart - m[1].length - 1 };
    pop.hidden = false;
    pop.replaceChildren(...matches.map((u, i) => h('button', {
      class: 'mention-opt' + (i === 0 ? ' active' : ''), type: 'button',
      onmousedown: (e) => {
        e.preventDefault();
        chooseMention(i);
      },
    }, avatar(u.id, u.name, {}), h('span', null, u.name))));
  }

  function closeMentionPop() {
    S.mention = null;
    if (S.ui.mentionPop) S.ui.mentionPop.hidden = true;
  }

  function chooseMention(i) {
    const ta = S.ui.textarea;
    const mn = S.mention;
    if (!mn) return;
    const u = mn.items[i];
    const end = ta.selectionStart;
    ta.value = ta.value.slice(0, mn.start) + '@' + u.name + ' ' + ta.value.slice(end);
    const pos = mn.start + u.name.length + 2;
    ta.setSelectionRange(pos, pos);
    closeMentionPop();
    autosize();
    ta.focus();
  }

  function moveMention(delta) {
    const mn = S.mention;
    mn.index = (mn.index + delta + mn.items.length) % mn.items.length;
    [...S.ui.mentionPop.children].forEach((c, i) => c.classList.toggle('active', i === mn.index));
  }

  // ---------- busca e fixadas ----------
  function openSearch() {
    const input = h('input', { class: 'input', placeholder: 'Buscar mensagens e arquivos…', maxlength: '100', 'data-role': 'search-input', autocomplete: 'off' });
    const list = h('div', { class: 'results' }, h('div', { class: 'hint' }, 'Digite para buscar em todos os canais de texto.'));
    let timer = null;
    let seq = 0;
    const run = async () => {
      const q = input.value.trim();
      const mine = ++seq;
      if (q.length < 2) return list.replaceChildren(h('div', { class: 'hint' }, 'Digite ao menos 2 letras.'));
      try {
        const r = await api('GET', '/api/search?q=' + encodeURIComponent(q));
        if (mine !== seq) return;
        list.replaceChildren(...(r.messages.length
          ? r.messages.map((m) => resultItem(m, close))
          : [h('div', { class: 'empty small' }, mascot('pensativo', 64), h('div', null, 'Nada encontrado.'))]));
      } catch (e) {
        list.replaceChildren(h('div', { class: 'hint error' }, e.message));
      }
    };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(run, 250);
    });
    const close = modal([
      h('h3', null, 'Buscar'),
      input,
      list,
      h('div', { class: 'row end', style: { marginTop: '14px' } }, h('button', { class: 'btn ghost', onclick: () => close() }, 'Fechar')),
    ]);
    input.focus();
  }

  function resultItem(m, close) {
    const text = m.text || (m.attachments[0] ? 'Arquivo: ' + m.attachments[0].name : '');
    return h('button', {
      class: 'result', onclick: () => {
        close();
        jumpToMessage(m.channel, m.id);
      },
    }, h('div', { class: 'result-meta' }, h('b', null, m.author), h('span', null, `#${m.channel} · ${dayLabel(m.ts)} ${hhmm(m.ts)}`)),
    h('div', { class: 'result-text' }, text.slice(0, 160)));
  }

  async function openPins() {
    const list = h('div', { class: 'results' }, h('div', { class: 'hint' }, 'Carregando…'));
    const close = modal([
      h('h3', null, 'Mensagens fixadas'),
      list,
      h('div', { class: 'row end', style: { marginTop: '14px' } }, h('button', { class: 'btn ghost', onclick: () => close() }, 'Fechar')),
    ]);
    try {
      const r = await api('GET', `/api/channels/${S.current}/pins`);
      list.replaceChildren(...(r.messages.length ? r.messages.map((m) => resultItem(m, close)) : [h('div', { class: 'empty small' }, mascot('pensativo', 64), h('div', null, 'Nenhuma mensagem fixada neste canal. Use o alfinete ao passar o mouse sobre uma mensagem.'))]));
    } catch (e) {
      list.replaceChildren(h('div', { class: 'hint error' }, e.message));
    }
  }

  // ---------- reações ----------
  const R = window.ConcordoReactions;

  function reactionFace(key, size) {
    if (key.startsWith('s:')) return h('img', { class: 'rx-img', src: `assets/mascot/${key.slice(2)}.png`, alt: key.slice(2), width: size, height: size, draggable: 'false' });
    return h('span', { class: 'rx-emoji', style: { fontSize: size * 0.8 + 'px' } }, key.slice(2));
  }

  function reactionsEl(m) {
    const me = S.session.user.id;
    const entries = Object.entries(m.reactions || {}).filter(([, ids]) => ids.length);
    const box = h('div', { class: 'reactions', 'data-msg': m.id, hidden: !entries.length });
    for (const [key, ids] of entries) {
      const mine = ids.includes(me);
      const who = ids.map((id) => nameOf(id)).join(', ');
      box.append(h('button', {
        class: 'rx' + (mine ? ' mine' : ''), title: who, 'aria-pressed': mine ? 'true' : 'false',
        onclick: () => toggleReaction(m.id, key),
      }, reactionFace(key, 20), h('span', { class: 'rx-count' }, String(ids.length))));
    }
    return box;
  }

  async function toggleReaction(id, key) {
    try {
      await api('POST', `/api/messages/${id}/reactions`, { key });
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function onReaction(d) {
    const entry = S.msgs.get(d.channel);
    const m = entry && entry.list.find((x) => x.id === d.id);
    if (!m) return;
    m.reactions = d.reactions;
    const old = document.querySelector(`.reactions[data-msg="${d.id}"]`);
    if (old) old.replaceWith(reactionsEl(m));
  }

  // seletor flutuante: figurinhas do mascote + alguns emojis
  function openReactionPicker(anchor, onPick, { up = false } = {}) {
    document.querySelectorAll('.rx-picker').forEach((n) => n.remove());
    const close = () => {
      pop.remove();
      document.removeEventListener('mousedown', outside, true);
      document.removeEventListener('keydown', esc, true);
    };
    const choose = (key) => () => {
      close();
      onPick(key);
    };
    const pop = h('div', { class: 'rx-picker', role: 'dialog', 'aria-label': 'Escolher reação' },
      h('div', { class: 'rx-row stickers' },
        ...R.STICKERS.map((s) => h('button', { class: 'rx-opt', title: s.label, 'aria-label': s.label, onclick: choose('s:' + s.id) }, reactionFace('s:' + s.id, 44)))),
      h('div', { class: 'rx-row emojis' },
        ...R.EMOJI.map((e) => h('button', { class: 'rx-opt small', 'aria-label': e, onclick: choose('e:' + e) }, reactionFace('e:' + e, 30)))));
    const outside = (ev) => {
      if (!pop.contains(ev.target) && !anchor.contains(ev.target)) close();
    };
    const esc = (ev) => {
      if (ev.key === 'Escape') close();
    };
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    const hgt = pop.offsetHeight;
    const left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
    const top = up || r.bottom + hgt + 8 > window.innerHeight ? Math.max(8, r.top - hgt - 8) : r.bottom + 6;
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    setTimeout(() => {
      document.addEventListener('mousedown', outside, true);
      document.addEventListener('keydown', esc, true);
    });
  }

  // reação ao vivo na chamada: sobe pela tela de todo mundo que está no canal de voz
  function floatReaction(from, key) {
    let layer = document.querySelector('.float-layer');
    if (!layer) {
      layer = h('div', { class: 'float-layer', 'aria-hidden': 'true' });
      document.body.append(layer);
    }
    if (layer.childElementCount > 24) return;
    const item = h('div', { class: 'float-rx' }, reactionFace(key, 72), h('span', { class: 'float-name' }, nameOf(from)));
    item.style.left = 8 + Math.random() * 78 + '%';
    item.addEventListener('animationend', () => item.remove());
    layer.append(item);
  }

  function attachmentEl(a) {
    const url = fileUrl(a.id);
    if (/^image\/(png|jpeg|gif|webp)$/.test(a.type)) {
      const img = h('img', { class: 'att-img', src: url, alt: a.name, loading: 'lazy' });
      img.addEventListener('click', () => openLightbox(url));
      return h('div', { class: 'att' }, img);
    }
    return h('div', { class: 'att file' },
      h('div', { class: 'att-icon' }, ico('file', 24)),
      h('div', { class: 'att-info' },
        h('div', { class: 'att-name', title: a.name }, a.name),
        h('div', { class: 'att-size' }, fmtSize(a.size))),
      h('button', { class: 'btn small', onclick: () => bridge.download(url) }, 'Baixar'));
  }

  function openLightbox(url) {
    const ov = h('div', { class: 'overlay lightbox', onclick: () => ov.remove() }, h('img', { src: url, alt: '' }));
    document.body.append(ov);
  }

  function appendMessage(m) {
    const box = S.ui.messages;
    const entry = S.msgs.get(S.current);
    const prev = entry && entry.list.length > 1 ? entry.list[entry.list.length - 2] : null;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
    const empty = box.querySelector('.empty');
    if (empty) empty.remove();
    box.append(...messageNodes(m, prev));
    if (nearBottom || m.userId === S.session.user.id) box.scrollTop = box.scrollHeight;
  }

  // Canais silenciados: sem contador nem som (menções a mim ainda avisam). Guardado por sala neste computador.
  const mutedKey = () => (S.session && S.session.room ? S.session.room.id : '');
  const mutedSet = () => new Set((LS.get('concordo.mutedChannels', {}) || {})[mutedKey()] || []);
  const isMuted = (ch) => mutedSet().has(ch);
  function toggleMuteChannel(ch) {
    const all = LS.get('concordo.mutedChannels', {}) || {};
    const set = mutedSet();
    if (set.has(ch)) set.delete(ch);
    else set.add(ch);
    all[mutedKey()] = [...set];
    LS.set('concordo.mutedChannels', all);
    if (set.has(ch)) S.unread.delete(ch);
    renderChannels();
    updateBadge();
  }
  const dnd = () => !!(S.session && S.users.get(S.session.user.id) && S.users.get(S.session.user.id).status === 'dnd');

  function onIncoming(m) {
    const entry = S.msgs.get(m.channel);
    const isNew = !!entry && !entry.list.some((x) => x.id === m.id);
    if (isNew) entry.list.push(m);
    const mine = m.userId === S.session.user.id;
    if (m.channel === S.current) {
      if (isNew) appendMessage(m);
    } else if (!mine && (!isMuted(m.channel) || (m.mentions || []).includes(S.session.user.id))) {
      S.unread.set(m.channel, (S.unread.get(m.channel) || 0) + 1);
      renderChannels();
    }
    if (S.typing.has(m.channel) && S.typing.get(m.channel).has(m.userId)) {
      clearTimeout(S.typing.get(m.channel).get(m.userId));
      S.typing.get(m.channel).delete(m.userId);
      renderTyping();
    }
    if (!mine && (!isMuted(m.channel) || (m.mentions || []).includes(S.session.user.id))) {
      const away = !document.hasFocus();
      if (away && m.channel === S.current) S.away = (S.away || 0) + 1; // nas outras abas o contador já é o S.unread
      alertIncoming(m, { away, otherChannel: m.channel !== S.current });
    }
  }

  // Aviso de mensagens novas. Padrão ('badge'): só um som e um contador vermelho no ícone, sem popup do Windows.
  // 'mentions': popup só quando citam você; 'all': popup em toda mensagem; 'none': nada.
  const notifyMode = () => LS.get('concordo.notify', 'badge');

  // A mensagem pede popup? (só com a janela sem foco)
  function wantsPopup(m, mine) {
    const mode = notifyMode();
    if (mine || mode === 'badge' || mode === 'none') return false;
    if (mode === 'mentions') return (m.mentions || []).includes(S.session.user.id);
    return true;
  }

  function notify(m) {
    try {
      const user = S.users.get(m.userId);
      const body = m.text || (m.attachments && m.attachments[0] ? 'Arquivo: ' + m.attachments[0].name : '');
      const n = new Notification(`${user ? user.name : m.author} · #${m.channel}`, { body });
      n.onclick = () => (bridge.showWindow ? bridge.showWindow() : window.focus());
    } catch {
      /* notificações indisponíveis */
    }
  }

  // Contador de não lidas no ícone da barra de tarefas (e no tooltip da bandeja).
  function totalUnread() {
    let n = S.away || 0;
    for (const v of S.unread.values()) n += v;
    for (const v of S.bgUnread.values()) n += v;
    return notifyMode() === 'none' ? 0 : n;
  }

  let badgeLast = -1;
  function updateBadge() {
    if (!bridge.setBadge) return;
    const n = totalUnread();
    if (n === badgeLast) return;
    badgeLast = n;
    let icon = null;
    if (n) {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 32;
        const g = c.getContext('2d');
        g.fillStyle = '#e5484d';
        g.beginPath();
        g.arc(16, 16, 15, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#fff';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.font = `bold ${n > 9 ? 17 : 21}px sans-serif`;
        g.fillText(n > 9 ? '9+' : String(n), 16, 17);
        icon = c.toDataURL('image/png');
      } catch {
        /* sem canvas */
      }
    }
    bridge.setBadge(n, icon).catch(() => {});
  }

  // Chegou mensagem de outra pessoa: som se eu não estou olhando para ela, popup só se o modo pedir.
  function alertIncoming(m, { away, otherChannel }) {
    if (notifyMode() === 'none') return;
    if ((away || otherChannel) && !dnd()) sfx('message');
    if (away && wantsPopup(m, false)) notify(m);
    updateBadge();
  }

  // ============================================================
  // envio de mensagens e arquivos
  // ============================================================
  function sendMessage() {
    const text = S.ui.textarea.value.trim();
    if (!text) return;
    if (text.length > S.limits.maxMessageLength) return toast('Mensagem longa demais.', 'error');
    if (!S.ws || S.ws.readyState !== 1) return toast('Sem conexão com a sala. Aguarde a reconexão.', 'error');
    const reply = S.replyTo && S.replyTo.channel === S.current ? S.replyTo.id : undefined;
    S.ws.send(JSON.stringify({ t: 'msg', channel: S.current, text, replyTo: reply }));
    cancelReply();
    closeMentionPop();
    S.ui.textarea.value = '';
    autosize();
  }

  async function uploadFiles(files) {
    for (const f of files) await uploadFile(f, S.current);
  }

  function uploadFile(file, channel) {
    return new Promise((resolve) => {
      const max = S.limits.maxUploadBytes;
      if (!file.size) {
        toast(`"${file.name}" está vazio.`, 'error');
        return resolve();
      }
      if (max && file.size > max) {
        toast(`"${file.name}" passa do limite de ${fmtSize(max)}.`, 'error');
        return resolve();
      }
      const bar = h('div', null);
      const label = h('span', null, `Enviando ${file.name}…`);
      S.ui.uploadStatus.replaceChildren(label, h('div', { class: 'bar' }, bar));
      const done = () => {
        if (S.ui.uploadStatus) S.ui.uploadStatus.replaceChildren();
        resolve();
      };

      const xhr = new XMLHttpRequest();
      if (Meter && !isLocalUrl(S.session.url)) Meter.add('chat', 'up', file.size);
      xhr.open('POST', `${S.session.url}/api/channels/${channel}/upload?name=${encodeURIComponent(file.name)}`);
      xhr.setRequestHeader('Authorization', 'Bearer ' + S.session.token);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) bar.style.width = Math.round((e.loaded / e.total) * 100) + '%';
      };
      xhr.onload = () => {
        if (xhr.status >= 300) {
          let reason = `erro ${xhr.status}`;
          try {
            reason = JSON.parse(xhr.responseText).error || reason;
          } catch {
            /* sem corpo */
          }
          toast(`Falha ao enviar "${file.name}": ${reason}`, 'error');
        }
        done();
      };
      xhr.onerror = () => {
        toast(`Falha ao enviar "${file.name}": sem conexão.`, 'error');
        done();
      };
      xhr.send(file);
    });
  }

  // ============================================================
  // websocket com reconexão
  // ============================================================
  function openSocket() {
    closeSocket();
    const s = S.session;
    const ws = new WebSocket(s.url.replace(/^http/i, 'ws') + '/ws?token=' + encodeURIComponent(s.token));
    meterWs(ws, s.url);
    S.ws = ws;
    setConn('connecting');

    ws.onopen = () => {
      S.retry = 0;
      if (S.handoff && S.session.url !== S.handoff.url) S.handoff = null; // já estou na sala nova
      setTimeout(maybeRejoinVoice, 600);
      if (!S.isHost) {
        api('GET', '/api/me').then((me) => {
          if (me && me.rv && S.session && S.session.rv !== me.rv) {
            S.session.rv = me.rv;
            saveRoom(S.session);
          }
        }).catch(() => {});
      }
      setConn('online');
      renderTakeoverBar();
      if (S.hasConnected) refreshAfterReconnect();
      S.hasConnected = true;
    };
    ws.onmessage = (ev) => {
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      onServerEvent(data);
    };
    ws.onclose = (ev) => {
      if (S.ws !== ws) return;
      S.ws = null;
      if (S.voice.client) {
        S.voiceRejoin = { channel: S.voice.channel, at: Date.now() };
        sfx('disconnected');
        leaveVoice({ silent: true, local: true });
        toast('A conexão caiu e você saiu da chamada de voz.', 'error');
      }
      if (S.leaving) return;
      if (ev.code === 4001) {
        toast('Você foi removido(a) desta sala.', 'error');
        forgetRoom(S.session.room.id);
        return leave();
      }
      setConn('reconnecting');
      scheduleReconnect();
      renderTakeoverBar();
    };
    ws.onerror = () => {};
  }

  function closeSocket() {
    clearTimeout(S.timer);
    if (S.ws) {
      const ws = S.ws;
      S.ws = null;
      ws.onclose = null;
      ws.close();
    }
  }

  // Depois de uma queda ou da troca de host, volta sozinho para a chamada onde eu estava.
  function maybeRejoinVoice(attempt = 0) {
    const r = S.voiceRejoin;
    if (!r || !S.session || S.voice.client || S.voice.joining) return;
    if (Date.now() - r.at > 3 * 60 * 1000) {
      S.voiceRejoin = null;
      return;
    }
    if (!S.channels.some((c) => c.id === r.channel && c.type === 'voice')) {
      if (attempt < 8) setTimeout(() => maybeRejoinVoice(attempt + 1), 1000);
      return;
    }
    S.voiceRejoin = null;
    joinVoice(r.channel);
    toast('Voltando para a chamada…', 'ok');
  }

  function scheduleReconnect() {
    clearTimeout(S.timer);
    const fast = S.handoff && Date.now() - S.handoff.at < 2 * 60 * 1000; // o host avisou que ia sair: não espera à toa
    const delay = fast ? 2000 : Math.min(15000, 1000 * 2 ** Math.min(S.retry, 4));
    S.retry += 1;
    S.timer = setTimeout(async () => {
      if (S.leaving || !S.session) return;
      try {
        await api('GET', '/api/me');
      } catch (e) {
        if (e.status === 401) {
          toast('Você não faz mais parte dessa sala.', 'error');
          forgetRoom(S.session.room.id);
          return leave();
        }
        // o endereço temporário muda a cada vez que o host abre o app: procura o novo no ponto de encontro
        if (!S.isHost && (S.retry >= 2 || S.handoff)) {
          const found = await followAddress(S.session.rv, S.session.token, S.session.url).catch(() => null);
          if (S.leaving || !S.session) return;
          if (found && found.me) {
            S.session.url = found.url;
            if (found.me.rv) S.session.rv = found.me.rv;
            saveRoom(S.session);
            toast('Sala encontrada no novo endereço. Reconectando…', 'ok');
            return openSocket();
          }
        }
        setConn('reconnecting');
        renderTakeoverBar();
        // o host sumiu de vez: o sucessor assume sozinho (os outros o seguem pelo mesmo ponto de encontro)
        if (myRank() >= 0 && S.retry >= 8 + myRank() * 4 && S.session.rv && !S.autoTakeover && !S.checkingCopy) {
          S.checkingCopy = true;
          const copy = await bridge.backupStatus(S.session.room.id).catch(() => null);
          S.checkingCopy = false;
          if (copy && !S.autoTakeover && !S.leaving && S.session) {
            S.autoTakeover = true;
            return takeOverRoom({ auto: true });
          }
        }
        return scheduleReconnect();
      }
      openSocket();
    }, delay);
  }

  async function refreshAfterReconnect() {
    try {
      await loadState();
      if (S.current) await loadHistory(S.current);
    } catch {
      /* a próxima tentativa resolve */
    }
  }

  function onServerEvent(d) {
    switch (d.t) {
      case 'resync':
        refreshAfterReconnect(); // o host recebeu mensagens de uma cópia: recarrega o histórico
        break;
      case 'msg':
        return onIncoming(d.message);
      case 'reaction':
        return onReaction(d);
      case 'host_leaving':
        return onHostLeaving(d);
      case 'msg_update':
        return applyMessageUpdate(d.message);
      case 'typing':
        return onTyping(d);
      case 'live_react':
        return R.isValid(d.key) ? floatReaction(d.from, d.key) : undefined;
      case 'presence':
        S.online = new Set(d.online);
        return renderMembers();
      case 'user':
        S.users.set(d.user.id, d.user);
        if (S.session && d.user.id === S.session.user.id) {
          for (const k of ['color', 'avatar', 'status', 'statusText']) delete S.session.user[k];
          Object.assign(S.session.user, d.user);
          renderMeBar();
        }
        renderMembers();
        return renderChannels();
      case 'user_removed':
        S.users.delete(d.id);
        return renderMembers();
      case 'channel':
        if (!S.channels.some((c) => c.id === d.channel.id)) S.channels.push(d.channel);
        return renderChannels();
      case 'heir':
        S.heir = d.id;
        if (d.succession) S.succession = d.succession;
        renderMembers();
        syncBackup();
        return;
      case 'voice':
        S.voice.rooms = d.rooms || {};
        voiceRoomChanged();
        return;
      case 'voice_joined':
        return onVoiceJoined(d);
      case 'voice_left':
        if (S.voice.client) leaveVoice({ silent: true, local: true });
        return;
      case 'rtc':
        if (S.voice.client) S.voice.client.handleSignal(d.from, d.data);
        return;
      case 'error':
        S.voice.joining = null;
        renderStage();
        return toast(d.message, 'error');
      default:
    }
  }

  // ============================================================
  // uso de internet e de disco (indicador no canto + detalhes)
  // ============================================================
  const meterOn = () => LS.get('concordo.meter', true) !== false;
  let meterTicks = 0;
  let voiceMid = 0;
  let diskInfo = null;

  async function refreshDisk() {
    if (!bridge.usageDisk) return;
    try {
      diskInfo = await bridge.usageDisk();
    } catch {
      /* sem leitura de disco */
    }
  }

  function renderMeterChip() {
    const el = S.ui && S.ui.meter;
    if (!el) return;
    el.hidden = !meterOn();
    if (el.hidden || !Meter) return;
    const r = Meter.rate();
    el.replaceChildren(
      h('span', { class: 'meter-rate' }, '↓ ' + Meter.speed(r.down)),
      h('span', { class: 'meter-rate' }, '↑ ' + Meter.speed(r.up)),
      diskInfo ? h('span', { class: 'meter-disk' }, Meter.bytes(diskInfo.total) + ' em disco') : null);
  }

  async function meterTick() {
    if (!Meter) return;
    meterTicks += 1;
    const c = S.voice && S.voice.client;
    if (c && c.traffic) {
      if (!c.__mid) c.__mid = ++voiceMid;
      Meter.absolute('voice', 'c' + c.__mid, c.traffic());
    }
    if (bridge.usageHost && meterTicks % 3 === 0 && S.hostedList.some((r) => r.running)) {
      try {
        const t = await bridge.usageHost();
        Meter.absolute('host', 'main', { up: t.out, down: t.in });
      } catch {
        /* sem servidor */
      }
    }
    if (meterTicks % 30 === 1 && meterOn()) refreshDisk().then(renderMeterChip);
    Meter.sample();
    renderMeterChip();
  }

  function startMeter() {
    if (!Meter) return;
    try {
      // quanto cada arquivo/imagem/resposta baixada pesou (o servidor libera a medição com Timing-Allow-Origin)
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (!/^https?:/i.test(e.name) || isLocalUrl(e.name)) continue;
          Meter.add('chat', 'down', e.transferSize || e.encodedBodySize || 0);
        }
      }).observe({ type: 'resource' });
    } catch {
      /* sem PerformanceObserver */
    }
    setInterval(meterTick, 2000);
    window.addEventListener('beforeunload', () => Meter.flush());
  }

  function openUsage() {
    if (!Meter) return;
    refreshDisk().then(() => {
      if (document.querySelector('[data-role="usage-modal"]')) refreshUsageBody();
    });
    const body = h('div', { 'data-role': 'usage-body' });
    const close = modal([
      h('div', { 'data-role': 'usage-modal' }),
      h('h3', null, 'Uso de internet e de disco'),
      body,
      h('div', { class: 'row end', style: { marginTop: '14px' } },
        h('button', { class: 'btn ghost', 'data-act': 'hide-meter', onclick: () => {
          LS.set('concordo.meter', false);
          renderMeterChip();
          close();
          toast('Indicador oculto. Para mostrar de novo: Configurações → Aplicativo.', 'ok');
        } }, 'Ocultar indicador'),
        h('button', { class: 'btn primary', onclick: () => close() }, 'Fechar')),
    ]);
    function refreshUsageBody() {
      const snap = Meter.snapshot();
      const row = (label, o) => h('tr', null,
        h('td', null, label),
        h('td', null, '↓ ' + Meter.bytes(o.down)),
        h('td', null, '↑ ' + Meter.bytes(o.up)));
      const names = { chat: 'Mensagens e arquivos', voice: 'Voz, vídeo e tela', host: 'Servidor das salas que hospedo' };
      const part = (title, data) => h('div', null,
        h('h4', { class: 'sub' }, title),
        h('table', { class: 'usage-table' },
          ...Meter.KINDS.filter((k) => k !== 'host' || data.host.up || data.host.down).map((k) => row(names[k], data[k])),
          Object.assign(row('Total', Meter.sum(data)), { className: 'total' })));
      body.replaceChildren(
        h('p', { class: 'hint' }, 'Agora: ↓ ' + Meter.speed(snap.rate.down) + ' · ↑ ' + Meter.speed(snap.rate.up) + '. Os valores são estimativas do que o próprio Concordo contou.'),
        part('Desde que abriu o app', snap.session),
        part('Hoje', snap.today),
        part('Este mês', snap.month),
        h('h4', { class: 'sub' }, 'Disco' + (diskInfo ? ` — ${Meter.bytes(diskInfo.total)}` : '')),
        diskInfo && diskInfo.rooms.length
          ? h('table', { class: 'usage-table' }, ...diskInfo.rooms.map((r) => h('tr', null,
              h('td', null, r.name || r.roomId),
              h('td', null, r.hosted ? 'hospedada ' + Meter.bytes(r.hosted) : ''),
              h('td', null, r.copy ? 'cópia ' + Meter.bytes(r.copy) : ''))))
          : h('p', { class: 'hint' }, 'Nada guardado ainda.'),
        h('p', { class: 'hint' }, 'Cópias guardam as salas dos amigos neste computador. Em Configurações dá para limitar o tamanho dos anexos guardados nelas.'));
    }
    refreshUsageBody();
    const timer = setInterval(() => {
      if (!document.body.contains(body)) return clearInterval(timer);
      refreshUsageBody();
    }, 2000);
  }

  // ============================================================
  // sucessor: cópia da sala e migração de host
  // ============================================================
  // Todo membro guarda uma cópia da sala. Se o host some, assume quem tem cópia e vem primeiro na ordem de sucessão;
  // os demais esperam um pouco mais e, antes de assumir, sempre conferem se alguém já publicou o endereço novo.
  const myRank = () => (S.session && !S.isHost ? S.succession.indexOf(S.session.user.id) : -1);
  const iAmHeir = () => myRank() === 0;
  const keepCopy = () => LS.get('concordo.keepCopy', true) !== false;
  // anexos que entram na cópia: 'all' | '10mb' (padrão) | 'none'
  const copyCap = () => ({ all: undefined, '10mb': 10 * 1024 * 1024, none: 0 }[LS.get('concordo.copyFiles', '10mb')]);

  function syncBackup() {
    if (!bridge.backupStart || !S.session) return;
    if (!S.isHost && keepCopy()) {
      const args = { url: S.session.url, token: S.session.token, roomId: S.session.room.id, maxFileBytes: copyCap() };
      const start = () => bridge.backupStart(args).catch(() => {});
      if (bridge.backupReconcile && S.reconciledUrl !== args.url) {
        // primeiro devolve ao host o que só a minha cópia tem (ele pode ter sido reaberto de uma cópia mais velha)
        S.reconciledUrl = args.url;
        bridge.backupReconcile(args).then((r) => {
          if (r && r.added) toast(`${r.added} mensagem(ns) da sua cópia voltaram para a sala.`, 'ok');
        }).catch(() => {}).finally(start);
      } else {
        start();
      }
      bridge.backupStatus(S.session.room.id).then((info) => {
        if (info && !S.backup) S.backup = info;
        renderHeirNote();
      }).catch(() => {});
    } else if (!S.isHost) {
      bridge.backupStop(S.session.room.id).catch(() => {});
    }
    renderHeirNote();
  }

  function ago(ts) {
    if (!ts) return 'ainda sem cópia';
    const min = Math.round((Date.now() - ts) / 60000);
    return min < 1 ? 'agora há pouco' : min < 60 ? `${min} min atrás` : min < 2880 ? `${Math.round(min / 60)} h atrás` : `${Math.round(min / 1440)} dias atrás`;
  }

  function renderHeirNote() {
    const ui = S.ui;
    if (!ui || !ui.heirNote) return;
    if (S.isHost || !S.session || !keepCopy()) {
      ui.heirNote.hidden = true;
      return;
    }
    ui.heirNote.hidden = false;
    ui.heirNote.replaceChildren(ico('shield-lock', 14),
      document.createTextNode((iAmHeir() ? 'Você é o sucessor desta sala · cópia: ' : 'Cópia da sala neste computador: ') + (S.backup && S.backup.error ? 'falhou (' + S.backup.error + ')' : ago(S.backup && S.backup.at))));
  }

  // O host some: o sucessor vê um aviso fixo e decide se assume.
  function renderTakeoverBar() {
    const ui = S.ui;
    if (!ui || !ui.takeover) return;
    const lost = myRank() >= 0 && S.retry >= 5 + myRank() * 2 && !S.leaving;
    if (!lost) {
      ui.takeover.hidden = true;
      ui.takeover.replaceChildren();
      return;
    }
    if (!ui.takeover.hidden) return;
    ui.takeover.hidden = false;
    bridge.backupStatus(S.session.room.id).then((info) => {
      ui.takeover.replaceChildren(...[
        h('span', null, info
          ? `O host parece ter saído. Você tem uma cópia da sala (${ago(info.at)}).`
          : 'O host parece ter saído, mas você ainda não tem uma cópia desta sala.'),
        info ? h('button', { class: 'btn small primary', 'data-act': 'takeover', onclick: () => takeOverRoom() }, 'Assumir a sala') : null].filter(Boolean));
    });
  }

  // O host avisou que vai sair: o sucessor copia a versão final e assume na hora; os outros esperam o endereço novo.
  async function onHostLeaving(d) {
    if (S.isHost || !S.session) return;
    S.handoff = { at: Date.now(), url: S.session.url };
    if (S.voice.client) S.voiceRejoin = { channel: S.voice.channel, at: Date.now() };
    toast('O host está saindo. A sala passa para o sucessor em instantes…', 'ok');
    if (d && d.heir === S.session.user.id && S.session.rv && !S.autoTakeover) {
      try {
        await bridge.backupSyncNow(S.session.room.id);
      } catch {
        /* usa a última cópia que existir */
      }
      S.autoTakeover = true;
      takeOverRoom({ auto: true, force: true }); // o host avisou que está saindo: o endereço dele ainda responde, mas vai cair
    }
  }

  async function takeOverRoom({ auto = false, force = false } = {}) {
    if (!auto && !confirm('Assumir a sala? Seu computador vira o servidor, com as mensagens e arquivos da última cópia, e você vira o dono. ' +
      'Depois, mande o novo código para o pessoal reconectar. Se o host original voltar, ele deve entrar na sua sala pelo código.')) return;
    const me = S.session.user.id;
    const roomId = S.session.room.id;
    try {
      if (S.voice.client) {
        S.voiceRejoin = { channel: S.voice.channel, at: Date.now() };
        leaveVoice({ silent: true, local: true });
      }
      const info = await bridge.backupTakeover({ roomId, userId: me, token: S.session.token, force });
      if (info && info.online) {
        // o host voltou (ou alguém já assumiu): não abre uma segunda sala, só entra nela
        S.autoTakeover = false;
        S.session.url = info.url;
        saveRoom(S.session);
        toast(`${info.host || 'Alguém'} já está hospedando a sala. Reconectando…`, 'ok');
        S.retry = 0;
        return openSocket();
      }
      closeSocket();
      S.afterTakeover = !auto;
      enterHost(info);
      if (auto) toast('O host saiu e você assumiu a sala. Os amigos reconectam sozinhos em instantes.', 'ok');
    } catch (e) {
      S.autoTakeover = false;
      toast(e.message, 'error');
      if (auto && S.session && !S.isHost) scheduleReconnect();
    }
  }

  // ============================================================
  // voz, vídeo e compartilhamento de tela
  // ============================================================
  function wsSend(obj) {
    if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj));
  }

  // barrinhas de "falando"
  const eqEl = () => h('span', { class: 'eq', 'aria-label': 'Falando' }, h('i'), h('i'), h('i'));

  // sinal de conexão com a pessoa: ping e perda de pacotes
  function signalEl(id) {
    const c = S.voice.client;
    if (!c || !S.session || id === S.session.user.id) return null;
    const q = c.quality(id);
    if (!q) return null;
    const word = { good: 'boa', ok: 'regular', bad: 'ruim' }[q.level];
    const title = `Conexão ${word}: ${q.rtt != null ? q.rtt + ' ms' : 'ping ?'}${q.loss ? ', perda de ' + q.loss + '%' : ''}`;
    return h('span', { class: 'sig ' + q.level, title, role: 'img', 'aria-label': title, 'data-q': q.level }, h('i'), h('i'), h('i'));
  }

  const voiceSpeaking = (id) => !!(S.voice.client && S.voice.client.speaking(id));
  const voiceMembers = (channel) => S.voice.rooms[channel] || [];
  const nameOf = (id) => (S.users.get(id) ? S.users.get(id).name : '?');

  let voiceRenderQueued = false;
  function scheduleVoiceRender() {
    if (voiceRenderQueued) return;
    voiceRenderQueued = true;
    requestAnimationFrame(() => {
      voiceRenderQueued = false;
      if (!S.ui.channelList) return;
      renderChannels();
      renderVoicePanel();
      renderStage();
    });
  }

  function voiceRoomChanged() {
    const v = S.voice;
    if (v.client && v.channel) {
      const me = S.session.user.id;
      const ids = voiceMembers(v.channel).map((p) => p.id);
      if (!ids.includes(me) && !v.joining) {
        // o servidor não me tem mais na sala (ex.: entrei por outra janela)
        return leaveVoice({ silent: true, local: true });
      }
      const others = ids.filter((id) => id !== me);
      if (v.lastIds) {
        if (others.some((id) => !v.lastIds.includes(id))) sfx('peerJoin');
        else if (v.lastIds.some((id) => !others.includes(id))) sfx('peerLeave');
      }
      v.lastIds = others;
      v.client.syncRoom(others);
    }
    scheduleVoiceRender();
  }

  function joinVoice(channel) {
    const v = S.voice;
    if (v.joining) return;
    if (v.client && v.channel === channel) return;
    if (v.client) leaveVoice({ silent: true, local: true });
    v.joining = channel;
    wsSend({ t: 'voice_join', channel });
    scheduleVoiceRender();
  }

  async function onVoiceJoined(d) {
    const v = S.voice;
    if (v.client) leaveVoice({ silent: true, local: true });
    v.joining = null;
    v.channel = d.channel;
    v.focus = null;
    v.lastIds = null;
    sfx('join');
    v.client = window.ConcordoVoice.createVoiceClient({
      myId: S.session.user.id,
      send: (to, data) => wsSend({ t: 'rtc', to, data }),
      getIce: () => S.ice,
      getState: (id) => voiceMembers(v.channel).find((p) => p.id === id),
      onChange: scheduleVoiceRender,
      onLocalState: (st) => wsSend({ t: 'voice_state', ...st }),
      getPrefs: vprefs,
    });
    const client = v.client;
    applySavedUserPrefs(client);
    await client.join(d.channel, d.peers || []);
    if (v.client !== client) return;
    const st = client.state();
    if (!st.hasMic) toast(st.micError || 'Sem microfone: você só vai ouvir.', 'error');
    pttApply();
    scheduleVoiceRender();
  }

  function leaveVoice({ silent = false, local = false } = {}) {
    const v = S.voice;
    if (v.client && !local) sfx('leave');
    v.lastIds = null;
    if (v.client) v.client.leave();
    v.client = null;
    v.channel = null;
    v.joining = null;
    v.focus = null;
    for (const tile of v.tiles ? v.tiles.values() : []) {
      const video = tile.querySelector('video');
      if (video) video.srcObject = null;
    }
    v.tiles = new Map();
    if (!local) wsSend({ t: 'voice_leave' });
    if (!silent) toast('Você saiu da chamada.', 'ok');
    if (S.ui.channelList) scheduleVoiceRender();
  }

  async function voiceAction(fn) {
    try {
      await fn();
    } catch (e) {
      if (!e.cancelled) toast(e.message, 'error');
    }
  }

  function renderVoicePanel() {
    const panel = S.ui.voicePanel;
    if (!panel) return;
    const v = S.voice;
    const active = !!v.client;
    panel.hidden = !active;
    if (!active) return panel.replaceChildren();
    const st = v.client.state();
    const ch = S.channels.find((c) => c.id === v.channel);
    const peers = v.client.peerIds();
    const connected = peers.filter((id) => (v.client.peer(id) || {}).conn === 'connected').length;
    const status = peers.length === 0 ? 'Sozinho(a) na sala' : connected === peers.length ? 'Conectado' : 'Conectando…';
    const btn = (act, label, title, on, onclick, extra = '') =>
      h('button', { class: 'vbtn' + (on ? ' on' : '') + extra, 'data-act': act, title, 'aria-label': title, 'aria-pressed': on ? 'true' : 'false', onclick }, label);
    panel.replaceChildren(...[
      h('div', { class: 'vstatus' },
        h('span', { class: 'dot ' + (connected === peers.length ? 'ok' : 'wait') }),
        h('div', null,
          h('div', { class: 'vtitle' }, status),
          h('div', { class: 'vsub' }, ch ? ch.name : '')),
        ),
      !st.hasMic ? h('div', { class: 'vwarn' }, 'Sem microfone — você só ouve.') : null,
      h('div', { class: 'vbtns' },
        btn('mute', ico(st.muted ? 'microphone-off' : 'microphone', 20), st.muted ? 'Ligar microfone' : 'Silenciar microfone', st.muted,
          () => {
            sfx(st.muted ? 'unmute' : 'mute');
            v.client.setMuted(!st.muted);
          }, ' danger-on'),
        btn('deafen', ico(st.deafened ? 'headphones-off' : 'headphones', 20), st.deafened ? 'Voltar a ouvir' : 'Ensurdecer (não ouvir ninguém)', st.deafened,
          () => {
            sfx(st.deafened ? 'undeafen' : 'deafen');
            v.client.setDeafened(!st.deafened);
          }, ' danger-on'),
        btn('cam', ico(st.cam ? 'camera' : 'camera-off', 20), st.cam ? 'Desligar câmera' : 'Ligar câmera', !!st.cam,
          () => voiceAction(async () => {
            await v.client.setCamera(!st.cam);
            sfx(st.cam ? 'camOff' : 'camOn');
          })),
        btn('screen', ico('screen-share', 20), st.screen ? 'Parar de compartilhar a tela' : 'Compartilhar tela', !!st.screen,
          () => {
            if (st.screen) {
              v.client.stopScreen();
              sfx('screenOff');
            } else {
              voiceAction(async () => {
                await startScreenShare();
              });
            }
          }),
        btn('react', ico('smile', 20), 'Reagir na chamada', false,
          (e) => openReactionPicker(e.currentTarget, (key) => wsSend({ t: 'live_react', key }), { up: true })),
        btn('leave', ico('call-end', 20), 'Sair da chamada', false, () => leaveVoice(), ' leave')),
    ].filter(Boolean));
  }

  function tileFor(key) {
    const v = S.voice;
    if (!v.tiles) v.tiles = new Map();
    let tile = v.tiles.get(key);
    if (tile) return tile;
    const video = h('video', { autoplay: true, playsinline: true, muted: true });
    video.muted = true;
    tile = h('div', { class: 'tile', 'data-key': key, onclick: () => {
      v.focus = v.focus === key ? null : key;
      renderStage();
    } },
      video,
      h('div', { class: 'tile-avatar' }),
      h('div', { class: 'tile-label' }),
      h('div', { class: 'tile-tools' },
        h('button', { class: 'tile-fit', title: 'Preencher o quadro (pode cortar as bordas)', 'aria-label': 'Alternar entre tela inteira e preencher', onclick: (e) => {
          e.stopPropagation();
          tile.classList.toggle('fill');
        } }, ico('fit', 16)),
        document.pictureInPictureEnabled ? h('button', { class: 'tile-pip', title: 'Janela flutuante (fica por cima de outros apps)', 'aria-label': 'Janela flutuante', onclick: async (e) => {
          e.stopPropagation();
          try {
            if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
            else await video.requestPictureInPicture();
          } catch {
            toast('Não consegui abrir a janela flutuante para este vídeo.', 'error');
          }
        } }, ico('pip', 16)) : null,
        h('button', { class: 'tile-full', title: 'Tela cheia', 'aria-label': 'Tela cheia', onclick: (e) => {
          e.stopPropagation();
          if (video.requestFullscreen) video.requestFullscreen().catch(() => {});
        } }, ico('maximize', 16))));
    v.tiles.set(key, tile);
    return tile;
  }

  function fillTile(tile, { id, kind, stream, conn, entry }) {
    const video = tile.querySelector('video');
    if ((video.srcObject || null) !== (stream || null)) {
      video.srcObject = stream || null;
      if (stream) video.play().catch(() => {});
    }
    video.hidden = !stream;
    if (stream && video.paused) video.play().catch(() => {});
    const av = tile.querySelector('.tile-avatar');
    av.hidden = !!stream;
    if (!stream && !av.firstChild) av.append(avatar(id, nameOf(id), { big: true }));
    tile.dataset.kind = kind;
    tile.dataset.user = id;
    tile.dataset.conn = conn;
    tile.classList.toggle('speaking', kind === 'user' && voiceSpeaking(id));
    tile.classList.toggle('screen', kind === 'screen');
    const label = tile.querySelector('.tile-label');
    const me = id === S.session.user.id;
    const base = nameOf(id) + (me ? ' (você)' : '') + (kind === 'screen' ? ' — tela' : '');
    const state = kind === 'user' && entry ? (entry.deafened ? ico('headphones-off', 14) : entry.muted ? ico('microphone-off', 14) : null) : null;
    label.replaceChildren(document.createTextNode(base), ...(state ? [state] : []),
      ...(kind === 'user' && voiceSpeaking(id) ? [eqEl()] : []),
      ...(kind === 'user' && !me ? [signalEl(id)].filter(Boolean) : []),
      document.createTextNode(conn === 'connecting' ? ' · conectando…' : conn === 'failed' ? ' · sem conexão' : ''));
  }

  function renderStage() {
    const stage = S.ui.stage;
    if (!stage) return;
    const ch = S.channels.find((c) => c.id === S.current);
    if (!ch || ch.type !== 'voice') return;
    const v = S.voice;
    const here = v.client && v.channel === ch.id;
    if (!here) {
      const people = voiceMembers(ch.id);
      const full = people.length >= ((S.limits && S.limits.maxVoice) || 8);
      stage.className = 'stage lobby';
      stage.replaceChildren(
        h('div', { class: 'lobby-card' },
          people.length ? h('div', { class: 'lobby-icon' }, ico('voice', 44)) : mascot('oculos', 96, ''),
          h('h2', null, ch.name),
          h('p', { class: 'hint' }, people.length
            ? people.map((p) => nameOf(p.id)).join(', ') + (people.length === 1 ? ' está aqui.' : ' estão aqui.')
            : 'Ninguém na chamada ainda.'),
          h('button', {
            class: 'btn primary',
            'data-act': 'join',
            disabled: v.joining || full ? true : null,
            onclick: () => joinVoice(ch.id),
          }, v.joining === ch.id ? 'Entrando…' : full ? 'Sala cheia' : 'Entrar na chamada'),
          h('p', { class: 'hint small' }, 'Voz e vídeo vão direto entre os computadores. Até 8 pessoas; fica melhor com poucas.')));
      return;
    }

    const me = S.session.user.id;
    const st = v.client.state();
    const entries = voiceMembers(ch.id);
    const wanted = [];
    for (const p of entries) {
      const mine = p.id === me;
      const info = mine ? { conn: 'self', cam: st.cam, screen: st.screen } : v.client.peer(p.id) || { conn: 'connecting' };
      wanted.push({ key: p.id + ':user', id: p.id, kind: 'user', stream: info.cam || null, conn: info.conn, entry: p });
      if (info.screen) wanted.push({ key: p.id + ':screen', id: p.id, kind: 'screen', stream: info.screen, conn: info.conn, entry: p });
    }
    if (v.focus && !wanted.some((w) => w.key === v.focus)) v.focus = null;
    const nodes = wanted.map((w) => {
      const tile = tileFor(w.key);
      fillTile(tile, w);
      tile.classList.toggle('focused', v.focus === w.key);
      return tile;
    });
    for (const key of [...v.tiles.keys()]) {
      if (!wanted.some((w) => w.key === key)) {
        const gone = v.tiles.get(key);
        const video = gone.querySelector('video');
        if (video) video.srcObject = null;
        v.tiles.delete(key);
      }
    }
    stage.className = 'stage live' + (v.focus ? ' has-focus' : '') + ' n' + Math.min(nodes.length, 9);
    const same = nodes.length === stage.children.length && nodes.every((n, i) => stage.children[i] === n);
    if (!same) stage.replaceChildren(...nodes);
  }

  // ---------- preferências de áudio/vídeo e menu de contexto ----------
  const VPREFS_KEY = 'concordo.voice';
  const vprefs = () => {
    const p = LS.get(VPREFS_KEY, {});
    p.users = p.users || {};
    return p;
  };
  const saveVprefs = (p) => LS.set(VPREFS_KEY, p);

  function applySavedUserPrefs(client) {
    const users = vprefs().users;
    for (const [id, u] of Object.entries(users)) {
      if (u.mic != null) client.setUserVolume(id, 'mic', u.mic);
      if (u.screen != null) client.setUserVolume(id, 'screen', u.screen);
      if (u.muted) client.setUserMuted(id, true);
    }
  }

  function setUserPref(id, patch) {
    const p = vprefs();
    p.users[id] = { ...(p.users[id] || {}), ...patch };
    saveVprefs(p);
    const c = S.voice.client;
    if (!c) return;
    if ('mic' in patch) c.setUserVolume(id, 'mic', patch.mic);
    if ('screen' in patch) c.setUserVolume(id, 'screen', patch.screen);
    if ('muted' in patch) c.setUserMuted(id, patch.muted);
  }

  function closeContextMenu() {
    const old = document.querySelector('.ctx-menu');
    if (old) old.remove();
  }

  function openUserMenu(ev, id, tile) {
    closeContextMenu();
    const saved = (vprefs().users[id]) || {};
    const slider = (label, key) => {
      const val = Math.round((saved[key] == null ? 1 : saved[key]) * 100);
      const out = h('span', { class: 'pct' }, val + '%');
      const input = h('input', { type: 'range', min: '0', max: '200', step: '5', value: String(val), 'data-role': 'vol-' + key });
      input.addEventListener('input', () => {
        out.textContent = input.value + '%';
        setUserPref(id, { [key]: Number(input.value) / 100 });
      });
      return h('div', { class: 'ctx-row' }, h('div', { class: 'ctx-label' }, h('span', null, label), out), input);
    };
    const hasStream = voiceMembers(S.voice.channel || '').some((p) => p.id === id && p.screen);
    const mute = h('input', { type: 'checkbox', 'data-role': 'mute-user' });
    mute.checked = !!saved.muted;
    mute.addEventListener('change', () => setUserPref(id, { muted: mute.checked }));
    const items = [
      h('div', { class: 'ctx-title' }, nameOf(id)),
      slider('Volume da voz', 'mic'),
      hasStream || (tile && tile.dataset.kind === 'screen') ? slider('Volume da transmissão', 'screen') : null,
      h('label', { class: 'ctx-check' }, mute, h('span', null, 'Silenciar para mim')),
      h('button', { class: 'ctx-btn', onclick: () => {
        setUserPref(id, { mic: 1, screen: 1, muted: false });
        closeContextMenu();
      } }, 'Redefinir volumes'),
    ];
    if (tile) {
      const v = tile.querySelector('video');
      items.push(h('button', { class: 'ctx-btn', onclick: () => {
        S.voice.focus = S.voice.focus === tile.dataset.key ? null : tile.dataset.key;
        closeContextMenu();
        renderStage();
      } }, S.voice.focus === tile.dataset.key ? 'Remover destaque' : 'Destacar'));
      if (v && !v.hidden) items.push(h('button', { class: 'ctx-btn', onclick: () => {
        closeContextMenu();
        v.requestFullscreen && v.requestFullscreen().catch(() => {});
      } }, 'Tela cheia'));
    }
    const menu = h('div', { class: 'ctx-menu', 'data-user': id }, items);
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(ev.clientX, innerWidth - r.width - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(ev.clientY, innerHeight - r.height - 4)) + 'px';
  }

  document.addEventListener('contextmenu', (ev) => {
    const el = ev.target.closest && ev.target.closest('[data-user]');
    if (!el || !S.session || el.closest('.ctx-menu')) return;
    const id = el.dataset.user;
    if (id === S.session.user.id) return;
    ev.preventDefault();
    openUserMenu(ev, id, el.classList.contains('tile') ? el : null);
  });
  document.addEventListener('mousedown', (ev) => {
    if (!ev.target.closest || !ev.target.closest('.ctx-menu')) closeContextMenu();
  });
  window.addEventListener('blur', closeContextMenu);
  function toggleMute() {
    const c = S.voice.client;
    if (!c) return;
    sfx(c.state().muted ? 'unmute' : 'mute');
    c.setMuted(!c.state().muted);
  }
  function toggleDeafen() {
    const c = S.voice.client;
    if (!c) return;
    sfx(c.state().deafened ? 'undeafen' : 'deafen');
    c.setDeafened(!c.state().deafened);
  }

  // Apertar para falar: segure a tecla para o microfone abrir; ao soltar ele fecha de novo.
  // Funciona com a janela do Concordo em foco (um app não vê teclas de outros programas sem um gancho nativo).
  const pttCfg = () => {
    const p = vprefs().ptt || {};
    return { on: !!p.on, code: p.code || 'KeyV' };
  };
  const keyName = (code) => String(code).replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ').replace('Backquote', '`');
  const ptt = { held: false, timer: null };
  const typingTarget = (t) => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  function pttSilence() {
    clearTimeout(ptt.timer);
    ptt.timer = null;
    ptt.held = false;
    const c = S.voice.client;
    if (c && pttCfg().on && !c.state().muted) c.setMuted(true);
  }
  function pttApply() {
    const c = S.voice.client;
    if (c && pttCfg().on && !ptt.held && !c.state().muted) c.setMuted(true); // PTT ligado: começa mudo
  }
  window.addEventListener('blur', () => {
    if (ptt.held) pttSilence();
  });
  document.addEventListener('keyup', (ev) => {
    const cfg = pttCfg();
    if (!cfg.on || ev.code !== cfg.code || !ptt.held) return;
    clearTimeout(ptt.timer);
    ptt.timer = setTimeout(pttSilence, 250); // pequena folga para não cortar o fim da frase
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeContextMenu();
    const c = S.voice.client;
    if (!c) return;
    const cfg = pttCfg();
    if (cfg.on && ev.code === cfg.code && !ev.ctrlKey && !ev.altKey && !ev.metaKey && !typingTarget(ev.target)) {
      ev.preventDefault();
      if (ev.repeat) return;
      clearTimeout(ptt.timer);
      ptt.timer = null;
      if (!ptt.held) {
        ptt.held = true;
        if (c.state().muted && !c.state().deafened) {
          c.setMuted(false);
        }
      }
      return;
    }
    if (!ev.ctrlKey || !ev.shiftKey) return;
    if (ev.code === 'KeyM') {
      ev.preventDefault();
      toggleMute();
    } else if (ev.code === 'KeyD') {
      ev.preventDefault();
      toggleDeafen();
    }
  });
  if (bridge.on) {
    bridge.on('shortcut', (action) => {
      if (action === 'mute') toggleMute();
      else if (action === 'deafen') toggleDeafen();
    });
  }

  // Campos de qualidade da transmissão (usados no seletor de tela e nas configurações).
  function qualityFields(kind) {
    const prefs = vprefs();
    const isScreen = kind === 'screen';
    const pfx = isScreen ? 'screen' : 'cam';
    const mk = (role, label, options, current) => {
      const sel = h('select', { class: 'input', 'data-role': role },
        ...options.map(([value, text]) => h('option', { value: String(value) }, text)));
      sel.value = String(current);
      sel.addEventListener('change', () => {
        const p = vprefs();
        p[pfx + role.replace(pfx + '-', '').replace(/^./, (c) => c.toUpperCase())] = isNaN(Number(sel.value)) ? sel.value : Number(sel.value);
        saveVprefs(p);
        if (S.voice.client) S.voice.client.applyQuality();
      });
      return h('div', { class: 'field' }, h('label', null, label), sel);
    };
    const resOptions = isScreen
      ? [['720', '720p'], ['1080', '1080p'], ['1440', '1440p'], ['source', 'Original da tela']]
      : [['360', '360p'], ['720', '720p'], ['1080', '1080p']];
    const fpsOptions = isScreen ? [[15, '15 fps (texto e slides)'], [30, '30 fps'], [60, '60 fps (jogos)']] : [[15, '15 fps'], [30, '30 fps']];
    const kbpsOptions = [[0, 'Automática (divide entre os espectadores)'], [500, '0,5 Mbps'], [1000, '1 Mbps'], [2000, '2 Mbps'], [4000, '4 Mbps'], [6000, '6 Mbps'], [8000, '8 Mbps']];
    return [
      mk(pfx + '-res', 'Resolução', resOptions, prefs[pfx + 'Res'] || (isScreen ? '1080' : '720')),
      mk(pfx + '-fps', 'Taxa de quadros', fpsOptions, prefs[pfx + 'Fps'] || 30),
      mk(pfx + '-kbps', 'Taxa de dados máxima por espectador', kbpsOptions, prefs[pfx + 'Kbps'] || 0),
    ];
  }

  // Aparência: Automático (segue o sistema), Claro ou Escuro. Guardado como texto puro para o theme.js ler cedo.
  function currentTheme() {
    try {
      const t = localStorage.getItem('concordo.theme');
      return t === 'light' || t === 'dark' ? t : 'auto';
    } catch {
      return 'auto';
    }
  }

  function applyTheme(mode) {
    try {
      if (mode === 'auto') localStorage.removeItem('concordo.theme');
      else localStorage.setItem('concordo.theme', mode);
    } catch {
      /* sem armazenamento: vale só até fechar */
    }
    if (mode === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', mode);
  }

  // Aparência: cor de destaque, tamanho do texto e densidade. Valem só neste computador.
  const ACCENTS = [[null, 'Padrão'], ['#6d4aff', 'Violeta'], ['#0e9f8e', 'Verde-água'], ['#2f6fdb', 'Azul'], ['#c0457a', 'Rosa'], ['#b7791f', 'Âmbar'], ['#be4b4b', 'Vermelho']];
  const FONT_SIZES = { small: 13, normal: 14, large: 16 };
  function applyLook() {
    const root = document.documentElement;
    const accent = LS.get('concordo.accent', null);
    if (/^#[0-9a-f]{6}$/i.test(accent || '')) {
      root.style.setProperty('--accent', accent);
      root.style.setProperty('--accent-2', accent);
    } else {
      root.style.removeProperty('--accent');
      root.style.removeProperty('--accent-2');
    }
    document.body.style.fontSize = (FONT_SIZES[LS.get('concordo.fontSize', 'normal')] || 14) + 'px';
    const density = LS.get('concordo.density', 'normal');
    if (density === 'normal') root.removeAttribute('data-density');
    else root.setAttribute('data-density', density);
  }
  applyLook();

  function lookChoice() {
    const accent = h('div', { class: 'accent-swatches' });
    const paint = () => {
      accent.replaceChildren(...ACCENTS.map(([c, label]) => {
        const b = h('button', { type: 'button', class: 'swatch' + ((LS.get('concordo.accent', null) || null) === c ? ' on' : ''), title: label, 'aria-label': 'Cor ' + label, 'data-accent': c || 'default', onclick: () => { LS.set('concordo.accent', c); applyLook(); paint(); } });
        b.style.background = c || 'var(--concordo-violet)';
        return b;
      }));
    };
    paint();
    const sel = (key, fallback, opts, role) => {
      const el = h('select', { class: 'input', 'data-role': role }, ...opts.map(([v, t]) => h('option', { value: v }, t)));
      el.value = LS.get(key, fallback);
      el.addEventListener('change', () => { LS.set(key, el.value); applyLook(); });
      return el;
    };
    return [
      h('div', { class: 'field' }, h('label', null, 'Cor de destaque'), accent),
      h('div', { class: 'field' }, h('label', null, 'Tamanho do texto'), sel('concordo.fontSize', 'normal', [['small', 'Pequeno'], ['normal', 'Normal'], ['large', 'Grande']], 'font-size')),
      h('div', { class: 'field' }, h('label', null, 'Densidade das mensagens'), sel('concordo.density', 'normal', [['compact', 'Compacta'], ['normal', 'Normal'], ['comfortable', 'Confortável']], 'density')),
    ];
  }

  function themeChoice() {
    const wrap = h('div', { class: 'theme-choice', role: 'group', 'aria-label': 'Tema' });
    const options = [['auto', 'Automático', null], ['light', 'Claro', 'sun'], ['dark', 'Escuro', 'moon']];
    const paint = () => {
      for (const b of wrap.children) {
        const on = b.dataset.theme === currentTheme();
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    };
    for (const [mode, label, icon] of options) {
      wrap.append(h('button', { class: 'btn with-icon', 'data-theme': mode, onclick: () => { applyTheme(mode); paint(); } },
        icon ? ico(icon, 16) : null, label));
    }
    paint();
    return wrap;
  }

  async function openVoiceSettings() {
    let devices = [];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch {
      /* sem lista: mostra só o padrão */
    }
    const prefs = vprefs();
    const select = (kind, current, fallbackLabel) => {
      const list = devices.filter((d) => d.kind === kind);
      const sel = h('select', { class: 'input', 'data-role': kind },
        h('option', { value: '' }, 'Padrão do sistema'),
        ...list.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) =>
          h('option', { value: d.deviceId }, d.label || `${fallbackLabel} ${i + 1}`)));
      sel.value = list.some((d) => d.deviceId === current) ? current : '';
      return sel;
    };
    const mic = select('audioinput', prefs.mic, 'Microfone');
    const cam = select('videoinput', prefs.cam, 'Câmera');
    const out = select('audiooutput', prefs.out, 'Saída');
    const canOut = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
    const notifySel = h('select', { class: 'input', 'data-role': 'notify-mode' },
      h('option', { value: 'badge' }, 'Só som e contador (sem popup)'),
      h('option', { value: 'mentions' }, 'Popup só quando me citarem (@)'),
      h('option', { value: 'all' }, 'Popup em todas as mensagens'),
      h('option', { value: 'none' }, 'Nenhum aviso'));
    notifySel.value = LS.get('concordo.notify', 'badge');
    notifySel.addEventListener('change', () => {
      LS.set('concordo.notify', notifySel.value);
      updateBadge();
    });
    const soundsBox = h('input', { type: 'checkbox', 'data-role': 'sounds-on' });
    soundsBox.checked = LS.get('concordo.sounds', true) !== false;
    soundsBox.addEventListener('change', () => {
      LS.set('concordo.sounds', soundsBox.checked);
      if (soundsBox.checked) sfx('join');
    });
    const soundVol = h('input', { type: 'range', min: '0', max: '1', step: '0.05', 'data-role': 'sounds-vol' });
    soundVol.value = String(LS.get('concordo.soundVolume', 0.6));
    soundVol.addEventListener('input', () => LS.set('concordo.soundVolume', Number(soundVol.value)));
    soundVol.addEventListener('change', () => sfx('unmute'));
    const copyBox = h('input', { type: 'checkbox', 'data-role': 'keep-copy' });
    copyBox.checked = keepCopy();
    copyBox.addEventListener('change', () => {
      LS.set('concordo.keepCopy', copyBox.checked);
      if (!copyBox.checked && bridge.backupStop) bridge.backupStop().catch(() => {});
      syncBackground();
      if (S.session) syncBackup();
    });
    const meterBox = h('input', { type: 'checkbox', 'data-role': 'meter-on' });
    meterBox.checked = meterOn();
    meterBox.addEventListener('change', () => {
      LS.set('concordo.meter', meterBox.checked);
      renderMeterChip();
    });
    const capSel = h('select', { class: 'input', 'data-role': 'copy-files' },
      h('option', { value: '10mb' }, 'Anexos até 10 MB (recomendado)'),
      h('option', { value: 'all' }, 'Todos os anexos (usa mais disco e internet)'),
      h('option', { value: 'none' }, 'Nenhum anexo (só mensagens)'));
    capSel.value = LS.get('concordo.copyFiles', '10mb');
    capSel.addEventListener('change', () => {
      LS.set('concordo.copyFiles', capSel.value);
      if (S.session) syncBackup();
    });
    const appCheck = (key, label) => {
      const box = h('input', { type: 'checkbox', 'data-role': 'app-' + key, disabled: true });
      if (bridge.getSettings) {
        bridge.getSettings().then((cfg) => {
          box.checked = !!cfg[key];
          box.disabled = false;
        }).catch(() => {});
        box.addEventListener('change', () => bridge.setSettings({ [key]: box.checked }).catch(() => {}));
      }
      return h('label', { class: 'check' }, box, h('span', null, label));
    };
    const check = (key, label, role) => {
      const box = h('input', { type: 'checkbox', 'data-role': role });
      box.checked = prefs[key] !== false;
      box.addEventListener('change', () => change({ [key]: box.checked }, 'mic'));
      return h('label', { class: 'check' }, box, h('span', null, label));
    };
    const change = async (patch, what) => {
      const p = vprefs();
      Object.assign(p, patch);
      saveVprefs(p);
      const c = S.voice.client;
      if (!c) return;
      try {
        if (what === 'mic') await c.restartMic();
        else if (what === 'cam') await c.restartCamera();
        else if (what === 'out') c.setOutputDevice();
      } catch (e) {
        toast(e.message, 'error');
      }
    };
    const pttBox = h('input', { type: 'checkbox', 'data-role': 'ptt-on' });
    pttBox.checked = pttCfg().on;
    const pttKey = h('button', { class: 'btn small', 'data-role': 'ptt-key', type: 'button' }, 'Tecla: ' + keyName(pttCfg().code));
    pttBox.addEventListener('change', () => {
      const p = vprefs();
      p.ptt = { on: pttBox.checked, code: pttCfg().code };
      saveVprefs(p);
      if (pttBox.checked) pttApply();
    });
    pttKey.addEventListener('click', () => {
      pttKey.textContent = 'Aperte a tecla…';
      const onKey = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        document.removeEventListener('keydown', onKey, true);
        if (ev.code !== 'Escape') {
          const p = vprefs();
          p.ptt = { on: pttCfg().on, code: ev.code };
          saveVprefs(p);
        }
        pttKey.textContent = 'Tecla: ' + keyName(pttCfg().code);
      };
      document.addEventListener('keydown', onKey, true);
    });
    mic.addEventListener('change', () => change({ mic: mic.value || null }, 'mic'));
    cam.addEventListener('change', () => change({ cam: cam.value || null }, 'cam'));
    out.addEventListener('change', () => change({ out: out.value || null }, 'out'));
    const close = modal([
      h('h3', null, 'Configurações'),
      h('h4', { class: 'sub' }, 'Aparência'),
      themeChoice(),
      ...lookChoice(),
      h('h4', { class: 'sub' }, 'Aplicativo'),
      appCheck('closeToTray', 'Ao fechar a janela, continuar na bandeja do sistema'),
      h('label', { class: 'check' }, copyBox, h('span', null, 'Guardar uma cópia das salas neste computador (permite assumir a sala se o host sair; usa disco)')),
      h('div', { class: 'field' }, h('label', null, 'Anexos guardados nas cópias'), capSel),
      appCheck('autoStart', 'Abrir o Concordo junto com o Windows (em segundo plano)'),
      h('label', { class: 'check' }, meterBox, h('span', null, 'Mostrar o uso de internet e de disco no canto da barra lateral')),
      h('div', { class: 'field' }, h('label', null, 'Avisar de mensagens novas'), notifySel),
      h('label', { class: 'check' }, soundsBox, h('span', null, 'Sons de chamada (entrar, sair, mutar, câmera, tela)')),
      h('div', { class: 'field' }, h('label', null, 'Volume dos sons'), soundVol),
      h('h4', { class: 'sub' }, 'Áudio'),
      h('div', { class: 'field' }, h('label', null, 'Microfone'), mic),
      canOut ? h('div', { class: 'field' }, h('label', null, 'Saída de som'), out) : null,
      h('div', { class: 'field' }, h('label', null, 'Câmera'), cam),
      check('echo', 'Cancelamento de eco', 'opt-echo'),
      check('noise', 'Supressão de ruído', 'opt-noise'),
      check('agc', 'Ajuste automático de volume do microfone', 'opt-agc'),
      h('label', { class: 'check' }, pttBox, h('span', null, 'Apertar para falar (o microfone só abre enquanto você segura a tecla)')),
      h('div', { class: 'field' }, pttKey),
      h('p', { class: 'hint' }, 'Apertar para falar vale com a janela do Concordo em foco. Para mutar de qualquer lugar, ligue os atalhos globais abaixo.'),
      appCheck('globalShortcuts', 'Atalhos globais: Ctrl+Shift+M muta e Ctrl+Shift+D ensurdece, mesmo em outro programa'),
      h('h4', { class: 'sub' }, 'Câmera: qualidade'),
      ...qualityFields('cam'),
      h('h4', { class: 'sub' }, 'Compartilhamento de tela: qualidade'),
      ...qualityFields('screen'),
      h('p', { class: 'hint' }, 'Mais resolução, quadros e dados pedem mais da sua internet de envio, que é dividida entre todos que assistem. Na dúvida, deixe a taxa em Automática.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', 'data-act': 'diag', onclick: async () => {
          const c = S.voice.client;
          if (!c) return toast('Entre numa chamada para gerar o diagnóstico.', 'error');
          await copyText(await c.diagnostics());
          toast('Diagnóstico copiado. Cole numa conversa com o desenvolvedor.', 'ok');
        } }, 'Copiar diagnóstico da chamada')),
      h('p', { class: 'hint' }, 'Atalhos durante a chamada: Ctrl+Shift+M silencia o microfone e Ctrl+Shift+D ensurdece. Clique com o botão direito no nome de alguém para ajustar o volume dele.'),
      h('div', { class: 'row end', style: { marginTop: '14px' } },
        h('button', { class: 'btn primary', onclick: () => close() }, 'Fechar')),
    ]);
  }

  async function startScreenShare() {
    const v = S.voice;
    if (!bridge.screenSources) {
      await v.client.startScreen({ audio: false });
      return sfx('screenOn');
    }
    let sources = await bridge.screenSources();
    if (!sources.length) throw new Error('Não encontrei nenhuma tela ou janela para compartilhar.');
    const audio = h('input', { type: 'checkbox', 'data-role': 'screen-audio' });
    audio.checked = LS.get('concordo.screenAudio', true) !== false; // ligado por padrão
    const kindOf = (src) => (String(src.id).startsWith('screen:') ? 'screen' : 'window');
    let tab = sources.some((x) => kindOf(x) === 'screen') ? 'screen' : 'window';
    let selected = null;
    let close = null;
    const grid = h('div', { class: 'source-grid' });
    const preview = h('div', { class: 'source-preview', hidden: true });
    const go = h('button', { class: 'btn primary', 'data-act': 'share-go', disabled: true }, 'Compartilhar');
    const tabs = h('div', { class: 'tabs', role: 'tablist' });

    const share = async () => {
      if (!selected) return;
      const src = selected;
      close();
      await voiceAction(async () => {
        LS.set('concordo.screenAudio', audio.checked);
        const withAudio = audio.checked;
        await v.client.startScreen({ audio: withAudio, prepare: () => bridge.screenPrepare({ id: src.id, audio: withAudio }) });
        sfx('screenOn');
        if (withAudio && v.client && v.client.state().screenNoAudio) {
          toast('O Windows não entregou o som do computador. A tela foi compartilhada sem áudio. Em Configurações → "Copiar diagnóstico da chamada" dá para ver o motivo.', 'error');
        }
      });
    };
    go.addEventListener('click', share);

    const renderTabs = () => tabs.replaceChildren(...['screen', 'window'].map((k) => {
      const n = sources.filter((x) => kindOf(x) === k).length;
      return h('button', {
        class: 'tab' + (k === tab ? ' active' : ''), role: 'tab', 'aria-selected': k === tab ? 'true' : 'false', 'data-tab': k,
        onclick: () => {
          tab = k;
          renderTabs();
          renderGrid();
        },
      }, (k === 'screen' ? 'Telas inteiras' : 'Janelas') + ` (${n})`);
    }));

    const renderPreview = () => {
      preview.hidden = !selected;
      go.disabled = !selected;
      if (!selected) return preview.replaceChildren();
      preview.replaceChildren(
        h('img', { src: selected.thumbnail, alt: '' }),
        h('div', { class: 'source-preview-name' }, selected.icon ? h('img', { class: 'app-icon', src: selected.icon, alt: '' }) : null, selected.name));
    };

    const renderGrid = () => {
      const list = sources.filter((x) => kindOf(x) === tab);
      grid.replaceChildren(...(list.length ? list.map((src) =>
        h('button', {
          class: 'source' + (selected && selected.id === src.id ? ' selected' : ''), 'data-source': src.id, type: 'button',
          onclick: () => {
            selected = src;
            renderGrid();
            renderPreview();
          },
          ondblclick: share,
        }, h('img', { src: src.thumbnail, alt: '' }),
        h('span', null, src.icon ? h('img', { class: 'app-icon', src: src.icon, alt: '' }) : null, h('b', null, src.name))))
        : [h('div', { class: 'hint' }, 'Nada por aqui agora.')]));
    };

    close = modal([
      h('h3', null, 'Compartilhar tela'),
      tabs,
      grid,
      preview,
      h('div', { class: 'row quality-row' }, ...qualityFields('screen').slice(0, 2)),
      h('label', { class: 'check' }, audio, h('span', null, 'Compartilhar também o som do computador')),
      h('div', { class: 'hint' }, 'No Windows o som é do computador inteiro (não dá para separar por janela). O Concordo tenta não reenviar a voz dos seus amigos; use fones de ouvido para evitar eco.'),
      h('div', { class: 'row end', style: { marginTop: '14px' } },
        h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancelar'),
        go),
    ]);
    renderTabs();
    renderGrid();

    // as miniaturas se atualizam enquanto a janela está aberta (janelas novas aparecem, a prévia acompanha)
    const timer = setInterval(async () => {
      if (!document.body.contains(grid)) return clearInterval(timer);
      try {
        const fresh = await bridge.screenSources();
        const ids = (list) => list.map((x) => x.id).join('|');
        const changedList = ids(fresh) !== ids(sources);
        sources = fresh;
        if (selected) selected = fresh.find((x) => x.id === selected.id) || null;
        if (changedList) {
          renderTabs();
          renderGrid();
        } else {
          for (const src of fresh) {
            const img = grid.querySelector(`.source[data-source="${CSS.escape(src.id)}"] img`);
            if (img) img.src = src.thumbnail;
          }
        }
        renderPreview();
      } catch {
        /* tenta de novo no próximo ciclo */
      }
    }, 3000);
  }

  // ============================================================
  // convites e canais (dono da sala)
  // ============================================================
  function openInviteModal({ sessionCode = false } = {}) {
    if (S.tunnel.state !== 'ready') return toast('O túnel ainda não está pronto.', 'error');
    const uses = h('select', { class: 'input' },
      h('option', { value: '1' }, 'Uma pessoa (recomendado)'),
      h('option', { value: '5' }, 'Até 5 pessoas'),
      h('option', { value: '0' }, 'Sem limite de pessoas'));
    const box = h('textarea', { class: 'input code-box', readonly: true, placeholder: 'O código aparece aqui' });
    const note = h('div', { class: 'hint' }, 'Cada convite vale por 24 horas. Quem entra fica salvo e reconecta sozinho depois.');
    const gen = h('button', { class: 'btn primary' }, 'Gerar convite');
    const session = h('button', { class: 'btn small' }, 'Código para quem já entrou');
    const copy = h('button', { class: 'btn', onclick: () => box.value && copyText(box.value, box) }, 'Copiar');

    gen.addEventListener('click', async () => {
      gen.disabled = true;
      try {
        const r = await api('POST', '/api/invites', { maxUses: parseInt(uses.value, 10), hours: 24 });
        box.value = r.code;
        note.textContent = 'Mande este código para o seu amigo. Ele cola em "Entrar" no Concordo.';
      } catch (e) {
        toast(e.message, 'error');
      }
      gen.disabled = false;
    });
    session.addEventListener('click', async () => {
      try {
        const r = await api('GET', '/api/session-code');
        box.value = r.code;
        note.textContent = 'Este código não cria conta nova: serve para quem já entrou antes reconectar (o endereço muda toda vez que você reinicia a sala).';
      } catch (e) {
        toast(e.message, 'error');
      }
    });

    if (sessionCode) {
      note.textContent = 'Você assumiu a sala! Mande este código para o pessoal colar em "Entrar": quem já estava na sala reconecta sem convite novo.';
      setTimeout(() => session.click(), 0);
    }
    const close = modal([
      h('h3', null, sessionCode ? 'Sala assumida' : 'Convidar amigos'),
      h('div', { class: 'field' }, h('label', null, 'Quantas pessoas podem usar'), uses),
      h('div', { class: 'row' }, gen, session),
      h('div', { class: 'field', style: { marginTop: '14px' } }, h('label', null, 'Código'), box),
      note,
      h('div', { class: 'row between', style: { marginTop: '14px' } },
        copy,
        h('button', { class: 'btn ghost', onclick: () => close() }, 'Fechar')),
    ]);
  }

  function openChannelModal() {
    const name = h('input', { class: 'input', maxlength: '24', placeholder: 'ex: jogos' });
    const type = h('select', { class: 'input' },
      h('option', { value: 'text' }, 'Texto'),
      h('option', { value: 'voice' }, 'Voz e vídeo'));
    const err = h('div', { class: 'hint' });
    const create = async () => {
      try {
        await api('POST', '/api/channels', { name: name.value, type: type.value });
        close();
      } catch (e) {
        err.className = 'hint error';
        err.textContent = e.message;
      }
    };
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') create();
    });
    const close = modal([
      h('h3', null, 'Novo canal'),
      h('div', { class: 'field' }, h('label', null, 'Tipo'), type),
      h('div', { class: 'field' }, h('label', null, 'Nome'), name),
      err,
      h('div', { class: 'row end', style: { marginTop: '14px' } },
        h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancelar'),
        h('button', { class: 'btn primary', onclick: create }, 'Criar')),
    ]);
    name.focus();
  }

  // ============================================================
  // sair / encerrar
  // ============================================================
  function teardownChat() {
    S.leaving = true;
    if (S.voice.client) leaveVoice({ silent: true, local: true });
    closeSocket();
    S.session = null;
    S.isHost = false;
    S.ui = {};
    S.msgs = new Map();
    S.unread = new Map();
    S.away = 0;
    updateBadge();
  }

  async function leave() {
    showWelcome();
  }

  async function endRoom() {
    const heir = S.heir && S.users.get(S.heir);
    const heirOnline = !!(heir && S.online.has(heir.id) && heir.id !== S.session.user.id);
    let close = null;
    const stop = async () => {
      close();
      S.leaving = true;
      const rid = S.session.room.id;
      S.hosted = null;
      try {
        await bridge.hostStop(rid);
      } catch (e) {
        toast(e.message, 'error');
      }
      await refreshHosted();
      showWelcome();
    };
    close = modal([
      h('h3', null, 'Sair da sala'),
      heirOnline
        ? h('p', { class: 'hint' }, `${heir.name} é o sucessor e está online. Ele pode assumir a sala agora: ninguém precisa de código novo e a chamada continua.`)
        : h('p', { class: 'hint' }, 'Nenhum sucessor está online. Se você encerrar, a sala fica fora do ar até alguém hospedar de novo.'),
      h('div', { class: 'col', style: { gap: '8px', marginTop: '12px' } },
        heirOnline ? h('button', { class: 'btn primary', 'data-act': 'handoff', onclick: () => handoffRoom(close) }, `Passar a sala para ${heir.name} e continuar como membro`) : null,
        h('button', { class: 'btn danger', 'data-act': 'end-room', onclick: stop }, 'Encerrar a sala para todos'),
        h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancelar')),
    ]);
  }

  async function handoffRoom(closeModal) {
    closeModal();
    const s0 = S.session;
    let rv = null;
    try {
      rv = (await api('GET', '/api/me')).rv;
    } catch {
      /* sem resposta */
    }
    if (!rv) return toast('Não consegui preparar a passagem (sem ponto de encontro). Tente de novo em instantes.', 'error');
    const oldUrl = S.publicUrl || s0.url;
    const { user, room, token } = s0;
    if (S.voice.client) S.voiceRejoin = { channel: S.voice.channel, at: Date.now() };
    teardownChat();
    S.leaving = true;
    S.hosted = null;
    const hostedId = room.id;
    mount(h('div', { class: 'center' }, h('div', { class: 'panel' },
      mascot('acenando', 96),
      h('h2', null, 'Passando a sala…'),
      h('p', { class: 'hint' }, 'O sucessor está assumindo. Você volta para a sala como membro em instantes.'))));
    try {
      await bridge.hostStop(hostedId); // avisa todos, espera o sucessor copiar a versão final e encerra
      await refreshHosted();
    } catch (e) {
      toast(e.message, 'error');
    }
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      await new Promise((r) => setTimeout(r, 2500));
      const found = await followAddress(rv, token, oldUrl).catch(() => null);
      if (found && found.me) {
        toast('A sala agora está com o sucessor. Você continua nela como membro.', 'ok');
        return enterGuest({ url: found.url, token, user: found.me.user, room: found.me.room, rv: found.me.rv || rv });
      }
    }
    saveRoom({ url: oldUrl, token, user, room, rv });
    showWelcome();
    toast('O sucessor ainda não assumiu. Sua sala ficou salva: tente entrar de novo daqui a pouco.', 'error');
  }

  // ============================================================
  // atualizações e links
  // ============================================================
  function renderBanner() {
    const u = S.update;
    $banner.replaceChildren();
    if (!u) return;
    if (u.state === 'downloading') {
      $banner.append(h('div', { class: 'banner' }, `Baixando a versão ${u.version}…`));
    } else if (u.state === 'downloaded') {
      $banner.append(
        h('div', { class: 'banner' },
          `A versão ${u.version} está pronta.`,
          h('button', {
            class: 'btn small',
            onclick: () => {
              if (S.isHost && !confirm('Atualizar agora encerra a sala e desconecta todo mundo. Continuar?')) return;
              bridge.installUpdate();
            },
          }, 'Reiniciar e atualizar')),
      );
    }
  }

  function handleDeepLink(link) {
    if (S.session) {
      toast('Saia da sala atual para entrar em outra pelo link.', 'error');
      return;
    }
    showJoin(link);
  }

  // ============================================================
  // início
  // ============================================================
  async function boot() {
    if (!bridge) {
      $app.append(h('div', { class: 'center' }, h('p', { class: 'tagline' }, 'Abra o Concordo pelo aplicativo instalado.')));
      return;
    }
    bridge.on('host:status', (ev) => {
      if (!S.session || !S.isHost || (ev.roomId && ev.roomId !== S.session.room.id)) return; // outra sala que eu hospedo
      S.tunnel = { state: ev.state, message: ev.message };
      S.publicUrl = ev.publicUrl;
      renderTunnel();
      if (ev.state === 'ready' && S.isHost && S.afterTakeover) {
        S.afterTakeover = false;
        openInviteModal({ sessionCode: true });
      }
      if (ev.state === 'error' && S.isHost) toast('O túnel caiu. Seus amigos não conseguem entrar até ele voltar.', 'error');
    });
    bridge.on('update:status', (ev) => {
      S.update = ev;
      renderBanner();
    });
    bridge.on('deeplink', handleDeepLink);
    startMeter();
    window.addEventListener('focus', () => {
      S.away = 0;
      updateBadge();
    });
    // Outro computador já hospeda esta sala com uma geração mais nova: este deixa de ser host e entra como membro.
    bridge.on('host:superseded', async (ev) => {
      const s0 = S.session;
      if (!ev || !ev.url) return;
      refreshHosted();
      if (!S.isHost || !s0 || (ev.roomId && ev.roomId !== s0.room.id)) return;
      const { token } = s0;
      S.hosted = null;
      teardownChat();
      S.leaving = true;
      try {
        const me = await request(ev.url, token, 'GET', '/api/me');
        toast(`${ev.host || 'Outro membro'} já está hospedando esta sala. Você entrou nela como membro.`, 'ok');
        enterGuest({ url: ev.url, token, user: me.user, room: me.room, rv: me.rv });
      } catch {
        showWelcome();
        toast('Outro computador assumiu a sala. Entre por "Suas salas".', 'error');
      }
    });
    bridge.on('backup:status', (ev) => {
      if (S.session && ev && ev.roomId === S.session.room.id) S.backup = ev;
      renderHeirNote();
    });

    const hosted = await refreshHosted();
    const running = hosted.find((r) => r.running && r.info);
    if (running) return enterHost(running.info);
    const link = await bridge.takeDeepLink();
    showWelcome();
    if (link) showJoin(link);
  }

  boot();
})();
