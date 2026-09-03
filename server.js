'use strict';
/**
 * 辦公室小遊戲 - 大廳 + 房間中繼伺服器
 *
 * 這支伺服器只負責：
 *   1. 提供 public/ 底下的靜態檔案（大廳頁面、遊戲前端）
 *   2. 用 WebSocket 幫房間內的瀏覽器互相轉發訊息
 *
 * 遊戲規則本身完全不在伺服器上跑 —— 誰開房間、誰的瀏覽器分頁就是那個房間的
 * 「主機」，負責算牌局狀態，伺服器只是把訊息從 A 轉給 B。伺服器重開，所有
 * 房間狀態就消失（不需要資料庫，開玩即用）。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3131;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const GAME_CATALOG = [
  { gameType: 'texas-holdem', name: '德州撲克', minPlayers: 2, maxPlayersLimit: 8, defaultMaxPlayers: 6 },
];

// ---------- 靜態檔案伺服器 ----------

const server = http.createServer((req, res) => {
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, reqPath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- WebSocket 中繼 ----------

const wss = new WebSocket.Server({ server });

/** @type {Map<string, Client>} */
const clients = new Map();
/** @type {Map<string, Room>} */
const rooms = new Map();

let nextClientId = 1;
let nextRoomId = 1;

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function sendToClient(clientId, msg) {
  const c = clients.get(clientId);
  if (c) send(c.ws, msg);
}

function roomSummary(room) {
  return {
    id: room.id,
    name: room.name,
    gameType: room.gameType,
    players: room.players.size,
    maxPlayers: room.maxPlayers,
    spectators: room.spectators.size,
    hostNickname: room.hostNickname,
    started: room.started,
  };
}

function broadcastLobby() {
  const roomList = [...rooms.values()].map(roomSummary);
  for (const c of clients.values()) {
    if (!c.roomId) send(c.ws, { type: 'room_list', catalog: GAME_CATALOG, rooms: roomList });
  }
}

function roomMemberIds(room) {
  return [room.hostId, ...room.players.keys(), ...room.spectators.keys()];
}

function broadcastRoomRoster(room) {
  const roster = {
    type: 'roster',
    room: roomSummary(room),
    players: [...room.players.entries()].map(([id, p]) => ({ id, nickname: p.nickname, seat: p.seat })),
    spectators: [...room.spectators.entries()].map(([id, s]) => ({ id, nickname: s.nickname })),
  };
  for (const id of roomMemberIds(room)) sendToClient(id, roster);
}

function closeRoom(room, reason) {
  rooms.delete(room.id);
  for (const id of roomMemberIds(room)) {
    const c = clients.get(id);
    if (c) {
      c.roomId = null;
      c.role = null;
      send(c.ws, { type: 'room_closed', reason });
    }
  }
  broadcastLobby();
}

// 房主主動離開時，優先把房主身分交給下一位還在座的玩家（依加入順序），
// 房間不因此關閉；真的沒人可以接手才會走 closeRoom。
function tryHostHandoff(room, leavingClient, handoffState) {
  const candidateId = [...room.players.keys()].find((id) => id !== leavingClient.id);
  if (!candidateId) return false;
  const candidate = clients.get(candidateId);
  if (!candidate) return false;

  room.hostId = candidateId;
  room.hostNickname = candidate.nickname;
  room.players.delete(leavingClient.id);
  candidate.role = 'host';

  leavingClient.roomId = null;
  leavingClient.role = null;

  send(candidate.ws, {
    type: 'host_handoff',
    state: handoffState,
    you: { id: candidate.id, nickname: candidate.nickname },
  });

  broadcastRoomRoster(room);
  return true;
}

// 房間裡如果已經有人用同一個暱稱（常見於同一台電腦開多分頁測試、或忘記改名），
// 自動補上 (2)(3)... 讓每個座位看起來是不同的人。
function uniqueDisplayName(room, desired, excludeClientId) {
  const taken = new Set();
  if (room.hostId !== excludeClientId) taken.add(room.hostNickname);
  for (const [id, p] of room.players) if (id !== excludeClientId) taken.add(p.nickname);
  for (const [id, s] of room.spectators) if (id !== excludeClientId) taken.add(s.nickname);
  if (!taken.has(desired)) return desired;
  let n = 2;
  while (taken.has(`${desired} (${n})`)) n++;
  return `${desired} (${n})`;
}

function leaveCurrentRoom(client, opts = {}) {
  const room = rooms.get(client.roomId);
  client.roomId = null;
  const wasRole = client.role;
  client.role = null;
  if (!room) return;

  if (wasRole === 'host') {
    closeRoom(room, opts.reason || '主機已離開，房間關閉');
    return;
  }
  if (wasRole === 'player') {
    room.players.delete(client.id);
  } else if (wasRole === 'spectator') {
    room.spectators.delete(client.id);
  }
  sendToClient(room.hostId, { type: 'peer_left', clientId: client.id, nickname: client.nickname, role: wasRole });
  broadcastRoomRoster(room);
  broadcastLobby();
}

wss.on('connection', (ws) => {
  const id = 'c' + nextClientId++;
  const client = { id, ws, nickname: '訪客' + id.slice(1), roomId: null, role: null };
  clients.set(id, client);
  send(ws, { type: 'welcome', clientId: id });
  broadcastLobby();

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    handleMessage(client, msg);
  });

  ws.on('close', () => {
    leaveCurrentRoom(client, { reason: '主機已離開，房間關閉' });
    clients.delete(id);
    broadcastLobby();
  });
});

