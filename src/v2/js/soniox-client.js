/**
 * 一路 Soniox 即時串流的連線層。
 *
 * 一路一個實例（電腦播出的聲音一條、麥克風一條），各自有自己的 WebSocket
 * 與自己的 SonioxSegmenter。⚠ 兩路**不可以**合成一條送 ASR——實測那會排隊，
 * 而且會把兩個人的話揉成一句沒人講過的話。
 *
 * 解析（token → segment）不在這裡，在 soniox-segmenter.js。這支只管「線」：
 * 連線、送音訊、keepalive、斷線警示、正確收尾。
 *
 * ⚠ 成本（官方 limits 頁 ＋ keepalive 頁明載「billed for the entire stream duration」）：
 *   **一條串流約 US$0.18/hr，兩路就是 US$0.36/hr，而且沒人講話的時間照樣計費。**
 *   所以「開著不用」是會燒錢的，不是零成本。
 */

import { SonioxSegmenter } from './soniox-segmenter.js';
import { toTraditional as defaultToTraditional } from './s2t.js';
import { OpusOggEncoder, opusSupported } from './ogg-opus.js';
import { logInfo } from './frontend-log.js';

const ENDPOINT = 'wss://stt-rt.soniox.com/transcribe-websocket';

/**
 * 送 Soniox 的聲音先壓成 Opus 24 kbps（ogg）。一律開、沒有開關。
 *
 * 實測結果：一路每小時 115 MB → 約 11 MB，
 * 延遲不變，字幕差異與「同一份 PCM 送兩次」同一水準；最難那段盲測重聽 8:7。
 * 這台 WebView2 不支援、或編碼器中途壞掉 → 改送原始 PCM，**畫面講出來**（流量會變大，字幕照常）。
 */
const SAMPLE_RATE = 16000; // Rust 送進前端的是 16 kHz 單聲道 s16le
const OPUS_BITRATE = 24000;
const OPUS_READY = opusSupported(SAMPLE_RATE, OPUS_BITRATE);
/**
 * 編碼器壞過一次，這次開 App 就都送 PCM、不再試。
 * ⚠ 放模組層、不放實例：休息→繼續會換一個新的 SonioxClient（capture.js resume），
 *   放實例上的話每次繼續都會再壞一次、多跳兩條警告。
 */
let codecFailed = false;

/**
 * keepalive 間隔。
 *
 * 官方 connection-keepalive 頁：「Send at least once every 20 seconds when not
 * sending audio」、「If no keepalive or audio is received for >20s, the
 * connection may be closed.」15 秒是留餘裕。
 *
 * ⚠ 這不是保險、是必需品：喇叭那一路在沒有聲音播放時**完全沒有封包**
 *   （實測：端點閒置時二十秒零封包，這是 WASAPI 的行為，不是 bug）。
 *   會議中對方沉默 20 秒是很平常的事，少了 keepalive 就會被伺服器踢掉，
 *   然後我們得靠重連救回來——而重連期間講的話是真的沒了。
 */
const KEEPALIVE_INTERVAL_MS = 15000;

/**
 * 一句話講完之後，最多等多久才強制定稿。
 *
 * 2000 是 Soniox 官方預設。⚠ 這個值以前是 3000，而那個 3000 **沒有人決定過**：
 * `_cfgFor()` 從來不給 `endpointDelayMs`，於是 `|| 3000` 每次都踩到，
 * 等於永遠用上限跑。四組並行實測：
 *   - 3000 / 2000 的中文字幕延遲是 0.82 / 0.74 秒，25 個數字逐個相同；
 *     聽出來的字 946 vs 941，差在結尾一個誰都聽不清的英文詞。
 *   - 🔴 **不可以改成 500**。它不只是把句子切碎，是**改掉值**：
 *     `64%` 變 `67%`、料號 `273-09` 碎成 `73`／`09`、尾款 `2642000`
 *     碎成 `2 67 2 6 2`。省不到延遲（也是 0.74 秒），代價卻是數字錯。
 */
