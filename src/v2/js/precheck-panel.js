/**
 * 開始前的自我檢查，畫在螢幕上的那一半。
 *
 * 判斷全部在 Rust 那邊（`commands/precheck.rs`），這裡只決定兩件事：
 * **要不要打擾人**，以及**要給他哪幾顆按鈕**。
 *
 * 三條刻意的規矩：
 *
 * 1. **全綠什麼都不彈。** 一個每次按開始都要再按一次「確定」的框，兩個星期內
 *    就會變成沒有人讀的東西——到那時候它連真的有問題那一次也擋不住了。
 *    全綠時體檢結果只留在紀錄檔，那是刻意的。
 * 2. **`fail` 與 `warn` 給的按鈕不一樣。** 黃的只是「知道了，照開」；
 *    紅的「資料夾寫不進去」要給兩條真的走得通的路——換一個資料夾，
 *    或明講這場不錄。只給一顆「確定」等於把問題丟回去給人自己想。
 * 3. **整支零 `innerHTML`**，只用 createElement + textContent。理由同
 *    `report-panel.js`：新前端的既有性質就是「零 innerHTML」，為了一張框把它打開不划算。
 *
 * ⚠ 「這場不錄」一定要走明確旗標、不可以送空字串的資料夾：後端在資料夾是空的
 *   時候會**退回去讀設定值**（`audio.rs` 的 fallback），於是送空字串＝照錄，
 *   而且畫面上不會有任何跡象。
 */

/** 三種等級的輕重，數字大的贏。 */
const RANK = { ok: 0, warn: 1, fail: 2 };

/**
 * 體檢清單 → 這個框該長什麼樣。**純函式、沒有 DOM**，所以 node 直接跑得動。
 *
 * @param {Array<{key:string,label:string,level:string,detail:string}>} items
 * @returns {{level:string, needsAsking:boolean, canRetarget:boolean, rows:Array, headline:string}}
 */
export function renderPrecheckModel(items) {
  const rows = (Array.isArray(items) ? items : []).map((i) => ({
    key: String(i.key || ''),
    label: String(i.label || i.key || ''),
    level: RANK[i.level] === undefined ? 'warn' : String(i.level),
    detail: String(i.detail || ''),
  }));

  // ⚠ 清單是空的時候**不可以**當成全綠：那代表體檢根本沒跑成功，
  //   而「沒跑」與「全過」在畫面上長得一模一樣——正是這張網要防的那種病。
  if (!rows.length) {
    return {
      level: 'warn',
      needsAsking: true,
      canRetarget: false,
      needsConsent: false,
      rows: [],
      headline: '體檢沒有跑出結果。這不代表沒問題，只代表沒有檢查——要開就是在賭。',
    };
  }

  let level = 'ok';
  rows.forEach((r) => {
    if (RANK[r.level] > RANK[level]) level = r.level;
  });

  // 只有「資料夾寫不進去」那一項紅的時候，換資料夾才是真的能解決問題的路。
  // 沒有播放裝置時換資料夾一點用都沒有，所以那顆鍵不出現——一顆按了不會有幫助的
  // 按鈕，會教人以後不看這個框。
  const canRetarget = rows.some((r) => r.key === 'writable' && r.level === 'fail');

  // 這台機器還沒看過錄音告知。只會出現一次（看過之後後端就不再送這一項）。
  // ⚠ 這一項**完全不擋人**，純粹是決定那行字要不要顯示。
  // ⚠ 判斷用「這一項在不在」，不看等級：等級是給框裡那行字上色用的，
  //   哪天它從 warn 調成別的，這裡不該跟著壞掉。
  const needsConsent = rows.some((r) => r.key === 'consent');

  const headline = level === 'fail'
    ? '這台機器現在的狀態會讓這場白錄。'
    : '有幾件事先講一聲，你可以照樣開始。';

  return {
    level,
    needsAsking: level !== 'ok',
    canRetarget,
    needsConsent,
    rows,
    headline,
  };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/**
 * 把體檢結果畫進 `#precheck-modal` 的內容區。**只畫，不開窗**——開窗是 `main.js`
 * 的事（同 `report-panel.js` 的分工）。
 *
 * @returns {object|null} 畫成功時回那份 model，畫不出來回 `null`。
 */
export function renderPrecheck(root, items) {
  if (!root) return null;
  const model = renderPrecheckModel(items);
  const body = root.querySelector('#precheck-body');
  if (!body) return null;

  while (body.firstChild) body.removeChild(body.firstChild);
  body.appendChild(el('p', 'precheck-headline', model.headline));

  model.rows.forEach((row) => {
    // 全部列出來、不只列有問題的那幾項：人要看得到「其他幾項是好的」，
    // 才知道這個框是在講一件具體的事，不是在亂叫。
    const line = el('div', 'precheck-row is-' + row.level);
    const mark = row.level === 'fail' ? '✕' : row.level === 'warn' ? '!' : '✓';
    line.appendChild(el('span', 'precheck-mark', mark));
    const text = el('div', 'precheck-text');
    text.appendChild(el('p', 'precheck-label', row.label));
    if (row.detail) text.appendChild(el('p', 'precheck-detail', row.detail));
    line.appendChild(text);
    body.appendChild(line);
  });

  return model;
}
