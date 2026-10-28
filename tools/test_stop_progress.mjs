/**
 * 收尾進度條 ＋ 強調標記出口。
 *
 * 這支釘的是三類「畫面看起來沒事」的壞法：
 *   ① 強調標記被照字面印出來 —— 實際使用的截圖裡就是這樣，
 *      紅字寫著 `**錄音沒有停**`。程式沒壞、沒有任何錯誤訊息，只是難看又難懂。
 *   ② 進度條停在半路 —— 收尾中途拋例外時如果沒有收掉進度，畫面會一直停在
 *      「第 3 步」等一個不會到來的結束。那是「靜默降級」的視覺版。
 *   ③ 正在跑的那一格不會動 —— 靜止的填色分不出「還在跑」跟「卡死了」，
 *      而那正是使用者按下停止之後唯一想知道的事。這裡釘 `is-live` 這個類別
 *      有沒有被掛上（動畫本身在 main.css，測不到，但沒有類別就一定不會動）。
 *
 * 跑法：
 *   & "C:\Program Files\nodejs\node.exe" app/tools/test_stop_progress.mjs
 */

import { appendWithEmphasis, plainText } from '../src/v2/js/ui-text.js';
import { createStopProgress, STOP_STEP_NAMES, SLOW_AFTER_MS } from '../src/v2/js/stop-progress.js';
import { MeetingCapture } from '../src/v2/js/capture.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  ← ' + detail : ''));
  if (!ok) failures += 1;
}

/* ── 一個剛好夠用的假 DOM ─────────────────────────────────────────────── */

function makeNode(childCount = 0) {
  const classes = new Set();
  const node = {
    hidden: false,
    textContent: '',
    children: [],
    classList: {
      toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
      contains: (name) => classes.has(name),
    },
    appendChild(child) { node.children.push(child); return child; },
  };
  node.ownerDocument = {
    createElement: (tag) => {
      const el = makeNode();
      el.tagName = tag.toUpperCase();
      return el;
    },
    createTextNode: (t) => ({ nodeType: 3, textContent: t, children: [] }),
  };
  for (let i = 0; i < childCount; i += 1) node.children.push(makeNode());
  return node;
}

/** 把塞進去的東西攤平成「人看到的那串字」。 */
function rendered(node) {
  if (node.nodeType === 3) return node.textContent;
  if (node.children.length === 0) return node.textContent || '';
  return node.children.map(rendered).join('');
}

/* ── ① 強調標記 ──────────────────────────────────────────────────────── */

console.log('=== 強調標記（ui-text.js）===');
{
  const p = makeNode();
  appendWithEmphasis(p, '⏸ 現在是休息中：**錄音沒有停**，但字幕停了。');
  const out = rendered(p);
  check('⭐ 畫面上一個星號都沒有', !out.includes('*'), out);
  check('句子本身完整', out === '⏸ 現在是休息中：錄音沒有停，但字幕停了。', out);
  const strongs = p.children.filter((c) => c.tagName === 'STRONG');
  check('⭐ 被夾住的那段真的變粗體', strongs.length === 1 && strongs[0].textContent === '錄音沒有停',
        JSON.stringify(strongs.map((s) => s.textContent)));
}
{
  const p = makeNode();
  appendWithEmphasis(p, '沒有標記的一句話');
  check('沒有標記時原樣輸出', rendered(p) === '沒有標記的一句話', rendered(p));
  check('沒有標記時不會產生粗體節點', p.children.every((c) => c.tagName !== 'STRONG'));
}
{
  const p = makeNode();
  appendWithEmphasis(p, 'a**b**c**d');
  check('星號數量是單數時也不吐星號', !rendered(p).includes('*'), rendered(p));
  check('單數星號時字仍然全在', rendered(p) === 'abcd', rendered(p));
}
{
  const p = makeNode();
  appendWithEmphasis(p, null);
  check('傳 null 不會爆', rendered(p) === '');
  check('沒有容器也不會爆', (() => { appendWithEmphasis(null, 'x'); return true; })());
}
check('plainText 與畫面看到的一致',
      plainText('**錄音沒有停**，但字幕停了。') === '錄音沒有停，但字幕停了。');

/* ── ② 進度條 ────────────────────────────────────────────────────────── */

console.log('=== 收尾進度（stop-progress.js）===');

/* 門檻本身要釘住。上面每一題都自己注入 slowAfterMs，所以**常數改成多少都不會
   被那些題目發現**——而這個常數訂錯的代價很具體：訂太低，「這步比平常久」
   每一場都跳，一個每次都出現的警示等於沒有警示。
   9268ms 是實測的第二步耗時。 */
check('⭐ 慢速門檻高於實測的正常值（9268ms），否則每場都會誤報',
      SLOW_AFTER_MS > 9268, SLOW_AFTER_MS + 'ms');

function makeProgress(slowAfterMs = 8000) {
  const els = { box: makeNode(), bar: makeNode(4), text: makeNode(), slow: makeNode() };
  let clock = 0;
  const timers = { started: 0, stopped: 0, fn: null };
  const p = createStopProgress(els, {
    now: () => clock,
    setInterval: (fn) => { timers.started += 1; timers.fn = fn; return 77; },
    clearInterval: () => { timers.stopped += 1; },
    slowAfterMs,
  });
  return {
    els, timers, p,
    advance(ms) { clock += ms; if (timers.fn) timers.fn(); },
  };
}

