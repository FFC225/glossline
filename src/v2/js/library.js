/**
 * 記錄庫：回看以前每一場的「原文｜譯文」兩欄。
 *
 * 資料來自後端 session_store.rs（`list_sessions` / `read_session` / …），
 * 也就是本場 session-store.js 存下去的同一批檔（.md 給人看、.json 給程式讀）。
 *
 * ⚠ 一筆的 `tgt` 可以是 null，那是**合法**狀態（講的就是目標語言，Soniox 不送譯文）。
 *   這裡把它顯示成「＝原文」而不是留白：留白會讓人以為翻譯掉了。
 *
 * ⚠ 舊檔（上游那套 addSegment(src, tgt) 存的）沒有 who / spk / t_ms 這些欄位。
 *   Rust 那邊每個新欄位都有 #[serde(default)]，所以舊檔照樣讀得出來，
 *   這裡遇到 undefined 一律當「沒有這個資訊」處理，不能整列消失。
 */

import { setText } from './escape.js';
import { openModal, closeModal } from './modal.js';
import { exportFileName } from './export-name.js';

const SOURCE_LABEL = { system: '電腦', mic: '我' };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function fmtDuration(sec) {
  const s = Number(sec) || 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return h + ' 小時 ' + m + ' 分';
  if (m > 0) return m + ' 分';
  return s + ' 秒';
}

export class Library {
  /**
   * @param {object} els
   * @param {HTMLElement} els.modal 整個彈窗（走 modal.js，Esc 與點外面都關得掉）。
   * @param {HTMLElement} els.list 清單容器。
   * @param {HTMLElement} els.detail 內容容器。
   * @param {HTMLInputElement} els.search 搜尋框。
   * @param {HTMLElement} els.title 標題。
   * @param {HTMLButtonElement} els.back 返回清單。
   * @param {(msg: string, fatal: boolean) => void} onAlert
   */
  constructor(els, onAlert) {
    this.els = els;
    this._onAlert = onAlert || (() => {});
    this._currentId = null;

    els.search.addEventListener('input', () => this._debouncedSearch());
    els.back.addEventListener('click', () => this.showList());
    this._searchTimer = null;
  }

  async open() {
    openModal(this.els.modal);
    await this.showList();
  }

  close() {
    closeModal(this.els.modal);
  }

