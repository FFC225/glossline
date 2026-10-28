use crate::settings::{describe_context, Settings, SettingsState};
use tauri::State;

/// Get current settings
#[tauri::command]
pub fn get_settings(state: State<'_, SettingsState>) -> Result<Settings, String> {
    let settings = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
    // "The value is in the file but not on screen" is only
    // answerable if we know what actually crossed the IPC boundary.
    eprintln!(
        "[settings] get_settings -> target_language={}, audio_source={}, recording_dir={:?}, font_size={}, max_lines={}, always_on_top={}, theme={}, custom_context=[{}]",
        settings.target_language,
        settings.audio_source,
        settings.recording_dir,
        settings.font_size,
        settings.max_lines,
        settings.always_on_top,
        settings.theme,
        describe_context(&settings.custom_context)
    );

    Ok(settings.clone())
}

/// Save settings
#[tauri::command]
pub fn save_settings(
    new_settings: Settings,
    state: State<'_, SettingsState>,
) -> Result<(), String> {
    let mut settings = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;

    eprintln!(
        "[settings] save_settings <- target_language={}, audio_source={}, recording_dir={:?}, font_size={}, max_lines={}, always_on_top={}, theme={}, custom_context=[{}]",
        new_settings.target_language,
        new_settings.audio_source,
        new_settings.recording_dir,
        new_settings.font_size,
        new_settings.max_lines,
        new_settings.always_on_top,
        new_settings.theme,
        describe_context(&new_settings.custom_context)
    );

    // Save to disk
    new_settings.save()?;

    // Update in-memory state
    *settings = new_settings;

    Ok(())
}
