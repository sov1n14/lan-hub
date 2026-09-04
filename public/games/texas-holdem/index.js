import { escapeHtml } from '/ui.js';
import { cardHTML, seatsHTML, resultHTML, winnersHTML } from '/games/texas-holdem/view.js';

const NOTIFY_GAIN = 0.3;
const NOTIFY_FREQUENCY = 800;
const NOTIFY_DURATION = 0.15;

let cssInjected = false;
function ensureCss() {
  if (cssInjected) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/games/texas-holdem/holdem.css';
  document.head.appendChild(link);
  cssInjected = true;
}

export function mount({ container, role, you, send, sendRaw, notifyTurn }) {
  ensureCss();

  container.innerHTML = `
    <div class="holdem-root">
      <div class="holdem-table">
        <div class="holdem-board">
          <div class="holdem-pot" id="hd-pot"></div>
          <div class="holdem-community" id="hd-community"></div>
          <div class="holdem-result" id="hd-result" hidden></div>
          <div class="holdem-deadline" id="hd-deadline"></div>
        </div>
        <div class="holdem-seats" id="hd-seats"></div>
        <div class="holdem-log" id="hd-log"></div>
      </div>
      <div class="holdem-controls" id="hd-controls"></div>
      <div class="holdem-secondary" id="hd-secondary"></div>
      <details class="holdem-history"><summary>牌局紀錄</summary><div id="hd-history"></div></details>
    </div>
  `;

  const $pot = container.querySelector('#hd-pot');
  const $community = container.querySelector('#hd-community');
  const $result = container.querySelector('#hd-result');
  const $deadline = container.querySelector('#hd-deadline');
  const $seats = container.querySelector('#hd-seats');
  const $log = container.querySelector('#hd-log');
  const $controls = container.querySelector('#hd-controls');
  const $secondary = container.querySelector('#hd-secondary');
  const $history = container.querySelector('#hd-history');

  let currentRole = role;
  let deadlineInterval = null;
  let lastView = null;

  function clearDeadlineInterval() {
    if (deadlineInterval) { clearInterval(deadlineInterval); deadlineInterval = null; }
  }

  // Match server's readyToStart: !p.sittingOut && p.chips > 0
  function canStartGame(view) {
    return view.players.filter((p) => !p.sittingOut && p.chips > 0).length >= 2;
  }

  function performAction(action, amount) {
    send('game_action', { action, amount });
  }

  function playNotifySound() {
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      gain.gain.value = NOTIFY_GAIN;
      osc.frequency.value = NOTIFY_FREQUENCY;
      osc.start(); osc.stop(ctx.currentTime + NOTIFY_DURATION);
    } catch {}
  }

  function updateDeadline(view) {
    if (!view.turnDeadline) { $deadline.textContent = ''; return; }
    const remaining = Math.max(0, Math.ceil((view.turnDeadline - Date.now()) / 1000));
    $deadline.textContent = remaining > 0 ? `⏱ ${remaining}s` : '';
  }

  function render(view) {
    lastView = view;
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
    renderSecondary(view);
    renderHistory(view);
    updateDeadline(view);

    clearDeadlineInterval();
    if (view.turnDeadline) {
      deadlineInterval = setInterval(() => updateDeadline(view), 1000);
    }

    const isMyTurn = !!(
      view.players[view.toActIdx]?.id === you.id &&
      !['waiting', 'showdown', 'hand_over'].includes(view.stage)
    );
    if (isMyTurn) playNotifySound();
    notifyTurn?.(isMyTurn);
  }

  function renderControls(view) {
    const me = view.players.find((p) => p.id === you.id);
    const html = [];

    if (['waiting', 'hand_over', 'showdown'].includes(view.stage)) {
      if (currentRole === 'host') {
        const canStart = canStartGame(view);
        const label = view.stage === 'waiting' ? '開始遊戲' : '下一手';
        html.push(`<button id="btn-start" ${canStart ? '' : 'disabled'}>${label}</button>`);
        if (!canStart) html.push(`<span style="color:var(--text-dim)">至少需要 2 位有籌碼的玩家</span>`);
      } else if (currentRole === 'spectator') {
        html.push(`<span style="color:var(--text-dim)">👀 旁觀中</span>`);
        if (view.players.length < (view.maxPlayers || 6)) {
          html.push(`<button id="btn-seat">入座</button>`);
        }
      } else {
        const label = view.stage === 'waiting' ? '等待房主開始遊戲…' : '等待下一手…';
        html.push(`<span style="color:var(--text-dim)">${label}</span>`);
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

    $controls.querySelector('#btn-start')?.addEventListener('click', () => sendRaw({ type: 'start_game' }));
    $controls.querySelector('#btn-seat')?.addEventListener('click', () => sendRaw({ type: 'seat_request' }));
    $controls.querySelector('#btn-fold')?.addEventListener('click', () => performAction('fold'));
    $controls.querySelector('#btn-call')?.addEventListener('click', () => {
      const toCall = view.currentBet - (view.players.find(p => p.id === you.id)?.betThisRound || 0);
      performAction(toCall > 0 ? 'call' : 'check');
    });
    const range = $controls.querySelector('#bet-range');
    const label = $controls.querySelector('#bet-amount-label');
    range?.addEventListener('input', () => { label.textContent = range.value; });
    $controls.querySelector('#btn-raise')?.addEventListener('click', () => {
      performAction(view.currentBet > 0 ? 'raise' : 'bet', Number(range.value));
    });
    $controls.querySelector('#btn-allin')?.addEventListener('click', () => {
      const me = view.players.find(p => p.id === you.id);
      performAction(view.currentBet > 0 ? 'raise' : 'bet', me.chips + me.betThisRound);
    });
  }

  function renderSecondary(view) {
    const me = view.players.find(p => p.id === you.id);
    if (!me || currentRole === 'spectator') { $secondary.innerHTML = ''; return; }
    const html = [];
    if (me.sittingOut) {
      html.push('<button id="btn-sitback">回座</button>');
    } else {
      html.push('<button id="btn-sitout" class="secondary">暫離</button>');
    }
    html.push('<button id="btn-leaveseat" class="secondary danger">退座轉旁觀</button>');
    if (me.chips === 0 && ['waiting', 'hand_over', 'showdown'].includes(view.stage)) {
      html.push('<button id="btn-rebuy">重新買入</button>');
    }
    $secondary.innerHTML = html.join(' ');
    $secondary.querySelector('#btn-sitout')?.addEventListener('click', () => sendRaw({ type: 'sit_out' }));
    $secondary.querySelector('#btn-sitback')?.addEventListener('click', () => sendRaw({ type: 'sit_back' }));
    $secondary.querySelector('#btn-leaveseat')?.addEventListener('click', () => sendRaw({ type: 'leave_seat' }));
    $secondary.querySelector('#btn-rebuy')?.addEventListener('click', () => sendRaw({ type: 'rebuy' }));
  }

  function renderHistory(view) {
    if (!view.handHistory || view.handHistory.length === 0) { $history.innerHTML = '<em>尚無紀錄</em>'; return; }
    $history.innerHTML = view.handHistory
      .map(h => `<div>第 ${h.handNumber} 手：${winnersHTML(h.result?.winners || []) || '—'}</div>`)
      .join('');
  }

  $controls.innerHTML = `<span style="color:var(--text-dim)">等待遊戲狀態…</span>`;

  return {
    onMessage(msg) {
      if (msg.type === 'state_update') render(msg.payload);
      else if (msg.type === 'role_changed') {
        currentRole = msg.role;
        if (lastView) render(lastView);
      }
    },
    destroy() {
      clearDeadlineInterval();
      container.innerHTML = '';
    },
  };
}
