import { randomInt } from 'node:crypto';

// 德州撲克 - 純規則邏輯（伺服器端執行，零 DOM 依賴）。

export const STARTING_CHIPS = 2000;
export const SMALL_BLIND = 25;
export const BIG_BLIND = 50;

const SUITS = ['s', 'h', 'd', 'c'];

export function createDeck() {
  const deck = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) deck.push({ r, s });
  return deck;
}

export function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// ---------- 牌型評估 ----------

function combinations5(arr) {
  const results = [];
  const combo = [];
  (function recurse(start) {
    if (combo.length === 5) { results.push(combo.slice()); return; }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      recurse(i + 1);
      combo.pop();
    }
  })(0);
  return results;
}

const HAND_NAMES = ['高牌', '一對', '兩對', '三條', '順子', '同花', '葫蘆', '四條', '同花順'];

function rank5(cards) {
  const ranks = cards.map((c) => c.r).sort((a, b) => b - a);
  const isFlush = cards.every((c) => c.s === cards[0].s);

  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const groups = Object.entries(counts)
    .map(([r, c]) => [Number(r), c])
    .sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  const uniqueDesc = [...new Set(ranks)];
  let straightHigh = null;
  if (uniqueDesc.length === 5) {
    if (uniqueDesc[0] - uniqueDesc[4] === 4) straightHigh = uniqueDesc[0];
    else if (uniqueDesc.join(',') === '14,5,4,3,2') straightHigh = 5;
  }
  const isStraight = straightHigh !== null;

  let rank, tiebreak;
  if (isStraight && isFlush) { rank = 8; tiebreak = [straightHigh]; }
  else if (groups[0][1] === 4) { rank = 7; tiebreak = [groups[0][0], groups[1][0]]; }
  else if (groups[0][1] === 3 && groups[1] && groups[1][1] >= 2) { rank = 6; tiebreak = [groups[0][0], groups[1][0]]; }
  else if (isFlush) { rank = 5; tiebreak = ranks; }
  else if (isStraight) { rank = 4; tiebreak = [straightHigh]; }
  else if (groups[0][1] === 3) { rank = 3; tiebreak = [groups[0][0], ...groups.filter((g) => g[1] === 1).map((g) => g[0])]; }
  else if (groups[0][1] === 2 && groups[1] && groups[1][1] === 2) {
    const pairs = [groups[0][0], groups[1][0]].sort((a, b) => b - a);
    rank = 2; tiebreak = [...pairs, groups.find((g) => g[1] === 1)[0]];
  } else if (groups[0][1] === 2) { rank = 1; tiebreak = [groups[0][0], ...groups.filter((g) => g[1] === 1).map((g) => g[0])]; }
  else { rank = 0; tiebreak = ranks; }

  return { rank, tiebreak, name: HAND_NAMES[rank] };
}

