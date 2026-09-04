// 聊天室側欄：大廳與房間共用，切換視圖時向伺服器重新索取該範圍的歷史訊息。
import { escapeHtml } from '/ui.js';

const CHAT_MAX_LENGTH = 200;
const MAX_LINES = 200;
const MIN_WIDTH = 200;
const MAX_WIDTH = 640;

export function initChat(els, sendMsg) {
  const nicknameMap = new Map();
  let messages = [];

  function submit() {
    const text = els.chatInput.value.trim().slice(0, CHAT_MAX_LENGTH);
    if (!text) return;
    sendMsg({ type: 'chat', text });
    els.chatInput.value = '';
  }
  els.chatSendBtn.addEventListener('click', submit);
  els.chatInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit(); });

  function lineHTML(msg) {
    const time = new Date(msg.ts).toLocaleTimeString('zh-Hant', { hour: '2-digit', minute: '2-digit' });
    if (msg.system) {
      const who = msg.fromId ? (nicknameMap.get(msg.fromId) ?? msg.fromNickname ?? '') : '';
      const prefix = who ? `${escapeHtml(who)} ` : '';
      return `<div class="chat-line system"><span class="chat-time">${time}</span> ${prefix}${escapeHtml(msg.text)}</div>`;
    }
    const name = (msg.fromId && nicknameMap.get(msg.fromId)) || msg.from;
    const mine = msg.fromId === localStorage.getItem('og_clientId');
    return `<div class="chat-line${mine ? ' mine' : ''}"><span class="chat-time">${time}</span> <b>${escapeHtml(name)}</b>：${escapeHtml(msg.text)}</div>`;
  }
  function rerender() {
    els.chatLog.innerHTML = messages.map(lineHTML).join('');
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
  }
  function scrollToBottom() { els.chatLog.scrollTop = els.chatLog.scrollHeight; }

  // 拖曳左緣調整寬度，寬度存在 #app 的 --chat-w 並記住
  const app = document.getElementById('app');
  const savedWidth = localStorage.getItem('og_chatWidth');
  if (savedWidth) app.style.setProperty('--chat-w', `${savedWidth}px`);
  els.chatResizer.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    els.chatResizer.setPointerCapture(ev.pointerId);
    const onMove = (e) => {
      const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - e.clientX));
      app.style.setProperty('--chat-w', `${width}px`);
      localStorage.setItem('og_chatWidth', width);
    };
    const stop = () => {
      els.chatResizer.removeEventListener('pointermove', onMove);
      els.chatResizer.removeEventListener('pointerup', stop);
    };
    els.chatResizer.addEventListener('pointermove', onMove);
    els.chatResizer.addEventListener('pointerup', stop);
  });

  return {
    append(msg) {
      messages.push(msg);
      if (messages.length > MAX_LINES) messages.shift();
      els.chatLog.insertAdjacentHTML('beforeend', lineHTML(msg));
      while (els.chatLog.childElementCount > MAX_LINES) els.chatLog.firstElementChild.remove();
      scrollToBottom();
    },
    setHistory(msgs) {
      messages = [...msgs];
      rerender();
    },
    updateNicknames(entries) {
      let changed = false;
      for (const { id, nickname } of entries) {
        if (nicknameMap.get(id) !== nickname) { nicknameMap.set(id, nickname); changed = true; }
      }
      if (changed) rerender();
    },
    requestHistory() { sendMsg({ type: 'chat_history' }); },
    setScope(roomName) {
      nicknameMap.clear();
      messages = [];
      els.chatTitle.textContent = `💬 ${roomName ? `${roomName} 聊天室` : '大廳聊天室'}`;
    },
  };
}
