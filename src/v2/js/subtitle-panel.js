/**
 * 字幕面板。
 *
 * 一筆 segment 一塊：上面一行原文（小、灰）、下面一行譯文（大、亮），
 * 類別沿用 .sub-orig / .sub-trans，**這裡不另外寫字級**——
 * 字級由設定寫進 --fs-base，兩級由 CSS 依比例推出來，改一處整組跟著動。
 *
 * 三件跟舊前端不同的事：
 *   1. **只有一個入口** addSegments()。舊前端 addOriginal / addTranslation 兩個入口
 *      各自維護一條先進先出佇列去猜配對，實測 47% 接錯。現在原文譯文在同一個
 *      物件裡進來，畫面沒有配對這件事可做。
 *   2. **沒有 _cleanupStaleOriginals()**。舊前端會把「超過 10 秒沒等到譯文」的原文
 *      直接丟掉——而講中文時本來就永遠不會有譯文，於是那些句子每 10 秒被丟一次，
 *      畫面上什麼提示都沒有。新模型不需要這個東西。
 *   3. **不用 innerHTML**。整支只用 createElement + textContent，所以字幕內容
 *      根本不會被當成 HTML 解析（跳脫漏洞的根因是「手工逐處補跳脫」）。
 */

/** 兩路的分別＝本專案唯一可靠的「誰在講」，所以每一句都標。 */
const SOURCE_LABEL = { system: '電腦', mic: '我' };

/**
 * segment → 畫面要呈現的形狀。**純函式**，沒有 DOM，給 node 測。
 *
 * 三種情況（第三種是舊前端整批弄丟的那種）：
 *   a. 有原文有譯文  → 兩行。
 *   b. 有原文沒譯文  → **一行**，用譯文那一級的字顯示原文，並標「原文即目標語言」。
 *      為什麼不是「上面原文、下面留白」：留白看起來像翻譯壞了，
 *      而這其實是完全正常的狀態（講的就是中文，Soniox 送零個譯文 token）。
 *   c. 有譯文沒原文  → 一行譯文＋標記。實測沒見過，但真發生時要看得見，不能靜靜吞掉。
 */
export function renderModel(seg) {
  const orig = seg.originalText === null || seg.originalText === undefined ? '' : seg.originalText;
  const hasTrans = seg.translationText !== null && seg.translationText !== undefined;
  const who = SOURCE_LABEL[seg.source] || '?';
  const meta = [who, seg.from || null, seg.speaker ? '說話者 ' + seg.speaker : null]
    .filter(Boolean)
    .join('・');

  if (!orig.trim() && hasTrans) {
    return { meta, note: '（這段沒有原文）', orig: null, trans: seg.translationText };
  }
  if (!hasTrans) {
    return { meta, note: '原文即目標語言', orig: null, trans: orig };
  }
  return { meta, note: null, orig, trans: seg.translationText };
}

export class SubtitlePanel {
  /**
   * @param {HTMLElement} root 字幕容器。
   * @param {number} maxLines 畫面上最多保留幾筆。⚠ 只影響畫面；
   *   記錄庫一筆都不會少（那是 session-store.js 的事）。
   */
  constructor(root, { maxLines = 8 } = {}) {
    if (!root) throw new Error('[panel] 找不到字幕容器');
    this.root = root;
    this.maxLines = maxLines;
    /** 一路一個暫時字幕元素，永遠掛在最後面。 */
    this._partials = new Map();
    this._finalCount = 0;
    this.clear();
  }

  setMaxLines(n) {
    const v = Number(n);
    this.maxLines = Number.isFinite(v) && v >= 1 ? Math.floor(v) : this.maxLines;
    this._trim();
  }

  clear() {
    this.root.textContent = '';
    this._partials.clear();
    this._finalCount = 0;
  }

  /** 定稿段落（可能一次多筆）。 */
  addSegments(segments) {
    if (!segments || !segments.length) return;
    const nearBottom = this._isNearBottom();
    for (const seg of segments) {
      const el = this._buildLine(seg, false);
      // 定稿一律插在暫時字幕之前，否則「還在講的那半句」會被推到中間去
      const firstPartial = this._firstPartialEl();
      if (firstPartial) this.root.insertBefore(el, firstPartial);
      else this.root.appendChild(el);
      this._finalCount += 1;
    }
    this._trim();
    if (nearBottom) this._scrollToBottom();
  }

  /**
   * 暫時字幕（邊講邊出字）。一路一條，傳 null 就把那一路的收掉。
   * ⚠ 不進記錄庫：它每收到一條訊息就整批被取代（Soniox 的 non-final 是累積重送）。
   */
  setPartial(source, partial) {
    const nearBottom = this._isNearBottom();
    const old = this._partials.get(source);
    if (old) {
      old.remove();
      this._partials.delete(source);
    }
    if (partial && (partial.originalText || partial.translationText)) {
      const el = this._buildLine(partial, true);
      this.root.appendChild(el);
      this._partials.set(source, el);
    }
    if (nearBottom) this._scrollToBottom();
  }

  /** 把所有暫時字幕收掉（停止收音時用）。 */
  clearPartials() {
    for (const el of this._partials.values()) el.remove();
    this._partials.clear();
  }

  /* ------------------------------ 內部 ------------------------------ */

  _buildLine(seg, isPartial) {
    const model = renderModel(seg);
    const line = document.createElement('div');
    line.className = 'sub-line' + (isPartial ? ' is-partial' : '');
    line.dataset.source = seg.source || '';

    const head = document.createElement('div');
    head.className = 'sub-meta';
    head.textContent = model.note ? model.meta + '・' + model.note : model.meta;
    line.appendChild(head);

    if (model.orig !== null) {
      const o = document.createElement('div');
      o.className = 'sub-orig';
      o.textContent = model.orig;
      line.appendChild(o);
    }
    const t = document.createElement('div');
    t.className = 'sub-trans';
    t.textContent = model.trans === null || model.trans === undefined ? '' : model.trans;
    line.appendChild(t);
    return line;
  }

  _firstPartialEl() {
    for (const el of this._partials.values()) return el;
    return null;
  }

  /** 只砍定稿行，暫時字幕不算在額度裡（它本來就只有一兩行、且永遠在最後）。 */
  _trim() {
    while (this._finalCount > this.maxLines) {
      const first = this.root.querySelector('.sub-line:not(.is-partial)');
      if (!first) break;
      first.remove();
      this._finalCount -= 1;
    }
  }

  _isNearBottom() {
    const el = this.root;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }

  _scrollToBottom() {
    this.root.scrollTop = this.root.scrollHeight;
  }
}
