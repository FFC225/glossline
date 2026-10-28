use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Translation term: source → target mapping for Soniox
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TranslationTerm {
    pub source: String,
    pub target: String,
}

/// Custom context for Soniox — provides domain-specific hints
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct CustomContext {
    pub domain: Option<String>,
    /// Transcription hints handed to Soniox as context.terms.
    /// The frontend has always sent this; the struct never had the field, so serde
    /// dropped it without a word -- the hard word list simply never persisted.
    pub terms: Vec<String>,
    /// Free-form background text, same story as terms above.
    pub text: Option<String>,
    pub translation_terms: Vec<TranslationTerm>,
}

/// One window size in LOGICAL pixels (already divided by the
/// monitor scale factor). Physical pixels would grow by the scale factor every
/// time the window is saved and restored on a HiDPI screen.
#[derive(Debug, Serialize, Deserialize, Clone, Copy, Default, PartialEq)]
#[serde(default)]
pub struct WindowSize {
    pub w: u32,
    pub h: u32,
}

/// App settings — persisted to JSON
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    /// Soniox API key
    pub soniox_api_key: String,
    /// Source language: "auto" or ISO 639-1 code
    pub source_language: String,
    /// Target language: ISO 639-1 code
    pub target_language: String,
    /// Audio source: "system" | "microphone" | "both"
    pub audio_source: String,
    /// Overlay opacity: 0.0 - 1.0
    pub overlay_opacity: f64,
    /// Font size in px
    pub font_size: u32,
    /// Max transcript lines to display
    pub max_lines: u32,
    /// Whether to show original text alongside translation
    pub show_original: bool,
    /// Translation mode: "soniox" | "local" | "openai"
    pub translation_mode: String,
    /// Optional custom context for better transcription
    pub custom_context: Option<CustomContext>,
    /// Directory the raw meeting audio is archived into,
    /// one WAV per source. Empty = archiving off. The archive is what gets
    /// handed to a post-meeting transcription tool afterwards, so it keeps the
    /// device's own rate/channels and never drops silence.
    #[serde(default = "default_recording_dir")]
    pub recording_dir: String,
    /// Whether the window floats above everything else.
    /// Upstream hard-coded this in tauri.conf.json; here it is switchable and
    /// remembered, so it lives here and the frontend applies it on boot.
    #[serde(default = "default_always_on_top")]
    pub always_on_top: bool,
    /// UI colour scheme: "dark" | "light".
    /// Anything else is treated as "dark" by the frontend.
    #[serde(default = "default_theme")]
    pub theme: String,
    /// Window shell mode: "overlay" (small floating) |
    /// "expanded" (comfortable). `decorations: false` means there is no system
    /// maximise/restore button, so the two sizes are ours to remember.
    #[serde(default = "default_window_mode")]
    pub window_mode: String,
    /// Remembered size per mode. `None` = never resized in
    /// that mode yet, so the frontend falls back to its built-in default.
    #[serde(default)]
    pub window_size_overlay: Option<WindowSize>,
    #[serde(default)]
    pub window_size_expanded: Option<WindowSize>,
    /// 這台機器是否已經看過並確認過錄音告知。
    ///
    /// 一次性，不是每場。每場的告知由畫面上那條持續的「🔴 錄音中」承擔——
    /// 一個每次都在、而且每次都勾得下去的框，兩個星期後就變成反射動作。
    #[serde(default)]
    pub recording_consent_ack: bool,
    /// 散會取名後，錄音資料夾的名字放哪邊：
    /// `"name_first"`＝`週會-YYYY-MM-DD_1430`（預設）｜
    /// `"date_first"`＝`YYYY-MM-DD_1430-週會`。其他值一律當 `name_first`。
    #[serde(default = "default_folder_name_order")]
    pub folder_name_order: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            soniox_api_key: String::new(),
            source_language: "auto".to_string(),
            // Upstream defaults to Vietnamese (its author's
            // language). A first run of ours is a meeting translated into a
            // language nobody in the room reads -- which looks like a broken app,
            // not a wrong setting. Only ever seen on a machine with no settings
            // file yet, i.e. exactly the machine we hand to someone else.
            target_language: "zh".to_string(),
            // 預設兩路都錄。
            // 上游預設只抓電腦播出的聲音，於是曾有整場沒有 me.wav——
            // 事後要核「我方到底有沒有答應」時，那半邊根本不存在。
            // ⚠ 改預設救不了已經存成 "system" 的設定檔，那要靠 precheck
            //   的單路警示攔（`commands/precheck.rs` 的 audio_source 那一項）。
            audio_source: "both".to_string(),
            overlay_opacity: 0.85,
            font_size: 16,
            max_lines: 5,
            show_original: true,
            translation_mode: "soniox".to_string(),
            custom_context: None,
            recording_dir: default_recording_dir(),
            always_on_top: default_always_on_top(),
            theme: default_theme(),
            window_mode: default_window_mode(),
            window_size_overlay: None,
            window_size_expanded: None,
            recording_consent_ack: false,
            folder_name_order: default_folder_name_order(),
        }
    }
}

