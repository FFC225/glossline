/**
 * 散會命名的規則測試。
 *
 * 只測 `session-naming.js` 的兩支純函式——那裡是「一次要改三個東西、而且可以
 * 各自失敗」的全部規則。invoke 是注入的假貨，所以 node 直接跑得動。
 * ⚠ DOM 那半邊（報告框裡那一欄、按鈕、狀態列）**沒有自動測試**，要實際跑 App 看。
 *   誠實標著：全綠不等於命名這件事在畫面上是好的。
 *
 * 跑法：
 *   & "C:\Program Files\nodejs\node.exe" app/tools/test_session_naming.mjs
 */

import { applyMeetingName, nameResultMessage, folderLeaf } from '../src/v2/js/session-naming.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  ← ' + detail : ''));
  if (!ok) failures += 1;
}

/** 記下每一次呼叫，並照 `fail` 指定的指令拋錯。 */
function fakeInvoke({ fail = [], renamed = 'D:\\raw\\meeting-2026-09-12_143000 Alice 週會' } = {}) {
  const calls = [];
  const fn = async (cmd, args) => {
    calls.push({ cmd, args });
    if (fail.includes(cmd)) throw '假的失敗（' + cmd + '）';
    if (cmd === 'rename_session_dir') return renamed;
    return null;
  };
  fn.calls = calls;
  return fn;
}

const OLD = 'D:\\raw\\meeting-2026-09-12_143000';
const NEW = 'D:\\raw\\meeting-2026-09-12_143000 Alice 週會';

console.log('=== 散會命名 ===');

/* ① 一切正常：三件都做、而且逐字稿是寫到新路徑 */
{
  const invoke = fakeInvoke();
  const r = await applyMeetingName({
    invoke,
    name: '  Alice 週會 ',
    sessionId: 'session-260101-1430',
    folder: OLD,
    hasSegments: true,
    markdown: () => '# Alice 週會\n',
  });
  check('三件都成功', r.ok && r.done.length === 3, JSON.stringify(r));
  check('回報的是改名後的路徑', r.folder === NEW, r.folder);
  const order = invoke.calls.map((c) => c.cmd);
  check(
    '順序：先標題、再改名、最後副本',
    order.join(',') ===
      'update_session_title,rename_session_dir,save_transcript_beside_recording',
    order.join(',')
  );
  const copy = invoke.calls.find((c) => c.cmd === 'save_transcript_beside_recording');
  check('副本寫到新路徑，不是舊路徑', copy.args.dir === NEW, copy.args.dir);
  const title = invoke.calls.find((c) => c.cmd === 'update_session_title');
  check('名字前後的空白有去掉', title.args.title === 'Alice 週會', title.args.title);
}

/* ①b 🔴 副本裡的標題必須是**新名字**（實撞過的迴歸）
 *
 * 第一版把 `setTitle` 留給呼叫端在「跑完整套之後」做，於是 markdown() 產生時
 * store 上還是舊的自動標題——三件事全部回報成功、檔案也確實被重寫（時間戳是新的），
 * 只有內容是舊的。這一條就是釘「產生 Markdown 之前標題已經換好」。
 */
{
  const invoke = fakeInvoke();
  let storeTitle = '目前測試一下，我隨便說一些東西';
  const r = await applyMeetingName({
    invoke,
    name: '測試場次',
    sessionId: 'session-260101-090000',
    folder: OLD,
    hasSegments: true,
    // 真正的 markdown() 第一行就是 store.title，所以這裡照樣從 storeTitle 生。
    markdown: () => '# ' + storeTitle + '\n\n內文\n',
    setTitle: (t) => {
      storeTitle = t;
    },
  });
  const copy = invoke.calls.find((c) => c.cmd === 'save_transcript_beside_recording');
  check('副本第一行是新名字', copy.args.mdContent.startsWith('# 測試場次'), copy.args.mdContent.split('\n')[0]);
  check('setTitle 有被呼叫', storeTitle === '測試場次', storeTitle);
  check('仍然三件都成功', r.ok && r.done.length === 3, JSON.stringify(r.done));
}

/* ①c 空名字時不可以動到標題（什麼都沒發生才對） */
{
  const invoke = fakeInvoke();
  let storeTitle = '原本的標題';
  await applyMeetingName({
    invoke,
    name: '  ',
    sessionId: 'session-x',
    folder: OLD,
    hasSegments: true,
    markdown: () => '# ' + storeTitle + '\n',
    setTitle: (t) => {
      storeTitle = t;
    },
  });
  check('空名字不動標題', storeTitle === '原本的標題', storeTitle);
}

