use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::degraded::{self, Warner};
use super::recorder::{Recorder, RecordingSummary};
use super::TARGET_SAMPLE_RATE;
use std::path::PathBuf;

/// Microphone capture using cpal.
/// Captures from the default input device and converts to PCM s16le 16kHz mono.
pub struct MicCapture {
    is_capturing: Arc<AtomicBool>,
    /// The thread that owns the cpal stream.
    /// cpal::Stream is !Send, so it is built, kept alive, rebuilt after the
    /// device drops out, and dropped — all on this one thread. `stop()` clears
    /// `is_capturing` and joins it, so the stream is gone before the WAV closes.
    worker: Option<std::thread::JoinHandle<()>>,
    /// Archive tap. Held here so `stop()`
    /// can pad out to the wall clock and patch the WAV header.
    recorder: Option<Arc<Recorder>>,
    last_recording: Option<RecordingSummary>,
    /// The archive file this start created, remembered
    /// so that a start which fails *after* creating it can delete it again.
    ///
    /// Kept here rather than asked of `Recorder` because `recorder.rs` is shared
    /// verbatim with the standalone recorder — a getter added for us would have to be
    /// copied over there too, and the two copies drift in silence.
    recording_path: Option<PathBuf>,
}

// SAFETY: MicCapture is only accessed through Mutex in AudioState,
// so concurrent access is properly synchronized. It holds no
// cpal::Stream at all (the worker thread owns it), so this impl is kept only
// to leave the struct's Send-ness exactly as before.
unsafe impl Send for MicCapture {}

impl MicCapture {
    pub fn new() -> Self {
        Self {
            is_capturing: Arc::new(AtomicBool::new(false)),
            worker: None,
            recorder: None,
            last_recording: None,
            recording_path: None,
        }
    }

    /// Start capturing from the microphone.
    /// Returns a receiver that yields PCM s16le 16kHz mono audio chunks.
    /// `record_to`: when set, the microphone's own audio is also written there
    /// as a WAV file, tapped before the 16 kHz mono conversion.
    /// **The only place a failed start returns from.**
    ///
    /// Three of `start_inner`'s exits are *after* `Recorder::create` has already
    /// written a WAV header to disk (unsupported sample format, the microphone
    /// being held exclusively by another program, `play()` refusing). Leaving
    /// that behind is worse than failing: `stop()` would pad it out to the wall
    /// clock, producing a file the length of the whole meeting,
    /// with a valid header and a complete summary, containing nothing but
    /// silence — indistinguishable from a good recording, which is the exact
    /// thing this project keeps having to kill.
    ///
    /// Written as wrapper + inner rather than a cleanup call at each exit on
    /// purpose: a test can only prove that the exits which exist today clean up
    /// after themselves, whereas this shape means a *new* exit added later
    /// cannot forget.
    pub fn start(
        &mut self,
        record_to: Option<PathBuf>,
        warn: Option<Warner>,
    ) -> Result<mpsc::Receiver<Vec<u8>>, String> {
        match self.start_inner(record_to, warn) {
            Ok(rx) => Ok(rx),
            Err(e) => {
                self.abort_failed_start();
                Err(e)
            }
        }
    }