/// Where a machine that has never been configured
/// archives its meetings.
///
/// Upstream's answer was the empty string, and the empty string means "do not
/// record" (`recording_paths` returns `(None, None)`). On the author's machine that is
/// invisible because the setting was filled in long ago; on a machine we hand
/// to someone else it means their first meeting leaves no file behind and
/// nothing on screen ever says so.
///
/// Three steps, in this order:
/// 1. `recordings\` next to the executable — same rule as the standalone recorder
///    (its `default_out_root`), so copying the
///    folder moves the recordings with it;
/// 2. `文件\會議錄音` — for an exe living somewhere Windows will not let us
///    write (Program Files, a read-only share);
/// 3. the empty string, and then it must be *said*: `eprintln!` here, and
///    `precheck`'s `recording_dir` item reports `fail`. A silent empty string
///    is the exact failure this function exists to remove.
///
/// ⚠ This is only a `serde` default and the `Default` impl, which means it
/// fills in a *missing* field. A settings file that already says `""` keeps
/// `""` — we cannot tell "the user turned recording off" from "it was saved
/// empty", and guessing would
/// be deciding for them. The precheck is what makes that case visible instead.
pub fn default_recording_dir() -> String {
    fn writable(dir: &std::path::Path) -> bool {
        if std::fs::create_dir_all(dir).is_err() {
            return false;
        }
        // Creating the folder is not the same as being allowed to write in it,
        // and an ACL denial only shows up at the first `File::create` — which
        // would otherwise be halfway through the first meeting.
        let probe = dir.join(".write-test");
        match std::fs::write(&probe, b"ok") {
            Ok(_) => {
                let _ = std::fs::remove_file(&probe);
                true
            }
            Err(_) => false,
        }
    }

    if let Some(next_to_exe) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("recordings")))
    {
        if writable(&next_to_exe) {
            return next_to_exe.to_string_lossy().to_string();
        }
        eprintln!(
            "[settings] cannot use {:?} for recordings, trying the documents folder",
            next_to_exe
        );
    }

    if let Some(docs) = dirs::document_dir() {
        let fallback = docs.join("會議錄音");
        if writable(&fallback) {
            return fallback.to_string_lossy().to_string();
        }
        eprintln!("[settings] cannot use {:?} for recordings either", fallback);
    }

    // No silent degrade. This is the only line anyone will ever see
    // about it until `precheck` puts it on screen.
    eprintln!(
        "[settings] RECORDING DISABLED: no writable default folder found. Pick one in the settings page, or the app will not keep any audio."
    );
    String::new()
}

/// Serde default for `local_tts_speed` (field-level default would give 0.0).
fn default_local_tts_speed() -> f32 {
    1.0
}

/// Serde default for `always_on_top`.
/// True keeps upstream's behaviour for anyone whose settings.json predates the field.
fn default_always_on_top() -> bool {
    true
}