const MAX_ENDPOINT_DELAY_MS = 2000;

const MAX_RECONNECT = 3;
const RECONNECT_DELAY_MS = 2000;

/** 收尾每一步的等待上限。等不到就往下走，不能卡在這裡不放手。 */
const CLOSE_STEP_TIMEOUT_MS = 3000;

/*
 * ⚠ 刻意**不做**上游那個「每 3 分鐘重開一條連線」（舊 soniox.js:23
 *   SESSION_DURATION_MS = 3 * 60 * 1000 的 _seamlessReset）。三個理由：
 *
 *   1. 沒有必要。官方 limits 頁：「Each real-time session is capped at 300 minutes」。
 *      上限是 5 小時，不是 3 分鐘。一場會議一條串流就夠了。
 *   2. 它會製造重疊計費。上游關舊連線的方式是送一個空 frame，而實測
 *      送空 frame 之後**伺服器沒有回 finished、也沒有關閉**，一路掛到 20 秒後
 *      吐 408 request_timeout。官方明載整條串流的時間都要計費
 *      → 每 3 分鐘就多付 20 秒、還是兩路一起。
 *   3. 它是「舊串流多開 36 秒、零輸出」這個未解症狀最像的來源。
 *      ⚠ 仍是推論、沒有坐實（也可能是抓包腳本送 b"" 與瀏覽器
 *        ArrayBuffer(0) 不等價）。但既然這個機制本來就不需要，就不要留著它。
 *      📌 官方 websocket-api 頁坐實第 2 點的根因：空的 binary frame
 *        「is an empty audio chunk and does not end the stream」，要送空字串 text frame。
 *
 *   若真有超過 300 分鐘的會議，那時再做接續——而且要照官方三步收尾，別只送空 frame。
 */

/**
 * 把設定裡的翻譯詞表整理成 Soniox 要的 `[{source, target}]`。
 *
 * ⚠ 兩邊都要擋：設定檔是使用者自己會去編的 JSON，而**送出去的形狀錯了不會噴錯**
 *   ——Soniox 那頭就是安靜地當作沒這格（本專案已經被這個病咬過三次）。
 *   所以只要有一格是空的就整條丟掉，寧可少送也不要送一條壞的。
 */
export function normalizeTranslationTerms(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const source = typeof item.source === 'string' ? item.source.trim() : '';
    const target = typeof item.target === 'string' ? item.target.trim() : '';
    if (!source || !target) continue;
    out.push({ source, target });
  }
  return out;
}

/**
 * 設定頁那一格的文字 → `[{source, target}]`。一行一組，寫成「原文 = 譯文」。
 *
 * 分隔符收三種（`=`／`＝`／`→`），因為中文輸入法打出來的等號是**全形**，
 * 而使用者不會知道我們只認半形那一個——認錯的下場是那一行安靜地消失。
 * ⚠ 只切最前面那一個分隔符：譯文裡本來就可能有等號（`交期 = D+30`）。
 * ⚠ 沒有分隔符的行不成一組、會被丟掉。丟掉沒問題，**不講才有問題**——
 *   呼叫端（main.js 的存檔）要比對行數並跟使用者講一聲。
 */
export function parseTranslationTerms(raw) {
  const out = [];
  for (const line of String(raw === null || raw === undefined ? '' : raw).split('\n')) {
    const text = line.trim();
    if (!text) continue;
    let cut = -1;
    for (const sep of ['=', '＝', '→']) {
      const i = text.indexOf(sep);
      if (i > 0 && (cut === -1 || i < cut)) cut = i;
    }
    if (cut === -1) continue;
    out.push({ source: text.slice(0, cut).trim(), target: text.slice(cut + 1).trim() });
  }
  return normalizeTranslationTerms(out);
}

/** 反方向：`[{source, target}]` → 設定頁那一格的文字。 */
export function formatTranslationTerms(list) {
  return normalizeTranslationTerms(list)
    .map((t) => t.source + ' = ' + t.target)
    .join('\n');
}

