import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import {
  createGame, addPlayer, removePlayer, readyToStart,
  startHand, applyAction, viewFor, rebuy,
  STARTING_CHIPS, BIG_BLIND, SMALL_BLIND,
} from './public/games/texas-holdem/engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3131;
const PUBLIC_DIR = path.join(__dirname, 'public');
const ACTION_TIMEOUT_MS = 30_000;
const NEXT_HAND_DELAY_MS = 5_000;
const RECONNECT_GRACE_MS = 60_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
};

const GAME_CATALOG = [
  { gameType: 'texas-holdem', name: '德州撲克', minPlayers: 2, maxPlayersLimit: 10, defaultMaxPlayers: 6 },
];

// --- Static file server ---
const server = http.createServer((req, res) => {
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, reqPath);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// --- WebSocket ---
const wss = new WebSocketServer({ server });
const clients = new Map();
const rooms = new Map();
let nextClientId = 1;
let nextRoomId = 1;

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function sendToClient(clientId, msg) {
  const c = clients.get(clientId);
  if (c) send(c.ws, msg);
}

function roomSummary(room) {
  return {
    id: room.id, name: room.name, gameType: room.gameType,
    players: room.players.size, maxPlayers: room.maxPlayers,
    spectators: room.spectators.size, hostNickname: room.hostNickname,
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
  return [...new Set([room.hostId, ...room.players.keys(), ...room.spectators.keys()])];
}

function broadcastRoomRoster(room) {
  const roster = {
    type: 'roster',
    room: roomSummary(room),
    players: [...room.players.entries()].map(([id, p]) => ({ id, nickname: p.nickname })),
    spectators: [...room.spectators.entries()].map(([id, s]) => ({ id, nickname: s.nickname })),
  };
  for (const id of roomMemberIds(room)) sendToClient(id, roster);
}

function broadcastGameState(room) {
  if (!room.gameState) return;
  for (const [id] of room.players) sendToClient(id, { type: 'state_update', payload: viewFor(room.gameState, id) });
  const sv = viewFor(room.gameState, '__spectator__');
  for (const [id] of room.spectators) sendToClient(id, { type: 'state_update', payload: sv });
}

// --- Timers ---
function scheduleActionTimer(room) {
  clearActionTimer(room);
  const gs = room.gameState;
  if (!gs || ['waiting', 'showdown', 'hand_over'].includes(gs.stage)) return;
  gs.turnDeadline = Date.now() + ACTION_TIMEOUT_MS;
  room.actionTimer = setTimeout(() => {
    room.actionTimer = null;
    const player = gs.players[gs.toActIdx];
    if (!player || player.folded || player.allIn) return;
    applyAction(gs, player.id, 'fold');
    checkTimers(room);
    broadcastGameState(room);
  }, ACTION_TIMEOUT_MS);
}
function clearActionTimer(room) {
  if (room.actionTimer) { clearTimeout(room.actionTimer); room.actionTimer = null; }
  if (room.gameState) room.gameState.turnDeadline = null;
}
function scheduleNextHandTimer(room) {
  if (room.nextHandTimer) return;
  room.nextHandTimer = setTimeout(() => {
    room.nextHandTimer = null;
    if (!room.gameState || !readyToStart(room.gameState)) return;
    const res = startHand(room.gameState);
    if (!res.ok) return;
    scheduleActionTimer(room);
    broadcastGameState(room);
    broadcastLobby();
  }, NEXT_HAND_DELAY_MS);
}
function checkTimers(room) {
  const gs = room.gameState;
  if (!gs) return;
  if (['hand_over', 'showdown'].includes(gs.stage)) {
    clearActionTimer(room);
    if (readyToStart(gs)) scheduleNextHandTimer(room);
  } else {
    scheduleActionTimer(room);
  }
}

// --- Room lifecycle ---
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

function closeRoom(room, reason) {
  clearActionTimer(room);
  if (room.nextHandTimer) { clearTimeout(room.nextHandTimer); room.nextHandTimer = null; }
  rooms.delete(room.id);
  for (const id of roomMemberIds(room)) {
    const c = clients.get(id);
    if (c) { c.roomId = null; c.role = null; send(c.ws, { type: 'room_closed', reason }); }
  }
  broadcastLobby();
}

function leaveCurrentRoom(client, opts = {}) {
  const room = rooms.get(client.roomId);
  client.roomId = null;
  const wasRole = client.role;
  client.role = null;
  if (!room) return;

  if (wasRole === 'player' || wasRole === 'host') {
    room.players.delete(client.id);
    if (room.gameState) { removePlayer(room.gameState, client.id); clearActionTimer(room); }
  } else if (wasRole === 'spectator') {
    room.spectators.delete(client.id);
  }

  if (wasRole === 'host') {
    const newHostId = [...room.players.keys()][0];
    if (newHostId) {
      const nh = clients.get(newHostId);
      room.hostId = newHostId;
      room.hostNickname = nh.nickname;
      nh.role = 'host';
      sendToClient(newHostId, { type: 'promoted_to_host' });
    } else {
      closeRoom(room, opts.disconnect ? '房主已離線，沒有其他玩家可接手，房間關閉' : '房主已離開，沒有其他玩家可接手，房間關閉');
      return;
    }
  }

  if (room.started && room.players.size <= 1) {
    closeRoom(room, '其他玩家皆已離開，房間關閉');
    return;
  }

  broadcastRoomRoster(room);
  if (room.gameState && room.started) { checkTimers(room); broadcastGameState(room); }
  broadcastLobby();
}

// --- S3 Reconnection ---
function handleDisconnect(client) {
  if (!client.connected) return;
  client.connected = false;
  const room = rooms.get(client.roomId);
  if (room && (client.role === 'player' || client.role === 'host')) {
    const ep = room.gameState?.players.find(p => p.id === client.id);
    room.disconnectedPlayers.set(client.id, { nickname: client.nickname, chips: ep?.chips ?? 0 });
  }
  leaveCurrentRoom(client, { disconnect: true });
  client.graceTimer = setTimeout(() => {
    clients.delete(client.id);
    for (const r of rooms.values()) r.disconnectedPlayers.delete(client.id);
  }, RECONNECT_GRACE_MS);
}

function handleReconnectRoom(client) {
  for (const [roomId, room] of rooms) {
    const saved = room.disconnectedPlayers.get(client.id);
    if (!saved) continue;
    room.disconnectedPlayers.delete(client.id);
    if (room.players.size >= room.maxPlayers) break;
    const nickname = uniqueDisplayName(room, saved.nickname, client.id);
    room.players.set(client.id, { nickname });
    client.roomId = roomId; client.role = 'player'; client.nickname = nickname;
    if (room.gameState) addPlayer(room.gameState, client.id, nickname, saved.chips);
    send(client.ws, { type: 'room_joined', roomId, role: 'player', you: { id: client.id, nickname }, room: roomSummary(room) });
    broadcastRoomRoster(room);
    if (room.gameState && room.started) broadcastGameState(room);
    broadcastLobby();
    return;
  }
  broadcastLobby();
}

// --- WebSocket connection handler ---
wss.on('connection', (ws) => {
  const tempId = 'c' + nextClientId++;
  let client = { id: tempId, ws, nickname: '訪客' + tempId.slice(1), roomId: null, role: null, connected: true, graceTimer: null };
  clients.set(tempId, client);
  send(ws, { type: 'welcome', clientId: tempId });
  broadcastLobby();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'reconnect' && msg.clientId) {
      const old = clients.get(msg.clientId);
      if (old && !old.connected) {
        if (old.graceTimer) clearTimeout(old.graceTimer);
        old.ws = ws; old.connected = true; old.graceTimer = null;
        clients.delete(tempId);
        client = old;
        send(ws, { type: 'welcome', clientId: old.id, reconnected: true });
        handleReconnectRoom(old);
        return;
      }
    }
    handleMessage(client, msg);
  });
  ws.on('close', () => handleDisconnect(client));
});

