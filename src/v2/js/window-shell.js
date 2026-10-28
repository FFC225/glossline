/**
 * 視窗外殼：大小兩種模式 ＋ 收音中自動收起外殼。
 *
 * 這支存在的理由，全部來自 `decorations: false`（沒有 Windows 自己的標題列）：
 *   - 沒有最大化／還原鈕 → 「小浮窗 ↔ 大視窗」只能自己做。
 *   - 沒有系統標題列 → 收起外殼時**必須留一條可拖動的帶子**，否則視窗會變成
 *     拖不動、也關不掉的一塊東西，而且不會有任何錯誤訊息。這條在 CSS 那邊
 *     （`body.chrome-hidden #drag-region` 保留 6px 高度）。
 *
 * ⚠ 尺寸與模式存在 **Rust Settings**，不是 localStorage。
 *   上游 `ui-shell.js` 用 localStorage，理由是省一次後端來回；但本專案已經定過規矩
 *   （見 main.js 的外觀／置頂那段）：設定只有一條路，才會被 `check_settings_fields.py`
 *   與載入時的形狀對照一起看顧。localStorage 會變成第二套設定系統，而且沒有任何機制看著它。
 *
 * ⚠ 這支**不碰警示列**（`#alert-line`）。斷線、藍牙降級、存檔失敗都是「不可靜默降級」那件事，
 *   外殼收起來的時候更要看得見，所以自動隱藏只收標題列與控制列。
 */

/** 對齊 `tauri.conf.json` 的 minWidth / minHeight。兩邊不一致時，視窗會被 Tauri 悄悄夾住。
 *
 * ⚠ 從 820×240 降到 360×200。原因是「並排」：Windows 貼齊分半之後，
 * 每半邊拿到的是**邏輯像素**——1920 實體寬的螢幕在 150% 縮放下只有 1280 邏輯寬，
 * 分半＝640，比舊的下限 820 還小，於是視窗**縮不下去、也無法與另一個 App 等寬**。
 * 下限一律用「畫面在這個寬度還讀得懂」來訂，不是用開發機的螢幕訂。 */
export const MIN_SIZE = Object.freeze({ w: 360, h: 200 });

/** 沒有記錄可用時，各模式的預設尺寸（overlay 那組＝tauri.conf.json 的開窗尺寸）。 */
export const MODE_DEFAULT_SIZE = Object.freeze({
  overlay: Object.freeze({ w: 900, h: 500 }),
  expanded: Object.freeze({ w: 1180, h: 760 }),
});

/** 模式 → 存尺寸的那格 Rust 設定名。 */
export const SIZE_KEY = Object.freeze({
  overlay: 'window_size_overlay',
  expanded: 'window_size_expanded',
});

/** 閒置多久收起外殼。上游用 3 秒，沿用。 */
export const AUTO_HIDE_IDLE_MS = 3000;

/** 程式自己改尺寸之後，這段時間內的 onResized 一律不算「使用者拉的」。 */
const SELF_RESIZE_GRACE_MS = 900;

/** 使用者拉完視窗到存檔之間的緩衝，避免拖動途中每一格都寫一次設定檔。 */
const RESIZE_SAVE_DEBOUNCE_MS = 500;

/* --------------------------------------------------------------------------
 * 純函式（沒有 DOM、沒有 Tauri），tools/test_window_shell.mjs 就是測這幾支。
 * ------------------------------------------------------------------------ */

/** 'expanded' 以外一律當 'overlay'（Rust 那格是自由字串，別假設它只會是這兩個值）。 */
export function normalizeMode(value) {
  return value === 'expanded' ? 'expanded' : 'overlay';
}

export function otherMode(value) {
  return normalizeMode(value) === 'expanded' ? 'overlay' : 'expanded';
}

/**
 * 把「記在設定檔裡的尺寸」變成可以直接用的尺寸，壞掉就回 null。
 *
 * ⚠ 比視窗下限小的一律夾到下限、**不是丟掉**：丟掉會讓視窗跳回預設尺寸，
 *   使用者只會看到「我明明調過，它自己變大了」；夾住則最多差幾十個像素。
 */
export function sanitizeSize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const w = Number(raw.w);
  const h = Number(raw.h);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  // 0、負數、以及「一看就不是螢幕尺寸」的值＝那筆記錄壞了，退回預設比較安全
  if (w <= 0 || h <= 0 || w > 20000 || h > 20000) return null;
  return { w: Math.max(MIN_SIZE.w, Math.round(w)), h: Math.max(MIN_SIZE.h, Math.round(h)) };
}

