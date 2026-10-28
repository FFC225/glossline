//! Raw-tap WAV recorder.
//!
//! The archived recording MUST keep silence and MUST stay on a real
//! time line, because it is handed to a post-meeting transcription tool afterwards.
//! Two independent tools have already lost audio by "helpfully" dropping quiet
//! parts, so this recorder never drops anything.
//!
//! It taps the capture path *before* the 16 kHz/mono conversion, so what lands
//! on disk is the device's own sample rate and channel count (16-bit PCM).
//!
//! Three things keep the time line honest:
//!   1. WASAPI SILENT packets are written as real zero frames, not skipped.
//!   2. `pad_to_wall_clock()` is called from the capture loop every poll, so a
//!      render endpoint that goes completely idle (WASAPI then delivers *no*
//!      packets at all, not silent ones) still advances the file.
//!   3. `finish()` pads out to the wall clock before patching the header, so a
//!      recording that ends during silence keeps its full duration.
//!
//! Two more keep the file readable afterwards:
//!   4. A WAV size field is 32-bit, so one file cannot describe more than 4 GiB.
//!      Past that the sizes wrap and the file is silently wrong, so the recorder
//!      rolls over to `<stem>-002.wav`, `-003`, ... before it can get there.
//!   5. The sizes are only known at `finish()`, so a recorder that is killed
//!      (crash, Task Manager, power loss) leaves a header claiming 0 bytes and
//!      players show an empty file. `repair_wav()` puts the real length back.
//!
//! `with_compressed_copy()` adds `them.mp3` beside the WAV (see
//! `compressed.rs`); without it this file behaves exactly as before. With it,
//! a normal stop ends with the WAV deleted once that mp3 proves
//! whole on disk (`finish_compressed`); every other ending keeps it. ⚠ This
//! file is no longer identical to the standalone recorder's copy of it:
//! copying it there also needs `compressed.rs` and `libmp3lame.dll`.

use super::compressed::CompressedTap;
use super::degraded::Warner;
use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

/// Only pad when we are behind by more than this; below it the deficit is
/// ordinary buffer jitter and padding would push real audio later in the file.
const PAD_THRESHOLD_SECS: f64 = 0.25;

/// A canonical PCM WAV header is 44 bytes and audio starts right after it.
pub(crate) const HEADER_BYTES: u64 = 44;

/// Roll over to the next part before the 32-bit size fields can overflow.
/// 3.8 GB is ~5.5 h of 48 kHz stereo 16-bit, ~11 h of the mono microphone file.
pub const DEFAULT_MAX_DATA_BYTES: u64 = 3_800_000_000;

/// Long gaps are padded in chunks so an hour-long one never allocates 700 MB.
const SILENCE_CHUNK_BYTES: usize = 1 << 20;

/// Files touched this recently are assumed to be open in another capture thread
/// and are left alone by `repair_dir` — that thread patches its own header.
const REPAIR_MIN_AGE: Duration = Duration::from_secs(10);

struct Inner {
    file: BufWriter<File>,
    /// Bytes of audio in the part currently open (drives the roll-over).
    file_data_bytes: u64,
    /// Bytes of audio across every part.
    data_bytes: u64,
    /// Frames across every part — this is what the wall clock is compared to.
    frames: u64,
    padded_frames: u64,
    pad_events: u64,
    started: Instant,
    /// 1-based index of the part currently open.
    part: u32,
    parts: Vec<String>,
    /// Set when writing has failed for good; stops the retry storm without
    /// pretending the recording is still running.
    dead: bool,
    /// Compressed copy (`them.mp3`), fed with
    /// exactly the frames that landed in the WAV. Optional and isolated: it
    /// never changes what the WAV gets (see `compressed.rs`).
    tap: Option<CompressedTap>,
}

/// A running 16-bit PCM WAV file. Cheap to call from an audio thread: one
/// mutex, one buffered write.
pub struct Recorder {
    inner: Mutex<Option<Inner>>,
    path: PathBuf,
    rate: u32,
    channels: u16,
    max_data_bytes: u64,
    /// The compressed copy after `finish()`
    /// has closed the WAV, waiting for `finish_compressed()` (or drop),
    /// with the WAV parts it may replace.
    closing_copy: Mutex<Option<(CompressedTap, Vec<String>)>>,
}

