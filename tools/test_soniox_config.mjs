/**
 * 送給 Soniox 的第一條設定訊息，以及翻譯詞表那一格的文字 ↔ 物件轉換。
 *
 * 為什麼值得一支測試：這個專案已經被「前端送了、對方沒有欄位接、零錯誤訊息」
 * 咬過三次。送出去的形狀錯了，Soniox 那頭就是安靜地當作沒這格——
 * 畫面上一切正常，只是硬詞表／翻譯詞表從來沒有生效過。
 *
 * 跑法：
 *   & "C:\Program Files\nodejs\node.exe" app/tools/test_soniox_config.mjs
 */

import {
  SonioxStream,
  normalizeTranslationTerms,
  parseTranslationTerms,
  formatTranslationTerms,
} from '../src/v2/js/soniox-client.js';

let failures = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (ok ? '' : '  ← got ' + g + ' want ' + w));
  if (!ok) failures += 1;
}
function check(name, ok, detail = '') {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  ← ' + detail : ''));
  if (!ok) failures += 1;
}

/** 只為了拿 _buildConfigMessage；建構子不碰 WebSocket。 */
function build(cfg) {
  const stream = new SonioxStream({ source: 'system', getConfig: () => cfg });
  return stream._buildConfigMessage(cfg);
}

const BASE = { apiKey: 'k', sourceLanguage: 'auto', targetLanguage: 'zh', terms: [] };

console.log('=== ① endpoint 延遲 ===');
{
  const msg = build(BASE);
  eq('max_endpoint_delay_ms 是 2000（官方預設）', msg.max_endpoint_delay_ms, 2000);
  // 🔴 500 會改掉數字本身（64% → 67%、料號 273-09 碎成 73／09），這是實測結果。
  check('沒有退回 500', msg.max_endpoint_delay_ms !== 500);
  // 舊值 3000 沒有人決定過，是 `cfg.endpointDelayMs || 3000` 每次都踩到上限。
  check('沒有退回 3000', msg.max_endpoint_delay_ms !== 3000);
  check('不再看 cfg.endpointDelayMs（那一格從來沒有人給值）',
    build({ ...BASE, endpointDelayMs: 3000 }).max_endpoint_delay_ms === 2000);
}

console.log('\n=== ② context 四格的形狀 ===');
{
  eq('兩格都空就整個 context 不送', build(BASE).context, undefined);

  const onlyTerms = build({ ...BASE, terms: ['Nordwind GmbH', '273-09'] });
  eq('只有硬詞表', onlyTerms.context, { terms: ['Nordwind GmbH', '273-09'] });

  const both = build({
    ...BASE,
    terms: ['Nordwind GmbH'],
    translationTerms: [{ source: 'lead time', target: '前置時間' }],
  });
  eq('兩格都有', both.context, {
    terms: ['Nordwind GmbH'],
    translation_terms: [{ source: 'lead time', target: '前置時間' }],
  });
  // ⚠ domain 不是頂層欄位（是 general 裡的一個 key），送上去只會被忽略。
  check('沒有多送 domain 這個頂層欄位', !('domain' in both.context));
  check('翻譯詞表是物件陣列、不是字串陣列',
    typeof both.context.translation_terms[0] === 'object');
}

console.log('\n=== ③ 壞資料一律丟掉，不送半條上去 ===');
eq('缺 target', normalizeTranslationTerms([{ source: 'a' }]), []);
eq('缺 source', normalizeTranslationTerms([{ target: 'b' }]), []);
eq('空白字串', normalizeTranslationTerms([{ source: '  ', target: 'b' }]), []);
eq('不是陣列', normalizeTranslationTerms('lead time = 前置時間'), []);
eq('null', normalizeTranslationTerms(null), []);
eq('混著好的與壞的，只留好的',
  normalizeTranslationTerms([{ source: 'a', target: '' }, { source: ' b ', target: ' c ' }]),
  [{ source: 'b', target: 'c' }]);

console.log('\n=== ④ 設定頁那一格：文字 ↔ 物件 ===');
eq('半形等號', parseTranslationTerms('lead time = 前置時間'),
  [{ source: 'lead time', target: '前置時間' }]);
// ⚠ 中文輸入法打出來的等號是全形。只認半形就會讓那一行安靜消失。
eq('全形等號', parseTranslationTerms('交期＝前置時間'),
  [{ source: '交期', target: '前置時間' }]);
eq('箭頭', parseTranslationTerms('lead time → 前置時間'),
  [{ source: 'lead time', target: '前置時間' }]);
eq('譯文裡也有等號時只切最前面那個', parseTranslationTerms('交期 = D+30 = 出貨'),
  [{ source: '交期', target: 'D+30 = 出貨' }]);
eq('空行與沒有分隔符的行丟掉', parseTranslationTerms('\n沒有等號的一行\na = b\n  \n'),
  [{ source: 'a', target: 'b' }]);
eq('行首就是等號不成一組', parseTranslationTerms('= b'), []);
eq('往返一趟不變形',
  parseTranslationTerms(formatTranslationTerms([{ source: 'a', target: 'b' }])),
  [{ source: 'a', target: 'b' }]);
eq('空輸入', parseTranslationTerms(''), []);
eq('null 輸入', parseTranslationTerms(null), []);

console.log('\n=== ⑤ 其他欄位沒有被動到 ===');
{
  const msg = build(BASE);
  eq('model', msg.model, 'stt-rt-v5');
  eq('sample_rate', msg.sample_rate, 16000);
  check('說話者分辨仍然開著（預設是關的，要明確送）', msg.enable_speaker_diarization === true);
  eq('翻譯', msg.translation, { type: 'one_way', target_language: 'zh' });
  check('auto 時不送 language_hints', !('language_hints' in msg));
}

console.log('\n=== ⑥ 聲音格式：Opus（ogg）與退回 PCM ===');
{
  // Opus 是包在 ogg 裡送，Soniox 從開頭頁自己認：官方說容器格式用 auto、不帶取樣率與聲道數
  const opus = build2(BASE, true);
  eq('壓縮時 audio_format 是 auto', opus.audio_format, 'auto');
  check('壓縮時不帶 sample_rate／num_channels', !('sample_rate' in opus) && !('num_channels' in opus));
  const pcm = build2(BASE, false);
  eq('退回 PCM 時是 pcm_s16le', pcm.audio_format, 'pcm_s16le');
  check('退回 PCM 時帶 16000 Hz 單聲道（原始格式少了這兩格 Soniox 不知道怎麼讀）',
    pcm.sample_rate === 16000 && pcm.num_channels === 1);
  eq('其餘欄位兩種格式都一樣',
    { ...opus, audio_format: 0 },
    (({ sample_rate, num_channels, ...rest }) => ({ ...rest, audio_format: 0 }))(pcm));
}

function build2(cfg, useOpus) {
  const stream = new SonioxStream({ source: 'system', getConfig: () => cfg });
  return stream._buildConfigMessage(cfg, useOpus);
}

console.log('\n' + (failures ? failures + ' 項 FAIL' : '全部 PASS'));
process.exit(failures ? 1 : 0);
