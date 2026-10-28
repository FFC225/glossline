/**
 * 設定的唯一出入口。
 *
 * 三條規矩，每一條都對應一個已經發生過的靜默失敗：
 *   1. 送出前先驗鍵：後端沒有的欄位一律 throw，不讓 serde 安靜吃掉。
 *   2. 存檔以「後端回來的整包」為底，只覆蓋改動的鍵——因為 save_settings 收整個 Settings，
 *      少送一格就等於把那格重設成預設值（recording_dir 被重設 = 錄音靜默不啟動）。
 *   3. 載入時做一次形狀對照，對不上就在 console 吼，不吼就永遠不會有人發現。
 */

import {
  RUST_SETTINGS_KEYS,
  RUST_CUSTOM_CONTEXT_KEYS,
  auditSettingsShape,
} from './settings-schema.js';

const { invoke } = window.__TAURI__.core;

class SettingsStore {
  constructor() {
    this._all = null;
    this._listeners = [];
    this.lastAudit = null;
  }

  /** 從後端讀整包設定，順便做形狀對照。 */
  async load() {
    const fromBackend = await invoke('get_settings');
    this.lastAudit = auditSettingsShape(fromBackend);
    if (this.lastAudit.missing.length || this.lastAudit.extra.length) {
      console.error(
        '[settings] 前端對照表與後端 Settings 對不上。' +
          ' 後端少了：' + (this.lastAudit.missing.join(', ') || '（無）') +
          '｜後端多出來：' + (this.lastAudit.extra.join(', ') || '（無）') +
          '　→ 去改 src/v2/js/settings-schema.js，並跑 tools/check_settings_fields.py'
      );
    }
    this._all = fromBackend;
    this._notify();
    return this.get();
  }

  /** 目前這份設定的複本。load() 之前是 null。 */
  get() {
    return this._all ? JSON.parse(JSON.stringify(this._all)) : null;
  }

  /**
   * 只改動指定欄位，其餘原樣送回。
   * 後端不認得的鍵一律 throw——這是本專案第三次踩同一個坑，所以做成硬錯誤。
   */
  async patch(changes) {
    if (!this._all) throw new Error('[settings] patch() 在 load() 之前被呼叫');

    const unknown = Object.keys(changes).filter((k) => !RUST_SETTINGS_KEYS.includes(k));
    if (unknown.length) {
      throw new Error(
        '[settings] 這些欄位 Rust Settings 沒有，送出去會被 serde 靜默丟掉：' + unknown.join(', ')
      );
    }

    if (changes.custom_context && typeof changes.custom_context === 'object') {
      const badCtx = Object.keys(changes.custom_context).filter(
        (k) => !RUST_CUSTOM_CONTEXT_KEYS.includes(k)
      );
      if (badCtx.length) {
        throw new Error(
          '[settings] custom_context 這些欄位 Rust 沒有，會被靜默丟掉：' + badCtx.join(', ')
        );
      }
    }

    const merged = { ...this._all, ...changes };
    await invoke('save_settings', { newSettings: merged });
    this._all = merged;
    this._notify();
    return this.get();
  }

  onChange(cb) {
    this._listeners.push(cb);
    return () => {
      this._listeners = this._listeners.filter((l) => l !== cb);
    };
  }

  _notify() {
    const snapshot = this.get();
    this._listeners.forEach((cb) => cb(snapshot));
  }
}

export const settingsStore = new SettingsStore();
