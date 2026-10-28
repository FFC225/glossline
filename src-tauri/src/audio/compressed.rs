//! Compressed copy of a recording.
//!
//! An hour of `them.wav` is ~650 MB, too big to upload over a slow network.
//! This writes `them.mp3` / `me.mp3` (CBR 64 kbps mono at the device's own
//! rate: 28.8 MB/h) next to the WAV, *while* it records. mp3 because phones,
//! LINE and the Windows player all open it, and the post-meeting tools already
//! take a `them.mp3` when there is no `them.wav`.
//!
//! The WAV stays the archive. Everything here is built so that this copy can
//! only ever fail on its own:
//!   - Encoding and file writes happen on a thread of their own. The capture
//!     thread only copies the bytes the WAV just took and `try_send`s them —
//!     it never waits, never prints, never calls the UI while it holds the
//!     Recorder lock. A panic there would poison that lock and stop the WAV.
//!   - Any failure (cannot create, encoder error, write error, panic, queue
//!     full) stops this copy, says so once on stderr and on screen, and leaves
//!     the WAV alone.
//!   - While recording, the file is `them_incomplete.mp3`. Only a copy that
//!     got every frame and closed cleanly is renamed to `them.mp3`. A crash,
//!     a kill, an exit before the last frame, or any failure leaves the
//!     `_incomplete` name on it, so a short file can never pass for a whole
//!     meeting (the WAV has `repair_wav`; this copy has its name).
//!
//! It is fed from `Recorder` *after* the WAV write, with exactly the frames
//! that landed in the WAV (silence included), so the two share one time line.
//!
//! LAME (LGPL) is not linked into the exe: it is `libmp3lame.dll` beside it,
//! built from source by `tools/build_lame_dll.bat` and loaded here at run time,
//! so anyone can swap in their own build. No DLL, a broken one, or one missing
//! a function is just another failure of this copy. The first version of this
//! file wrote Ogg Vorbis.

use super::degraded::Warner;
use std::io::{Seek, SeekFrom, Write};
use std::os::raw::{c_int, c_uchar, c_void};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::Arc;
use std::time::Duration;

/// Every warning from this module starts with this, so the UI can show it
/// somewhere that does not cover a Bluetooth / microphone alert.
pub const WARNING_PREFIX: &str = "壓縮檔";

/// Messages in flight before the capture side gives up on this copy. Capture
/// sends one per ~10 ms packet, so this is tens of seconds of slack; an
/// encoder that far behind is broken, not slow (it runs ~250x real time).
const QUEUE_MSGS: usize = 4096;

/// How long Stop waits for the encoder to write its last page. The WAV is
/// already closed and its summary handed over by then. Past this the encoder
/// keeps going in the background and renames the file itself when done.
const FINISH_WAIT: Duration = Duration::from_secs(10);

/// CBR kbps. Legal at every rate we meet: MPEG-1 (48k/44.1k/32k),
/// MPEG-2 (24k/22.05k/16k) and MPEG-2.5 (12k/11.025k/8k) all have 64.
const KBPS: c_int = 64;

/// The encoder, beside the exe.
pub const LAME_DLL: &str = "libmp3lame.dll";

enum Msg {
    /// 16-bit little-endian interleaved frames, exactly as written to the WAV.
    Audio(Vec<u8>),
    /// This many frames of digital silence.
    Silence(u64),
}

/// What the encoder thread reports when it is done.
struct Done {
    frames: u64,
    bytes: u64,
}

pub struct CompressedTap {
    tx: Option<SyncSender<Msg>>,
    done: Option<Receiver<Option<Done>>>,
    /// The final name (`them.mp3`); the file is written under `incomplete_path`.
    path: PathBuf,
    rate: u32,
    channels: u16,
    /// Frames handed to the encoder so far (the WAV-side count).
    sent_frames: u64,
    /// The copy is missing frames (capture gave up on it). Set by the capture
    /// side *before* it lets go of the queue, so the encoder can never rename
    /// a short file to the final name.
    short: Arc<AtomicBool>,
    /// The warning has been shown (whichever side noticed first).
    announced: Arc<AtomicBool>,
    warn: Option<Warner>,
}

/// Same name as the WAV, `.mp3` extension: `them.wav` -> `them.mp3`.
pub fn compressed_path(wav: &Path) -> PathBuf {
    wav.with_extension("mp3")
}

/// `them.mp3` -> `them_incomplete.mp3`: the name while recording, and the name
/// that stays on any copy that did not close cleanly.
pub fn incomplete_path(mp3: &Path) -> PathBuf {
    let stem = mp3
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "recording".to_string());
    mp3.with_file_name(format!("{}_incomplete.mp3", stem))
}

/// `libmp3lame.dll` in the exe's own folder, by full path: never the system
/// search order, so a same-named DLL elsewhere cannot stand in for it.
/// (Test binaries live one folder deeper, in target/debug/deps.)
fn lame_dll_path() -> PathBuf {
    let dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_default();
    #[cfg(test)]
    {
        if !dir.join(LAME_DLL).exists() {
            if let Some(up) = dir.parent() {
                return up.join(LAME_DLL);
            }
        }
    }
    dir.join(LAME_DLL)
}

/// Say it once, on stderr and on screen. Never call this with the Recorder
/// lock held (it prints and calls into the UI).
fn announce(announced: &AtomicBool, warn: &Option<Warner>, path: &Path, why: &str) {
    if announced.swap(true, Ordering::SeqCst) {
        return;
    }
    let name = |p: &Path| {
        p.file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default()
    };
    let msg = format!(
        "{}（{}）停了：{}。原始錄音 {} 不受影響。",
        WARNING_PREFIX,
        name(path),
        why,
        name(&path.with_extension("wav"))
    );
    eprintln!("[recorder] COMPRESSED COPY STOPPED — {}", msg);
    if let Some(w) = warn {
        w(&msg);
    }
}

impl CompressedTap {
    /// Start the encoder thread. Never fails: if the thread cannot start, the
    /// tap is returned already stopped (and has said so).
    pub fn start(wav_path: &Path, rate: u32, channels: u16, warn: Option<Warner>) -> Self {
        Self::start_with(wav_path, rate, channels, warn, lame_dll_path())
    }