    /// Put this capture back the way it was before a failed `start`.
    ///
    /// `last_recording` is already cleared at the top of `start_inner` (same
    /// rule as `wasapi.rs`); it is cleared again here so that "a failed start
    /// leaves no summary behind" is a property of *this* function and can be
    /// asserted without a microphone.
    fn abort_failed_start(&mut self) {
        self.is_capturing.store(false, Ordering::SeqCst);
        self.last_recording = None;
        if let Some(h) = self.worker.take() {
            let _ = h.join();
        }
        // Drop the recorder *before* deleting, so nothing holds the handle.
        // `finish()` is deliberately not called: it would pad and patch the
        // header, i.e. manufacture the very file we are here to remove.
        self.recorder = None;
        // Dropping it also closed me.mp3
        // (CompressedTap's Drop waits for its file), so that goes too.
        let wav = self.recording_path.take();
        let mp3 = wav.as_deref().map(super::compressed::compressed_path);
        let mp3_working = mp3.as_deref().map(super::compressed::incomplete_path);
        for path in wav.into_iter().chain(mp3).chain(mp3_working) {
            match std::fs::remove_file(&path) {
                Ok(_) => eprintln!("[Mic] start failed — removed the empty {:?}", path),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                // Never fail quietly: if the empty file survives, say so. A leftover
                // silent me.wav that nobody mentions is how this fails.
                Err(e) => eprintln!(
                    "[Mic] start failed and the empty {:?} could not be removed: {}",
                    path, e
                ),
            }
        }
    }

    fn start_inner(
        &mut self,
        record_to: Option<PathBuf>,
        warn: Option<Warner>,
    ) -> Result<mpsc::Receiver<Vec<u8>>, String> {
        if self.is_capturing.load(Ordering::SeqCst) {
            return Err("Already capturing".to_string());
        }
        // Cleared here, not on success: last meeting's summary must never be
        // able to answer for this meeting (same rule as `wasapi.rs`).
        self.last_recording = None;
        self.recording_path = record_to.clone();

        let (sender, receiver) = mpsc::channel::<Vec<u8>>();
        self.is_capturing.store(true, Ordering::SeqCst);
        let is_capturing = self.is_capturing.clone();

        // The worker reports how the *first* open went before `start` returns,
        // so a microphone that cannot be opened still fails the start exactly
        // as before (and `start`'s wrapper still removes the empty file).
        let (ready_tx, ready_rx) = mpsc::channel::<Result<Option<Arc<Recorder>>, String>>();
        let worker = std::thread::Builder::new()
            .name("mic-capture".into())
            .spawn(move || mic_worker(record_to, warn, sender, is_capturing, ready_tx))
            .map_err(|e| format!("Failed to start mic thread: {}", e))?;
        self.worker = Some(worker);

        match ready_rx.recv() {
            Ok(Ok(recorder)) => {
                self.recorder = recorder;
                Ok(receiver)
            }
            Ok(Err(e)) => Err(e),
            Err(_) => Err("Mic thread ended before opening the microphone".to_string()),
        }
    }

    pub fn stop(&mut self) {
        self.is_capturing.store(false, Ordering::SeqCst);
        // Join the worker: it drops the stream on its way out, so after this
        // no callback can still be writing into the archive file.
        if let Some(h) = self.worker.take() {
            let _ = h.join();
        }
        // Close the archive file after the stream is gone,
        // so no callback can still be writing into it.
        if let Some(rec) = self.recorder.take() {
            if let Some(summary) = rec.finish() {
                eprintln!(
                    "[Mic] recording done: {} ({:.1}s, {} bytes, padded {:.1}s in {} gaps)",
                    summary.path,
                    summary.seconds,
                    summary.bytes,
                    summary.padded_seconds,
                    summary.pad_events
                );
                self.last_recording = Some(summary);
            }
            // me.mp3, after the WAV is done.
            rec.finish_compressed();
        }
    }

    pub fn last_recording(&self) -> Option<RecordingSummary> {
        self.last_recording.clone()
    }

    pub fn is_capturing(&self) -> bool {
        self.is_capturing.load(Ordering::SeqCst)
    }
}

impl Default for MicCapture {
    fn default() -> Self {
        Self::new()
    }
}

/// Sample layout the archive file was created with. After a reconnect the
/// archive may only keep receiving samples if the device came back in the
/// same layout — a WAV header describes one rate and one channel count.
#[derive(Clone, Copy, PartialEq, Debug)]
struct Layout {
    rate: u32,
    channels: u16,
    format: cpal::SampleFormat,
}

fn layout_of(config: &cpal::SupportedStreamConfig) -> Layout {
    Layout {
        rate: config.sample_rate().0,
        channels: config.channels(),
        format: config.sample_format(),
    }
}

