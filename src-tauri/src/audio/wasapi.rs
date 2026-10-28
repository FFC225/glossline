use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use super::degraded::{self, Warner};
use super::recorder::{Recorder, RecordingSummary};
use super::TARGET_SAMPLE_RATE;
use std::path::PathBuf;

/// System audio capture using WASAPI loopback on Windows.
/// Captures all system audio output and converts to PCM s16le 16kHz mono.
///
/// Note: uses the "legacy" WASAPI loopback path (same as v0.5.1). This captures
/// ALL system audio including our own TTS output. Earlier attempts to use the
/// Application Loopback API (ALAC) for self-exclusion were reverted in v0.5.3
/// because the implementation caused runtime crashes on Windows. Self-exclusion
/// will be revisited once it can be properly tested on a real Windows machine.
pub struct SystemAudioCapture {
    is_capturing: Arc<AtomicBool>,
    /// Filled by the capture thread when a recording it
    /// started finishes, so `stop()` can report where the file went.
    last_recording: Arc<std::sync::Mutex<Option<RecordingSummary>>>,
}

impl SystemAudioCapture {
    pub fn new() -> Self {
        Self {
            is_capturing: Arc::new(AtomicBool::new(false)),
            last_recording: Arc::new(std::sync::Mutex::new(None)),
        }
    }

    /// Start capturing system audio via WASAPI loopback.
    /// Returns a receiver that yields PCM s16le 16kHz mono audio chunks.
    /// `record_to`: when set, the raw device audio is also written there as a
    /// WAV file, tapped before the 16 kHz/mono conversion. The file is created
    /// inside the capture thread because the device format is only known there.
    pub fn start(
        &self,
        record_to: Option<PathBuf>,
        warn: Option<Warner>,
    ) -> Result<mpsc::Receiver<Vec<u8>>, String> {
        if self.is_capturing.load(Ordering::SeqCst) {
            return Err("Already capturing".to_string());
        }

        let (sender, receiver) = mpsc::channel::<Vec<u8>>();
        let is_capturing = self.is_capturing.clone();
        is_capturing.store(true, Ordering::SeqCst);

        let last_recording = self.last_recording.clone();
        if let Ok(mut slot) = last_recording.lock() {
            *slot = None;
        }

        std::thread::spawn(move || {
            run_legacy_loopback(sender, is_capturing, record_to, last_recording, warn);
        });

        Ok(receiver)
    }

    /// The summary of the most recently finished recording, if any.
    pub fn last_recording(&self) -> Option<RecordingSummary> {
        self.last_recording.lock().ok().and_then(|g| g.clone())
    }

    /// Stop capturing
    pub fn stop(&self) {
        self.is_capturing.store(false, Ordering::SeqCst);
    }

    pub fn is_capturing(&self) -> bool {
        self.is_capturing.load(Ordering::SeqCst)
    }
}

impl Default for SystemAudioCapture {
    fn default() -> Self {
        Self::new()
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Windows API imports
// ─────────────────────────────────────────────────────────────────────────────

use windows::Win32::Media::Audio::{
    eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
};

// ─────────────────────────────────────────────────────────────────────────────
// Legacy WASAPI loopback path (captures all system audio)
// ─────────────────────────────────────────────────────────────────────────────

fn run_legacy_loopback(
    sender: mpsc::Sender<Vec<u8>>,
    is_capturing: Arc<AtomicBool>,
    record_to: Option<PathBuf>,
    last_recording: Arc<std::sync::Mutex<Option<RecordingSummary>>>,
    warn: Option<Warner>,
) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        let enumerator: IMMDeviceEnumerator =
            match CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) {
                Ok(e) => e,
                Err(e) => {
                    eprintln!("[wasapi] Failed to create device enumerator: {}", e);
                    CoUninitialize();
                    return;
                }
            };

