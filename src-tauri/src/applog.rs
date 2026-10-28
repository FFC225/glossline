//! The app writes its own log file.
//!
//! Why this exists: every `println!`/`eprintln!` in this crate (36 of them)
//! only ever landed anywhere because a launcher script piped the exe's stdout and
//! stderr into `logs\app-*.log`. Release builds are `windows_subsystem =
//! "windows"`, so a **double-clicked** exe has no console and no redirection --
//! those 36 lines are written into a null handle and vanish, with no error.
//! That is exactly the shape we cannot ship to someone else: the first thing a
//! tester hits is "it doesn't start", and we would have zero evidence.
//!
//! The approach: do not touch the 36 call sites. Point the process's own
//! stdout/stderr at a file, once, before anything prints. Everything already
//! written -- including panics, which go to stderr -- follows for free.
//!
//! ⚠ This rests on one assumption: that Rust's Windows stdio asks the OS for
//! the current handle on every write (rather than caching it at first use).
//! It is the reason a canary build is worth running first. If a double-clicked build produces an
//! empty log, this whole file is the wrong approach and the fallback is the
//! recorder's explicit `say!`/`note!` macros.
//!
//! ⚠️ **stdout does not hold up its half; everything now goes through stderr.**
//! Measured: three runs started by hand landed the `eprintln!`
//! lines and lost every `println!` line -- the six header lines and all eight
//! `[Mic]` device lines, which are exactly what a Bluetooth headset dropping
//! to call mode is diagnosed from. Runs started from a shell, and runs started
//! through Explorer from here, kept them. **The root cause is not known**: the
//! difference is not "double-click vs shell", because launching through
//! Explorer reproduced nothing. So the fix is not a fix of the cause -- those
//! 14 lines were converted to `eprintln!` so that one proven path carries
//! everything, instead of two paths where one is silently lossy.
//! 📌 The rule for anyone adding output here: **`eprintln!`, always.** A
//! `println!` may reach the log on your machine and be missing from the one a
//! tester mails back, with nothing anywhere saying a line was dropped.
//!
//! Three rules this file must never break:
//!   1. Failing to log must never take the app down. Every step is best-effort
//!      and returns quietly; there is no `unwrap` and no panic path.
//!   2. Never steal the launcher's log. When stdout is already redirected to a
//!      file, the `.bat` is doing the job -- leave it alone, or the existing
//!      `logs\app-*.log` (the only evidence trail there is) would
//!      go silently empty.
//!   3. ~~Never write next to the exe.~~ **Revised.** Writing next
//!      to the exe is now the *preferred* location -- one folder handed over
//!      carries the settings and the evidence trail with it. The danger the old
//!      rule named is real and has not gone away (Program Files, a locked
//!      OneDrive folder), so it is now handled by asking instead of by banning:
//!      `portable::portable_root()` writes a probe file, reads it back, deletes
//!      it, and only then claims the folder. Anything else falls back to the
//!      user's own local data dir, which always works.
//!      ⚠ The one rule that did NOT change: **the chosen address must be
//!      printed**. Silently picking a different folder is the exact failure this
//!      whole file exists to prevent.

/// Keep this many log files. One run is a few hundred lines, so this is about
/// tidiness, not disk space.
#[cfg(target_os = "windows")]
const KEEP_LOGS: usize = 20;

/// Redirect this process's stdout and stderr into a fresh log file.
/// Call once, as the very first thing in `run()`, before anything prints.
#[cfg(target_os = "windows")]
pub fn init() {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{GetFileType, FILE_TYPE_DISK};
    use windows::Win32::System::Console::{
        GetStdHandle, SetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE,
    };

    // Rule 2: the launcher is already capturing us -> do nothing.
    unsafe {
        if let Ok(h) = GetStdHandle(STD_OUTPUT_HANDLE) {
            if !h.is_invalid() && GetFileType(h) == FILE_TYPE_DISK {
                return;
            }
        }
    }

    let Some(dir) = log_dir() else { return };
    if std::fs::create_dir_all(&dir).is_err() {
        return; // read-only location: no log is survivable, a crash is not
    }
    prune(&dir);

    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let path = dir.join(format!("app-{}.log", stamp));
    let Ok(file) = std::fs::File::create(&path) else {
        return;
    };

    let handle = HANDLE(file.as_raw_handle() as _);
    unsafe {
        // Both streams into the same file, so the interleaving on disk matches
        // the order things actually happened.
        let _ = SetStdHandle(STD_OUTPUT_HANDLE, handle);
        let _ = SetStdHandle(STD_ERROR_HANDLE, handle);
    }
    // The file must outlive this function: dropping it would close the very
    // handle the process now prints through.
    std::mem::forget(file);

    header(&path);
}

#[cfg(not(target_os = "windows"))]
pub fn init() {}

