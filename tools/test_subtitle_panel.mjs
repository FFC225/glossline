/**
 * 字幕面板的呈現規則測試。
 *
 * 只測 renderModel()——那是「一筆 segment 該長成畫面上的什麼樣子」的全部規則，
 * 而且是純函式、沒有 DOM，所以 node 直接跑得動。
 * DOM 那半邊（插在哪、砍到剩幾行、要不要捲到底）不在這裡驗，
 * ⚠ 那塊目前**沒有自動測試**，要靠實際跑 App 看。誠實標著，別以為全綠＝面板沒問題。
 *
 * 跑法：
 *   & "C:\Program Files\nodejs\node.exe" app/tools/test_subtitle_panel.mjs
 */

import { renderModel } from '../src/v2/js/subtitle-panel.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  ← ' + detail : ''));
  if (!ok) failures += 1;
}

console.log('=== 字幕呈現規則 ===');

/* ① 有原文有譯文：兩行 */
{
  const m = renderModel({
    source: 'system',
    from: 'en',
    speaker: '1',
    originalText: 'The budget is 15,000 EUR.',
    translationText: '預算是 15,000 歐元。',
  });
  check('原文在原文那格', m.orig === 'The budget is 15,000 EUR.');
  check('譯文在譯文那格', m.trans === '預算是 15,000 歐元。');
  check('沒有多餘的註記', m.note === null);
  check('meta 有來源', m.meta.startsWith('電腦'), m.meta);
  check('meta 有語言', m.meta.includes('en'), m.meta);
  check('meta 有說話者', m.meta.includes('說話者 1'), m.meta);
}

/* ② 沒有譯文（講的就是目標語言）：一行，用譯文那一級顯示原文 */
{
  const m = renderModel({
    source: 'mic',
    from: 'zh',
    originalText: '我們就到這裡收尾吧。',
    translationText: null,
  });
  check('沒有譯文時不重複顯示兩行', m.orig === null);
  check('原文升上譯文那一格', m.trans === '我們就到這裡收尾吧。');
  check('標明這是正常狀態', m.note === '原文即目標語言', String(m.note));
  check('麥克風那路標成「我」', m.meta.startsWith('我'), m.meta);
}

/* ③ 只有譯文沒有原文（孤兒）：要看得見，不能靜靜吞掉 */
{
  const m = renderModel({ source: 'system', originalText: null, translationText: '謝謝參加。' });
  check('孤兒段落照樣顯示譯文', m.trans === '謝謝參加。');
  check('孤兒段落有標記', m.note === '（這段沒有原文）', String(m.note));
}

/* ④ 空白原文（只有空格）也算沒有原文 */
{
  const m = renderModel({ source: 'system', originalText: '   ', translationText: '謝謝。' });
  check('全空白的原文當作沒有原文', m.note === '（這段沒有原文）', String(m.note));
}

/* ⑤ 欄位缺一角時不可以炸 —— 少一格資訊而已，不是壞掉 */
{
  const m = renderModel({ originalText: 'hello', translationText: '哈囉' });
  check('沒有 source 時 meta 是 ?', m.meta === '?', m.meta);
  const m2 = renderModel({ source: 'system', originalText: 'hello', translationText: undefined });
  check('translationText 是 undefined 當成沒有譯文', m2.trans === 'hello' && m2.note === '原文即目標語言');
}

/* ⑥ 兩路的標籤不可以相同（不然畫面上分不出誰講的） */
{
  const a = renderModel({ source: 'system', originalText: 'a', translationText: 'b' });
  const b = renderModel({ source: 'mic', originalText: 'a', translationText: 'b' });
  check('兩路標籤不同', a.meta !== b.meta, a.meta + ' vs ' + b.meta);
}

console.log('\n' + (failures ? failures + ' 項 FAIL' : '全部 PASS'));
process.exit(failures ? 1 : 0);
