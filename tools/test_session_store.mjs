/**
 * 記錄庫的合成資料單元測試。
 *
 * 為什麼要合成資料而不是只用實測封包（學到的教訓）：
 *   真實資料只能證明「這一份沒壞」，證不了「規則對」。邊界（沒有譯文、
 *   沒有原文、存檔失敗、髒不髒的判斷）只有自己造得出來。
 *
 * 跑法：
 *   & "C:\Program Files\nodejs\node.exe" app/tools/test_session_store.mjs
 */

import { SessionStore, segmentToRow } from '../src/v2/js/session-store.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  ← ' + detail : ''));
  if (!ok) failures += 1;
}

function seg(over = {}) {
  return {
    id: 'x',
    source: 'system',
    speaker: '1',
    from: 'en',
    to: 'zh',
    startMs: 1000,
    endMs: 2000,
    originalText: 'Thanks for joining.',
    translationText: '謝謝參加。',
    translationRaw: '谢谢参加。',
    confidence: 0.9,
    isFinal: true,
    ...over,
  };
}

/** 假的 invoke：記下每次呼叫，可切換成會丟例外。 */
function fakeInvoke() {
  const calls = [];
  const fn = async (cmd, args) => {
    calls.push({ cmd, args });
    if (fn.shouldFail) throw new Error('磁碟滿了');
    return null;
  };
  fn.calls = calls;
  fn.shouldFail = false;
  return fn;
}

console.log('=== 記錄庫（合成資料）===');

/* ① 一般段落：欄位全到位 */
{
  const store = new SessionStore({ invoke: fakeInvoke() });
  store.init({ sourceLang: 'auto', targetLang: 'zh' });
  store.addSegment(seg(), store.createdAtMs + 4200);
  const row = store.currentChunk.segments[0];
  check('原文有落地', row.src === 'Thanks for joining.');
  check('譯文是轉繁後的那格', row.tgt === '謝謝參加。');
  check('簡體原樣留著（回溯用）', row.raw === '谢谢参加。');
  check('who 貫穿到記錄', row.who === 'system');
  check('spk 有存', row.spk === '1');
  check('t_ms 是牆上時鐘', row.t_ms === 4200, String(row.t_ms));
  check('start_ms 有存（但不拿來排時間）', row.start_ms === 1000);
  check('ts 是 HH:MM:SS', /^\d{2}:\d{2}:\d{2}$/.test(row.ts), row.ts);
}

/* ② 沒有譯文：這是本專案最貴的那個 bug（舊前端整批弄丟中文） */
{
  const store = new SessionStore({ invoke: fakeInvoke() });
  store.init({});
  store.addSegment(seg({ originalText: '我們就到這裡收尾吧。', translationText: null, translationRaw: null, from: 'zh' }));
  const row = store.currentChunk.segments[0];
  check('沒有譯文照樣落地', store.totalSegmentCount() === 1);
  check('tgt 是 null，不是空字串', row.tgt === null, JSON.stringify(row.tgt));
  check('原文完整保留', row.src === '我們就到這裡收尾吧。');

  const md = store._toMarkdown();
  check('Markdown 標出「原文即目標語言」', md.includes('原文即目標語言'));
  check('Markdown 沒有出現字串 "null"', !md.includes('null'));
  check('Markdown 有原文', md.includes('我們就到這裡收尾吧。'));
  check('Markdown 標了來源', md.includes('【電腦聲音】'));

  const json = store._toJson();
  check('未結束的 chunk 也會被序列化', json.chunks.length === 1 && json.chunks[0].segments.length === 1);
  check('自動標題用得到原文', json.title === '我們就到這裡收尾吧。', json.title);
}

/* ③ 沒有原文只有譯文（孤兒）：實測沒見過，但不可以吞掉 */
{
  const store = new SessionStore({ invoke: fakeInvoke() });
  store.init({});
  store.addSegment(seg({ originalText: null }));
  const row = store.currentChunk.segments[0];
  check('孤兒譯文照樣落地', store.totalSegmentCount() === 1);
  check('孤兒段落 src 是空字串', row.src === '');
  check('孤兒段落 tgt 還在', row.tgt === '謝謝參加。');
}