    fn start_with(wav_path: &Path, rate: u32, channels: u16, warn: Option<Warner>, dll: PathBuf) -> Self {
        let path = compressed_path(wav_path);
        let (tx, rx) = mpsc::sync_channel::<Msg>(QUEUE_MSGS);
        let (done_tx, done_rx) = mpsc::channel::<Option<Done>>();
        let short = Arc::new(AtomicBool::new(false));
        let announced = Arc::new(AtomicBool::new(false));
        let mut tap = Self {
            tx: Some(tx),
            done: Some(done_rx),
            path: path.clone(),
            rate,
            channels,
            sent_frames: 0,
            short: short.clone(),
            announced: announced.clone(),
            warn: warn.clone(),
        };
        let spawned = std::thread::Builder::new()
            .name("compressed-copy".into())
            .spawn(move || {
                let work = incomplete_path(&path);
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    encode_loop(&work, rate, channels, &rx, &dll)
                }))
                .unwrap_or_else(|_| Err("壓縮程式內部錯誤".to_string()));
                let done = match result {
                    Err(e) => {
                        // The queue stays open until this is said, so the
                        // real reason ("no DLL") is what shows, not capture's
                        // "encoder thread ended" from a closed queue.
                        announce(&announced, &warn, &path, &e);
                        drop(rx);
                        None
                    }
                    // Capture already announced why it gave up; keep the name.
                    Ok(_) if short.load(Ordering::SeqCst) => None,
                    Ok(d) => match std::fs::rename(&work, &path) {
                        Ok(_) => {
                            eprintln!(
                                "[recorder] compressed copy done: {} ({:.1}s, {} bytes)",
                                path.display(),
                                d.frames as f64 / rate as f64,
                                d.bytes
                            );
                            Some(d)
                        }
                        Err(e) => {
                            announce(&announced, &warn, &path, &format!("壓完了但改不了名（{}）", e));
                            None
                        }
                    },
                };
                let _ = done_tx.send(done);
            });
        if let Err(e) = spawned {
            tap.tx = None;
            tap.done = None;
            tap.short.store(true, Ordering::SeqCst);
            announce(&tap.announced, &tap.warn, &tap.path, &format!("無法啟動壓縮執行緒（{}）", e));
        }
        tap
    }

    fn block_align(&self) -> usize {
        self.channels as usize * 2
    }

    /// Frames that just landed in the WAV. Called with the Recorder lock held:
    /// one copy and a non-blocking send, nothing that prints, waits or panics.
    pub fn audio(&mut self, s16: &[u8]) {
        if s16.is_empty() || self.tx.is_none() {
            return;
        }
        let frames = (s16.len() / self.block_align()) as u64;
        self.send(Msg::Audio(s16.to_vec()), frames);
    }

    /// Silence that just landed in the WAV.
    pub fn silence(&mut self, frames: u64) {
        if frames == 0 || self.tx.is_none() {
            return;
        }
        self.send(Msg::Silence(frames), frames);
    }

    fn send(&mut self, msg: Msg, frames: u64) {
        let result = match &self.tx {
            Some(tx) => tx.try_send(msg),
            None => return,
        };
        let why = match result {
            Ok(()) => {
                self.sent_frames += frames;
                return;
            }
            Err(TrySendError::Full(_)) => "壓縮跟不上（排隊超過上限）",
            // The encoder thread already said why it stopped.
            Err(TrySendError::Disconnected(_)) => "壓縮執行緒意外結束",
        };
        // Order matters: mark the copy short *before* letting go of the queue,
        // or the encoder could drain it and rename a short file to them.mp3.
        self.short.store(true, Ordering::SeqCst);
        self.tx = None;
        // The warning prints and calls the UI: not here, under the lock.
        let (announced, warn, path) = (self.announced.clone(), self.warn.clone(), self.path.clone());
        let spawned = std::thread::Builder::new()
            .name("compressed-copy-warn".into())
            .spawn(move || announce(&announced, &warn, &path, why));
        if let Err(e) = spawned {
            // Last resort, so the stop leaves at least a log line. (The file
            // keeps its _incomplete name either way.) `writeln!`, not
            // `eprintln!`: that one panics if stderr fails, and a panic here,
            // under the Recorder lock, would stop the WAV.
            let _ = writeln!(
                std::io::stderr(),
                "[recorder] COMPRESSED COPY STOPPED — {} ({}); warning thread failed: {}",
                why,
                self.path.display(),
                e
            );
        }
    }

    /// Close the queue and wait (bounded) for the last page. Call it *after*
    /// the WAV summary has been handed over. Returns the encoded length in
    /// seconds when the copy is whole. Safe to call twice.
    pub fn finish(&mut self) -> Option<f64> {
        self.tx = None; // encoder drains what is queued, then flushes and tags
        let done = self.done.take()?;
        match done.recv_timeout(FINISH_WAIT) {
            // A real check, not a debug_assert: `Some` here is
            // what lets the WAV be deleted, so it must also hold in release.
            Ok(Some(d)) if d.frames != self.sent_frames => {
                // The encoder already gave it the final name; take that back,
                // so a copy this side does not trust never passes for whole.
                let _ = std::fs::rename(&self.path, incomplete_path(&self.path));
                announce(
                    &self.announced,
                    &self.warn,
                    &self.path,
                    &format!("壓縮格數 {} 與送出的 {} 不符", d.frames, self.sent_frames),
                );
                None
            }
            Ok(Some(d)) => Some(d.frames as f64 / self.rate as f64),
            // Already announced -- except when the warning thread in `send`
            // could not start; then this is the first word on screen.
            Ok(None) => {
                announce(&self.announced, &self.warn, &self.path, "壓縮中途停了（原因見 log）");
                None
            }
            Err(RecvTimeoutError::Timeout) => {
                announce(
                    &self.announced,
                    &self.warn,
                    &self.path,
                    "停止時還沒壓完，背景繼續壓；壓完才會從 _incomplete 改成正式檔名",
                );
                None
            }
            Err(RecvTimeoutError::Disconnected) => {
                announce(&self.announced, &self.warn, &self.path, "壓縮執行緒意外結束");
                None
            }
        }
    }
}

/// After a normal stop the WAV goes once this copy is
/// proven whole. Both lengths are read back from disk, not from the counts in
/// memory: the mp3 by walking every frame to the end of the file (a truncated
/// mp3 keeps a header claiming the whole meeting), the WAV from its parts'
/// sizes. They must be *equal*: both sides get the very same frames (a
/// real meeting and 8k/16k/44.1k/48k tests: difference 0), so any difference
/// is unexplained and keeps the WAV.
impl CompressedTap {
    /// Delete the WAV parts if, and only if, `encoded` says the copy closed
    /// whole and the file on disk agrees. Anything else keeps them, logs why,
    /// and says so on screen once (not again if this copy already announced
    /// its own failure). Call with no lock held. Returns whether it deleted.
    pub fn replace_wav(&self, encoded: Option<f64>, wav_parts: &[String]) -> bool {
        let wav_name = wav_parts
            .first()
            .and_then(|p| Path::new(p).file_name())
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "wav".to_string());
        let mp3_name = self
            .path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        let checked = match encoded {
            None => Err("壓縮檔沒有完整收尾".to_string()),
            Some(_) => self.check_whole(wav_parts),
        };
        let (mp3_frames, wav_frames) = match checked {
            Ok(v) => v,
            Err(why) => {
                eprintln!("[recorder] KEPT {}: {}", wav_parts.first().map(String::as_str).unwrap_or("?"), why);
                self.say_once(&format!(
                    "{}（{}）沒通過完整檢查，原始錄音 {} 留在資料夾裡、沒有刪：{}。",
                    WARNING_PREFIX, mp3_name, wav_name, why
                ));
                return false;
            }
        };
        let mut left = Vec::new();
        for part in wav_parts {
            if let Err(e) = remove_with_retry(Path::new(part)) {
                eprintln!("[recorder] KEPT {}: could not delete ({})", part, e);
                left.push((part.clone(), e));
            }
        }
        if left.is_empty() {
            eprintln!(
                "[recorder] deleted {} after verifying {} ({:.3}s, {} frames = wav {}{})",
                wav_parts[0],
                self.path.display(),
                mp3_frames as f64 / self.rate as f64,
                mp3_frames,
                wav_frames,
                if wav_parts.len() > 1 { format!(", {} parts", wav_parts.len()) } else { String::new() }
            );
            return true;
        }
        let names: Vec<String> = left
            .iter()
            .map(|(p, _)| Path::new(p).file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default())
            .collect();
        self.say_once(&format!(
            "{}（{}）是完整的，但原始錄音 {} 刪不掉、留在資料夾裡（{}）。可以之後自己刪。",
            WARNING_PREFIX,
            mp3_name,
            names.join("、"),
            left[0].1
        ));
        false
    }

    /// `(mp3 frames, wav frames)` when the final-name mp3 on disk is whole and
    /// as long as the WAV parts; otherwise why not.
    fn check_whole(&self, wav_parts: &[String]) -> Result<(u64, u64), String> {
        if wav_parts.is_empty() {
            return Err("沒有 wav 分檔清單".to_string());
        }
        // Renamed before this ran: everything moved together, nothing to judge here.
        if !self.path.parent().map(Path::exists).unwrap_or(false) {
            return Err("錄音資料夾在收尾前被改名或搬走，wav 跟著搬過去、沒有刪".to_string());
        }
        if incomplete_path(&self.path).exists() {
            return Err("資料夾裡還有 _incomplete 檔".to_string());
        }
        if !self.path.exists() {
            return Err("找不到正式檔名的 mp3".to_string());
        }
        let mp3 = mp3_frames_on_disk(&self.path, self.rate)?;
        let wav = wav_frames_on_disk(wav_parts, self.block_align() as u64)?;
        if mp3 != wav {
            return Err(format!(
                "長度不符（mp3 {:.3} 秒、wav {:.3} 秒）",
                mp3 as f64 / self.rate as f64,
                wav as f64 / self.rate as f64
            ));
        }
        Ok((mp3, wav))
    }

    fn say_once(&self, msg: &str) {
        if self.announced.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(w) = &self.warn {
            w(msg);
        }
    }
}

