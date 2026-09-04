// 下注回合、回合推進、結算邏輯

import { log, nextIndexWhere, isSeated, canAct, HAND_HISTORY_CAP } from './util.js';
import { evaluate7, compareEval } from './evaluate.js';

function isBettingRoundOver(state) {
  const contenders = state.players.filter(canAct);
  if (contenders.length === 0) return true;
  return contenders.every((p) => state.actedSet.has(p.id) && p.betThisRound === state.currentBet);
}

export function nonFoldedCount(state) {
  return state.players.filter((p) => isSeated(p) && !p.folded).length;
}

function dealCommunity(state, n) {
  state.deck.pop();
  for (let i = 0; i < n; i++) state.communityCards.push(state.deck.pop());
}

export function advanceTurn(state, actedIdx) {
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

export function endHandByFold(state) {
  const winner = state.players.find((p) => isSeated(p) && !p.folded);
  const pot = state.players.reduce((s, p) => s + p.betThisHand, 0);
  winner.chips += pot;
  state.stage = 'hand_over';
  state.lastResult = { winners: [{ id: winner.id, nickname: winner.nickname, amount: pot, hand: null }], pots: [{ amount: pot, eligible: [winner.id] }], reveal: [] };
  log(state, `${winner.nickname} 獲勝，贏得 ${pot} 籌碼（其他人已蓋牌）`);
  state.handHistory.push({ handNumber: state.handNumber, result: state.lastResult });
  if (state.handHistory.length > HAND_HISTORY_CAP) state.handHistory.shift();
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
  if (state.handHistory.length > HAND_HISTORY_CAP) state.handHistory.shift();
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
      // TDA 43：未達最小加碼的全下不重開下注，已行動者只能跟注或棄牌。
      if (state.actedSet.has(p.id)) return { ok: false, error: '短全下不重開下注，只能跟注或蓋牌' };
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
