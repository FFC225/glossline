/**
 * 中場休息／接回。
 *
 * 這支釘的全部是「零錯誤訊息」那一類的壞法：
 *   ① 休息時把 `this.streams` 換掉 → 接回之後永遠不再有字幕（Channel 的 onmessage
 *      閉包抓著的是舊 entry），而錄音一切正常。
 *   ② 接回時先叫後端恢復、後接 Soniox → 那幾百毫秒的話被丟掉，
 *      症狀是「繼續之後第一句沒字幕」。
 *   ③ 休息時忘了收 Soniox → 休息一小時白付一小時，帳單月底才看得到。
 *   ④ 休息中按停止 → `stream` 是 null，收尾在半路拋例外，整場逐字稿掉在地上。
 *   ⑤ 暫停失敗卻照改鈕面 → 畫面說「休息中」而其實還在收音、還在計費。
 *
 * 跑法：
 *   & "C:\Program Files\nodejs\node.exe" app/tools/test_pause_resume.mjs
 */

import { MeetingCapture } from '../src/v2/js/capture.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  ← ' + detail : ''));
  if (!ok) failures += 1;
}

/** 把 Tauri 的 invoke 換掉，記下誰被叫過、依什麼順序。 */
function fakeTauri(failOn = null) {
  const calls = [];
  globalThis.window = {
    __TAURI__: {
      core: {
        invoke: async (cmd) => {
          if (cmd === 'log_frontend') return; // 記 log 不算行為，不進 calls
          calls.push(cmd);
          if (cmd === failOn) throw new Error('假裝 ' + cmd + ' 壞了');
          return 1;
        },
      },
    },
  };
  return calls;
}

/** 一條假串流，記得自己被 finish／connect 過幾次。 */
function fakeStream(order, tag) {
  return {
    isLive: true,
    finished: 0,
    connected: 0,
    fed: 0,
    sendAudio() { this.fed += 1; return true; },
    finish() { this.finished += 1; order.push('finish:' + tag); return Promise.resolve(); },
    connect() { this.connected += 1; order.push('connect:' + tag); },
  };
}

function makeCapture(order) {
  const alerts = [];
  const statuses = [];
  const capture = new MeetingCapture({
    panel: { clear() {}, clearPartials() {}, addSegments() {}, setPartial() {} },
    store: {
      init() {}, beginChunk() {}, addSegment() {},
      endSession: async () => 'ok', totalSegmentCount: () => 0, markdown: () => '',
    },
    settingsStore: { get: () => ({}) },
    onAlert: (msg, fatal) => alerts.push({ msg, fatal }),
    onStatus: (s) => statuses.push(s),
    onNotice: () => {},
  });
  // 接回時不要真的去開 WebSocket。
  capture._makeStream = (source) => ({ source, label: source, stream: fakeStream(order, source) });
  capture._waitLive = async () => { order.push('waitLive'); return true; };
  return { capture, alerts, statuses };
}

/** 開一場「已經在收音」的假會議。 */
function arm(capture, order) {
  const entries = [
    { source: 'system', label: '【電腦聲音】', packets: 5, stream: fakeStream(order, 'system') },
    { source: 'mic', label: '【麥克風】', packets: 3, stream: fakeStream(order, 'mic') },
  ];
  capture.streams = entries;
  capture.running = true;
  capture.paused = false;
  return entries;
}

console.log('=== 第 7 條 中場休息／接回 ===');

/* ① 休息：要叫後端、要收兩條串流、**但 entry 物件不可以換掉** */
{
  const order = [];
  const calls = fakeTauri();
  const { capture } = makeCapture(order);
  const entries = arm(capture, order);
  const before = [entries[0], entries[1]];
  const s0 = entries[0].stream;
  const s1 = entries[1].stream;

  const ok = await capture.pause();
  check('回報成功', ok === true);
  check('有叫後端 pause_capture', calls.includes('pause_capture'), JSON.stringify(calls));
  check('兩條串流都收掉了（＝休息不計費）', s0.finished === 1 && s1.finished === 1,
        `system=${s0.finished} mic=${s1.finished}`);
  check('狀態變成休息中', capture.isPaused() === true);
  check('⭐ streams 陣列沒有被清空', capture.streams.length === 2,
        String(capture.streams.length));
  check('⭐ entry 物件是同兩個（Channel 的 onmessage 還指著它們）',
        capture.streams[0] === before[0] && capture.streams[1] === before[1]);
  check('entry 裡的 stream 已經放掉', capture.streams[0].stream === null);
}