/* ② 空名字：一個指令都不該送出去 */
{
  const invoke = fakeInvoke();
  const r = await applyMeetingName({
    invoke,
    name: '   ',
    sessionId: 'session-x',
    folder: OLD,
    hasSegments: true,
    markdown: () => '#\n',
  });
  check('空名字不送任何指令', invoke.calls.length === 0 && !r.ok, JSON.stringify(r));
}

/* ③ 這場沒錄音（folder 是 null）：只改記錄庫，不可以生出資料夾相關的呼叫 */
{
  const invoke = fakeInvoke();
  const r = await applyMeetingName({
    invoke,
    name: '沒錄的那場',
    sessionId: 'session-x',
    folder: null,
    hasSegments: true,
    markdown: () => '#\n',
  });
  const order = invoke.calls.map((c) => c.cmd);
  check('只呼叫記錄庫那一支', order.join(',') === 'update_session_title', order.join(','));
  check('folder 仍然是 null', r.folder === null && r.ok, JSON.stringify(r));
}

/* ④ 零句：記錄庫根本沒存檔，不可以去改它的標題（會得到 Read failed） */
{
  const invoke = fakeInvoke();
  const r = await applyMeetingName({
    invoke,
    name: '空的一場',
    sessionId: 'session-x',
    folder: OLD,
    hasSegments: false,
    markdown: () => '#\n',
  });
  const order = invoke.calls.map((c) => c.cmd);
  check('零句時只改資料夾名', order.join(',') === 'rename_session_dir', order.join(','));
  check('零句時不寫逐字稿副本', !order.includes('save_transcript_beside_recording'));
  check('仍然算成功', r.ok, JSON.stringify(r));
}

/* ⑤ 改名失敗（資料夾被檔案總管佔住）：副本不可以拿舊路徑硬寫，而且要講出來 */
{
  const invoke = fakeInvoke({ fail: ['rename_session_dir'] });
  const r = await applyMeetingName({
    invoke,
    name: 'Alice 週會',
    sessionId: 'session-x',
    folder: OLD,
    hasSegments: true,
    markdown: () => '# Alice 週會\n',
  });
  check('不算成功', !r.ok, JSON.stringify(r));
  check('folder 維持舊路徑', r.folder === OLD, r.folder);
  const copy = invoke.calls.find((c) => c.cmd === 'save_transcript_beside_recording');
  // 改名失敗時副本仍該寫（資料夾還在舊名字上），但一定要寫在舊路徑、不是想像中的新路徑。
  check('副本寫在還存在的那個路徑', copy && copy.args.dir === OLD, copy ? copy.args.dir : '沒寫');
  const msg = nameResultMessage(r);
  check('訊息要說「只改了一半」', msg.bad && msg.text.includes('只改了一半'), msg.text);
}

/* ⑥ 全軍覆沒：訊息不可以出現任何「成功」的字眼 */
{
  const invoke = fakeInvoke({ fail: ['update_session_title', 'rename_session_dir'] });
  const r = await applyMeetingName({
    invoke,
    name: 'X',
    sessionId: 'session-x',
    folder: OLD,
    hasSegments: false,
    markdown: () => '#\n',
  });
  const msg = nameResultMessage(r);
  check('全失敗＝紅字、沒有勾', msg.bad && !msg.text.includes('✓'), msg.text);
}

/* ⑦ 訊息只露資料夾最後一段（整條路徑會把框擠爛） */
{
  check('folderLeaf 取最後一段', folderLeaf(NEW) === 'meeting-2026-09-12_143000 Alice 週會', folderLeaf(NEW));
  check('斜線也吃', folderLeaf('/home/a/b 名字') === 'b 名字');
  check('沒有分隔符就原樣回', folderLeaf('meeting-x') === 'meeting-x');
  const msg = nameResultMessage({ ok: true, folder: NEW, done: ['錄音資料夾'], errors: [] });
  check('成功訊息不含完整路徑', msg.text.includes('meeting-2026-09-12_143000 Alice 週會') && !msg.text.includes('D:\\'), msg.text);
}

console.log(failures === 0 ? '\n全過。' : '\n' + failures + ' 項沒過。');
process.exit(failures === 0 ? 0 : 1);
