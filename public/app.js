// 大廳 + 房間 shell：負責 WebSocket 連線、大廳列表、切換房間畫面。
// 個別遊戲的規則/UI 都在 games/<gameType>/index.js 裡，透過下面的 contract 掛進來：
//   export function mount({ container, role, you, roomId, room, send, onLeave }) -> { onMessage(msg), destroy() }

const GAME_MODULES = {
  'texas-holdem': () => import('/games/texas-holdem/index.js'),
};

const els = {
  connDot: document.getElementById('conn-dot'),
  nicknameInput: document.getElementById('nickname-input'),
  lobbyView: document.getElementById('lobby-view'),
  roomGrid: document.getElementById('room-grid'),
  emptyHint: document.getElementById('empty-hint'),
  createBtn: document.getElementById('create-room-btn'),
  roomView: document.getElementById('room-view'),
  roomNameLabel: document.getElementById('room-name-label'),
  roomRoleLabel: document.getElementById('room-role-label'),
  roomCountLabel: document.getElementById('room-count-label'),
  leaveBtn: document.getElementById('leave-room-btn'),
  spectatorBanner: document.getElementById('spectator-banner'),
  gameMount: document.getElementById('game-mount'),
  stealthDecoy: document.getElementById('stealth-decoy'),
  roomReal: document.getElementById('room-real'),
  decoyBadge: document.getElementById('decoy-badge'),
  createModal: document.getElementById('create-modal'),
  createGametype: document.getElementById('create-gametype'),
  createRoomname: document.getElementById('create-roomname'),
  createMaxplayers: document.getElementById('create-maxplayers'),
  createBigblind: document.getElementById('create-bigblind'),
  createStartchips: document.getElementById('create-startchips'),
  createRebuy: document.getElementById('create-rebuy'),
  createCancelBtn: document.getElementById('create-cancel-btn'),
  createConfirmBtn: document.getElementById('create-confirm-btn'),
};

const GAME_LABELS = { 'texas-holdem': '德州撲克' };