/// How often to look for the microphone again after it dropped out.
const RECONNECT_EVERY: Duration = Duration::from_secs(1);
/// A microphone delivers callbacks continuously, even in a silent room (unlike
/// WASAPI loopback, which goes quiet when nothing plays). This long without one
/// means the stream is dead even if cpal never called the error callback.
const STALL_AFTER_MS: u64 = 3000;
/// A reopened stream that dies again within this is counted as the same outage.
const FLAP_WINDOW: Duration = Duration::from_secs(10);

/// What the stream callbacks share with the worker loop.
struct Health {
    /// Set by the error callback when the device is gone.
    broken: AtomicBool,
    /// Milliseconds since `epoch` at the last data callback.
    last_data_ms: AtomicU64,
    epoch: Instant,
}

impl Health {
    fn now_ms(&self) -> u64 {
        self.epoch.elapsed().as_millis() as u64
    }
    fn touch(&self) {
        self.last_data_ms.store(self.now_ms(), Ordering::SeqCst);
    }
}

/// Owns the cpal stream for one meeting.
///
/// Before this, a microphone that dropped out (cable pulled, the hardware
/// on/off switch, a USB hub reset) got one `eprintln!` from cpal and that was
/// the end of it: switching it back on brought nothing back, the subtitles
/// stopped, and the archive was padded with silence until stop — no error on
/// screen. This was observed with the hardware switch on a USB mic.
///
/// Now a dead stream (error callback, or no data for `STALL_AFTER_MS`) is
/// dropped and the default input is opened again every second until it works.
/// The archive keeps the same file: `pad_to_wall_clock` fills the gap, so the
/// time line stays true.
fn mic_worker(
    record_to: Option<PathBuf>,
    warn: Option<Warner>,
    sender: mpsc::Sender<Vec<u8>>,
    is_capturing: Arc<AtomicBool>,
    ready: mpsc::Sender<Result<Option<Arc<Recorder>>, String>>,
) {
    let health = Arc::new(Health {
        broken: AtomicBool::new(false),
        last_data_ms: AtomicU64::new(0),
        epoch: Instant::now(),
    });

    let (first, layout, recorder) =
        match open_first(record_to, &warn, &sender, &is_capturing, &health) {
            Ok(v) => v,
            Err(e) => {
                let _ = ready.send(Err(e));
                return;
            }
        };
    let _ = ready.send(Ok(recorder.clone()));

    let mut stream = Some(first);
    let mut down_since: Option<Instant> = None;
    let mut last_try: Option<Instant> = None;
    let mut attempts: u32 = 0;
    let mut reconnected_at: Option<Instant> = None;
    let mut flaps: u32 = 0;

    while is_capturing.load(Ordering::SeqCst) {
        if stream.is_some() {
            let stalled =
                health.now_ms().saturating_sub(health.last_data_ms.load(Ordering::SeqCst)) > STALL_AFTER_MS;
            if health.broken.load(Ordering::SeqCst) || stalled {
                stream = None;
                last_try = None;
                // A device that opens fine but never delivers (listed, yet
                // switched off) would loop open → 3 s stall → open. Treat a
                // stream that died within FLAP_WINDOW as the same outage:
                // keep the counters and stay quiet, or the log gets four
                // lines every four seconds for the rest of the meeting.
                if reconnected_at.map_or(false, |t| t.elapsed() < FLAP_WINDOW) {
                    flaps += 1;
                } else {
                    flaps = 0;
                    down_since = Some(Instant::now());
                    attempts = 0;
                }
                if flaps == 0 || flaps % 30 == 0 {
                    eprintln!(
                        "[Mic] stream lost ({}) — reopening the default microphone every {}s{}",
                        if stalled { "no data for 3s" } else { "device error" },
                        RECONNECT_EVERY.as_secs(),
                        if flaps > 0 { format!(" (dropped again right after reopening, {} times)", flaps) } else { String::new() }
                    );
                }
            }
        }

        if stream.is_none() && last_try.map_or(true, |t| t.elapsed() >= RECONNECT_EVERY) {
            last_try = Some(Instant::now());
            attempts += 1;
            match reopen(layout, &recorder, &warn, &sender, &is_capturing, &health, flaps == 0) {
                Ok((s, what)) => {
                    stream = Some(s);
                    reconnected_at = Some(Instant::now());
                    if flaps == 0 || flaps % 30 == 0 {
                        eprintln!(
                            "[Mic] reconnected after {:.1}s ({} attempts): {}",
                            down_since.map_or(0.0, |t| t.elapsed().as_secs_f64()),
                            attempts,
                            what
                        );
                    }
                }
                // First failure and then every 30 s: enough to see it is still
                // trying, without a line per second for a whole meeting.
                Err(e) if attempts == 1 || attempts % 30 == 0 => {
                    eprintln!("[Mic] reopen attempt {} failed: {}", attempts, e)
                }
                Err(_) => {}
            }
        }

        std::thread::sleep(Duration::from_millis(100));
    }
    drop(stream);
}

