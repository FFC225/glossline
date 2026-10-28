/**
 * 這場會議的記錄庫（唯一的真相來源）。
 *
 * 上游 src/js/session-store.js 的骨架幾乎原樣沿用——autosave 用「距離上次存檔多久」
 * 而不是固定 interval、用單調遞增的 mutation 計數判髒、persist 串成一條 chain 避免
 * 兩次 save_session 撞同一個 .tmp——這三件它都寫對了，沒有理由重寫。
 *
 * 換掉的是**存什麼**：
 *   舊的一筆是 { ts, src, tgt }，而且 app.js 只在「收到譯文」時才呼叫 addSegment，
 *   於是講中文那 8 句 100% 沒進檔案（實測與抓包坐實：講目標語言時
 *   Soniox 送零個 translation token）。
 *   新的一筆吃 segmenter 定下來的 segment 形狀，**tgt 可以是 null 且那是合法狀態**。
 *
 * ⚠ 這支刻意不在模組頂層碰 window.__TAURI__：那樣就沒辦法用 node 離線測，
 *   而「配對有沒有錯開、中文段有沒有落地」正是本專案最需要機械驗收的地方。
 *   實際執行時 invoke 預設接 Tauri，測試時由呼叫端注入一個假的。
 */

const AUTOSAVE_MS = 15000;

function defaultInvoke(cmd, args) {
  return window.__TAURI__.core.invoke(cmd, args);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 來源代號 → 給人看的字。兩路的分別是本專案唯一可靠的「誰在講」。 */
export const SOURCE_LABEL = { system: '電腦聲音', mic: '麥克風' };

/**
 * segment → 存檔用的一筆。**純函式**，給 node 測。
 *
 * @param {object} seg segmenter 產出的 segment 形狀。
 * @param {object} ctx
 * @param {number} ctx.sessionStartMs 這場會議開始的時刻（Date.now()）。
 * @param {number} ctx.nowMs 這一筆抵達的時刻。
 *
 * ⚠ 時間戳有兩套，別混用：
 *   - `t_ms`：**牆上時鐘**距離本場開始的毫秒，SRT 就是用它排的。
 *   - `start_ms`／`end_ms`：Soniox 那條串流自己的時鐘。兩路各自從 0 起算，
 *     而且重連會歸零 —— 拿它排整場的時間軸會排出一個「看起來很精確、其實錯的」
 *     字幕檔。存著只為了回頭對照抓包資料。
 */
export function segmentToRow(seg, { sessionStartMs, nowMs }) {
  const d = new Date(nowMs);
  const hasTrans = seg.translationText !== null && seg.translationText !== undefined;
  return {
    ts: pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()),
    src: seg.originalText === null || seg.originalText === undefined ? '' : seg.originalText,
    // null = 這段講的就是目標語言，Soniox 不送譯文。空字串與 null 是兩件事，
    // 壓成 '' 就再也分不出「沒有譯文」與「譯文是空的」。
    tgt: hasTrans ? seg.translationText : null,
    t_ms: Math.max(0, nowMs - sessionStartMs),
    who: seg.source || null,
    spk: seg.speaker === undefined ? null : seg.speaker,
    from: seg.from === undefined ? null : seg.from,
    raw: seg.translationRaw === undefined ? null : seg.translationRaw,
    start_ms: seg.startMs === undefined ? null : seg.startMs,
    end_ms: seg.endMs === undefined ? null : seg.endMs,
  };
}

export class SessionStore {
  constructor({ invoke } = {}) {
    this._invoke = invoke || defaultInvoke;
    this.id = null;
    this.createdAt = null;
    this.createdAtMs = 0;
    this.endedAt = null;
    this.title = '';
    this.engine = 'soniox';
    this.sourceLang = '';
    this.targetLang = '';
    this.chunks = [];
    this.currentChunk = null;
    this._mutations = 0;
    this._persistedMutations = 0;
    this._persistChain = Promise.resolve();
    this._lastPersistAt = 0;
    this._autosaveTimer = null;
    /** 存檔失敗要讓人看見（不可靜默降級）。呼叫端塞一個會吼的函式進來。 */
    this.onPersistError = null;
  }

  init({ sourceLang, targetLang } = {}) {
    this._cancelAutosave();
    const now = new Date();
    this.id = this._generateId(now);
    this.createdAt = now.toISOString();
    this.createdAtMs = now.getTime();
    this.endedAt = null;
    this.title = '';
    this.sourceLang = sourceLang || '';
    this.targetLang = targetLang || '';
    this.chunks = [];
    this.currentChunk = null;
    this._mutations = 0;
    this._persistedMutations = 0;
    this._persistChain = Promise.resolve();
    this._lastPersistAt = now.getTime();
    return this.id;
  }

