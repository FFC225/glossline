/**
 * 會中「⭐ 標記重點」。
 *
 * 按下去**只記時間**，不存當下那句字幕：那時它常常還沒定稿（Soniox 未定稿的字
 * 會整批被換掉，`soniox-segmenter.js`），存了會跟 `逐字稿.md` 對不上。
 * 字句在停止時才從已定稿的段落補上——取按下前後各 NEAR_MS 內最近的一句，
 * 因為人常在「剛聽完」或「正在聽」的時候按，猜哪一邊都會猜錯一半。
 *
 * ⚠ 輸出格式有兩條不能碰的限制：
 *   - 不可以有 `[時:分:秒] 【麥克風/電腦聲音】` 那種行：會後的
 *     外部的會後處理腳本看格式認即時稿，
 *     找到兩份就整場報錯。所以時間不加方括號、來源不加【】。
 *   - 只寫進錄音資料夾，不進記錄庫（記錄庫會把任何 .md 當成一場舊會議）。
 *
 * 純邏輯、不碰畫面與 Tauri，`tools/test_marks.mjs` 測。
 */

/** 按下前後多久內的句子算「這個標記指的那句」。 */
export const NEAR_MS = 15000;

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 牆上時鐘 時:分:秒，跟 `逐字稿.md` 每行開頭的時間同一套。 */
export function wallClock(ms) {
  const d = new Date(ms);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

/** 一句變成一行。⚠ 來源寫成「麥克風」「電腦聲音」但不加【】，理由見檔頭。 */
function rowLine(row, sourceLabel) {
  const who = sourceLabel[row.who] || '未知來源';
  const tgt = row.tgt === null || row.tgt === undefined ? '' : '　→ ' + row.tgt;
  return '  - ' + row.ts + '｜' + who + '｜' + row.src + tgt;
}

/**
 * @param {number[]} markMs 每次按下的時刻（Date.now()）。
 * @param {object[]} rows   記錄庫的逐句（session-store.js 的 segmentToRow 形狀，要有 t_ms／ts／src／tgt／who）。
 * @param {object} ctx
 * @param {number} ctx.sessionStartMs 這場開始的時刻，rows 的 t_ms 從這裡起算。
 * @param {object} ctx.sourceLabel    session-store.js 的 SOURCE_LABEL。
 * @returns {string} 沒有標記時回空字串（呼叫端據此不寫檔）。
 */
export function marksToMarkdown(markMs, rows, { sessionStartMs, sourceLabel }) {
  if (!markMs.length) return '';
  const nl = String.fromCharCode(10);
  const lines = [
    '# 重點標記',
    '',
    '> 開會時按「⭐ 標記重點」的時間點，共 ' + markMs.length + ' 個。' +
      '時間是牆上時鐘，對得上同資料夾 `逐字稿.md` 每行開頭的時間；' +
      '底下列的是按下前後最近的定稿句子，指的是哪一句請回逐字稿看上下文。',
    '',
  ];
  for (const m of markMs) {
    lines.push('- ⭐ ' + wallClock(m));
    let before = null;
    let after = null;
    for (const r of rows) {
      const at = sessionStartMs + (r.t_ms || 0);
      if (at <= m && m - at <= NEAR_MS) before = r; // 留最後一句
      if (at > m && at - m <= NEAR_MS && !after) after = r;
    }
    if (!before && !after) {
      lines.push('  - （前後 ' + NEAR_MS / 1000 + ' 秒內沒有字幕）');
    }
    if (before) lines.push(rowLine(before, sourceLabel));
    if (after) lines.push(rowLine(after, sourceLabel));
  }
  lines.push('');
  return lines.join(nl);
}