/// The first open of a meeting: device, archive file, stream.
fn open_first(
    record_to: Option<PathBuf>,
    warn: &Option<Warner>,
    sender: &mpsc::Sender<Vec<u8>>,
    is_capturing: &Arc<AtomicBool>,
    health: &Arc<Health>,
) -> Result<(cpal::Stream, Layout, Option<Arc<Recorder>>), String> {
    let (device, config) = open_default_input(true)?;
    let layout = layout_of(&config);

    // Microphone side of the Bluetooth check: an AirPods
    // Hands-Free endpoint measured 8000 Hz mono on one machine. Nothing on
    // screen ever says the link degraded, so this is the only warning.
    degraded::check(
        warn,
        "microphone",
        &device.name().unwrap_or_default(),
        layout.rate,
        layout.channels,
    );

    // Archive tap. Unlike WASAPI loopback there is no
    // SILENT flag here — a quiet room arrives as real low-level samples —
    // so the time line only needs the wall-clock guard for dropped
    // callbacks (device stall / format change).
    let recorder = record_to.and_then(|path| {
        match Recorder::create(path, layout.rate, layout.channels) {
            Ok(r) => {
                eprintln!(
                    "[Mic] recording raw input: {} Hz, {} ch, 16-bit",
                    layout.rate, layout.channels
                );
                // + me.mp3 beside it.
                Some(Arc::new(r.with_compressed_copy(warn.clone())))
            }
            Err(e) => {
                eprintln!("[Mic] RECORDING DISABLED — could not create file: {}", e);
                None
            }
        }
    });

    let stream = build_stream(&device, &config, sender, is_capturing, recorder.clone(), health)?;
    Ok((stream, layout, recorder))
}

/// Open the default input again after the stream died.
fn reopen(
    layout: Layout,
    recorder: &Option<Arc<Recorder>>,
    warn: &Option<Warner>,
    sender: &mpsc::Sender<Vec<u8>>,
    is_capturing: &Arc<AtomicBool>,
    health: &Arc<Health>,
    // false while the same outage keeps flapping: the screen was told once.
    announce: bool,
) -> Result<(cpal::Stream, String), String> {
    let (device, config) = open_default_input(false)?;
    let name = device.name().unwrap_or_default();
    let now = layout_of(&config);

    // Same layout: keep writing the same archive file. Different layout (the
    // default input changed to another device while it was down): subtitles
    // carry on, but these samples cannot go into a file whose header says
    // otherwise — the archive keeps being padded with silence, and the user
    // is told, because a silent stretch nobody mentions is how this fails.
    let same = now == layout;
    let rec = if same { recorder.clone() } else { None };
    let stream = build_stream(&device, &config, sender, is_capturing, rec, health)?;

    // Warnings only once the stream is really up: before that, a build that
    // fails every second would put "reconnected" on screen every second
    // while nothing is reconnected.
    if announce {
        degraded::check(warn, "microphone", &name, now.rate, now.channels);
    }
    if announce && !same && recorder.is_some() {
        let msg = format!(
            "麥克風接回來了，但換成另一種格式（{}：{} Hz、{} 聲道，原本 {} Hz、{} 聲道）。之後的話照樣有字幕，但不會進錄音檔。要錄進檔案請按停止再重新開始。",
            name, now.rate, now.channels, layout.rate, layout.channels
        );
        eprintln!("[Mic] {}", msg);
        if let Some(w) = warn {
            w(&msg);
        }
    }
    Ok((stream, format!("{:?} {} Hz {} ch {:?}", name, now.rate, now.channels, now.format)))
}

