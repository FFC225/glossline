/**
 * 骨架。
 *
 * 這支只做三件事：把畫面搭起來、把設定接好、把彈窗規矩定死。
 * 字幕、配對、記錄庫由各自的模組接上，這裡留掛載點。
 */

import { setText } from './escape.js';
import { settingsStore } from './settings-store.js';
import { V2_EDITED_KEYS } from './settings-schema.js';
import { openModal, closeModal, openModalCount } from './modal.js';
import { WindowShell, computeFitGeometry } from './window-shell.js';
import { installFrontendLog, logInfo } from './frontend-log.js';
import { SubtitlePanel } from './subtitle-panel.js';
import { SessionStore } from './session-store.js';
import { MeetingCapture } from './capture.js';
import { renderReport } from './report-panel.js';
import { renderPrecheck } from './precheck-panel.js';
import { applyMeetingName, nameResultMessage } from './session-naming.js';
import { appendWithEmphasis, formatElapsed } from './ui-text.js';
import { createStopProgress } from './stop-progress.js';
import { Library } from './library.js';
import {
  normalizeTranslationTerms,
  parseTranslationTerms,
  formatTranslationTerms,
} from './soniox-client.js';

const $ = (id) => document.getElementById(id);

/** 下面這四樣東西。boot() 之前都是 null。 */
let panel = null;
let sessionStore = null;
let capture = null;
let library = null;
/** 視窗大小模式與「收音中自動收起外殼」。boot() 之前是 null。 */
let windowShell = null;
/** 報告框上那顆「開啟資料夾」要開哪一場。每次跳報告時重寫，沒有就是 null。 */
let reportFolder = null;
/**
 * 散會命名要改哪一筆記錄。
 *
 * ⚠ 這是**快照**，不是每次去問 `sessionStore.id`：報告框還開著的時候人可以按
 * 開始跑下一場，那時 store 上的 id 已經是新的一場了，拿它去改標題會改到別人身上。
 */
let reportSession = { id: null, hasSegments: false };

const FIELD_BINDINGS = [
  { id: 'set-api-key', key: 'soniox_api_key', kind: 'text' },
  { id: 'set-source-lang', key: 'source_language', kind: 'text' },
  { id: 'set-target-lang', key: 'target_language', kind: 'text' },
  { id: 'set-audio-source', key: 'audio_source', kind: 'text' },
  { id: 'set-recording-dir', key: 'recording_dir', kind: 'text' },
  { id: 'set-folder-name-order', key: 'folder_name_order', kind: 'text' },
  { id: 'set-font-size', key: 'font_size', kind: 'int' },
  { id: 'set-max-lines', key: 'max_lines', kind: 'int' },
  { id: 'set-opacity', key: 'overlay_opacity', kind: 'percent' },
  { id: 'set-show-original', key: 'show_original', kind: 'bool' },
];

function readField(binding) {
  const el = $(binding.id);
  if (!el) throw new Error('[v2] 設定欄位不存在：#' + binding.id);
  switch (binding.kind) {
    case 'bool':
      return el.checked;
    case 'int': {
      const n = parseInt(el.value, 10);
      if (Number.isNaN(n)) throw new Error('[v2] ' + binding.key + ' 不是數字，拒絕存檔');
      return n;
    }
    case 'percent':
      return parseInt(el.value, 10) / 100;
    default:
      return el.value.trim();
  }
}

function writeField(binding, value) {
  const el = $(binding.id);
  if (!el) throw new Error('[v2] 設定欄位不存在：#' + binding.id);
  switch (binding.kind) {
    case 'bool':
      el.checked = Boolean(value);
      break;
    case 'percent':
      el.value = Math.round((Number(value) || 0) * 100);
      break;
    default:
      el.value = value === null || value === undefined ? '' : String(value);
  }
}

function populateForm(settings) {
  FIELD_BINDINGS.forEach((b) => writeField(b, settings[b.key]));
  const terms = settings.custom_context && Array.isArray(settings.custom_context.terms)
    ? settings.custom_context.terms
    : [];
  $('set-context-terms').value = terms.join('\n');
  $('set-context-translation-terms').value = formatTranslationTerms(
    settings.custom_context && settings.custom_context.translation_terms
  );
  refreshOpacityLabel();
}

function collectForm(current) {
  const changes = {};
  FIELD_BINDINGS.forEach((b) => {
    changes[b.key] = readField(b);
  });

  const termsRaw = $('set-context-terms').value.trim();
  const terms = termsRaw ? termsRaw.split('\n').map((t) => t.trim()).filter(Boolean) : [];
  const prevCtx = (current && current.custom_context) || {};
  changes.custom_context = {
    domain: prevCtx.domain ?? null,
    terms,
    text: prevCtx.text ?? null,
    translation_terms: parseTranslationTerms($('set-context-translation-terms').value),
  };

  const stray = Object.keys(changes).filter((k) => !V2_EDITED_KEYS.includes(k));
  if (stray.length) throw new Error('[v2] 表單送出了 V2_EDITED_KEYS 之外的欄位：' + stray.join(', '));
  return changes;
}

/* ---------------------------------------------------------------------------
 * 外觀與置頂：兩顆標題列按鈕。
 *
 * 兩件都存在 Rust Settings 裡（不是 localStorage）——理由是這兩格必須跟其他設定
 * 走同一條路，才會被 check_settings_fields.py 與載入時的形狀對照一起看顧。
 * 存 localStorage 就會變成第二套設定系統，而且沒有任何機制看著它。
 * ------------------------------------------------------------------------- */

/** 'light' 以外一律當 'dark'（Rust 那格是自由字串，別假設它只會是這兩個值）。 */
function normalizeTheme(value) {
  return value === 'light' ? 'light' : 'dark';
}

