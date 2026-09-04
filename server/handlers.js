import {
  GAME_CATALOG, clients, rooms, bumpRoomId,
  send, sendToClient, roomSummary,
  broadcastLobby, broadcastRoomRoster, broadcastGameState,
  scheduleActionTimer, clearActionTimer, checkTimers,
  uniqueDisplayName, closeRoom, leaveCurrentRoom,
} from './rooms.js';
import { createGame, addPlayer, removePlayer, startHand, applyAction, rebuy, STARTING_CHIPS, BIG_BLIND } from './holdem/engine.js';

const ROOM_NAME_MAX_LENGTH = 30;
const NICKNAME_MAX_LENGTH = 20;
const MIN_BLIND = 2;

function handleSetNickname(client, msg) {
  const raw = String(msg.nickname || client.nickname).slice(0, NICKNAME_MAX_LENGTH);
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
}

function handleListRooms(client, _msg) {
  send(client.ws, { type: 'room_list', catalog: GAME_CATALOG, rooms: [...rooms.values()].map(roomSummary) });
}

function handleCreateRoom(client, msg) {
  if (client.roomId) return send(client.ws, { type: 'error', message: '你已經在房間裡了' });
  const game = GAME_CATALOG.find(g => g.gameType === msg.gameType);
  if (!game) return send(client.ws, { type: 'error', message: '不支援的遊戲類型' });
  const maxPlayers = Math.min(Math.max(Number(msg.maxPlayers) || game.defaultMaxPlayers, game.minPlayers), game.maxPlayersLimit);
  const bigBlind = Math.max(Number(msg.bigBlind) || BIG_BLIND, MIN_BLIND);
  const smallBlind = Math.floor(bigBlind / 2);
  const chips = Math.max(Number(msg.startingChips) || STARTING_CHIPS, bigBlind * 2);
  const allowRebuy = !!msg.allowRebuy;
  const roomId = 'r' + bumpRoomId();
  const room = {
    id: roomId, gameType: game.gameType,
    name: String(msg.name || `${client.nickname} 的房間`).slice(0, ROOM_NAME_MAX_LENGTH),
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
}

function handleJoinRoom(client, msg) {
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
}

function handleLeaveRoom(client, _msg) {
  leaveCurrentRoom(client, {});
}

function handleStartGame(client, _msg) {
  const room = rooms.get(client.roomId);
  if (!room || client.role !== 'host') return;
  if (room.nextHandTimer) { clearTimeout(room.nextHandTimer); room.nextHandTimer = null; }
  const res = startHand(room.gameState);
  if (!res.ok) return send(client.ws, { type: 'error', message: res.error });
  room.started = true;
  scheduleActionTimer(room);
  broadcastGameState(room);
  broadcastLobby();
}

function handleGameAction(client, msg) {
  const room = rooms.get(client.roomId);
  if (!room?.gameState) return;
  if (client.role !== 'player' && client.role !== 'host') return;
  const res = applyAction(room.gameState, client.id, msg.payload.action, msg.payload.amount);
  if (!res.ok) return send(client.ws, { type: 'error', message: res.error });
  clearActionTimer(room);
  checkTimers(room);
  broadcastGameState(room);
}

function handleSeatRequest(client, _msg) {
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
}

function handleRebuy(client, msg) {
  const room = rooms.get(client.roomId);
  if (!room?.gameState || !room.settings.allowRebuy)
    return send(client.ws, { type: 'error', message: 'Rebuy 未啟用' });
  if (client.role !== 'player' && client.role !== 'host') return;
  const amount = Number(msg.amount) || Math.floor(room.settings.startingChips / 2);
  const res = rebuy(room.gameState, client.id, amount);
  if (!res.ok) return send(client.ws, { type: 'error', message: res.error });
  broadcastGameState(room);
}

function handleSitOut(client, _msg) {
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
}

function handleSitBack(client, _msg) {
  const room = rooms.get(client.roomId);
  if (!room?.gameState || (client.role !== 'player' && client.role !== 'host')) return;
  const player = room.gameState.players.find(p => p.id === client.id);
  if (!player || !player.sittingOut) return;
  player.sittingOut = false;
  broadcastGameState(room);
}

function handleLeaveSeat(client, _msg) {
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
}

const MESSAGE_HANDLERS = {
  set_nickname: handleSetNickname,
  list_rooms: handleListRooms,
  create_room: handleCreateRoom,
  join_room: handleJoinRoom,
  leave_room: handleLeaveRoom,
  start_game: handleStartGame,
  game_action: handleGameAction,
  seat_request: handleSeatRequest,
  rebuy: handleRebuy,
  sit_out: handleSitOut,
  sit_back: handleSitBack,
  leave_seat: handleLeaveSeat,
};

export function handleMessage(client, msg) {
  const handler = MESSAGE_HANDLERS[msg.type];
  if (handler) handler(client, msg);
}