/// The default input device and the config to open it with.
fn open_default_input(
    verbose: bool,
) -> Result<(cpal::Device, cpal::SupportedStreamConfig), String> {
    let host = cpal::default_host();

    // List available input devices for debugging
    let input_devices: Vec<String> = host
        .input_devices()
        .map(|devs| devs.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default();
    if verbose {
        eprintln!("[Mic] Available input devices: {:?}", input_devices);
    }

    if input_devices.is_empty() {
        return Err(
            "No microphone found. Connect an external microphone or headset.".to_string(),
        );
    }

    let device = host
        .default_input_device()
        .ok_or("No default microphone found. Connect an external microphone or headset.")?;

    if verbose {
        eprintln!("[Mic] Device: {:?}", device.name().unwrap_or_default());
    }

    // Try default config first, fallback to supported configs
    let default_config = device
        .default_input_config()
        .or_else(|e| {
            if verbose {
                eprintln!(
                "[Mic] default_input_config failed: {}, trying supported configs",
                e
            );
            }
            // Fallback: find a supported config
            let mut configs = device
                .supported_input_configs()
                .map_err(|e2| format!("No supported input configs: {}", e2))?;
            // Prefer F32, then I16
            configs
                .find(|c| c.sample_format() == cpal::SampleFormat::F32)
                .or_else(|| {
                    device
                        .supported_input_configs()
                        .ok()
                        .and_then(|mut c| c.next())
                })
                .map(|c| {
                    // Pick sample rate: prefer 48kHz, else max
                    let rate =
                        if c.min_sample_rate().0 <= 48000 && c.max_sample_rate().0 >= 48000 {
                            cpal::SampleRate(48000)
                        } else {
                            c.max_sample_rate()
                        };
                    c.with_sample_rate(rate)
                })
                .ok_or_else(|| format!("No suitable input config found (original: {})", e))
        })
        .map_err(|e| format!("Failed to get default input config: {}", e))?;

    if verbose {
        eprintln!(
            "[Mic] Config: rate={}, channels={}, format={:?}",
            default_config.sample_rate().0,
            default_config.channels(),
            default_config.sample_format()
        );
    }

    Ok((device, default_config))
}

/// Build and start one cpal input stream.
fn build_stream(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
    sender: &mpsc::Sender<Vec<u8>>,
    is_capturing: &Arc<AtomicBool>,
    rec: Option<Arc<Recorder>>,
    health: &Arc<Health>,
) -> Result<cpal::Stream, String> {
    let source_sample_rate = config.sample_rate().0;
    let source_channels = config.channels() as usize;

    // Build the input config targeting our desired format
    let stream_config = cpal::StreamConfig {
        channels: config.channels(),
        sample_rate: config.sample_rate(),
        buffer_size: cpal::BufferSize::Default,
    };

    let target_rate = TARGET_SAMPLE_RATE;
    // Cleared before building, raised again if this very stream fails — a
    // flag cleared *after* building could erase an error the new stream
    // already reported. The stall clock restarts here for the same reason.
    health.broken.store(false, Ordering::SeqCst);
    health.touch();
    let err_health = health.clone();
    let err_fn = move |err: cpal::StreamError| {
        eprintln!("Microphone input error: {}", err);
        // Only "device gone" is fatal for certain; anything else is left to
        // the stall check, which catches a stream that actually stopped.
        if matches!(err, cpal::StreamError::DeviceNotAvailable) {
            err_health.broken.store(true, Ordering::SeqCst);
        }
    };

    let stream = match config.sample_format() {
        cpal::SampleFormat::F32 => {
            let is_capturing = is_capturing.clone();
            let sender = sender.clone();
            let health = health.clone();
            device.build_input_stream(
                &stream_config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    health.touch();
                    if !is_capturing.load(Ordering::SeqCst) {
                        return;
                    }
                    if let Some(r) = &rec {
                        r.pad_to_wall_clock();
                        r.write_f32(data);
                    }
                    let pcm = convert_f32_to_pcm_s16le(
                        data,
                        source_channels,
                        source_sample_rate,
                        target_rate,
                    );
                    if !pcm.is_empty() {
                        let _ = sender.send(pcm);
                    }
                },
                err_fn,
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            let is_capturing = is_capturing.clone();
            let sender = sender.clone();
            let health = health.clone();
            device.build_input_stream(
                &stream_config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    health.touch();
                    if !is_capturing.load(Ordering::SeqCst) {
                        return;
                    }
                    if let Some(r) = &rec {
                        r.pad_to_wall_clock();
                        let mut bytes = Vec::with_capacity(data.len() * 2);
                        for &s in data {
                            bytes.extend_from_slice(&s.to_le_bytes());
                        }
                        r.write_s16(&bytes);
                    }
                    let pcm = convert_i16_to_pcm_s16le(
                        data,
                        source_channels,
                        source_sample_rate,
                        target_rate,
                    );
                    if !pcm.is_empty() {
                        let _ = sender.send(pcm);
                    }
                },
                err_fn,
                None,
            )
        }
        format => {
            return Err(format!("Unsupported sample format: {:?}", format));
        }
    }
    .map_err(|e| format!("Failed to build input stream: {}", e))?;

    stream
        .play()
        .map_err(|e| format!("Failed to start mic stream: {}", e))?;

    Ok(stream)
}

