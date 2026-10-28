/**
 * Soniox token → segment 解析層。
 *
 * 這一支是本專案的核心，也是舊前端最貴的那個 bug 的所在。
 *
 * 舊前端怎麼壞的：
 *   舊 soniox.js 收到 token 陣列的當下，就把它壓成兩條無名字串
 *   （originalText / translationText），speaker / language / is_final / 時間戳全部丟掉，
 *   然後當兩個獨立回呼送出。app.js 拿到那兩條字串時已經沒有任何資訊可用來配對，
 *   只能用先進先出猜 —— 實測 47% 的譯文接在錯誤的原文下面，偏移一旦發生就永遠回不來。
 *
 * 這一支的作法反過來：**原文與譯文在同一個物件裡出生**，所以沒有錯開的可能。
 *
 * 設計依據全部來自實測封包，
 * 每一條規則下面都註明它是哪個結論。⚠ 沒有實測支持的地方也標出來了，別當已知。
 *
 * 這支檔案刻意**不碰 WebSocket、不碰 DOM**，所以能拿實測的 .jsonl 離線重放，
 * 之後改配對邏輯都不必連線、不花錢、不用開麥克風。
 */

/**
 * 沒有譯文的原文段落，累積超過這個字元數就在句末標點切一段。
 *
 * 為什麼需要（實測結論②）：講目標語言（中文）時 Soniox 完全不送譯文，
 * 於是沒有東西會打斷那一段 —— 實測兩段中文各 97／96 字、一段塞 4 句話，
 * 純靠 <end> 沖洗的話字幕會變成「等一段 100 字才出現」。
 *
 * ⚠⚠ 判準是 **translation_status === 'none'**，不是「目前手上還沒有譯文」。
 *   這兩件事看起來一樣，差別要命：譯文本來就比原文晚到，所以「還沒有譯文」
 *   在每一段的中途都是真的。第一版就是這樣寫的，離線重放立刻抓到後果——
 *   `One more thing: the deadline moved from Friday to Monday.`（56 字、以句點結尾）
 *   在譯文抵達之前就被切掉，於是那句的譯文變成一個沒有原文的孤兒段落。
 *   **那正是舊前端錯位的病，只是換我來犯一次。**
 *
 *   實測結論①給了乾淨的判準：`none` = 講的就是目標語言、Soniox **不會**送譯文；
 *   `original` = 會另外送譯文，**絕對不能切**。
 */
const MAX_UNTRANSLATED_CHARS = 40;

/** 句末標點（中英都要）。切段只挑這種位置，免得切在半句話中間。 */
const SENTENCE_END = /[。！？；…!?;]$|[.]$/;

/**
 * 小數點不是句末標點。
 *
 * ⚠ 端到端實測實撞過：
 *   「…料號是A273-09。數量5200件，單價是73.」被切成一段，
 *   「5塊，不良率控制在千分之三以內…」成了下一段。
 *   **匯出成會議紀錄時讀的人只會看到「單價是73」**，而且不會有任何提示。
 *   查 start_ms/end_ms：兩段之間只隔 120 ms —— 人根本沒停，是這條規則自己切的。
 *
 * ⚠ 判準要看**累積文字的結尾**，不能只看單一 token：Soniox 會把
 *   「73.」跟「5塊」拆成不同 token，只看當下那顆看不出它是小數。
 *
 * ⚠ **只擋數字後面的點**。英文縮寫（`Mr.` `U.S.` `No.` `vs.`）同樣會誤切，
 *   但那要另一套規則（要判斷後面接不接大寫字母），**目前沒做**——
 *   而且這條分段規則只在 `translation_status === 'none'`（講的就是目標語言）時生效，
 *   英文段走的是「收到譯文後又來原文」那條路，碰不到這裡。
 */
const DECIMAL_TAIL = /\d\s*[.]$/;

/** 這個累積文字的結尾是真的句末嗎（小數點不算）。 */
function isSentenceEnd(text) {
  const s = String(text || '').trimEnd();
  if (DECIMAL_TAIL.test(s)) return false;
  return SENTENCE_END.test(s);
}

/**
 * Soniox 的兩個控制標記。
 *
 * ⚠ 判斷只能靠 text（實測結論①②）：`<end>` 的 translation_status 也是 "none"，
 *   跟「講目標語言時的原文 token」撞在同一個值上，所以看 status 會判錯。
 *   實測的 <end> 長這樣，沒有 speaker、沒有 language、沒有時間戳：
 *   {"text": "<end>", "confidence": 0.999, "is_final": true, "translation_status": "none"}
 *
 * `<fin>` 只在客戶端送過 {"type":"finalize"} 之後才會出現（官方 manual-finalization 頁）。
 */
const CONTROL_TOKENS = new Set(['<end>', '<fin>']);

/** 這個 token 是譯文側嗎。 */
function isTranslation(token) {
  return token.translation_status === 'translation';
}

