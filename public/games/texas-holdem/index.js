// 德州撲克 - 前端掛載點。房主的分頁會建立並掌管權威狀態（engine.js），
// 其他玩家/旁觀者的分頁只負責顯示伺服器轉發過來的 state_update。

import { createGame, addPlayer, removePlayer, startHand, applyAction, viewFor } from './engine.js';

let cssInjected = false;
function ensureCss() {
  if (cssInjected) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/games/texas-holdem/holdem.css';
  document.head.appendChild(link);
  cssInjected = true;
}

const AUTO_ADVANCE_SECONDS = 10;

export function mount({ container, role, you, send, sendRaw, notify, notifyTurn, initialState }) {
  const warn = notify || ((msg) => alert(msg));
  ensureCss();

  container.innerHTML = `
    <div class="holdem-root">
      <div class="holdem-table">
        <div class="holdem-board">
          <div class="holdem-pot" id="hd-pot"></div>
          <div class="holdem-community" id="hd-community"></div>
          <div class="holdem-result" id="hd-result" hidden></div>
        </div>
        <div class="holdem-seats" id="hd-seats"></div>
        <div class="holdem-log" id="hd-log"></div>
      </div>
      <div class="holdem-controls" id="hd-controls"></div>
    </div>
  `;

  const $pot = container.querySelector('#hd-pot');
  const $community = container.querySelector('#hd-community');
  const $result = container.querySelector('#hd-result');
  const $seats = container.querySelector('#hd-seats');
  const $log = container.querySelector('#hd-log');
  const $controls = container.querySelector('#hd-controls');

  const isHost = role === 'host';
  let state = null; // 只有房主用得到（權威狀態）
  let autoAdvance = null; // { handNumber, intervalId }

  function clearAutoAdvance() {
    if (autoAdvance) clearInterval(autoAdvance.intervalId);
    autoAdvance = null;
  }

  function canStartGame(view) {
    return view.players.filter((p) => p.chips > 0).length >= 2;
  }

  function broadcastState() {
    const targeted = {};
    for (const p of state.players) targeted[p.id] = viewFor(state, p.id);
    const defaultView = viewFor(state, '__spectator__');
    sendRaw({ type: 'state_update', targeted, defaultView });
  }

  function performAction(action, amount) {
    if (isHost) {
      const res = applyAction(state, you.id, action, amount);
      if (!res.ok) return warn(res.error, { error: true });
      broadcastState();
    } else {
      send('game_action', { action, amount });
    }
  }

  function hostStart() {
    const res = startHand(state);
    // 不管成功與否都要重播：就算沒開成新的一手，斷線離座造成的座位變動還是要讓大家看到，
    // 不然畫面會卡在舊的倒數/按鈕文字上不動。
    broadcastState();
    if (!res.ok) warn(res.error, { error: true });
  }

  function render(view) {
    $pot.textContent = `底池 ${view.pot}`;
    $community.innerHTML =
      view.communityCards.map((c) => cardHTML(c)).join('') ||
      '<span style="color:rgba(255,255,255,0.4)">尚未翻牌</span>';
    $seats.innerHTML = seatsHTML(view, you.id);
    $log.innerHTML = view.log.map((l) => escapeHtml(l)).join('<br/>');
    $log.scrollTop = $log.scrollHeight;

    if (view.lastResult) {
      $result.hidden = false;
      $result.innerHTML = resultHTML(view);
    } else {
      $result.hidden = true;
    }

    renderControls(view);

    const isMyTurn = !!(
      view.players[view.toActIdx]?.id === you.id &&
      !['waiting', 'showdown', 'hand_over'].includes(view.stage)
    );
    notifyTurn?.(isMyTurn);

    if (['hand_over', 'showdown'].includes(view.stage) && canStartGame(view)) {
      startAutoAdvance(view);
    } else {
      clearAutoAdvance();
    }
  }

  function startAutoAdvance(view) {
    if (autoAdvance && autoAdvance.handNumber === view.handNumber) return; // 已經在倒數了
    clearAutoAdvance();
    let remaining = AUTO_ADVANCE_SECONDS;
    const el = $controls.querySelector('#hd-countdown');
    const tick = () => {
      if (el) el.textContent = `（${remaining} 秒後自動開始下一手）`;
      if (remaining <= 0) {
        clearAutoAdvance();
        if (isHost) hostStart();
        return;
      }
      remaining -= 1;
    };
    tick();
    const intervalId = setInterval(tick, 1000);
    autoAdvance = { handNumber: view.handNumber, intervalId };
  }

  function renderControls(view) {
    const me = view.players.find((p) => p.id === you.id);
    const html = [];

    if (['waiting', 'hand_over', 'showdown'].includes(view.stage)) {
      if (isHost) {
        const canStart = canStartGame(view);
        const label = view.stage === 'waiting' ? '開始遊戲' : '下一手';
        html.push(`<button id="btn-start" ${canStart ? '' : 'disabled'}>${label}</button>`);
        if (!canStart) html.push(`<span style="color:var(--text-dim)">至少需要 2 位有籌碼的玩家</span>`);
        else if (view.stage !== 'waiting') html.push(`<span class="countdown-label" id="hd-countdown"></span>`);
      } else if (role === 'player') {
        const label = view.stage === 'waiting' ? '等待房主開始遊戲…' : '等待房主開始下一手…';
        html.push(`<span style="color:var(--text-dim)">${label}</span>`);
        if (view.stage !== 'waiting' && canStartGame(view)) html.push(`<span class="countdown-label" id="hd-countdown"></span>`);
      } else {
        html.push(`<span style="color:var(--text-dim)">👀 旁觀中</span>`);
      }
    } else if (me && view.players[view.toActIdx]?.id === you.id && !me.folded && !me.allIn) {
      const toCall = view.currentBet - me.betThisRound;
      const maxBet = me.chips + me.betThisRound;
      const minRaiseTo = Math.min(view.currentBet + view.minRaise, maxBet);
      html.push(`<button id="btn-fold" class="danger">蓋牌</button>`);
      html.push(
        toCall > 0
          ? `<button id="btn-call">跟注 ${Math.min(toCall, me.chips)}</button>`
          : `<button id="btn-call">過牌</button>`
      );
      if (me.chips > 0 && maxBet > view.currentBet) {
        html.push(`
          <input type="range" id="bet-range" min="${minRaiseTo}" max="${maxBet}" value="${minRaiseTo}" step="1" />
          <span class="bet-amount" id="bet-amount-label">${minRaiseTo}</span>
          <button id="btn-raise">${view.currentBet > 0 ? '加碼到' : '下注'}</button>
          <button id="btn-allin" class="secondary">全下</button>
        `);
      }
    } else if (me) {
      html.push(
        `<span style="color:var(--text-dim)">${me.folded ? '你已蓋牌，' : ''}${me.allIn ? '你已全下，' : ''}等待其他玩家行動…</span>`
      );
    } else {
      html.push(`<span style="color:var(--text-dim)">👀 旁觀中</span>`);
    }

    $controls.innerHTML = html.join('');

    $controls.querySelector('#btn-start')?.addEventListener('click', hostStart);
    $controls.querySelector('#btn-fold')?.addEventListener('click', () => performAction('fold'));
    $controls.querySelector('#btn-call')?.addEventListener('click', () => {
      const toCall = view.currentBet - me.betThisRound;
      performAction(toCall > 0 ? 'call' : 'check');
    });
    const range = $controls.querySelector('#bet-range');
    const label = $controls.querySelector('#bet-amount-label');
    range?.addEventListener('input', () => {
      label.textContent = range.value;
    });
    $controls.querySelector('#btn-raise')?.addEventListener('click', () => {
      performAction(view.currentBet > 0 ? 'raise' : 'bet', Number(range.value));
    });
    $controls.querySelector('#btn-allin')?.addEventListener('click', () => {
      performAction(view.currentBet > 0 ? 'raise' : 'bet', me.chips + me.betThisRound);
    });
  }

  if (isHost) {
    if (initialState) {
      // 從前一位房主接手：直接沿用收到的權威狀態，牌局照樣繼續。
      // actedSet 經過 JSON 轉送會變成陣列，這裡要轉回 Set。
      state = { ...initialState, actedSet: new Set(initialState.actedSet || []) };
    } else {
      state = createGame();
      addPlayer(state, you.id, you.nickname);
    }
    broadcastState();
  } else {
    $controls.innerHTML = `<span style="color:var(--text-dim)">等待房主開始遊戲…</span>`;
  }

  return {
    onMessage(msg) {
      if (isHost) {
        if (msg.type === 'peer_joined') {
          if (msg.role === 'player') addPlayer(state, msg.clientId, msg.nickname);
          broadcastState();
        } else if (msg.type === 'peer_left') {
          removePlayer(state, msg.clientId);
          broadcastState();
        } else if (msg.type === 'game_action') {
          const res = applyAction(state, msg.senderId, msg.payload.action, msg.payload.amount);
          if (res.ok) broadcastState();
        } else if (msg.type === 'state_update') {
          render(msg.payload);
        }
      } else if (msg.type === 'state_update') {
        render(msg.payload);
      }
    },
    prepareHandoff() {
      // 房主主動離開：把自己標記成離線（沿用一般斷線的蓋牌/離座邏輯），
      // 再把剩下的權威狀態交給下一位玩家。actedSet 是 Set，經 JSON 傳送前要先轉成陣列。
      if (!isHost || !state) return null;
      removePlayer(state, you.id);
      return { ...state, actedSet: [...state.actedSet] };
    },
    destroy() {
      clearAutoAdvance();
      container.innerHTML = '';
    },
  };
}

function cardHTML(card, small) {
  if (card === 'back') return `<div class="card back ${small ? 'small' : ''}"></div>`;
  const suitChar = { s: '♠', h: '♥', d: '♦', c: '♣' }[card.s];
  const red = card.s === 'h' || card.s === 'd';
  const rankChar = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[card.r] || card.r;
  return `<div class="card ${red ? 'red' : ''} ${small ? 'small' : ''}">${rankChar}${suitChar}</div>`;
}

function seatsHTML(view, youId) {
  return view.players
    .map((p, i) => {
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
        <div class="${classes.join(' ')}">
          <div class="seat-name">${dealer}${escapeHtml(p.nickname)} ${tags.join(' ')}</div>
          <div class="seat-chips">💰 ${p.chips}</div>
          ${p.betThisRound > 0 ? `<div class="seat-bet">本輪下注 ${p.betThisRound}</div>` : ''}
          <div class="seat-cards">${cards}</div>
        </div>`;
    })
    .join('');
}

function resultHTML(view) {
  if (!view.lastResult) return '';
  return (
    '🏆 ' +
    view.lastResult.winners
      .map((w) => `${escapeHtml(w.nickname)} +${w.amount}${w.hand ? `（${w.hand}）` : ''}`)
      .join('、')
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