/** 這個模式該用多大：先看設定裡記的，壞掉或沒有就用預設。 */
export function pickSizeForMode(settings, mode) {
  const m = normalizeMode(mode);
  const saved = sanitizeSize(settings ? settings[SIZE_KEY[m]] : null);
  return saved || { ...MODE_DEFAULT_SIZE[m] };
}

/**
 * 現在該不該把外殼收起來。
 *
 * ⚠ 只有**收音中**才收：沒在收音時畫面是空的，收起標題列只會讓人以為 App 壞了。
 * ⚠ 有彈窗開著時不收：設定頁開著卻把底下的東西抽掉，看起來像畫面破圖。
 */
export function shouldAutoHide({ capturing, modalOpen }) {
  return Boolean(capturing) && !modalOpen;
}

/**
 * 「符合螢幕」要把視窗擺成多大、擺在哪（全部邏輯像素）。
 *
 * @param {{width:number,height:number,x:number,y:number,scale:number}} monitor
 *   螢幕的**實體**寬高與左上角座標，加上它的縮放比例。
 *
 * ⚠ 每一項都要各自除以 scale。兩台螢幕縮放不同時（例如一台橫放、一台直放），
 *   少除的那一項會算出「數字看起來對、實際大一圈或跑到隔壁螢幕」的結果，
 *   而且不會有任何錯誤訊息——只是視窗又被裁掉。
 * ⚠ 留一點邊（寬 94%、高 90%），免得剛好貼齊工作列、標題列被壓在下面。
 */
export function computeFitGeometry(monitor) {
  const scale = Number(monitor.scale) > 0 ? Number(monitor.scale) : 1;
  const logicalW = monitor.width / scale;
  const logicalH = monitor.height / scale;
  const w = Math.max(MIN_SIZE.w, Math.floor(logicalW * 0.94));
  const h = Math.max(MIN_SIZE.h, Math.floor(logicalH * 0.9));
  return {
    w,
    h,
    x: Math.floor(monitor.x / scale + (logicalW - w) / 2),
    y: Math.floor(monitor.y / scale + (logicalH - h) / 2),
  };
}

/* --------------------------------------------------------------------------
 * 外殼本體
 * ------------------------------------------------------------------------ */

export class WindowShell {
  /**
   * @param {object} opts
   * @param {{get: () => object, patch: (o: object) => Promise<object>}} opts.settingsStore
   * @param {() => boolean} opts.isModalOpen 目前有沒有彈窗開著。
   * @param {(msg: string) => void} [opts.onError] 存不起來／縮不動時給人看的一句話。
   * @param {() => void} [opts.onUserResize] **使用者自己**拉動視窗時叫一次。
   *   程式自己改的尺寸不算——這個分別很重要：「符合螢幕」記著一份「按之前長怎樣」，
   *   使用者一旦自己動過，那份記憶就過期了，不能再拿來還原。
   */
  constructor({ settingsStore, isModalOpen, onError, onUserResize }) {
    this.settingsStore = settingsStore;
    this.isModalOpen = isModalOpen || (() => false);
    this._onError = onError || (() => {});
    this._onUserResize = onUserResize || (() => {});

    this.mode = 'overlay';
    this.capturing = false;
    this.hidden = false;

    this._idleTimer = null;
    this._saveTimer = null;
    this._ignoreResizeUntil = 0;
    this._lastInteract = 0;

    this._onInteract = this._onInteract.bind(this);
  }

  /** 讀設定套用模式與尺寸，並開始盯著使用者自己拉的尺寸。⚠ 要在 settingsStore.load() 之後叫。 */
  async init() {
    const settings = this.settingsStore.get() || {};
    this.mode = normalizeMode(settings.window_mode);
    this._applyModeClass();
    this._renderButton();
    await this._applySize(pickSizeForMode(settings, this.mode));

    try {
      await this._api().getCurrentWindow().onResized(() => this._onResized());
    } catch (err) {
      // 接不到就只是「尺寸不會被記住」，不影響其他事，所以不吼給使用者看
      console.error('[shell] onResized 接不上，尺寸不會被記住', err);
    }

    window.addEventListener('mousemove', this._onInteract, { passive: true });
    window.addEventListener('mousedown', this._onInteract, { passive: true });
    window.addEventListener('keydown', this._onInteract);
    return this.mode;
  }