/// Convert f32 audio to PCM s16le, with mono mixdown and resampling
fn convert_f32_to_pcm_s16le(
    data: &[f32],
    channels: usize,
    source_rate: u32,
    target_rate: u32,
) -> Vec<u8> {
    // Step 1: Mix to mono
    let mono: Vec<f32> = if channels > 1 {
        data.chunks(channels)
            .map(|frame| frame.iter().sum::<f32>() / channels as f32)
            .collect()
    } else {
        data.to_vec()
    };

    // Step 2: Resample if needed
    let resampled = if source_rate != target_rate {
        simple_resample(&mono, source_rate, target_rate)
    } else {
        mono
    };

    // Step 3: Convert to s16le bytes
    resampled
        .iter()
        .flat_map(|&s| {
            let clamped = s.clamp(-1.0, 1.0);
            let s16 = (clamped * 32767.0) as i16;
            s16.to_le_bytes()
        })
        .collect()
}

/// Convert i16 audio to PCM s16le, with mono mixdown and resampling
fn convert_i16_to_pcm_s16le(
    data: &[i16],
    channels: usize,
    source_rate: u32,
    target_rate: u32,
) -> Vec<u8> {
    // Step 1: Mix to mono and convert to f32
    let mono: Vec<f32> = if channels > 1 {
        data.chunks(channels)
            .map(|frame| {
                let sum: f32 = frame.iter().map(|&s| s as f32).sum();
                sum / (channels as f32 * 32768.0)
            })
            .collect()
    } else {
        data.iter().map(|&s| s as f32 / 32768.0).collect()
    };

    // Step 2: Resample if needed
    let resampled = if source_rate != target_rate {
        simple_resample(&mono, source_rate, target_rate)
    } else {
        mono
    };

    // Step 3: Convert to s16le bytes
    resampled
        .iter()
        .flat_map(|&s| {
            let clamped = s.clamp(-1.0, 1.0);
            let s16 = (clamped * 32767.0) as i16;
            s16.to_le_bytes()
        })
        .collect()
}

