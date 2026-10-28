/**
 * 麥克風沒聲音／斷了的監看（mic-watch.js）。
 *
 * 訊號照實測的形狀合成：
 *   正常安靜＝11.44 Hz、振幅 165 的低頻波＋小雜訊；音量 0＝只剩低頻波。
 * 最要釘住的是「按掉 → 聲音回來 → 又沒聲音 → 要再喊一次」：
 * 按一次就整場失明的壞法不噴任何錯。
 *
 * 跑法：
 *   & "C:\Program Files\nodejs\node.exe" app/tools/test_mic_watch.mjs
 */

import { MicWatch } from '../src/v2/js/mic-watch.js';

let failures = 0;
function check(name, ok, detail = '') {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  ← ' + detail : ''));
  if (!ok) failures += 1;
}

// 固定種子的雜訊，結果每次一樣
let seed = 12345;
function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function gauss() {
  return Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
}

let sampleIndex = 0;
/** 一包 10 毫秒（160 個樣本）。noise＝雜訊標準差。 */
function packet(noise) {
  const out = new Int16Array(160);
  for (let i = 0; i < 160; i++, sampleIndex++) {
    const v = 165 * Math.sin((2 * Math.PI * 11.44 * sampleIndex) / 16000) + noise * gauss();
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
  }
  return out.buffer;
}
const QUIET = 8; // 濾後峰值約 20 多，接近實測正常安靜的中位 24
const MUTED = 0.5;

/** 從 t0 起餵 ms 毫秒、每秒 tick 一次，回傳期間所有事件 [{t, ev}]。 */
function run(w, t0, ms, noise) {
  const events = [];
  for (let t = t0; t < t0 + ms; t += 10) {
    if (noise !== null) w.feed(packet(noise), t);
    if (t % 1000 === 0) {
      const ev = w.tick(t);
      if (ev) events.push({ t, ev });
    }
  }
  return events;
}

console.log('=== F1 麥克風監看 ===');

{
  const w = new MicWatch();
  w.reset(0);
  const ev = run(w, 0, 30000, QUIET);
  check('正常安靜 30 秒不喊', ev.length === 0, JSON.stringify(ev));
}

{
  const w = new MicWatch();
  w.reset(0);
  const ev = run(w, 0, 20000, MUTED);
  check('音量 0 要喊沒聲音', ev.length === 1 && ev[0].ev.show === 'silent', JSON.stringify(ev));
  check('不早於 10 秒', ev[0] && ev[0].t >= 10000, ev[0] && String(ev[0].t));
  check('不晚於 15 秒', ev[0] && ev[0].t <= 15000, ev[0] && String(ev[0].t));
}

{
  const w = new MicWatch();
  w.reset(0);
  run(w, 0, 15000, MUTED);
  const back = run(w, 15000, 15000, QUIET);
  check('聲音回來要自動收起', back.some((e) => e.ev.hide), JSON.stringify(back));
}

{
  // 最要緊的一條：按掉 → 恢復 → 再沒聲音 → 再喊
  const w = new MicWatch();
  w.reset(0);
  const first = run(w, 0, 12000, MUTED);
  check('第一次喊了', first.some((e) => e.ev.show === 'silent'));
  w.dismiss();
  const still = run(w, 12000, 20000, MUTED);
  check('按掉之後、還沒恢復前不再喊', still.length === 0, JSON.stringify(still));
  const back = run(w, 32000, 15000, QUIET);
  check('恢復時不必再收（已經收了）', back.length === 0, JSON.stringify(back));
  const again = run(w, 47000, 15000, MUTED);
  check('恢復後再沒聲音要再喊一次', again.some((e) => e.ev.show === 'silent'), JSON.stringify(again));
}

{
  const w = new MicWatch();
  w.reset(0);
  run(w, 0, 5000, QUIET);
  const gone = run(w, 5000, 5000, null); // 不餵封包
  const g = gone.find((e) => e.ev.show === 'gone');
  check('3 秒沒封包要喊斷了', Boolean(g), JSON.stringify(gone));
  check('3–5 秒內喊', g && g.t - 5000 >= 3000 && g.t - 5000 <= 5000, g && String(g.t));
  const back = run(w, 10000, 3000, QUIET);
  check('封包回來要收起', back.some((e) => e.ev.hide), JSON.stringify(back));
}

{
  const w = new MicWatch();
  w.reset(0);
  run(w, 0, 12000, MUTED); // 已在喊沒聲音
  const gone = run(w, 12000, 5000, null);
  check('沒聲音之後再斷線，要改喊斷了', gone.some((e) => e.ev.show === 'gone'), JSON.stringify(gone));
}

{
  // 休息：後端不送封包好幾分鐘，接回時 reset，不准誤報斷線
  const w = new MicWatch();
  w.reset(0);
  run(w, 0, 5000, QUIET);
  w.reset(300000);
  const ev = run(w, 300000, 2000, QUIET);
  check('休息接回 reset 後不誤報斷線', ev.length === 0, JSON.stringify(ev));
  const ev2 = run(w, 302000, 5000, MUTED);
  check('接回後未滿 10 秒不判沒聲音', ev2.length === 0, JSON.stringify(ev2));
}

