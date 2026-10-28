/**
 * 把 16 kHz 單聲道 PCM 壓成 Opus、裝進 ogg，給 Soniox 用。
 *
 * 為什麼（實測結果）：
 *   原始 PCM 一路 256 kbps＝每小時 115 MB；Opus 24 kbps 每小時約 11 MB，
 *   延遲沒變、字幕差異與「同一份聲音送兩次」同一水準。網路慢的時候用的。
 *
 * ⚠ 只管「送給 Soniox 的那份」。錄音檔是 Rust 後端寫的 WAV，跟這裡無關。
 *
 * 兩塊：
 *   - OggOpusWriter：純粹把 Opus 封包包成 ogg 頁。不碰瀏覽器 API，
 *     所以 tools/check_ogg_opus.mjs 能用 node 單獨驗（拿 ffmpeg 解碼對答案）。
 *   - OpusOggEncoder：WebView2 內建的 AudioEncoder（WebCodecs）＋上面那支。
 *
 * ogg 一條連線一個：Soniox 要先看到兩個開頭頁（OpusHead、OpusTags）才認得後面的音訊，
 * 所以每次重連、休息後繼續都要開一個新的（soniox-client.js 的 connect() 負責）。
 */

const OGG_SAMPLE_RATE = 48000; // ogg 的時間碼一律以 48 kHz 計，不管實際取樣率
const PACKETS_PER_PAGE = 5; // 5 × 20 ms＝每頁 100 ms，跟實測那組一樣
/**
 * 有東西在排隊、卻這麼久一個輸出都沒有 → 當作編碼器卡住了。
 * ⚠ 卡住不一定會觸發 error 回呼：那會是「連線 live、keepalive 照送、
 *   字幕一片空白、零錯誤訊息」。
 * ⚠ 不能用「佇列超過幾包」判：重連後一次補送最多 10 秒的暫存（capture.js `_flushPending`），
 *   同步塞進來佇列瞬間上千，第一版就這樣誤判（瀏覽器實測一頁都沒產出）。
 */
const STALL_MS = 5000;

