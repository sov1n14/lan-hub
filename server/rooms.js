import { WebSocket } from 'ws';
import {
  createGame, addPlayer, removePlayer, readyToStart,
  startHand, applyAction, viewFor, rebuy,
} from './holdem/engine.js';

const ACTION_TIMEOUT_MS = 60_000;
const NEXT_HAND_DELAY_MS = 10_000;
const RECONNECT_GRACE_MS = 60_000;

export const GAME_CATALOG = [
  { gameType: 'texas-holdem', name: '德州撲克', minPlayers: 2, maxPlayersLimit: 10, defaultMaxPlayers: 6 },
];

export const clients = new Map();
export const rooms = new Map();
let nextClientId = 1;
let nextRoomId = 1;
export function bumpClientId() { return nextClientId++; }
export function bumpRoomId() { return nextRoomId++; }

export function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
export function sendToClient(clientId, msg) {
  const c = clients.get(clientId);
  if (c) send(c.ws, msg);
}

export function roomSummary(room) {
  return {
    id: room.id, name: room.name, gameType: room.gameType,
    players: room.players.size, maxPlayers: room.maxPlayers,
    spectators: room.spectators.size, hostNickname: room.hostNickname,
    started: room.started,
  };
}

export function broadcastLobby() {
  const roomList = [...rooms.values()].map(roomSummary);
  for (const c of clients.values()) {
    if (!c.roomId) send(c.ws, { type: 'room_list', catalog: GAME_CATALOG, rooms: roomList });
  }
}

export function roomMemberIds(room) {
  return [...new Set([room.hostId, ...room.players.keys(), ...room.spectators.keys()])];
}

export function broadcastRoomRoster(room) {
  const roster = {
    type: 'roster',
    room: roomSummary(room),
    players: [...room.players.entries()].map(([id, p]) => ({ id, nickname: p.nickname })),
    spectators: [...room.spectators.entries()].map(([id, s]) => ({ id, nickname: s.nickname })),
  };
  for (const id of roomMemberIds(room)) sendToClient(id, roster);
}

// --- Chat ---
const CHAT_HISTORY_MAX = 100;
const lobbyChat = [];

export function displayName(room, client) {
  return room?.players.get(client.id)?.nickname ?? room?.spectators.get(client.id)?.nickname ?? client.nickname;
}
export function chatHistory(room) { return room ? room.chat : lobbyChat; }
export function pushChat(room, entry) {
  const log = chatHistory(room);
  log.push(entry);
  if (log.length > CHAT_HISTORY_MAX) log.shift();
  if (room) for (const id of roomMemberIds(room)) sendToClient(id, entry);
  else for (const c of clients.values()) if (!c.roomId) send(c.ws, entry);
}
export function systemChat(room, text) {
  pushChat(room, { type: 'chat', system: true, text, ts: Date.now() });
}

export function broadcastGameState(room) {
  if (!room.gameState) return;
  for (const [id] of room.players) sendToClient(id, { type: 'state_update', payload: viewFor(room.gameState, id) });
  const sv = viewFor(room.gameState, '__spectator__');
  for (const [id] of room.spectators) sendToClient(id, { type: 'state_update', payload: sv });
}

// --- Timers ---
export function scheduleActionTimer(room) {
  const gs = room.gameState;
  if (!gs || ['waiting', 'showdown', 'hand_over'].includes(gs.stage)) return clearActionTimer(room);
  const player = gs.players[gs.toActIdx];
  if (room.actionTimer && room.actionTimerPlayerId === player?.id) return;
  clearActionTimer(room);
  gs.turnDeadline = Date.now() + ACTION_TIMEOUT_MS;
  room.actionTimerPlayerId = player?.id ?? null;
  room.actionTimer = setTimeout(() => {
    room.actionTimer = null;
    const toCall = gs.currentBet - player.betThisRound;
    applyAction(gs, player.id, toCall > 0 ? 'fold' : 'check');
    checkTimers(room);
    broadcastGameState(room);
  }, ACTION_TIMEOUT_MS);
}
export function clearActionTimer(room) {
  if (room.actionTimer) { clearTimeout(room.actionTimer); room.actionTimer = null; }
  room.actionTimerPlayerId = null;
  if (room.gameState) room.gameState.turnDeadline = null;
}
export function scheduleNextHandTimer(room) {
  if (room.nextHandTimer) return;
  room.nextHandTimer = setTimeout(() => {
    room.nextHandTimer = null;
    if (!room.gameState || !readyToStart(room.gameState)) return;
    const res = startHand(room.gameState);
    if (!res.ok) return;
    checkTimers(room);
    broadcastGameState(room);
    broadcastLobby();
  }, NEXT_HAND_DELAY_MS);
}
export function checkTimers(room) {
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
export function uniqueDisplayName(room, desired, excludeClientId) {
  const taken = new Set();
  if (room.hostId !== excludeClientId) taken.add(room.hostNickname);
  for (const [id, p] of room.players) if (id !== excludeClientId) taken.add(p.nickname);
  for (const [id, s] of room.spectators) if (id !== excludeClientId) taken.add(s.nickname);
  if (!taken.has(desired)) return desired;
  let n = 2;
  while (taken.has(`${desired} (${n})`)) n++;
  return `${desired} (${n})`;
}

export function closeRoom(room, reason) {
  clearActionTimer(room);
  if (room.nextHandTimer) { clearTimeout(room.nextHandTimer); room.nextHandTimer = null; }
  rooms.delete(room.id);
  for (const id of roomMemberIds(room)) {
    const c = clients.get(id);
    if (c) { c.roomId = null; c.role = null; send(c.ws, { type: 'room_closed', reason }); }
  }
  broadcastLobby();
}

// 把房主交給第一位其他在座玩家；沒有人可接手時回傳 false。
export function transferHost(room) {
  const newHostId = [...room.players.keys()].find((id) => id !== room.hostId);
  if (!newHostId) return false;
  const nh = clients.get(newHostId);
  room.hostId = newHostId;
  room.hostNickname = nh.nickname;
  nh.role = 'host';
  sendToClient(newHostId, { type: 'promoted_to_host' });
  systemChat(room, `${nh.nickname} 成為新房主`);
  return true;
}

export function leaveCurrentRoom(client, opts = {}) {
  const room = rooms.get(client.roomId);
  client.roomId = null;
  const wasRole = client.role;
  client.role = null;
  if (!room) return;
  const name = displayName(room, client);

  if (wasRole === 'player' || wasRole === 'host') {
    room.players.delete(client.id);
    if (room.gameState) removePlayer(room.gameState, client.id);
  } else if (wasRole === 'spectator') {
    room.spectators.delete(client.id);
  }
  systemChat(room, `${name} ${opts.disconnect ? '離線了' : '離開了房間'}`);

  if (wasRole === 'host' && !transferHost(room)) {
    closeRoom(room, opts.disconnect ? '房主已離線，沒有其他玩家可接手，房間關閉' : '房主已離開，沒有其他玩家可接手，房間關閉');
    return;
  }

  if (room.started && room.players.size <= 1) {
    closeRoom(room, '其他玩家皆已離開，房間關閉');
    return;
  }

  broadcastRoomRoster(room);
  if (room.gameState && room.started) { checkTimers(room); broadcastGameState(room); }
  broadcastLobby();
}

// --- Reconnection ---
export function handleDisconnect(client) {
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

export function handleReconnectRoom(client) {
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
    systemChat(room, `${nickname} 重新連線`);
    broadcastRoomRoster(room);
    if (room.gameState && room.started) broadcastGameState(room);
    broadcastLobby();
    return;
  }
  broadcastLobby();
}
