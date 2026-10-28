// 驗 src/v2/js/ogg-opus.js 的 OggOpusWriter 包得對不對。
//
// 做法：ffmpeg 產一份參考 ogg（16 kHz 單聲道、Opus 24k、每頁 100 ms）→ 拆出 OpusHead 與每個 Opus 封包
// → 交給我們的 OggOpusWriter 重包 → ffmpeg 開 CRC 檢查解碼。
// 對答案：① 解碼零錯誤 ② 解出來的樣本數跟參考檔一樣 ③ 每個音訊頁的時間碼跟參考檔一樣。
// 這三條任一條不對，Soniox 那頭的症狀會是「字幕對不上時間」或「整條串流不認」，而且零錯誤訊息。
//
// 用法：node app\tools\check_ogg_opus.mjs     （需要 PATH 上有 ffmpeg）
//       設 OGG_CHECK_SELFTEST=1 會多跑一項反向自檢（故意弄壞一頁，第①關必須叫）
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { OggOpusWriter } = await import(pathToFileURL(join(here, '..', 'src', 'v2', 'js', 'ogg-opus.js')).href);

const dir = mkdtempSync(join(tmpdir(), 'oggcheck-'));
const ref = join(dir, 'ref.ogg');
const ours = join(dir, 'ours.ogg');
let fail = 0;
const check = (ok, msg) => {
  console.log((ok ? '✓ ' : '✗ ') + msg);
  if (!ok) fail++;
};

try {
  // 有變化的聲音（掃頻＋雜訊），封包大小才會有大有小，lacing 才測得到
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'aevalsrc=0.4*sin(2*PI*(200+300*t)*t)+0.1*(random(0)-0.5):s=16000:d=12',
    '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '24k', '-application', 'voip',
    '-frame_duration', '20', '-page_duration', '100000', '-f', 'ogg', ref]);

  // 拆參考檔
  const data = readFileSync(ref);
  const pages = [];
  for (let pos = 0; pos < data.length;) {
    if (data.toString('latin1', pos, pos + 4) !== 'OggS') throw new Error('參考檔頁頭錯在 ' + pos);
    const granule = data.readBigInt64LE(pos + 6);
    const nseg = data[pos + 26];
    const lacing = [...data.subarray(pos + 27, pos + 27 + nseg)];
    let off = pos + 27 + nseg;
    const packets = [];
    let cur = [];
    for (const l of lacing) {
      cur.push(data.subarray(off, off + l));
      off += l;
      if (l < 255) {
        packets.push(Buffer.concat(cur));
        cur = [];
      }
    }
    if (cur.length) throw new Error('參考檔有跨頁封包，本檢查沒處理（參數變了？）');
    pages.push({ granule, packets });
    pos = off;
  }
  const head = pages[0].packets[0];
  const audio = pages.slice(2);
  const nPackets = audio.reduce((a, p) => a + p.packets.length, 0);
  console.log(`參考檔：${pages.length} 頁、${nPackets} 個 Opus 封包`);

  // 重包：每個封包 20 ms＝48 kHz 的 960 個樣本
  const w = new OggOpusWriter(12345);
  const out = [...w.headerPages(new Uint8Array(head))];
  const all = audio.flatMap((p) => p.packets);
  all.forEach((pkt, i) => {
    const page = w.addPacket(new Uint8Array(pkt), 960);
    if (page) out.push(page);
    if (i === all.length - 1) {
      const last = w.flush(true, w.preSkip + 12 * 48000); // 參考音訊長 12 秒
      if (last) out.push(last);
    }
  });
  writeFileSync(ours, Buffer.concat(out.map((p) => Buffer.from(p))));

  // ① CRC＋解碼零錯誤
  // ⚠ 看 stderr 有沒有字，不看結束代碼：故意弄壞一頁實測，ffmpeg 印「CRC mismatch!」但 exit 0
  //   （-err_detect explode 也一樣）。只看結束代碼的話這關永遠綠燈。
  const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-err_detect', 'crccheck', '-i', ours,
    '-f', 'null', '-'], { encoding: 'utf8' });
  const err = (r.stderr || '').trim() + (r.status ? ' exit ' + r.status : '');
  check(!err, 'ffmpeg 開 CRC 檢查解碼零錯誤' + (err ? '：' + err.slice(0, 300) : ''));
  if (process.env.OGG_CHECK_SELFTEST) {
    // 反向自檢：弄壞一頁，這關必須叫
    const bad = readFileSync(ours);
    bad[bad.indexOf('OggS', 2000, 'latin1') + 40] ^= 0xff;
    writeFileSync(ours + '.bad', bad);
    const rb = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-err_detect', 'crccheck', '-i', ours + '.bad',
      '-f', 'null', '-'], { encoding: 'utf8' });
    check(/CRC mismatch/.test(rb.stderr || ''), '反向自檢：弄壞一頁時第①關會叫');
  }

  // ② 解出來的樣本數一樣
  const decode = (f) => execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-i', f, '-f', 's16le', '-ac', '1',
    '-ar', '16000', '-'], { maxBuffer: 64 * 1024 * 1024 }).length;
  const a = decode(ref);
  const b = decode(ours);
  check(a === b, `解碼樣本數 參考 ${a / 2}／我們 ${b / 2}`);

  // ③ 每個音訊頁的時間碼一樣（參考檔也是 5 封包一頁；最後一頁 ffmpeg 會按實際長度裁，只比前面的）
  const ourGranules = [];
  const ob = readFileSync(ours);
  for (let pos = 0; pos < ob.length;) {
    ourGranules.push(ob.readBigInt64LE(pos + 6));
    const nseg = ob[pos + 26];
    pos += 27 + nseg + [...ob.subarray(pos + 27, pos + 27 + nseg)].reduce((x, y) => x + y, 0);
  }
  const refG = pages.slice(2, -1).map((p) => p.granule);
  const ourG = ourGranules.slice(2, 2 + refG.length);
  const firstDiff = refG.findIndex((g, i) => g !== ourG[i]);
  check(refG.length > 0 && firstDiff === -1,
    `音訊頁時間碼逐頁相同（比 ${refG.length} 頁）` + (firstDiff >= 0 ? `：第 ${firstDiff} 頁 ${refG[firstDiff]} vs ${ourG[firstDiff]}` : ''));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `有 ${fail} 項失敗` : '全過');
process.exit(fail ? 1 : 0);
