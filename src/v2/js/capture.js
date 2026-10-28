/**
 * v2 一場會議的開始與結束。
 *
 * 把四樣東西接在一起，接法本身就是本專案的幾條硬規矩：
 *
 *   Rust 錄音／收音 ──(一路一條 Channel)──> SonioxStream ──> SonioxSegmenter
 *                                                              │
 *                                              ┌───────────────┴───────────────┐
 *                                          字幕面板                        記錄庫
 *
 * ⚠ 兩路**從頭到尾不合流**：後端 audio.rs 兩條 Channel、前端兩個 SonioxStream、
 *   兩個 segmenter，`source` 欄位一路貫穿到 json。實測過合流的代價——
 *   兩個人的話擠進一條 mono 會排隊，ASR 然後生出沒人講過的句子。
 *
 * ⚠ 字幕失敗不可以拖累錄音（會議模式禁止靜默降級）：錄音整條在 Rust 那邊，
 *   Soniox 連不上、斷線、金鑰錯，錄音都照跑，而且每一種都要跳看得見的警示。
 */

import { SonioxStream } from './soniox-client.js';
import { logInfo } from './frontend-log.js';
import { MicWatch } from './mic-watch.js';
import { marksToMarkdown, wallClock } from './marks.js';
import { SOURCE_LABEL } from './session-store.js';

/** audio_source 設定 → 這場要開哪幾路，以及各自吃哪一條 Channel。 */
function planStreams(audioSource) {
  switch (audioSource) {
    case 'system':
      return [{ source: 'system', channel: 'channel' }];
    case 'microphone':
      // ⚠ 單一來源時後端把音訊送在 `channel` 上（不是 micChannel），
      //   看 audio.rs 的 match：只有 "both" 才會用到 mic_channel。
      return [{ source: 'mic', channel: 'channel' }];
    case 'both':
      return [
        { source: 'system', channel: 'channel' },
        { source: 'mic', channel: 'micChannel' },
      ];
    default:
      return [];
  }
}

/** 等 WebSocket 接通，最多等這麼久。等不到只是講一聲，錄音早就開始了。 */
const CONNECT_WAIT_MS = 5000;

/**
 * 還沒接通時，最多先暫存多少音訊（見 `_bufferWhileConnecting`）。
 *
 * 48 kHz、立體聲、16 bit = 每秒 192,000 位元組，所以這是**大約十秒**。
 * 挑十秒的理由：握手正常是一兩秒，重連通常幾秒內回來；再長就不划算——
 * 補送一段很久以前的話，字幕會落後到跟不上現場，那時候它已經不是即時字幕了。
 */
const PENDING_MAX_BYTES = 192000 * 10;

/**
 * 開場多久還沒收到電腦的聲音就出聲提醒。
 *
 * 為什麼是「兩分鐘」而不是更短：`them` 那條只在**非靜音**時才送封包
 * （wasapi.rs 的 is_silent），開會前幾十秒沒人講話是常態，更短就會天天誤報。
 * 為什麼要有：錄空一整場的成本是整場會議，發現得越早越好——
 * 收工報告是最後一道網，這是第一道。
 */
const QUIET_START_MS = 120000;

export class MeetingCapture {
  /**
   * @param {object} opts
   * @param {import('./subtitle-panel.js').SubtitlePanel} opts.panel
   * @param {import('./session-store.js').SessionStore} opts.store
   * @param {{get: () => object}} opts.settingsStore
   * @param {(text: string) => void} opts.onStatus 狀態列。
   * @param {(msg: string, fatal: boolean) => void} opts.onAlert 看得見的警示。
   * @param {(running: boolean) => void} opts.onRunning 按鈕狀態。
   * @param {(report: object) => void} opts.onReport 收工報告（stop_capture 回來的東西）。
   * @param {(message: string) => void} opts.onNotice 常駐通知區（紅字）。
   *   ⚠ 不可以拿 onAlert 代替：那是單一格子，下一則會把「這場沒開麥克風」整個洗掉。
   * @param {(items: Array) => Promise<{go:boolean,noRecording:boolean,recordDir:(string|null)}>} opts.onPrecheck
   *   體檢有 warn／fail 時問人要怎麼辦。全綠時**不會被呼叫**。
   * @param {(kind: ('silent'|'gone'|null)) => void} opts.onMicAlert 麥克風沒聲音／斷了，null＝收起。
   *   ⚠ 不可以拿 onAlert 代替：那格會被下一則（重連中、存檔失敗）洗掉，而麥克風沒聲音要一直掛到恢復。
   */
  constructor({ panel, store, settingsStore, onStatus, onAlert, onRunning, onReport, onNotice, onProgress, onPrecheck, onMicAlert }) {
    this.panel = panel;
    this.store = store;
    this.settingsStore = settingsStore;
    this._onStatus = onStatus || (() => {});
    this._onAlert = onAlert || (() => {});
    this._onRunning = onRunning || (() => {});
    this._onReport = onReport || (() => {});
    this._onNotice = onNotice || (() => {});
    // 收尾進度（第 8 條後半）。沒接的話整段照跑、只是沒人看得到——
    // 所以 `stop()` 裡不可以因為「沒接」就跳過那幾行。
    this._onProgress = onProgress || (() => {});
    // 沒有掛 onPrecheck 就是「有問題照開」——但那是呼叫端的決定，
    // 不是這裡偷偷幫它決定的：預設值寫在這裡，看得到。
    this._onPrecheck = onPrecheck || (async () => ({ go: true, noRecording: false, recordDir: null }));
    this.streams = [];
    this.running = false;
    /** 中場休息中。錄音照跑，只有字幕與計費停了。 */
    this.paused = false;
    this._starting = false;
    /** 開場靜默提醒的計時器。⚠ 停止時一定要收掉，否則停止後才跳＝假警報。 */
    this._quietTimer = null;
    this._onMicAlert = onMicAlert || (() => {});
    /** F1 麥克風監看（只在這場真的開了麥克風時才有）與它的每秒計時器。 */
    this._micWatch = null;
    this._micTimer = null;
    /** F2：這場按過「⭐ 標記重點」的時刻（Date.now()），只記時間、字句停止時才補。 */
    this._marks = [];
  }

