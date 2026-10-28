/**
 * 離線重放：把實測抓到的 Soniox 原始封包餵進 v2 的解析層，機械驗收。
 *
 * 為什麼要有這支（解析層的驗收方式）：
 *   配對邏輯是本專案最容易靜默壞掉的地方（舊前端 47% 錯位、中文 8 句全消失，
 *   兩件都沒有任何錯誤訊息）。有了這支，之後每次改配對都能重跑，
 *   不必連線、不花錢、不用開麥克風唸稿。
 *
 * 跑法：
 *   & "C:\Program Files\nodejs\node.exe" app/tools/replay_segmenter.mjs
 *
 * 資料來源：環境變數 SONIOX_CAPTURE_DIR 指向的資料夾裡的 soniox-raw-*.jsonl（最新一份）
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SonioxSegmenter } from '../src/v2/js/soniox-segmenter.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.SONIOX_CAPTURE_DIR;
if (!dataDir) {
  console.error('先設 SONIOX_CAPTURE_DIR，指向 soniox-raw-*.jsonl 所在的資料夾');
  process.exit(1);
}

const files = readdirSync(dataDir)
  .filter((f) => f.startsWith('soniox-raw-') && f.endsWith('.jsonl'))
  .sort();
if (!files.length) {
  console.error('找不到 soniox-raw-*.jsonl，先跑 capture_ws.py');
  process.exit(1);
}
const dataPath = join(dataDir, files[files.length - 1]);
const rows = readFileSync(dataPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));

console.log('資料：' + files[files.length - 1] + '  ' + rows.length + ' 行');

// ⚠ 刻意**不**接簡→繁轉換：這支驗的是配對與分段，接了轉換就等於同時驗兩件事，
//   紅了也分不出是哪一邊壞的。所以下面印出來的譯文是簡體，那是預期的。
//   轉繁另有 test_s2t.mjs 顧，實際執行時 SonioxStream 預設就會接上。
const seg = new SonioxSegmenter({ source: 'system' });

const segments = [];
let partialCount = 0;
// 同時自己算一份「所有定稿原文 token 串接」，用來驗零丟字
let expectedOriginal = '';
let expectedTranslation = '';

for (const row of rows) {
  if (row.kind !== 'recv') continue;
  const tokens = (row.payload && row.payload.tokens) || [];
  for (const t of tokens) {
    if (!t.is_final) continue;
    if (t.text === '<end>' || t.text === '<fin>') continue;
    if (t.translation_status === 'translation') expectedTranslation += t.text;
    else expectedOriginal += t.text;
  }
  const { segments: got, partial } = seg.push(tokens);
  segments.push(...got);
  if (partial) partialCount += 1;
}
segments.push(...seg.flush());

console.log('產出 segment：' + segments.length + '（暫時字幕更新 ' + partialCount + ' 次）');

/* --------------------------------- 檢查 --------------------------------- */

let failures = 0;
function check(name, ok, detail = '') {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  ← ' + detail : ''));
  if (!ok) failures += 1;
}

console.log('\n=== 機械驗收 ===');

// ① 零丟字：這是最強的一條。原文與譯文都不能少一個字。
const gotOriginal = segments.map((s) => s.originalText || '').join('');
const gotTranslation = segments.map((s) => s.translationRaw || '').join('');
check(
  '原文零丟字',
  gotOriginal === expectedOriginal,
  gotOriginal === expectedOriginal
    ? ''
    : '預期 ' + expectedOriginal.length + ' 字、實得 ' + gotOriginal.length + ' 字'
);
check(
  '譯文零丟字',
  gotTranslation === expectedTranslation,
  gotTranslation === expectedTranslation
    ? ''
    : '預期 ' + expectedTranslation.length + ' 字、實得 ' + gotTranslation.length + ' 字'
);

// ② 講目標語言（中文）的段落照樣落地，且 translationText 是 null
const zhSegs = segments.filter((s) => s.from === 'zh');
check('中文段落有落地', zhSegs.length > 0, zhSegs.length + ' 段');
check(
  '中文段落 translationText 全為 null',
  zhSegs.every((s) => s.translationText === null),
  zhSegs.filter((s) => s.translationText !== null).length + ' 段不是 null'
);

// ③ 沒有譯文的長段落有被切開（否則字幕會等 97 字才出現）
const longest = Math.max(...zhSegs.map((s) => (s.originalText || '').length), 0);
check('中文段落最長不超過 80 字', longest <= 80, '最長 ' + longest + ' 字');

// ④ 有譯文的段落，原文與譯文都不為空（成對出生，不可能只有一半）
const paired = segments.filter((s) => s.translationText !== null);
check(
  '有譯文的段落原文都不為空',
  paired.every((s) => s.originalText && s.originalText.trim().length > 0),
  paired.filter((s) => !s.originalText || !s.originalText.trim()).length + ' 段原文是空的'
);

// ⑤ 每個 segment 的 id 唯一
const ids = new Set(segments.map((s) => s.id));
check('id 唯一', ids.size === segments.length, ids.size + ' / ' + segments.length);

// ⑥ 時間戳：原文側有 startMs（譯文側官方不給，見報告結論④）
const noStart = segments.filter((s) => s.originalText && s.startMs === null);
check('原文段落都有 startMs', noStart.length === 0, noStart.length + ' 段缺 startMs');

// ⑦ source 貫穿
check('source 全部是 system', segments.every((s) => s.source === 'system'));

// ⑧ flush 之後手上是空的（再 flush 一次應該零產出）
check('flush 後無殘留', seg.flush().length === 0);

/* --------------------------------- 逐段輸出 --------------------------------- */

console.log('\n=== 逐段輸出（給人眼看配對對不對）===');
for (const s of segments) {
  const t = s.startMs === null ? '  ?  ' : (s.startMs / 1000).toFixed(1).padStart(6);
  console.log(
    t + 's [' + (s.from || '?') + '→' + (s.to || '–') + ' spk=' + (s.speaker || '?') + ']'
  );
  console.log('        原 ' + (s.originalText || '（無）'));
  console.log('        譯 ' + (s.translationRaw === null ? '（無譯文）' : s.translationRaw));
}

console.log('\n' + (failures ? failures + ' 項 FAIL' : '全部 PASS'));
process.exit(failures ? 1 : 0);