/** @typedef {'idle'|'connecting'|'live'|'reconnecting'|'closing'|'closed'|'error'} StreamState */

export class SonioxStream {
  /**
   * @param {object} opts
   * @param {'system'|'mic'} opts.source 哪一路。
   * @param {() => object} opts.getConfig 回傳連線設定（見 _buildConfigMessage）。
   *   用函式而不是物件，這樣重連時拿到的是當下的設定、不是開場快照。
   * @param {(segments: Array<object>) => void} opts.onSegments 定稿段落（可能一次多筆）。
   * @param {(partial: object|null) => void} opts.onPartial 暫時字幕。
   * @param {(state: StreamState, detail?: string) => void} opts.onState 狀態變化。
   * @param {(message: string, fatal: boolean) => void} opts.onAlert
   *   要讓人看見的警示。⚠ 會議模式禁止靜默降級，所以斷線、重連、
   *   放棄重連**每一次都要走這裡**，不能只寫 console。
   * @param {(s: string) => string} [opts.toTraditional] 簡→繁轉換器。
   *   預設接上 s2t.js。Soniox 官方語言表只有 `zh`、不分繁簡，
   *   所以譯文一定是簡體，轉繁是常態、不是選配——預設就要接上，
   *   免得哪個呼叫端忘了傳就安靜地吐簡體出來。
   */
  constructor({
    source,
    getConfig,
    onSegments,
    onPartial,
    onState,
    onAlert,
    toTraditional = defaultToTraditional,
  }) {
    this.source = source;
    this._getConfig = getConfig;
    this._onSegments = onSegments || (() => {});
    this._onPartial = onPartial || (() => {});
    this._onState = onState || (() => {});
    this._onAlert = onAlert || (() => {});

    this.segmenter = new SonioxSegmenter({ source, toTraditional });

    this.ws = null;
    this.state = 'idle';
    this._keepaliveTimer = null;
    this._reconnects = 0;
    this._intentionalClose = false;
    /** 收尾時等特定訊息用的一次性掛鉤。 */
    this._waiters = [];
    /** 這條連線的 Opus 編碼器（每次 connect 換新的；null＝送原始 PCM）。 */
    this._encoder = null;
    this._pcmNoticeShown = false;
  }