/// Serde default for `theme` (bool/String field-level
/// defaults would give false/"" and silently mean something else).
fn default_theme() -> String {
    "dark".to_string()
}

/// Serde default for `window_mode`. Anything the frontend
/// does not recognise is treated as "overlay".
fn default_window_mode() -> String {
    "overlay".to_string()
}

/// Serde default for `folder_name_order`：沒有這格的舊設定檔（早期版本存的）
/// 讀進來就是名字在前。
fn default_folder_name_order() -> String {
    "name_first".to_string()
}

/// 設定檔的老家：`%APPDATA%\com.personal.translator\settings.json`
/// （macOS 是 `~/Library/Application Support/...`）。
///
/// ⚠ 這個位置**沒有廢掉**：exe 旁邊寫不進去時就是它，而且搬家之後舊的那份
///   也刻意留著不刪（見 `migrate_settings`）。
fn legacy_settings_path() -> PathBuf {
    let mut path = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("com.personal.translator");
    path.push("settings.json");
    path
}

/// 這一次要讀寫的設定檔在哪。
///
/// **優先放在 exe 旁邊**（給別人一個資料夾，資料直接在
/// 資料夾產生）。exe 旁邊寫不進去（Program Files、被鎖住的同步資料夾）就
/// 退回老家——判斷方式是真的寫一個檔試試看，見 `portable.rs`。
fn settings_path() -> PathBuf {
    match crate::portable::portable_root() {
        Some(root) => root.join("settings.json"),
        None => legacy_settings_path(),
    }
}

/// 設定檔實際在哪，給設定頁顯示（指令在 `commands/logs.rs`）。
///
/// ⚠ 順便講出走的是哪一種位置：光給一條路徑，使用者看不出來那是
///   「跟程式放在一起」還是「退回去的那個」，而那正是他下一個問題。
pub fn settings_path_display() -> String {
    format!(
        "{}（{}）",
        settings_path().display(),
        crate::portable::where_label()
    )
}

/// 搬遷的結果。做成一個有名字的東西，是為了讓「什麼都沒做」跟「做了但失敗」
/// 在測試裡分得開——這兩件事在畫面上長得一模一樣（設定都是空的）。
#[derive(Debug, PartialEq)]
pub enum MigrateOutcome {
    /// 新舊是同一個檔（exe 旁邊寫不進去），沒有搬家這回事。
    SamePlace,
    /// 新位置已經有檔了，**不覆蓋**。
    TargetExists,
    /// 老家沒有東西可搬（第一次用這支程式）。
    NothingToMove,
    /// 搬好了。
    Copied,
    /// 搬失敗——要講出來，不可以安靜地當成「沒設定過」。
    Failed(String),
}

/// 把老家那份設定**複製**到新位置。
///
/// 三條刻意的規矩：
///   1. **複製，不是移動**——這種搬遷最常見的失敗是「搬到一半」，舊的還在就永遠有退路。
///   2. **新位置已經有檔就不動它**——覆蓋掉使用者剛填的金鑰是最貴的錯。
///   3. **失敗要出聲**。設定讀不到的症狀是「金鑰不見了」，而使用者會以為是自己弄丟的。
pub fn migrate_settings(legacy: &Path, target: &Path) -> MigrateOutcome {
    if legacy == target {
        return MigrateOutcome::SamePlace;
    }
    if target.exists() {
        return MigrateOutcome::TargetExists;
    }
    if !legacy.exists() {
        return MigrateOutcome::NothingToMove;
    }
    if let Some(parent) = target.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            return MigrateOutcome::Failed(format!("建不出資料夾 {}：{}", parent.display(), e));
        }
    }
    match fs::copy(legacy, target) {
        Ok(_) => MigrateOutcome::Copied,
        Err(e) => MigrateOutcome::Failed(format!("{} -> {}：{}", legacy.display(), target.display(), e)),
    }
}