// --- Message handler ---
function handleMessage(client, msg) {
  switch (msg.type) {
    case 'set_nickname': {
      const raw = String(msg.nickname || client.nickname).slice(0, 20);
      const room = rooms.get(client.roomId);
      const nickname = room ? uniqueDisplayName(room, raw, client.id) : raw;
      client.nickname = nickname;
      if (room) {
        if (client.role === 'host') room.hostNickname = nickname;
        if (room.players.has(client.id)) room.players.get(client.id).nickname = nickname;
        if (room.spectators.has(client.id)) room.spectators.get(client.id).nickname = nickname;
        const ep = room.gameState?.players.find(p => p.id === client.id);
        if (ep) ep.nickname = nickname;
        broadcastRoomRoster(room);
        if (room.gameState) broadcastGameState(room);
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
      const game = GAME_CATALOG.find(g => g.gameType === msg.gameType);
      if (!game) return send(client.ws, { type: 'error', message: '不支援的遊戲類型' });
      const maxPlayers = Math.min(Math.max(Number(msg.maxPlayers) || game.defaultMaxPlayers, game.minPlayers), game.maxPlayersLimit);
      const bigBlind = Math.max(Number(msg.bigBlind) || BIG_BLIND, 2);
      const smallBlind = Math.floor(bigBlind / 2);
      const chips = Math.max(Number(msg.startingChips) || STARTING_CHIPS, bigBlind * 2);
      const allowRebuy = !!msg.allowRebuy;
      const roomId = 'r' + nextRoomId++;
      const room = {
        id: roomId, gameType: game.gameType,
        name: String(msg.name || `${client.nickname} 的房間`).slice(0, 30),
        maxPlayers, hostId: client.id, hostNickname: client.nickname,
        players: new Map([[client.id, { nickname: client.nickname }]]),
        spectators: new Map(), started: false,
        gameState: createGame({ smallBlind, bigBlind, startingChips: chips }),
        settings: { bigBlind, smallBlind, startingChips: chips, allowRebuy },
        disconnectedPlayers: new Map(), actionTimer: null, nextHandTimer: null,
      };
      addPlayer(room.gameState, client.id, client.nickname, chips);
      rooms.set(roomId, room);
      client.roomId = roomId; client.role = 'host';
      send(client.ws, { type: 'room_joined', roomId, role: 'host', you: { id: client.id, nickname: client.nickname }, room: roomSummary(room) });
      broadcastRoomRoster(room);
      broadcastGameState(room);
      broadcastLobby();
      break;
    }
    case 'join_room': {
      if (client.roomId) return send(client.ws, { type: 'error', message: '你已經在房間裡了' });
      const room = rooms.get(msg.roomId);
      if (!room) return send(client.ws, { type: 'error', message: '房間不存在或已關閉' });
      let role = msg.as === 'spectator' ? 'spectator' : 'player';
      if (role === 'player' && room.players.size >= room.maxPlayers) role = 'spectator';
      if (role === 'player' && room.started) role = 'spectator';
      const nickname = uniqueDisplayName(room, client.nickname, client.id);
      if (role === 'player') {
        room.players.set(client.id, { nickname });
        if (room.gameState) addPlayer(room.gameState, client.id, nickname, room.settings.startingChips);
      } else {
        room.spectators.set(client.id, { nickname });
      }
      client.roomId = room.id; client.role = role;
      send(client.ws, { type: 'room_joined', roomId: room.id, role, you: { id: client.id, nickname }, room: roomSummary(room) });
      broadcastRoomRoster(room);
      if (room.gameState) broadcastGameState(room);
      broadcastLobby();
      break;
    }
    case 'leave_room': {
      leaveCurrentRoom(client);
      break;
    }
    case 'start_game': {
      const room = rooms.get(client.roomId);
      if (!room || client.role !== 'host') return;
      if (room.nextHandTimer) { clearTimeout(room.nextHandTimer); room.nextHandTimer = null; }
      const res = startHand(room.gameState);
      if (!res.ok) return send(client.ws, { type: 'error', message: res.error });
      room.started = true;
      scheduleActionTimer(room);
      broadcastGameState(room);
      broadcastLobby();
      break;
    }
    case 'game_action': {
      const room = rooms.get(client.roomId);
      if (!room?.gameState) return;
      if (client.role !== 'player' && client.role !== 'host') return;
      const res = applyAction(room.gameState, client.id, msg.payload.action, msg.payload.amount);
      if (!res.ok) return send(client.ws, { type: 'error', message: res.error });
      clearActionTimer(room);
      checkTimers(room);
      broadcastGameState(room);
      break;
    }
    case 'seat_request': {
      const room = rooms.get(client.roomId);
      if (!room || client.role !== 'spectator') return;
      const stage = room.gameState?.stage ?? 'waiting';
      if (!['waiting', 'hand_over', 'showdown'].includes(stage))
        return send(client.ws, { type: 'error', message: '牌局進行中，無法入座' });
      if (room.players.size >= room.maxPlayers)
        return send(client.ws, { type: 'error', message: '座位已滿' });
      room.spectators.delete(client.id);
      const nickname = uniqueDisplayName(room, client.nickname, client.id);
      room.players.set(client.id, { nickname });
      client.role = 'player';
      if (room.gameState) addPlayer(room.gameState, client.id, nickname, room.settings.startingChips);
      send(client.ws, { type: 'role_changed', role: 'player' });
      broadcastRoomRoster(room); broadcastGameState(room); broadcastLobby();
      break;
    }
    case 'rebuy': {
      const room = rooms.get(client.roomId);
      if (!room?.gameState || !room.settings.allowRebuy)
        return send(client.ws, { type: 'error', message: 'Rebuy 未啟用' });
      if (client.role !== 'player' && client.role !== 'host') return;
      const amount = Number(msg.amount) || Math.floor(room.settings.startingChips / 2);
      const res = rebuy(room.gameState, client.id, amount);
      if (!res.ok) return send(client.ws, { type: 'error', message: res.error });
      broadcastGameState(room);
      break;
    }
    case 'sit_out': {
      const room = rooms.get(client.roomId);
      if (!room?.gameState || (client.role !== 'player' && client.role !== 'host')) return;
      const player = room.gameState.players.find(p => p.id === client.id);
      if (!player || player.sittingOut) return;
      const midHand = !['waiting', 'showdown', 'hand_over'].includes(room.gameState.stage);
      if (midHand && !player.folded && !player.allIn) {
        applyAction(room.gameState, client.id, 'fold');
        clearActionTimer(room);
      }
      player.sittingOut = true;
      if (midHand) checkTimers(room);
      broadcastGameState(room);
      break;
    }
    case 'sit_back': {
      const room = rooms.get(client.roomId);
      if (!room?.gameState || (client.role !== 'player' && client.role !== 'host')) return;
      const player = room.gameState.players.find(p => p.id === client.id);
      if (!player || !player.sittingOut) return;
      player.sittingOut = false;
      broadcastGameState(room);
      break;
    }
    case 'leave_seat': {
      const room = rooms.get(client.roomId);
      if (!room || client.role !== 'player') return;
      if (room.gameState) { removePlayer(room.gameState, client.id); clearActionTimer(room); }
      room.players.delete(client.id);
      room.spectators.set(client.id, { nickname: client.nickname });
      client.role = 'spectator';
      send(client.ws, { type: 'role_changed', role: 'spectator' });
      broadcastRoomRoster(room);
      if (room.gameState && room.started) { checkTimers(room); broadcastGameState(room); }
      broadcastLobby();
      break;
    }
    default: break;
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
