//! "Which speaker, which microphone" for the settings page.
//!
//! Why this exists: the audio-source picker only ever said *category*
//! ("computer output" / "microphone"), never *which device*. That is the one
//! question that actually decides whether a meeting recording is usable,
//! because of Bluetooth: the instant any program starts using a Bluetooth
//! headset's microphone, the whole link drops to telephone quality and nothing
//! on screen says so. Showing the endpoint names and their sample rates turns
//! that invisible failure into something you can see before the meeting starts.
//!
//! Uses cpal (already a dependency for the microphone path) rather than raw
//! WASAPI: cpal's default output device on Windows is the same eRender/eConsole
//! endpoint the loopback capture opens, so the numbers here describe the very
//! stream that would be recorded.

use crate::audio::degraded::is_call_mode;
use cpal::traits::{DeviceTrait, HostTrait};
use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct EndpointInfo {
    /// Device name as Windows reports it, e.g. "Speakers (Realtek...)".
    pub name: String,
    pub sample_rate: u32,
    pub channels: u16,
    /// True when the format is telephone-grade mono -- same rule the capture
    /// path uses to raise its warning, so the settings page and the recorder
    /// can never disagree about what counts as degraded.
    pub call_mode: bool,
    /// Set when the device exists but its format could not be read.
    pub note: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct AudioEndpoints {
    /// The endpoint "computer output" captures from (loopback).
    pub output: Option<EndpointInfo>,
    /// The endpoint "microphone" captures from.
    pub input: Option<EndpointInfo>,
    /// Every input device Windows offers, so a wrong default is obvious.
    pub input_choices: Vec<String>,
    /// Non-fatal problem worth telling the user about.
    pub error: Option<String>,
}

fn describe(name: String, cfg: Result<cpal::SupportedStreamConfig, String>) -> EndpointInfo {
    match cfg {
        Ok(c) => {
            let rate = c.sample_rate().0;
            let ch = c.channels();
            EndpointInfo {
                name,
                sample_rate: rate,
                channels: ch,
                call_mode: is_call_mode(rate, ch),
                note: None,
            }
        }
        Err(e) => EndpointInfo {
            name,
            sample_rate: 0,
            channels: 0,
            call_mode: false,
            note: Some(e),
        },
    }
}

/// Report the default output and input endpoints, plus every input choice.
///
/// Never returns Err: a settings page that cannot enumerate devices should
/// still open, and should say what it could not find out.
/// Async on purpose: a sync Tauri command runs on the main thread, which on
/// Windows is the STA thread that owns the WebView. Enumerating audio endpoints
/// there means COM apartment roulette plus a frozen UI for however long the
/// driver takes. spawn_blocking puts it on a worker with clean COM state.
#[tauri::command]
pub async fn list_audio_endpoints() -> AudioEndpoints {
    match tauri::async_runtime::spawn_blocking(collect).await {
        Ok(v) => v,
        Err(e) => AudioEndpoints {
            output: None,
            input: None,
            input_choices: Vec::new(),
            error: Some(format!("device enumeration thread failed: {}", e)),
        },
    }
}

fn collect() -> AudioEndpoints {
    let host = cpal::default_host();

    let output = host.default_output_device().map(|d| {
        let name = d.name().unwrap_or_else(|_| "(unnamed output)".to_string());
        describe(name, d.default_output_config().map_err(|e| e.to_string()))
    });

    let input = host.default_input_device().map(|d| {
        let name = d.name().unwrap_or_else(|_| "(unnamed input)".to_string());
        describe(name, d.default_input_config().map_err(|e| e.to_string()))
    });

    let input_choices: Vec<String> = host
        .input_devices()
        .map(|devs| devs.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default();

    let error = match (&output, &input) {
        (None, None) => Some("Windows reports no default output and no default input device.".to_string()),
        (None, _) => Some("No default output device -- capturing computer audio will fail.".to_string()),
        (_, None) => Some("No default input device -- capturing the microphone will fail.".to_string()),
        _ => None,
    };

    eprintln!(
        "[audio] endpoints: output={:?}, input={:?}, input_choices={}",
        output.as_ref().map(|e| (e.name.clone(), e.sample_rate, e.channels)),
        input.as_ref().map(|e| (e.name.clone(), e.sample_rate, e.channels)),
        input_choices.len()
    );

    AudioEndpoints { output, input, input_choices, error }
}