        let device = match enumerator.GetDefaultAudioEndpoint(eRender, eConsole) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("[wasapi] Failed to get default audio endpoint: {}", e);
                CoUninitialize();
                return;
            }
        };

        let audio_client: IAudioClient = match device.Activate(CLSCTX_ALL, None) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[wasapi] Failed to activate audio client: {}", e);
                CoUninitialize();
                return;
            }
        };

        let mix_format_ptr = match audio_client.GetMixFormat() {
            Ok(f) => f,
            Err(e) => {
                eprintln!("[wasapi] Failed to get mix format: {}", e);
                CoUninitialize();
                return;
            }
        };
        let mix_format = &*mix_format_ptr;

        let source_rate = mix_format.nSamplesPerSec;
        let source_channels = mix_format.nChannels as u32;
        let bits_per_sample = mix_format.wBitsPerSample;

        // Bluetooth check: if the default output endpoint is
        // telephone-grade mono, a Bluetooth headset has flipped to call mode
        // and everything from here on is muffled. Say so instead of recording
        // a ruined meeting in silence.
        degraded::check(
            &warn,
            "system audio (speaker output)",
            "",
            source_rate,
            source_channels as u16,
        );

        if let Err(e) = audio_client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK,
            10_000_000, // 1 second buffer in 100ns units
            0,
            mix_format_ptr,
            None,
        ) {
            eprintln!(
                "[wasapi] Failed to initialize audio client in loopback mode: {}",
                e
            );
            CoUninitialize();
            return;
        }

        eprintln!("[wasapi] Using WASAPI loopback (legacy path)");

        let capture_client: IAudioCaptureClient = match audio_client.GetService() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[wasapi] Failed to get capture client: {}", e);
                CoUninitialize();
                return;
            }
        };

        if let Err(e) = audio_client.Start() {
            eprintln!("[wasapi] Failed to start audio client: {}", e);
            CoUninitialize();
            return;
        }

        // Defensive: skip capture entirely if channel count is zero.
        if source_channels == 0 {
            eprintln!("[wasapi] Unexpected mix format with zero channels — aborting");
            let _ = audio_client.Stop();
            CoUninitialize();
            return;
        }

        // Recording tap. Created here because
        // the device format is only known after GetMixFormat above. The file
        // keeps the device's own rate/channels; only the Soniox path is
        // downmixed to 16 kHz mono.
        let recorder = record_to.and_then(|path| {
            match Recorder::create(path, source_rate, source_channels as u16) {
                Ok(r) => {
                    eprintln!(
                        "[wasapi] recording raw loopback: {} Hz, {} ch, 16-bit",
                        source_rate, source_channels
                    );
                    // + them.mp3 beside it.
                    Some(r.with_compressed_copy(warn.clone()))
                }
                Err(e) => {
                    eprintln!("[wasapi] RECORDING DISABLED — could not create file: {}", e);
                    None
                }
            }
        });
        let mut silent_packets = 0u64;
        let mut silent_frames = 0u64;

        while is_capturing.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(10));

            // Advance the file even when the render endpoint hands us nothing
            // at all, so an idle stretch stays on the time line.
            if let Some(rec) = &recorder {
                rec.pad_to_wall_clock();
            }

            let packet_size = match capture_client.GetNextPacketSize() {
                Ok(size) => size,
                Err(_) => continue,
            };

            if packet_size == 0 {
                continue;
            }

            let mut buffer_ptr = std::ptr::null_mut();
            let mut num_frames = 0u32;
            let mut flags = 0u32;

            if capture_client
                .GetBuffer(&mut buffer_ptr, &mut num_frames, &mut flags, None, None)
                .is_err()
            {
                continue;
            }

            if num_frames > 0 && !buffer_ptr.is_null() {
                let is_silent = (flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)) != 0;

                // Archive tap. A SILENT packet's buffer
                // contents are undefined per the WASAPI contract, so it is
                // written as real zero frames rather than skipped — dropping it
                // is what shortens the time line.
                if let Some(rec) = &recorder {
                    if is_silent {
                        silent_packets += 1;
                        silent_frames += num_frames as u64;
                        rec.write_silence(num_frames as u64);
                    } else if bits_per_sample == 32 {
                        rec.write_f32(std::slice::from_raw_parts(
                            buffer_ptr as *const f32,
                            num_frames as usize * source_channels as usize,
                        ));
                    } else if bits_per_sample == 16 {
                        rec.write_s16(std::slice::from_raw_parts(
                            buffer_ptr,
                            num_frames as usize * source_channels as usize * 2,
                        ));
                    }
                }

                if !is_silent {
                    let pcm_data = convert_to_pcm_s16_16k(
                        buffer_ptr,
                        num_frames,
                        source_rate,
                        source_channels,
                        bits_per_sample,
                    );

                    if !pcm_data.is_empty() {
                        if sender.send(pcm_data).is_err() {
                            break; // Receiver dropped
                        }
                    }
                }
            }

            let _ = capture_client.ReleaseBuffer(num_frames);
        }

        // Close the archive file before tearing down COM.
        if let Some(rec) = &recorder {
            if let Some(summary) = rec.finish() {
                eprintln!(
                    "[wasapi] recording done: {} ({:.1}s, {} bytes, padded {:.1}s in {} gaps,                      {} silent packets / {:.1}s written as zeros)",
                    summary.path,
                    summary.seconds,
                    summary.bytes,
                    summary.padded_seconds,
                    summary.pad_events,
                    silent_packets,
                    silent_frames as f64 / source_rate as f64
                );
                if let Ok(mut slot) = last_recording.lock() {
                    *slot = Some(summary);
                }
            }
            // Only after the WAV summary is
            // in the slot `stop_capture` reads 300 ms later.
            rec.finish_compressed();
        }

        // Cleanup: stop, drop COM objects, then CoUninitialize.
        let _ = audio_client.Stop();

        // Explicitly drop COM interface pointers BEFORE CoUninitialize.
        // Otherwise Rust's drop order would call Release() after COM is torn down.
        drop(capture_client);
        drop(audio_client);
        drop(device);
        drop(enumerator);

        CoUninitialize();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PCM conversion helper