/// Simple linear interpolation resampler
/// Good enough for speech (not for music production)
fn simple_resample(samples: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if from_rate == to_rate || samples.is_empty() {
        return samples.to_vec();
    }

    let ratio = from_rate as f64 / to_rate as f64;
    let output_len = (samples.len() as f64 / ratio) as usize;
    let mut output = Vec::with_capacity(output_len);

    for i in 0..output_len {
        let src_pos = i as f64 * ratio;
        let src_idx = src_pos as usize;
        let frac = src_pos - src_idx as f64;

        if src_idx + 1 < samples.len() {
            // Linear interpolation between two adjacent samples
            let s = samples[src_idx] as f64 * (1.0 - frac) + samples[src_idx + 1] as f64 * frac;
            output.push(s as f32);
        } else if src_idx < samples.len() {
            output.push(samples[src_idx]);
        }
    }

    output
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `start()` 在建完檔之後才失敗時，磁碟上不可以留下那個空檔。
    ///
    /// ⚠ 這一則**不是**去跑 `start()`——那需要一台沒有麥克風（或麥克風被獨佔）
    /// 的機器，而測試跑在哪台機器上不是我們能選的，跑得過跑不過會隨機器變。
    /// 所以這裡直接驗清理本身；「每一個失敗出口都會叫到它」那一半不是靠這則
    /// 測試保證的，是靠 `start()` 寫成「wrapper + inner，只有一個回 Err 的地方」
    /// 這個形狀保證的（見 `start` 的註解）。
    #[test]
    fn a_failed_start_leaves_no_empty_wav_behind() {
        let dir = std::env::temp_dir().join(format!(
            "mt-mic-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("me.wav");

        let mut mic = MicCapture::new();
        // 把狀態擺成「群 B」那一刻的樣子：檔頭已經寫下去、is_capturing 已經是
        // true、而且上一場的摘要還在手上。
        // With a warner that remembers: an empty mp3 copy closed
        // here must not put a warning on screen.
        let warned = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let w = warned.clone();
        let warner: crate::audio::degraded::Warner = Arc::new(move |m: &str| w.lock().unwrap().push(m.to_string()));
        mic.recorder = Some(Arc::new(
            Recorder::create(path.clone(), 48000, 2).unwrap().with_compressed_copy(Some(warner)),
        ));
        let mp3 = dir.join("me.mp3");
        mic.recording_path = Some(path.clone());
        mic.is_capturing.store(true, Ordering::SeqCst);
        mic.last_recording = Some(RecordingSummary {
            path: "上一場的假摘要.wav".to_string(),
            parts: vec!["上一場的假摘要.wav".to_string()],
            seconds: 1234.0,
            bytes: 999,
            padded_seconds: 0.0,
            pad_events: 0,
        });
        assert!(path.exists(), "前提不成立：檔頭本來就該已經在磁碟上");

        mic.abort_failed_start();

        assert!(!mic.is_capturing(), "is_capturing 沒歸零");
        assert!(!path.exists(), "空的 me.wav 留在磁碟上了");
        assert!(!mp3.exists(), "空的 me.mp3 留在磁碟上了");
        assert!(!dir.join("me_incomplete.mp3").exists(), "空的 me_incomplete.mp3 留在磁碟上了");
        assert!(warned.lock().unwrap().is_empty(), "abort 時壓縮檔冒出警示：{:?}", warned.lock().unwrap());
        assert!(
            mic.last_recording().is_none(),
            "上一場的摘要還留著——下一張收工報告會拿它當這一場的成績"
        );

        std::fs::remove_dir_all(&dir).ok();
    }
}
