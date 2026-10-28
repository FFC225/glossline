//! Bluetooth "call mode" (HFP) guard.
//!
//! The moment any program starts USING a Bluetooth headset's microphone, the
//! whole link drops from A2DP to HFP: telephone-grade mono, in both directions.
//! Nothing on screen says so — Windows shows nothing, the app shows nothing,
//! the sound simply gets muffled and the archive is quietly ruined. Measured:
//! an AirPods Hands-Free endpoint can come up as 8000 Hz mono
//! (16 kHz on other machines — the host Bluetooth chipset decides).
//!
//! Deliberately pure: no device is opened in this file, so the rule can be
//! tested without touching an audio device or making any sound.

use std::sync::Arc;

/// Somewhere a human will actually see the warning (a Tauri event, in the app).
/// A plain callback, so the audio modules stay UI-agnostic and testable.
pub type Warner = Arc<dyn Fn(&str) + Send + Sync>;

/// Telephone-grade mono is the fingerprint of a headset in call mode.
/// A 16 kHz mono USB microphone would also trip this — a false alarm that
/// costs one dismissed toast, against a silent failure that costs the meeting.
pub fn is_call_mode(sample_rate: u32, channels: u16) -> bool {
    channels == 1 && (sample_rate == 8000 || sample_rate == 16000)
}

/// The text of the warning. Says what was seen, what it means, and what to do.
pub fn banner(source: &str, device: &str, sample_rate: u32, channels: u16) -> String {
    let device = device.trim();
    let device = if device.is_empty() { "unnamed device" } else { device };
    format!(
        "AUDIO QUALITY WARNING - {} is {} Hz, {} channel ({}). That is telephone quality: a Bluetooth headset has almost certainly switched to call mode (HFP) because some program is using its microphone. Everything recorded and transcribed from now on will be muffled. Fix: point Windows AND the meeting app at a non-Bluetooth microphone, then start again.",
        source, sample_rate, channels, device
    )
}

/// Check one device format at the start of a capture and, when it looks like
/// call mode, say so loudly: always on stderr, and through `warn` (the UI) when
/// one is wired up. Returns the message so callers can test it.
pub fn check(
    warn: &Option<Warner>,
    source: &str,
    device: &str,
    sample_rate: u32,
    channels: u16,
) -> Option<String> {
    if !is_call_mode(sample_rate, channels) {
        return None;
    }
    let msg = banner(source, device, sample_rate, channels);
    eprintln!("[audio] {}", msg);
    if let Some(w) = warn {
        w(&msg);
    }
    Some(msg)
}
