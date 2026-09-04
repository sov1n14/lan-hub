// 牌型評估 — 純函式，無副作用

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
