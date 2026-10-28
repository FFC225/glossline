/**
 * 握手／重連期間的音訊暫存。
 *
 * 背景：原本 `start()` 會 `await _waitLive(...)` 等 Soniox 接通才叫 `start_capture`，
 * 於是「按下開始」到「真的開始錄」之間空掉兩三秒 —— 那段聲音不在任何檔案裡，
 * 也沒有任何錯誤訊息。改成先開錄音、握手期間的音訊暫存、接通後補送。
 *
 * 這支釘的是那個暫存的四種壞法，每一種都不會噴錯：
 *   ① 沒接通就把音訊丟掉 → 開頭幾句永遠沒有字幕
 *   ② 接通後忘了補送 → 同上，而且更難發現（後面的字幕都正常）
 *   ③ 暫存沒有上限 → 連不上時把整場音訊堆在記憶體裡，最後前端被拖垮
 *   ④ 休息時沒清掉暫存 → 接回之後補送休息前的聲音，字幕整段錯位
 *
 * 跑法：
 *   & "C:\Program Files\nodejs\node.exe" app/tools/test_connect_buffer.mjs
 */

import { MeetingCapture } from '../src/v2/js/capture.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  ← ' + detail : ''));
  if (!ok) failures += 1;
}

function fakeTauri() {
  globalThis.window = {
    __TAURI__: {
      core: { invoke: async () => 1 },
    },
  };
}

/** 一條假串流。`isLive` 可以中途切換，模擬「連上了」。 */
function fakeStream() {
  return {
    isLive: false,
    sent: [],
    sendAudio(bytes) {
      if (!this.isLive) return false;
      this.sent.push(bytes.length);
      return true;
    },
    finish() { return Promise.resolve(); },
    connect() {},
  };
}

function makeCapture() {
  const alerts = [];
  const capture = new MeetingCapture({
    panel: { clear() {}, clearPartials() {}, addSegments() {}, setPartial() {} },
    store: {
      init() {}, beginChunk() {}, addSegment() {},
      endSession: async () => 'ok', totalSegmentCount: () => 0, markdown: () => '',
    },
    settingsStore: { get: () => ({}) },
    onAlert: (msg, fatal) => alerts.push({ msg, fatal }),
    onStatus: () => {},
    onNotice: () => {},
  });
  capture._makeStream = (source) => ({ source, label: source, stream: fakeStream() });
  capture._waitLive = async () => true;
  return { capture, alerts };
}

function arm(capture) {
  const entry = { source: 'system', label: '【電腦聲音】', packets: 0, stream: fakeStream() };
  capture.streams = [entry];
  capture.running = true;
  capture.paused = false;
  return entry;
}

/** 每秒 192,000 位元組（48 kHz 立體聲 16 bit），所以這是「幾秒的音訊」。 */
const ONE_SECOND = 192000;

console.log('=== 握手期間的音訊暫存 ===');

/* ① 還沒接通：不送、但也不丟 */
{
  fakeTauri();
  const { capture } = makeCapture();
  const entry = arm(capture);

  capture._feedAudio(entry, new ArrayBuffer(1000));
  capture._feedAudio(entry, new ArrayBuffer(2000));

  check('沒接通時一個位元組都沒送出去', entry.stream.sent.length === 0);
  check('但是存起來了，不是丟掉', entry.pendingBytes === 3000, String(entry.pendingBytes));
  check('封包照樣計數（收工報告要看這一路有沒有聲音）', entry.packets === 2, String(entry.packets));
}

/* ② 接通的那一刻：暫存的要補送，而且順序不能亂 */
{
  fakeTauri();
  const { capture } = makeCapture();
  const entry = arm(capture);

  capture._feedAudio(entry, new ArrayBuffer(100));
  capture._feedAudio(entry, new ArrayBuffer(200));
  entry.stream.isLive = true;
  capture._feedAudio(entry, new ArrayBuffer(300));

  check('⭐ 三包都送出去了（不是只送接通後那一包）', entry.stream.sent.length === 3,
        JSON.stringify(entry.stream.sent));
  check('⭐ 順序就是收到的順序', JSON.stringify(entry.stream.sent) === '[100,200,300]',
        JSON.stringify(entry.stream.sent));
  check('補送完暫存要清空', entry.pendingBytes === 0, String(entry.pendingBytes));

  capture._feedAudio(entry, new ArrayBuffer(400));
  check('⭐ 已經補送過的不會再送第二次', entry.stream.sent.length === 4,
        JSON.stringify(entry.stream.sent));
}

/* ③ 一直連不上：暫存要停在上限，而且只講一次 */
{
  fakeTauri();
  const { capture, alerts } = makeCapture();
  const entry = arm(capture);

  // 十五秒的音訊灌進去，上限是十秒。
  for (let i = 0; i < 15; i += 1) capture._feedAudio(entry, new ArrayBuffer(ONE_SECOND));

  check('⭐ 暫存有上限（不會把整場堆在記憶體裡）',
        entry.pendingBytes <= ONE_SECOND * 10, String(entry.pendingBytes));
  check('⭐ 留下來的是先到的那幾秒（補送回去才接得上斷點）',
        entry.pendingBytes === ONE_SECOND * 10, String(entry.pendingBytes));
  check('⭐ 滿了要講一聲', alerts.length === 1, JSON.stringify(alerts));
  check('而且只講一次（每包都講 = 一秒鐘洗版一百次）', alerts.length === 1, String(alerts.length));
  check('那句話要說清楚「錄音沒事」', alerts[0] && alerts[0].msg.includes('錄音'), JSON.stringify(alerts[0]));
}

/* ④ 休息：暫存要跟著結束 */
{
  fakeTauri();
  const { capture } = makeCapture();
  const entry = arm(capture);

  capture._feedAudio(entry, new ArrayBuffer(5000)); // 休息前、還沒接通 → 進暫存
  check('（前提）休息前確實有東西在暫存', entry.pendingBytes === 5000, String(entry.pendingBytes));

  await capture.pause();
  check('⭐ 休息會把暫存清掉', !entry.pendingBytes, String(entry.pendingBytes));

  await capture.resume();
  entry.stream.isLive = true;
  capture._feedAudio(entry, new ArrayBuffer(70));
  check('⭐ 接回之後不會補送休息前的聲音（那會讓字幕整段錯位）',
        JSON.stringify(entry.stream.sent) === '[70]', JSON.stringify(entry.stream.sent));
}

console.log(failures ? `\n${failures} 項失敗` : '\n全部通過');
process.exit(failures ? 1 : 0);
