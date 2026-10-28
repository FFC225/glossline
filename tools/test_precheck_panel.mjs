/**
 * 開始前自我檢查的呈現規則測試。
 *
 * 只測 renderPrecheckModel()——「什麼時候該打擾人、該給他哪幾顆按鈕」的全部規則，
 * 純函式、沒有 DOM，node 直接跑得動。
 * ⚠ DOM 那半邊（畫進 #precheck-modal、四顆按鈕的迴圈、換資料夾之後重跑）
 *   **沒有自動測試**，要靠實際跑 App 看。誠實標著，別以為全綠＝這張網沒問題。
 *
 * 跑法：
 *   & "C:\Program Files\nodejs\node.exe" app/tools/test_precheck_panel.mjs
 */

import { renderPrecheckModel } from '../src/v2/js/precheck-panel.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  ← ' + detail : ''));
  if (!ok) failures += 1;
}

const item = (key, level, label = key) => ({ key, label, level, detail: key + ' 的說明' });

const allGreen = [
  item('windows', 'ok'),
  item('output', 'ok'),
  item('input', 'ok'),
  item('recording_dir', 'ok'),
  item('writable', 'ok'),
  item('disk', 'ok'),
];

/* ① 全綠不打擾人。這是整個自我檢查最重要的一條：一個每次都要按確定的框，
      兩週內就會變成沒人讀的東西，那時候它連真的有問題那一次也擋不住。 */
{
  const m = renderPrecheckModel(allGreen);
  check('全綠不彈框', m.needsAsking === false && m.level === 'ok');
  check('全綠也不給換資料夾', m.canRetarget === false);
  check('六項都留在清單上', m.rows.length === 6);
}

/* ② 空清單不算全綠——那是「沒檢查」。兩者在畫面上長得一樣，
      這是這張網唯一的死法。 */
{
  const m = renderPrecheckModel([]);
  check('空清單要問人', m.needsAsking === true, JSON.stringify(m.level));
  check('空清單不可以說成全綠', m.level !== 'ok');
  check('空清單要講「沒有檢查」', m.headline.includes('沒有檢查'));
}
{
  const m = renderPrecheckModel(null);
  check('null 也當成沒檢查', m.needsAsking === true && m.level !== 'ok');
}

/* ③ 有黃的要問，但不給「換資料夾」——沒有麥克風換資料夾一點用都沒有，
      一顆按了不會有幫助的按鈕會教人以後不看這個框。 */
{
  const m = renderPrecheckModel([
    item('output', 'ok'),
    item('input', 'warn', '找不到麥克風'),
    item('recording_dir', 'ok'),
  ]);
  check('有黃的要問人', m.needsAsking === true && m.level === 'warn');
  check('黃的不給換資料夾', m.canRetarget === false);
}

/* ④ 只有「寫不進去」紅的時候才給換資料夾那條路。 */
{
  const m = renderPrecheckModel([
    item('recording_dir', 'ok'),
    item('writable', 'fail', '沒辦法在這個位置存檔'),
    item('disk', 'ok'),
  ]);
  check('寫不進去＝fail', m.level === 'fail');
  check('寫不進去才給換資料夾', m.canRetarget === true);
  check('紅的講得比黃的重', m.headline.includes('白錄'));
}

/* ⑤ 別的紅（沒有播放裝置）不給換資料夾——那條路解決不了它。 */
{
  const m = renderPrecheckModel([item('output', 'fail'), item('writable', 'ok')]);
  check('沒有播放裝置是 fail', m.level === 'fail');
  check('但不給換資料夾', m.canRetarget === false);
}

/* ⑥ fail 蓋過 warn：清單裡混著兩種時，整體等級是紅的，不是黃的。 */
{
  const m = renderPrecheckModel([item('input', 'warn'), item('writable', 'fail')]);
  check('紅蓋過黃', m.level === 'fail');
}

/* ⑦ 認不得的 level 一律當成 warn，不可以當成 ok——
      「我看不懂這是什麼」與「一切正常」是兩件事。 */
{
  const m = renderPrecheckModel([item('mystery', 'banana')]);
  check('認不得的等級當成 warn', m.rows[0].level === 'warn' && m.needsAsking === true);
}

/* ⑧ 資料夾是空的那一項照樣要在清單上（黃的），
      它是「設定被存成空的」下次開會前唯一會露臉的地方。 */
{
  const m = renderPrecheckModel([
    item('recording_dir', 'warn', '這場不會留下錄音檔'),
    item('output', 'ok'),
  ]);
  const row = m.rows.find((r) => r.key === 'recording_dir');
  check('資料夾空的那項在清單上', Boolean(row) && row.level === 'warn');
  check('而且會問人', m.needsAsking === true);
}

/* ⑨ 授權碼拿掉之後，沒有任何一項會收掉「照樣開始」——
      紅的項目都是使用者自己的取捨。這條釘的是「model 不再帶擋人的旗標」，
      免得哪天有人把舊的 blocked 接回來、卻沒有東西會去清它。 */
{
  const m = renderPrecheckModel([
    item('output', 'fail', '找不到任何播放裝置'),
    item('writable', 'fail', '沒辦法在這個位置存檔'),
  ]);
  check('紅的也不帶擋人旗標', !('blocked' in m));
  check('但換資料夾那條路要給', m.canRetarget === true);
}
{
  const m = renderPrecheckModel([]);
  check('空清單照樣要問人', m.needsAsking === true);
}

/* ⑩ 錄音告知：第一次才會有那一項，而且它**完全不擋人**
      （是一行提示，不是勾選欄）。 */
{
  const m = renderPrecheckModel([
    item('consent', 'warn', '這支程式會錄下會議的聲音'),
    item('output', 'ok'),
  ]);
  check('第一次要講一聲', m.needsConsent === true);
}
{
  // 等級不是判斷依據：哪天後端把它調成別的等級，這行字照樣要出現。
  const m = renderPrecheckModel([
    item('output', 'ok'),
    item('consent', 'ok', '這支程式會錄下會議的聲音'),
  ]);
  check('看的是這一項在不在，不是等級', m.needsConsent === true);
}
{
  // 看過之後後端就不送這一項了，所以清單上沒有 = 不必再講。
  const m = renderPrecheckModel([
    item('output', 'ok'),
    item('input', 'warn', '找不到麥克風'),
  ]);
  check('講過就不再問', m.needsConsent === false);
}

console.log(failures === 0 ? '\n全部通過。' : '\n有 ' + failures + ' 條沒過。');
process.exit(failures === 0 ? 0 : 1);
