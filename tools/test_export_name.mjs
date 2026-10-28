/**
 * 匯出檔名的純函式測試。
 *
 * 跑法：
 *   "C:\Program Files\nodejs\node.exe" app/tools/test_export_name.mjs
 *
 * ⚠ 這張網管得到的只有「檔名長什麼樣」。存檔對話框開不開得起來、
 *   Rust 寫不寫得進那個路徑，node 看不到——要開 App 按那顆鈕才算數。
 */

import { exportFileName } from '../src/v2/js/export-name.js';

let pass = 0;
const failures = [];

function check(name, got, want) {
  if (got === want) {
    pass += 1;
  } else {
    failures.push(name + '\n    got  ' + JSON.stringify(got) + '\n    want ' + JSON.stringify(want));
  }
}

const ID = 'session-260101-090000';

/* ── 一般情況 ── */
check('一般標題', exportFileName('週會 第三次', ID, 'srt'), '週會 第三次.srt');
check('副檔名 txt', exportFileName('週會', ID, 'txt'), '週會.txt');
check('副檔名大寫會被壓成小寫', exportFileName('週會', ID, 'SRT'), '週會.srt');

/* ── 標題是「這場的第一句話」，所以什麼都可能有 ── */
check(
  '冒號與斜線（Windows 不給）',
  exportFileName('OK: let\'s review 1/2 的 schedule', ID, 'srt'),
  "OK let's review 1 2 的 schedule.srt"
);
check('反斜線', exportFileName('a\\b', ID, 'txt'), 'a b.txt');
check('引號與問號星號', exportFileName('他說"什麼"?*', ID, 'txt'), '他說 什麼.txt');
check('換行被壓成一個空白', exportFileName('第一行\n第二行', ID, 'txt'), '第一行 第二行.txt');
check('控制字元', exportFileName('a\u0007b', ID, 'txt'), 'a b.txt');
check('連續空白只留一個', exportFileName('  很   多  空白  ', ID, 'txt'), '很 多 空白.txt');

/* ── 結尾的點與空白：Windows 會靜默吃掉，於是兩個不同標題存成同一個檔 ── */
check('結尾的點', exportFileName('會議紀錄...', ID, 'txt'), '會議紀錄.txt');
check('結尾的空白', exportFileName('會議紀錄   ', ID, 'txt'), '會議紀錄.txt');

/* ── 沒東西可用時退回 id ── */
check('空標題', exportFileName('', ID, 'srt'), ID + '.srt');
check('null 標題', exportFileName(null, ID, 'srt'), ID + '.srt');
check('undefined 標題', exportFileName(undefined, ID, 'srt'), ID + '.srt');
check('整串都是非法字元', exportFileName('///***', ID, 'txt'), ID + '.txt');
check('標題與 id 都沒有', exportFileName('', '', 'txt'), 'session.txt');

/* ── Windows 保留字：建不出來，而且錯誤訊息看不出原因 ── */
check('保留字 con', exportFileName('con', ID, 'txt'), ID + '.txt');
check('保留字大小寫不拘', exportFileName('CON', ID, 'txt'), ID + '.txt');
check('保留字 com1', exportFileName('com1', ID, 'txt'), ID + '.txt');
check('只是開頭像保留字不算', exportFileName('console', ID, 'txt'), 'console.txt');

/* ── 太長：整場的第一句話可以很長，全路徑上限 260 ── */
const long = '一二三四五六七八九十'.repeat(12); // 120 字
const cut = exportFileName(long, ID, 'srt');
check('過長被截斷', cut.length, 60 + 4);
check('截斷後仍是同樣的開頭', cut.slice(0, 10), '一二三四五六七八九十');
check('剛好 60 字不截', exportFileName('あ'.repeat(60), ID, 'txt').length, 64);

/* ── 副檔名本身也可能是空的 ── */
check('沒給副檔名', exportFileName('週會', ID, ''), '週會.txt');

if (failures.length) {
  console.log('FAIL ' + failures.length + ' 項（PASS ' + pass + '）');
  failures.forEach((f) => console.log('  X ' + f));
  process.exit(1);
}
console.log('全部 PASS：' + pass + ' 項');