  get isRunning() {
    return this.running;
  }

  _cfgFor() {
    const s = this.settingsStore.get() || {};
    const ctx = s.custom_context || {};
    return {
      apiKey: s.soniox_api_key || '',
      sourceLanguage: s.source_language || 'auto',
      targetLanguage: s.target_language || 'zh',
      terms: Array.isArray(ctx.terms) ? ctx.terms : [],
      // ⚠ 這一格以前沒撈，於是設定裡就算填了也永遠送不出去（斷三層的第一層）。
      translationTerms: Array.isArray(ctx.translation_terms) ? ctx.translation_terms : [],
    };
  }

  async start() {
    if (this.running || this._starting) return;
    this._starting = true;
    try {
      await this._startInner();
    } finally {
      this._starting = false;
    }
  }

  async _startInner() {
    const settings = this.settingsStore.get() || {};
    const plan = planStreams(settings.audio_source);
    if (!plan.length) {
      this._onAlert('設定裡的「抓哪一路」是「' + settings.audio_source + '」，我不認得這個值。', true);
      return;
    }
    if (!settings.soniox_api_key) {
      // 不擋——沒有金鑰照樣可以只錄音。但要講清楚會發生什麼事。
      this._onAlert('沒有 Soniox 金鑰，這場只會錄音、不會有字幕。', true);
    }

    const { invoke, Channel } = window.__TAURI__.core;

    // 開始前先看一眼這台機器。全綠什麼都不彈（結果只留在紀錄檔），
    // 有 warn／fail 才問人。⚠ 這一步要排在建 Channel 與連 Soniox 之前——
    // 問到一半被取消時，不可以已經有一條連著的串流在那裡計費。
    const decision = await this._runPrecheck(invoke, settings.audio_source);
    if (!decision.go) {
      this._onStatus('沒有開始（開始前的檢查沒過）');
      return;
    }
    const noRecording = Boolean(decision.noRecording);
    const recordDir = decision.recordDir || null;
    // 這場不會留下錄音檔的話，整場都要看得到。
    // ⚠ 用常駐通知區、不用 onAlert：沒有這一行，「刻意關掉錄音」跟「錄音壞掉」
    //   長得一模一樣，而後者是要修的。
    if (noRecording) {
      this._onNotice('⚠ 這場沒有在錄音（你選了「這場不錄」）。只會有字幕，事後沒有音檔可以做正式逐字稿。');
    } else if (!recordDir && (!settings.recording_dir || !String(settings.recording_dir).trim())) {
      // 錄音資料夾是空的時候 Rust 那邊直接不錄，而且不報錯。
      // 實測時整場沒錄到就是走這條路。
      this._onNotice('⚠ 這場沒有在錄音（錄音資料夾是空的）。只會有字幕，事後沒有音檔可以做正式逐字稿。');
    }

    this.panel.clear();
    this.store.init({
      sourceLang: settings.source_language || 'auto',
      targetLang: settings.target_language || 'zh',
    });
    this.store.beginChunk();
    this._marks = [];

    // 一路一條串流，各自連線
    this.streams = plan.map((p) => this._makeStream(p.source));
    this.streams.forEach((s) => s.stream.connect());

    // ⚠ 這裡**刻意不等** Soniox 接通（原本是 `await _waitLive(...)`）。
    //
    // 等待的原意是對的：握手還沒完成時送出去的音訊會被丟掉（`sendAudio` 直接回 false），
    // 開頭那一兩句就不會有字幕。但代價被連坐到錄音上了——`start_capture` 才是
    // 開始寫檔的那一刻，於是「按下開始」到「真的開始錄」之間空掉兩三秒，
    // **而那段聲音不會出現在任何地方，也不會有任何錯誤訊息**（跟「錄音靜默缺一段」同一種病）。
    //
    // 改成：先開音訊與錄音，握手期間的音訊由 `_feedAudio` 暫存，接通後補送。
    // 兩邊都保住——錄音檔從第一秒就完整，字幕開頭也不缺。
    // 連線狀況的警示移到下面，用不擋人的方式講。

    // 建 Channel、接音訊
    const args = { source: settings.audio_source, recordDir, noRecording };
    // 兩條 Channel 都一定要給（Tauri 的 Channel 不能是 optional）。
    // 沒被用到的那條就是永遠收不到東西。
    args.channel = new Channel();
    args.micChannel = new Channel();
    for (const p of plan) {
      const entry = this.streams.find((s) => s.source === p.source);
      // ⚠ 抽成 `_feedAudio` 而不是寫在這裡，唯一的理由是**這樣才測得到**：
      //   寫成閉包的話，「休息中收到一則遲到的音訊」這件事永遠進不了測試
      //   （測試不會真的建 Tauri Channel），而那正是下面要防的競態。
      args[p.channel].onmessage = (pcm) => this._feedAudio(entry, pcm);
    }

    let started = null;
    try {
      started = await invoke('start_capture', args);
    } catch (err) {
      console.error('[capture] start_capture 失敗', err);
      this._onAlert('收音啟動失敗：' + err + '（這場什麼都不會有，請看設定裡的裝置）', true);
      await this._teardownStreams();
      return;
    }

    // **後端實際開了哪幾路才算數**，不是設定說要開哪幾路。
    // 麥克風沒開起來時會議照跑，但這裡有三件事非做不可，少一件就會說謊：
    await this._reconcileStreams(started);

    this.running = true;
    this.paused = false;
    this._armQuietCheck();
    this._armMicWatch();
    this._onRunning(true);
    this._onStatus('收音中｜' + this.streams.map((s) => s.label).join(' ＋ '));

    // 連線狀況的警示。**不 await**：它只負責講話，不決定能不能開始。
    // ⚠ 要在 `this.running` 還是 true 的時候才講——不然使用者開完又立刻停止時，
    //   會在停止之後才跳一則「還沒接上」，那是在報告一個已經不存在的狀態。
    this._waitLive(CONNECT_WAIT_MS).then((allLive) => {
      if (allLive || !this.running) return;
      const notLive = this.streams.filter((s) => s.stream && !s.stream.isLive);
      if (!notLive.length) return;
      this._onAlert(
        notLive.map((s) => s.label).join('、') +
          ' 還沒接上 Soniox。錄音照常在進行，字幕會等它自己重連。',
        true
      );
    });
  }

