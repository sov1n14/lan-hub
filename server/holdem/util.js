// 共用工具函式與常數

export const LOG_CAP = 60;
export const HAND_HISTORY_CAP = 20;

export function log(state, id, text) {
  state.log.push({ id, text });
  if (state.log.length > LOG_CAP) state.log.shift();
}

export function nextIndexWhere(state, fromIdx, predicate) {
  const n = state.players.length;
  if (n === 0) return -1;
  let i = fromIdx;
  for (let step = 0; step < n; step++) {
    i = (i + 1) % n;
    if (predicate(state.players[i])) return i;
  }
  return -1;
}

export const isMidHand = (state) => !['waiting', 'showdown', 'hand_over'].includes(state.stage);
export const isSeated = (p) => !p.sittingOut;
export const canAct = (p) => !p.sittingOut && !p.folded && !p.allIn;
