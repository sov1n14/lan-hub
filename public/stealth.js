// 偷玩模式：F9 手動切換假文件

export function initStealth(els) {
  let fromLobby = false;

  function showDecoy() {
    els.stealthDecoy.hidden = false;
    els.roomReal.hidden = true;
  }

  function showGame() {
    if (fromLobby) {
      fromLobby = false;
      els.roomView.hidden = true;
      els.lobbyView.hidden = false;
    } else {
      els.stealthDecoy.hidden = true;
      els.roomReal.hidden = false;
    }
  }

  function toggleStealth() {
    if (els.roomView.hidden) {
      fromLobby = true;
      els.lobbyView.hidden = true;
      els.roomView.hidden = false;
      showDecoy();
    } else if (els.stealthDecoy.hidden) {
      showDecoy();
    } else {
      showGame();
    }
  }

  els.stealthDecoy.addEventListener('click', showGame);

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'F9') return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    ev.preventDefault();
    toggleStealth();
  });

  // 用 canvas 畫一個「文件」favicon；輪到你時疊一個小紅點，看起來像未讀通知
  const faviconLink = (() => {
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    return link;
  })();

  function drawFavicon(withDot) {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.font = '52px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('📄', 32, 34);
    if (withDot) {
      ctx.beginPath();
      ctx.arc(50, 14, 10, 0, Math.PI * 2);
      ctx.fillStyle = '#e2574c';
      ctx.fill();
    }
    return canvas.toDataURL('image/png');
  }

  function setFavicon(withDot) {
    faviconLink.href = drawFavicon(withDot);
  }

  function notifyTurn(isYourTurn) {
    setFavicon(isYourTurn);
    els.decoyBadge.hidden = !isYourTurn;
    if (isYourTurn) els.decoyBadge.textContent = '3 則留言';
  }

  function resetStealth() {
    fromLobby = false;
    showGame();
    setFavicon(false);
    els.decoyBadge.hidden = true;
  }

  setFavicon(false);

  return { notifyTurn, resetStealth };
}
