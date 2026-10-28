// Bluetooth call-mode (HFP) guard.
pub mod degraded;
// compressed copy (them.mp3 / me.mp3) written beside the WAV.
pub mod compressed;
pub mod microphone;
// raw-tap WAV recorder.
pub mod recorder;
pub mod resampler;

#[cfg(target_os = "macos")]
pub mod system_audio;

#[cfg(target_os = "windows")]
pub mod wasapi;

// Re-export SystemAudioCapture from the correct platform module
#[cfg(target_os = "macos")]
pub use system_audio::SystemAudioCapture;

#[cfg(target_os = "windows")]
pub use wasapi::SystemAudioCapture;

/// Target audio format for Soniox: PCM s16le, 16kHz, mono
pub const TARGET_SAMPLE_RATE: u32 = 16000;
pub const TARGET_CHANNELS: u16 = 1;
