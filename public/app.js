// 大廳 + 房間 shell：負責 WebSocket 連線、大廳列表、切換房間畫面。
// 個別遊戲的規則/UI 都在 games/<gameType>/index.js 裡，透過下面的 contract 掛進來：
//   export function mount({ container, role, you, send, sendRaw, notifyTurn }) -> { onMessage(msg), destroy() }

import { showToast } from '/ui.js';
import { initStealth } from '/stealth.js';
import { initLobby } from '/lobby.js';
import { initChat } from '/chat.js';

const GAME_MODULES = {
  'texas-holdem': () => import('/games/texas-holdem/index.js'),
};

const ROLE_LABELS = { host: '🎩 房主', player: '🎮 玩家', spectator: '👀 旁觀' };
const RECONNECT_DELAY_MS = 1500;

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
  themeToggle: document.getElementById('theme-toggle'),
  chatTitle: document.getElementById('chat-title'),
  chatLog: document.getElementById('chat-log'),
  chatInput: document.getElementById('chat-input'),
  chatSendBtn: document.getElementById('chat-send-btn'),
  chatResizer: document.getElementById('chat-resizer'),
};

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  els.themeToggle.textContent = theme === 'light' ? '🌙' : '☀️';
  localStorage.setItem('og_theme', theme);
}
applyTheme(localStorage.getItem('og_theme')
  || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
els.themeToggle.addEventListener('click', () => {
  applyTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
});

const { notifyTurn, resetStealth } = initStealth(els);
const lobby = initLobby(els, sendMsg);
const chat = initChat(els, sendMsg);

let ws = null;
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
    setTimeout(connect, RECONNECT_DELAY_MS);
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

function setRole(role) {
  if (currentGame) currentGame.role = role;
  els.roomRoleLabel.textContent = ROLE_LABELS[role] || role;
  els.spectatorBanner.hidden = role !== 'spectator';
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      localStorage.setItem('og_clientId', msg.clientId);
      chat.requestHistory();
      break;
    case 'room_list':
      lobby.renderRoomList(msg.catalog, msg.rooms);
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
      setRole('host');
      break;
    case 'role_changed':
      setRole(msg.role);
      routeToGame(msg);
      break;
    case 'roster':
      updateRoomHeader(msg.room);
      routeToGame(msg);
      break;
    case 'error':
      showToast(msg.message, { error: true });
      break;
    case 'state_update':
      routeToGame(msg);
      break;
    case 'chat':
      chat.append(msg);
      break;
    case 'chat_history':
      chat.setHistory(msg.messages);
      break;
    default:
      break;
  }
}

// ---------- 房間畫面 ----------

// 加入房間到遊戲模組載入完成中間有一小段 await 的空檔，這段時間伺服器仍可能送來
// state_update 等訊息 —— 先排隊，模組準備好後再依序補放。
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
  updateRoomHeader(msg.room);
  setRole(msg.role);
  resetStealth();
  chat.setScope(msg.room.name);
  chat.requestHistory();

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
    send: (type, payload) => sendMsg({ type, payload }),
    sendRaw: sendMsg,
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
  chat.setScope(null);
  chat.requestHistory();
  sendMsg({ type: 'list_rooms' });
}

els.leaveBtn.addEventListener('click', () => {
  sendMsg({ type: 'leave_room' });
  showLobby();
});

connect();
