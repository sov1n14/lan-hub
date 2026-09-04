// 德州撲克 - 遊戲狀態機入口（伺服器端執行，零 DOM 依賴）

import { randomInt } from 'node:crypto';
import { log, nextIndexWhere, isSeated, canAct } from './util.js';
import { applyAction, advanceTurn, nonFoldedCount, endHandByFold } from './hand.js';

export { applyAction };

export const STARTING_CHIPS = 2000;
const SMALL_BLIND = 25;
export const BIG_BLIND = 50;

const SUITS = ['s', 'h', 'd', 'c'];

function createDeck() {
  const deck = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) deck.push({ r, s });
  return deck;
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function createGame({ smallBlind = SMALL_BLIND, bigBlind = BIG_BLIND, startingChips = STARTING_CHIPS } = {}) {
  return {
    smallBlind,
    bigBlind,
    players: [],
    dealerIdx: -1,
    communityCards: [],
    deck: [],
    stage: 'waiting',
    toActIdx: -1,
    currentBet: 0,
    minRaise: bigBlind,
    startingChips,
    actedSet: new Set(),
    handNumber: 0,
    log: [],
    lastResult: null,
    handHistory: [],
  };
}

export function addPlayer(state, id, nickname, buyIn = STARTING_CHIPS) {
  const existing = state.players.find(p => p.id === id);
  if (existing) {
    existing.connected = true;
    existing.nickname = nickname;
    if (existing.chips <= 0) existing.chips = buyIn;
    existing.sittingOut = state.stage !== 'waiting';
    return;
  }
  state.players.push({
    id, nickname, chips: buyIn,
    holeCards: [], folded: true, allIn: false,
    betThisRound: 0, betThisHand: 0,
    connected: true, sittingOut: state.stage !== 'waiting',
  });
}

export function removePlayer(state, id) {
  const idx = state.players.findIndex((x) => x.id === id);
  if (idx === -1) return;
  const p = state.players[idx];
  const midHand = !['waiting', 'showdown', 'hand_over'].includes(state.stage);

  if (!midHand) {
    state.players.splice(idx, 1);
    if (state.dealerIdx === idx) state.dealerIdx = -1;
    else if (state.dealerIdx > idx) state.dealerIdx -= 1;
    log(state, `${p.nickname} 離線，已離座`);
    return;
  }

  p.connected = false;
  p.sittingOut = true;
  if (!p.folded) {
    p.folded = true;
    log(state, `${p.nickname} 離線，自動蓋牌`);
    if (idx === state.toActIdx) {
      advanceTurn(state, idx);
    } else if (nonFoldedCount(state) <= 1) {
      endHandByFold(state);
    }
  }
}

export function rebuy(state, playerId, amount) {
  if (!['waiting', 'hand_over', 'showdown'].includes(state.stage))
    return { ok: false, error: '只能在非牌局進行中買入' };
  const p = state.players.find(x => x.id === playerId);
  if (!p) return { ok: false, error: '找不到玩家' };
  if (p.chips > 0) return { ok: false, error: '還有籌碼，無法 rebuy' };
  const maxRebuy = Math.floor(state.startingChips / 2);
  if (amount <= 0 || amount > maxRebuy)
    return { ok: false, error: `Rebuy 金額須在 1~${maxRebuy} 之間` };
  p.chips = amount;
  p.sittingOut = false;
  p.folded = true;
  log(state, `${p.nickname} 重新買入 ${amount} 籌碼`);
  return { ok: true };
}

// 牌局中斷線的人只會先蓋牌，真正把座位清空要等到下一手開局前才做，
// 這樣才不會在計算彩池/牌局狀態時把陣列索引搞亂。
function purgeDisconnected(state) {
  const dealerPlayer = state.dealerIdx >= 0 ? state.players[state.dealerIdx] : null;
  state.players = state.players.filter((p) => p.connected);
  state.dealerIdx = dealerPlayer ? state.players.findIndex((p) => p.id === dealerPlayer.id) : -1;
}