  /**
   * 跑體檢，決定要不要開始。
   *
   * 回傳 `{ go, noRecording, recordDir }`。
   * ⚠ 體檢本身出錯（command 不見了、Rust 那邊 panic）**不可以當成全綠放行**，
   *   也不可以擋住開會——所以是問人，由人決定。「沒檢查」與「檢查過了」
   *   在畫面上長得一樣，這是這整張網唯一的死法。
   */
  async _runPrecheck(invoke, audioSource) {
    let items = null;
    try {
      // ⚠ `audioSource` 要送**這場真的要開的那個值**，不能讓後端自己去讀設定：
      //   設定頁改完還沒存回去的那一瞬間，兩邊會是不同的值，於是警示會對著
      //   另一個設定講話——而那種錯誤看起來完全正常。
      items = await invoke('precheck', { recordDir: null, audioSource: audioSource || null });
    } catch (err) {
      console.error('[capture] precheck 失敗', err);
      this._onAlert('開始前的檢查跑不起來：' + err + '（不代表沒問題，只代表沒檢查）', true);
      items = [];
    }
    const worst = (items || []).reduce(
      (acc, i) => (i && (i.level === 'fail' || (i.level === 'warn' && acc !== 'fail')) ? i.level : acc),
      'ok'
    );
    // 規矩 1：全綠什麼都不彈。⚠ 空清單不算全綠——那是「沒跑」。
    if (worst === 'ok' && Array.isArray(items) && items.length) {
      return { go: true, noRecording: false, recordDir: null };
    }
    const answer = await this._onPrecheck(items || []);
    return answer || { go: false, noRecording: false, recordDir: null };
  }