/**
 * 字級：把設定裡的「字級」寫進 --fs-base，字幕兩級由 CSS 依比例推出來。
 * 這樣調字級是整組一起動；若各處各寫各的，就會出現「介面變大、字幕沒變」
 * 這種調了一半的狀態，而且不會有任何錯誤訊息。
 */
function applyFontSize(px) {
  const n = Number(px);
  const safe = Number.isFinite(n) && n >= 10 && n <= 48 ? n : 16;
  document.documentElement.style.setProperty('--fs-base', safe + 'px');
  return safe;
}

function applyTheme(theme) {
  const t = normalizeTheme(theme);
  document.documentElement.setAttribute('data-theme', t);
  const btn = $('btn-theme');
  setText(btn, t === 'light' ? '☀️ 亮色' : '🌙 暗色');
  btn.setAttribute('aria-pressed', String(t === 'light'));
  return t;
}

/**
 * 套用置頂。
 * ⚠ 回傳「有沒有真的套上去」——setAlwaysOnTop 失敗（權限沒開之類）時，
 *   按鈕若照樣變狀態，畫面就會宣稱一件沒發生的事。這正是本專案一路在抓的靜默失敗。
 */
async function applyAlwaysOnTop(on) {
  const want = Boolean(on);
  const btn = $('btn-pin');
  try {
    const { getCurrentWindow } = window.__TAURI__.window;
    await getCurrentWindow().setAlwaysOnTop(want);
  } catch (err) {
    console.error('[v2] 置頂切換失敗', err);
    toast('置頂切換失敗：' + err, true);
    return false;
  }
  setText(btn, want ? '📌 置頂' : '📍 不置頂');
  btn.setAttribute('aria-pressed', String(want));
  btn.classList.toggle('is-on', want);
  return true;
}

async function toggleTheme() {
  const current = settingsStore.get();
  const next = normalizeTheme(current && current.theme) === 'light' ? 'dark' : 'light';
  applyTheme(next);
  try {
    await settingsStore.patch({ theme: next });
  } catch (err) {
    console.error('[v2] 外觀設定存檔失敗', err);
    toast('外觀已切換，但存不起來：' + err.message, true);
  }
}

async function togglePin() {
  const current = settingsStore.get();
  const next = !(current && current.always_on_top);
  // 先套用、套不上就不存——不讓設定檔記下一個沒有發生的狀態
  if (!(await applyAlwaysOnTop(next))) return;
  try {
    await settingsStore.patch({ always_on_top: next });
  } catch (err) {
    console.error('[v2] 置頂設定存檔失敗', err);
    toast('置頂已切換，但存不起來：' + err.message, true);
  }
}

/* ---------------------------------------------------------------------------
 * 目前實際在用的輸入／輸出裝置。
 *
 * 「抓哪一路」只講得出類別（電腦播出的／麥克風），講不出「是哪一台」——
 * 而「是哪一台」正是決定錄音能不能用的那一題：藍牙耳機一旦被程式
 * 碰到麥克風，整條連線掉成電話品質，Windows 與 App 都不會說一個字。
 * 把裝置名稱與取樣率直接寫在設定頁，就是把那個看不見的失敗變成看得見的。
 * ------------------------------------------------------------------------- */

/**
 * 把視窗縮進「目前所在的那個螢幕」。
 *
 * 為什麼需要這顆鈕：視窗是 decorations:false（沒有 Windows 自己的標題列），
 * 所以沒有最大化／還原鈕。一旦視窗被拉得比螢幕大、或被拖到一個比較小的螢幕
 * （例如直立擺放的螢幕），就會被裁掉一半，而且沒有任何內建方式救得回來。
 * （實撞過。）
 *
 * 用實體像素算，再除以縮放比例換回邏輯像素——兩台螢幕縮放不同時，
 * 少了這一步就會算出一個「數字看起來對、實際大一圈」的尺寸。
 */
/** 按「符合螢幕」之前視窗長怎樣。null＝現在不是被縮過的狀態，按鈕顯示「符合螢幕」。 */
let fitPrevious = null;

function renderFitButton() {
  const btn = $('btn-fit');
  setText(btn, fitPrevious ? '⤡ 還原大小' : '⤢ 符合螢幕');
  btn.title = fitPrevious
    ? '還原成按「符合螢幕」之前的大小與位置（雙擊標題列也可以）'
    : '把視窗縮到目前這個螢幕裡（雙擊標題列也可以）';
}

/**
 * 使用者自己拉過視窗 → 那份「按之前長怎樣」就過期了。
 * 還原成一個他早就不要的尺寸，比不能還原更討厭，所以直接忘掉、鈕變回「符合螢幕」。
 */
function forgetFit() {
  if (!fitPrevious) return;
  fitPrevious = null;
  renderFitButton();
}

/** 目前視窗的大小與位置，換算成邏輯像素。 */
async function currentGeometry() {
  const win = window.__TAURI__.window.getCurrentWindow();
  const scale = (await win.scaleFactor()) || 1;
  const size = await win.innerSize();
  const pos = await win.outerPosition();
  return {
    w: Math.round(size.width / scale),
    h: Math.round(size.height / scale),
    x: Math.round(pos.x / scale),
    y: Math.round(pos.y / scale),
  };
}

async function applyGeometry(geo) {
  const w = window.__TAURI__.window;
  const win = w.getCurrentWindow();
  // 先講一聲這是我們自己改的，否則外殼會把它當成「使用者拉的」而洗掉還原記憶
  if (windowShell) windowShell.noteProgrammaticResize();
  await win.setSize(new w.LogicalSize(geo.w, geo.h));
  await win.setPosition(new w.LogicalPosition(geo.x, geo.y));
  // 記起來，否則下次開 App 又跳回原本那個尺寸，使用者得每次開機都按一次鈕
  if (windowShell) await windowShell.saveCurrentSize();
}

