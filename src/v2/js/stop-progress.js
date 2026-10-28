/**
 * 按下停止之後那幾秒，畫面要看得出來它還在動。
 *
 * 由來：實際使用時，按停止後的第一句反應是
 * 「會一段時間關閉，我希望要有進度條，我才知道沒有卡。」
 * 原本那幾秒畫面上只有「收尾中…」三個字，而收尾實際上有四步、
 * 其中兩步（收兩條 WebSocket、寫錄音夾副本）都可能拖到好幾秒。
 *
 * ⚠ **刻意不報百分比。** 四步各花多久還沒量到（`[收尾計時]` 那行要等實錄），
 *   憑印象分四等分就會做出「跑到 90% 卡住」的東西——那正是這裡要治的病。
 *   四格只說「現在在第幾步」，文案也不准寫成百分比。
 *
 * ⚠ **秒數是「這一步」的秒數，不是總計。** 卡住是卡在某一步上；總秒數一路
 *   往上跳，反而看不出來是哪一步不動。
 *
 * ⚠ **「正在跑的那一格會動」是這整塊唯一真正的訊息。** 靜止的填色沒辦法分辨
 *   「還在跑」跟「卡死了」，而那就是使用者按下停止之後想知道的唯一一件事。
 *   動畫在 `main.css` 的 `.stop-progress-bar span.is-live`；關掉動態效果的人
 *   由秒數承擔（它每 250 毫秒自己跳一次），所以秒數也不可以省。
 */

/** 四步的名字。順序**必須**跟 `capture.js` 的 `stop()` 一致，那邊改了這邊要跟。
 *
 * ⚠ 第二步那句「通常要十秒左右」是**實測寫死的**（見下方數字），不是估的。
 *   講出來的理由：那十秒裡畫面沒有任何別的事發生，不先講一聲，
 *   會動的格子只證明「程式還活著」、不能回答「這樣正常嗎」。 */
export const STOP_STEP_NAMES = [
  '收音訊、補檔頭',
  '收字幕串流（通常要十秒左右）',
  '存進記錄庫',
  '寫錄音夾副本',
];

/**
 * 一步超過幾毫秒就多講一句「這步比平常久」。
 *
 * 📏 **15 秒是實測訂的，不是猜的**：
 *   ①323ms ②**9268ms** ③13ms ④3ms，總計 9607ms。
 *   而那場只錄了十幾秒——**第二步幾乎是固定成本**（關兩條 Soniox 連線要等伺服器
 *   把最後一段吐完），跟會議多長沒什麼關係。
 *
 * ⚠ 第一版寫 8 秒，那會讓「這步比平常久」**每一場都跳**——
 *   一個每次都出現的警示等於沒有警示，而且會把真的出事那次一起淹掉。
 * 📌 判準：**門檻要訂在「正常值之上」，而正常值只能量、不能想。**
 */
export const SLOW_AFTER_MS = 15000;

/** 畫面重繪的間隔：慢到不吃效能，快到讓秒數看起來是活的。 */
export const TICK_MS = 250;

/**
 * @param {{box: object, bar: object, text: object, slow: object}} els 四個 DOM 節點
 * @param {object} [opts] 測試用的注入點（真實執行時全部留空）
 * @returns {{render: (step: number|null) => void}}
 */
export function createStopProgress(els, opts = {}) {
  // `performance.now()`：`Date.now()` 會被系統校時往回撥，開會中途剛好校時
  // 一次就會出現負的秒數（同 `capture.js` 計時那段的理由）。
  const now = opts.now || (() => performance.now());
  const startTimer = opts.setInterval || ((fn, ms) => setInterval(fn, ms));
  const stopTimer = opts.clearInterval || ((id) => clearInterval(id));
  const slowAfterMs = opts.slowAfterMs === undefined ? SLOW_AFTER_MS : opts.slowAfterMs;

  let step = 0;
  let stepAt = 0;
  let timer = null;

  function paint() {
    if (!step || !els.text) return;
    const elapsed = now() - stepAt;
    els.text.textContent =
      '收尾中… 第 ' + step + ' 步／共 ' + STOP_STEP_NAMES.length + ' 步 · ' +
      (STOP_STEP_NAMES[step - 1] || '') +
      ' · 已經 ' + Math.floor(elapsed / 1000) + ' 秒';
    if (els.slow) els.slow.hidden = elapsed < slowAfterMs;
  }

  /**
   * @param {number|null} next 1..4；傳 null 代表收尾結束（成功或失敗**都要**傳）。
   */
  function render(next) {
    if (!els.box || !els.bar) return;

    if (!next) {
      if (timer !== null) {
        stopTimer(timer);
        timer = null;
      }
      step = 0;
      els.box.hidden = true;
      if (els.slow) els.slow.hidden = true;
      // 格子一起清乾淨：留著 is-live 的話，下一場開起來會有一格在那裡自己閃。
      const cells = els.bar.children;
      for (let i = 0; i < cells.length; i += 1) {
        cells[i].classList.toggle('is-done', false);
        cells[i].classList.toggle('is-live', false);
      }
      return;
    }

    step = next;
    stepAt = now();
    els.box.hidden = false;
    if (els.slow) els.slow.hidden = true; // 換步就重新計，慢的是「這一步」

    // 前面的填實、現在這一格會動、後面的留白。
    const cells = els.bar.children;
    for (let i = 0; i < cells.length; i += 1) {
      cells[i].classList.toggle('is-done', i < step - 1);
      cells[i].classList.toggle('is-live', i === step - 1);
    }

    paint();
    if (timer === null) timer = startTimer(paint, TICK_MS);
  }

  return { render };
}