/// What a finished recording turned out to be (logged, and returned to the UI).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSummary {
    /// First (usually only) part; kept for callers that want a single name.
    pub path: String,
    /// Every part written, in order. One entry unless the recording rolled over.
    pub parts: Vec<String>,
    pub seconds: f64,
    pub bytes: u64,
    /// Silence inserted to keep the time line true (see `pad_to_wall_clock`).
    pub padded_seconds: f64,
    pub pad_events: u64,
}

/// What `repair_wav` found and fixed.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairReport {
    pub path: String,
    /// The (wrong) size the header claimed.
    pub header_data_bytes: u64,
    /// The size the file actually holds.
    pub actual_data_bytes: u64,
}

impl Recorder {
    /// Create the file and write a placeholder header. Sizes are patched by
    /// `finish()`; a crash therefore leaves a header claiming 0 bytes of data,
    /// which `repair_wav` can fix from the real file length.
    pub fn create(path: PathBuf, rate: u32, channels: u16) -> Result<Self, String> {
        Self::create_with_limit(path, rate, channels, DEFAULT_MAX_DATA_BYTES)
    }

    /// Same, with an explicit per-file size cap. Only tests pass a small one.
    pub fn create_with_limit(
        path: PathBuf,
        rate: u32,
        channels: u16,
        max_data_bytes: u64,
    ) -> Result<Self, String> {
        if rate == 0 || channels == 0 {
            return Err(format!("bad format: {} Hz, {} ch", rate, channels));
        }
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("create dir: {}", e))?;
        }
        let file = File::create(&path).map_err(|e| format!("create {:?}: {}", path, e))?;
        let mut file = BufWriter::new(file);
        write_header(&mut file, rate, channels, 0).map_err(|e| format!("header: {}", e))?;
        Ok(Self {
            inner: Mutex::new(Some(Inner {
                file,
                file_data_bytes: 0,
                data_bytes: 0,
                frames: 0,
                padded_frames: 0,
                pad_events: 0,
                started: Instant::now(),
                part: 1,
                parts: vec![path.to_string_lossy().to_string()],
                dead: false,
                tap: None,
            })),
            path,
            rate,
            channels,
            // Never let a caller ask for more than the 32-bit fields can hold.
            max_data_bytes: max_data_bytes.min(DEFAULT_MAX_DATA_BYTES),
            closing_copy: Mutex::new(None),
        })
    }

    /// Also write a compressed copy beside the
    /// WAV (`them.wav` -> `them.mp3`). Its failures stop only that copy and
    /// are announced through `warn`; the WAV is unaffected.
    pub fn with_compressed_copy(self, warn: Option<Warner>) -> Self {
        let tap = CompressedTap::start(&self.path, self.rate, self.channels, warn);
        if let Ok(mut guard) = self.inner.lock() {
            if let Some(inner) = guard.as_mut() {
                inner.tap = Some(tap);
            }
        }
        self
    }

    fn block_align(&self) -> u64 {
        self.channels as u64 * 2
    }

    /// `dir/stem.wav` for part 1, then `dir/stem-002.wav`, `-003`, ...
    fn part_path(&self, part: u32) -> PathBuf {
        if part <= 1 {
            return self.path.clone();
        }
        let dir = self.path.parent().map(PathBuf::from).unwrap_or_default();
        let stem = self
            .path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "recording".to_string());
        let name = match self.path.extension() {
            Some(ext) => format!("{}-{:03}.{}", stem, part, ext.to_string_lossy()),
            None => format!("{}-{:03}", stem, part),
        };
        dir.join(name)
    }

    /// Write already-16-bit interleaved audio.
    pub fn write_s16(&self, bytes: &[u8]) {
        let mut guard = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if let Some(inner) = guard.as_mut() {
            let before = inner.frames;
            self.write_locked(inner, bytes);
            // Hand the compressed copy exactly what the WAV took.
            let took = (inner.frames - before).saturating_mul(self.block_align());
            if let (Some(tap), Some(landed)) = (inner.tap.as_mut(), bytes.get(..took as usize)) {
                tap.audio(landed);
            }
        }
    }

    /// Write f32 interleaved audio, converted to 16-bit.
    pub fn write_f32(&self, samples: &[f32]) {
        let mut buf = Vec::with_capacity(samples.len() * 2);
        for &s in samples {
            let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
            buf.extend_from_slice(&v.to_le_bytes());
        }
        self.write_s16(&buf);
    }

    /// Write `frames` frames of digital silence. Used for WASAPI's SILENT flag,
    /// where the buffer contents are explicitly undefined.
    pub fn write_silence(&self, frames: u64) {
        if frames == 0 {
            return;
        }
        let mut guard = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if let Some(inner) = guard.as_mut() {
            self.write_zeros_locked(inner, frames);
        }
    }

    /// Insert silence for time that elapsed without any audio arriving.
    /// Call this from the capture loop, not only when data shows up.
    pub fn pad_to_wall_clock(&self) {
        let mut guard = match self.inner.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if let Some(inner) = guard.as_mut() {
            self.pad_locked(inner);
        }
    }

    fn pad_locked(&self, inner: &mut Inner) {
        let expected = (inner.started.elapsed().as_secs_f64() * self.rate as f64) as u64;
        let deficit = expected.saturating_sub(inner.frames);
        if (deficit as f64) / self.rate as f64 <= PAD_THRESHOLD_SECS {
            return;
        }
        let before = inner.frames;
        self.write_zeros_locked(inner, deficit);
        let written = inner.frames - before;
        if written > 0 {
            inner.padded_frames += written;
            inner.pad_events += 1;
        }
    }

    fn write_zeros_locked(&self, inner: &mut Inner, frames: u64) {
        let mut left = frames.saturating_mul(self.block_align());
        if left == 0 {
            return;
        }
        let before = inner.frames;
        let chunk = vec![0u8; (SILENCE_CHUNK_BYTES as u64).min(left) as usize];
        while left > 0 && !inner.dead {
            let n = left.min(chunk.len() as u64) as usize;
            self.write_locked(inner, &chunk[..n]);
            left -= n as u64;
        }
        // Silence and wall-clock padding both pass here; the compressed copy
        // gets the same number of frames as a count, not a buffer of zeros.
        let took = inner.frames - before;
        if let Some(tap) = inner.tap.as_mut() {
            tap.silence(took);
        }
    }

    /// The one place bytes reach the file: splits the write at the size cap and
    /// rolls over to the next part instead of overflowing the 32-bit fields.
    fn write_locked(&self, inner: &mut Inner, bytes: &[u8]) {
        if inner.dead {
            return;
        }
        let block = self.block_align() as usize;
        let mut rest = bytes;
        while !rest.is_empty() {
            let mut room = self.max_data_bytes.saturating_sub(inner.file_data_bytes) as usize;
            room -= room % block; // never split a frame across two files
            if room == 0 {
                if !self.roll_part(inner) {
                    return;
                }
                continue;
            }
            let n = room.min(rest.len());
            if inner.file.write_all(&rest[..n]).is_err() {
                eprintln!(
                    "[recorder] RECORDING STOPPED — write failed on {}",
                    inner.parts.last().map(|s| s.as_str()).unwrap_or("?")
                );
                inner.dead = true;
                return;
            }
            inner.file_data_bytes += n as u64;
            inner.data_bytes += n as u64;
            inner.frames += (n / block) as u64;
            rest = &rest[n..];
        }
    }

    /// Close the current part (patching its header) and open the next one.
    /// Returns false if the next part could not be created; the recording then
    /// stops loudly rather than writing a file whose sizes have wrapped.
    fn roll_part(&self, inner: &mut Inner) -> bool {
        let next_path = self.part_path(inner.part + 1);
        let next = match File::create(&next_path) {
            Ok(f) => f,
            Err(e) => {
                eprintln!(
                    "[recorder] RECORDING STOPPED — cannot open next part {:?}: {}",
                    next_path, e
                );
                inner.dead = true;
                return false;
            }
        };
        let mut next = BufWriter::new(next);
        if let Err(e) = write_header(&mut next, self.rate, self.channels, 0) {
            eprintln!(
                "[recorder] RECORDING STOPPED — cannot write header of {:?}: {}",
                next_path, e
            );
            inner.dead = true;
            return false;
        }
        let done = std::mem::replace(&mut inner.file, next);
        close_part(done, inner.file_data_bytes);
        eprintln!(
            "[recorder] rolled over at {} bytes -> {:?}",
            inner.file_data_bytes, next_path
        );
        inner.file_data_bytes = 0;
        inner.part += 1;
        inner.parts.push(next_path.to_string_lossy().to_string());
        true
    }

    /// Pad out to the wall clock, patch the header, close the file.
    /// Safe to call twice; the second call returns `None`.
    pub fn finish(&self) -> Option<RecordingSummary> {
        let mut guard = self.inner.lock().ok()?;
        {
            let inner = guard.as_mut()?;
            self.pad_locked(inner);
        }
        let mut inner = guard.take()?;
        let tap = inner.tap.take();
        close_part(inner.file, inner.file_data_bytes);
        let summary = RecordingSummary {
            path: self.path.to_string_lossy().to_string(),
            parts: inner.parts,
            seconds: inner.frames as f64 / self.rate as f64,
            bytes: inner.data_bytes,
            padded_seconds: inner.padded_frames as f64 / self.rate as f64,
            pad_events: inner.pad_events,
        };
        // The compressed copy is *not* waited for here: the caller hands this
        // summary over first, then calls `finish_compressed()`.
        if let Ok(mut slot) = self.closing_copy.lock() {
            *slot = tap.map(|t| (t, summary.parts.clone()));
        }
        Some(summary)
    }

    /// Wait (bounded, see `compressed.rs`) for
    /// the compressed copy to write its last page. Call after `finish()` and
    /// after its summary has been handed over. Dropping the Recorder does the
    /// same, so forgetting this cannot leave the file open.
    ///
    /// Then the WAV parts are deleted if the mp3 on disk
    /// proves whole (`CompressedTap::replace_wav`). Only this normal-stop
    /// path gets there: a crash, a kill or a dropped Recorder keeps the WAV.
    pub fn finish_compressed(&self) {
        let closing = self.closing_copy.lock().ok().and_then(|mut s| s.take());
        if let Some((mut tap, parts)) = closing {
            let encoded = tap.finish();
            tap.replace_wav(encoded, &parts);
        }
    }
}

