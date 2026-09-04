const TOAST_DURATION = 3200;

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const toastContainer = document.getElementById('toast-container');
export function showToast(message, { error = false } = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' error' : '');
  el.textContent = message;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), TOAST_DURATION);
}

// 追蹤輸入框是否在 IME 組字中。Safari 會先送 compositionend 再送確認組字的 Enter keydown，所以結束後延到下一個 tick 才解除。
export function trackComposition(input) {
  let composing = false;
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { setTimeout(() => { composing = false; }, 0); });
  return () => composing;
}
