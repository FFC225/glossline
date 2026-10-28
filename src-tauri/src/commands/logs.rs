//! "Open that folder for me" -- the other half of having
//! files at all.
//!
//! A log nobody can find is a log nobody sends back. A tester who hits a
//! problem should not have to be told a path over the phone, let alone be
//! walked through `%LOCALAPPDATA%` in Explorer. The same goes for the
//! recordings of a meeting that just ended (`open_session_dir`).

use std::path::{Path, PathBuf};

/// Hand a folder to the platform's file manager.
///
/// Shared by both buttons so there is one place that knows the per-OS command
/// -- and, on Windows, one place that knows about the `\\?\` trap below.
fn reveal(dir: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let cmd = "open";
    #[cfg(target_os = "windows")]
    let cmd = "explorer";
    #[cfg(target_os = "linux")]
    let cmd = "xdg-open";

    std::process::Command::new(cmd)
        .arg(dir)
        .spawn()
        .map_err(|e| format!("開不了資料夾：{}", e))?;
    Ok(())
}

/// Strip the `\\?\` verbatim prefix that `canonicalize` adds on Windows.
///
/// 🔴 Explorer does **not** understand a verbatim path: handed
/// `\\?\C:\Example\raw\meeting-x` it silently opens the user's Documents
/// folder instead, exits 0, and reports nothing. That is exactly the failure
/// this button exists to avoid -- a window opens, so it looks like it worked,
/// but it is the wrong folder.
fn strip_verbatim(path: PathBuf) -> PathBuf {
    match path.to_str() {
        Some(s) if s.starts_with(r"\\?\") => PathBuf::from(&s[4..]),
        _ => path,
    }
}

/// Open the folder holding this app's own log files.
///
/// Creates it first: on a run where logging failed (a read-only profile, say)
/// the folder may not exist, and "the button does nothing" is a worse answer
/// than an empty folder that shows the person where it would have been.
#[tauri::command]
pub fn open_log_dir() -> Result<(), String> {
    let dir = crate::applog::log_dir().ok_or_else(|| "找不到記錄資料夾的位置".to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("建不出記錄資料夾：{}", e))?;
    reveal(&dir)
}

/// Open one meeting's recording folder -- the one named in the stop report.
///
/// ⚠ The path is checked before it is handed over, and a bad one comes back as
/// `Err` so the screen can say so. The failure this guards against is not a
/// crash: `explorer <missing path>` opens Documents (or nothing) and exits 0,
/// so without the check a renamed folder would look like a working button.
#[tauri::command]
pub fn open_session_dir(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("這場沒有錄音資料夾".to_string());
    }
    // canonicalize() fails when the folder is gone -- which is the whole point.
    let dir = std::fs::canonicalize(&path)
        .map_err(|e| format!("找不到這場的資料夾（{}）：{}", path, e))?;
    if !dir.is_dir() {
        return Err(format!("這個路徑不是資料夾：{}", path));
    }
    reveal(&strip_verbatim(dir))
}

/// Where the log folder is, for showing on screen next to the button. Returned
/// even when logging is not active, because "here is where it would be" is
/// still the address a tester needs to read out.
#[tauri::command]
pub fn log_dir_path() -> String {
    crate::applog::log_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "（找不到位置）".to_string())
}

/// 設定檔實際在哪，給設定頁顯示。
///
/// 設定與 log **優先寫在 exe 旁邊**，寫不進去才退回
/// 使用者自己的資料夾——兩條路都合法，所以位置必須看得見。log 那半早就有
/// 欄位（`log_dir_path`），設定這半沒有，獨立審查把這個不對稱抓了出來。
///
/// ⚠ 為什麼「有 log 就夠了」不成立：使用者要問的是「我填的金鑰存到哪去了」，
///   而他會去看的地方是設定頁、不是 log 檔。
#[tauri::command]
pub fn settings_file_path() -> String {
    crate::settings::settings_path_display()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Only the refusal paths are tested: a happy path would spawn a real
    // Explorer window on whoever runs `cargo test`. That half is
    // left to manual button presses.

    #[test]
    fn empty_path_is_refused() {
        assert!(open_session_dir("   ".to_string()).is_err());
    }

    #[test]
    fn missing_folder_is_refused_and_says_the_path() {
        let err = open_session_dir(r"Z:\nope-does-not-exist\meeting-x".to_string()).unwrap_err();
        assert!(err.contains("nope-does-not-exist"), "{}", err);
    }

    #[test]
    fn a_file_is_not_a_folder() {
        let file = std::env::temp_dir().join("mt-open-session-dir-test.txt");
        std::fs::write(&file, b"x").unwrap();
        let err = open_session_dir(file.display().to_string()).unwrap_err();
        let _ = std::fs::remove_file(&file);
        assert!(err.contains("不是資料夾"), "{}", err);
    }

    /// The happy path, driven by hand: `MT_OPEN_DIR=<folder> cargo test --lib
    /// commands::logs -- --ignored --nocapture`. It really does open a window,
    /// which is why it is `#[ignore]`d -- and the point of running it is to
    /// then ask Explorer which folder it landed on.
    #[test]
    #[ignore]
    fn opens_the_folder_named_in_the_env() {
        let dir = std::env::var("MT_OPEN_DIR").expect("set MT_OPEN_DIR");
        open_session_dir(dir).expect("should open");
    }

    #[test]
    fn verbatim_prefix_is_stripped() {
        // Handing Explorer the `\\?\` form opens the wrong folder without
        // failing, so this is load-bearing, not cosmetic.
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\C:\Example\raw\meeting-x")),
            PathBuf::from(r"C:\Example\raw\meeting-x")
        );
        assert_eq!(
            strip_verbatim(PathBuf::from(r"C:\Example\raw")),
            PathBuf::from(r"C:\Example\raw")
        );
    }
}