  /** 小浮窗 ↔ 大視窗。離開前先把目前這個模式的尺寸記下來。 */
  async toggleMode() {
    const next = otherMode(this.mode);
    await this.saveCurrentSize();

    this.mode = next;
    this._applyModeClass();
    this._renderButton();
    await this._applySize(pickSizeForMode(this.settingsStore.get() || {}, next));

    try {
      await this.settingsStore.patch({ window_mode: next });
    } catch (err) {
      console.error('[shell] 視窗模式存檔失敗', err);
      this._onError('視窗已切換，但這個選擇存不起來：' + err.message);
    }
    return next;
  }

  /**
   * 把目前的實際尺寸記到「現在這個模式」那一格。
   * 沒變就不寫——不然每次拖動都要覆寫一次整份 settings.json（金鑰也在裡面）。
   */
  async saveCurrentSize() {
    const size = await this._currentLogicalSize();
    if (!size) return false;
    const key = SIZE_KEY[this.mode];
    const settings = this.settingsStore.get() || {};
    const prev = sanitizeSize(settings[key]);
    if (prev && prev.w === size.w && prev.h === size.h) return true;
    try {
      await this.settingsStore.patch({ [key]: size });
      return true;
    } catch (err) {
      console.error('[shell] 視窗尺寸存檔失敗', err);
      return false;
    }
  }

  /** 收音開始／結束。只有收音中才會自動收起外殼。 */
  setCapturing(on) {
    this.capturing = Boolean(on);
    if (this.capturing) {
      this._armIdle();
    } else {
      clearTimeout(this._idleTimer);
      this._setHidden(false);
    }
  }

  /* ------------------------------ 內部 ------------------------------ */

  _api() {
    return window.__TAURI__.window;
  }

  _applyModeClass() {
    document.body.classList.toggle('expanded', this.mode === 'expanded');
  }

  _renderButton() {
    const btn = document.getElementById('btn-window-mode');
    if (!btn) return;
    // 跟「暗色／亮色」那顆同一套規矩：字上寫的是**現在是什麼**，不是按下去會變成什麼。
    btn.textContent = this.mode === 'expanded' ? '🗖 大視窗' : '🗗 小浮窗';
    btn.setAttribute('aria-pressed', String(this.mode === 'expanded'));
    btn.classList.toggle('is-on', this.mode === 'expanded');
  }

  async _applySize(size) {
    try {
      const api = this._api();
      this.noteProgrammaticResize();
      await api.getCurrentWindow().setSize(new api.LogicalSize(size.w, size.h));
      return true;
    } catch (err) {
      console.error('[shell] 視窗尺寸套用失敗', err);
      this._onError('視窗尺寸調不動：' + err);
      return false;
    }
  }

  /**
   * 實際尺寸換算回邏輯像素。
   * ⚠ 少了除以縮放比例這一步，在 150% 的螢幕上存回去的數字會大一圈，
   *   而且每開一次就再大一圈——看起來像視窗自己在長大。
   */
  async _currentLogicalSize() {
    try {
      const win = this._api().getCurrentWindow();
      const factor = (await win.scaleFactor()) || 1;
      const size = await win.innerSize();
      return sanitizeSize({ w: size.width / factor, h: size.height / factor });
    } catch (err) {
      console.error('[shell] 讀不到目前視窗尺寸', err);
      return null;
    }
  }

  /**
   * 我們自己要改視窗尺寸之前先叫這個，接下來那一下的 onResized 就不會被當成
   * 「使用者拉的」。⚠ 少了這步，「符合螢幕」自己造成的 resize 會反過來把
   * 「按之前長怎樣」那份記憶洗掉，於是還原鈕按下去回到錯的大小。
   */
  noteProgrammaticResize() {
    this._ignoreResizeUntil = Date.now() + SELF_RESIZE_GRACE_MS;
  }

  _onResized() {
    if (Date.now() < this._ignoreResizeUntil) return; // 這是我們自己改的，不是使用者拉的
    this._onUserResize();
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveCurrentSize(), RESIZE_SAVE_DEBOUNCE_MS);
  }

  _onInteract() {
    const now = Date.now();
    // 字幕一直在動的時候 mousemove 會很密集，節流一下
    if (now - this._lastInteract < 100) return;
    this._lastInteract = now;
    if (this.hidden) this._setHidden(false);
    if (this.capturing) this._armIdle();
  }

  _armIdle() {
    clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      if (shouldAutoHide({ capturing: this.capturing, modalOpen: this.isModalOpen() })) {
        this._setHidden(true);
      }
    }, AUTO_HIDE_IDLE_MS);
  }

  _setHidden(hide) {
    const want = Boolean(hide);
    if (want === this.hidden) return;
    this.hidden = want;
    document.body.classList.toggle('chrome-hidden', want);
  }
}
