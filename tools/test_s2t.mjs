/**
 * 簡→繁轉換的測試。
 *
 * 重點在**一對多的歧義**：`发` 可以是「發」也可以是「髮」，`干` 可以是
 * 「乾」「幹」「干」。字級表判不出來，要靠詞級表蓋過去。
 * 若哪天有人把詞級表拿掉只留字級，這幾項會立刻紅——那正是要攔的退步。
 *
 * 最後一段拿實測抓到的真實譯文全轉一遍，給人眼看。
 *
 * 跑法：
 *   & "C:\Program Files\nodejs\node.exe" app/tools/test_s2t.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { toTraditional, tableSizes } from '../src/v2/js/s2t.js';

let failures = 0;
function eq(name, got, want) {
  const ok = got === want;
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (ok ? '' : '  ← got 「' + got + '」want 「' + want + '」'));
  if (!ok) failures += 1;
}
function check(name, ok, detail = '') {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  ← ' + detail : ''));
  if (!ok) failures += 1;
}

console.log('=== ① 字典載入 ===');
const sizes = tableSizes();
check('階段 1（S2T）條目數 > 40000', sizes.s2t > 40000, sizes.s2t + ' 條');
check('階段 2（TWP）條目數 > 500', sizes.twp > 500, sizes.twp + ' 條');
check('階段 3（TWV）條目數 > 30', sizes.twv > 30, sizes.twv + ' 條');

console.log('\n=== ② 字級轉換 ===');
eq('简体 → 簡體', toTraditional('简体'), '簡體');
eq('预算是15,000欧元', toTraditional('预算是15,000欧元'), '預算是15,000歐元');
eq('感谢您加入', toTraditional('感谢您加入'), '感謝您加入');

console.log('\n=== ③ 一對多歧義：詞級要蓋過字級 ===');
eq('头发 → 頭髮（不是頭發）', toTraditional('头发'), '頭髮');
eq('发展 → 發展（发 的字級歧義）', toTraditional('发展'), '發展');
eq('干净 → 乾淨', toTraditional('干净'), '乾淨');
eq('干部 → 幹部', toTraditional('干部'), '幹部');
eq('里面 → 裡面', toTraditional('里面'), '裡面');
eq('公里 → 公里（不變）', toTraditional('公里'), '公里');

console.log('\n=== ③b 台灣用詞在地化（階段 2）===');
// ⚠ 這幾項專門攔「把兩張表壓成一張只掃一次」的退步：
//   「打印」簡繁同形，階段 1 碰不到它，只有階段 2 抓得到。
eq('软件 → 軟體', toTraditional('软件'), '軟體');
eq('网络 → 網路', toTraditional('网络'), '網路');
eq('打印 → 列印（簡繁同形，只有階段 2 抓得到）', toTraditional('打印'), '列印');
eq('信息 → 資訊', toTraditional('信息'), '資訊');
eq('鼠标 → 滑鼠', toTraditional('鼠标'), '滑鼠');
// ⚠ 這一項看起來像 bug、其實是在地化生效：TWPhrases 有 `發送 → 傳送`，
//   台灣講「傳送」。留著當提醒——在地化會改用詞，看到譯文用字跟預期不同時先查這張表。
eq('发送 → 傳送（在地化，不是 發送）', toTraditional('发送'), '傳送');
// ⚠ 後來新增：兩階段版漏掉的那一條，也是唯一一種在真實逐字稿上
//   跟 Python 版 s2twp 不一致的地方。拿掉階段 2 或把階段合併，這一項會紅。
eq('文本 → 文字（TWPhrases 專屬，合併階段就會漏）', toTraditional('无文本'), '無文字');
// 階段 3 專屬：TWVariants 是字形，只有整段跑完階段 2 之後才輪到它。
eq('裏面 → 裡面（TWVariants 字形）', toTraditional('裏面'), '裡面');
eq('拉麪 → 拉麵（TWVariants 字形）', toTraditional('拉麪'), '拉麵');

console.log('\n=== ④ 不該動的東西不要動 ===');
eq('已是繁體', toTraditional('繁體中文'), '繁體中文');
eq('英數與符號', toTraditional('Nordwind GmbH 15,000 EUR'), 'Nordwind GmbH 15,000 EUR');
eq('空字串', toTraditional(''), '');
eq('中英夾雜', toTraditional('这个 defect rate 大概 3%'), '這個 defect rate 大概 3%');

console.log('\n=== ⑤ 壞輸入不爆 ===');
eq('null 原樣回傳', toTraditional(null), null);
eq('數字原樣回傳', toTraditional(123), 123);

console.log('\n=== ⑥ 拿實測的真實譯文全轉一遍（給人眼看）===');
if (!process.env.SONIOX_CAPTURE_DIR) {
  console.log('  略過：沒設 SONIOX_CAPTURE_DIR（指向 soniox-raw-*.jsonl 所在的資料夾）');
} else try {
  const dataDir = process.env.SONIOX_CAPTURE_DIR;
  const file = readdirSync(dataDir)
    .filter((f) => f.startsWith('soniox-raw-') && f.endsWith('.jsonl'))
    .sort()
    .pop();
  const rows = readFileSync(join(dataDir, file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  let raw = '';
  for (const r of rows) {
    if (r.kind !== 'recv') continue;
    for (const t of (r.payload && r.payload.tokens) || []) {
      if (t.is_final && t.translation_status === 'translation') raw += t.text;
    }
  }
  const converted = toTraditional(raw);
  check('長度沒有暴走（轉換是一對一的字數）', Math.abs(converted.length - raw.length) <= 2,
    raw.length + ' → ' + converted.length);
  console.log('  原（簡）：' + raw.trim());
  console.log('  轉（繁）：' + converted.trim());
} catch (err) {
  check('讀實測資料', false, String(err));
}

console.log('\n' + (failures ? failures + ' 項 FAIL' : '全部 PASS'));
process.exit(failures ? 1 : 0);