/**
 * 把視窗縮進「目前所在的那個螢幕」，再按一次還原。
 *
 * 為什麼需要這顆鈕：視窗是 decorations:false（沒有 Windows 自己的標題列），
 * 所以沒有最大化／還原鈕。一旦視窗被拉得比螢幕大、或被拖到一個比較小的螢幕
 * （例如直立擺放的螢幕），就會被裁掉一半，而且沒有任何內建方式救得回來。
 * （實撞過。）
 *
 * ⚠ 為什麼要能還原：只縮不還原等於「這顆鈕會弄壞你原本擺好的版面，而且回不去」，
 *   實測時當場踩到。
 */
async function toggleFit() {
  try {
    if (fitPrevious) {
      const target = fitPrevious;
      await applyGeometry(target);
      fitPrevious = null;
      renderFitButton();
      toast('已還原成 ' + target.w + '×' + target.h);
      return;
    }

    const w = window.__TAURI__.window;
    const mon = (await w.currentMonitor()) || (await w.primaryMonitor());
    if (!mon) {
      toast('問不到螢幕資訊，沒辦法自動縮', true);
      return;
    }
    const scale = mon.scaleFactor || (await w.getCurrentWindow().scaleFactor()) || 1;
    const geo = computeFitGeometry({
      width: mon.size.width,
      height: mon.size.height,
      x: mon.position.x,
      y: mon.position.y,
      scale,
    });
    const before = await currentGeometry();
    await applyGeometry(geo);
    fitPrevious = before;
    renderFitButton();
    toast('已縮到 ' + geo.w + '×' + geo.h + '（再按一次還原）');
  } catch (err) {
    console.error('[v2] 視窗縮放失敗', err);
    toast('視窗縮放失敗：' + err, true);
  }
}

// 用 fromCharCode 而不是跳脫字元：這一行已經被「轉義在傳輸途中被吃掉」
// 咬過兩次，而且咬掉的時候不噴任何錯，只是檔案裡多一個真的換行。
const NEWLINE = String.fromCharCode(10);

function renderEndpoint(prefix, info) {
  const nameEl = $('dev-' + prefix + '-name');
  const fmtEl = $('dev-' + prefix + '-fmt');
  if (!info) {
    setText(nameEl, '（Windows 說沒有這個裝置）');
    setText(fmtEl, '');
    return null;
  }
  setText(nameEl, info.name);
  if (info.note) {
    setText(fmtEl, '（格式讀不到：' + info.note + '）');
  } else {
    setText(fmtEl, info.sample_rate + ' Hz・' + info.channels + ' 聲道');
  }
  return info;
}

async function refreshDevices() {
  const warnEl = $('dev-warn');
  try {
    const eps = await window.__TAURI__.core.invoke('list_audio_endpoints');
    const out = renderEndpoint('out', eps.output);
    const inp = renderEndpoint('in', eps.input);

    const messages = [];
    if (eps.error) messages.push(eps.error);
    // 電話品質＝藍牙切到通話模式。判準跟錄音端同一條（Rust 的 is_call_mode），
    // 所以設定頁與錄音器不可能對「什麼叫降級」講出兩套話。
    [['輸出', out], ['輸入', inp]].forEach(([label, info]) => {
      if (info && info.call_mode) {
        messages.push(
          '⚠ ' + label + '是 ' + info.sample_rate + ' Hz 單聲道＝電話品質。' +
            '多半是藍牙耳機被某個程式用到麥克風、整條切成通話模式了。' +
            '這時候錄下來的東西會糊掉，而且不會有任何提示。' +
            '解法：Windows 的預設裝置與會議軟體自己那份設定，兩邊都改成非藍牙的麥克風。'
        );
      }
    });

    warnEl.hidden = messages.length === 0;
    setText(warnEl, messages.join(NEWLINE));
    return eps;
  } catch (err) {
    console.error('[v2] 裝置偵測失敗', err);
    setText($('dev-out-name'), '偵測失敗');
    setText($('dev-in-name'), '偵測失敗');
    setText($('dev-out-fmt'), '');
    setText($('dev-in-fmt'), '');
    warnEl.hidden = false;
    setText(warnEl, '裝置偵測失敗：' + err);
    return null;
  }
}

function refreshOpacityLabel() {
  setText($('set-opacity-value'), $('set-opacity').value + '%');
}

function toast(message, isError = false) {
  const el = $('toast');
  setText(el, message);
  el.classList.toggle('error', isError);
  el.classList.add('is-visible');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.remove('is-visible'), 3200);
}

/** 開資料夾選取視窗。取消或出錯都回 `null`，不丟例外。 */
async function pickFolder(title) {
  try {
    const { open } = window.__TAURI__.dialog;
    const picked = await open({ directory: true, multiple: false, title });
    if (picked === null || picked === undefined) return null;
    return Array.isArray(picked) ? picked[0] : picked;
  } catch (err) {
    console.error('[v2] 資料夾選取失敗', err);
    toast('資料夾選取失敗：' + err, true);
    return null;
  }
}

async function pickRecordingDir() {
  const picked = await pickFolder('選擇錄音存放資料夾');
  if (picked) $('set-recording-dir').value = picked;
}