  /**
   * 把「設定說要開的」對齊成「後端真的開了的」。
   *
   * 三件事，少一件就會說謊：
   *   ① **把沒開的那條 Soniox 串流收掉**——它在 invoke 之前就連上了，
   *      而一條沒人餵的串流照樣按整條存活時間計費（約 US$0.18／小時買一條
   *      零輸入的串流），畫面上零訊息；不收掉還會裝成「字幕停了」。
   *   ② **狀態列只列真的開了的那幾路**——不然它會在一場沒有麥克風的會議裡
   *      寫著「＋【麥克風】」。
   *   ③ **常駐紅字**（不是 toast、不是警示列：一個三秒就消失、一個會被下一則洗掉）。
   */
  async _reconcileStreams(started) {
    if (!started || !Array.isArray(started.tracks)) return;
    // 後端的軌名是 them／me，前端的來源名是 system／mic。
    const opened = new Set(
      started.tracks.map((t) => (t === 'me' ? 'mic' : t === 'them' ? 'system' : t))
    );
    const orphans = this.streams.filter((s) => !opened.has(s.source));
    this.streams = this.streams.filter((s) => opened.has(s.source));
    for (const s of orphans) {
      try {
        await s.stream.finish();
      } catch (err) {
        console.error('[capture] 收掉沒開起來的那條串流失敗', err);
      }
    }
    if (started.micFailed) {
      this._onNotice(
        '⚠ 這場沒有開麥克風，只有對方的聲音。你講的話不會進字幕、也不會被錄下來。原因：'
          + started.micFailed
      );
    }
  }

  _makeStream(source) {
    const label = source === 'system' ? '【電腦聲音】' : '【麥克風】';
    const stream = new SonioxStream({
      source,
      getConfig: () => this._cfgFor(),
      onSegments: (segments) => {
        this.panel.addSegments(segments);
        for (const seg of segments) this.store.addSegment(seg);
      },
      onPartial: (partial) => this.panel.setPartial(source, partial),
      onState: (state) => {
        if (state === 'reconnecting') this._onStatus(label + '重連中…（錄音沒有中斷）');
      },
      onAlert: (msg, fatal) => this._onAlert(msg, fatal),
    });
    return { source, label, stream };
  }

  /**
   * 開場兩分鐘後回頭看一眼「電腦的聲音」那一路收到東西沒有。
   *
   * ⚠ 這個功能最容易壞的地方不是檢查本身，是**沒有把計時器收掉**：
   *   停止後才跳出來的提醒是假警報，而假警報的代價是以後沒有人看警示——
   *   而且這種壞法不噴任何錯，畫面上就是多了一行看起來很合理的字。
   */
  _armQuietCheck() {
    this._cancelQuietCheck();
    if (!this.streams.some((s) => s.source === 'system')) return; // 只抓麥克風的場次不適用
    this._quietTimer = setTimeout(() => {
      this._quietTimer = null;
      if (!this.running) return; // 雙保險：就算計時器漏收，停掉的場次也不准說話
      const sys = this.streams.find((s) => s.source === 'system');
      if (!sys || sys.packets) return;
      this._onAlert(
        '開場兩分鐘了，還沒收到電腦放出來的聲音。會議的聲音可能沒有走這台電腦'
          + '（用手機開會、投到電視、Windows 的播放裝置選到別的），這樣下去對方那一軌會是空的。',
        true
      );
    }, QUIET_START_MS);
  }

  _cancelQuietCheck() {
    if (this._quietTimer !== null) {
      clearTimeout(this._quietTimer);
      this._quietTimer = null;
    }
  }

  /**
   * 開始監看麥克風（判法與門檻的來由見 mic-watch.js 檔頭）。
   *
   * ⚠ 要排在 `_reconcileStreams` 之後：後端沒開起來的麥克風已經有常駐紅字，
   *   這裡再監看它就會三秒後多喊一句「斷了」，講的是同一件事。
   * ⚠ 只警告、不停止、不換裝置（錄音照常）。
   */
  _armMicWatch() {
    this._cancelMicWatch();
    if (!this.streams.some((s) => s.source === 'mic')) return;
    this._micWatch = new MicWatch();
    this._micWatch.reset(Date.now());
    this._micTimer = setInterval(() => this._tickMicWatch(), 1000);
  }

  _tickMicWatch() {
    // 雙保險：停掉的場次、休息中都不准說話（休息時後端本來就不送封包，會被當成斷了）
    if (!this._micWatch || !this.running || this.paused) return;
    const ev = this._micWatch.tick(Date.now());
    if (!ev) return;
    if (ev.show) {
      logInfo('[麥克風] 警告：' + (ev.show === 'gone' ? '斷了（3 秒沒有封包）' : '10 秒沒聲音'));
      this._onMicAlert(ev.show);
    } else if (ev.hide) {
      logInfo('[麥克風] 恢復');
      this._onMicAlert(null);
    }
  }

  /** 使用者按了「知道了」：收起，恢復之後再沒聲音一樣會再喊。 */
  dismissMicAlert() {
    if (this._micWatch) this._micWatch.dismiss();
    this._onMicAlert(null);
  }

  _cancelMicWatch() {
    if (this._micTimer !== null) {
      clearInterval(this._micTimer);
      this._micTimer = null;
    }
  }