/* ② 接回：順序必須是「先接通 Soniox、再叫後端恢復」 */
{
  const order = [];
  const calls = fakeTauri();
  const { capture } = makeCapture(order);
  const entries = arm(capture, order);
  const before = [entries[0], entries[1]];
  await capture.pause();
  order.length = 0;
  calls.length = 0;

  const ok = await capture.resume();
  check('回報成功', ok === true);
  check('有叫後端 resume_capture', calls.includes('resume_capture'), JSON.stringify(calls));
  const iConnect = order.findIndex((x) => x.startsWith('connect:'));
  const iWait = order.indexOf('waitLive');
  check('⭐ 先 connect 再等 live', iConnect >= 0 && iWait > iConnect, order.join(' > '));
  check('⭐ resume_capture 排在接通之後（不然第一句沒字幕）',
        iWait >= 0 && calls.indexOf('resume_capture') >= 0 && order.length > iWait,
        order.join(' > '));
  check('不再是休息中', capture.isPaused() === false);
  check('⭐ entry 物件仍是同兩個', capture.streams[0] === before[0] && capture.streams[1] === before[1]);
  check('每條 entry 都換上新串流', Boolean(capture.streams[0].stream) && Boolean(capture.streams[1].stream));
}

/* ③ 暫停失敗：不可以進入休息狀態，串流也不可以被收掉 */
{
  const order = [];
  fakeTauri('pause_capture');
  const { capture, alerts } = makeCapture(order);
  const entries = arm(capture, order);
  const s0 = entries[0].stream;

  const ok = await capture.pause();
  check('回報失敗', ok === false);
  check('⭐ 沒有進入休息狀態（畫面才不會說謊）', capture.isPaused() === false);
  check('⭐ 串流沒被收掉（還在收音就還要字幕）', s0.finished === 0, String(s0.finished));
  check('有跳警示', alerts.length === 1 && alerts[0].fatal === true, JSON.stringify(alerts));
}

/* ④ 休息中按停止：不可以在收尾半路爆掉 */
{
  const order = [];
  fakeTauri();
  const { capture } = makeCapture(order);
  arm(capture, order);
  await capture.pause();

  let threw = null;
  try {
    await capture.stop();
  } catch (err) {
    threw = err;
  }
  check('⭐ 休息中停止不拋例外（stream 是 null）', threw === null, String(threw));
  check('停止後不再是休息中（下一場才不會一開始就在休息）', capture.isPaused() === false);
  check('停止後 running 是 false', capture.isRunning === false);
}

/* ⑤ 邊界：沒在收音、或重複按，都要安靜地回 false，不可以去動後端 */
{
  const order = [];
  const calls = fakeTauri();
  const { capture } = makeCapture(order);

  check('沒在收音時休息 → false', (await capture.pause()) === false);
  check('沒在收音時接回 → false', (await capture.resume()) === false);
  check('完全沒碰後端', calls.length === 0, JSON.stringify(calls));

  arm(capture, order);
  await capture.pause();
  calls.length = 0;
  check('已經在休息了再按休息 → false', (await capture.pause()) === false);
  check('重複按不會再叫一次後端', calls.length === 0, JSON.stringify(calls));
}

/* ⑥ ⭐ 競態：休息中有一則遲到的音訊從後端送上來。
 *
 * 這條是獨立審查抓出來的。後端的收音迴圈是 10 毫秒輪詢一次，而它每 200 毫秒
 * 把手上的音訊送一次 —— 那段 flush **原本不看暫停旗標**。於是按下休息的瞬間，
 * 殘留在後端手上的音訊可能在前端已經把串流放掉之後才送達。
 *
 * 後端那一半已經修掉（迴圈開頭清空 buffer），這裡釘的是前端這一半：
 * 就算真的有一則遲到的訊息進來，也不可以爆掉。
 */
{
  const order = [];
  fakeTauri();
  const { capture } = makeCapture(order);
  const entries = arm(capture, order);
  const packetsBefore = entries[0].packets;

  // 收音中：正常送進串流
  check('收音中：音訊送得進去', capture._feedAudio(entries[0], new ArrayBuffer(8)) === true);
  check('收音中：封包有計數', entries[0].packets === packetsBefore + 1, String(entries[0].packets));

  await capture.pause();
  const packetsAtPause = entries[0].packets;

  let threw = null;
  let fed = null;
  try {
    fed = capture._feedAudio(entries[0], new ArrayBuffer(8));
  } catch (err) {
    threw = err;
  }
  check('⭐ 休息中遲到的音訊不會爆掉', threw === null, String(threw));
  check('⭐ 休息中的音訊不送出去', fed === false, String(fed));
  check('⭐ 休息中的封包不計數（收工報告靠它判斷有沒有錄到）',
        entries[0].packets === packetsAtPause, String(entries[0].packets));

  await capture.resume();
  check('接回之後音訊又送得進去了', capture._feedAudio(entries[0], new ArrayBuffer(8)) === true);
}

console.log(failures ? `\n${failures} 項失敗` : '\n全部通過');
process.exit(failures ? 1 : 0);
