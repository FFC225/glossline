/**
 * 錄音讀秒的字面。
 *
 * 讀秒本身是「現在 − 開始的那一刻」，那一段不必測（它就是減法）。
 * 這支釘的是**印出來的字**，因為那是使用者唯一看得到的東西：
 *   ① 一小時以內不要長出「00:」的小時位
 *   ② 超過一小時要長出來（不然 1:00:05 印成 00:05，看起來像剛開始錄）
 *   ③ 負數／NaN 不可以印出來——時鐘被往回調時那個減法會變負的
 *
 * 跑法：
 *   & "C:\Program Files\nodejs\node.exe" app/tools/test_elapsed.mjs
 */

import { formatElapsed } from '../src/v2/js/ui-text.js';

let failures = 0;
function eq(name, got, want) {
  const ok = got === want;
  console.log((ok ? '  PASS ' : '  FAIL ') + name + '  ← ' + got + (ok ? '' : '（要 ' + want + '）'));
  if (!ok) failures += 1;
}

const S = 1000;
const M = 60 * S;
const H = 60 * M;

console.log('=== 錄音讀秒 ===');

eq('剛按下去', formatElapsed(0), '00:00');
eq('不足一秒還是 00:00（不四捨五入成 00:01）', formatElapsed(999), '00:00');
eq('十二分三十四秒', formatElapsed(12 * M + 34 * S), '12:34');
eq('五十九分五十九秒（還沒長小時位）', formatElapsed(59 * M + 59 * S), '59:59');
eq('⭐ 剛好一小時要長出小時位', formatElapsed(H), '1:00:00');
eq('⭐ 一小時又五秒不可以印成 00:05', formatElapsed(H + 5 * S), '1:00:05');
eq('兩小時三分四秒', formatElapsed(2 * H + 3 * M + 4 * S), '2:03:04');
eq('十小時（小時位不補零）', formatElapsed(10 * H), '10:00:00');
eq('⭐ 負數（時鐘被往回調）當 0', formatElapsed(-5000), '00:00');
eq('⭐ NaN 當 0', formatElapsed(NaN), '00:00');
eq('⭐ undefined 當 0', formatElapsed(undefined), '00:00');
eq('Infinity 當 0（不是印一串 NaN:NaN）', formatElapsed(Infinity), '00:00');

console.log(failures ? `\n${failures} 項失敗` : '\n全部通過');
process.exit(failures ? 1 : 0);