{
  // 審查抓到：按掉沒聲音之後被拔線，原本整個不喊
  const w = new MicWatch();
  w.reset(0);
  run(w, 0, 12000, MUTED);
  w.dismiss();
  const gone = run(w, 12000, 5000, null);
  check('按掉沒聲音之後再斷線，照樣喊斷了', gone.some((e) => e.ev.show === 'gone'), JSON.stringify(gone));
}

{
  const w = new MicWatch();
  w.reset(0);
  run(w, 0, 3000, QUIET);
  check('log 摘要有包數與門檻', /300 包.*門檻 9/.test(w.summary()), w.summary());
  // 計數表算出來的中位數要跟逐包排序的一樣（準到 0.1）
  const v = new MicWatch();
  v.reset(0);
  for (let k = 0; k < 2001; k++) {
    const amp = 1 + (k * 37) % 500;
    const s = new Int16Array(160);
    for (let i = 0; i < 160; i++) s[i] = Math.round(amp * Math.sin(i * 0.9));
    v.feed(s.buffer, k * 10);
  }
  const m = /最小 ([\d.]+)、中位 ([\d.]+)/.exec(v.summary());
  const exact = (() => {
    const x = new MicWatch(); x.reset(0); const all = [];
    const f = x._filter;
    for (let k = 0; k < 2001; k++) {
      const amp = 1 + (k * 37) % 500;
      const s = new Int16Array(160);
      for (let i = 0; i < 160; i++) s[i] = Math.round(amp * Math.sin(i * 0.9));
      all.push(f.peak(s));
    }
    all.sort((a, b) => a - b);
    return { min: all[0], med: all[1000] };
  })();
  check('摘要的最小值與逐包排序一致', m && Math.abs(Number(m[1]) - exact.min) < 0.051, m && m[1] + ' vs ' + exact.min.toFixed(2));
  check('摘要的中位數與逐包排序差 ≤0.05', m && Math.abs(Number(m[2]) - exact.med) <= 0.051, m && m[2] + ' vs ' + exact.med.toFixed(2));
  const odd = new Uint8Array(new ArrayBuffer(321), 1, 320);
  let threw = false;
  try { w.feed(odd, 3000); } catch (e) { threw = true; }
  check('起點是奇數位元組不會丟例外', !threw);
}

console.log('=== 接進 capture.js 之後 ===');
{
  const { MeetingCapture } = await import('../src/v2/js/capture.js');
  globalThis.window = { __TAURI__: { core: { invoke: async () => null } } }; // logInfo 會叫 invoke
  let now = 0;
  Date.now = () => now;
  let tickFn = null;
  globalThis.setInterval = (fn) => { tickFn = fn; return 1; };
  globalThis.clearInterval = () => { tickFn = null; };
  const mic = [];
  const capture = new MeetingCapture({
    panel: {}, store: {}, settingsStore: { get: () => ({}) },
    onMicAlert: (k) => mic.push(k),
  });
  const entry = { source: 'mic', label: '【麥克風】', stream: { isLive: true, sendAudio() {} } };
  capture.streams = [entry];
  capture.running = true;
  capture._armMicWatch();
  check('有開麥克風才排每秒計時器', typeof tickFn === 'function');
  for (; now < 12000; now += 10) {
    capture._feedAudio(entry, packet(MUTED));
    if (now % 1000 === 0) tickFn();
  }
  check('音量 0 經 _feedAudio 進來也會喊', mic.includes('silent'), JSON.stringify(mic));

  capture.paused = true; // 模擬休息：後端不送封包
  const before = mic.length;
  for (; now < 60000; now += 1000) tickFn();
  check('休息中不喊（不誤報斷了）', mic.length === before, JSON.stringify(mic.slice(before)));

  capture.paused = false;
  capture._micWatch.reset(now); // resume() 裡做的事
  for (const end = now + 5000; now < end; now += 10) {
    capture._feedAudio(entry, packet(QUIET));
    if (now % 1000 === 0) tickFn();
  }
  check('接回後 5 秒內不誤報', mic.slice(before).every((k) => k === null), JSON.stringify(mic.slice(before)));

  // 監看出錯不准拖累字幕：feed 丟例外時，這一包照樣要送出去
  let sent = 0;
  const e2 = { source: 'mic', label: '【麥克風】', stream: { isLive: true, sendAudio() { sent += 1; } } };
  capture._micWatch = { feed() { throw new Error('boom'); } };
  capture._feedAudio(e2, packet(QUIET));
  capture._feedAudio(e2, packet(QUIET));
  check('監看丟例外時，聲音照樣送去翻譯', sent === 2, String(sent));
  check('監看丟例外後本場停用', capture._micWatch === null);

  const only = new MeetingCapture({ panel: {}, store: {}, settingsStore: { get: () => ({}) } });
  tickFn = null;
  only.streams = [{ source: 'system', stream: {} }];
  only._armMicWatch();
  check('只抓電腦聲音的場次不監看麥克風', tickFn === null && only._micWatch === null);
}

console.log(failures ? `\n${failures} 項失敗` : '\n全部通過');
process.exit(failures ? 1 : 0);