/// Flush a finished part and patch its RIFF/data size fields.
fn close_part(file: BufWriter<File>, data_bytes: u64) {
    let mut file = match file.into_inner() {
        Ok(f) => f,
        Err(_) => return,
    };
    let _ = file.seek(SeekFrom::Start(4));
    let _ = file.write_all(&((36 + data_bytes) as u32).to_le_bytes());
    let _ = file.seek(SeekFrom::Start(40));
    let _ = file.write_all(&(data_bytes as u32).to_le_bytes());
    let _ = file.flush();
}

/// 44-byte canonical PCM WAV header.
fn write_header<W: Write>(w: &mut W, rate: u32, channels: u16, data_bytes: u32) -> std::io::Result<()> {
    let block_align = channels * 2;
    let byte_rate = rate * block_align as u32;
    w.write_all(b"RIFF")?;
    w.write_all(&(36 + data_bytes).to_le_bytes())?;
    w.write_all(b"WAVE")?;
    w.write_all(b"fmt ")?;
    w.write_all(&16u32.to_le_bytes())?;
    w.write_all(&1u16.to_le_bytes())?; // WAVE_FORMAT_PCM
    w.write_all(&channels.to_le_bytes())?;
    w.write_all(&rate.to_le_bytes())?;
    w.write_all(&byte_rate.to_le_bytes())?;
    w.write_all(&block_align.to_le_bytes())?;
    w.write_all(&16u16.to_le_bytes())?; // bits per sample
    w.write_all(b"data")?;
    w.write_all(&data_bytes.to_le_bytes())?;
    Ok(())
}