  get isLive() {
    return this.state === 'live' && this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  _setState(state, detail) {
    this.state = state;
    this._onState(state, detail);
  }

  /**
   * 組出連線的第一條訊息。
   *
   * ⚠ 只送 Soniox 認得的欄位。這個專案已經被「前端送了、對方沒有欄位接、
   *   零錯誤訊息」咬過三次（Rust Settings 的五個頂層欄位、CustomContext 的三格），
   *   對 Soniox 這一側同樣適用。
   */
  _buildConfigMessage(cfg, useOpus) {
    // ⚠ 不放 api_key：金鑰在 connect() 的 protocols list 裡送（兩處都放會被回 400）。
    // ogg 由 Soniox 自己從開頭頁認格式（官方：容器格式用 auto，不帶取樣率與聲道數）。
    const audio = useOpus
      ? { audio_format: 'auto' }
      : { audio_format: 'pcm_s16le', sample_rate: SAMPLE_RATE, num_channels: 1 };
    const msg = {
      model: 'stt-rt-v5',
      ...audio,
      enable_endpoint_detection: true,
      max_endpoint_delay_ms: MAX_ENDPOINT_DELAY_MS,
      // ⚠ 開著，但**分段不拿 speaker 當鍵**（見 segmenter 的 class 註解）。
      // 留著是因為「哪一句是誰講的」寫進記錄檔有價值，丟了就回不來。
      enable_speaker_diarization: true,
      enable_language_identification: true,
    };

    if (cfg.sourceLanguage && cfg.sourceLanguage !== 'auto') {
      msg.language_hints = [cfg.sourceLanguage];
    }
    if (cfg.targetLanguage) {
      msg.translation = { type: 'one_way', target_language: cfg.targetLanguage };
    }
    // ⚠ `context` 的四格照官方 docs/stt/concepts/context：general / text / terms /
    //   translation_terms。`domain` **不是**頂層欄位（是 general 裡的一個 key），
    //   `translation_terms` 是**物件陣列** `[{source, target}]`、不是字串陣列。
    //   整包 context 上限 10,000 字元。
    const context = {};
    const terms = Array.isArray(cfg.terms) ? cfg.terms.filter(Boolean) : [];
    if (terms.length) {
      // 會議專有名詞（人名、公司、料號）。這是硬詞表那一格——只影響「聽成什麼字」。
      context.terms = terms;
    }
    const translationTerms = normalizeTranslationTerms(cfg.translationTerms);
    if (translationTerms.length) {
      // 指定某個詞要翻成什麼。跟 terms 是兩件事：terms 管聽、這格管譯。
      context.translation_terms = translationTerms;
    }
    if (Object.keys(context).length) {
      msg.context = context;
    }
    return msg;
  }

  connect() {
    this._intentionalClose = false;
    const cfg = this._getConfig();
    if (!cfg || !cfg.apiKey) {
      this._setState('error', '沒有 API key');
      this._onAlert('沒有 Soniox API key，' + this._label() + '這一路不會有字幕。', true);
      return;
    }

    this._setState('connecting');
    let ws;
    try {
      // 官方 websocket-authentication：瀏覽器（含 Tauri webview）設不了 header，
      //   金鑰放 protocols list。設定訊息的 api_key 已棄用，2027-01-15 起只放那裡會被拒。
      ws = new WebSocket(ENDPOINT, ['soniox-api-key', cfg.apiKey]);
    } catch (err) {
      this._setState('error', String(err));
      this._onAlert(this._label() + '連線建立失敗：' + err, true);
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = async () => {
      // 每條連線一個新的 ogg（Soniox 要先看到開頭頁），所以編碼器跟著連線開
      const supported = await OPUS_READY;
      // ⚠ 先確認這條還是現役再開編碼器：等待期間若已換成新連線，在這裡開會把新連線的編碼器關掉
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      const useOpus = !codecFailed && supported && this._openEncoder(ws);
      if (!useOpus && !this._pcmNoticeShown) {
        this._pcmNoticeShown = true;
        this._onAlert(
          this._label() + '省流量模式沒有啟用，這場送原始聲音（流量約大十倍）。字幕不受影響。',
          false
        );
      }
      try {
        ws.send(JSON.stringify(this._buildConfigMessage(cfg, useOpus)));
      } catch (err) {
        this._onAlert(this._label() + '送出設定失敗：' + err, true);
        return;
      }
      this._reconnects = 0;
      // 成功路徑也要留痕跡：不然事後無從確認「這場到底有沒有壓縮」
      logInfo(this._label() + '接上 Soniox，送' + (useOpus ? ' Opus 24 kbps（省流量）' : '原始 PCM'));
      this._setState('live');
      this._startKeepalive();
    };

    ws.onmessage = (event) => this._handleMessage(event.data);

    ws.onerror = () => {
      // onerror 拿不到有用的細節，真正的判斷留給 onclose
      console.error('[soniox/' + this.source + '] WebSocket error');
    };

    ws.onclose = (event) => {
      this._stopKeepalive();
      if (this.ws === ws) this._closeEncoder();
      if (this._intentionalClose) {
        this._setState('closed');
        return;
      }
      // 非預期斷線。⚠ 會議模式禁止靜默降級：不可以靜默退回什麼都不做。
      this._onAlert(
        this._label() + '串流斷線（代碼 ' + event.code + '）。錄音沒有中斷，字幕正在重連。',
        false
      );
      this._scheduleReconnect();
    };
  }

  _label() {
    return this.source === 'system' ? '【電腦聲音】' : '【麥克風】';
  }

  /** 開這條連線的編碼器。開不起來回 false（呼叫端改送 PCM）。 */
  _openEncoder(ws) {
    this._closeEncoder();
    try {
      this._encoder = new OpusOggEncoder({
        sampleRate: SAMPLE_RATE,
        bitrate: OPUS_BITRATE,
        onPage: (page) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(page);
        },
        onError: (err) => this._onCodecError(ws, err),
      });
      return true;
    } catch (err) {
      console.error('[soniox/' + this.source + '] Opus 編碼器開不起來', err);
      codecFailed = true;
      this._encoder = null;
      return false;
    }
  }

  _closeEncoder() {
    if (this._encoder) this._encoder.close();
    this._encoder = null;
  }

  /**
   * 編碼器中途壞了。這條連線已經宣告是 ogg、不能半路改送 PCM，
   * 所以關掉讓它走重連，重連時 `codecFailed` 會讓它改用 PCM。
   * ⚠ 不可以只是停止送：那會是「字幕停了、錄音正常、零錯誤訊息」。
   * 收尾途中壞的不在此限：不會重連，講「會接回來」是騙人的，關掉也只會讓收尾白等。
   */
  _onCodecError(ws, err) {
    console.error('[soniox/' + this.source + '] Opus 編碼器出錯', err);
    codecFailed = true;
    if (this._intentionalClose) return;
    this._pcmNoticeShown = true;
    this._onAlert(
      this._label() + '省流量壓縮出錯，改送原始聲音重連（流量約大十倍）。字幕會接回來。',
      false
    );
    if (this.ws === ws) {
      this._closeEncoder();
      try {
        ws.close(4000, 'codec failed');
      } catch (_err) {
        // 關不掉的話 onclose 不會來；但下一包 sendAudio 會因為 isLive 為 false 而被暫存
      }
    }
  }

  _handleMessage(raw) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      console.error('[soniox/' + this.source + '] 收到不是 JSON 的訊息', err);
      return;
    }