export function readyToStart(state) {
  return state.players.filter((p) => !p.sittingOut && p.chips > 0).length >= 2;
}

function seatOrderFromDealer(state) {
  const order = [];
  const n = state.players.filter(isSeated).length;
  let idx = state.dealerIdx;
  order.push(state.players[idx]);
  for (let i = 1; i < n; i++) {
    idx = nextIndexWhere(state, idx, isSeated);
    order.push(state.players[idx]);
  }
  return order;
}

function postBet(state, player, amount) {
  const actual = Math.min(amount, player.chips);
  player.chips -= actual;
  player.betThisRound += actual;
  player.betThisHand += actual;
  if (player.chips === 0) player.allIn = true;
  log(state, `${player.nickname} 下注 ${actual}`);
}

export function startHand(state) {
  purgeDisconnected(state);
  const eligible = state.players.filter((p) => !p.sittingOut && p.chips > 0);
  if (eligible.length < 2) return { ok: false, error: '至少需要 2 位有籌碼的玩家' };

  for (const p of state.players) {
    p.sittingOut = p.sittingOut || p.chips <= 0;
    p.holeCards = [];
    p.folded = p.sittingOut;
    p.allIn = false;
    p.betThisRound = 0;
    p.betThisHand = 0;
  }

  state.deck = shuffle(createDeck());
  state.communityCards = [];
  state.stage = 'preflop';
  state.handNumber += 1;
  state.currentBet = 0;
  state.minRaise = state.bigBlind;
  state.actedSet = new Set();
  state.log = [];
  state.lastResult = null;

  state.dealerIdx = nextIndexWhere(state, state.dealerIdx === -1 ? state.players.length - 1 : state.dealerIdx, isSeated);
  const order = seatOrderFromDealer(state);
  if (order.length < 2) return { ok: false, error: '至少需要 2 位在座玩家' };

  const sbPlayer = order.length === 2 ? order[0] : order[1];
  const bbPlayer = order.length === 2 ? order[1] : order[2];
  postBet(state, sbPlayer, state.smallBlind);
  postBet(state, bbPlayer, state.bigBlind);
  state.currentBet = state.bigBlind;
  state.actedSet = new Set([sbPlayer.id, bbPlayer.id].filter((id) => state.players.find((p) => p.id === id)?.allIn));

  const seated = state.players.filter(isSeated);
  for (const p of seated) p.holeCards = [state.deck.pop(), state.deck.pop()];

  const bbIdx = state.players.indexOf(bbPlayer);
  log(state, `第 ${state.handNumber} 手開始`);
  state.toActIdx = nextIndexWhere(state, bbIdx, canAct);
  if (state.toActIdx === -1) advanceTurn(state, bbIdx);
  return { ok: true };
}

export function viewFor(state, viewerId) {
  const revealIds = new Set((state.lastResult?.reveal || []).map((r) => r.id));
  return {
    stage: state.stage,
    handNumber: state.handNumber,
    communityCards: state.communityCards,
    currentBet: state.currentBet,
    minRaise: state.minRaise,
    dealerIdx: state.dealerIdx,
    toActIdx: state.toActIdx,
    smallBlind: state.smallBlind,
    bigBlind: state.bigBlind,
    pot: state.players.reduce((s, p) => s + p.betThisHand, 0),
    log: state.log.slice(-14),
    lastResult: state.lastResult,
    turnRemainingMs: state.turnDeadline ? Math.max(0, state.turnDeadline - Date.now()) : null,
    handHistory: state.handHistory || [],
    players: state.players.map((p, idx) => ({
      id: p.id,
      nickname: p.nickname,
      chips: p.chips,
      folded: p.folded,
      allIn: p.allIn,
      sittingOut: p.sittingOut,
      connected: p.connected,
      betThisRound: p.betThisRound,
      betThisHand: p.betThisHand,
      seatIndex: idx,
      holeCards: p.id === viewerId || revealIds.has(p.id)
        ? p.holeCards
        : p.holeCards.length ? ['back', 'back'] : [],
    })),
  };
}
