/**
 * 收工報告的呈現規則測試。
 *
 * 只測 renderReportModel()——那是「一份報告該長成畫面上的什麼樣子」的全部規則，
 * 純函式、沒有 DOM，node 直接跑得動。
 * ⚠ DOM 那半邊（畫進 #report-modal、開關彈窗）**沒有自動測試**，要靠實際跑 App 看。
 *   誠實標著，別以為全綠＝報告框沒問題。
 *
 * 跑法：
 *   & "C:\Program Files\nodejs\node.exe" app/tools/test_report_panel.mjs
 */

import { renderReportModel } from '../src/v2/js/report-panel.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  ← ' + detail : ''));
  if (!ok) failures += 1;
}

function track(over = {}) {
  return Object.assign(
    {
      track: 'them',
      label: '對方·電腦聲音（them.wav）',
      path: 'C:\\Example\\raw\\meeting-x\\them.wav',
      parts: ['C:\\Example\\raw\\meeting-x\\them.wav'],
      seconds: 3600.4,
      bytes: 691200000,
      paddedSeconds: 2846.4,
      padEvents: 11135,
      packets: 12000,
      silentTailSeconds: 0.2,
      noAudio: false,
      diedMidway: false,
      note: null,
      verdict: null,
    },
    over
  );
}

console.log('=== 收工報告呈現規則 ===');

/* ① 一切正常：不該有任何紅字 */
{
  const m = renderReportModel({
    sessionDir: 'C:\\Example\\raw\\meeting-x',
    recordingOff: false,
    tracks: [track(), track({ track: 'me', label: '你的麥克風（me.wav）', paddedSeconds: 3.8, padEvents: 14 })],
    blindSpot: '說明：對方那一軌綁的是按下開始當時的播放裝置。',
  });
  check('兩軌都在', m.rows.length === 2);
  check('沒有判決', m.rows.every((r) => r.verdict === null));
  check('沒有一軌被標紅', m.rows.every((r) => r.bad === false));
  check('資料夾有帶出來', m.folder === 'C:\\Example\\raw\\meeting-x');
  check('死角說明一定要在', Boolean(m.blindSpot));
  check('補靜音的次數看得到', m.rows[0].detail.includes('11135'), m.rows[0].detail);
  check(
    '最後一包距今多久一定要印（好的時候也要）',
    m.rows[0].detail.includes('最後一包'),
    m.rows[0].detail
  );
}

/* ② 整場沒收到聲音：判決要出現、那一軌要標紅 */
{
  const m = renderReportModel({
    sessionDir: 'D:\\x',
    tracks: [
      track({
        packets: 0,
        noAudio: true,
        verdict: '⚠ 這場沒錄到對方的聲音（them.wav 整場是靜音，別拿去做逐字稿）。',
        verdictDetail: '檔案長度和大小都正常，但裡面從頭到尾是安靜的……',
      }),
    ],
  });
  check('判決有顯示', m.rows[0].verdict.includes('沒錄到對方'));
  check('那一軌標紅', m.rows[0].bad === true);
  check('原因帶得過來（攤開用的）', m.rows[0].verdictDetail.includes('從頭到尾是安靜的'));
  // 結論要短到一眼看得完。實測前那句是 150 字，使用者的原話是
  // 「太長沒人看得完」——而沒被看完的警告等於沒有警告。
  check('結論一句話、不超過 60 字', m.rows[0].verdict.length <= 60, m.rows[0].verdict.length + ' 字');
}

/* ②b 舊的收工報告只有 verdict、沒有 verdictDetail：不可以變成字串 "undefined" */
{
  const m = renderReportModel({
    tracks: [track({ packets: 0, noAudio: true, verdict: '⚠ 沒錄到。' })],
  });
  check('沒有原因時是 null，不是 undefined', m.rows[0].verdictDetail === null, String(m.rows[0].verdictDetail));
}

/* ③ 中途停了（拔麥克風）：封包數是正的，仍然要標紅 */
{
  const m = renderReportModel({
    tracks: [
      track({
        track: 'me',
        packets: 4000,
        silentTailSeconds: 120.0,
        diedMidway: true,
        verdict: '⚠⚠ 麥克風在你按停止前約 2 分鐘就沒再送資料了。',
      }),
    ],
  });
  check('中途停了也算壞', m.rows[0].bad === true);
  check('尾巴秒數印出來', m.rows[0].detail.includes('120.0'), m.rows[0].detail);
}

/* ④ 沒收到收尾回報：不准顯示 0 秒 */
{
  const m = renderReportModel({
    tracks: [track({ seconds: 0, bytes: 0, note: '沒收到收尾回報，但檔案在（12.3 MB）。' })],
  });
  check('走 note、不是 0 秒', m.rows[0].headline.includes('12.3 MB'), m.rows[0].headline);
  check(
    '不可以出現「0 秒」',
    !/(^|[^\d])0 秒/.test(m.rows[0].headline),
    m.rows[0].headline
  );
}

/* ⑤ 後端一軌都沒回：這句才可以出現 */
{
  const m = renderReportModel({ tracks: [] });
  check('空報告要喊', Boolean(m.warn), String(m.warn));
  check('沒有 rows', m.rows.length === 0);
}

/* ⑥ ⚠ 最重要的一條：正常的一場**不可以**掉進 ⑤ 那句話。
      舊前端判的是陣列長度，後端改成回物件之後每一場都會走過去，
      印出一句看起來很正常、而且完全錯誤的警告。 */
{
  const m = renderReportModel({ sessionDir: 'D:\\x', recordingOff: false, tracks: [track()] });
  check('正常的一場沒有那句假警告', m.warn === null, String(m.warn));
}

/* ⑦ 這場根本沒設錄音資料夾 */
{
  const m = renderReportModel({ recordingOff: true, tracks: [track()] });
  check('未錄音要標出來', m.recordingOff === true);
}

/* ⑧ 換過檔（切成好幾份）要講 */
{
  const m = renderReportModel({ tracks: [track({ parts: ['a.wav', 'a-002.wav'] })] });
  check('切成幾份有講', m.rows[0].detail.includes('2 份'), m.rows[0].detail);
}

console.log(failures === 0 ? '\n全部通過。' : '\n有 ' + failures + ' 條沒過。');
process.exit(failures === 0 ? 0 : 1);
