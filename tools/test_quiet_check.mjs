/**
 * 開場兩分鐘沒收到電腦聲音就提醒的計時器行為。
 *
 * 這支測的不是「兩分鐘準不準」，是**那個計時器會不會在不該說話的時候說話**：
 * 停止之後才跳出來的提醒是假警報，而假警報的代價是以後沒有人看警示。
 * 這種壞法不噴任何錯——畫面上只是多了一行看起來很合理的字，所以只能靠測試釘住。
 *
 * 做法：把 globalThis.setTimeout／clearTimeout 換掉，抓住那個 callback 自己叫，
 * 不必真的等兩分鐘。
 *
 * 跑法：
 *   & "C:\Program Files\nodejs\node.exe" app/tools/test_quiet_check.mjs
 */

import { MeetingCapture } from '../src/v2/js/capture.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  ← ' + detail : ''));
  if (!ok) failures += 1;
}

/** 抓住 setTimeout 的 callback，不真的等。 */
function fakeClock() {
  const state = { fired: null, delay: null, cleared: [], nextId: 1 };
  globalThis.setTimeout = (fn, delay) => {
    state.fired = fn;
    state.delay = delay;
    return state.nextId++;
  };
  globalThis.clearTimeout = (id) => state.cleared.push(id);
  return state;
}

function makeCapture() {
  const alerts = [];
  const capture = new MeetingCapture({
    panel: { clear() {}, clearPartials() {}, addSegments() {}, setPartial() {} },
    store: { init() {}, beginChunk() {}, addSegment() {}, endSession() {}, totalSegmentCount: () => 0 },
    settingsStore: { get: () => ({}) },
    onAlert: (msg, fatal) => alerts.push({ msg, fatal }),
  });
  return { capture, alerts };
}

console.log('=== 開場沒聲音的提醒 ===');

/* ① 兩分鐘到了、系統那一路一包都沒收到 → 要講話 */
{
  const clock = fakeClock();
  const { capture, alerts } = makeCapture();
  capture.streams = [{ source: 'system', label: '【電腦聲音】', packets: 0 }];
  capture.running = true;
  capture._armQuietCheck();
  check('排的是兩分鐘', clock.delay === 120000, String(clock.delay));
  clock.fired();
  check('沒收到聲音要喊', alerts.length === 1, JSON.stringify(alerts));
  check('要標成顯眼的', alerts[0] && alerts[0].fatal === true);
}

/* ② 收到過聲音 → 不准講話（不然天天誤報） */
{
  const clock = fakeClock();
  const { capture, alerts } = makeCapture();
  capture.streams = [{ source: 'system', packets: 37 }];
  capture.running = true;
  capture._armQuietCheck();
  clock.fired();
  check('有聲音就不出聲', alerts.length === 0, JSON.stringify(alerts));
}

/* ③ ⭐ 最重要的一條：已經停止的場次，計時器就算漏收也不准說話 */
{
  const clock = fakeClock();
  const { capture, alerts } = makeCapture();
  capture.streams = [{ source: 'system', packets: 0 }];
  capture.running = true;
  capture._armQuietCheck();
  capture.running = false; // 模擬「停止了、但 callback 已經在路上」
  clock.fired();
  check('停止之後不可以跳假警報', alerts.length === 0, JSON.stringify(alerts));
}

/* ④ 停止時真的有把計時器收掉（不是只靠 ③ 那道保險） */
{
  const clock = fakeClock();
  const { capture } = makeCapture();
  capture.streams = [{ source: 'system', packets: 0 }];
  capture.running = true;
  capture._armQuietCheck();
  capture._cancelQuietCheck();
  check('計時器有被 clearTimeout', clock.cleared.length === 1, JSON.stringify(clock.cleared));
  check('收完就不留把手', capture._quietTimer === null);
}

/* ⑤ 只抓麥克風的場次根本不排這個檢查（那一路本來就沒有「電腦的聲音」） */
{
  const clock = fakeClock();
  const { capture } = makeCapture();
  capture.streams = [{ source: 'mic', packets: 0 }];
  capture.running = true;
  capture._armQuietCheck();
  check('只收麥克風時不排計時器', clock.fired === null && capture._quietTimer === null);
}

console.log(failures === 0 ? '\n全部通過。' : '\n有 ' + failures + ' 條沒過。');
process.exit(failures === 0 ? 0 : 1);
