/**
 * 匯出檔的預設檔名。
 *
 * 單獨一支、而且是純函式，理由有兩個：
 *   ① `library.js` 匯入 `modal.js`，那支在載入時就 `document.addEventListener`，
 *      在 node 裡跑不起來——測試要進得去，這段就不能住在 library.js 裡。
 *   ② 這裡每一條規則都對應一種「不會噴錯、只會安靜失敗」的情況（見下）。
 *
 * 標題不是我們取的，是**這場會議的第一句話**（session-store.js 拿第一段當標題）。
 * 所以它什麼都可能有：冒號、斜線、引號、換行，或者長達兩百字。
 */

/** Windows 檔名不能有的字元。Linux/mac 只忌諱 `/`，但取交集才不會換平台就壞。 */
const ILLEGAL = /[<>:"/\\|?*\x00-\x1f]/g;

/**
 * Windows 保留字：這些名字（含加副檔名）在任何資料夾都建不出來，
 * 而且失敗訊息是「檔名無效」，看不出是撞到 1970 年代的裝置名。
 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** 留給日期前綴與副檔名之後，主檔名的上限。Windows 全路徑上限 260。 */
const MAX_STEM = 60;

/**
 * @param {string} title 會議標題（通常是第一句話）。
 * @param {string} id 這場的 id，標題整個沒得用時的退路。
 * @param {string} ext 副檔名，不含點。
 * @returns {string} 可以直接餵給存檔對話框的檔名。
 */
export function exportFileName(title, id, ext) {
  const safeExt = String(ext || 'txt').replace(ILLEGAL, '').toLowerCase() || 'txt';

  let stem = String(title == null ? '' : title)
    .replace(ILLEGAL, ' ')
    // 換行與 tab 在檔名裡是合法的，但貼進終端機／檔案總管會變成兩行，看起來像檔壞了
    .replace(/\s+/g, ' ')
    .trim()
    // 結尾的點與空白會被 Windows 靜默吃掉，於是「同一個檔名」存兩次會互相覆蓋
    .replace(/[. ]+$/, '');

  if (stem.length > MAX_STEM) stem = stem.slice(0, MAX_STEM).replace(/[. ]+$/, '');
  if (!stem || RESERVED.test(stem)) stem = String(id || 'session');
  // id 本身也可能是空的（理論上不會，但這裡是最後一道）
  if (!stem) stem = 'session';

  return stem + '.' + safeExt;
}