/// Windows may hold a just-closed file for a moment (indexer, antivirus).
fn remove_with_retry(path: &Path) -> std::io::Result<()> {
    let mut last = None;
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(300));
        }
        match std::fs::remove_file(path) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(e), // waiting will not bring it back
            Err(e) => last = Some(e),
        }
    }
    Err(last.unwrap())
}

/// Audio frames in our WAV parts: (file size - 44-byte header) / block align.
fn wav_frames_on_disk(parts: &[String], block: u64) -> Result<u64, String> {
    let mut frames = 0;
    for p in parts {
        let len = std::fs::metadata(p).map_err(|e| format!("讀不到 wav 分檔（{}）", e))?.len();
        frames += len.saturating_sub(super::recorder::HEADER_BYTES) / block.max(1);
    }
    Ok(frames)
}

/// Layer III frame header -> (bytes, samples per frame, sample rate).
fn frame_info(h: &[u8]) -> Option<(usize, u64, u32)> {
    if h.len() < 4 || h[0] != 0xFF || h[1] & 0xE0 != 0xE0 || (h[1] >> 1) & 3 != 1 {
        return None;
    }
    let version = (h[1] >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
    let v1 = version == 3;
    let kbps = if v1 {
        [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
    } else {
        [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
    }[(h[2] >> 4) as usize];
    let rate = match version {
        3 => [44100, 48000, 32000, 0],
        2 => [22050, 24000, 16000, 0],
        0 => [11025, 12000, 8000, 0],
        _ => return None,
    }[((h[2] >> 2) & 3) as usize];
    if kbps == 0 || rate == 0 {
        return None;
    }
    let pad = ((h[2] >> 1) & 1) as usize;
    let len = if v1 { 144 } else { 72 } * kbps * 1000 / rate as usize + pad;
    Some((len, if v1 { 1152 } else { 576 }, rate))
}

/// Playable length of an mp3 we wrote, in frames, the way ffprobe gets it:
/// the Info tag's frame count, minus the encoder delay and padding from its
/// LAME tag. Only after walking every frame header from the first byte to
/// exactly the last: a truncated file still carries the whole count.
fn mp3_frames_on_disk(path: &Path, rate: u32) -> Result<u64, String> {
    use std::io::{BufReader, Read};
    let file = std::fs::File::open(path).map_err(|e| format!("打不開 mp3（{}）", e))?;
    let len = file.metadata().map_err(|e| format!("讀不到 mp3 大小（{}）", e))?.len();
    let mut r = BufReader::with_capacity(64 * 1024, file);
    let mut head = [0u8; 4];
    let read_err = |e: std::io::Error| format!("讀 mp3 失敗（{}）", e);

    // Frame 1: the Info tag.
    r.read_exact(&mut head).map_err(read_err)?;
    let (first_len, spf, first_rate) = frame_info(&head).ok_or("mp3 開頭不是 mp3 框")?;
    if first_rate != rate {
        return Err(format!("mp3 取樣率 {} 不是錄音的 {}", first_rate, rate));
    }
    let mut first = vec![0u8; first_len];
    first[..4].copy_from_slice(&head);
    r.read_exact(&mut first[4..]).map_err(|_| "mp3 第一框不完整".to_string())?;
    let at = first.windows(4).position(|w| w == b"Info" || w == b"Xing").ok_or("mp3 沒有 Info 標頭")?;
    let be32 = |o: usize| -> Result<u32, String> {
        first
            .get(o..o + 4)
            .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
            .ok_or_else(|| "mp3 Info 標頭不完整".to_string())
    };
    let flags = be32(at + 4)?;
    if flags & 1 == 0 {
        return Err("mp3 Info 標頭沒有框數".to_string());
    }
    let tag_frames = be32(at + 8)? as u64;
    let mut o = at + 12;
    if flags & 2 != 0 {
        o += 4;
    }
    if flags & 4 != 0 {
        o += 100;
    }
    if flags & 8 != 0 {
        o += 4;
    }
    let lame = first.get(o..o + 24).ok_or("mp3 沒有 LAME 標頭")?;
    if &lame[..4] != b"LAME" {
        return Err("mp3 沒有 LAME 標頭".to_string());
    }
    let delay = ((lame[21] as u64) << 4) | (lame[22] as u64 >> 4);
    let padding = (((lame[22] & 0x0F) as u64) << 8) | lame[23] as u64;

    // Every other frame, to exactly the end of the file.
    let mut pos = first_len as u64;
    let mut walked = 0u64;
    while pos < len {
        if len - pos < 4 {
            return Err(format!("mp3 結尾有 {} 位元組不成框", len - pos));
        }
        r.read_exact(&mut head).map_err(read_err)?;
        let (n, _, fr) = frame_info(&head).ok_or_else(|| format!("mp3 第 {} 位元組不是框頭", pos))?;
        if fr != rate {
            return Err(format!("mp3 中途取樣率變成 {}", fr));
        }
        if pos + n as u64 > len {
            return Err("mp3 最後一框被截斷".to_string());
        }
        r.seek_relative(n as i64 - 4).map_err(read_err)?;
        pos += n as u64;
        walked += 1;
    }
    if walked != tag_frames {
        return Err(format!("mp3 實際 {} 框、檔頭寫 {} 框（檔案被截斷或被改過）", walked, tag_frames));
    }
    (tag_frames * spf)
        .checked_sub(delay + padding)
        .ok_or_else(|| "mp3 標頭的延遲與補位比整檔還長".to_string())
}

impl Drop for CompressedTap {
    /// A Recorder dropped without finishing its copy (failed start, unwinding
    /// capture thread) still closes the file, and it is closed by the time drop
    /// returns — so the caller can delete it right after.
    fn drop(&mut self) {
        let _ = self.finish();
    }
}

/// The encoder thread: everything that can fail lives here.
fn encode_loop(path: &Path, rate: u32, channels: u16, rx: &Receiver<Msg>, dll: &Path) -> Result<Done, String> {
    // The DLL first: without it there is no file at all, just the warning.
    let mut lame = Lame::open(dll, rate)?;
    let file = std::fs::File::create(path).map_err(|e| format!("無法建立檔案（{}）", e))?;
    // 8 KiB ≈ 1 s at 64 kbps: what a killed process can lose off the end.
    let mut out = std::io::BufWriter::with_capacity(8 * 1024, file);
    let mut bytes = 0u64;
    let mut put = |out: &mut std::io::BufWriter<std::fs::File>, data: &[u8]| -> Result<(), String> {
        out.write_all(data).map_err(|e| format!("寫檔失敗（{}）", e))?;
        bytes += data.len() as u64;
        Ok(())
    };

    let ch = channels.max(1) as usize;
    let block = ch * 2;
    let mut frames = 0u64;
    let mut mono: Vec<i16> = Vec::new();
    let mut mp3: Vec<u8> = Vec::new();
    // Silence goes in 100 ms blocks so an hour-long gap never allocates much.
    let silence_block = (rate as usize / 10).max(1);
    let zeros = vec![0i16; silence_block];

    for msg in rx.iter() {
        match msg {
            Msg::Audio(bytes) => {
                mono.clear();
                for frame in bytes.chunks_exact(block) {
                    let mut sum = 0i32;
                    for s in frame.chunks_exact(2) {
                        sum += i16::from_le_bytes([s[0], s[1]]) as i32;
                    }
                    mono.push((sum / ch as i32) as i16);
                }
                if !mono.is_empty() {
                    let n = lame.encode(&mono, &mut mp3)?;
                    put(&mut out, &mp3[..n])?;
                    frames += mono.len() as u64;
                }
            }
            Msg::Silence(n) => {
                let mut left = n;
                while left > 0 {
                    let k = left.min(silence_block as u64) as usize;
                    let n = lame.encode(&zeros[..k], &mut mp3)?;
                    put(&mut out, &mp3[..n])?;
                    left -= k as u64;
                    frames += k as u64;
                }
            }
        }
    }
    let n = lame.flush(&mut mp3)?;
    put(&mut out, &mp3[..n])?;
    // LAME's first frame was a placeholder; the real Info/LAME tag (frame
    // count, encoder delay and padding, which players use to trim the time
    // line back to exactly `frames`) is written over it. Same size, by design.
    // Offset 0 holds only because no ID3v2 tag goes in front (`no_id3` above):
    // add tags one day and this would overwrite them, silently.
    let n = lame.tag(&mut mp3)?;
    let fail = |e: std::io::Error| format!("寫不了 mp3 檔頭（{}）", e);
    out.flush().map_err(fail)?;
    let file = out.get_mut();
    file.seek(SeekFrom::Start(0)).map_err(fail)?;
    file.write_all(&mp3[..n]).map_err(fail)?;
    file.flush().map_err(fail)?;
    Ok(Done { frames, bytes })
}

type Gfp = *mut c_void;
type SetInt = unsafe extern "C" fn(Gfp, c_int) -> c_int;

/// The LAME calls we make, out of `libmp3lame.dll` (`lame.h` declares them
/// `__cdecl`, which on x64 is the C convention).
struct Lame {
    gfp: Gfp,
    encode_buffer: unsafe extern "C" fn(Gfp, *const i16, *const i16, c_int, *mut c_uchar, c_int) -> c_int,
    encode_flush: unsafe extern "C" fn(Gfp, *mut c_uchar, c_int) -> c_int,
    lametag_frame: unsafe extern "C" fn(Gfp, *mut c_uchar, usize) -> usize,
    close: unsafe extern "C" fn(Gfp) -> c_int,
    /// Unloaded only after `drop` has called `lame_close`.
    _lib: libloading::Library,
}

impl Lame {
    /// Load the DLL and set up CBR 64 kbps mono at `rate`, with no resampling
    /// (one thing fewer that could move the time line) and no ID3 tag.
    fn open(dll: &Path, rate: u32) -> Result<Lame, String> {
        if !dll.exists() {
            return Err(format!("找不到 mp3 編碼元件 {}（應放在程式旁邊）", LAME_DLL));
        }
        // SAFETY: loading runs the DLL's DllMain; it is our own LAME build.
        // Every function is looked up by name with the type `lame.h` gives it.
        unsafe {
            let lib = libloading::Library::new(dll)
                .map_err(|e| format!("mp3 編碼元件 {} 載入失敗（{}）", LAME_DLL, e))?;
            macro_rules! sym {
                ($name:literal, $t:ty) => {
                    *lib.get::<$t>(concat!($name, "\0").as_bytes()).map_err(|e| {
                        format!("mp3 編碼元件 {} 少了 {}（{}）", LAME_DLL, $name, e)
                    })?
                };
            }
            let init = sym!("lame_init", unsafe extern "C" fn() -> Gfp);
            let setters: [(&str, SetInt, c_int); 7] = [
                ("in_samplerate", sym!("lame_set_in_samplerate", SetInt), rate as c_int),
                ("out_samplerate", sym!("lame_set_out_samplerate", SetInt), rate as c_int),
                ("num_channels", sym!("lame_set_num_channels", SetInt), 1),
                ("mode", sym!("lame_set_mode", SetInt), 3), // MONO
                ("VBR", sym!("lame_set_VBR", SetInt), 0),   // vbr_off = CBR
                ("brate", sym!("lame_set_brate", SetInt), KBPS),
                ("bWriteVbrTag", sym!("lame_set_bWriteVbrTag", SetInt), 1),
            ];
            let no_id3 = sym!("lame_set_write_id3tag_automatic", unsafe extern "C" fn(Gfp, c_int));
            let init_params = sym!("lame_init_params", unsafe extern "C" fn(Gfp) -> c_int);
            let mut lame = Lame {
                gfp: std::ptr::null_mut(),
                encode_buffer: sym!(
                    "lame_encode_buffer",
                    unsafe extern "C" fn(Gfp, *const i16, *const i16, c_int, *mut c_uchar, c_int) -> c_int
                ),
                encode_flush: sym!("lame_encode_flush", unsafe extern "C" fn(Gfp, *mut c_uchar, c_int) -> c_int),
                lametag_frame: sym!("lame_get_lametag_frame", unsafe extern "C" fn(Gfp, *mut c_uchar, usize) -> usize),
                close: sym!("lame_close", unsafe extern "C" fn(Gfp) -> c_int),
                _lib: lib,
            };
            lame.gfp = init();
            if lame.gfp.is_null() {
                return Err("mp3 編碼器建不起來（lame_init）".to_string());
            }
            for (what, set, v) in setters {
                if set(lame.gfp, v) != 0 {
                    return Err(format!("mp3 編碼器不接受 {} = {}（{} Hz）", what, v, rate));
                }
            }
            no_id3(lame.gfp, 0);
            let r = init_params(lame.gfp);
            if r < 0 {
                return Err(format!("mp3 編碼器不接受這組設定（{} Hz、{} kbps 單聲道，錯誤 {}）", rate, KBPS, r));
            }
            // Which DLL did the work, so a swapped-in build shows in the log.
            if let Ok(ver) = lib_version(&lame._lib) {
                eprintln!("[recorder] mp3 encoder: LAME {} ({}), {} Hz {} kbps mono", ver, dll.display(), rate, KBPS);
            }
            Ok(lame)
        }
    }

    /// Encode mono samples; returns how many bytes of `out` to write.
    fn encode(&mut self, pcm: &[i16], out: &mut Vec<u8>) -> Result<usize, String> {
        // Worst case from lame.h: 1.25 * samples + 7200.
        out.resize(pcm.len() + pcm.len() / 4 + 7200, 0);
        // SAFETY: both pointers are valid for the lengths passed; mono, so
        // LAME reads only the first channel.
        let n = unsafe {
            (self.encode_buffer)(
                self.gfp,
                pcm.as_ptr(),
                pcm.as_ptr(),
                pcm.len() as c_int,
                out.as_mut_ptr(),
                out.len() as c_int,
            )
        };
        if n < 0 {
            return Err(format!("編碼出錯（LAME {}）", n));
        }
        Ok(n as usize)
    }

    fn flush(&mut self, out: &mut Vec<u8>) -> Result<usize, String> {
        out.resize(7200, 0);
        // SAFETY: `out` is valid for its length.
        let n = unsafe { (self.encode_flush)(self.gfp, out.as_mut_ptr(), out.len() as c_int) };
        if n < 0 {
            return Err(format!("收尾失敗（LAME {}）", n));
        }
        Ok(n as usize)
    }

    /// The final Info/LAME tag frame. Without it players cannot trim the
    /// encoder delay, so a missing tag is a failure, not a detail.
    fn tag(&mut self, out: &mut Vec<u8>) -> Result<usize, String> {
        out.resize(8192, 0);
        // SAFETY: `out` is valid for its length; LAME returns the size it
        // needs (and copies nothing) when that is too small.
        let mut n = unsafe { (self.lametag_frame)(self.gfp, out.as_mut_ptr(), out.len()) };
        if n > out.len() {
            out.resize(n, 0);
            n = unsafe { (self.lametag_frame)(self.gfp, out.as_mut_ptr(), out.len()) };
        }
        if n == 0 || n > out.len() {
            return Err("LAME 沒有產生 mp3 檔頭".to_string());
        }
        Ok(n)
    }
}

/// `get_lame_short_version()`, e.g. "3.100". Only for the log line.
unsafe fn lib_version(lib: &libloading::Library) -> Result<String, libloading::Error> {
    let f = *lib.get::<unsafe extern "C" fn() -> *const std::os::raw::c_char>(b"get_lame_short_version\0")?;
    let p = f();
    Ok(if p.is_null() {
        "?".to_string()
    } else {
        std::ffi::CStr::from_ptr(p).to_string_lossy().to_string()
    })
}

impl Drop for Lame {
    fn drop(&mut self) {
        if !self.gfp.is_null() {
            // SAFETY: gfp came from lame_init and is closed exactly once.
            unsafe { (self.close)(self.gfp) };
            self.gfp = std::ptr::null_mut();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::recorder::Recorder;
    use std::sync::Mutex;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "mt-mp3-{}-{}",
            tag,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// `mp3data_struct` from lame.h (`unsigned long` is 32 bits on Windows).
    #[repr(C)]
    #[derive(Default)]
    struct Mp3Data {
        header_parsed: c_int,
        stereo: c_int,
        samplerate: c_int,
        bitrate: c_int,
        mode: c_int,
        mode_ext: c_int,
        framesize: c_int,
        nsamp: u32,
        totalframes: c_int,
        framenum: c_int,
    }

    /// What a player gets: the mp3 decoded with the DLL's own decoder, the
    /// encoder delay and padding from the LAME tag trimmed off the way ffmpeg
    /// does it (decoder delay 528 + 1), as mono samples; and the sample rate.
    fn decode(path: &Path) -> (Vec<f32>, u32) {
        type HipInit = unsafe extern "C" fn() -> *mut c_void;
        type HipExit = unsafe extern "C" fn(*mut c_void) -> c_int;
        type HipB = unsafe extern "C" fn(
            *mut c_void,
            *mut c_uchar,
            usize,
            *mut i16,
            *mut i16,
            *mut Mp3Data,
            *mut c_int,
            *mut c_int,
        ) -> c_int;
        let mut data = std::fs::read(path).unwrap();
        unsafe {
            let lib = libloading::Library::new(lame_dll_path()).expect("libmp3lame.dll for the tests");
            let init = *lib.get::<HipInit>(b"hip_decode_init\0").unwrap();
            let exit = *lib.get::<HipExit>(b"hip_decode_exit\0").unwrap();
            let dec = *lib.get::<HipB>(b"hip_decode1_headersB\0").unwrap();
            let hip = init();
            let (mut l, mut r) = (vec![0i16; 1152], vec![0i16; 1152]);
            let mut info = Mp3Data::default();
            let (mut delay, mut padding) = (-1, -1);
            let mut pcm: Vec<i16> = Vec::new();
            // One whole frame per call (found from its own header), so nothing
            // is left sitting in the decoder's buffer at the end.
            let mut pos = 0usize;
            let mut frames = 0usize;
            while pos + 4 <= data.len() {
                let len = frame_len(&data[pos..pos + 4]).unwrap_or_else(|| panic!("no frame at byte {}", pos));
                let end = (pos + len).min(data.len());
                let (mut d, mut p) = (-1, -1);
                let n = dec(hip, data[pos..end].as_mut_ptr(), end - pos, l.as_mut_ptr(), r.as_mut_ptr(), &mut info, &mut d, &mut p);
                if d >= 0 {
                    delay = d;
                    padding = p;
                }
                assert!(n >= 0, "decode error in {} at frame {}", path.display(), frames);
                pcm.extend_from_slice(&l[..n as usize]);
                pos = end;
                frames += 1;
            }
            // mpglib runs two frames behind (it wants the next header before
            // it trusts this one): drain what it still holds.
            loop {
                let (mut d, mut p) = (-1, -1);
                let n = dec(hip, data.as_mut_ptr(), 0, l.as_mut_ptr(), r.as_mut_ptr(), &mut info, &mut d, &mut p);
                if n <= 0 {
                    break;
                }
                pcm.extend_from_slice(&l[..n as usize]);
            }
            exit(hip);
            assert!(delay >= 0, "no LAME tag in {}", path.display());
            let skip = delay as usize + 529;
            let tail = (padding as usize).saturating_sub(529);
            let end = pcm.len().saturating_sub(tail).max(skip);
            let out = pcm[skip.min(pcm.len())..end].iter().map(|v| *v as f32 / 32768.0).collect();
            (out, info.samplerate as u32)
        }
    }

    /// Byte length of the Layer III frame whose 4-byte header this is.
    fn frame_len(h: &[u8]) -> Option<usize> {
        frame_info(h).map(|f| f.0)
    }

    /// Same length as the WAV, within one mp3 frame (expected: exactly).
    fn assert_same_length(pcm_len: usize, wav_seconds: f64, rate: u32) {
        let wav_frames = (wav_seconds * rate as f64).round() as i64;
        let diff = pcm_len as i64 - wav_frames;
        eprintln!("[test] mp3 vs wav at {} Hz: {:+} frames", rate, diff);
        assert!(diff.abs() <= 1152, "mp3 {} frames vs wav {} ({:+})", pcm_len, wav_frames, diff);
    }

    /// 10 ms of a 440 Hz tone, interleaved s16.
    fn tone(rate: u32, channels: u16, start: u64) -> Vec<u8> {
        let n = rate as u64 / 100;
        let mut b = Vec::new();
        for i in start..start + n {
            let v = ((i as f64 * 440.0 * std::f64::consts::TAU / rate as f64).sin() * 8000.0) as i16;
            for _ in 0..channels {
                b.extend_from_slice(&v.to_le_bytes());
            }
        }
        b
    }

    fn rms(s: &[f32]) -> f64 {
        (s.iter().map(|x| (*x as f64).powi(2)).sum::<f64>() / s.len().max(1) as f64).sqrt()
    }

    fn collecting_warner() -> (Option<Warner>, Arc<Mutex<Vec<String>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s = seen.clone();
        let w: Warner = Arc::new(move |m: &str| s.lock().unwrap().push(m.to_string()));
        (Some(w), seen)
    }

    /// Pits 1 and 4: SILENT frames stay on the time line, and the WAV rolling
    /// over to -002/-003 does not disturb the single compressed file.
    #[test]
    fn same_length_and_silence_in_place_across_wav_rollover() {
        let dir = temp_dir("roll");
        let wav = dir.join("them.wav");
        let (warn, seen) = collecting_warner();
        // 400 kB per WAV part = ~2 s of 48 kHz stereo -> several parts.
        let rec = Recorder::create_with_limit(wav.clone(), 48000, 2, 400_000)
            .unwrap()
            .with_compressed_copy(warn);
        let mut t = 0u64;
        for _ in 0..300 {
            rec.write_s16(&tone(48000, 2, t)); // 3 s of tone
            t += 480;
        }
        rec.write_silence(48000 * 2); // 2 s of WASAPI SILENT
        for _ in 0..200 {
            rec.write_s16(&tone(48000, 2, t)); // 2 s of tone
            t += 480;
        }
        let s = rec.finish().unwrap();
        rec.finish_compressed();
        assert!(s.parts.len() >= 3, "test did not roll over: {:?}", s.parts);
        assert!(seen.lock().unwrap().is_empty(), "unexpected warning: {:?}", seen.lock().unwrap());
        // A whole copy replaces every WAV part.
        for p in &s.parts {
            assert!(!Path::new(p).exists(), "{} not deleted", p);
        }

        let (pcm, rate) = decode(&dir.join("them.mp3"));
        assert_eq!(rate, 48000);
        assert_same_length(pcm.len(), s.seconds, 48000);
        assert!((s.seconds - 7.0).abs() < 0.01);
        // tone rms = 8000/32768/sqrt(2) = 0.17
        assert!(rms(&pcm[48000..2 * 48000]) > 0.12, "tone missing before the gap");
        assert!(rms(&pcm[3 * 48000 + 4800..5 * 48000 - 4800]) < 0.001, "silence not silent");
        assert!(rms(&pcm[5 * 48000 + 4800..7 * 48000 - 4800]) > 0.12, "tone missing after the gap");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Pit 2: an idle endpoint sends nothing; wall-clock padding must reach the
    /// compressed copy too. Real time, ~1.5 s.
    #[test]
    fn wall_clock_padding_reaches_the_copy() {
        let dir = temp_dir("pad");
        let wav = dir.join("them.wav");
        let rec = Recorder::create(wav.clone(), 48000, 2).unwrap().with_compressed_copy(None);
        rec.write_s16(&tone(48000, 2, 0));
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_millis(1500) {
            std::thread::sleep(Duration::from_millis(10));
            rec.pad_to_wall_clock();
        }
        let s = rec.finish().unwrap();
        rec.finish_compressed();
        assert!(s.padded_seconds > 1.0, "wav was not padded: {:?}", s);
        let (pcm, _) = decode(&dir.join("them.mp3"));
        assert_same_length(pcm.len(), s.seconds, 48000);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Pit 5: Bluetooth call mode, 8 kHz mono (MPEG-2.5); and 16 kHz, 44.1 kHz.
    #[test]
    fn eight_khz_mono_call_mode_and_other_rates() {
        for (rate, ch) in [(8000u32, 1u16), (16000, 1), (44100, 2)] {
            let dir = temp_dir("rates");
            let wav = dir.join("me.wav");
            let rec = Recorder::create(wav.clone(), rate, ch).unwrap().with_compressed_copy(None);
            for i in 0..300 {
                rec.write_s16(&tone(rate, ch, i * (rate as u64 / 100)));
            }
            let s = rec.finish().unwrap();
            rec.finish_compressed();
            // The delete-WAV check reads exactly the WAV's length back off the disk.
            let on_disk = mp3_frames_on_disk(&dir.join("me.mp3"), rate).unwrap();
            let wav_frames = (s.seconds * rate as f64).round() as u64;
            eprintln!("[test] {} Hz: mp3 on disk {} frames, wav {}", rate, on_disk, wav_frames);
            assert_eq!(on_disk, wav_frames);
            assert!(!wav.exists(), "{} Hz: whole copy, WAV not deleted", rate);
            let (pcm, got) = decode(&dir.join("me.mp3"));
            assert_eq!(got, rate, "resampled");
            assert_same_length(pcm.len(), s.seconds, rate);
            assert!(rms(&pcm[rate as usize / 2..rate as usize * 5 / 2]) > 0.12, "{} Hz tone missing", rate);
            std::fs::remove_dir_all(&dir).ok();
        }
    }

    /// The WAV must come out byte-for-byte the same with or without the copy.
    #[test]
    fn wav_bytes_identical_with_and_without_copy() {
        let dir = temp_dir("same");
        let a = dir.join("a").join("them.wav");
        let b = dir.join("b").join("them.wav");
        let ra = Recorder::create_with_limit(a.clone(), 44100, 2, 300_000).unwrap();
        let rb = Recorder::create_with_limit(b.clone(), 44100, 2, 300_000)
            .unwrap()
            .with_compressed_copy(None);
        for r in [&ra, &rb] {
            for i in 0..250u64 {
                r.write_s16(&tone(44100, 2, i * 441));
                if i % 50 == 0 {
                    r.write_silence(4410);
                }
            }
            r.write_f32(&[0.5, -0.5, 0.25, -0.25]);
        }
        let sa = ra.finish().unwrap();
        let sb = rb.finish().unwrap();
        // Compared before finish_compressed(), which deletes b's WAV once its
        // mp3 proves whole.
        assert_eq!(sa.parts.len(), sb.parts.len());
        for (pa, pb) in sa.parts.iter().zip(sb.parts.iter()) {
            assert_eq!(std::fs::read(pa).unwrap(), std::fs::read(pb).unwrap(), "{} differs", pb);
        }
        rb.finish_compressed();
        assert!(!dir.join("a").join("them.mp3").exists(), "copy written without asking");
        ra.finish_compressed(); // no copy: nothing to replace, the WAV stays
        assert!(Path::new(&sa.parts[0]).exists(), "WAV without a copy was deleted");
        let (pcm, _) = decode(&dir.join("b").join("them.mp3"));
        assert_same_length(pcm.len(), sb.seconds, 44100);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The file starts with LAME's Info tag (not the placeholder), so players
    /// can trim the encoder delay; and no ID3 tag in front of it.
    #[test]
    fn file_starts_with_the_lame_info_tag() {
        let dir = temp_dir("tag");
        let rec = Recorder::create(dir.join("them.wav"), 48000, 1).unwrap().with_compressed_copy(None);
        for i in 0..100 {
            rec.write_s16(&tone(48000, 1, i * 480));
        }
        rec.finish().unwrap();
        rec.finish_compressed();
        let b = std::fs::read(dir.join("them.mp3")).unwrap();
        assert_eq!(b[0], 0xFF, "not an mp3 frame first (ID3?)");
        let head = &b[..200];
        let at = head.windows(4).position(|w| w == b"Info").expect("no Info tag in the first frame");
        assert!(head[at..].windows(4).any(|w| w == b"LAME"), "no LAME tag");
        // The frame-count field is filled in (the placeholder has zeros).
        let frames = u32::from_be_bytes([b[at + 8], b[at + 9], b[at + 10], b[at + 11]]);
        assert!(frames > 30, "Info frame count not written: {}", frames);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The copy cannot even be created: WAV carries on, the screen is told once.
    #[test]
    fn copy_that_cannot_be_created_leaves_the_wav_alone() {
        let dir = temp_dir("nocreate");
        std::fs::create_dir_all(dir.join("them_incomplete.mp3")).unwrap(); // a folder in the way
        let (warn, seen) = collecting_warner();
        let rec = Recorder::create(dir.join("them.wav"), 48000, 2).unwrap().with_compressed_copy(warn);
        for i in 0..200 {
            rec.write_s16(&tone(48000, 2, i * 480));
        }
        let s = rec.finish().unwrap();
        rec.finish_compressed();
        assert!((s.seconds - 2.0).abs() < 0.001, "wav length changed: {}", s.seconds);
        let w = seen.lock().unwrap();
        assert_eq!(w.len(), 1, "expected exactly one warning: {:?}", *w);
        assert!(w[0].contains("無法建立檔案"), "{}", w[0]);
        assert!(w[0].contains("them.wav 不受影響"), "{}", w[0]);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// No DLL, a file that is not a DLL, a DLL without LAME in it: each stops
    /// only the copy, says why once, and leaves no mp3 of either name.
    #[test]
    fn missing_or_broken_dll_stops_only_the_copy() {
        let dir = temp_dir("dll");
        let junk = dir.join("junk.dll");
        std::fs::write(&junk, b"not a dll").unwrap();
        let cases = [
            (dir.join("nowhere").join(LAME_DLL), "找不到 mp3 編碼元件"),
            (junk, "載入失敗"),
            (PathBuf::from(r"C:\Windows\System32\version.dll"), "少了 lame_init"),
        ];
        for (i, (dll, why)) in cases.into_iter().enumerate() {
            let sub = dir.join(i.to_string());
            std::fs::create_dir_all(&sub).unwrap();
            let (warn, seen) = collecting_warner();
            let mut tap = CompressedTap::start_with(&sub.join("me.wav"), 48000, 1, warn, dll);
            let t0 = std::time::Instant::now();
            for k in 0..300 {
                tap.audio(&tone(48000, 1, k * 480)); // capture never waits
            }
            assert!(t0.elapsed() < Duration::from_millis(200), "capture side waited");
            assert!(tap.finish().is_none());
            let w = seen.lock().unwrap();
            assert_eq!(w.len(), 1, "case {}: {:?}", i, *w);
            assert!(w[0].contains(why), "case {}: {}", i, w[0]);
            assert!(w[0].contains("me.wav 不受影響"), "{}", w[0]);
            assert!(!sub.join("me.mp3").exists() && !sub.join("me_incomplete.mp3").exists());
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    /// An encoder that falls behind: capture never blocks, the copy stops
    /// once, and the frames it did get are the only ones counted.
    #[test]
    fn full_queue_stops_the_copy_without_blocking() {
        let dir = temp_dir("full");
        let (tx, rx) = mpsc::sync_channel::<Msg>(2);
        let (warn, seen) = collecting_warner();
        let mut tap = CompressedTap {
            tx: Some(tx),
            done: None, // hand-built: no encoder thread to wait for
            path: dir.join("them.mp3"),
            rate: 48000,
            channels: 2,
            sent_frames: 0,
            short: Arc::new(AtomicBool::new(false)),
            announced: Arc::new(AtomicBool::new(false)),
            warn,
        };
        let t0 = std::time::Instant::now();
        for i in 0..10 {
            tap.audio(&tone(48000, 2, i * 480));
        }
        assert!(t0.elapsed() < Duration::from_millis(200), "capture side waited");
        assert_eq!(tap.sent_frames, 960, "only the two queued packets count");
        assert!(tap.short.load(Ordering::SeqCst), "copy not marked short");
        assert!(tap.tx.is_none());
        // The warning is shown from its own thread, never under the lock.
        let t1 = std::time::Instant::now();
        while seen.lock().unwrap().is_empty() && t1.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(seen.lock().unwrap().len(), 1);
        drop(rx);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// While recording, and after anything short of a clean close, the copy is
    /// `_incomplete`: a killed process cannot leave a short `them.mp3`.
    #[test]
    fn only_a_whole_copy_gets_the_final_name() {
        let dir = temp_dir("names");
        let rec = Recorder::create(dir.join("them.wav"), 48000, 2).unwrap().with_compressed_copy(None);
        for i in 0..100 {
            rec.write_s16(&tone(48000, 2, i * 480));
        }
        std::thread::sleep(Duration::from_millis(200));
        assert!(dir.join("them_incomplete.mp3").exists(), "not written under the working name");
        assert!(!dir.join("them.mp3").exists(), "final name used before the end");
        rec.finish().unwrap();
        rec.finish_compressed();
        assert!(dir.join("them.mp3").exists());
        assert!(!dir.join("them_incomplete.mp3").exists());

        // Same, but capture gave up on the copy halfway (queue full).
        let dir2 = temp_dir("short");
        let mut tap = CompressedTap::start(&dir2.join("me.wav"), 48000, 1, None);
        tap.audio(&tone(48000, 1, 0));
        tap.short.store(true, Ordering::SeqCst);
        assert!(tap.finish().is_none());
        assert!(dir2.join("me_incomplete.mp3").exists(), "short copy lost its warning name");
        assert!(!dir2.join("me.mp3").exists(), "short copy passed for a whole one");
        drop(tap);
        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&dir2).ok();
    }

    /// Dropped without finish() (failed start, unwinding thread): the file is
    /// still a valid mp3 and is closed by the time drop returns.
    #[test]
    fn drop_without_finish_closes_a_valid_file() {
        let dir = temp_dir("drop");
        let mp3 = dir.join("them.mp3");
        {
            let rec = Recorder::create(dir.join("them.wav"), 48000, 2).unwrap().with_compressed_copy(None);
            for i in 0..100 {
                rec.write_s16(&tone(48000, 2, i * 480));
            }
        }
        let (pcm, _) = decode(&mp3);
        assert_same_length(pcm.len(), 1.0, 48000);
        // No normal stop, so the WAV is never replaced.
        assert!(dir.join("them.wav").exists(), "dropped Recorder deleted its WAV");
        std::fs::remove_file(&mp3).expect("mp3 still held open after drop");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ── 錄完只留 mp3 ─────────────────────────────────

    /// A WAV recorded without a copy, and a tap fed the same frames by hand,
    /// so a test can break the copy in between.
    fn wav_and_tap(dir: &Path, dll: Option<PathBuf>) -> (RecordingSummaryLite, CompressedTap, Arc<Mutex<Vec<String>>>) {
        let wav = dir.join("me.wav");
        let rec = Recorder::create(wav.clone(), 48000, 1).unwrap();
        let (warn, seen) = collecting_warner();
        let mut tap = match dll {
            Some(d) => CompressedTap::start_with(&wav, 48000, 1, warn, d),
            None => CompressedTap::start(&wav, 48000, 1, warn),
        };
        for i in 0..100 {
            let t = tone(48000, 1, i * 480);
            rec.write_s16(&t);
            tap.audio(&t);
        }
        let s = rec.finish().unwrap();
        (RecordingSummaryLite { parts: s.parts }, tap, seen)
    }

    struct RecordingSummaryLite {
        parts: Vec<String>,
    }

    #[test]
    fn short_copy_keeps_the_wav_and_says_so_once() {
        let dir = temp_dir("c-short");
        let (s, mut tap, seen) = wav_and_tap(&dir, None);
        tap.short.store(true, Ordering::SeqCst); // capture gave up halfway
        let enc = tap.finish();
        assert!(enc.is_none());
        assert!(!tap.replace_wav(enc, &s.parts));
        assert!(Path::new(&s.parts[0]).exists(), "WAV deleted for a short copy");
        assert!(dir.join("me_incomplete.mp3").exists());
        assert_eq!(seen.lock().unwrap().len(), 1, "{:?}", seen.lock().unwrap());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn no_dll_no_mp3_keeps_the_wav_with_one_warning() {
        let dir = temp_dir("c-nodll");
        let (s, mut tap, seen) = wav_and_tap(&dir, Some(dir.join("nowhere").join(LAME_DLL)));
        let enc = tap.finish();
        assert!(!tap.replace_wav(enc, &s.parts));
        assert!(Path::new(&s.parts[0]).exists(), "WAV deleted with no mp3 at all");
        let w = seen.lock().unwrap();
        assert_eq!(w.len(), 1, "warned twice: {:?}", *w);
        assert!(w[0].contains("找不到 mp3 編碼元件"), "{}", w[0]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn length_mismatch_keeps_the_wav() {
        let dir = temp_dir("c-len");
        let (s, mut tap, seen) = wav_and_tap(&dir, None);
        // The WAV holds 10 ms (one capture packet) more than the copy got.
        let mut f = std::fs::OpenOptions::new().append(true).open(&s.parts[0]).unwrap();
        f.write_all(&vec![0u8; 960]).unwrap();
        drop(f);
        let enc = tap.finish();
        assert!(enc.is_some(), "the copy itself closed fine");
        assert!(!tap.replace_wav(enc, &s.parts));
        assert!(Path::new(&s.parts[0]).exists());
        assert!(dir.join("me.mp3").exists());
        let w = seen.lock().unwrap();
        assert_eq!(w.len(), 1, "{:?}", *w);
        assert!(w[0].contains("長度不符") && w[0].contains("me.wav"), "{}", w[0]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn whole_copy_deletes_the_wav_quietly() {
        let dir = temp_dir("c-ok");
        let (s, mut tap, seen) = wav_and_tap(&dir, None);
        let enc = tap.finish();
        assert!(tap.replace_wav(enc, &s.parts));
        assert!(!Path::new(&s.parts[0]).exists(), "WAV not deleted");
        assert!(dir.join("me.mp3").exists());
        assert!(seen.lock().unwrap().is_empty(), "{:?}", seen.lock().unwrap());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `finish` gave None (e.g. Stop timed out) yet a whole-looking mp3 is on
    /// disk: only `encoded` counts, so the WAV stays. (The timeout itself,
    /// 10 s, is not simulated here.)
    #[test]
    fn none_from_finish_keeps_the_wav_even_if_the_file_looks_whole() {
        let dir = temp_dir("c-timeout");
        let (s, mut tap, _seen) = wav_and_tap(&dir, None);
        assert!(tap.finish().is_some());
        assert!(mp3_frames_on_disk(&dir.join("me.mp3"), 48000).is_ok());
        assert!(!tap.replace_wav(None, &s.parts));
        assert!(Path::new(&s.parts[0]).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The WAV shorter than the copy (its last part lost a tail): also kept.
    #[test]
    fn mp3_longer_than_wav_keeps_the_wav() {
        let dir = temp_dir("c-shortwav");
        let (s, mut tap, seen) = wav_and_tap(&dir, None);
        let enc = tap.finish();
        let f = std::fs::OpenOptions::new().write(true).open(&s.parts[0]).unwrap();
        let len = f.metadata().unwrap().len();
        f.set_len(len - 2).unwrap(); // one mono frame
        drop(f);
        assert!(!tap.replace_wav(enc, &s.parts));
        assert!(Path::new(&s.parts[0]).exists());
        assert!(seen.lock().unwrap()[0].contains("長度不符"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The folder was renamed before the check ran: the WAV moved with it and
    /// is not deleted; the message says why instead of "mp3 missing".
    #[test]
    fn renamed_folder_keeps_the_wav_and_says_why() {
        let root = temp_dir("c-moved");
        let dir = root.join("2026-01-01_0900");
        std::fs::create_dir_all(&dir).unwrap();
        let (s, mut tap, seen) = wav_and_tap(&dir, None);
        let enc = tap.finish();
        let moved = root.join("週會-2026-01-01_0900");
        std::fs::rename(&dir, &moved).unwrap();
        assert!(!tap.replace_wav(enc, &s.parts));
        assert!(moved.join("me.wav").exists() && moved.join("me.mp3").exists());
        assert!(seen.lock().unwrap()[0].contains("改名"), "{:?}", seen.lock().unwrap());
        std::fs::remove_dir_all(&root).ok();
    }

    /// Held open by another program (no delete sharing): kept, said once.
    #[cfg(windows)]
    #[test]
    fn wav_that_cannot_be_deleted_is_kept_with_a_warning() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = temp_dir("c-locked");
        let (s, mut tap, seen) = wav_and_tap(&dir, None);
        let enc = tap.finish();
        let lock = std::fs::OpenOptions::new().read(true).share_mode(0).open(&s.parts[0]).unwrap();
        assert!(!tap.replace_wav(enc, &s.parts));
        drop(lock);
        assert!(Path::new(&s.parts[0]).exists());
        assert!(dir.join("me.mp3").exists());
        let w = seen.lock().unwrap();
        assert_eq!(w.len(), 1, "{:?}", *w);
        assert!(w[0].contains("刪不掉") && w[0].contains("me.wav"), "{}", w[0]);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A truncated mp3 keeps a header claiming the whole length; the walk
    /// to the end of the file is what catches it. So does a stray byte.
    #[test]
    fn truncated_or_padded_mp3_fails_the_check() {
        let dir = temp_dir("c-trunc");
        let (s, mut tap, _seen) = wav_and_tap(&dir, None);
        tap.finish().unwrap();
        let mp3 = dir.join("me.mp3");
        let whole = std::fs::read(&mp3).unwrap();
        let frames = mp3_frames_on_disk(&mp3, 48000).unwrap();
        assert_eq!(frames, 48000, "1 s of tone");
        assert!(wav_frames_on_disk(&s.parts, 2).unwrap() == 48000);
        std::fs::write(&mp3, &whole[..whole.len() / 2]).unwrap();
        let e = mp3_frames_on_disk(&mp3, 48000).unwrap_err();
        assert!(e.contains("截斷") || e.contains("框"), "{}", e);
        // Cut exactly at a frame boundary (last frame gone): every header is
        // fine, only the Info tag's frame count gives it away.
        let mut pos = 0;
        let mut last = 0;
        while pos < whole.len() {
            last = pos;
            pos += frame_len(&whole[pos..pos + 4]).unwrap();
        }
        std::fs::write(&mp3, &whole[..last]).unwrap();
        let e = mp3_frames_on_disk(&mp3, 48000).unwrap_err();
        assert!(e.contains("檔頭寫"), "{}", e);
        let mut longer = whole.clone();
        longer.push(0);
        std::fs::write(&mp3, &longer).unwrap();
        assert!(mp3_frames_on_disk(&mp3, 48000).is_err());
        assert!(mp3_frames_on_disk(&mp3, 44100).is_err(), "rate not checked");
        std::fs::remove_dir_all(&dir).ok();
    }
}