/**
 * 這個 token 是原文側嗎。
 *
 * ⚠ 兩個值都要收（實測結論①）：
 *   - "original" = 講了外語、Soniox 會另外送譯文
 *   - "none"     = 講的就是目標語言，Soniox **不送譯文**（實測：中文段零個 translation token）
 *   舊前端只認得有譯文的那種，所以中文那 8 句 100% 沒進檔案。
 */
function isOriginal(token) {
  const st = token.translation_status;
  return st === 'original' || st === 'none';
}

function textOf(tokens) {
  return tokens.map((t) => t.text).join('');
}

function firstDefined(tokens, field) {
  for (const t of tokens) {
    if (t[field] !== undefined && t[field] !== null) return t[field];
  }
  return null;
}

function lastDefined(tokens, field) {
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const v = tokens[i][field];
    if (v !== undefined && v !== null) return v;
  }
  return null;
}

function meanConfidence(tokens) {
  const vals = tokens.map((t) => t.confidence).filter((c) => typeof c === 'number');
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

let seqCounter = 0;

/**
 * 一路串流的解析層。**一條串流一個實例**（系統聲一個、麥克風一個）。
 *
 * 為什麼是兩個實例而不是一個共用的：實測「兩路合成一條送 ASR」會排隊，
 * 而合流點在後端 commands/audio.rs。前端這邊從第一行就照兩路設計，
 * source 欄位一路貫穿到記錄檔，所以「誰講的」不必靠猜。
 *
 * ⭐ 這也是為什麼分段**不用 speaker 當鍵**（只存不用）：
 *   官方 diarization 頁自己寫 realtime 模式有 "temporary speaker switches that
 *   stabilize as more context is available" —— 拿一個會中途改主意的欄位當
 *   「換人就換一段」的依據，會把一句話剖成兩半，而且不噴任何錯。
 *   而「對方 vs 我自己」這個真正要分的區別，兩路串流已經給了。
 *   ⚠ speaker 照樣存進 segment（不丟資料），只是不參與分段。
 *   ⚠ 實測沒有量到翻轉（素材只有一個人講話，全程 speaker='1'）——
 *     這條規則的依據是官方文件，不是我們的實測。
 */
export class SonioxSegmenter {
  /**
   * @param {object} opts
   * @param {'system'|'mic'} opts.source 哪一路。
   * @param {(s: string) => string} [opts.toTraditional] 簡→繁轉換器。
   *   預設原樣回傳。⚠ 轉換點刻意放在 segment 出生的地方、不放渲染層：
   *   放渲染層就會出現「畫面是繁體、匯出檔是簡體」的分裂。
   *
   *   ⭐ **原文與譯文都要過**：Soniox 聽中文吐的是簡體
   *   （實測 `我下个礼拜跟供应商确认…`），只轉譯文的話，講中文那幾段在畫面與
   *   記錄庫都會是簡體，而那正是會議裡最常出現的段落之一。
   *   ⚠ **原文沒有留 raw 那一格**（譯文有 `translationRaw`）：原文轉錯字時的回頭路是
   *   錄音檔本身，不是這個物件。要加的話記得後端 `Segment` 也要同步開欄位。
   */
  constructor({ source, toTraditional } = {}) {
    if (source !== 'system' && source !== 'mic') {
      throw new Error('[segmenter] source 必須是 system 或 mic，收到：' + source);
    }
    this.source = source;
    this._toTraditional = typeof toTraditional === 'function' ? toTraditional : (s) => s;

    /** 尚未定稿的 token。⚠ 整批取代、不能 append（見 push 的註解）。 */
    this._pending = [];
    /** 正在組裝中的 segment。final token 分批抵達，所以這個要跨訊息保留。 */
    this._cur = { orig: [], trans: [] };
    /** 已完成、等著被取走的 segment。 */
    this._out = [];
  }

  /**
   * 餵進一條 Soniox 訊息的 tokens 陣列。
   *
   * ⚠ non-final 是「累積重送」（實測結論③）：伺服器每條訊息都把整個尚未定稿的
   *   陣列從頭重送、逐步長大，定稿時同一批改成 is_final:true。實測樣貌：
   *     [5266ms] Op:" Th" Op:"an"
   *     [5391ms] Op:" Th" Op:"an" Op:"ks"
   *     [6250ms] OF:" Th" OF:"an" OF:"ks" OF:" for" …
   *   所以 pending 必須**整批取代**。若 append，暫時字幕會變成
   *   「Th Than Thanks Thanks for…」這種一路自我重複的爛泥，而且不會噴錯。
   *
   * @param {Array<object>} tokens
   * @returns {{segments: Array<object>, partial: object|null}}
   *   segments = 這次新完成的定稿段落；partial = 目前的暫時字幕（可為 null）。
   */
  push(tokens) {
    const list = Array.isArray(tokens) ? tokens : [];

    // 整批取代（非累加）
    this._pending = list.filter((t) => !t.is_final);

    for (const token of list) {
      if (!token.is_final) continue;
      this._consumeFinal(token);
    }

    const segments = this._out;
    this._out = [];
    return { segments, partial: this._buildPartial() };
  }

  _consumeFinal(token) {
    if (CONTROL_TOKENS.has(token.text)) {
      // 句群邊界：把手上的東西收乾淨
      this._closeCurrent();
      return;
    }

    if (isTranslation(token)) {
      this._cur.trans.push(token);
      return;
    }

    if (!isOriginal(token)) {
      // 未知的 translation_status。丟掉會變成靜默丟資料（不可靜默降級的那一類），
      // 所以當原文收下，並吼一聲讓它進 logs/app-*.log。
      console.warn('[segmenter] 未知的 translation_status，當原文收下：', JSON.stringify(token));
    }

    // 已經收到譯文了，又來原文 → 前一段結束（實測結論⑤：抵達順序是
    // 「一小段原文 → 對應譯文 → 下一段原文」，整齊成對，沒有觀察到跨句錯開）
    if (this._cur.trans.length > 0) {
      this._closeCurrent();
    }

    this._cur.orig.push(token);

    // 講目標語言的長段落，在句末標點切（見 MAX_UNTRANSLATED_CHARS 的註解）。
    // ⚠ 條件是 status==='none'（這一段確定不會有譯文），不是「手上還沒有譯文」。
    // ⚠ 結尾判斷吃的是**整段累積文字**、不是單一 token（見 DECIMAL_TAIL 的註解）：
    //   「73.」與「5塊」是兩顆 token，只看當下那顆看不出它是小數點。
    if (
      token.translation_status === 'none' &&
      this._cur.trans.length === 0 &&
      textOf(this._cur.orig).length >= MAX_UNTRANSLATED_CHARS &&
      isSentenceEnd(textOf(this._cur.orig))
    ) {
      this._closeCurrent();
    }
  }

  /** 把組裝中的 segment 收成一筆輸出。空的就什麼都不做。 */
  _closeCurrent() {
    const { orig, trans } = this._cur;
    if (!orig.length && !trans.length) return;

    // 譯文先到而原文是空的：實測沒見過，但真發生時丟掉就是靜默丟資料。
    // 照樣落地成一筆（originalText 為 null），並吼一聲。
    if (!orig.length) {
      console.warn('[segmenter] 收到沒有原文的譯文段落，照樣落地：', textOf(trans));
    }

    const raw = trans.length ? textOf(trans) : null;
    seqCounter += 1;

    this._out.push({
      id: this.source + '-' + Date.now().toString(36) + '-' + seqCounter,
      source: this.source,
      // 存著但不參與分段（見 class 註解）
      speaker: firstDefined(orig, 'speaker'),
      from: firstDefined(orig, 'language'),
      to: trans.length ? firstDefined(trans, 'language') : null,
      // ⚠ 時間戳只有原文側有（實測結論④：215 個譯文 token 零個帶 start_ms）
      startMs: firstDefined(orig, 'start_ms'),
      endMs: lastDefined(orig, 'end_ms'),
      // 原文也轉繁（見 constructor 的註解）。英文與數字過字典不會被動到，
      // 所以這一行對英文段落是 no-op。
      originalText: orig.length ? this._toTraditional(textOf(orig)) : null,
      // 畫面與匯出用這格（已轉繁）
      translationText: raw === null ? null : this._toTraditional(raw),
      // Soniox 原樣吐出的簡體，只進 json。轉繁是一對多的（发 → 發／髮），
      // 留這格就是為了出事時回得去。
      translationRaw: raw,
      confidence: meanConfidence(orig),
      isFinal: true,
    });

    this._cur = { orig: [], trans: [] };
  }

  /**
   * 目前的暫時字幕。畫面用它做「邊講邊出字」，**不進記錄檔**。
   *
   * 把組裝中的定稿部分也算進來，否則已定稿但還在等譯文的那半句會從畫面上消失
   * 一下再冒出來（閃爍），看起來像掉字。
   */
  _buildPartial() {
    const origTokens = [...this._cur.orig, ...this._pending.filter(isOriginal)];
    const transTokens = [...this._cur.trans, ...this._pending.filter(isTranslation)];
    if (!origTokens.length && !transTokens.length) return null;

    const raw = transTokens.length ? textOf(transTokens) : null;
    return {
      source: this.source,
      speaker: firstDefined(origTokens, 'speaker'),
      from: firstDefined(origTokens, 'language'),
      to: transTokens.length ? firstDefined(transTokens, 'language') : null,
      originalText: origTokens.length ? this._toTraditional(textOf(origTokens)) : null,
      translationText: raw === null ? null : this._toTraditional(raw),
      translationRaw: raw,
      isFinal: false,
    };
  }

  /**
   * 串流結束前把手上的東西全部倒出來。
   *
   * ⚠ 一定要有這一步：一個段落要等到「下一段原文開始」或 `<end>` 才會被判定完成，
   *   所以最後一段永遠卡在手上。少了這一步，每場會議的最後一句都會消失，
   *   而且不會有任何提示 —— 正是本專案一路在抓的那種壞法。
   */
  flush() {
    this._closeCurrent();
    this._pending = [];
    const segments = this._out;
    this._out = [];
    return segments;
  }
}
