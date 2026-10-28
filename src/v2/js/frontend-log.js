/**
 * 前端出的錯 -> 後端 -> logs/app-*.log
 *
 * 為什麼要有這支：每跑一次 App 已經有一份 `logs\app-*.log`（啟動器把 exe 的
 * stdout+stderr 導進去），但裡面**只有 Rust 的輸出**。JS 拋的例外死在 webview 裡，
 * 只有開著 devtools 才看得到——開會時沒有人會開。等於「最可能在正式使用時出事的那一類」
 * 剛好是我們唯一沒有紀錄的那一類。
 *
 * 三個入口全接：window.onerror（同步例外）、unhandledrejection（沒 catch 的 Promise）、
 * console.error（我們自己主動記的）。
 *
 * ⚠ 轉送本身絕不可以把 App 弄掛：invoke 失敗一律吞掉，
 *   否則「記錄錯誤」會變成「製造錯誤」，而且會遞迴。
 */

const MAX_LEN = 4000;

let installed = false;
let forwarding = false; // 防遞迴：轉送過程中若又 console.error，不再往下送

function invokeLog(level, message) {
  if (forwarding) return;
  // typeof window：node 跑 tools/test_*.mjs 時沒有 window（soniox-client.js 也會呼叫 logInfo）
  const core = typeof window !== 'undefined' && window.__TAURI__ && window.__TAURI__.core;
  if (!core || typeof core.invoke !== 'function') return; // 瀏覽器裡直接開檔時
  forwarding = true;
  try {
    const text = String(message).slice(0, MAX_LEN);
    // 不 await：這是 fire-and-forget，而且 catch 掉所有失敗。
    core.invoke('log_frontend', { level, message: text }).catch(() => {});
  } catch (_) {
    // 故意留空：記 log 失敗不值得吵，更不值得把 App 拖下水
  } finally {
    forwarding = false;
  }
}

function describeError(err) {
  if (!err) return String(err);
  if (err instanceof Error) return err.stack || (err.name + ': ' + err.message);
  if (typeof err === 'object') {
    try {
      return JSON.stringify(err);
    } catch (_) {
      return Object.prototype.toString.call(err);
    }
  }
  return String(err);
}

/** 裝上三個入口。重複呼叫無效果。 */
export function installFrontendLog() {
  if (installed) return;
  installed = true;

  window.addEventListener('error', (ev) => {
    const where = ev.filename ? ' @' + ev.filename + ':' + ev.lineno + ':' + ev.colno : '';
    invokeLog('error', (ev.error ? describeError(ev.error) : ev.message) + where);
  });

  window.addEventListener('unhandledrejection', (ev) => {
    invokeLog('unhandled-rejection', describeError(ev.reason));
  });

  const origError = console.error.bind(console);
  console.error = (...args) => {
    origError(...args);
    invokeLog('console.error', args.map(describeError).join(' '));
  };

  const origWarn = console.warn.bind(console);
  console.warn = (...args) => {
    origWarn(...args);
    invokeLog('console.warn', args.map(describeError).join(' '));
  };

  logInfo('前端已啟動，錯誤轉送已裝上');
}

/** 主動記一行（不是錯誤，只是想在 log 裡留痕跡）。 */
export function logInfo(message) {
  invokeLog('info', message);
}
