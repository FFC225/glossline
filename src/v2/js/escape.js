/**
 * 全前端唯一的跳脫出口。
 *
 * 舊前端有三套互不共用的實作（ui.js:595 走 DOM textContent、app.js:1221 手刻但不轉引號、
 * app.js:1217 手刻但不轉 &），跳脫漏洞的根因就是「事後逐處補」。這裡只留一份，
 * 任何要把字串放進 innerHTML 的地方一律經過這裡，不准再手刻。
 */

const HTML_ENTITIES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** 把任意值轉成可安全放進 HTML 的字串。null / undefined 一律變空字串。 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ENTITIES[ch]);
}

/**
 * 樣板字面值版本：html`<div>${userText}</div>`
 * 插值一律跳脫，樣板本體（我們自己寫的那部分）原樣保留。
 */
export function html(strings, ...values) {
  let out = '';
  for (let i = 0; i < strings.length; i += 1) {
    out += strings[i];
    if (i < values.length) out += escapeHtml(values[i]);
  }
  return out;
}

/** 純文字寫入，連跳脫都不必——能用這個就別用 innerHTML。 */
export function setText(el, value) {
  if (!el) return;
  el.textContent = value === null || value === undefined ? '' : String(value);
}
