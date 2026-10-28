use crate::settings::SettingsState;
use tauri::{Runtime, State};

/// Frontend errors -> the app's own log file.
///
/// Why this exists: a JS exception dies inside the webview -- visible only if
/// someone had devtools open, which nobody does during a meeting. So the one
/// class of failure most likely to hit us in production was the one class we
/// had no record of.
///
/// Deliberately dumb: no filtering, no rate limiting, no structured payload.
/// It writes to stderr and returns nothing, so a logging failure can never take
/// the app down with it.
///
/// The one thing it is NOT dumb about is secrets. This log is written to be
/// mailed back to us by a tester, and this function records whatever JS hands
/// it -- including, one careless `console.error(config)` from now, the Soniox
/// key. So every value we know to be a secret is blanked out first.
#[tauri::command]
pub fn log_frontend<R: Runtime>(
    _app: tauri::AppHandle<R>,
    state: State<'_, SettingsState>,
    level: String,
    message: String,
) {
    // A stack trace is many lines, and one event per line is what makes the
    // log greppable. `lines()` splits on both LF and CRLF, so no escape
    // characters are needed here -- which is deliberate: this file has already
    // been mangled once by escapes getting eaten in transit.
    let flat = message.lines().collect::<Vec<_>>().join(" | ");

    // A poisoned lock must not cost us the log line: fall back to printing the
    // message unredacted only when there are no secrets to redact anyway --
    // i.e. never silently drop the line, and never print a key we could have
    // masked. If the lock is unavailable we cannot know the secrets, so the
    // safe move is to say so and keep the text out.
    let Ok(settings) = state.0.lock() else {
        eprintln!("[frontend/{}] <settings lock unavailable; message withheld>", level);
        return;
    };
    let secrets = [settings.soniox_api_key.as_str()];
    let safe = crate::applog::redact(&flat, &secrets);
    drop(settings);

    eprintln!("[frontend/{}] {}", level, safe);
}
