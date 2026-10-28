/**
 * 端到端離線重放：實測封包 → 解析層 → 記錄庫。
 *
 * replay_segmenter.mjs 驗的是「token 有沒有變成對的 segment」；
 * 這一支往下再走一層，驗「segment 有沒有原封不動變成存進 json 的那幾筆」。
 * 兩支分開是有意的：中間任何一層丟資料，看得出來是哪一層。
 *
 * ⚠ 不連線、不花錢、不開麥克風。資料是事先花約 US$0.0052 抓好的那份（路徑由 SONIOX_CAPTURE_DIR 指定）。
 *
 * 跑法：
 *   & "C:\Program Files\nodejs\node.exe" app/tools/replay_session.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SonioxSegmenter } from '../src/v2/js/soniox-segmenter.js';
import { toTraditional } from '../src/v2/js/s2t.js';
import { SessionStore } from '../src/v2/js/session-store.js';
import { renderModel } from '../src/v2/js/subtitle-panel.js';

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
  console.error('找不到 soniox-raw-*.jsonl');
  process.exit(1);
}
const rows = readFileSync(join(dataDir, files[files.length - 1]), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));

console.log('資料：' + files[files.length - 1] + '  ' + rows.length + ' 行');

/* ------------------------- 重放：封包 → segment → 記錄庫 ------------------------- */

const saved = [];
const store = new SessionStore({
  invoke: async (cmd, args) => {
    saved.push(args);
    return null;
  },
});
store.init({ sourceLang: 'auto', targetLang: 'zh' });
store.beginChunk();

// ⚠ 跟 replay_segmenter.mjs 差在這一行：那支刻意**不接**簡→繁（它只驗配對，
//   接了就變成一次驗兩件事、紅了分不出是哪一邊）。這支驗的是整條路——
//   實際執行時 SonioxStream 預設就會接上 s2t，所以這裡也接。
const seg = new SonioxSegmenter({ source: 'system', toTraditional });
const segments = [];
// 用假時鐘餵，才不會每次跑出來的 t_ms 都不一樣（跑兩次結果要一樣才驗得下去）
let clock = store.createdAtMs;

for (const row of rows) {
  if (row.kind !== 'recv') continue;
  const tokens = (row.payload && row.payload.tokens) || [];
  const { segments: got } = seg.push(tokens);
  clock += 250;
  for (const s of got) {
    segments.push(s);
    store.addSegment(s, clock);
  }
}
for (const s of seg.flush()) {
  segments.push(s);
  clock += 250;
  store.addSegment(s, clock);
}

const stored = store.currentChunk.segments;
console.log('segment ' + segments.length + ' 筆 → 記錄庫 ' + stored.length + ' 筆');

/* --------------------------------- 檢查 --------------------------------- */

let failures = 0;
function check(name, ok, detail = '') {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  ← ' + detail : ''));
  if (!ok) failures += 1;
}

console.log('\n=== 機械驗收 ===');

check('一筆都沒少', stored.length === segments.length, segments.length + ' → ' + stored.length);

// ① 逐筆對照：存進去的字要跟 segment 一模一樣（這條若破，就是存檔層在改資料）
const mismatched = stored.filter((r, i) => {
  const s = segments[i];
  return (
    r.src !== (s.originalText || '') ||
    r.tgt !== (s.translationText === undefined ? null : s.translationText) ||
    r.raw !== s.translationRaw ||
    r.who !== s.source
  );
});
check('逐筆內容一致', mismatched.length === 0, mismatched.length + ' 筆對不上');

// ② 講中文那幾段：照樣落地，而且 tgt 是 null（不是空字串、不是字串 "null"）
const zh = stored.filter((r) => r.from === 'zh');
check('中文段落有進記錄庫', zh.length > 0, zh.length + ' 筆');
check('中文段落 tgt 全是 null', zh.every((r) => r.tgt === null));
check('中文段落原文都不是空的', zh.every((r) => r.src.trim().length > 0));

// ③ 有譯文的段落，兩欄都在（成對出生，不可能只剩一半）
const paired = stored.filter((r) => r.tgt !== null);
check('有譯文的段落原文都在', paired.every((r) => r.src.trim().length > 0));
check('有譯文的段落都留了簡體原樣', paired.every((r) => typeof r.raw === 'string' && r.raw.length > 0));
check(
  '譯文確實轉過繁體（至少有一筆跟簡體不同）',
  paired.some((r) => r.tgt !== r.raw),
  '全部一模一樣就表示轉換沒接上'
);

// ③b 中文原文也要是繁體（原文也要一起轉）
const allSrc = stored.map((r) => r.src).join('');
check('中文原文已轉繁（實測素材裡的「确认」）', allSrc.includes('確認') && !allSrc.includes('确认'));
check('中文原文已轉繁（「礼拜」→「禮拜」）', allSrc.includes('禮拜') && !allSrc.includes('礼拜'));
check('英文原文沒有被字典動到', allSrc.includes('Thanks for joining.'));

// ④ 時間軸：t_ms 單調不遞減，且從 0 起算
const tms = stored.map((r) => r.t_ms);
check('t_ms 不遞減', tms.every((v, i) => i === 0 || v >= tms[i - 1]));
check('t_ms 全部 >= 0', tms.every((v) => v >= 0));

// ⑤ 匯出的那兩份：json 能來回、md 不含 "null" 這個字串
const json = store._toJson();
const roundTrip = JSON.parse(JSON.stringify(json));
check('json 可以來回序列化', JSON.stringify(roundTrip) === JSON.stringify(json));
const md = store._toMarkdown();
check('Markdown 沒有把 null 印出來', !md.includes('null'));
check('Markdown 每一筆都在', stored.every((r) => md.includes(r.src.slice(0, 12))));
check('沒有譯文的那幾筆有標記', md.includes('原文即目標語言'));

// ⑥ 畫面那一層也吃得下同一批（不會有「存得進去但畫不出來」的段落）
const blank = segments.filter((s) => {
  const m = renderModel(s);
  return !m.trans || !m.trans.trim();
});
check('每一筆在畫面上都有字', blank.length === 0, blank.length + ' 筆會畫成空白');

// ⑦ 自動標題不會是「未命名」（這批資料第一句就有譯文）
check('自動標題取得到', json.title !== '未命名會議', json.title);

/* ------------------------------ 抽樣印出來給人看 ------------------------------ */

console.log('\n=== 前 3 筆與後 3 筆（人眼確認配對）===');
const show = [...stored.slice(0, 3), null, ...stored.slice(-3)];
for (const r of show) {
  if (!r) {
    console.log('   …');
    continue;
  }
  console.log(
    '  [' + r.ts + ' +' + r.t_ms + 'ms ' + (r.who || '?') + '/' + (r.from || '?') + ']'
  );
  console.log('     原 ' + r.src);
  console.log('     譯 ' + (r.tgt === null ? '（無譯文，原文即目標語言）' : r.tgt));
}

console.log('\n' + (failures ? failures + ' 項 FAIL' : '全部 PASS'));
process.exit(failures ? 1 : 0);
