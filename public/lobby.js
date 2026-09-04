// 大廳：房間列表、開房 modal、暱稱設定。
import { escapeHtml } from '/ui.js';

const MAX_PLAYERS_LIMIT = 10;
const DEFAULT_MAX_PLAYERS = 6;
const DEFAULT_BIG_BLIND = 50;
const DEFAULT_STARTING_CHIPS = 2000;
const DEFAULT_NICKNAME = '訪客';

export function initLobby(els, sendMsg) {
  function renderCatalogSelect(catalog) {
    if (els.createGametype.dataset.filled) return;
    els.createGametype.innerHTML = catalog
      .map((g) => `<option value="${g.gameType}">${g.name}</option>`)
      .join('');
    els.createGametype.dataset.filled = '1';
  }

  function renderRoomGrid(catalog, rooms) {
    const gameName = (gameType) => catalog.find((g) => g.gameType === gameType)?.name || gameType;
    els.roomGrid.innerHTML = '';
    els.emptyHint.hidden = rooms.length > 0;
    for (const r of rooms) {
      const card = document.createElement('div');
      card.className = 'room-card';
      const full = r.players >= r.maxPlayers;
      card.innerHTML = `
        <div class="room-title">${escapeHtml(r.name)}</div>
        <div class="room-meta">
          <span class="badge">${gameName(r.gameType)}</span>
          <span class="badge ${full ? 'full' : ''}">👤 ${r.players}/${r.maxPlayers} 人</span>
          <span class="badge">👀 ${r.spectators} 旁觀</span>
          ${r.started ? '<span class="badge">🎲 進行中</span>' : ''}
        </div>
        <div class="actions">
          <button data-join="${r.id}" ${full || r.started ? 'disabled' : ''}>加入遊戲</button>
          <button class="secondary" data-spectate="${r.id}">旁觀</button>
        </div>
      `;
      els.roomGrid.appendChild(card);
    }
  }

  els.roomGrid.addEventListener('click', (ev) => {
    const joinId = ev.target.getAttribute('data-join');
    const spectateId = ev.target.getAttribute('data-spectate');
    if (joinId) sendMsg({ type: 'join_room', roomId: joinId, as: 'player' });
    if (spectateId) sendMsg({ type: 'join_room', roomId: spectateId, as: 'spectator' });
  });

  // ---------- 開房 modal ----------

  els.createBtn.addEventListener('click', () => { els.createModal.hidden = false; });
  for (const input of [els.createMaxplayers, els.createBigblind, els.createStartchips]) {
    input.addEventListener('keydown', (ev) => {
      if (['e', 'E', '.', '+', '-'].includes(ev.key)) ev.preventDefault();
    });
    input.addEventListener('change', () => {
      const v = parseInt(input.value, 10);
      if (isNaN(v)) { input.value = input.defaultValue; return; }
      const min = Number(input.min), max = Number(input.max);
      input.value = Math.max(min, Math.min(max, v));
    });
  }
  els.createMaxplayers.addEventListener('input', () => {
    const v = parseInt(els.createMaxplayers.value, 10);
    if (!isNaN(v) && v > MAX_PLAYERS_LIMIT) els.createMaxplayers.value = MAX_PLAYERS_LIMIT;
  });
  els.createCancelBtn.addEventListener('click', () => { els.createModal.hidden = true; });
  els.createConfirmBtn.addEventListener('click', () => {
    sendMsg({
      type: 'create_room',
      gameType: els.createGametype.value,
      name: els.createRoomname.value,
      maxPlayers: Number(els.createMaxplayers.value) || DEFAULT_MAX_PLAYERS,
      bigBlind: Number(els.createBigblind.value) || DEFAULT_BIG_BLIND,
      startingChips: Number(els.createStartchips.value) || DEFAULT_STARTING_CHIPS,
      allowRebuy: els.createRebuy.checked,
    });
    els.createModal.hidden = true;
    els.createRoomname.value = '';
  });

  // ---------- 暱稱 ----------

  els.nicknameInput.value = localStorage.getItem('og_nickname') || '';
  els.nicknameInput.addEventListener('change', () => {
    const nick = els.nicknameInput.value.trim() || DEFAULT_NICKNAME;
    localStorage.setItem('og_nickname', nick);
    sendMsg({ type: 'set_nickname', nickname: nick });
  });

  // 首次訪客強制註冊暱稱
  const nicknameModal = document.getElementById('nickname-modal');
  const nicknameModalInput = document.getElementById('nickname-modal-input');
  const nicknameModalConfirm = document.getElementById('nickname-modal-confirm');

  nicknameModal.hidden = !!localStorage.getItem('og_nickname');

  nicknameModalInput.addEventListener('input', () => {
    nicknameModalConfirm.disabled = !nicknameModalInput.value.trim();
  });
  function confirmNicknameModal() {
    const nick = nicknameModalInput.value.trim();
    if (!nick) return;
    localStorage.setItem('og_nickname', nick);
    els.nicknameInput.value = nick;
    sendMsg({ type: 'set_nickname', nickname: nick });
    nicknameModal.hidden = true;
  }
  nicknameModalConfirm.addEventListener('click', confirmNicknameModal);
  nicknameModalInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') confirmNicknameModal(); });

  return {
    renderRoomList(catalog, rooms) {
      renderCatalogSelect(catalog);
      renderRoomGrid(catalog, rooms);
    },
  };
}