  beginChunk() {
    this.currentChunk = {
      started_at: new Date().toISOString(),
      ended_at: null,
      segments: [],
    };
  }

  /**
   * 收一筆定稿 segment。
   *
   * ⚠ 這裡**不做任何「值不值得存」的判斷**。舊 app.js 就是在這一層自作主張
   *   （沒有譯文就不存、超過 10 秒沒等到譯文就丟掉），結果是整批中文靜靜消失。
   *   要不要顯示是畫面的事，存檔一律照收。
   */
  addSegment(seg, nowMs = Date.now()) {
    if (!this.id) throw new Error('[session] addSegment() 在 init() 之前被呼叫');
    if (!this.currentChunk) this.beginChunk();
    this.currentChunk.segments.push(
      segmentToRow(seg, { sessionStartMs: this.createdAtMs, nowMs })
    );
    this._mutations += 1;
    this._scheduleAutosave();
  }

  endChunk() {
    this._cancelAutosave();
    if (!this.currentChunk) return;
    this.currentChunk.ended_at = new Date().toISOString();
    if (this.currentChunk.segments.length > 0) {
      this.chunks.push(this.currentChunk);
      this._mutations += 1;
    }
    this.currentChunk = null;
  }

  /** 對外的存檔入口。串成一條 chain，兩次 save_session 不會重疊。 */
  persist() {
    const link = this._persistChain.then(() => this._persistNow());
    this._persistChain = link.catch(() => {});
    return link;
  }

  async _persistNow() {
    if (this._mutations === this._persistedMutations || this.totalSegmentCount() === 0) {
      return 'skipped';
    }
    const gen = this._mutations;
    if (!this.title) this.title = this._autoTitle();
    try {
      await this._invoke('save_session', {
        id: this.id,
        mdContent: this._toMarkdown(),
        jsonData: this._toJson(),
      });
      this._persistedMutations = gen;
      this._lastPersistAt = Date.now();
      return 'saved';
    } catch (err) {
      // ⚠ 只印 console 等於沒講。存檔失敗＝這場會議的紀錄正在流失，
      //   是本專案定義的「不可靜默」那一類。
      console.error('[session] 存檔失敗：', err);
      if (typeof this.onPersistError === 'function') this.onPersistError(err);
      return 'failed';
    }
  }

  async endSession() {
    this.endChunk();
    this.endedAt = new Date().toISOString();
    this._mutations += 1;
    return this.persist();
  }

  isEmpty() {
    return this.totalSegmentCount() === 0;
  }

  /**
   * 給人看的那一份 Markdown。
   *
   * ⚠ 跟存進記錄庫的是**同一個產生器**，不是另外寫一份長得像的。
   *   兩個產生器早晚會分岔，而分岔的樣子是「兩份稿內容不一樣」、零錯誤訊息。
   */
  markdown() {
    return this._toMarkdown();
  }

  /** 整場逐句（含進行中那段），F2 停止時拿來補重點標記的字句。 */
  allRows() {
    return this._allChunks().flatMap((c) => c.segments);
  }

  totalSegmentCount() {
    const finished = this.chunks.reduce((n, c) => n + c.segments.length, 0);
    const live = this.currentChunk ? this.currentChunk.segments.length : 0;
    return finished + live;
  }

  /* ------------------------------ 內部 ------------------------------ */

  _allChunks() {
    if (this.currentChunk && this.currentChunk.segments.length > 0) {
      return [...this.chunks, this.currentChunk];
    }
    return this.chunks;
  }

  _scheduleAutosave() {
    const elapsed = Date.now() - this._lastPersistAt;
    if (elapsed >= AUTOSAVE_MS) {
      this.persist();
    } else if (!this._autosaveTimer) {
      this._autosaveTimer = setTimeout(() => {
        this._autosaveTimer = null;
        this.persist();
      }, AUTOSAVE_MS - elapsed);
    }
  }

  _cancelAutosave() {
    if (this._autosaveTimer) {
      clearTimeout(this._autosaveTimer);
      this._autosaveTimer = null;
    }
  }

  _generateId(d) {
    return (
      String(d.getFullYear()).slice(2) +
      pad2(d.getMonth() + 1) +
      pad2(d.getDate()) +
      '-' +
      pad2(d.getHours()) +
      pad2(d.getMinutes()) +
      pad2(d.getSeconds())
    );
  }

