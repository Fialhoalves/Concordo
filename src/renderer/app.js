/* Interface do Concordo. JavaScript puro, sem build.
   Todo texto vindo da rede entra na página via textContent/createTextNode (nunca innerHTML). */
(() => {
  'use strict';

  const bridge = window.concordo;
  const Invite = window.ConcordoInvite;
  const $app = document.getElementById('app');
  const $banner = document.getElementById('banner');
  const $toasts = document.getElementById('toasts');

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
    let n = 0;
    for (const ch of String(id)) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
    return `hsl(${n % 360} 55% 45%)`;
  }

  function avatar(id, name, { big = false, presence = false } = {}) {
    const initial = Array.from((name || '?').trim())[0] || '?';
    const el = h('div', { class: 'avatar' + (big ? ' big' : '') }, initial.toUpperCase());
    el.style.background = colorFor(id);
    if (presence) el.append(h('span', { class: 'presence' + (S.online.has(id) ? ' on' : '') }));
    return el;
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
    unread: new Map(),
    ws: null,
    retry: 0,
    timer: null,
    leaving: false,
    hasConnected: false,
    ui: {},
    update: null,
  };

  // ============================================================
  // rede
  // ============================================================
  async function request(base, token, method, route, body) {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(base + route, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
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
      savedAt: Date.now(),
    };
    LS.set('concordo.rooms', rooms);
  }

  function forgetRoom(roomId) {
    const rooms = getRooms();
    delete rooms[roomId];
    LS.set('concordo.rooms', rooms);
  }

  // ============================================================
  // telas iniciais
  // ============================================================
  const mount = (...nodes) => $app.replaceChildren(...nodes);

  function showWelcome() {
    teardownChat();
    const rooms = Object.values(getRooms()).sort((a, b) => b.savedAt - a.savedAt);

    const savedList = rooms.length
      ? h('div', { class: 'saved' },
          h('h4', null, 'Suas salas'),
          rooms.map((r) => {
            const enter = h('button', { class: 'btn small primary' }, 'Entrar');
            enter.addEventListener('click', () => reconnect(r, enter));
            return h('div', { class: 'saved-item' },
              h('div', null,
                h('div', { class: 'name' }, r.roomName || 'Sala'),
                h('div', { class: 'hint' }, `como ${r.name}`)),
              h('div', { class: 'row' },
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
                }, '✕')));
          }),
        )
      : null;

    const version = h('div', { class: 'version' });
    bridge.appInfo().then((i) => (version.textContent = `Concordo v${i.version}`));

    mount(
      h('div', { class: 'center' },
        h('div', { class: 'logo' }, 'C'),
        h('div', { class: 'title' }, 'Concordo'),
        h('p', { class: 'tagline' }, 'Bate-papo entre amigos que roda no seu PC. Sem cadastro e sem servidor de terceiros.'),
        h('div', { class: 'cards' },
          h('button', { class: 'card', onclick: showHostSetup },
            h('h3', null, 'Hospedar'),
            h('p', null, 'Crie uma sala. Seu computador vira o servidor e você convida a galera.')),
          h('button', { class: 'card', onclick: () => showJoin() },
            h('h3', null, 'Entrar'),
            h('p', null, 'Tem um código de convite? Cole aqui e entre na sala de um amigo.'))),
        savedList,
        version),
    );
  }

  async function reconnect(room, button) {
    button.disabled = true;
    try {
      const me = await request(room.url, room.token, 'GET', '/api/me');
      enterGuest({ url: room.url, token: room.token, user: me.user, room: me.room });
    } catch (e) {
      if (e.status === 401) {
        forgetRoom(room.roomId);
        toast('Você não faz mais parte dessa sala.', 'error');
        showWelcome();
      } else {
        toast('A sala está offline ou mudou de endereço. Peça ao host um novo código de sessão e cole em "Entrar".', 'error');
        button.disabled = false;
      }
    }
  }

  function showHostSetup() {
    const nick = h('input', { class: 'input', maxlength: '24', placeholder: 'Como os amigos vão te ver', value: LS.get('concordo.nick', '') });
    const room = h('input', { class: 'input', maxlength: '40', value: LS.get('concordo.roomName', 'Concordo') });
    const msg = h('div', { class: 'hint' }, 'Seu computador vira o servidor. Deixe o Concordo aberto enquanto a galera estiver conversando.');
    const go = h('button', { class: 'btn primary' }, 'Iniciar sala');

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
        return enterGuest({ url: d.url, token: saved.token, user: me.user, room: me.room });
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
    enterGuest({ url: d.url, token: res.token, user: res.user, room: res.room });
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
    S.tunnel = { state: info.tunnelState, message: info.tunnelMessage };
    S.publicUrl = info.publicUrl;
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
    ui.inviteBtn = h('button', { class: 'btn small', onclick: openInviteModal }, 'Convidar');

    ui.textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    ui.textarea.addEventListener('input', autosize);
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
    const meBar = h('div', { class: 'me-bar' },
      h('div', { class: 'who' }, avatar(me.id, me.name), h('span', null, me.name)),
      S.isHost
        ? h('div', { class: 'row' },
            ui.inviteBtn,
            h('button', { class: 'btn small danger', onclick: endRoom }, 'Encerrar'))
        : h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => leave() }, 'Sair da sala')));

    const addChannelBtn = h('button', { class: 'btn ghost', title: 'Novo canal', onclick: openChannelModal }, '+');

    ui.main = h('div', { class: 'main' },
      h('div', { class: 'main-head' }, ui.chName, ui.conn),
      ui.messages,
      h('div', { class: 'composer-wrap' },
        ui.uploadStatus,
        h('div', { class: 'composer' },
          h('button', { class: 'btn ghost', title: 'Enviar arquivo', onclick: () => fileInput.click() }, '📎'),
          fileInput,
          ui.textarea,
          h('button', { class: 'btn primary', onclick: sendMessage }, 'Enviar'))),
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

    mount(
      h('div', { class: 'chat' },
        h('aside', { class: 'sidebar' },
          h('div', { class: 'room-head' }, ui.roomName, S.isHost ? ui.tunnel : null),
          h('div', { class: 'side-scroll' },
            h('div', { class: 'section' }, h('span', null, 'Canais'), S.session.user.role === 'owner' ? addChannelBtn : null),
            ui.channelList,
            h('div', { class: 'section' }, h('span', null, 'Membros')),
            ui.memberList),
          meBar),
        ui.main),
    );
    renderTunnel();
    setConn(S.ws && S.ws.readyState === 1 ? 'online' : 'connecting');
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
            await bridge.hostRetryTunnel();
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
      reconnecting: ['warn', S.retry >= 5 ? 'Sem resposta. O host pode ter reiniciado; peça um novo código de sessão.' : 'Reconectando…'],
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
    S.session.user = st.you;
    S.session.room = st.room;
    S.ui.roomName.textContent = st.room.name;
    renderChannels();
    renderMembers();
  }

  function renderChannels() {
    if (!S.ui.channelList) return;
    S.ui.channelList.replaceChildren(
      ...S.channels.map((ch) => {
        const unread = S.unread.get(ch.id) || 0;
        return h('div', {
          class: 'channel' + (ch.id === S.current ? ' active' : ''),
          onclick: () => selectChannel(ch.id),
        }, h('span', { class: 'hash' }, '#'), h('span', null, ch.name), unread ? h('span', { class: 'badge' }, unread > 99 ? '99+' : unread) : null);
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
        h('div', { class: 'member' + (S.online.has(u.id) ? '' : ' offline') },
          avatar(u.id, u.name, { presence: true }),
          h('span', { class: 'name' }, u.name),
          u.role === 'owner' ? h('span', { class: 'crown', title: 'Dono da sala' }, '👑') : null,
          me.role === 'owner' && u.id !== me.id
            ? h('button', {
                class: 'btn small ghost kick',
                title: 'Remover da sala',
                onclick: () => removeMember(u),
              }, '✕')
            : null),
      ),
    );
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
    renderChannels();
    const ch = S.channels.find((c) => c.id === id);
    S.ui.chName.textContent = '# ' + (ch ? ch.name : id);
    S.ui.messages.replaceChildren();
    if (S.msgs.has(id)) renderMessages();
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
    if (!entry.list.length) nodes.push(h('div', { class: 'empty' }, 'Nada por aqui ainda. Mande a primeira mensagem!'));
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
    const grouped = sameDay && prev.userId === m.userId && m.ts - prev.ts < 5 * 60 * 1000;
    const user = S.users.get(m.userId);
    const name = user ? user.name : m.author;

    const author = h('span', { class: 'author' }, name);
    author.style.color = colorFor(m.userId);

    out.push(
      h('div', { class: 'msg' + (grouped ? '' : ' head') },
        grouped ? h('div', { class: 'gutter' }, hhmm(m.ts)) : avatar(m.userId, name, { big: true }),
        h('div', { class: 'body' },
          grouped ? null : h('div', { class: 'meta' }, author, h('span', { class: 'time' }, hhmm(m.ts))),
          m.text ? h('div', { class: 'text' }, linkify(m.text)) : null,
          (m.attachments || []).map(attachmentEl))),
    );
    return out;
  }

  function attachmentEl(a) {
    const url = fileUrl(a.id);
    if (/^image\/(png|jpeg|gif|webp)$/.test(a.type)) {
      const img = h('img', { class: 'att-img', src: url, alt: a.name, loading: 'lazy' });
      img.addEventListener('click', () => openLightbox(url));
      return h('div', { class: 'att' }, img);
    }
    return h('div', { class: 'att file' },
      h('div', { class: 'att-icon' }, '📄'),
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

  function onIncoming(m) {
    const entry = S.msgs.get(m.channel);
    const isNew = !!entry && !entry.list.some((x) => x.id === m.id);
    if (isNew) entry.list.push(m);
    const mine = m.userId === S.session.user.id;
    if (m.channel === S.current) {
      if (isNew) appendMessage(m);
    } else if (!mine) {
      S.unread.set(m.channel, (S.unread.get(m.channel) || 0) + 1);
      renderChannels();
    }
    if (!mine && !document.hasFocus()) notify(m);
  }

  function notify(m) {
    try {
      const user = S.users.get(m.userId);
      const body = m.text || (m.attachments && m.attachments[0] ? '📎 ' + m.attachments[0].name : '');
      const n = new Notification(`${user ? user.name : m.author} · #${m.channel}`, { body });
      n.onclick = () => window.focus();
    } catch {
      /* notificações indisponíveis */
    }
  }

  // ============================================================
  // envio de mensagens e arquivos
  // ============================================================
  function sendMessage() {
    const text = S.ui.textarea.value.trim();
    if (!text) return;
    if (text.length > S.limits.maxMessageLength) return toast('Mensagem longa demais.', 'error');
    if (!S.ws || S.ws.readyState !== 1) return toast('Sem conexão com a sala. Aguarde a reconexão.', 'error');
    S.ws.send(JSON.stringify({ t: 'msg', channel: S.current, text }));
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
    S.ws = ws;
    setConn('connecting');

    ws.onopen = () => {
      S.retry = 0;
      setConn('online');
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
      if (S.leaving) return;
      if (ev.code === 4001) {
        toast('Você foi removido(a) desta sala.', 'error');
        forgetRoom(S.session.room.id);
        return leave();
      }
      setConn('reconnecting');
      scheduleReconnect();
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

  function scheduleReconnect() {
    clearTimeout(S.timer);
    const delay = Math.min(15000, 1000 * 2 ** Math.min(S.retry, 4));
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
        setConn('reconnecting');
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
      case 'msg':
        return onIncoming(d.message);
      case 'presence':
        S.online = new Set(d.online);
        return renderMembers();
      case 'user':
        S.users.set(d.user.id, d.user);
        return renderMembers();
      case 'user_removed':
        S.users.delete(d.id);
        return renderMembers();
      case 'channel':
        if (!S.channels.some((c) => c.id === d.channel.id)) S.channels.push(d.channel);
        return renderChannels();
      case 'error':
        return toast(d.message, 'error');
      default:
    }
  }

  // ============================================================
  // convites e canais (dono da sala)
  // ============================================================
  function openInviteModal() {
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

    const close = modal([
      h('h3', null, 'Convidar amigos'),
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
    const err = h('div', { class: 'hint' });
    const create = async () => {
      try {
        await api('POST', '/api/channels', { name: name.value });
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
    closeSocket();
    S.session = null;
    S.isHost = false;
    S.ui = {};
    S.msgs = new Map();
    S.unread = new Map();
  }

  async function leave() {
    showWelcome();
  }

  async function endRoom() {
    if (!confirm('Encerrar a sala? O servidor para e todo mundo é desconectado. Os dados ficam guardados no seu computador.')) return;
    S.leaving = true;
    try {
      await bridge.hostStop();
    } catch (e) {
      toast(e.message, 'error');
    }
    showWelcome();
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
      S.tunnel = { state: ev.state, message: ev.message };
      S.publicUrl = ev.publicUrl;
      renderTunnel();
      if (ev.state === 'error' && S.isHost) toast('O túnel caiu. Seus amigos não conseguem entrar até ele voltar.', 'error');
    });
    bridge.on('update:status', (ev) => {
      S.update = ev;
      renderBanner();
    });
    bridge.on('deeplink', handleDeepLink);

    const running = await bridge.hostInfo();
    if (running) return enterHost(running);
    const link = await bridge.takeDeepLink();
    showWelcome();
    if (link) showJoin(link);
  }

  boot();
})();