const CRC_TABLE = (() => {
  // ogg 的 CRC32：多項式 0x04C11DB7、不反轉、初值 0（跟 zip 那種不一樣）
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

function oggCrc(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  }
  return crc;
}

export class OggOpusWriter {
  constructor(serial = (Math.random() * 0xffffffff) >>> 0) {
    this.serial = serial;
    this.seq = 0;
    this.preSkip = 0;
    this.samples48k = 0; // 已包進頁的音訊長度（48 kHz 樣本數）
    this.pending = []; // 還沒包成頁的 Opus 封包
  }

  /**
   * 兩個開頭頁。`opusHead` 是編碼器給的 OpusHead（WebCodecs 的 decoderConfig.description）。
   * pre-skip 從裡面讀，時間碼要加上它，不然解碼端會把開頭多算一段。
   */
  headerPages(opusHead) {
    const head = new Uint8Array(opusHead);
    if (head.length < 19 || String.fromCharCode(...head.subarray(0, 8)) !== 'OpusHead') {
      throw new Error('編碼器給的開頭不是 OpusHead');
    }
    this.preSkip = head[10] | (head[11] << 8);
    const vendor = new TextEncoder().encode('glossline');
    const tags = new Uint8Array(8 + 4 + vendor.length + 4);
    tags.set(new TextEncoder().encode('OpusTags'), 0);
    new DataView(tags.buffer).setUint32(8, vendor.length, true);
    tags.set(vendor, 12);
    // 最後 4 個位元組＝0 個註解，Uint8Array 本來就是 0
    return [this._page([head], 0, 0x02), this._page([tags], 0, 0)];
  }

  /** 收一個 Opus 封包；湊滿一頁就回傳那一頁，否則回 null。 */
  addPacket(packet, samples48k) {
    this.pending.push(packet);
    this.samples48k += samples48k;
    return this.pending.length >= PACKETS_PER_PAGE ? this.flush() : null;
  }

  /**
   * 把手上剩的封包包成一頁（沒有就回 null）。`eos` 標記這條串流的最後一頁。
   *
   * ⚠ 時間碼＝到這頁為止「解出來的樣本數」，pre-skip **已經算在裡面**、不能再加
   *   （第一版加了，tools/check_ogg_opus.mjs 抓到每頁多 312、解碼多出 216 個樣本）。
   * `endGranule`：最後一頁用實際錄進去的長度（pre-skip＋輸入樣本），把編碼器補的尾巴裁掉。
   */
  flush(eos = false, endGranule = null) {
    if (!this.pending.length) return null;
    const packets = this.pending;
    this.pending = [];
    const granule = endGranule === null ? this.samples48k : Math.min(this.samples48k, endGranule);
    return this._page(packets, granule, eos ? 0x04 : 0);
  }

  _page(packets, granule, flags) {
    const lacing = [];
    for (const p of packets) {
      let n = p.length;
      while (n >= 255) {
        lacing.push(255);
        n -= 255;
      }
      lacing.push(n);
    }
    if (lacing.length > 255) throw new Error('一頁塞太多封包（lacing ' + lacing.length + '）');
    const bodyLen = packets.reduce((a, p) => a + p.length, 0);
    const page = new Uint8Array(27 + lacing.length + bodyLen);
    const dv = new DataView(page.buffer);
    page.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
    page[4] = 0; // 版本
    page[5] = flags;
    dv.setBigInt64(6, BigInt(granule), true);
    dv.setUint32(14, this.serial, true);
    dv.setUint32(18, this.seq++, true);
    // 22–25 是 CRC，先留 0 算完再填
    page[26] = lacing.length;
    page.set(lacing, 27);
    let off = 27 + lacing.length;
    for (const p of packets) {
      page.set(p, off);
      off += p.length;
    }
    dv.setUint32(22, oggCrc(page), true);
    return page;
  }
}

/** 這台機器的 WebView2 能不能壓 16 kHz 單聲道 Opus。不能就整場送 PCM。 */
export async function opusSupported(sampleRate, bitrate) {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return false;
  try {
    const r = await AudioEncoder.isConfigSupported(encoderConfig(sampleRate, bitrate));
    return Boolean(r && r.supported);
  } catch (_err) {
    return false;
  }
}

function encoderConfig(sampleRate, bitrate) {
  return {
    codec: 'opus',
    sampleRate,
    numberOfChannels: 1,
    bitrate,
    opus: { frameDuration: 20000, application: 'voip' },
  };
}

export class OpusOggEncoder {
  /**
   * @param {object} opts
   * @param {(page: Uint8Array) => void} opts.onPage 每產出一頁就交出去（開頭兩頁一定最先）。
   * @param {(err: unknown) => void} opts.onError 編碼器壞了。呼叫端要改送 PCM 並講出來。
   */
  constructor({ sampleRate, bitrate, onPage, onError }) {
    this.sampleRate = sampleRate;
    this.writer = new OggOpusWriter();
    this._onPage = onPage;
    this._onError = onError;
    this._headerSent = false;
    this._framesIn = 0; // 已送進編碼器的樣本數，當 AudioData 的時間戳
    this._broken = false;
    this._outputs = 0; // 編碼器吐出來的封包數，給卡住偵測用
    this._stallTimer = null;
    this.encoder = new AudioEncoder({
      output: (chunk, meta) => this._output(chunk, meta),
      error: (err) => this._fail(err),
    });
    this.encoder.configure(encoderConfig(sampleRate, bitrate));
  }

  _fail(err) {
    if (this._broken) return;
    this._broken = true;
    this._onError(err);
  }

  _output(chunk, meta) {
    this._outputs++;
    if (this._broken) return;
    try {
      if (!this._headerSent) {
        const desc = meta && meta.decoderConfig && meta.decoderConfig.description;
        if (!desc) throw new Error('編碼器第一包沒有附 OpusHead');
        for (const p of this.writer.headerPages(desc.buffer ? desc : new Uint8Array(desc))) this._onPage(p);
        this._headerSent = true;
      }
      const packet = new Uint8Array(chunk.byteLength);
      chunk.copyTo(packet);
      const samples48k = Math.round((chunk.duration * OGG_SAMPLE_RATE) / 1e6);
      const page = this.writer.addPacket(packet, samples48k);
      if (page) this._onPage(page);
    } catch (err) {
      this._fail(err);
    }
  }

  /** 餵一塊 s16le PCM（Uint8Array）。 */
  push(bytes) {
    if (this._broken || !bytes.length) return;
    this._armStallCheck();
    try {
      // 拷一份成獨立的 buffer：原本那塊可能從奇數位移開始，Int16Array 不收
      const pcm = new Int16Array(bytes.slice().buffer, 0, bytes.length >> 1);
      const data = new AudioData({
        format: 's16',
        sampleRate: this.sampleRate,
        numberOfFrames: pcm.length,
        numberOfChannels: 1,
        timestamp: Math.round((this._framesIn * 1e6) / this.sampleRate),
        data: pcm,
      });
      this._framesIn += pcm.length;
      this.encoder.encode(data);
      data.close();
    } catch (err) {
      this._fail(err);
    }
  }

  /** 有在餵才計時；喇叭閒置時沒有 push，也就不會誤判。 */
  _armStallCheck() {
    if (this._stallTimer) return;
    const seen = this._outputs;
    this._stallTimer = setTimeout(() => {
      this._stallTimer = null;
      if (!this._broken && this._outputs === seen && this.encoder.encodeQueueSize > 0) {
        this._fail(new Error('編碼器 ' + STALL_MS / 1000 + ' 秒沒有吐出任何東西（排隊 ' +
          this.encoder.encodeQueueSize + ' 包）'));
      }
    }, STALL_MS);
  }

  /**
   * 收尾：把編碼器裡剩的音框擠出來送掉。
   * ⚠ 刻意**不標** EOS：Soniox 若看到 EOS 就自己結束串流，收尾三步會各白等一輪逾時
   *   （未實測；不標沒有壞處，結束由 finalize＋空字串負責）。
   */
  async flush() {
    if (this._broken) return;
    try {
      await this.encoder.flush();
      const end = this.writer.preSkip + Math.round((this._framesIn * OGG_SAMPLE_RATE) / this.sampleRate);
      const page = this.writer.flush(false, end);
      if (page) this._onPage(page);
    } catch (err) {
      this._fail(err);
    }
  }

  close() {
    this._broken = true; // 之後就算還有輸出回來，也不再交頁
    clearTimeout(this._stallTimer);
    this._stallTimer = null;
    try {
      if (this.encoder.state !== 'closed') this.encoder.close();
    } catch (_err) {
      // 關不掉也無所謂，這條連線已經不用了
    }
  }
}