    // 先讓收尾流程的等待者看一眼（finished / <fin> 都在這裡認）
    this._notifyWaiters(data);

    if (data.error_code) {
      // ⚠ 顯眼警示，不靜默。408 request_timeout 代表閒置超過 20 秒沒送東西，
      // 那就是 keepalive 沒發揮作用，屬於我們的 bug、不是網路問題。
      const msg =
        this._label() + 'Soniox 回報錯誤 ' + data.error_code + '：' + (data.error_message || '');
      console.error('[soniox/' + this.source + '] ' + msg, data);
      this._onAlert(msg, true);
      this._setState('error', String(data.error_code));
      return;
    }

    const tokens = data.tokens || [];
    if (!tokens.length) return;

    const { segments, partial } = this.segmenter.push(tokens);
    if (segments.length) this._onSegments(segments);
    this._onPartial(partial);
  }

  /** 餵一塊 PCM（16 kHz mono s16le）。來源是 Rust 的 audio Channel。有編碼器就先壓再送。 */
  sendAudio(bytes) {
    if (!this.isLive) return false;
    try {
      if (this._encoder) this._encoder.push(bytes);
      else this.ws.send(bytes);
      return true;
    } catch (err) {
      console.error('[soniox/' + this.source + '] 送音訊失敗', err);
      return false;
    }
  }

  _startKeepalive() {
    this._stopKeepalive();
    this._keepaliveTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'keepalive' }));
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  _stopKeepalive() {
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
  }

  _scheduleReconnect() {
    if (this._reconnects >= MAX_RECONNECT) {
      this._setState('error', '重連次數用盡');
      this._onAlert(
        this._label() + '重連 ' + MAX_RECONNECT + ' 次都失敗，這一路的字幕停了。' +
          '錄音仍在繼續，會議紀錄可以事後補。',
        true
      );
      return;
    }
    this._reconnects += 1;
    this._setState('reconnecting', this._reconnects + '/' + MAX_RECONNECT);
    setTimeout(() => {
      if (!this._intentionalClose) this.connect();
    }, RECONNECT_DELAY_MS);
  }

  /* ------------------------------ 收尾 ------------------------------ */

  /** 掛一個一次性條件，等某種訊息出現。 */
  _waitFor(predicate, timeoutMs) {
    return new Promise((resolve) => {
      const entry = { predicate, resolve: null, done: false };
      const finish = (ok) => {
        if (entry.done) return;
        entry.done = true;
        this._waiters = this._waiters.filter((w) => w !== entry);
        resolve(ok);
      };
      entry.resolve = finish;
      this._waiters.push(entry);
      setTimeout(() => finish(false), timeoutMs);
    });
  }

  _notifyWaiters(data) {
    for (const w of [...this._waiters]) {
      try {
        if (w.predicate(data)) w.resolve(true);
      } catch (err) {
        console.error('[soniox/' + this.source + '] waiter 判斷失敗', err);
      }
    }
  }

  /**
   * 正確收尾。⚠ 三步，不能只送空 frame。
   *
   * 依據（實測 ＋ 官方文件）：
   *   - 官方 manual-finalization 頁：送 {"type":"finalize"}，伺服器回
   *     {"text":"<fin>","is_final":true}，把還沒定稿的 token 逼出來。
   *   - 官方 websocket-api 頁：送「空字串 text frame」之後伺服器回一個帶
   *     "finished": true 的訊息，然後關閉連線。⚠ 空的 binary frame 只是一段空音訊、
   *     不會結束串流——下面那條「掛 20 秒吃 408」就是送錯成 binary 的結果。
   *   - ⚠ 實測只送空 frame 的結果：**沒有 finished、沒有關閉**，掛到 20 秒後
   *     吐 408，而且最後 2.76 秒的音訊從未被定稿（final_audio_proc_ms 101520
   *     < total_audio_proc_ms 104280）。少了 finalize，每場會議的最後一句都有
   *     可能不見，而且不會有任何提示。
   *
   * 最後不管有沒有等到，都把 segmenter 手上的東西 flush 出來——
   * 一個段落要等到「下一段開始」或 <end> 才算完成，所以最後一段永遠卡在手上。
   */
  async finish() {
    this._intentionalClose = true;
    this._setState('closing');
    this._stopKeepalive();

    const open = this.ws && this.ws.readyState === WebSocket.OPEN;
    if (open) {
      try {
        // 第零步：編碼器手上還壓著最後幾十毫秒，先擠出來送掉，不然最後一個字會少一截
        // ⚠ 跟另外兩步一樣要有逾時：卡在這裡＝停止流程後面存記錄庫、寫副本都不會跑
        if (this._encoder) {
          const flushed = await Promise.race([
            this._encoder.flush().then(() => true),
            new Promise((r) => setTimeout(() => r(false), CLOSE_STEP_TIMEOUT_MS)),
          ]);
          if (!flushed) console.warn('[soniox/' + this.source + '] 編碼器收尾逾時，最後一小段沒送');
        }

        // 第一步：逼出未定稿的 token
        const finSeen = this._waitFor(
          (d) => (d.tokens || []).some((t) => t.text === '<fin>'),
          CLOSE_STEP_TIMEOUT_MS
        );
        this.ws.send(JSON.stringify({ type: 'finalize' }));
        if (!(await finSeen)) {
          console.warn('[soniox/' + this.source + '] 等不到 <fin>，繼續收尾');
        }

        // 第二步：告知音訊結束
        const finishedSeen = this._waitFor((d) => d.finished === true, CLOSE_STEP_TIMEOUT_MS);
        this.ws.send('');
        if (!(await finishedSeen)) {
          console.warn('[soniox/' + this.source + '] 等不到 finished:true，直接關');
        }
      } catch (err) {
        console.error('[soniox/' + this.source + '] 收尾途中失敗', err);
      }
    }

    // 第三步：關
    try {
      if (this.ws) this.ws.close(1000, 'session end');
    } catch (err) {
      console.error('[soniox/' + this.source + '] 關閉失敗', err);
    }
    this.ws = null;
    this._closeEncoder();

    const tail = this.segmenter.flush();
    if (tail.length) this._onSegments(tail);
    this._onPartial(null);
    this._setState('closed');
    return tail;
  }
}
