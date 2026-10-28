/**
 * 重點標記（marks.js）。
 *
 * 最要釘住的是**格式**：`重點標記.md` 只要有一行長得像即時稿
 * （`[時:分:秒] 【麥克風/電腦聲音】`），會後的 `find_live_transcript()` 就會
 * 找到兩份即時稿、整場報錯。下面用同一條規則（會後處理腳本認即時稿的那條）掃。
 *
 * 跑法：
 *   & "C:\Program Files\nodejs\node.exe" app/tools/test_marks.mjs
 */

import { marksToMarkdown, wallClock, NEAR_MS } from '../src/v2/js/marks.js';
import { SessionStore, SOURCE_LABEL } from '../src/v2/js/session-store.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  ← ' + detail : ''));
  if (!ok) failures += 1;
}

// 會後處理腳本認即時稿那條規則的 JS 版
const LIVE_LINE = /^\[(\d\d):(\d\d):(\d\d)\]\s*【(麥克風|電腦聲音)】(.*)$/;

const start = new Date(2026, 9, 22, 15, 0, 0).getTime();
const store = new SessionStore({ invoke: async () => {} });
store.init({ sourceLang: 'auto', targetLang: 'zh' });
store.createdAtMs = start;
store.beginChunk();
const seg = (src, tgt, source) => ({ originalText: src, translationText: tgt, source });
store.addSegment(seg('Budget is fifteen thousand euros.', '預算是一萬五千歐元。', 'system'), start + 10_000);
store.addSegment(seg('我們下週確認', null, 'mic'), start + 14_000);
store.addSegment(seg('Next topic.', '下一個議題。', 'system'), start + 60_000);
const transcriptBefore = store.markdown();

const marks = [
  start + 12_000,             // 前一句 10 秒、後一句 14 秒，兩句都要列
  start + 40_000,             // 前後 15 秒內都沒有字幕
  start + 60_000,             // 剛好同一刻抵達：算「前一句」
];
const md = marksToMarkdown(marks, store.allRows(), { sessionStartMs: start, sourceLabel: SOURCE_LABEL });
const lines = md.split('\n');

check('沒有任何一行會被認成即時稿', !lines.some((l) => LIVE_LINE.test(l)),
  lines.filter((l) => LIVE_LINE.test(l)).join(' | '));
check('不出現【麥克風】【電腦聲音】', !md.includes('【麥克風】') && !md.includes('【電腦聲音】'));
check('三個標記都在', lines.filter((l) => l.startsWith('- ⭐ ')).length === 3);
check('時間是牆上時鐘', md.includes('- ⭐ 15:00:12') && md.includes('- ⭐ 15:00:40'));
check('前後兩句都列（第 1 個）',
  md.includes('15:00:10｜電腦聲音｜Budget is fifteen thousand euros.　→ 預算是一萬五千歐元。') &&
  md.includes('15:00:14｜麥克風｜我們下週確認'));
check('沒有譯文的那句不印箭頭', !md.includes('我們下週確認　→'));
check('附近沒字幕要講出來', md.includes('（前後 ' + NEAR_MS / 1000 + ' 秒內沒有字幕）'));
check('同一刻抵達的那句有列', md.split('- ⭐ 15:01:00')[1].includes('Next topic.'));
check('沒有標記就回空字串（不寫檔）',
  marksToMarkdown([], store.allRows(), { sessionStartMs: start, sourceLabel: SOURCE_LABEL }) === '');
check('逐字稿內容不受標記影響', store.markdown() === transcriptBefore);
check('wallClock 補零', wallClock(new Date(2026, 0, 1, 9, 5, 7).getTime()) === '09:05:07');

console.log(failures ? `\n${failures} 項失敗` : '\n全部通過');
process.exit(failures ? 1 : 0);