/* ④ 存檔：髒了才存、成功之後不重複存 */
{
  const invoke = fakeInvoke();
  const store = new SessionStore({ invoke });
  store.init({});
  check('沒東西時不存', (await store.persist()) === 'skipped');
  store.addSegment(seg());
  check('有東西就存', (await store.persist()) === 'saved');
  check('save_session 被呼叫一次', invoke.calls.length === 1, String(invoke.calls.length));
  const args = invoke.calls[0].args;
  check('送出的鍵名是 Tauri 的 camelCase', 'mdContent' in args && 'jsonData' in args);
  check('id 一致', args.id === store.id && args.jsonData.id === store.id);
  check('沒有新東西就不再存', (await store.persist()) === 'skipped');
  store.addSegment(seg());
  check('又有新東西就再存一次', (await store.persist()) === 'saved');
}

/* ⑤ 存檔失敗要吼，而且不可以假裝存過了 */
{
  const invoke = fakeInvoke();
  invoke.shouldFail = true;
  const store = new SessionStore({ invoke });
  let shouted = null;
  store.onPersistError = (err) => {
    shouted = String(err);
  };
  store.init({});
  store.addSegment(seg());
  check('失敗回報 failed', (await store.persist()) === 'failed');
  check('失敗有吼出來', shouted !== null && shouted.includes('磁碟滿了'), String(shouted));
  check('失敗後仍算髒（下次會重試）', store._mutations !== store._persistedMutations);
  invoke.shouldFail = false;
  check('修好之後存得起來', (await store.persist()) === 'saved');
}

/* ⑥ endSession 會把開著的 chunk 收掉並存檔 */
{
  const invoke = fakeInvoke();
  const store = new SessionStore({ invoke });
  store.init({});
  store.addSegment(seg());
  check('endSession 存檔', (await store.endSession()) === 'saved');
  check('chunk 已收', store.currentChunk === null && store.chunks.length === 1);
  check('ended_at 有寫', typeof store.endedAt === 'string');
  const json = invoke.calls[invoke.calls.length - 1].args.jsonData;
  check('json 的 chunk 有 ended_at', json.chunks[0].ended_at !== null);
}

/* ⑦ init 之前 addSegment 要直接炸，不可以默默丟掉 */
{
  const store = new SessionStore({ invoke: fakeInvoke() });
  let threw = false;
  try {
    store.addSegment(seg());
  } catch (e) {
    threw = true;
  }
  check('init 之前 addSegment 會丟例外', threw);
}

/* ⑧ segmentToRow 是純函式：同樣輸入同樣輸出，不看時鐘 */
{
  const a = segmentToRow(seg(), { sessionStartMs: 1000, nowMs: 5000 });
  const b = segmentToRow(seg(), { sessionStartMs: 1000, nowMs: 5000 });
  check('純函式：兩次結果相同', JSON.stringify(a) === JSON.stringify(b));
  const c = segmentToRow(seg(), { sessionStartMs: 9000, nowMs: 1000 });
  check('時鐘倒退時 t_ms 不會是負的', c.t_ms === 0, String(c.t_ms));
}

/* ⑨ 表頭「開始」要到秒：會後切錄音的零點只剩這裡 */
{
  const store = new SessionStore({ invoke: fakeInvoke() });
  store.init({});
  // 固定一個秒數不是 00 的時刻，才分得出「有秒」與「秒被補成 00」
  const t = new Date(2026, 8, 23, 15, 1, 3);
  store.createdAt = t.toISOString();
  store.createdAtMs = t.getTime();
  store.addSegment(seg(), t.getTime() + 5000);
  const md = store._toMarkdown();
  check('表頭開始到秒', md.includes('**開始**：2026-09-23 15:01:03　'), md.split('\n')[2]);
  // 會後處理工具的舊版 regex（只抓到分）照樣要吃得到，舊工具不能因此壞掉
  const oldRe = /\*\*開始\*\*：\d{4}-\d\d-\d\d\s+(\d\d):(\d\d)/;
  const m = md.match(oldRe);
  check('舊 regex 仍抓得到時分', m && m[1] === '15' && m[2] === '01');
  // 段落的時間取自 beginChunk() 當下，不是上面固定的那一刻，所以只驗格式
  check('段落標題仍只到分', /^## 第 1 段 — \d\d:\d\d – 進行中$/m.test(md), md.split('\n')[6]);
}

console.log('\n' + (failures ? failures + ' 項 FAIL' : '全部 PASS'));
process.exit(failures ? 1 : 0);
