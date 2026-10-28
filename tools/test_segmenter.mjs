/**
 * v2 解析層的單元測試（合成資料）。
 *
 * 跟 replay_segmenter.mjs 分工不同，兩支都要留：
 *   - replay 用**真實封包**跑，回答「這套邏輯對真的 Soniox 輸出成不成立」。
 *   - 這一支用**合成資料**跑，回答「每一條規則本身對不對」。
 *
 * 為什麼需要這一支（反向測試的收穫）：
 *   我故意把 segmenter 弄壞三處，replay 三次都說 PASS。檢查之後發現破的不是
 *   segmenter、是 replay 的涵蓋——
 *     ① replay 完全沒有檢查暫時字幕（partial），所以 non-final 改成 append 也照樣綠。
 *     ② 那份實測資料的尾端剛好有 <end>，所以 flush() 不做事也看不出來。
 *   真實資料只能證明「這一份沒壞」，證不了「規則對」。合成資料才控制得住邊界。
 *
 * 跑法：
 *   & "C:\Program Files\nodejs\node.exe" app/tools/test_segmenter.mjs
 */

import { SonioxSegmenter } from '../src/v2/js/soniox-segmenter.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  ← ' + detail : ''));
  if (!ok) failures += 1;
}
function eq(name, got, want) {
  check(name, got === want, got === want ? '' : 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
}

/** 造一個 token。預設是英文原文、已定稿。 */
function tok(text, over = {}) {
  return {
    text,
    is_final: true,
    confidence: 0.9,
    speaker: '1',
    language: 'en',
    translation_status: 'original',
    start_ms: 1000,
    end_ms: 1200,
    ...over,
  };
}
const trans = (text, over = {}) =>
  tok(text, { translation_status: 'translation', language: 'zh', start_ms: null, end_ms: null, ...over });
const zh = (text, over = {}) => tok(text, { translation_status: 'none', language: 'zh', ...over });
const END = tok('<end>', { translation_status: 'none', language: null, speaker: null, start_ms: null, end_ms: null });

const newSeg = () => new SonioxSegmenter({ source: 'system' });

console.log('=== ① non-final 是整批取代，不是累加 ===');
{
  const s = newSeg();
  // 模擬伺服器的累積重送：每次都把整個未定稿陣列從頭送一次
  s.push([tok('Th', { is_final: false })]);
  s.push([tok('Th', { is_final: false }), tok('an', { is_final: false })]);
  const r = s.push([tok('Th', { is_final: false }), tok('an', { is_final: false }), tok('ks', { is_final: false })]);
  eq('partial 等於最後一批的串接', r.partial.originalText, 'Thanks');
  eq('partial 不是定稿', r.partial.isFinal, false);
  eq('這階段沒有任何定稿段落', r.segments.length, 0);
}

console.log('\n=== ② 定稿之後 pending 要清掉，partial 不留殘影 ===');
{
  const s = newSeg();
  s.push([tok('Hi', { is_final: false })]);
  const r = s.push([tok('Hi'), END]);
  eq('定稿後 partial 為 null', r.partial, null);
  eq('產出一段', r.segments.length, 1);
  eq('原文正確', r.segments[0].originalText, 'Hi');
}

console.log('\n=== ③ 原文與譯文在同一個物件裡出生（配對不靠猜）===');
{
  const s = newSeg();
  const r1 = s.push([tok('Hello.'), trans('你好。')]);
  // 下一段原文抵達，前一段才算完成
  const r2 = s.push([tok('Bye.'), trans('再見。')]);
  const all = [...r1.segments, ...r2.segments, ...s.flush()];
  eq('共兩段', all.length, 2);
  eq('第一段原文', all[0].originalText, 'Hello.');
  eq('第一段譯文', all[0].translationText, '你好。');
  eq('第二段原文', all[1].originalText, 'Bye.');
  eq('第二段譯文', all[1].translationText, '再見。');
  eq('from', all[0].from, 'en');
  eq('to', all[0].to, 'zh');
}

console.log('\n=== ④ 講目標語言（none）：沒有譯文照樣落地 ===');
{
  const s = newSeg();
  const r = s.push([zh('我講一下數字。'), END]);
  eq('有落地', r.segments.length, 1);
  eq('translationText 是 null', r.segments[0].translationText, null);
  eq('translationRaw 也是 null', r.segments[0].translationRaw, null);
  eq('原文在', r.segments[0].originalText, '我講一下數字。');
  eq('from 是 zh', r.segments[0].from, 'zh');
}

console.log('\n=== ⑤ 長段落切分：none 會切、original 不會切 ===');
{
  // none：40 字以上遇句末標點就切。
  // ⚠ 逐字送，因為真實的 Soniox token 就是一兩個字一個，切分判斷是累積出來的。
  const s1 = newSeg();
  const sentence1 = '這是一段刻意寫得很長的話總共超過四十個字才會觸發切分規則否則字幕要等一整段才出現。';
  const sentence2 = '第二句話在這裡。';
  const r1 = s1.push([...(sentence1 + sentence2).split('').map((c) => zh(c)), END]);
  check(
    'none 長段落被切成兩段',
    r1.segments.length === 2,
    r1.segments.length + ' 段：' + r1.segments.map((s) => s.originalText.length + '字').join(' / ')
  );
  if (r1.segments.length === 2) {
    eq('切點在句末標點', r1.segments[0].originalText, sentence1);
  }

  // original：再長也不切，因為譯文還在路上，切了就會變成孤兒
  const s2 = newSeg();
  const longEn = 'One more thing: the deadline moved from Friday to Monday and everyone must know.';
  const r2 = s2.push([tok(longEn)]);
  eq('original 長段落當下不切', r2.segments.length, 0);
  const r3 = s2.push([trans('還有一件事：截止時間從週五改到週一。')]);
  eq('譯文抵達時也還沒送出（等下一段開始）', r3.segments.length, 0);
  const out = s2.flush();
  eq('flush 後成一段', out.length, 1);
  eq('原文完整沒被剖開', out[0].originalText, longEn);
  check('譯文有接上', out[0].translationText !== null, String(out[0].translationText));
}

console.log('\n=== ⑥ flush 撈得回最後一段（尾端沒有 <end> 的情況）===');
{
  const s = newSeg();
  const r = s.push([tok('The last sentence.'), trans('最後一句。')]);
  eq('還沒送出', r.segments.length, 0);
  const tail = s.flush();
  eq('flush 拿得到', tail.length, 1);
  eq('內容正確', tail[0].originalText, 'The last sentence.');
  eq('再 flush 一次是空的', s.flush().length, 0);
}

console.log('\n=== ⑦ <end> 立刻沖洗 ===');
{
  const s = newSeg();
  const r = s.push([tok('Done.'), trans('好了。'), END]);
  eq('<end> 當下就送出', r.segments.length, 1);
  eq('<end> 本身沒有變成文字', r.segments[0].originalText, 'Done.');
}

console.log('\n=== ⑧ 時間戳：原文側有、譯文側不影響 ===');
{
  const s = newSeg();
  s.push([tok('A', { start_ms: 500, end_ms: 600 }), tok('B', { start_ms: 600, end_ms: 900 })]);
  const out = s.flush();
  eq('startMs 取第一個', out[0].startMs, 500);
  eq('endMs 取最後一個', out[0].endMs, 900);
}

console.log('\n=== ⑨ 簡→繁轉換掛在 segment 出生的地方 ===');
{
  const s = new SonioxSegmenter({ source: 'mic', toTraditional: (x) => x.replace(/发/g, '發') });
  s.push([tok('Send it.'), trans('发送它。')]);
  const out = s.flush();
  eq('translationText 已轉換', out[0].translationText, '發送它。');
  eq('translationRaw 保留原樣', out[0].translationRaw, '发送它。');
  eq('source 貫穿', out[0].source, 'mic');

  // 原文也要轉。Soniox 聽中文吐的是簡體，
  // 只轉譯文的話講中文那幾段在畫面與記錄庫都會是簡體。
  const s2 = new SonioxSegmenter({ source: 'mic', toTraditional: (x) => x.replace(/发/g, '發') });
  const r2 = s2.push([tok('我发一份给你。', { translation_status: 'none', language: 'zh' })]);
  // 這個假轉換器只認得 发 → 發，所以「给」原封不動是預期的
  eq('暫時字幕的原文也轉了', r2.partial.originalText, '我發一份给你。');
  const out2 = s2.flush();
  eq('定稿原文已轉換', out2[0].originalText, '我發一份给你。');
  eq('沒有譯文時仍是 null', out2[0].translationText, null);
}

console.log('\n=== ⑩ 壞輸入不會讓它爆掉，也不會靜默丟資料 ===');
{
  const s = newSeg();
  eq('空陣列', s.push([]).segments.length, 0);
  eq('null', s.push(null).segments.length, 0);
  // 未知的 translation_status：當原文收下（丟掉才是靜默降級的形狀）
  const r = s.push([tok('weird', { translation_status: 'brand_new_status' }), END]);
  eq('未知 status 照樣落地', r.segments.length, 1);
  eq('內容沒丟', r.segments[0].originalText, 'weird');
}

console.log('\n=== ⑪ 小數點不是句末標點（端到端實測撞過）===');
{
  // 實撞的形狀：「…料號是A273-09。數量5200件，單價是73.」被切成一段，
  // 「5塊，不良率…」成了下一段 → 匯出後讀的人只看到「單價是73」。
  // 查 start_ms/end_ms：兩段之間只隔 120 ms，人根本沒停，是規則自己切的。
  const zh = { translation_status: 'none', language: 'zh' };
  const s = newSeg();
  const r1 = s.push([
    tok('這一季的預算是新臺幣385萬，目前已經用掉64%，第二批預計4月30號，料號是A273-09，單價是', zh),
    tok('73.', zh),
  ]);
  eq('累積已過門檻但結尾是小數點 → 不切', r1.segments.length, 0);

  const r2 = s.push([tok('5塊，不良率控制在千分之三以內，交期是6月2號。', zh)]);
  eq('真的句末才切', r2.segments.length, 1);
  check(
    '73.5 沒有被切開',
    r2.segments.length === 1 && r2.segments[0].originalText.includes('73.5塊'),
    r2.segments.length ? JSON.stringify(r2.segments[0].originalText) : '沒有段落'
  );
}
{
  // 反向：改動不能讓「正常的句號」失去切段能力（否則長段落又會塞成一坨）
  const zh = { translation_status: 'none', language: 'zh' };
  const s = newSeg();
  const r = s.push([
    tok('我先報告上個月的進度，生產線的良率已經從87%提升到92%，主要原因是換掉了包材供應商。', zh),
  ]);
  eq('一般句號照樣切', r.segments.length, 1);
}
{
  // 英文句點結尾（非小數）也要照切
  const en = { translation_status: 'none', language: 'en' };
  const s = newSeg();
  const r = s.push([
    tok('The quarterly budget review is scheduled for next Tuesday morning with the whole team.', en),
  ]);
  eq('英文句點照樣切', r.segments.length, 1);
}

console.log('\n' + (failures ? failures + ' 項 FAIL' : '全部 PASS'));
process.exit(failures ? 1 : 0);