{
  const { els, p } = makeProgress();
  els.box.hidden = true;
  p.render(1);
  check('第 1 步：整塊顯示出來', els.box.hidden === false);
  check('⭐ 第 1 格會動（is-live）', els.bar.children[0].classList.contains('is-live'));
  check('第 1 格還不算完成', !els.bar.children[0].classList.contains('is-done'));
  check('後面三格都還空著',
        [1, 2, 3].every((i) => !els.bar.children[i].classList.contains('is-live')
                            && !els.bar.children[i].classList.contains('is-done')));
  check('文字說得出第幾步與步驟名',
        els.text.textContent.includes('第 1 步／共 4 步') && els.text.textContent.includes(STOP_STEP_NAMES[0]),
        els.text.textContent);
}
{
  const { els, p } = makeProgress();
  p.render(1);
  p.render(3);
  check('第 3 步：前兩格填實', els.bar.children[0].classList.contains('is-done')
                            && els.bar.children[1].classList.contains('is-done'));
  check('第 3 步：第 3 格才是會動的那格', els.bar.children[2].classList.contains('is-live')
                            && !els.bar.children[0].classList.contains('is-live'));
  check('第 3 步：第 4 格仍留白', !els.bar.children[3].classList.contains('is-done')
                            && !els.bar.children[3].classList.contains('is-live'));
}
{
  const { els, p, timers } = makeProgress();
  p.render(1);
  p.render(2);
  p.render(3);
  check('計時器只建一次（換步不重複建）', timers.started === 1, String(timers.started));
  p.render(null);
  check('⭐ 收掉時整塊隱藏', els.box.hidden === true);
  check('⭐ 收掉時計時器有停', timers.stopped === 1, String(timers.stopped));
  check('⭐ 收掉時格子清乾淨（不留一格自己閃）',
        els.bar.children.every((c) => !c.classList.contains('is-live')
                                   && !c.classList.contains('is-done')));
  check('收掉時「這步比較久」那行也收起來', els.slow.hidden === true);
}
{
  const t = makeProgress();
  t.p.render(2);
  const first = t.els.text.textContent;
  t.advance(3000);
  check('⭐ 秒數會自己跳（關掉動畫時唯一的活著證據）',
        t.els.text.textContent !== first && t.els.text.textContent.includes('已經 3 秒'),
        t.els.text.textContent);
  check('還沒到 8 秒時不講「比較久」', t.els.slow.hidden === true);
  t.advance(6000);
  check('⭐ 超過 8 秒會多講一句', t.els.slow.hidden === false);
  t.p.render(3);
  check('⭐ 換下一步時「比較久」重新算', t.els.slow.hidden === true);
  check('換步後秒數從 0 重新算', t.els.text.textContent.includes('已經 0 秒'),
        t.els.text.textContent);
}

/* ── ③ capture.stop() 真的照順序回報 ─────────────────────────────────── */

console.log('=== stop() 的回報順序（capture.js）===');

function fakeTauri() {
  globalThis.window = {
    __TAURI__: { core: { invoke: async (cmd) => (cmd === 'log_frontend' ? undefined : null) } },
  };
}

function makeCapture({ endSessionThrows = false, onProgress } = {}) {
  fakeTauri();
  const capture = new MeetingCapture({
    panel: { clear() {}, clearPartials() {}, addSegments() {}, setPartial() {} },
    store: {
      init() {}, beginChunk() {}, addSegment() {},
      endSession: async () => { if (endSessionThrows) throw new Error('假裝存檔炸了'); return 'ok'; },
      totalSegmentCount: () => 0, markdown: () => '',
    },
    settingsStore: { get: () => ({}) },
    onAlert: () => {},
    onStatus: () => {},
    onNotice: () => {},
    onReport: () => {},
    onRunning: () => {},
    onProgress,
  });
  capture.streams = [];
  capture.running = true;
  capture.paused = false;
  return capture;
}

{
  const seen = [];
  const capture = makeCapture({ onProgress: (s) => seen.push(s) });
  await capture.stop();
  check('⭐ 四步依序回報，最後收掉',
        JSON.stringify(seen) === JSON.stringify([1, 2, 3, 4, null]), JSON.stringify(seen));
  check('步數與名字表對得上', STOP_STEP_NAMES.length === 4, String(STOP_STEP_NAMES.length));
}
{
  const seen = [];
  const capture = makeCapture({ endSessionThrows: true, onProgress: (s) => seen.push(s) });
  let threw = false;
  try { await capture.stop(); } catch { threw = true; }
  check('中途炸掉時例外仍然往外丟（不吞錯）', threw === true);
  check('⭐ 中途炸掉也會收掉進度（不會停在半路）',
        seen[seen.length - 1] === null, JSON.stringify(seen));
  check('炸在第 3 步，所以第 4 步沒報過', !seen.includes(4), JSON.stringify(seen));
}
{
  const capture = makeCapture({});  // 完全不接 onProgress
  let ok = true;
  try { await capture.stop(); } catch { ok = false; }
  check('沒接進度回報時整段照跑、不會爆', ok === true);
}

console.log('');
console.log(failures === 0 ? '全部通過。' : failures + ' 項沒過。');
process.exit(failures === 0 ? 0 : 1);
