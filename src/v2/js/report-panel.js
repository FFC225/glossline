/**
 * 收工報告。
 *
 * 這張單子存在的理由只有一句：**一場錄空了的會議，和一場錄得很好的會議，
 * 在畫面上、在檔案總管裡長得一模一樣**——檔案在、秒數對、大小正常，
 * 裡面全是程式為了對齊時間補進去的靜音（錄音時補靜音反過來把失敗藏起來了）。
 * 唯一分得出來的是後端數的封包，所以那個數字一定要走到人的眼睛裡。
 *
 * 兩件刻意的事：
 *   1. **判決的文字由後端給**（`TrackReport.verdict`）。同一句話不寫兩份：
 *      後端已經為了紀錄檔算過一次，前端再寫一份遲早會有一邊改到、另一邊沒改。
 *   2. **整支零 innerHTML**，只用 createElement + textContent。
 *      `escape.js` 的 html`` 也安全，但零 innerHTML 是新前端
 *      的既有性質，為了一張報告框把它打開不划算。
 *   3. **這裡不 import `modal.js`**：那支在載入當下就 `document.addEventListener`，
 *      一 import 就沒辦法在 node 底下測這支的純函式。開關彈窗留給 `main.js`。
 */

const MB = 1048576;

function seconds(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 報告 → 畫面要呈現的形狀。**純函式、沒有 DOM**，所以 node 直接跑得動。
 *
 * 回傳 `{ warn, recordingOff, folder, blindSpot, rows }`，
 * `rows` 一軌一筆：`{ track, label, headline, detail, verdict, bad }`。
 */
export function renderReportModel(report) {
  const tracks = (report && report.tracks) || [];
  if (!tracks.length) {
    // ⚠ 只有在後端真的一軌都沒回時才可以講這句。舊版前端判的是「陣列長度」，
    //   後端改成回一個物件之後每一場都會掉進來，於是每場都印一句
    //   看起來很正常、而且完全錯誤的警告。
    return {
      warn: '沒有收到收工報告。錄音檔可能還在、也可能沒有——請直接開資料夾確認。',
      micFailed: (report && report.micFailed) || null,
      recordingOff: false,
      folder: (report && report.sessionDir) || null,
      blindSpot: (report && report.blindSpot) || null,
      rows: [],
    };
  }

  const rows = tracks.map((t) => {
    const bad = Boolean(t.noAudio || t.diedMidway);
    // 摘要沒回來的那一軌不准顯示 0 秒：「還沒收完」跟「沒錄到」是兩件事，
    // 而 0 秒會把前者講成後者。後端在這種情況給的是 note。
    const headline = t.note
      ? t.note
      : Math.round(seconds(t.seconds)) +
        ' 秒　' +
        (Number(t.bytes || 0) / MB).toFixed(1) +
        // 這是開會中那份 wav 的大小；正常停止後 wav 換成約 1/24 大的 mp3。
        ' MB（未壓縮）';
    const detail = [];
    if (!t.note) {
      detail.push(
        '補靜音 ' + seconds(t.paddedSeconds).toFixed(1) + ' 秒（' + (t.padEvents || 0) + ' 次）'
      );
    }
    detail.push('收到 ' + (t.packets || 0) + ' 包聲音');
    // 「最後一包距今多久」是拔麥克風唯一抓得到的地方（封包數看不到中途死掉），
    // 所以不管好壞都印出來——好的時候它就是零點幾秒，一眼看得出是正常收工。
    detail.push('最後一包在按停止前 ' + seconds(t.silentTailSeconds).toFixed(1) + ' 秒');
    if (Array.isArray(t.parts) && t.parts.length > 1) {
      detail.push('檔案太長，切成 ' + t.parts.length + ' 份');
    }
    return {
      track: t.track,
      label: t.label || t.track,
      headline,
      detail: detail.join('｜'),
      verdict: t.verdict || null,
      // 判決的「為什麼」。後端把結論與原因拆成兩段送過來
      // （使用者的原話：「太長沒人看得完」）。⚠ 舊的收工報告只有 verdict 一格，
      // 所以這裡必須容得下 undefined——那不是錯，是沒有原因可攤開。
      verdictDetail: t.verdictDetail || null,
      bad,
    };
  });

  return {
    warn: null,
    // 「我只想抓喇叭」與「我要兩路、麥克風沒開起來」會產出一模一樣的
    // 一軌報告——差別只有後者少了半場會議。這一格就是那個差別。
    micFailed: report.micFailed || null,
    recordingOff: Boolean(report.recordingOff),
    folder: report.sessionDir || null,
    blindSpot: report.blindSpot || null,
    rows,
  };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/**
 * 把報告畫進 `#report-modal` 的內容區。**只畫，不開窗**——開窗是 `main.js` 的事
 * （見檔頭第 3 點）。
 *
 * @param {HTMLElement} root `#report-modal`。
 * @param {object} report `stop_capture` 回來的東西。
 * @returns {object|null} 畫成功時回那份 model（`main.js` 拿 `folder` 給「開啟資料夾」
 *   那顆鍵用——資料夾是誰、只有一個地方說了算），畫不出來回 `null`。
 */
export function renderReport(root, report) {
  if (!root) return null;
  const model = renderReportModel(report);
  const body = root.querySelector('#report-body');
  if (!body) return null;

  while (body.firstChild) body.removeChild(body.firstChild);

  if (model.warn) body.appendChild(el('p', 'report-verdict', model.warn));
  if (model.recordingOff) {
    body.appendChild(el('p', 'report-verdict', '⚠ 這場沒有留下錄音檔（沒有設定錄音資料夾）。'));
  }
  if (model.micFailed) body.appendChild(el('p', 'report-verdict', model.micFailed));
  if (model.folder) {
    const folder = el('p', 'report-folder');
    folder.appendChild(el('span', null, '資料夾：'));
    folder.appendChild(el('code', null, model.folder));
    body.appendChild(folder);
  }

  model.rows.forEach((row) => {
    const card = el('div', 'report-track' + (row.bad ? ' is-bad' : ''));
    card.appendChild(el('h3', null, row.label));
    card.appendChild(el('p', 'report-headline', row.headline));
    card.appendChild(el('p', 'report-detail', row.detail));
    if (row.verdict) {
      card.appendChild(el('p', 'report-verdict', row.verdict));
      // 原因收在摺疊裡：預設只看得到一句結論，想知道為什麼才展開。
      // ⚠ 用 <details>，不是自己接一顆按鈕——鍵盤與讀螢幕軟體都直接吃它，
      //   而且它關起來的時候文字仍然在 DOM 裡（Ctrl+F 找得到）。
      if (row.verdictDetail) {
        const more = document.createElement('details');
        more.className = 'report-why';
        more.appendChild(el('summary', null, '為什麼？'));
        more.appendChild(el('p', null, row.verdictDetail));
        card.appendChild(more);
      }
    }
    body.appendChild(card);
  });

  if (model.blindSpot) body.appendChild(el('p', 'report-blindspot', model.blindSpot));

  return model;
}