async function saveSettings() {
  try {
    const changes = collectForm(settingsStore.get());
    await settingsStore.patch(changes);
    // 存完立刻套用，不必重開才看得到
    applyFontSize(changes.font_size);
    applyTheme(settingsStore.get().theme);
    applyDisplaySettings(settingsStore.get());
    // ⚠ 翻譯詞表寫壞的那幾行會被丟掉。丟掉本身沒問題，**不講才有問題**：
    //   使用者看著自己打的字，按存檔、跳「已儲存」，下次開起來那行不見了。
    const typed = $('set-context-translation-terms').value
      .split('\n')
      .filter((l) => l.trim()).length;
    const kept = changes.custom_context.translation_terms.length;
    toast(
      typed > kept
        ? '設定已儲存，但翻譯詞表有 ' + (typed - kept) + ' 行沒有「原文 = 譯文」的等號，已略過'
        : '設定已儲存',
      typed > kept
    );
  } catch (err) {
    console.error('[v2] 設定儲存失敗', err);
    toast('設定儲存失敗：' + err.message, true);
  }
}

/* ---------------------------------------------------------------------------
 * 字幕、錄音、記錄庫
 * ------------------------------------------------------------------------- */

/**
 * 看得見的警示（會議模式禁止靜默降級）。
 *
 * ⚠ 刻意不用 toast：toast 三秒就消失，而斷線、藍牙降級、存檔失敗這幾件事發生時
 *   人多半正在講話、沒有看螢幕。所以留一行在畫面上，直到有人按掉或下一次警示蓋掉。
 */
function showAlert(message, fatal = false) {
  const el = $('alert-line');
  setText(el, (fatal ? '⚠ ' : '· ') + message);
  el.classList.toggle('fatal', Boolean(fatal));
  el.hidden = false;
  console.warn('[v2] ' + message);
}

function clearAlert() {
  const el = $('alert-line');
  el.hidden = true;
  setText(el, '');
}

/**
 * F1：麥克風沒聲音／斷了。kind＝'silent'｜'gone'｜null（收起）。
 *
 * ⚠ 自己一格、不用 showAlert：那格會被下一則（重連中、存檔失敗）洗掉，
 *   而「你講的話收不到」要一直掛到麥克風恢復或有人按「知道了」。
 */
const MIC_ALERT_TEXT = {
  silent: '⚠ 你的麥克風已經 10 秒完全沒有聲音，你講的話現在收不到（字幕和錄音都是空的）。'
    + '可能被靜音、被別的程式搶走，或選錯了麥克風。',
  gone: '⚠ 麥克風斷了：3 秒沒有收到任何聲音資料，可能被拔掉或被系統停用。'
    + '插回去之後這個警告沒有自己消失的話，請停止、再重新開始一場。',
};

function showMicAlert(kind) {
  const box = $('mic-alert');
  if (!kind) {
    box.hidden = true;
    return;
  }
  setText($('mic-alert-text'), MIC_ALERT_TEXT[kind] || MIC_ALERT_TEXT.silent);
  box.hidden = false;
}

/**
 * 常駐通知：還沒解決的事（收工報告的判決、未錄音、麥克風沒開起來）。
 *
 * ⚠ 刻意**不用** `showAlert`：那是單一格子＋setText，下一則警示會把上一則整個蓋掉。
 *   「這場沒錄到對方的聲音」被一句「重連中」洗掉，跟從來沒講過完全一樣。
 * 只有下一次按「開始」才清（`toggleCapture`），所以散會後去泡杯咖啡回來，字還在。
 */
function addPersistentNotice(message) {
  const box = $('persistent-notice');
  if (!box || !message) return;
  // 同一則不重複堆：同一場可能會重掛同一句。
  // ⚠ 比對的是**原文**（dataset.raw），不是 textContent —— 強調標記被吃掉之後
  //   兩者不再相等，拿 textContent 比會讓同一句重複堆上去。
  for (const child of box.children) {
    if (child.dataset.raw === message) return;
  }
  const line = document.createElement('p');
  line.dataset.raw = message;
  // 強調標記在這一個出口會被解析成真的粗體（`ui-text.js`，含為什麼要這樣做）。
  appendWithEmphasis(line, message);
  box.appendChild(line);
  box.hidden = false;
}

function clearPersistentNotice() {
  const box = $('persistent-notice');
  if (!box) return;
  while (box.firstChild) box.removeChild(box.firstChild);
  box.hidden = true;
}

function setStatus(text) {
  setText($('status-line'), text);
}

/* ── 收尾進度 ─────────────────────────────────
   邏輯全在 `stop-progress.js`（含「為什麼不報百分比」那段）。這裡只把
   四個 DOM 節點餵給它，並且**延後到第一次用到才建**——`$()` 在模組載入當下
   還拿不到節點，提前建會拿到一手 null 而且不會噴任何錯。 */
let stopProgress = null;

function renderStopProgress(step) {
  if (!stopProgress) {
    stopProgress = createStopProgress({
      box: $('stop-progress'),
      bar: $('stop-progress-bar'),
      text: $('stop-progress-text'),
      slow: $('stop-progress-slow'),
    });
  }
  stopProgress.render(step);
}

/**
 * 散會時把收工報告攤開。
 *
 * ⚠ 畫不出來也不可以安靜地什麼都不做——那樣「報告框沒跳」與「這場很正常」
 *   在畫面上又長得一樣了，正是這張報告在防的那件事。
 */
/**
 * 報告框自己那行錯誤。空字串＝收起來。
 *
 * ⚠ 這行不能改用 showAlert：報告框是全螢幕遮罩，`#alert-line` 在它下面被蓋住。
 *   所以「開不了資料夾」是兩邊都講——框裡這行給當下的人看，`#alert-line` 那行
 *   給關掉框之後的人看。
 */
function setReportError(message) {
  const el = $('report-error');
  if (!el) return;
  setText(el, message);
  el.hidden = !message;
}

