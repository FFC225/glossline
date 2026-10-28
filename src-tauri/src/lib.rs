mod applog;
mod audio;
mod commands;
mod portable;
mod settings;

use audio::microphone::MicCapture;
use audio::SystemAudioCapture;
use commands::audio::AudioState;
use settings::{Settings, SettingsState};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

// Set once the frontend has flushed the session (or the exit deadline elapsed),
// so the ExitRequested handler stops preventing exit and the app can quit.
static EXIT_ALLOWED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn get_platform_info() -> String {
    // `std::env::consts::ARCH` is the arch of THIS binary, not the CPU. On an
    // Apple Silicon Mac running the x64 build under Rosetta it reports
    // "x86_64", which wrongly blocked the Local MLX engine (MLX runs as a
    // separate native-ARM Python subprocess, so it works fine there).
    // Ask the hardware directly so detection is Rosetta-proof.
    let is_arm_hardware = is_apple_silicon_hardware();
    format!(
        r#"{{"os":"{}","arch":"{}","is_arm_hardware":{},"version":"0.3.0"}}"#,
        std::env::consts::OS,
        std::env::consts::ARCH,
        is_arm_hardware
    )
}

/// True only on Apple Silicon hardware (macOS), even when the current process
/// is x86_64 under Rosetta. Uses `sysctl hw.optional.arm64`, which reads the
/// real CPU, not the process translation state. Non-macOS → false.
#[cfg(target_os = "macos")]
fn is_apple_silicon_hardware() -> bool {
    std::process::Command::new("sysctl")
        .args(["-n", "hw.optional.arm64"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim() == "1")
        .unwrap_or(false)
}

#[cfg(not(target_os = "macos"))]
fn is_apple_silicon_hardware() -> bool {
    false
}

// Called by the frontend after it has flushed the session on exit. Force-exits
// the process; the flag keeps a subsequent ExitRequested from being prevented.
#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    EXIT_ALLOWED.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First, before anything prints: give this process's stdout/stderr a file
    // to land in. A double-clicked release build has no console at all, so
    // without this every line below -- starting with the settings dump, which
    // is how we tell "the settings loaded" from "the settings were ignored" --
    // goes nowhere and leaves no trace that it went nowhere.
    applog::init();

    // Load settings from disk (or defaults)
    let initial_settings = Settings::load();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 改名 glossline：舊 identifier 底下的記錄庫逐檔補搬過來。
            commands::session_store::migrate_legacy_sessions(app.handle());
            // updater/process plugins removed (unsigned binaries are never run).
            // Dev builds (compiled with the `devtools` feature): auto-open the WebView
            // inspector so JS/console errors are visible. Never compiled into release.
            #[cfg(feature = "devtools")]
            {
                use tauri::Manager;
                if let Some(win) = app.get_webview_window("main") {
                    win.open_devtools();
                }
            }
            Ok(())
        })
        .manage(SettingsState(Mutex::new(initial_settings)))
        .manage(AudioState {
            system_audio: Mutex::new(SystemAudioCapture::new()),
            microphone: Mutex::new(MicCapture::new()),
            active_receiver: Mutex::new(Vec::new()),
            current_session: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            commands::settings::get_settings,
            commands::frontend_log::log_frontend,
            commands::logs::open_log_dir,
            commands::logs::log_dir_path,
            commands::logs::settings_file_path,
            commands::logs::open_session_dir,
            commands::settings::save_settings,
            commands::audio::start_capture,
            commands::audio::stop_capture,
            commands::audio::pause_capture,
            commands::audio::resume_capture,
            commands::audio::check_permissions,
            commands::precheck::precheck,
            commands::audio_devices::list_audio_endpoints,
            commands::transcript::save_transcript,
            commands::transcript::open_transcript_dir,
            commands::transcript::list_transcripts,
            commands::transcript::read_transcript,
            commands::session_store::save_session,
            commands::session_store::save_transcript_beside_recording,
            commands::session_store::save_marks_beside_recording,
            commands::session_store::list_sessions,
            commands::session_store::read_session,
            commands::session_store::read_legacy_session,
            commands::session_store::delete_session,
            commands::session_store::update_session_title,
            commands::session_store::rename_session_dir,
            commands::session_store::export_session_srt,
            commands::session_store::export_session_txt,
            commands::session_store::export_session_file,
            commands::session_store::search_sessions,
            get_platform_info,
            exit_app,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Cmd+Q and Dock → Quit fire app-level ExitRequested (not the
            // window's onCloseRequested). Prevent the first exit, ask the
            // frontend to flush the session, and force-exit after a deadline so
            // a hung flush can never make the app unquittable.
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if !EXIT_ALLOWED.load(Ordering::SeqCst) {
                    use tauri::{Emitter, Manager};
                    api.prevent_exit();
                    if let Some(win) = app_handle.get_webview_window("main") {
                        let _ = win.emit("app-exit-requested", ());
                    }
                    let handle = app_handle.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(3));
                        EXIT_ALLOWED.store(true, Ordering::SeqCst);
                        handle.exit(0);
                    });
                }
            }
        });
}