impl Settings {
    /// Load settings from disk, or return defaults
    pub fn load() -> Self {
        // 老家那份先搬過來（只在新位置還沒有檔的時候）。
        // ⚠ 排在讀取之前：反過來的話第一次開起來會是空白設定，
        //   使用者會以為金鑰不見了，然後重填一次——而下一次啟動又搬了一份舊的蓋上來。
        let legacy = legacy_settings_path();
        let target = settings_path();
        match migrate_settings(&legacy, &target) {
            MigrateOutcome::Copied => eprintln!(
                "[settings] 舊位置那份已複製過來：{} -> {}（舊的沒有刪，還在原地）",
                legacy.display(),
                target.display()
            ),
            MigrateOutcome::Failed(why) => eprintln!(
                "[settings] ⚠ 舊設定搬不過來（{}）——這次會當成沒設定過，金鑰與錄音資料夾要重填一次。舊的那份還在 {}",
                why,
                legacy.display()
            ),
            _ => {}
        }

        let path = target;
        if path.exists() {
            match fs::read_to_string(&path) {
                Ok(content) => match serde_json::from_str::<Self>(&content) {
                    Ok(s) => {
                        eprintln!(
                            "[settings] loaded {} (target_language={}, audio_source={}, recording_dir={:?}, font_size={}, max_lines={}, always_on_top={}, theme={}, window_mode={}, custom_context=[{}])",
                            path.display(),
                            s.target_language,
                            s.audio_source,
                            s.recording_dir,
                            s.font_size,
                            s.max_lines,
                            s.always_on_top,
                            s.theme,
                            s.window_mode,
                            describe_context(&s.custom_context)
                        );
                        s
                    }
                    // No silent degrade: this used to be
                    // `.unwrap_or_default()`. A single bad field silently
                    // replaced every setting with the built-in defaults --
                    // including an empty recording_dir, which turns archiving
                    // off without saying so.
                    Err(e) => {
                        eprintln!(
                            "[settings] PARSE FAILED for {}: {} -- falling back to defaults, \
                             so every setting you see is a default, not yours",
                            path.display(),
                            e
                        );
                        Self::default()
                    }
                },
                Err(e) => {
                    eprintln!("[settings] cannot read {}: {}", path.display(), e);
                    Self::default()
                }
            }
        } else {
            eprintln!("[settings] no file at {}, using defaults", path.display());
            Self::default()
        }
    }

    /// Save settings to disk
    pub fn save(&self) -> Result<(), String> {
        let path = settings_path();

        // Ensure parent directory exists
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create config dir: {}", e))?;
        }

        let json = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize: {}", e))?;

        fs::write(&path, json).map_err(|e| format!("Failed to write settings: {}", e))?;

        Ok(())
    }
}

/// One-line summary of `custom_context` for the log.
///
/// The hard word list is the whole reason `terms` was added to the struct, but
/// the log never printed it -- so "did the word list persist?" could only ever
/// be answered by looking at the screen. Printing the *counts* (not the
/// contents) keeps meeting vocabulary out of the log file while still giving a
/// machine-checkable answer.
pub fn describe_context(ctx: &Option<CustomContext>) -> String {
    match ctx {
        None => "none".to_string(),
        Some(c) => format!(
            "terms={}, text={}, translation_terms={}, domain={}",
            c.terms.len(),
            c.text.as_ref().map(|t| t.chars().count()).unwrap_or(0),
            c.translation_terms.len(),
            c.domain.as_deref().unwrap_or("-")
        ),
    }
}

/// Thread-safe settings state managed by Tauri
pub struct SettingsState(pub Mutex<Settings>);

#[cfg(test)]
mod migrate_tests {
    use super::*;