function showStopReport(report) {
  const root = $('report-modal');
  const model = renderReport(root, report);
  if (!model) {
    showAlert('收工報告畫不出來，請看紀錄檔（設定頁最下面那顆鍵）。', true);
    // ⚠ 框畫不出來也一定要把判決講出來。`capture.js` 不再另外
    //   丟一份到警示列（那會讓同一句話出現兩次），所以這條路現在是判決唯一的出口。
    ((report && report.tracks) || []).forEach((t) => addPersistentNotice(t.verdict));
    if (report && report.micFailed) addPersistentNotice(report.micFailed);
    return;
  }
  // ⚠ 沒有資料夾（這場沒錄）就把鍵收起來，不要留一顆按了必定報錯的鍵：
  //   一顆會失敗的按鈕會教人以後不相信錯誤訊息。
  reportFolder = model.folder;
  $('btn-report-open-dir').hidden = !reportFolder;
  setReportError('');
  prepareNameRow();
  // 判決要活得比這個框久。人在散會時是邊收東西邊瞄一眼，
  // 框一關就沒了的話，等於只講給「剛好在看螢幕的那三秒」聽。
  model.rows.forEach((row) => addPersistentNotice(row.verdict));
  if (model.micFailed) addPersistentNotice(model.micFailed);
  if (model.warn) addPersistentNotice(model.warn);
  openModal(root);
}

/**
 * 散會命名那一欄：每次跳報告都重設。
 *
 * ⚠ 一定要清空上一場留下的字。輸入框裡殘留著上一場的名字，按下去會把
 *   「上一場的名字」套到這一場身上——而畫面上看起來完全正常。
 *
 * ⚠ 這場既沒錄音也沒句子時整欄收起來：沒有東西可以改名，留一個按了只會
 *   回一句「沒有地方可以存」的欄位只是在騙人。
 */
function prepareNameRow() {
  const row = $('report-name-row');
  if (!row) return;
  reportSession = {
    id: sessionStore ? sessionStore.id : null,
    hasSegments: Boolean(sessionStore && sessionStore.totalSegmentCount() > 0),
  };
  const usable = Boolean(reportFolder) || (reportSession.id && reportSession.hasSegments);
  row.hidden = !usable;
  const input = $('report-name-input');
  if (input) input.value = '';
  setNameStatus('', false);
  $('btn-report-name-save').disabled = false;
}

function setNameStatus(message, bad) {
  const el = $('report-name-status');
  if (!el) return;
  setText(el, message);
  el.hidden = !message;
  el.classList.toggle('is-bad', Boolean(bad));
}

/**
 * 存名字。三件事（記錄庫標題／資料夾改名／資料夾裡那份逐字稿）由
 * `session-naming.js` 統一跑，這裡只管畫面。
 *
 * ⚠ 改名成功後 `reportFolder` 一定要跟著換成新路徑：「開啟資料夾」那顆鍵用的
 *   就是它，指到已經不存在的舊路徑時 explorer 會安靜地開錯地方（見 logs.rs 檔頭）。
 */
async function saveMeetingName() {
  const input = $('report-name-input');
  const name = input ? input.value : '';
  const btn = $('btn-report-name-save');
  if (btn) btn.disabled = true;
  setNameStatus('存名字中…', false);
  let result;
  try {
    result = await applyMeetingName({
      invoke: (cmd, args) => window.__TAURI__.core.invoke(cmd, args),
      name,
      sessionId: reportSession.id,
      folder: reportFolder,
      hasSegments: reportSession.hasSegments,
      markdown: () => sessionStore.markdown(),
      // ⚠ 交給 applyMeetingName 在產生 Markdown 之前設，不可以搬到這裡事後補：
      //   副本的第一行就是這個標題。判斷「還是同一場」是因為報告框開著的時候
      //   人可以按開始跑下一場，那時 store 已經換人了。
      setTitle: (t) => {
        if (sessionStore && reportSession.id === sessionStore.id) sessionStore.title = t;
      },
    });
  } catch (err) {
    // applyMeetingName 自己就收掉每一個 invoke 的錯，走到這裡代表是程式壞了，
    // 不是使用者做錯事——照樣要講，不可以只留一個轉圈圈的「存名字中…」。
    setNameStatus('⚠ 存名字時程式出錯：' + err, true);
    if (btn) btn.disabled = false;
    return;
  }
  if (result.folder) reportFolder = result.folder;
  const msg = nameResultMessage(result);
  setNameStatus(msg.text, msg.bad);
  if (msg.bad) logInfo('[naming] ' + msg.text);
  if (btn) btn.disabled = false;
}

/**
 * 體檢有話要說時，把框打開並等人選。
 *
 * 回傳 `{ go, noRecording, recordDir }` 給 `capture.js`。
 *
 * ⚠ 「換一個資料夾」不是選完就算——選完要**當場用新資料夾重跑一次體檢**，
 *   因為新選的那個也可能寫不進去（桌面可以、某個網路磁碟不行），而那時候
 *   人已經按下開始了，再沒有人會回頭看。所以這裡是個迴圈。
 *
 * ⚠ 「這場不錄」送的是明確旗標 `noRecording`，**不是空字串的資料夾**：
 *   後端在資料夾是空的時候會退回去讀設定值，送空字串＝照錄，畫面零跡象。
 */