  async _waitLive(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.streams.every((s) => s.stream.isLive)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  /**
   * 一包音訊從後端進來了，送進這一路的串流。
   *
   * ⚠ 休息中 `entry.stream` 是 null（`pause()` 已經收掉它了）。後端那邊也已經擋住不送，
   *   但中間有一段**跨進程的時間差**：`pause_capture` 回來到這裡把 stream 設成 null
   *   之間，後端可能還有一則訊息在路上（它的收音迴圈是 10 毫秒輪詢一次的）。
   *   少這個判斷就是對 null 呼叫方法，丟一個沒人接的 TypeError。
   *
   * 📌 **兩邊各擋一次是刻意的**：這種競態只偶爾發生 ——
   *   「偶爾壞一次、而且只留一行錯誤訊息」是最不會被修的那種壞法，一層擋不住等於沒擋。
   * 📌 休息中的封包**也不計數**：`packets` 是收工報告判斷「這軌到底有沒有錄到」的唯一依據，
   *   把沒送出去的算進去會讓那個判斷變寬。
   */
  _feedAudio(entry, pcm) {
    if (!entry || !entry.stream) return false;
    // 這一路到底有沒有送過東西過來。數字不必準，只分「零」與「非零」。
    entry.packets = (entry.packets || 0) + 1;
    const bytes = new Uint8Array(pcm);
    // ⚠ 監看出錯不准拖累字幕：它排在送 Soniox 之前，不接住的話每包都丟例外＝字幕整條停。
    // 接住之後本場停用監看、寫進 log——警告失效要留得下痕跡，不能安靜消失。
    if (entry.source === 'mic' && this._micWatch) {
      try {
        this._micWatch.feed(bytes, Date.now());
      } catch (err) {
        console.error('[capture] 麥克風監看出錯', err);
        logInfo('[麥克風] 監看出錯、本場停用：' + (err && err.message ? err.message : err));
        this._micWatch = null;
      }
    }
    // 還沒接通（開場握手、或中途重連）：先存著，不要丟。
    // `sendAudio` 在這種時候是**安靜地回 false**，所以少了這一段，
    // 缺的那幾句字幕不會有任何人發現。
    if (!entry.stream.isLive) {
      this._bufferWhileConnecting(entry, bytes);
      return true;
    }
    this._flushPending(entry);
    entry.stream.sendAudio(bytes);
    return true;
  }

  /**
   * 握手／重連期間的音訊暫存。
   *
   * ⚠ **一定要有上限**：連不上時後端每 10 毫秒就送一包，沒有上限的話
   *   一場會議就是把整場音訊堆在瀏覽器記憶體裡，最後整個前端被拖垮——
   *   而那時候使用者看到的只是「字幕停了」，完全不會指向這裡。
   * ⚠ 滿了之後**丟新的、留舊的**：留著的是最接近斷點的那幾秒，補送回去才接得上。
   *   反過來丟舊留新，補送的內容會跟斷點之間空一段，Soniox 會把兩邊當成同一句接起來。
   */
  _bufferWhileConnecting(entry, bytes) {
    if (!entry.pending) {
      entry.pending = [];
      entry.pendingBytes = 0;
    }
    if (entry.pendingBytes + bytes.length > PENDING_MAX_BYTES) {
      if (!entry.pendingOverflow) {
        entry.pendingOverflow = true;
        this._onAlert(
          entry.label + ' 一直接不上 Soniox，這段期間的字幕會缺一塊。錄音沒有受影響。',
          true
        );
      }
      return;
    }
    entry.pending.push(bytes);
    entry.pendingBytes += bytes.length;
  }

  /** 接通了，把暫存的補送出去。順序就是收到的順序。 */
  _flushPending(entry) {
    if (!entry.pending || !entry.pending.length) return;
    // ⚠ 先把佇列換掉再送：`sendAudio` 之後才清的話，送的過程中又有新封包進來
    //   就會被一起清掉（那幾包已經送出去了，但新的那一包還沒）。
    const queued = entry.pending;
    entry.pending = [];
    entry.pendingBytes = 0;
    entry.pendingOverflow = false;
    for (const chunk of queued) entry.stream.sendAudio(chunk);
  }

  /** 現在是不是在中場休息。 */
  isPaused() {
    return Boolean(this.paused);
  }

  /**
   * 中場休息開始。
   *
   * 兩件事同時發生，缺一不可：
   *   - **後端**把音訊丟掉（`pause_capture`），但錄音照寫靜音 →
   *     檔案裡的時間永遠等於真實時間（錄音要保留靜音）。
   *   - **前端**把兩條 Soniox 串流收掉 → 休息不計費。
   *     串流是按整條時長算錢的（`soniox-client.js:11-12`），
   *     不收的話休息一小時就白付一小時。
   *
   * ⚠ **不可以用 `_teardownStreams()`**：那支會把 `this.streams` 清空，
   *   而 `start()` 裡 Channel 的 `onmessage` 閉包抓著的是**那些 entry 物件**
   *   （`entry.stream.sendAudio(...)`）。陣列一換，繼續之後音訊就送進被丟掉的舊串流，
   *   症狀是「繼續以後永遠不再有字幕」，而錄音一切正常、零錯誤訊息。
   *   所以這裡**保留 entry、只換掉裡面的 stream**。
   */
  async pause() {
    if (!this.running || this.paused) return false;

    // 先讓後端停止送，再收串流：反過來的話，收尾途中還有音訊往一條正在關的串流送。
    try {
      await window.__TAURI__.core.invoke('pause_capture');
    } catch (err) {
      console.error('[capture] pause_capture 失敗', err);
      this._onAlert('暫停失敗：' + err + '（還在收音，沒有進入休息）', true);
      return false;
    }

    this.paused = true;
    this._cancelQuietCheck(); // 休息中不准跳「開場兩分鐘沒聲音」，那會是假警報
    this._onMicAlert(null); // 休息中不判斷麥克風；接回時重新計時（resume）

    for (const entry of this.streams) {
      try {
        await entry.stream.finish();
      } catch (err) {
        console.error('[capture] 休息時收串流失敗', err);
      }
      entry.stream = null;
      // 暫存的音訊跟著這條串流一起結束。留著的話會在「繼續」之後被補送出去，
      // 而那是休息**之前**的聲音——接在休息後的第一句前面，字幕就錯位了。
      entry.pending = [];
      entry.pendingBytes = 0;
      entry.pendingOverflow = false;
    }

    logInfo('[休息] 開始：字幕與計費都停了，錄音照寫（檔案長度＝真實時間）');
    this._onStatus('⏸ 休息中｜錄音照常進行，字幕暫停');
    this._onNotice('⏸ 現在是休息中：**錄音沒有停**，但字幕停了。按「繼續」接回同一場。');
    return true;
  }

  /**
   * 休息結束，接回同一場。
   *
   * ⚠ 順序是**先重連 Soniox、再叫後端恢復**。反過來的話，恢復到接通之間那幾百毫秒的
   *   音訊會被送進一條還沒 live 的串流而丟掉（`sendAudio` 在沒 live 時直接回 false），
   *   症狀是「繼續之後第一句話沒有字幕」，同樣零錯誤訊息。
   */
  async resume() {
    if (!this.running || !this.paused) return false;

    this._onStatus('接回中…');
    for (const entry of this.streams) {
      entry.stream = this._makeStream(entry.source).stream;
      entry.stream.connect();
    }

    const live = await this._waitLive(CONNECT_WAIT_MS);
    if (!live) {
      // 不擋著不讓繼續：錄音比字幕重要，串流會自己重連。但要講（不可靜默降級）。
      this._onAlert('接回時 Soniox 還沒接上。錄音已經繼續，字幕會等它自己重連。', true);
    }

    try {
      await window.__TAURI__.core.invoke('resume_capture');
    } catch (err) {
      console.error('[capture] resume_capture 失敗', err);
      this._onAlert('接回失敗：' + err + '（還在休息中，音訊沒有進字幕）', true);
      return false;
    }

    this.paused = false;
    this._armQuietCheck(); // 回來之後再給兩分鐘：休息前已經有聲音的話它本來就不會叫
    // 休息中後端沒送封包：不重新計時的話，接回那一刻就會誤報「麥克風斷了」
    if (this._micWatch) this._micWatch.reset(Date.now());
    logInfo('[休息] 結束：接回同一場');
    this._onStatus('收音中｜' + this.streams.map((s) => s.label).join(' ＋ '));
    this._onNotice('');
    return true;
  }

  async _teardownStreams() {
    const list = this.streams;
    this.streams = [];
    for (const s of list) {
      // ⚠ 休息中停止時 `stream` 是 null（`pause()` 已經收掉了）。
      //   少這個判斷的話，「休息中按停止」會在這裡拋例外，而那條路上還有
      //   存記錄庫與寫副本兩步沒跑 —— 整場的逐字稿會因此掉在地上。
      if (!s.stream) continue;
      try {
        await s.stream.finish();
      } catch (err) {
        console.error('[capture] 串流收尾失敗', err);
      }
    }
  }

  /**
   * 停止。
   *
   * 順序有講究：**先停音訊、再收串流、最後存檔**。
   *   - 先停音訊，Soniox 那邊才不會在收尾途中又收到新的一段。
   *   - 串流收尾會 flush 出「還卡在手上的最後一段」——一個段落要等到下一段開始
   *     或 <end> 才算完成，少了這一步每場會議的最後一句都會消失。
   *   - flush 出來的那幾筆是走 onSegments 進記錄庫的，所以存檔一定要排在最後。
   */
  async stop() {
    if (!this.running) return null;
    this.running = false;
    this.paused = false; // 休息中直接按停止也要收乾淨，否則下一場開起來是「休息中」
    this._cancelQuietCheck(); // 第一件事就收掉，晚一步就可能在停止後跳假警報
    this._cancelMicWatch();
    if (this._micWatch) {
      // 換機器時回頭看門檻有沒有落在對的地方（F1-0 只量過一支麥克風）
      logInfo('[麥克風] ' + this._micWatch.summary());
      this._micWatch = null;
    }
    this._onMicAlert(null);
    this._onRunning(false);
    this._onStatus('收尾中…');

    // 收尾四步的計時（**先量再做，別做假進度條**）。
    // ⚠ 這段只量、不改任何控制流——順序、await、錯誤處理全部原樣。
    //   憑印象掛一條進度條會做出「跑到 90% 卡住」的東西，所以得先知道久的是哪一步。
    // ⚠ 用 `performance.now()` 而不是 `Date.now()`：後者會被系統校時往回撥，
    //   而開會中途剛好校時一次，帳面上就會出現負的耗時。
    const tStart = performance.now();
    let tMark = tStart;
    const steps = [];
    const mark = (name) => {
      const now = performance.now();
      steps.push(name + '=' + Math.round(now - tMark) + 'ms');
      tMark = now;
    };

    // 進度回報（第 8 條後半）。`mark()` 只是量給 log 看的，這幾行是給**人**看的。
    // ⚠ 每一步的編號要跟 `main.js` 的 `STOP_STEP_NAMES` 對齊，那邊是文字、這邊是序號。
    let report = null;
    try {
      this._onProgress(1);
      try {
        report = await window.__TAURI__.core.invoke('stop_capture');
      } catch (err) {
        console.error('[capture] stop_capture 失敗', err);
        this._onAlert('停止收音時出錯：' + err, true);
      }
      mark('①收音訊補檔頭');

      this._onProgress(2);
      await this._teardownStreams();
      this.panel.clearPartials();
      mark('②收串流'); // `clearPartials` 是同步的，量到的幾乎全是收兩條 WebSocket 的時間

      this._onProgress(3);
      const result = await this.store.endSession();
      if (result === 'failed') {
        this._onAlert('這場的紀錄存檔失敗，內容還在畫面上，先別關 App。', true);
      }
      mark('③存記錄庫');

      this._onProgress(4);
      await this._copyTranscriptBesideRecording(report, result);
      await this._saveMarksBesideRecording(report);
      mark('④寫錄音夾副本');
    } finally {
      // ⚠ `finally` 不是保險，是這段的正解：成功、失敗、中途拋例外，三條路都要收掉。
      //   一條停在半路的進度條就是「靜默降級」的視覺版——
      //   它讓人一直等一個已經不會發生的結束，而畫面上什麼錯都沒說。
      this._onProgress(null);
    }

    // 這一行是第 8 條唯一的產出：跑一場之後從 `logs\app-*.log` 撈得到。
    // ⚠ 放在狀態列更新之前，這樣就算 `_summaryText` 出事，計時也已經落地了。
    logInfo('[收尾計時] ' + steps.join(' ')
            + ' 總計=' + Math.round(performance.now() - tStart) + 'ms');

    this._onStatus(this._summaryText(report));
    // 判決要講出來，而且要活得比報告框久——散會時人多半邊收東西邊瞄一眼，
    // 一個「關掉就沒了」的提示等於沒提示。
    //
    // ⚠ 這裡**刻意不再走警示列**（原本兩個地方都送）：
    //   `#alert-line` 與 `#persistent-notice` 是兩個不同的區塊、樣式又幾乎一樣，
    //   所以同一句判決會在畫面上連著出現兩次，看起來像程式壞掉。實測時第一個
    //   問的就是「為什麼說兩次」。常駐通知區留得更久，留它就夠了——掛它的是
    //   `main.js` 的 `showStopReport`（連 micFailed 一起）。
    //   ⤷ 要退回舊行為：把下面兩行的註解拿掉。
    // const verdicts = ((report && report.tracks) || []).map((t) => t.verdict).filter(Boolean);
    // if (verdicts.length) this._onAlert(verdicts.join('　'), true);
    this._onReport(report);
    return report;
  }

  /**
   * 冗餘備份：把這場的逐字稿**再存一份**到該場的錄音資料夾。
   *
   * 為什麼要重複存：記錄庫那一份在 Windows 幫 App 準備的資料夾裡、一場一個檔平鋪，
   * 而錄音在使用者自己指定的資料夾、一場一個夾子。事後要把「這場的稿」對上
   * 「這場的錄音」得在兩邊比時間——沒有人會做這件事。多存一份，那個夾子就自己完整了。
   *
   * ⚠ 記錄庫那一份仍是正本，這裡失敗不影響它（存檔早在上面做完了）。
   *   但**失敗要講**（不可靜默降級）：不講的話使用者會以為資料夾裡有稿，其實沒有。
   * ⚠ 三種情況本來就不該寫，而且都不是錯：沒有收工報告、這場沒錄音、這場零句。
   */
  async _copyTranscriptBesideRecording(report, persistResult) {
    const dir = report && report.sessionDir;
    if (!dir || (report && report.recordingOff)) return;
    if (this.store.totalSegmentCount() === 0) return;
    if (persistResult === 'failed') return; // 正本都沒存成功，副本沒有意義
    try {
      await window.__TAURI__.core.invoke('save_transcript_beside_recording', {
        dir: String(dir),
        mdContent: this.store.markdown(),
      });
    } catch (err) {
      console.error('[capture] 逐字稿副本寫入失敗', err);
      this._onAlert(
        '這場的紀錄已存進記錄庫，但錄音資料夾裡那份副本沒寫成功：' + err,
        true
      );
    }
  }

  /** F2：按一下「⭐ 標記重點」。收音中才算，回傳這場目前共幾個。 */
  addMark(nowMs = Date.now()) {
    if (!this.running) return 0;
    this._marks.push(nowMs);
    logInfo('[重點標記] 第 ' + this._marks.length + ' 個 ' + wallClock(nowMs));
    return this._marks.length;
  }

  /**
   * 停止時把標記寫成錄音資料夾裡的 `重點標記.md`。
   * ⚠ 存不了要講（不可靜默降級），而且把時間點直接講在畫面上——那是這些標記僅剩的一份。
   */
  async _saveMarksBesideRecording(report) {
    if (!this._marks.length) return;
    const times = this._marks.map(wallClock).join('、');
    const dir = report && report.sessionDir;
    if (!dir || report.recordingOff) {
      this._onNotice('⚠ 這場按了 ' + this._marks.length + ' 個重點標記，但沒有錄音資料夾可以存：' + times);
      return;
    }
    const md = marksToMarkdown(this._marks, this.store.allRows(), {
      sessionStartMs: this.store.createdAtMs,
      sourceLabel: SOURCE_LABEL,
    });
    try {
      await window.__TAURI__.core.invoke('save_marks_beside_recording', {
        dir: String(dir),
        mdContent: md,
      });
      logInfo('[重點標記] 已存 ' + this._marks.length + ' 個');
    } catch (err) {
      console.error('[capture] 重點標記寫入失敗', err);
      this._onNotice('⚠ 重點標記沒存成功（' + err + '）。時間點：' + times);
    }
  }

  /**
   * 錄音結果寫在狀態列。
   * ⚠ padded 秒數要露出來：那是「靜音補了多少」，錄音的真實時間軸就靠它，
   *   數字不對的時候要能當場看見，而不是事後對不上才發現。
   */
  _summaryText(report) {
    const segs = this.store.totalSegmentCount();
    const tracks = (report && report.tracks) || [];
    if (!tracks.length) {
      // ⚠ 這句只有在「後端一軌都沒回」時才可以出現。舊版是 `!summaries.length`，
      //   後端改回一個物件之後物件沒有 .length，於是每一場都走到這裡，
      //   畫面印出一句看起來很正常、而且完全錯誤的警告——那比 undefined 糟得多。
      return '已停止｜本場 ' + segs + ' 句｜⚠ 沒有收到收工報告';
    }
    if (report.recordingOff) {
      return '已停止｜本場 ' + segs + ' 句｜⚠ 這場沒有錄音（沒有設定錄音資料夾）';
    }
    const parts = tracks.map((t) => {
      // 不帶副檔名：正常停止後資料夾裡是 them.mp3，wav 只有出狀況才留。
      const name = String(t.path || t.track).split(/[\\/]/).pop().replace(/\.wav$/i, '');
      // 欄位名是 camelCase（TrackReport 掛了 #[serde(rename_all = "camelCase")]），
      // 猜錯的話畫面會顯示 undefined。
      if (t.note) return name + '（' + t.note + '）';
      const flag = t.noAudio ? ' ⚠整場沒聲音' : t.diedMidway ? ' ⚠中途停了' : '';
      return (
        name +
        '（' +
        Math.round(t.seconds) +
        ' 秒、補靜音 ' +
        Math.round(t.paddedSeconds || 0) +
        ' 秒' +
        flag +
        '）'
      );
    });
    // 一場一個資料夾之後，光看 them.wav／me.wav 認不出是哪一場。
    // 資料夾名由後端給——前端不再自己從路徑切一份，免得兩邊各記一份、久了對不上。
    const dir = String(report.sessionDir || '').split(/[\\/]/).filter(Boolean).pop();
    const folder = dir ? '｜資料夾 ' + dir : '';
    return '已停止｜本場 ' + segs + ' 句' + folder + '｜錄音：' + parts.join('、');
  }
}
