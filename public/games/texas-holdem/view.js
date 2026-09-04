import { escapeHtml } from '/ui.js';

export function cardHTML(card, small) {
  if (card === 'back') return `<div class="card back ${small ? 'small' : ''}"></div>`;
  const suitChar = { s: '♠', h: '♥', d: '♦', c: '♣' }[card.s];
  const red = card.s === 'h' || card.s === 'd';
  const rankChar = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[card.r] || card.r;
  return `<div class="card ${red ? 'red' : ''} ${small ? 'small' : ''}">${rankChar}${suitChar}</div>`;
}

export function seatsHTML(view, youId) {
  const n = view.players.length;
  // Rotate the ring so the viewer's seat lands at the bottom; spectators see seat 0 there.
  const youIdx = Math.max(0, view.players.findIndex((p) => p.id === youId));
  return view.players
    .map((p, i) => {
      const ringPos = (i - youIdx + n) % n;
      const classes = ['seat'];
      if (i === view.toActIdx && !['waiting', 'showdown', 'hand_over'].includes(view.stage)) classes.push('turn');
      if (p.folded) classes.push('folded');
      if (p.id === youId) classes.push('you');
      const dealer = i === view.dealerIdx ? '<span class="dealer-btn">D</span> ' : '';
      const cards = p.holeCards.map((c) => cardHTML(c, true)).join('');
      const tags = [];
      if (p.allIn) tags.push('<span class="tag">ALL-IN</span>');
      if (p.sittingOut) tags.push('<span class="tag">離座</span>');
      if (!p.connected) tags.push('<span class="tag">離線</span>');
      return `
        <div class="${classes.join(' ')}" style="--seat-i:${ringPos};--seat-n:${n}">
          <div class="seat-name">${dealer}${escapeHtml(p.nickname)} ${tags.join(' ')}</div>
          <div class="seat-chips">💰 ${p.chips}</div>
          ${p.betThisHand > 0 ? `<div class="seat-bet">本輪 ${p.betThisRound} · 本手累計 ${p.betThisHand}</div>` : ''}
          <div class="seat-cards">${cards}</div>
        </div>`;
    })
    .join('');
}

export function winnersHTML(winners) {
  return winners
    .map((w) => `${escapeHtml(w.nickname)} +${w.amount}${w.hand ? `（${w.hand}）` : ''}`)
    .join('、');
}

export function resultHTML(view) {
  if (!view.lastResult) return '';
  return '🏆 ' + winnersHTML(view.lastResult.winners);
}