async function askPrecheck(items) {
  const root = $('precheck-modal');
  let current = items;
  // 換資料夾最多繞幾次。純粹是防手滑無限繞，不是什麼業務規則。
  for (let round = 0; round < 8; round += 1) {
    const model = renderPrecheck(root, current);
    if (!model) {
      // 框畫不出來就不可以靜靜放行——那等於這張網從來不存在。
      showAlert('開始前的檢查畫不出來，這場沒有開始。請看紀錄檔。', true);
      return { go: false, noRecording: false, recordDir: null };
    }
    $('btn-precheck-pick-dir').hidden = !model.canRetarget;
    $('btn-precheck-no-record').hidden = !model.canRetarget;

    // 第一次開始錄音時講一句錄音告知。**不擋人**——
    // 只是一行字，按鈕照常按得下去。
    $('precheck-consent').hidden = !model.needsConsent;

    const choice = await new Promise((resolve) => {
      // ⚠ 答案要先記在這裡，不可以在按鈕的處理常式裡直接 resolve：
      //   `closeModal` 會**同步**叫 `onClose`，於是 onClose 裡的
      //   `resolve('cancel')` 永遠比按鈕那一行先跑，四顆鍵就會全部變成「取消」。
      //   Promise 只認第一次 resolve，而且不噴任何錯——按鈕看起來就是沒反應。
      let answer = null;
      const pick = (value) => () => {
        answer = value;
        closeModal(root); // onClose 會負責 resolve
      };
      const handlers = [
        ['btn-precheck-go', pick('go')],
        ['btn-precheck-cancel', pick('cancel')],
        ['btn-precheck-pick-dir', pick('pick')],
        ['btn-precheck-no-record', pick('no-record')],
      ];
      handlers.forEach(([id, fn]) => $(id).addEventListener('click', fn));
      openModal(root, {
        onClose: () => {
          handlers.forEach(([id, fn]) => $(id).removeEventListener('click', fn));
          // Esc／點外面＝沒有回答。當成「先不要開始」——一個被隨手關掉的
          // 警告不可以解讀成同意。
          resolve(answer || 'cancel');
        },
      });
    });

    if (choice === 'go') {
      // 講過就記住，之後不再講。
      // ⚠ 存不回去**不擋人**：他已經看過那句話，為了一個寫不進去的
      //   設定檔擋下他的會議，代價和收穫完全不成比例。下次會再問一次而已。
      if (model.needsConsent) {
        try {
          await settingsStore.patch({ recording_consent_ack: true });
        } catch (err) {
          console.error('[v2] 錄音告知的確認存不回去', err);
        }
      }
      return { go: true, noRecording: false, recordDir: null };
    }
    if (choice === 'cancel') return { go: false, noRecording: false, recordDir: null };
    if (choice === 'no-record') return { go: true, noRecording: true, recordDir: null };

    // choice === 'pick'
    const picked = await pickFolder('選擇錄音存放資料夾');
    if (!picked) continue; // 取消選取＝回到同一張清單，不是放行
    try {
      // 存回設定，否則下一場又是同一個壞資料夾。
      await settingsStore.patch({ recording_dir: picked });
      $('set-recording-dir').value = picked;
    } catch (err) {
      console.error('[v2] 錄音資料夾存不回去', err);
      toast('新的資料夾存不回設定：' + err.message, true);
    }
    try {
      current = await window.__TAURI__.core.invoke('precheck', { recordDir: picked });
    } catch (err) {
      console.error('[v2] 換完資料夾重跑體檢失敗', err);
      showAlert('換完資料夾之後的檢查跑不起來：' + err, true);
      return { go: false, noRecording: false, recordDir: null };
    }
    const stillBad = (current || []).some((i) => i && i.level !== 'ok');
    if (!stillBad) return { go: true, noRecording: false, recordDir: picked };
  }
  return { go: false, noRecording: false, recordDir: null };
}

/** 顯示相關的設定：只影響畫面，記錄庫一筆都不會少。 */
function applyDisplaySettings(settings) {
  if (!panel) return;
  panel.setMaxLines(settings.max_lines);
  // 「同時顯示原文」關掉時只是把原文那一行藏起來——資料照存，
  // 所以事後打開記錄庫還是看得到全部。
  $('subtitle-panel').classList.toggle('hide-orig', settings.show_original === false);
}

function setRunningUi(running) {
  const btn = $('btn-toggle');
  setText(btn, running ? '■ 停止' : '▶ 開始');
  btn.classList.toggle('is-running', running);
  // 休息鈕只在收音中出現。停止時一定要一起收掉並復位，否則下一場會看到一顆
  // 寫著「▶ 繼續」的鈕，而那一場根本沒有在休息。
  const pauseBtn = $('btn-pause');
  if (pauseBtn) {
    pauseBtn.hidden = !running;
    if (!running) setText(pauseBtn, '⏸ 休息');
  }
  const markBtn = $('btn-mark');
  if (markBtn) {
    markBtn.hidden = !running;
    if (!running) setText(markBtn, '⭐ 標記重點');
  }
  // 錄音中的持續指示。跟按鈕分開的一行字，理由見 index.html。
  const rec = $('recording-indicator');
  if (rec) rec.hidden = !running;
  if (running) startElapsedClock();
  else stopElapsedClock();
  // 收音中才會自動收起外殼；停止時一定要放回來，不然畫面看起來像卡住了。
  if (windowShell) windowShell.setCapturing(running);
}

/* ─── 錄音讀秒 ────────────────────────────────────────────
 *
 * ⚠ **不可以用「每跳一次加一秒」來計時**：分頁被最小化或系統忙的時候，
 *   `setInterval` 會被延後甚至合併，加出來的秒數只會少不會多——
 *   於是畫面上的「已錄 42 分」對應到檔案裡的 47 分鐘，**零錯誤訊息**。
 *   每次都從「現在 − 開始的那一刻」重算，跳幾次都不影響答案。
 *
 * 📌 休息中**照樣走**：休息時錄音沒有停（後端照寫靜音），
 *   所以這個數字要跟錄音檔的長度一致。它報的是「錄了多久」，
 *   不是「講了多久」。
 */