  /**
   * 自動標題：拿第一筆看得懂的字。
   * ⚠ 先看譯文、沒有譯文就用原文——只認譯文的話，整場都講中文的會議會全部叫「未命名」。
   */
  _autoTitle() {
    for (const chunk of this._allChunks()) {
      for (const seg of chunk.segments) {
        const text = (seg.tgt && seg.tgt.trim()) || (seg.src && seg.src.trim());
        if (text) return text.slice(0, 40);
      }
    }
    return '未命名會議';
  }

  _totalDurationSec() {
    let total = 0;
    for (const c of this._allChunks()) {
      if (!c.started_at) continue;
      const start = new Date(c.started_at).getTime();
      let end;
      if (c.ended_at) {
        end = new Date(c.ended_at).getTime();
      } else {
        const last = c.segments[c.segments.length - 1];
        if (!last) continue;
        // 開著的 chunk 用最後一筆的 t_ms 推，這樣當掉的檔案也列得出合理長度
        end = this.createdAtMs + (last.t_ms || 0);
      }
      if (end > start) total += Math.floor((end - start) / 1000);
    }
    return total;
  }

  _toJson() {
    return {
      id: this.id,
      created_at: this.createdAt,
      ended_at: this.endedAt,
      title: this.title || this._autoTitle(),
      engine: this.engine,
      source_lang: this.sourceLang || '',
      target_lang: this.targetLang || '',
      duration_sec: this._totalDurationSec(),
      chunks: this._allChunks(),
    };
  }

  _formatDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return (
      d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
    );
  }

  /**
   * 表頭「開始」專用：到秒。
   *
   * ⚠ 這一秒是會後把字幕時間 `[15:10:55]` 換算成「錄音第幾秒」的**唯一零點**。
   *   錄音資料夾名拿掉秒之後，別處都沒記；
   *   只到分的話會後切片最多差 59 秒，而且零錯誤訊息。
   *   `createdAt` 是在 `start_capture` 之前取的（`capture.js` 先 `store.init()` 再 invoke），
   *   所以它只會比錄音檔的第一格**早**、不會晚，差距是後端開裝置的時間（不到 1 秒）。
   *   段落標題（`## 第 N 段`）仍用 `_formatDateTime`，那是給人看的、不拿來算。
   */
  _formatDateTimeSec(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return this._formatDateTime(iso) + ':' + pad2(d.getSeconds());
  }

  _formatDuration(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return h + ' 小時 ' + m + ' 分';
    if (m > 0) return m + ' 分 ' + s + ' 秒';
    return s + ' 秒';
  }

  /**
   * 給人看的那一份。事後整理會議紀錄的人讀的是這個檔，
   * 所以「這句是誰講的」與「這句沒有譯文」都要看得出來，不能只留一行字。
   */
  _toMarkdown() {
    const nl = String.fromCharCode(10);
    const lines = [];
    lines.push('# ' + (this.title || this._autoTitle()));
    lines.push('');
    lines.push(
      '**引擎**：' + this.engine +
        '　**語言**：' + (this.sourceLang || '自動') + ' → ' + (this.targetLang || '?') +
        '　**開始**：' + this._formatDateTimeSec(this.createdAt) +
        '　**長度**：' + this._formatDuration(this._totalDurationSec())
    );
    lines.push('');
    // 錄音告知：這一行**跟著檔案走**，而檔案會被轉寄、被丟進別的工具、
    // 被三個月後的另一個人打開。那時候「這段話是錄下來的、裡面有別人的聲音」
    // 這件事，只有檔案自己講得出來——當初在畫面上講過的那一句早就沒了。
    lines.push(
      '> ⚠ 本檔含會議錄音的逐字內容，可能包含第三人的個人資料。' +
        '請依貴公司的個資與保密規定保管，不要任意轉傳。'
    );
    lines.push('');

    const all = this._allChunks();
    for (let i = 0; i < all.length; i += 1) {
      const chunk = all[i];
      const startStr = this._formatDateTime(chunk.started_at).slice(11);
      const endStr = chunk.ended_at ? this._formatDateTime(chunk.ended_at).slice(11) : '進行中';
      lines.push('## 第 ' + (i + 1) + ' 段 — ' + startStr + ' – ' + endStr);
      lines.push('');
      for (const seg of chunk.segments) {
        const who = SOURCE_LABEL[seg.who] || '未知來源';
        lines.push('[' + seg.ts + '] 【' + who + '】' + seg.src);
        if (seg.tgt === null || seg.tgt === undefined) {
          // 標出來，不要留白。留白的話事後看檔的人分不出
          // 「翻譯掉了」與「本來就不需要翻譯」。
          lines.push('→ （原文即目標語言，Soniox 不送譯文）');
        } else {
          lines.push('→ ' + seg.tgt);
        }
        lines.push('');
      }
    }
    return lines.join(nl);
  }
}
