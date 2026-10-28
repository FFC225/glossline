/**
 * 麥克風「完全沒聲音」與「斷了」的監看。
 *
 * 純邏輯、不碰畫面、不碰 Tauri、時間由呼叫端給——這樣才測得到
 * （`tools/test_mic_watch.mjs`）。capture.js 每收到一包麥克風音訊就 `feed()`，
 * 每秒 `tick()` 一次，依回傳的事件顯示或收起警告。
 *
 * ⚠ **不能直接看音量大小**（實測結果）：
 *   某支 USB 麥克風一直送一個 11.44 Hz、振幅約 165 的低頻波，人耳聽不到，
 *   Windows 把麥克風音量拉到 0 時**講話會消失、這個波不會**。直接取峰值：
 *   正常安靜中位 164、音量 0 中位 149，分不開——門檻設低永遠不觸發，而且零錯誤訊息。
 *   先濾掉 300 Hz 以下再取峰值：正常安靜最小 15.3、音量 0 最大 9.4，完全分開。
 *
 * ⚠ 門檻 9 只量過**一支麥克風、一個房間**。內建麥克風還沒量，
 *   換機器時看 log 那行「麥克風每包峰值」的最小／中位數有沒有落在門檻兩邊。
 */

/** 濾波後每包峰值的 10 秒中位數低於這個就算「沒聲音」（16 bit 刻度）。 */
export const SILENT_THRESHOLD = 9;
/** 連續多久沒聲音才喊。 */
export const SILENT_MS = 10000;
/**
 * 多久一包都沒收到就算「斷了」。前端實際約 0.2 秒收一包（實測 log：後端 2909 包、
 * 前端 140 包），3 秒＝約十五包都沒來。所以「每包峰值」是 0.2 秒內的最大值、不是 10 毫秒。
 */
export const GAP_MS = 3000;
/** 高通截止頻率。語音在 300 Hz 以上，實測量到的低頻波在 11 Hz。 */
const HIGHPASS_HZ = 300;
const SAMPLE_RATE = 16000; // microphone.rs 送進前端的是 16 kHz 單聲道 s16le
/** 峰值計數表的格數：0.1 一格、到 40000（16 bit 滿刻度濾波後可能略超過 32768）。 */
const PEAK_BINS = 400001;

/** 二階高通（RBJ biquad，Q＝0.7071）。11 Hz 衰減到約千分之一。 */
function makeHighpass(fs, fc) {
  const w = (2 * Math.PI * fc) / fs;
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const c = Math.cos(w);
  const a0 = 1 + alpha;
  const b0 = (1 + c) / 2 / a0;
  const b1 = -(1 + c) / a0;
  const b2 = (1 + c) / 2 / a0;
  const a1 = (-2 * c) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return {
    /** 回傳這一段濾完之後的絕對值最大。濾波器狀態跨包延續。 */
    peak(samples) {
      let max = 0;
      for (let i = 0; i < samples.length; i++) {
        const x = samples[i];
        const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        const a = y < 0 ? -y : y;
        if (a > max) max = a;
      }
      return max;
    },
  };
}

function median(values) {
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export class MicWatch {
  constructor({ threshold = SILENT_THRESHOLD, silentMs = SILENT_MS, gapMs = GAP_MS } = {}) {
    this.threshold = threshold;
    this.silentMs = silentMs;
    this.gapMs = gapMs;
    /**
     * 整場的峰值統計，停止時寫進 log，換機器時回頭看門檻落點。
     * ⚠ 不存每一包：一包約 0.2 秒，三小時約五萬筆；包的間隔由後端決定、日後可能變密，不賭它。
     *   改成 0.1 一格的計數表（中位數準到 0.1）＋另記最小值。
     */
    this._hist = new Uint32Array(PEAK_BINS);
    this._count = 0;
    this._min = Infinity;
    this.reset(0);
  }

  /**
   * 重新開始計時：開場、休息後接回都要叫。
   * ⚠ 休息中後端不送封包，不 reset 的話接回那一刻就會因為「好幾分鐘沒封包」誤報斷線。
   */
  reset(now) {
    this._filter = makeHighpass(SAMPLE_RATE, HIGHPASS_HZ);
    this._window = []; // [{t, peak}]，只留最近 silentMs
    this._armedAt = now;
    this._lastPacketAt = null;
    /** 'ok'＝沒事｜'alerted'＝警告顯示中｜'dismissed'＝使用者按了知道了、等恢復 */
    this.state = 'ok';
    this.kind = null; // 'silent' | 'gone'
  }

  /** 收到一包 s16le 單聲道。`pcm` 是 ArrayBuffer 或 Uint8Array。 */
  feed(pcm, now) {
    let bytes = pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm);
    // Int16Array 要求起點是偶數位元組，不是的話先複製一份
    if (bytes.byteOffset % 2) bytes = bytes.slice();
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    const peak = this._filter.peak(samples);
    this._lastPacketAt = now;
    this._window.push({ t: now, peak });
    this._hist[Math.min(Math.round(peak * 10), PEAK_BINS - 1)] += 1;
    this._count += 1;
    if (peak < this._min) this._min = peak;
    while (this._window.length && this._window[0].t < now - this.silentMs) this._window.shift();
  }

  /** 現在有沒有問題：'gone'｜'silent'｜null。 */
  _problem(now) {
    const last = this._lastPacketAt === null ? this._armedAt : this._lastPacketAt;
    if (now - last >= this.gapMs) return 'gone';
    // 至少要監看滿 silentMs 才判沒聲音：剛開場、剛接回時視窗還不滿，中位數不可信
    if (now - this._armedAt < this.silentMs || !this._window.length) return null;
    return median(this._window.map((w) => w.peak)) < this.threshold ? 'silent' : null;
  }

  /**
   * 每秒叫一次。回傳要畫面做的事：
   *   {show: 'silent'|'gone'}｜{hide: true}｜null
   * ⚠ 按掉之後**聲音回來就重新開始監看**——不能按一次就整場失明。
   */
  tick(now) {
    const p = this._problem(now);
    if (p) {
      // 按掉只壓住「同一件事」：按掉沒聲音之後被拔線，照樣要喊斷了
      if (this.state === 'ok' || p !== this.kind) {
        this.state = 'alerted';
        this.kind = p;
        return { show: p };
      }
      return null;
    }
    const was = this.state;
    this.state = 'ok';
    this.kind = null;
    return was === 'alerted' ? { hide: true } : null;
  }

  /** 使用者按了「知道了」。收起，但恢復之前不再喊同一件事。 */
  dismiss() {
    if (this.state === 'alerted') this.state = 'dismissed';
  }

  /** 給 log 的一行：整場每包峰值的最小／中位數。 */
  summary() {
    if (!this._count) return '麥克風每包峰值（濾掉 300Hz 以下）：一包都沒有';
    let i = 0;
    for (let seen = this._hist[0]; seen * 2 < this._count; ) seen += this._hist[++i];
    return '麥克風每包峰值（濾掉 300Hz 以下）：' + this._count + ' 包，最小 ' + this._min.toFixed(1)
      + '、中位 ' + (i / 10).toFixed(1) + '（門檻 ' + this.threshold + '）';
  }
}