function handleMessage(client, msg) {
  switch (msg.type) {
    case 'set_nickname': {
      client.nickname = String(msg.nickname || client.nickname).slice(0, 20);
      const room = rooms.get(client.roomId);
      if (room) {
        if (client.role === 'host') room.hostNickname = client.nickname;
        if (room.players.has(client.id)) room.players.get(client.id).nickname = client.nickname;
        if (room.spectators.has(client.id)) room.spectators.get(client.id).nickname = client.nickname;
        broadcastRoomRoster(room);
        broadcastLobby();
      }
      break;
    }

    case 'list_rooms': {
      send(client.ws, { type: 'room_list', catalog: GAME_CATALOG, rooms: [...rooms.values()].map(roomSummary) });
      break;
    }

    case 'create_room': {
      if (client.roomId) return send(client.ws, { type: 'error', message: '你已經在房間裡了' });
      const game = GAME_CATALOG.find((g) => g.gameType === msg.gameType);
      if (!game) return send(client.ws, { type: 'error', message: '不支援的遊戲類型' });

      const maxPlayers = Math.min(
        Math.max(Number(msg.maxPlayers) || game.defaultMaxPlayers, game.minPlayers),
        game.maxPlayersLimit
      );

      const roomId = 'r' + nextRoomId++;
      const room = {
        id: roomId,
        gameType: game.gameType,
        name: String(msg.name || `${client.nickname} 的房間`).slice(0, 30),
        maxPlayers,
        hostId: client.id,
        hostNickname: client.nickname,
        players: new Map([[client.id, { nickname: client.nickname, seat: 0 }]]),
        spectators: new Map(),
        started: false,
      };
      rooms.set(roomId, room);
      client.roomId = roomId;
      client.role = 'host';

      send(client.ws, { type: 'room_joined', roomId, role: 'host', you: { id: client.id, nickname: client.nickname }, room: roomSummary(room) });
      broadcastRoomRoster(room);
      broadcastLobby();
      break;
    }

    case 'join_room': {
      if (client.roomId) return send(client.ws, { type: 'error', message: '你已經在房間裡了' });
      const room = rooms.get(msg.roomId);
      if (!room) return send(client.ws, { type: 'error', message: '房間不存在或已關閉' });

      let role = msg.as === 'spectator' ? 'spectator' : 'player';
      if (role === 'player' && room.players.size >= room.maxPlayers) role = 'spectator';
      if (role === 'player' && room.started) role = 'spectator'; // 遊戲進行中，中途只能旁觀

      // 同一台電腦開多個分頁測試、或暱稱剛好撞名時，自動加上 (2)(3)... 區分，
      // 不然牌桌上會看起來像「大家都是同一個人」。
      const nickname = uniqueDisplayName(room, client.nickname, client.id);
      if (role === 'player') {
        room.players.set(client.id, { nickname, seat: room.players.size });
      } else {
        room.spectators.set(client.id, { nickname });
      }
      client.roomId = room.id;
      client.role = role;

      send(client.ws, { type: 'room_joined', roomId: room.id, role, you: { id: client.id, nickname }, room: roomSummary(room) });
      sendToClient(room.hostId, { type: 'peer_joined', clientId: client.id, nickname, role });
      broadcastRoomRoster(room);
      broadcastLobby();
      break;
    }

    case 'leave_room': {
      const room = rooms.get(client.roomId);
      if (room && client.role === 'host' && msg.handoff && tryHostHandoff(room, client, msg.handoff)) {
        broadcastLobby();
        break;
      }
      leaveCurrentRoom(client);
      broadcastLobby();
      break;
    }

    case 'start_game': {
      const room = rooms.get(client.roomId);
      if (room && client.role === 'host') {
        room.started = true;
        broadcastLobby();
      }
      break;
    }

    // 一般玩家 -> 主機：遊戲操作 (下注/蓋牌/...)
    case 'game_action': {
      const room = rooms.get(client.roomId);
      if (!room) return;
      sendToClient(room.hostId, {
        type: 'game_action',
        senderId: client.id,
        senderNickname: client.nickname,
        payload: msg.payload,
      });
      break;
    }

    // 主機 -> 所有人：廣播牌局狀態（可依收件人分別隱藏手牌）
    case 'state_update': {
      const room = rooms.get(client.roomId);
      if (!room || client.role !== 'host') return;

      const targeted = msg.targeted || {};
      const sentTo = new Set();
      for (const [targetId, payload] of Object.entries(targeted)) {
        sendToClient(targetId, { type: 'state_update', payload });
        sentTo.add(targetId);
      }
      if (msg.defaultView !== undefined) {
        for (const memberId of roomMemberIds(room)) {
          if (!sentTo.has(memberId)) {
            sendToClient(memberId, { type: 'state_update', payload: msg.defaultView });
          }
        }
      }
      break;
    }

    default:
      break;
  }
}

server.listen(PORT, () => {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  console.log('========================================');
  console.log(' 辦公室小遊戲 已啟動');
  console.log(` 本機開啟: http://localhost:${PORT}`);
  for (const a of addrs) console.log(` 同 WiFi 的人開啟: http://${a}:${PORT}`);
  console.log('========================================');
});
