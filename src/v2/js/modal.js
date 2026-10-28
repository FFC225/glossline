/**
 * 所有彈窗的共同殼。
 *
 * 舊版 #setup-modal 是全視窗遮罩、既沒有 Esc 也不能點外面關，
 * 只靠 Rust channel 事件收起——channel 一卡住就沒有退路，畫面等於鎖死。
 * 所以這裡把「Esc ＋ 點外面」做成開啟彈窗的唯一途徑，不給手刻的機會。
 */

const openStack = [];

function onKeydown(ev) {
  if (ev.key !== 'Escape') return;
  const top = openStack[openStack.length - 1];
  if (top) {
    ev.preventDefault();
    closeModal(top.el);
  }
}

document.addEventListener('keydown', onKeydown);

/** 開啟彈窗；回傳一個關閉它的函式。 */
export function openModal(el, { onClose } = {}) {
  if (!el || openStack.some((m) => m.el === el)) return () => {};

  const onBackdrop = (ev) => {
    // 只有點在遮罩本身（不是內容卡片）才關
    if (ev.target === el) closeModal(el);
  };
  el.addEventListener('mousedown', onBackdrop);

  el.hidden = false;
  el.classList.add('is-open');
  openStack.push({ el, onBackdrop, onClose });

  const focusable = el.querySelector('input, select, textarea, button');
  if (focusable) focusable.focus();

  return () => closeModal(el);
}

export function closeModal(el) {
  const idx = openStack.findIndex((m) => m.el === el);
  if (idx === -1) return;
  const [entry] = openStack.splice(idx, 1);
  el.removeEventListener('mousedown', entry.onBackdrop);
  el.classList.remove('is-open');
  el.hidden = true;
  if (typeof entry.onClose === 'function') entry.onClose();
}

/** 測試用：目前開著幾個彈窗。 */
export function openModalCount() {
  return openStack.length;
}