  _debouncedSearch() {
    clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => this.showList(), 250);
  }

  async showList() {
    this._currentId = null;
    this.els.detail.hidden = true;
    this.els.list.hidden = false;
    this.els.back.hidden = true;
    setText(this.els.title, '記錄庫');

    const q = this.els.search.value.trim();
    this.els.list.textContent = '';
    this.els.list.appendChild(el('p', 'placeholder', '讀取中…'));
    let items;
    try {
      const { invoke } = window.__TAURI__.core;
      items = q ? await invoke('search_sessions', { query: q }) : await invoke('list_sessions');
    } catch (err) {
      console.error('[library] 清單讀取失敗', err);
      this.els.list.textContent = '';
      this.els.list.appendChild(el('p', 'placeholder', '讀取失敗：' + err));
      return;
    }

    this.els.list.textContent = '';
    if (!items.length) {
      this.els.list.appendChild(el('p', 'placeholder', q ? '找不到符合的會議。' : '還沒有任何紀錄。'));
      return;
    }
    for (const item of items) {
      const row = el('button', 'session-row');
      row.type = 'button';
      row.appendChild(el('span', 'session-title', item.title || '（無標題）'));
      const meta =
        item.created_at.replace('T', ' ').slice(0, 16) +
        '・' + fmtDuration(item.duration_sec) +
        '・' + item.segment_count + ' 句' +
        (item.has_legacy_only ? '・舊格式（只有 .md）' : '');
      row.appendChild(el('span', 'session-meta', meta));
      row.addEventListener('click', () => this.showOne(item));
      this.els.list.appendChild(row);
    }
  }

  async showOne(item) {
    if (item.has_legacy_only) {
      // 舊格式沒有 .json，逐句兩欄拆不出來，只能整份純文字顯示。
      // 硬拆會拆出一個看起來像資料、其實是猜的東西。
      await this._showLegacy(item);
      return;
    }
    let result;
    try {
      result = await window.__TAURI__.core.invoke('read_session', { id: item.id });
    } catch (err) {
      console.error('[library] 讀取失敗', err);
      this._onAlert('這場讀不出來：' + err, true);
      return;
    }
    this._currentId = item.id;
    this._renderDetail(item, result.json);
  }

  async _showLegacy(item) {
    let md = '';
    try {
      md = await window.__TAURI__.core.invoke('read_legacy_session', { id: item.id });
    } catch (err) {
      this._onAlert('舊格式的檔讀不出來：' + err, true);
      return;
    }
    this._currentId = item.id;
    this._enterDetail(item.title || item.id);
    const pre = el('pre', 'legacy-md', md);
    this.els.detail.appendChild(pre);
  }

  _enterDetail(title) {
    this.els.list.hidden = true;
    this.els.detail.hidden = false;
    this.els.back.hidden = false;
    setText(this.els.title, title);
    this.els.detail.textContent = '';
  }

  _renderDetail(item, json) {
    this._enterDetail(json.title || item.id);

    const bar = el('div', 'detail-bar');
    const info = el(
      'span',
      'session-meta',
      (json.source_lang || '自動') + ' → ' + (json.target_lang || '?') +
        '・' + fmtDuration(json.duration_sec) +
        '・' + json.chunks.reduce((n, c) => n + c.segments.length, 0) + ' 句'
    );
    bar.appendChild(info);
    const spacer = el('span', 'spacer');
    bar.appendChild(spacer);

    const openDir = el('button', null, '開啟資料夾');
    openDir.type = 'button';
    openDir.addEventListener('click', async () => {
      try {
        await window.__TAURI__.core.invoke('open_transcript_dir');
      } catch (err) {
        this._onAlert('開不了資料夾：' + err, true);
      }
    });
    bar.appendChild(openDir);

    for (const fmt of ['srt', 'txt']) {
      const btn = el('button', null, '匯出 ' + fmt.toUpperCase());
      btn.type = 'button';
      btn.addEventListener('click', () => this._export(item.id, json.title || item.id, fmt));
      bar.appendChild(btn);
    }

    const del = el('button', 'danger', '刪除這場');
    del.type = 'button';
    del.addEventListener('click', () => this._delete(item.id, json.title || item.id));
    bar.appendChild(del);
    this.els.detail.appendChild(bar);

    const table = el('div', 'seg-table');
    const head = el('div', 'seg-row seg-head');
    head.appendChild(el('span', 'seg-time', '時間'));
    head.appendChild(el('span', 'seg-src', '原文'));
    head.appendChild(el('span', 'seg-tgt', '中文'));
    table.appendChild(head);

    for (const chunk of json.chunks) {
      for (const seg of chunk.segments) {
        const row = el('div', 'seg-row');
        const who = SOURCE_LABEL[seg.who] || '';
        row.appendChild(el('span', 'seg-time', seg.ts + (who ? ' ' + who : '')));
        row.appendChild(el('span', 'seg-src', seg.src || ''));
        if (seg.tgt === null || seg.tgt === undefined) {
          row.appendChild(el('span', 'seg-tgt is-same', '＝原文'));
        } else {
          row.appendChild(el('span', 'seg-tgt', seg.tgt));
        }
        table.appendChild(row);
      }
    }
    this.els.detail.appendChild(table);
  }

  /**
   * 匯出成 SRT／TXT。
   *
   * ⚠ 存檔這一步走 Rust（`export_session_file`），不是前端自己寫檔：
   *   這個 fork 沒有裝 fs plugin，而上游那招（`Blob` ＋ `<a download>`）
   *   在 WebView2 到底存不存得出檔案，從來沒有人按過那顆鈕、沒被驗證過。
   *
   * ⚠ 舊格式（只有 .md）的那幾場沒有這兩顆鈕：後端要讀 .json 才拆得出逐句。
   */
  async _export(id, title, format) {
    const { save } = window.__TAURI__.dialog;
    let path = null;
    try {
      path = await save({
        defaultPath: exportFileName(title, id, format),
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
    } catch (err) {
      console.error('[library] 存檔對話框開不起來', err);
      this._onAlert('開不了存檔視窗：' + err, true);
      return;
    }
    // 按取消會回 null。那不是錯誤，跳警示會讓人以為自己弄壞了什麼。
    if (!path) return;
    try {
      const written = await window.__TAURI__.core.invoke('export_session_file', {
        id,
        format,
        path,
      });
      this._onAlert('已匯出：' + written, false);
    } catch (err) {
      console.error('[library] 匯出失敗', err);
      this._onAlert('匯出失敗：' + err, true);
    }
  }

  async _delete(id, title) {
    // 刪掉就沒了，而且刪的是會議紀錄——問一次。
    if (!window.confirm('要刪掉「' + title + '」嗎？.md 與 .json 都會被刪除，救不回來。')) return;
    try {
      await window.__TAURI__.core.invoke('delete_session', { id });
    } catch (err) {
      this._onAlert('刪不掉：' + err, true);
      return;
    }
    await this.showList();
  }
}