/// Where the log file goes.
///
/// **Preferred location is `<exe folder>\logs`** so that
/// handing someone one folder hands them the evidence trail too. Rule 3 below used to forbid exactly this; it is now a
/// *probe*, not a ban -- `portable::portable_root()` writes a real file, reads
/// it back and deletes it before claiming the folder is usable, and falls back
/// to `%LOCALAPPDATA%\glossline\logs` when it is not (Program Files, a
/// locked OneDrive folder, a read-only share).
///
/// ⚠ Both branches are legitimate, so **the address has to be visible**: the
/// header line below prints the resolved path and `where_label()`, and the
/// frontend reads the same value through `log_dir_path`. A log nobody can find
/// is the same as no log.
pub fn log_dir() -> Option<std::path::PathBuf> {
    crate::portable::dir_for(
        "logs",
        dirs::data_local_dir().map(|d| d.join("glossline").join("logs")),
    )
}

/// Blank out any secret that would otherwise be written to the log verbatim.
///
/// The log's whole purpose is to be **sent to us by someone else**, so a key
/// reaching it is not a small leak -- it is a key mailed to a third party in a
/// file we asked them to send. The frontend forwarder (`log_frontend`) records
/// whatever JS hands it, with no filter: one `console.error(config)` anywhere,
/// today or in a year, is all it takes.
///
/// Matching is by exact value, not by pattern: we know what the secrets are, so
/// there is nothing to guess and nothing innocent to mangle. ⚠ The limit of
/// that choice: a secret we do NOT hold (one typed into some future field, or a
/// token minted at runtime) is invisible here. Values under 8 characters are
/// skipped -- a stray short string would otherwise redact half the log.
pub fn redact(message: &str, secrets: &[&str]) -> String {
    let mut out = message.to_string();
    for s in secrets {
        let s = s.trim();
        if s.len() < 8 {
            continue;
        }
        if out.contains(s) {
            out = out.replace(s, "<redacted>");
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::redact;

    /// ⚠ These test the masking rule, not the whole path. That a key never
    /// reaches the log ALSO depends on `log_frontend` passing every secret
    /// field in; a field added to `Settings` and forgotten there is invisible
    /// to every test here.
    #[test]
    fn masks_a_key_wherever_it_appears() {
        let msg = r#"POST failed {"api_key":"sk-abcdefgh12345678","model":"x"}"#; // gitleaks:allow (fake key for the redaction test)
        let out = redact(msg, &["sk-abcdefgh12345678"]);
        assert!(!out.contains("sk-abcdefgh12345678"));
        assert!(out.contains("<redacted>"));
        assert!(out.contains("model")); // the rest of the line survives
    }

    #[test]
    fn masks_every_secret_and_every_occurrence() {
        let out = redact(
            "one=AAAAAAAAAA two=BBBBBBBBBB again=AAAAAAAAAA",
            &["AAAAAAAAAA", "BBBBBBBBBB"],
        );
        assert_eq!(out, "one=<redacted> two=<redacted> again=<redacted>");
    }

    /// An empty key field is the normal state for six of the seven providers.
    /// Left unguarded it would match everywhere and redact the entire log.
    #[test]
    fn empty_and_short_secrets_are_ignored() {
        let msg = "nothing secret here";
        assert_eq!(redact(msg, &["", "   ", "abc", "1234567"]), msg);
    }

    #[test]
    fn leaves_an_innocent_message_alone() {
        let msg = "[audio] endpoints: output=Some((\"Speakers\", 48000, 2))";
        assert_eq!(redact(msg, &["sk-abcdefgh12345678"]), msg);
    }
}

/// The first lines of every log: the questions asked of every bug report
/// ("which build?", "which machine?", "where is it installed?") answered
/// before anyone has to ask them.
#[cfg(target_os = "windows")]
fn header(path: &std::path::Path) {
    eprintln!("=== glossline ===");
    eprintln!("time    : {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"));
    eprintln!("version : {}", env!("CARGO_PKG_VERSION"));
    eprintln!(
        "exe     : {}",
        std::env::current_exe()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|_| "?".into())
    );
    eprintln!("log     : {}", path.display());
    // ⚠ log 與設定**優先寫在 exe 旁邊**，寫不進去才退回使用者
    //   自己的資料夾。兩條路都合法，所以這一行不可以省——沒有它，「檔案怎麼
    //   不在我以為的地方」就變成一個沒有線索的問題。
    eprintln!("位置    : {}", crate::portable::where_label());
    eprintln!("--------------------------");
}

/// Delete all but the newest `KEEP_LOGS` files. Best-effort: a failure here is
/// not worth a word, let alone an interruption.
#[cfg(target_os = "windows")]
fn prune(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<_> = entries
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("app-")
        })
        .filter_map(|e| e.metadata().ok().and_then(|m| m.modified().ok()).map(|t| (t, e.path())))
        .collect();
    if files.len() <= KEEP_LOGS {
        return;
    }
    files.sort_by_key(|(t, _)| *t);
    let cut = files.len() - KEEP_LOGS;
    for (_, p) in files.into_iter().take(cut) {
        let _ = std::fs::remove_file(p);
    }
}