/// Put the real length back into a recording whose writer was killed before
/// `finish()` could patch the header.
///
/// Returns `Ok(None)` when the header already matches the file, `Ok(Some(..))`
/// when it was repaired, and `Err` when the file is not one of ours — a foreign
/// WAV layout is left strictly alone rather than guessed at.
pub fn repair_wav(path: &Path) -> Result<Option<RepairReport>, String> {
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|e| format!("open {:?}: {}", path, e))?;
    let file_len = file
        .metadata()
        .map_err(|e| format!("stat {:?}: {}", path, e))?
        .len();
    if file_len < HEADER_BYTES {
        return Err(format!("shorter than a WAV header ({} bytes)", file_len));
    }
    let mut head = [0u8; HEADER_BYTES as usize];
    file.read_exact(&mut head)
        .map_err(|e| format!("read header: {}", e))?;
    // Only the canonical 44-byte PCM layout this recorder writes is understood.
    if &head[0..4] != b"RIFF" || &head[8..12] != b"WAVE" || &head[12..16] != b"fmt " {
        return Err("not a RIFF/WAVE/fmt file".to_string());
    }
    if u32::from_le_bytes(head[16..20].try_into().unwrap()) != 16 || &head[36..40] != b"data" {
        return Err("not a canonical 44-byte PCM WAV (data chunk is elsewhere)".to_string());
    }
    let block_align = u16::from_le_bytes(head[32..34].try_into().unwrap()) as u64;
    if block_align == 0 {
        return Err("header says block align 0".to_string());
    }
    // The tail of a torn final write may not be a whole frame; leave those bytes
    // out of the size rather than describing a fractional frame.
    let actual = (file_len - HEADER_BYTES) / block_align * block_align;
    let stored_data = u32::from_le_bytes(head[40..44].try_into().unwrap()) as u64;
    let stored_riff = u32::from_le_bytes(head[4..8].try_into().unwrap()) as u64;
    if stored_data == actual && stored_riff == actual + 36 {
        return Ok(None);
    }
    file.seek(SeekFrom::Start(4))
        .and_then(|_| file.write_all(&((36 + actual) as u32).to_le_bytes()))
        .and_then(|_| file.seek(SeekFrom::Start(40)))
        .and_then(|_| file.write_all(&(actual as u32).to_le_bytes()))
        .and_then(|_| file.flush())
        .map_err(|e| format!("patch header: {}", e))?;
    Ok(Some(RepairReport {
        path: path.to_string_lossy().to_string(),
        header_data_bytes: stored_data,
        actual_data_bytes: actual,
    }))
}

/// Repair every `.wav` in `dir` whose header outlived its writer. Meant to run
/// when a capture starts, so last session's killed recording becomes usable
/// again. Files written in the last few seconds are skipped — those belong to a
/// capture thread that is still running and will patch its own header.
pub fn repair_dir(dir: &Path) -> Vec<RepairReport> {
    let mut fixed = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return fixed, // no directory yet = nothing to repair
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_wav = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase() == "wav")
            .unwrap_or(false);
        if !is_wav {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            if let Ok(modified) = meta.modified() {
                let too_fresh = SystemTime::now()
                    .duration_since(modified)
                    .map(|age| age < REPAIR_MIN_AGE)
                    .unwrap_or(true);
                if too_fresh {
                    continue;
                }
            }
        }
        match repair_wav(&path) {
            Ok(Some(report)) => {
                eprintln!(
                    "[recorder] repaired header: {} (said {} bytes of audio, holds {})",
                    report.path, report.header_data_bytes, report.actual_data_bytes
                );
                fixed.push(report);
            }
            Ok(None) => {}
            Err(e) => eprintln!("[recorder] not repairing {:?}: {}", path, e),
        }
    }
    fixed
}