// ─────────────────────────────────────────────────────────────────────────────

/// Convert raw WASAPI buffer to PCM s16le 16kHz mono
unsafe fn convert_to_pcm_s16_16k(
    buffer_ptr: *mut u8,
    num_frames: u32,
    source_rate: u32,
    source_channels: u32,
    bits_per_sample: u16,
) -> Vec<u8> {
    let frame_count = num_frames as usize;

    // WASAPI shared-mode mix format is typically 32-bit IEEE float.
    // We only handle that case; anything else returns empty (silent) data.
    if bits_per_sample != 32 || source_channels == 0 {
        return Vec::new();
    }

    let ptr = buffer_ptr as *const f32;
    let total_samples = frame_count * source_channels as usize;
    let f32_samples = std::slice::from_raw_parts(ptr, total_samples);

    // Take first channel only (mono)
    let mono: Vec<f32> = f32_samples
        .chunks(source_channels as usize)
        .map(|frame| frame[0])
        .collect();

    if mono.is_empty() || source_rate == 0 {
        return Vec::new();
    }

    // Downsample to 16kHz
    let ratio = source_rate as f64 / TARGET_SAMPLE_RATE as f64;
    let output_len = (mono.len() as f64 / ratio) as usize;

    let mut pcm_bytes: Vec<u8> = Vec::with_capacity(output_len * 2);

    for i in 0..output_len {
        let src_idx = (i as f64 * ratio) as usize;
        if src_idx >= mono.len() {
            break;
        }
        let sample = mono[src_idx].clamp(-1.0, 1.0);
        let s16 = (sample * 32767.0) as i16;
        pcm_bytes.extend_from_slice(&s16.to_le_bytes());
    }

    pcm_bytes
}