let elapsedStartedAt = null;
let elapsedTimer = null;

function paintElapsed() {
  const node = $('recording-elapsed');
  if (!node || elapsedStartedAt === null) return;
  setText(node, formatElapsed(Date.now() - elapsedStartedAt));
}

function startElapsedClock() {
  if (elapsedTimer !== null) return; // 已經在走了（休息／接回不重算）
  elapsedStartedAt = Date.now();
  paintElapsed();
  elapsedTimer = setInterval(paintElapsed, 1000);
}

function stopElapsedClock() {
  if (elapsedTimer !== null) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
  elapsedStartedAt = null;
  // 復位成 00:00。留著上一場的數字，下一場開頭那一秒會顯示別場的長度。
  const node = $('recording-elapsed');
  if (node) setText(node, formatElapsed(0));
}

/**
 * 中場休息 / 接回。
 *
 * ⚠ 畫面上**必須看得出來現在是休息中**（不可靜默降級）：鈕的字會變成「▶ 繼續」，
 *   狀態列寫「⏸ 休息中」，常駐區留一行講「錄音沒有停」。
 *   「按了休息但看起來跟在錄一樣」是這個功能最糟的壞法——
 *   人會以為還在錄，散會才發現中間半小時沒有字幕。
 */
async function togglePause() {
  const btn = $('btn-pause');
  btn.disabled = true;
  try {
    const ok = capture.isPaused() ? await capture.resume() : await capture.pause();
    // ⚠ 只有**真的成功**才改鈕面。失敗時 capture 那邊已經跳過警示了，
    //   這裡若照改，畫面會說「休息中」而其實還在收音。
    if (ok) setText(btn, capture.isPaused() ? '▶ 繼續' : '⏸ 休息');
  } catch (err) {
    console.error('[v2] 休息／繼續失敗', err);
    showAlert('休息／繼續失敗：' + err, true);
  } finally {
    btn.disabled = false;
  }
}

async function toggleCapture() {
  const btn = $('btn-toggle');
  btn.disabled = true;
  try {
    if (capture.isRunning) {
      await capture.stop();
    } else {
      clearAlert();
      // 上一場的紅字在這裡才清——不是散會時清。這一行就是「常駐」的定義。
      clearPersistentNotice();
      // 上一場的收尾進度若因為什麼原因殘留在畫面上，新的一場不該帶著它開始。
      renderStopProgress(null);
      await capture.start();
    }
  } catch (err) {
    console.error('[v2] 開始／停止失敗', err);
    showAlert('開始／停止失敗：' + err, true);
  } finally {
    btn.disabled = false;
  }
}

/**
 * 關 App 之前把這場存下來。
 *
 * Rust 那邊收到關閉要求時會先擋下來、發 app-exit-requested、三秒後強制離開
 * （lib.rs 的 ExitRequested）。三秒是硬上限，所以這裡不能慢慢來。
 */
async function onExitRequested() {
  try {
    if (capture && capture.isRunning) await capture.stop();
    else if (sessionStore && !sessionStore.isEmpty()) await sessionStore.endSession();
  } catch (err) {
    console.error('[v2] 收尾失敗', err);
  }
  try {
    await window.__TAURI__.core.invoke('exit_app');
  } catch (err) {
    console.error('[v2] exit_app 失敗', err);
  }
}

function wireMeeting() {
  panel = new SubtitlePanel($('subtitle-panel'), { maxLines: 8 });
  sessionStore = new SessionStore();
  sessionStore.onPersistError = (err) => showAlert('紀錄存檔失敗：' + err, true);
  capture = new MeetingCapture({
    panel,
    store: sessionStore,
    settingsStore,
    onStatus: setStatus,
    onAlert: showAlert,
    onRunning: setRunningUi,
    onReport: showStopReport,
    onNotice: addPersistentNotice,
    onProgress: renderStopProgress,
    onPrecheck: askPrecheck,
    onMicAlert: showMicAlert,
  });
  library = new Library(
    {
      modal: $('library-modal'),
      list: $('library-list'),
      detail: $('library-detail'),
      search: $('library-search'),
      title: $('library-title'),
      back: $('btn-library-back'),
    },
    showAlert
  );

  $('btn-toggle').addEventListener('click', toggleCapture);
  $('btn-pause').addEventListener('click', togglePause);
  // 按了要看得到「有記到」，不然人會連按好幾下。
  $('btn-mark').addEventListener('click', () => {
    const n = capture.addMark();
    if (n) setText($('btn-mark'), '⭐ 已標 ' + n + ' 個');
  });
  $('btn-mic-alert-ok').addEventListener('click', () => capture.dismissMicAlert());
  $('btn-library').addEventListener('click', () => library.open());
  $('btn-library-close').addEventListener('click', () => library.close());
  $('btn-report-close').addEventListener('click', () => closeModal($('report-modal')));
  $('btn-report-name-save').addEventListener('click', saveMeetingName);
  // 打完名字直接按 Enter 是最自然的動作。⚠ 要 preventDefault：Enter 落在
  // 彈窗裡的 input 上會被當成「送出」，而這個框沒有 form，結果是整頁重載。
  $('report-name-input').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    saveMeetingName();
  });
  // ⚠ 開不了要講話。後端已經先 canonicalize＋is_dir 擋過，這裡只負責把那句話
  //   放到看得見的地方——資料夾被改名、被搬走、磁碟沒接上都走這條。
  $('btn-report-open-dir').addEventListener('click', async () => {
    if (!reportFolder) return;
    try {
      setReportError('');
      await window.__TAURI__.core.invoke('open_session_dir', { path: reportFolder });
    } catch (err) {
      setReportError('⚠ 開不了這場的資料夾：' + err);
      showAlert('開不了這場的資料夾：' + err, true);
    }
  });

  const { getCurrentWindow } = window.__TAURI__.window;
  const win = getCurrentWindow();
  // 藍牙掉成通話品質：Windows 與 App 都不會說一個字，
  // 所以 Rust 端量到的時候一定要衝到畫面上來。
  win.listen('audio-degraded', (event) => showAlert(String(event.payload), true));
  // 壓縮檔（them.mp3／me.mp3）出事：原始 wav 照錄、停止後也不刪，所以不搶那一格紅字——
  // 那格正顯示著藍牙／麥克風警示時，蓋掉它等於把真正壞掉的那件事藏起來。
  // 空著才放上去，不然用 toast。檔名本身也會留著 _incomplete。
  win.listen('compressed-copy-warning', (event) => {
    const el = $('alert-line');
    if (el.hidden || !el.classList.contains('fatal')) showAlert(String(event.payload), false);
    else toast(String(event.payload), true);
  });
  win.listen('app-exit-requested', onExitRequested);
}