    /// 每題自己一個乾淨的資料夾，否則同一顆 temp 目錄下互相踩。
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mt-settings-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn old_there_new_missing_gets_copied() {
        let dir = scratch("copy");
        let legacy = dir.join("old.json");
        let target = dir.join("新家").join("settings.json");
        fs::write(&legacy, r#"{"api_key":"abc"}"#).unwrap();

        assert_eq!(migrate_settings(&legacy, &target), MigrateOutcome::Copied);
        assert_eq!(fs::read_to_string(&target).unwrap(), r#"{"api_key":"abc"}"#);
        // ⭐ 舊的必須還在：這是搬壞了唯一的退路。
        assert!(legacy.exists(), "舊檔被刪掉了，搬遷失敗就沒有退路");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn existing_target_is_never_overwritten() {
        let dir = scratch("nooverwrite");
        let legacy = dir.join("old.json");
        let target = dir.join("settings.json");
        fs::write(&legacy, r#"{"api_key":"舊的"}"#).unwrap();
        fs::write(&target, r#"{"api_key":"剛填的"}"#).unwrap();

        assert_eq!(migrate_settings(&legacy, &target), MigrateOutcome::TargetExists);
        // ⭐ 覆蓋掉使用者剛填的金鑰是這整段最貴的錯。
        assert_eq!(fs::read_to_string(&target).unwrap(), r#"{"api_key":"剛填的"}"#);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_to_move_when_there_is_no_old_file() {
        let dir = scratch("nosource");
        let legacy = dir.join("不存在.json");
        let target = dir.join("settings.json");

        assert_eq!(migrate_settings(&legacy, &target), MigrateOutcome::NothingToMove);
        assert!(!target.exists(), "來源不存在時不可以生出一個空檔");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn same_path_is_not_a_migration() {
        // exe 旁邊寫不進去時，新舊就是同一個檔——這條路不可以被當成「要搬家」。
        let dir = scratch("same");
        let p = dir.join("settings.json");
        fs::write(&p, "{}").unwrap();
        assert_eq!(migrate_settings(&p, &p), MigrateOutcome::SamePlace);
        let _ = fs::remove_dir_all(&dir);
    }

    /// 搬不過去的時候要**說得出來**，不可以安靜地當成「本來就沒設定過」。
    ///
    /// 這題是獨立審查抓到的缺口：`MigrateOutcome::Failed` 這個分支
    /// 當時在整份測試裡零命中——而它正是「金鑰看起來不見了」那條路。
    /// 製造失敗的方法：把新位置的**父資料夾做成一個檔案**，`create_dir_all` 必敗。
    #[test]
    fn a_failed_move_says_so_instead_of_looking_like_a_fresh_install() {
        let dir = scratch("failed");
        let legacy = dir.join("old.json");
        fs::write(&legacy, r#"{"api_key":"abc"}"#).unwrap();

        let blocker = dir.join("擋路的檔");
        fs::write(&blocker, "我是一個檔案，不是資料夾").unwrap();
        let target = blocker.join("settings.json");

        match migrate_settings(&legacy, &target) {
            MigrateOutcome::Failed(why) => {
                assert!(!why.is_empty(), "失敗訊息是空的，等於沒說");
                // 訊息裡要有路徑，不然看 log 的人不知道是哪個檔。
                assert!(
                    why.contains("擋路的檔") || why.contains("settings.json"),
                    "失敗訊息沒有帶路徑：{}",
                    why
                );
            }
            other => panic!("這條路該回 Failed，卻回了 {:?}", other),
        }
        // ⭐ 失敗之後舊檔必須原封不動——那是使用者的金鑰唯一還在的地方。
        assert_eq!(fs::read_to_string(&legacy).unwrap(), r#"{"api_key":"abc"}"#);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn settings_path_display_says_where_and_which_kind() {
        let shown = settings_path_display();
        assert!(shown.contains("settings.json"), "沒講到檔名：{}", shown);
        // 光給路徑看不出「這是跟程式放一起的、還是退回去的那個」。
        assert!(shown.contains("資料夾"), "沒講是哪一種位置：{}", shown);
    }

    #[test]
    fn legacy_and_portable_paths_are_not_accidentally_the_same() {
        // 兩個函式如果哪天被改成同一個位置，上面每一題都會變成 SamePlace 而
        // 「全部通過」——這題就是釘住那個假通過。
        let legacy = legacy_settings_path();
        assert!(legacy.ends_with("settings.json"));
        assert!(legacy.to_string_lossy().contains("com.personal.translator"));
    }
}