let ws = null;
let clientId = null;
let catalog = [];
let currentGame = null; // { role, roomId, gameType, instance }
let pendingGameMessages = null; // 加入房間後、遊戲模組還沒載入完成前，先把訊息排隊

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}`;
}

function connect() {
  ws = new WebSocket(wsUrl());
  ws.addEventListener('open', () => {
    els.connDot.classList.add('on');
    const savedId = localStorage.getItem('og_clientId');
    if (savedId) sendMsg({ type: 'reconnect', clientId: savedId });
    const savedNick = localStorage.getItem('og_nickname');
    if (savedNick) sendMsg({ type: 'set_nickname', nickname: savedNick });
  });
  ws.addEventListener('close', () => {
    els.connDot.classList.remove('on');
    setTimeout(connect, 1500);
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleServerMessage(msg);
  });
}

function sendMsg(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

const toastContainer = document.getElementById('toast-container');
function showToast(message, { error = false } = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' error' : '');
  el.textContent = message;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      clientId = msg.clientId;
      localStorage.setItem('og_clientId', clientId);
      break;
    case 'room_list':
      catalog = msg.catalog;
      renderCatalogSelect();
      renderRoomGrid(msg.rooms);
      break;
    case 'room_joined':
      enterRoomView(msg);
      break;
    case 'room_closed':
      showToast(msg.reason || '房間已關閉', { error: true });
      showLobby();
      break;
    case 'promoted_to_host':
      showToast('你已被指派為新房主');
      if (currentGame) currentGame.role = 'host';
      els.roomRoleLabel.textContent = '🎩 房主';
      break;
    case 'role_changed':
      if (currentGame) currentGame.role = msg.role;
      els.roomRoleLabel.textContent = { host: '🎩 房主', player: '🎮 玩家', spectator: '👀 旁觀' }[msg.role] || msg.role;
      els.spectatorBanner.hidden = msg.role !== 'spectator';
      routeToGame(msg);
      break;
    case 'roster':
      updateRoomHeader(msg.room);
      routeToGame(msg);
      break;
    case 'error':
      showToast(msg.message, { error: true });
      break;
    case 'game_action':
    case 'state_update':
    case 'peer_joined':
    case 'peer_left':
      routeToGame(msg);
      break;
    default:
      break;
  }
}

// ---------- 大廳畫面 ----------

function renderCatalogSelect() {
  if (els.createGametype.dataset.filled) return;
  els.createGametype.innerHTML = catalog
    .map((g) => `<option value="${g.gameType}">${GAME_LABELS[g.gameType] || g.gameType}</option>`)
    .join('');
  els.createGametype.dataset.filled = '1';
}

function renderRoomGrid(rooms) {
  els.roomGrid.innerHTML = '';
  els.emptyHint.hidden = rooms.length > 0;
  for (const r of rooms) {
    const card = document.createElement('div');
    card.className = 'room-card';
    const full = r.players >= r.maxPlayers;
    card.innerHTML = `
      <div class="room-title">${escapeHtml(r.name)}</div>
      <div class="room-meta">
        <span class="badge">${GAME_LABELS[r.gameType] || r.gameType}</span>
        <span class="badge ${full ? 'full' : ''}">👤 ${r.players}/${r.maxPlayers} 人</span>
        <span class="badge">👀 ${r.spectators} 旁觀</span>
        ${r.started ? '<span class="badge">🎲 進行中</span>' : ''}
      </div>
      <div class="actions">
        <button data-join="${r.id}" ${full || r.started ? 'disabled' : ''}>加入遊戲</button>
        <button class="secondary" data-spectate="${r.id}">旁觀</button>
      </div>
    `;
    els.roomGrid.appendChild(card);
  }
}

els.roomGrid.addEventListener('click', (ev) => {
  const joinId = ev.target.getAttribute('data-join');
  const spectateId = ev.target.getAttribute('data-spectate');
  if (joinId) sendMsg({ type: 'join_room', roomId: joinId, as: 'player' });
  if (spectateId) sendMsg({ type: 'join_room', roomId: spectateId, as: 'spectator' });
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 開房 modal ----------

els.createBtn.addEventListener('click', () => { els.createModal.hidden = false; });
for (const input of [els.createMaxplayers, els.createBigblind, els.createStartchips]) {
  input.addEventListener('keydown', (ev) => {
    if (['e', 'E', '.', '+', '-'].includes(ev.key)) ev.preventDefault();
  });
  input.addEventListener('change', () => {
    const v = parseInt(input.value, 10);
    if (isNaN(v)) { input.value = input.defaultValue; return; }
    const min = Number(input.min), max = Number(input.max);
    input.value = Math.max(min, Math.min(max, v));
  });
}
els.createMaxplayers.addEventListener('input', () => {
  const v = parseInt(els.createMaxplayers.value, 10);
  if (!isNaN(v) && v > 10) els.createMaxplayers.value = 10;
});
els.createCancelBtn.addEventListener('click', () => { els.createModal.hidden = true; });
els.createConfirmBtn.addEventListener('click', () => {
  sendMsg({
    type: 'create_room',
    gameType: els.createGametype.value,
    name: els.createRoomname.value,
    maxPlayers: Number(els.createMaxplayers.value) || 6,
    bigBlind: Number(els.createBigblind.value) || 50,
    startingChips: Number(els.createStartchips.value) || 2000,
    allowRebuy: els.createRebuy.checked,
  });
  els.createModal.hidden = true;
  els.createRoomname.value = '';
});

// ---------- 暱稱 ----------

els.nicknameInput.value = localStorage.getItem('og_nickname') || '';
els.nicknameInput.addEventListener('change', () => {
  const nick = els.nicknameInput.value.trim() || '訪客';
  localStorage.setItem('og_nickname', nick);
  sendMsg({ type: 'set_nickname', nickname: nick });
});

// 首次訪客強制註冊暱稱
const nicknameModal = document.getElementById('nickname-modal');
const nicknameModalInput = document.getElementById('nickname-modal-input');
const nicknameModalConfirm = document.getElementById('nickname-modal-confirm');

if (!localStorage.getItem('og_nickname')) {
  nicknameModal.hidden = false;
} else {
  nicknameModal.hidden = true;
}

nicknameModalInput.addEventListener('input', () => {
  nicknameModalConfirm.disabled = !nicknameModalInput.value.trim();
});
function confirmNicknameModal() {
  const nick = nicknameModalInput.value.trim();
  if (!nick) return;
  localStorage.setItem('og_nickname', nick);
  els.nicknameInput.value = nick;
  sendMsg({ type: 'set_nickname', nickname: nick });
  nicknameModal.hidden = true;
}
nicknameModalConfirm.addEventListener('click', confirmNicknameModal);
nicknameModalInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') confirmNicknameModal(); });

// ---------- 偷玩模式：F9 手動切換假文件 ----------

function showDecoy() {
  els.stealthDecoy.hidden = false;
  els.roomReal.hidden = true;
}

function showGame() {
  els.stealthDecoy.hidden = true;
  els.roomReal.hidden = false;
}

function toggleStealth() {
  if (els.roomView.hidden) return;
  if (els.stealthDecoy.hidden) showDecoy();
  else showGame();
}

els.stealthDecoy.addEventListener('click', showGame);

document.addEventListener('keydown', (ev) => {
  if (ev.key !== 'F9') return;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  ev.preventDefault();
  toggleStealth();
});

// 用 canvas 畫一個「文件」favicon；輪到你時疊一個小紅點，看起來像未讀通知
const faviconLink = (() => {
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  return link;
})();

function drawFavicon(withDot) {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.font = '52px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('📄', 32, 34);
  if (withDot) {
    ctx.beginPath();
    ctx.arc(50, 14, 10, 0, Math.PI * 2);
    ctx.fillStyle = '#e2574c';
    ctx.fill();
  }
  return canvas.toDataURL('image/png');
}

function setFavicon(withDot) {
  faviconLink.href = drawFavicon(withDot);
}

function notifyTurn(isYourTurn) {
  setFavicon(isYourTurn);
  els.decoyBadge.hidden = !isYourTurn;
  if (isYourTurn) els.decoyBadge.textContent = '3 則留言';
}

function resetStealth() {
  showGame();
  setFavicon(false);
  els.decoyBadge.hidden = true;
}

setFavicon(false);

// ---------- 房間畫面 ----------

// 加入房間到遊戲模組載入完成中間有一小段 await 的空檔，這段時間伺服器仍可能送來
// state_update / peer_joined 等訊息 —— 先排隊，模組準備好後再依序補放。
function routeToGame(msg) {
  if (currentGame?.instance) {
    currentGame.instance.onMessage?.(msg);
  } else if (pendingGameMessages) {
    pendingGameMessages.push(msg);
  }
}

async function enterRoomView(msg) {
  els.lobbyView.hidden = true;
  els.roomView.hidden = false;
  els.spectatorBanner.hidden = msg.role !== 'spectator';
  updateRoomHeader(msg.room);
  els.roomRoleLabel.textContent = { host: '🎩 房主', player: '🎮 玩家', spectator: '👀 旁觀' }[msg.role];
  resetStealth();

  els.gameMount.innerHTML = '';
  pendingGameMessages = [];
  const loader = GAME_MODULES[msg.room.gameType];
  if (!loader) {
    els.gameMount.textContent = '找不到這個遊戲的前端模組';
    return;
  }
  const mod = await loader();
  const instance = mod.mount({
    container: els.gameMount,
    role: msg.role,
    you: msg.you,
    roomId: msg.roomId,
    room: msg.room,
    send: (type, payload) => sendMsg({ type, payload }),
    sendRaw: sendMsg,
    onLeave: showLobby,
    notify: showToast,
    notifyTurn,
  });
  currentGame = { role: msg.role, roomId: msg.roomId, gameType: msg.room.gameType, instance };
  const queued = pendingGameMessages;
  pendingGameMessages = null;
  for (const queuedMsg of queued) instance.onMessage?.(queuedMsg);
}


function updateRoomHeader(room) {
  els.roomNameLabel.textContent = room.name;
  els.roomCountLabel.textContent = `${room.players}/${room.maxPlayers} 人・${room.spectators} 旁觀`;
}

function showLobby() {
  currentGame?.instance?.destroy?.();
  currentGame = null;
  pendingGameMessages = null;
  els.gameMount.innerHTML = '';
  els.roomView.hidden = true;
  els.lobbyView.hidden = false;
  resetStealth();
  sendMsg({ type: 'list_rooms' });
}

els.leaveBtn.addEventListener('click', () => {
  sendMsg({ type: 'leave_room' });
  showLobby();
});

connect();