export function compareEval(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  const len = Math.max(a.tiebreak.length, b.tiebreak.length);
  for (let i = 0; i < len; i++) {
    const av = a.tiebreak[i] || 0, bv = b.tiebreak[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

export function evaluate7(cards7) {
  let best = null;
  for (const combo of combinations5(cards7)) {
    const r = rank5(combo);
    if (!best || compareEval(r, best) > 0) best = r;
  }
  return best;
}

// ---------- 遊戲狀態機 ----------

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

function log(state, msg) {
  state.log.push(msg);
  if (state.log.length > 60) state.log.shift();
}

function nextIndexWhere(state, fromIdx, predicate) {
  const n = state.players.length;
  if (n === 0) return -1;
  let i = fromIdx;
  for (let step = 0; step < n; step++) {
    i = (i + 1) % n;
    if (predicate(state.players[i])) return i;
  }
  return -1;
}

const isSeated = (p) => !p.sittingOut;
const canAct = (p) => !p.sittingOut && !p.folded && !p.allIn;

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
  state.toActIdx = nextIndexWhere(state, bbIdx, canAct);
  if (state.toActIdx === -1) state.toActIdx = bbIdx;

  log(state, `第 ${state.handNumber} 手開始`);
  return { ok: true };
}

function isBettingRoundOver(state) {
  const contenders = state.players.filter(canAct);
  if (contenders.length === 0) return true;
  return contenders.every((p) => state.actedSet.has(p.id) && p.betThisRound === state.currentBet);
}

function nonFoldedCount(state) {
  return state.players.filter((p) => isSeated(p) && !p.folded).length;
}

function dealCommunity(state, n) {
  state.deck.pop();
  for (let i = 0; i < n; i++) state.communityCards.push(state.deck.pop());
}

export function applyAction(state, playerId, action, amount = 0) {
  const idx = state.players.findIndex((p) => p.id === playerId);
  if (idx === -1) return { ok: false, error: '找不到玩家' };
  if (idx !== state.toActIdx) return { ok: false, error: '還沒輪到你' };
  const p = state.players[idx];
  if (p.folded || p.allIn) return { ok: false, error: '你已經無法行動' };

  const toCall = state.currentBet - p.betThisRound;
  let aggressive = false;

  switch (action) {
    case 'fold':
      p.folded = true;
      log(state, `${p.nickname} 蓋牌`);
      break;
    case 'check':
      if (toCall > 0) return { ok: false, error: '目前有注要跟，不能過牌' };
      log(state, `${p.nickname} 過牌`);
      break;
    case 'call': {
      const pay = Math.min(toCall, p.chips);
      p.chips -= pay; p.betThisRound += pay; p.betThisHand += pay;
      if (p.chips === 0) p.allIn = true;
      log(state, `${p.nickname} 跟注 ${pay}${p.allIn ? '（全下）' : ''}`);
      break;
    }
    case 'bet':
    case 'raise': {
      const total = Number(amount);
      if (!Number.isFinite(total) || total <= p.betThisRound) return { ok: false, error: '下注金額不正確' };
      const need = total - p.betThisRound;
      if (need > p.chips) return { ok: false, error: '籌碼不夠' };
      const isAllIn = need === p.chips;
      const minTotal = state.currentBet > 0 ? state.currentBet + state.minRaise : state.minRaise;
      if (total < minTotal && !isAllIn) {
        return { ok: false, error: `下注至少要到 ${minTotal}` };
      }
      p.chips -= need; p.betThisRound += need; p.betThisHand += need;
      if (p.chips === 0) p.allIn = true;
      if (total > state.currentBet) {
        const raiseAmount = total - state.currentBet;
        if (raiseAmount >= state.minRaise) {
          state.minRaise = Math.max(state.minRaise, raiseAmount);
          aggressive = true;
        }
        state.currentBet = total;
      }
      log(state, `${p.nickname} ${action === 'bet' ? '下注' : '加碼到'} ${total}${p.allIn ? '（全下）' : ''}`);
      break;
    }
    default:
      return { ok: false, error: '未知的動作' };
  }

  if (aggressive) state.actedSet = new Set([p.id]);
  else state.actedSet.add(p.id);

  advanceTurn(state, idx);
  return { ok: true };
}

function advanceTurn(state, actedIdx) {
  if (nonFoldedCount(state) <= 1) return endHandByFold(state);
  if (isBettingRoundOver(state)) return advanceStage(state);
  const next = nextIndexWhere(state, actedIdx, canAct);
  if (next === -1) return advanceStage(state);
  state.toActIdx = next;
}

function advanceStage(state) {
  for (const p of state.players) p.betThisRound = 0;
  state.currentBet = 0;
  state.minRaise = state.bigBlind;
  state.actedSet = new Set();

  if (state.stage === 'preflop') { dealCommunity(state, 3); state.stage = 'flop'; }
  else if (state.stage === 'flop') { dealCommunity(state, 1); state.stage = 'turn'; }
  else if (state.stage === 'turn') { dealCommunity(state, 1); state.stage = 'river'; }
  else if (state.stage === 'river') return showdown(state);

  const contenders = state.players.filter(canAct);
  if (contenders.length <= 1) return advanceStage(state);
  const next = nextIndexWhere(state, state.dealerIdx, canAct);
  if (next === -1) return advanceStage(state);
  state.toActIdx = next;
}

function endHandByFold(state) {
  const winner = state.players.find((p) => isSeated(p) && !p.folded);
  const pot = state.players.reduce((s, p) => s + p.betThisHand, 0);
  winner.chips += pot;
  state.stage = 'hand_over';
  state.lastResult = { winners: [{ id: winner.id, nickname: winner.nickname, amount: pot, hand: null }], pots: [{ amount: pot, eligible: [winner.id] }], reveal: [] };
  log(state, `${winner.nickname} 獲勝，贏得 ${pot} 籌碼（其他人已蓋牌）`);
  state.handHistory.push({ handNumber: state.handNumber, result: state.lastResult });
  if (state.handHistory.length > 20) state.handHistory.shift();
}

function computeSidePots(state) {
  const pots = [];
  let remaining = state.players
    .filter((p) => p.betThisHand > 0)
    .map((p) => ({ id: p.id, amount: p.betThisHand, folded: p.folded }));
  while (remaining.length > 0) {
    const level = Math.min(...remaining.map((c) => c.amount));
    const potAmount = level * remaining.length;
    const eligible = remaining.filter((c) => !c.folded).map((c) => c.id);
    pots.push({ amount: potAmount, eligible });
    remaining = remaining.map((c) => ({ ...c, amount: c.amount - level })).filter((c) => c.amount > 0);
  }
  return pots;
}

function showdown(state) {
  state.stage = 'showdown';
  const pots = computeSidePots(state);
  const evals = new Map();
  for (const p of state.players) {
    if (isSeated(p) && !p.folded) evals.set(p.id, evaluate7([...p.holeCards, ...state.communityCards]));
  }

  const winners = [];
  for (const pot of pots) {
    const eligibleEvals = pot.eligible.map((id) => [id, evals.get(id)]).filter(([, e]) => e);
    if (eligibleEvals.length === 0) continue;
    let bestEval = eligibleEvals[0][1];
    for (const [, e] of eligibleEvals) if (compareEval(e, bestEval) > 0) bestEval = e;
    const potWinners = eligibleEvals.filter(([, e]) => compareEval(e, bestEval) === 0).map(([id]) => id);
    potWinners.sort((a, b) => {
      const n = state.players.length;
      const distA = (state.players.findIndex(p => p.id === a) - state.dealerIdx + n) % n;
      const distB = (state.players.findIndex(p => p.id === b) - state.dealerIdx + n) % n;
      return distA - distB;
    });
    const share = Math.floor(pot.amount / potWinners.length);
    let remainder = pot.amount - share * potWinners.length;
    for (const id of potWinners) {
      const player = state.players.find((p) => p.id === id);
      let amount = share;
      if (remainder > 0) { amount += 1; remainder -= 1; }
      player.chips += amount;
      winners.push({ id, nickname: player.nickname, amount, hand: bestEval.name });
    }
  }

  state.lastResult = {
    winners,
    pots: pots.map((p) => ({ amount: p.amount, eligible: p.eligible })),
    reveal: [...evals.entries()].map(([id, e]) => ({ id, evaluation: e.name })),
  };
  log(state, `攤牌！${winners.map((w) => `${w.nickname} +${w.amount}(${w.hand})`).join('、')}`);
  state.handHistory.push({ handNumber: state.handNumber, result: state.lastResult });
  if (state.handHistory.length > 20) state.handHistory.shift();
}

// ---------- 給前端用的「畫面視角」 ----------

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
    turnDeadline: state.turnDeadline || null,
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