function wireShell() {
  windowShell = new WindowShell({
    settingsStore,
    isModalOpen: () => openModalCount() > 0,
    onError: (msg) => toast(msg, true),
    onUserResize: forgetFit,
  });
  $('btn-window-mode').addEventListener('click', () => {
    // 切模式＝對尺寸的新指令，「還原成縮之前」那份記憶到這裡就作廢了
    forgetFit();
    windowShell.toggleMode();
  });
  $('btn-fit').addEventListener('click', toggleFit);
  // 雙擊標題列＝最常見的「把視窗弄回來」直覺動作，接同一個行為（含再按一次還原）。
  $('drag-region').addEventListener('dblclick', toggleFit);
  renderFitButton();
  $('btn-theme').addEventListener('click', toggleTheme);
  $('btn-pin').addEventListener('click', togglePin);
  $('btn-settings').addEventListener('click', () => {
    openModal($('settings-modal'));
    refreshDevices();
  });
  $('btn-refresh-devices').addEventListener('click', refreshDevices);
  $('btn-settings-close').addEventListener('click', () => closeModal($('settings-modal')));
  $('btn-settings-save').addEventListener('click', saveSettings);
  $('btn-pick-recording-dir').addEventListener('click', pickRecordingDir);
  $('set-opacity').addEventListener('input', refreshOpacityLabel);
  $('btn-open-log-dir').addEventListener('click', async () => {
    try {
      await window.__TAURI__.core.invoke('open_log_dir');
    } catch (err) {
      showAlert('開不了紀錄資料夾：' + err, true);
    }
  });
  // 路徑只填一次：它是固定的。⚠ 不用 showAlert 收場——設定頁一打開就跳警告
  // 太吵，而且路徑填不出來時欄位本來就空著，看得出來。
  window.__TAURI__.core
    .invoke('log_dir_path')
    .then((p) => {
      $('set-log-dir').value = p;
    })
    .catch((err) => console.error('log_dir_path failed: ' + err));
  // 設定檔位置。同上：只填一次，填不出來時欄位空著，看得出來。
  window.__TAURI__.core
    .invoke('settings_file_path')
    .then((p) => {
      $('set-settings-path').value = p;
    })
    .catch((err) => console.error('settings_file_path failed: ' + err));
  $('btn-close-app').addEventListener('click', () => window.__TAURI__.core.invoke('exit_app'));
}

async function boot() {
  // 最先裝：這之後任何一行拋錯都會進 logs/app-*.log。
  installFrontendLog();
  wireShell();
  wireMeeting();
  try {
    const settings = await settingsStore.load();
    populateForm(settings);
    applyTheme(settings.theme);
    applyFontSize(settings.font_size);
    applyDisplaySettings(settings);
    await applyAlwaysOnTop(settings.always_on_top);
    // ⚠ 一定要排在 load() 之後：外殼要先知道上次是小浮窗還是大視窗、各自多大。
    await windowShell.init();
    // 開機也偵測一次：這樣 log 裡就留有「這場用的是哪兩台裝置、幾 Hz」，
    // 事後回頭查一份糊掉的錄音時，那行是唯一的線索。
    await refreshDevices();
    logInfo(
      '設定已套用：theme=' + normalizeTheme(settings.theme) +
        ', always_on_top=' + Boolean(settings.always_on_top) +
        ', font_size=' + settings.font_size +
        ', window_mode=' + windowShell.mode +
        ', terms=' + ((settings.custom_context && settings.custom_context.terms) || []).length +
        ', translation_terms=' +
          normalizeTranslationTerms(
            settings.custom_context && settings.custom_context.translation_terms
          ).length
    );
    const audit = settingsStore.lastAudit;
    const clean = audit && !audit.missing.length && !audit.extra.length;
    setStatus(clean ? '準備好了，按「開始」收音' : '設定欄位對照有差異（見 console），仍可按「開始」');
    // 對照有差異只印 console 等於沒講——沒開 devtools 的人看不到，
    // 那正是本專案一路在踩的靜默失敗。所以畫面上也吼一聲。
    if (!clean) toast('欄位對照有差異，設定可能存不完整（見 console）', true);
  } catch (err) {
    console.error('[v2] 設定載入失敗', err);
    setText($('status-line'), '設定載入失敗：' + err);
    toast('設定載入失敗，畫面上的值都不是你的', true);
  }
}

window.addEventListener('DOMContentLoaded', boot);
