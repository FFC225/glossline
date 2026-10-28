//! 按「開始」之前先看一眼這台機器。
//!
//! 這是一頭一尾兩張網的**前面那一張**（後面那張是 `audio.rs` 的收工報告）。
//! 它防的事跟收工報告一樣、只是提早兩小時：一場沒錄到的會議與一場錄得很好的
//! 會議，在畫面上、在檔案總管裡長得一模一樣。差別是這一張網還來得及修。
//!
//! 整支照搬獨立錄音工具的 `self_check`（那支已經在黑窗裡跑了
//! 幾十場），但**回清單、不印字**——黑窗有一個可以印字的地方，這支沒有。
//! 判斷留在這裡，長什麼樣子留給前端。
//!
//! 三條刻意的規矩：
//!
//! 1. **`async` ＋ `spawn_blocking`，不是裝飾。** 同步 command 跑在主執行緒，
//!    Windows 上那就是拿著 WebView 的 STA 執行緒；在那裡列舉音訊裝置＝
//!    COM 公寓輪盤＋畫面凍住。`audio_devices.rs` 已經為了同一件事踩過一次。
//! 2. **`State<'_, SettingsState>` 不可以跨 `spawn_blocking`**：先取成 `String`
//!    再進去。
//! 3. **每一項各留一行 `eprintln!`**。全綠時前端什麼都不彈，
//!    那一刻紀錄檔是體檢結果的唯一去處——所以那幾行不是裝飾。
//!    ⚠ 只准 `eprintln!`，`applog.rs` 只接管 stderr。

use crate::settings::SettingsState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::State;

/// 每一秒錄音要吃掉的位元組：48 kHz、立體聲、16 bit、兩軌。
/// 照抄獨立錄音工具的同名常數——同一台機器上兩支工具
/// 講出來的「還能錄幾小時」必須是同一個數字，不然人會不知道要信哪一個。
const BYTES_PER_SECOND: u64 = 48_000 * 4 * 2;
/// 低於這個就講一聲，大約是兩小時的會議。
const LOW_DISK: u64 = 3 * 1024 * 1024 * 1024;

/// 體檢清單上的一項。
///
/// `level` 只有三個值：`ok` / `warn` / `fail`。用字串不用 enum 是因為它要原封
/// 走到 JS 那邊去，而 JS 那邊本來就只會拿它跟這三個字比。
#[derive(Debug, Clone, Serialize)]
pub struct CheckItem {
    /// 機器認的名字（`windows` / `output` / `input` / `recording_dir` /
    /// `writable` / `disk`）。前端靠它認人——`label` 是給人看的，會改。
    pub key: String,
    pub label: String,
    pub level: String,
    pub detail: String,
}

impl CheckItem {
    fn new(key: &str, label: &str, level: &str, detail: String) -> Self {
        // 全綠不彈框時，這一行是唯一的去處。
        eprintln!("[precheck] {} {}: {} — {}", level.to_uppercase(), key, label, detail);
        Self {
            key: key.to_string(),
            label: label.to_string(),
            level: level.to_string(),
            detail,
        }
    }
}

/// Windows 版本，從登錄檔讀。
///
/// `GetVersionEx` 沒有 application manifest 就會說謊，而 Windows 11 除了 build
/// 號以外到處都自稱 10——build 號正是唯一值得記的那個數字。
/// （`process loopback` 要 20348+，所以這一行不只是好看的。）
fn windows_version() -> String {
    #[cfg(target_os = "windows")]
    {
        let build = reg_string("CurrentBuild").unwrap_or_default();
        let display = reg_string("DisplayVersion").unwrap_or_default();
        let n: u32 = build.parse().unwrap_or(0);
        if n > 0 {
            let name = if n >= 22000 { 11 } else { 10 };
            return format!("Windows {} {} (build {})", name, display, build).replace("  ", " ");
        }
    }
    "(版本查不到)".to_string()
}

/// 版本鍵底下的一個字串值。
#[cfg(target_os = "windows")]
fn reg_string(name: &str) -> Option<String> {
    use windows::core::{w, PCWSTR};
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    let value: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let mut buf = [0u16; 128];
    let mut len = (buf.len() * 2) as u32;
    unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            w!(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion"),
            PCWSTR(value.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr() as *mut _),
            Some(&mut len),
        )
        .ok()
        .ok()?;
    }
    let n = (len as usize / 2).saturating_sub(1).min(buf.len());
    Some(String::from_utf16_lossy(&buf[..n]))
}

/// 放著 `path` 的那顆磁碟還剩幾個位元組。
fn free_bytes(path: &Path) -> Option<u64> {
    #[cfg(target_os = "windows")]
    unsafe {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        wide.push(0);
        let mut free: u64 = 0;
        if GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&mut free), None, None).is_ok() {
            return Some(free);
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = path;
    None
}

fn gib(bytes: u64) -> f64 {
    bytes as f64 / (1024.0 * 1024.0 * 1024.0)
}

/// `bytes` 裝得下幾小時的兩軌錄音。
fn hours_left(bytes: u64) -> f64 {
    bytes as f64 / (BYTES_PER_SECOND as f64 * 3600.0)
}

/// 開始前的體檢。
///
/// `record_dir` 有給就用它（換完資料夾之後要能立刻重驗一次，而那時候設定
/// 還沒存回去），沒給就退回設定值——**跟 `start_capture` 同一條規則**，
/// 不然體檢看的那個資料夾跟真的會被寫進去的那個不是同一個，全綠也沒有意義。
#[tauri::command]
pub async fn precheck(
    record_dir: Option<String>,
    audio_source: Option<String>,
    settings: State<'_, SettingsState>,
) -> Result<Vec<CheckItem>, String> {
    // 規矩 2：State 不能跨 spawn_blocking，先取成 String。
    let dir = match record_dir {
        Some(d) if !d.trim().is_empty() => d,
        _ => settings
            .0
            .lock()
            .map(|s| s.recording_dir.clone())
            .unwrap_or_default(),
    };

    // 「抓哪一路」同一條規則：前端傳的是**這場真的要開的那個值**，
    // 沒傳才退回設定值。體檢講的那一路必須就是等一下真的會開的那一路，
    // 不然警示會對著另一個設定講話。
    let source = match audio_source {
        Some(s) if !s.trim().is_empty() => s,
        _ => settings
            .0
            .lock()
            .map(|s| s.audio_source.clone())
            .unwrap_or_default(),
    };

    let acked = settings
        .0
        .lock()
        .map(|s| s.recording_consent_ack)
        .unwrap_or_default();
    let consent = consent_item(acked);

    // 規矩 1：列舉音訊裝置絕對不可以留在主執行緒上。
    let mut items = tauri::async_runtime::spawn_blocking(move || run_checks(&dir, &source))
        .await
        .map_err(|e| format!("體檢沒跑完：{}", e))?;
    // 告知排第一（只有第一次會有）。
    if let Some(c) = consent {
        items.insert(0, c);
    }
    Ok(items)
}

/// 「抓哪一路」這一項。**純函式、不碰任何裝置**，所以測試直接叫得動。
///
/// 實際發生過整場只錄到對方、沒有 `me.wav`，事後要核
/// 「我方到底有沒有答應」時那半邊根本不存在——而當下畫面上沒有任何跡象：
/// 單路錄得很好的一場，跟兩路錄得很好的一場，長得一模一樣。
///
/// ⚠ 單路**不擋**，只是不准默默開：前端拿到 `warn` 會彈體檢框，
///   人按「照樣開始」就繼續（`precheck-panel.js` 的規矩 2）。
fn audio_source_item(source: &str) -> CheckItem {
    match source.trim() {
        "both" => CheckItem::new(
            "audio_source",
            "兩路都錄（對方 ＋ 你自己）",
            "ok",
            "對方的聲音與你的麥克風各存一軌。".to_string(),
        ),
        "system" => CheckItem::new(
            "audio_source",
            "這場只會錄到對方，不會錄到你自己",
            "warn",
            "「抓哪一路」現在是「只抓對方」。你自己講的話不會進檔、也不會有字幕，事後沒辦法核對我方講過什麼。要兩邊都留就到設定頁改成「兩路都抓」。"
                .to_string(),
        ),
        "microphone" => CheckItem::new(
            "audio_source",
            "這場只會錄到你自己，不會錄到對方",
            "warn",
            "「抓哪一路」現在是「只抓自己」。對方講的話不會進檔、也不會有字幕。要兩邊都留就到設定頁改成「兩路都抓」。"
                .to_string(),
        ),
        other => CheckItem::new(
            "audio_source",
            "「抓哪一路」這個值我不認得",
            "warn",
            format!(
                "設定裡是「{}」，我只認得 both／system／microphone。這場很可能什麼都開不起來。",
                other
            ),
        ),
    }
}

/// A-8：錄音告知那一項。**純函式。**
///
/// 只在「這台機器還沒確認過」時出現，而且是 `fail`——前端看到它會把勾選欄
/// 顯示出來，沒勾就按不下開始（`main.js` 的 `needsConsent`）。
/// 確認過之後這一項就不再出現在清單上：一個永遠都在、永遠可以按過去的提醒，
/// 跟沒有提醒是一樣的。
fn consent_item(acked: bool) -> Option<CheckItem> {
    if acked {
        return None;
    }
    // 這是「不擋人的一行提示」（原本是勾了才能開始）。
    // ⚠ 等級因此一定要從 `fail` 降成 `warn`：`fail` 會讓體檢框的標題變成
    //   「這台機器現在的狀態會讓這場白錄」——那句話對這一項是假的，
    //   而一個會說假話的警告，會連帶教人不要相信同一個框裡其他真的警告。
    Some(CheckItem::new(
        "consent",
        "這支程式會錄下會議的聲音",
        "warn",
        "第一次使用先講一聲：錄音與逐字稿裡會有其他與會者的聲音與說過的話。\
開始錄之前請先告訴他們。這一項不會擋你，而且之後不會再問。"
            .to_string(),
    ))
}

/// 真正在做事的那一半。**不碰 Tauri、不碰 State**，所以測試直接叫得動。
fn run_checks(dir: &str, source: &str) -> Vec<CheckItem> {
    use cpal::traits::{DeviceTrait, HostTrait};

    let mut items = Vec::new();
    items.push(CheckItem::new(
        "windows",
        "Windows 版本",
        "ok",
        windows_version(),
    ));

    let host = cpal::default_host();

    // 輸出裝置。沒有它就沒有「對方的聲音」可以抄。
    let out_dev = host.default_output_device();
    let out_name = out_dev.as_ref().and_then(|d| d.name().ok());
    items.push(match &out_name {
        Some(n) => {
            let fmt = out_dev
                .as_ref()
                .and_then(|d| d.default_output_config().ok())
                .map(|c| format!("（{} Hz, {} 聲道）", c.sample_rate().0, c.channels()))
                .unwrap_or_default();
            CheckItem::new(
                "output",
                "喇叭／耳機（對方的聲音從這裡抄）",
                "ok",
                format!("{}{}", n, fmt),
            )
        }
        None => CheckItem::new(
            "output",
            "找不到任何播放裝置",
            "fail",
            "Windows 沒有預設的喇叭或耳機，這樣錄不到對方的聲音。請先接上耳機或喇叭、到「設定 → 系統 → 音效」選好，再按一次開始。"
                .to_string(),
        ),
    });

    // 輸入裝置。少了這半邊還能錄對方，所以只是警告。
    let in_dev = host.default_input_device();
    let in_name = in_dev.as_ref().and_then(|d| d.name().ok());
    let in_fmt = in_dev.as_ref().and_then(|d| d.default_input_config().ok());
    items.push(match &in_name {
        Some(n) => {
            let detail = match &in_fmt {
                Some(c) => format!("{}（{} Hz, {} 聲道）", n, c.sample_rate().0, c.channels()),
                None => n.clone(),
            };
            // 藍牙耳機的免持麥克風會把整條連線拖成電話音質，
            // 而 Windows 與 App 都不會說一個字。這裡是唯一會講的地方。
            if n.contains("Hands-Free") || n.contains("免持") {
                CheckItem::new(
                    "input",
                    "這支麥克風是藍牙耳機的「免持」麥克風",
                    "warn",
                    format!(
                        "{}。它會把整條藍牙拖成電話音質，對方的聲音也會一起變糊。建議改用 USB 麥克風。",
                        detail
                    ),
                )
            } else {
                CheckItem::new("input", "麥克風（你的聲音）", "ok", detail)
            }
        }
        None => CheckItem::new(
            "input",
            "找不到麥克風",
            "warn",
            "你自己的聲音不會被錄下來，對方的聲音照錄。要錄自己就接一支麥克風再按一次開始。"
                .to_string(),
        ),
    });

    // 這場要錄哪幾路。排在兩個裝置之後、資料夾之前：先講機器上有什麼，
    // 再講這場打算用哪幾路，最後才講要存去哪裡。
    items.push(audio_source_item(source));

    // **現在生效的**錄音資料夾。
    //
    // 這一項是為了一個真實事故加的：`recording_dir` 被存成空字串，而空字串在
    // `recording_paths` 裡的意思是「不錄」——App 照常開、照常出字幕、照常說
    // 「已停止」，只是一個檔都沒有。整條路上沒有任何一個地方會講話。
    // 這是它下次開會前唯一會露臉的地方。
    let has_dir = !dir.trim().is_empty();
    items.push(if has_dir {
        CheckItem::new("recording_dir", "錄音存放資料夾", "ok", dir.to_string())
    } else {
        CheckItem::new(
            "recording_dir",
            "這場不會留下錄音檔",
            "warn",
            "錄音資料夾是空的，所以只會有字幕、不會有錄音檔——事後沒有東西可以拿去做正式逐字稿。要錄就到設定頁選一個資料夾。"
                .to_string(),
        )
    });

    // 寫得進去嗎。權限問題在錄完之前看起來跟沒事一模一樣。
    if has_dir {
        let root = PathBuf::from(dir.trim());
        let probe_result = std::fs::create_dir_all(&root).and_then(|_| {
            let probe = root.join(".write-test");
            std::fs::write(&probe, b"ok")?;
            std::fs::remove_file(&probe)
        });
        items.push(match probe_result {
            Ok(_) => CheckItem::new(
                "writable",
                "寫入權限",
                "ok",
                format!("可以寫入 {}", root.display()),
            ),
            Err(e) => CheckItem::new(
                "writable",
                "沒辦法在這個位置存檔",
                "fail",
                format!(
                    "{}（{}）。換一個「文件」或桌面底下的資料夾再試一次；C 槽根目錄與 Program Files 底下會被 Windows 擋住。",
                    root.display(),
                    e
                ),
            ),
        });

        // 磁碟空間。三小時的會議兩軌合計約 4 GB。
        items.push(match free_bytes(&root) {
            Some(free) if free >= LOW_DISK => CheckItem::new(
                "disk",
                "磁碟空間",
                "ok",
                format!(
                    "剩 {:.1} GB，大約可以錄 {:.1} 小時",
                    gib(free),
                    hours_left(free)
                ),
            ),
            Some(free) => CheckItem::new(
                "disk",
                "磁碟空間不多",
                "warn",
                format!(
                    "只剩 {:.1} GB，大約只夠錄 {:.1} 小時。一小時的會議兩軌合計約 1.4 GB。長會議前先清一些空間。",
                    gib(free),
                    hours_left(free)
                ),
            ),
            None => CheckItem::new(
                "disk",
                "磁碟空間",
                "warn",
                "查不到剩餘空間（不影響錄音，只是沒辦法事先提醒你）".to_string(),
            ),
        });
    }

    items
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 寫不進去的資料夾一定要判 `fail`，而且**不可以**只是少一項。
    ///
    /// 少一項跟全過在前端看起來一模一樣（都沒有紅的），而這正是這項檢查要抓的那件事。
    #[test]
    fn unwritable_dir_is_a_fail_not_a_missing_item() {
        // 這個路徑在任何一台 Windows 上都不存在，`create_dir_all` 必定失敗。
        #[cfg(target_os = "windows")]
        let bad = r"Z:\nope\glossline-test";
        #[cfg(not(target_os = "windows"))]
        let bad = "/proc/nope/glossline-test";

        let items = run_checks(bad, "both");
        let w = items
            .iter()
            .find(|i| i.key == "writable")
            .expect("寫入權限那一項不見了——少一項跟全過在畫面上長得一樣");
        assert_eq!(w.level, "fail");
        // 資料夾那一項照樣要在，而且是 ok（路徑是有填的，只是寫不進去）——
        // 兩件事分開講，人才知道要去改哪一個。
        let d = items.iter().find(|i| i.key == "recording_dir").unwrap();
        assert_eq!(d.level, "ok");
    }

    /// 資料夾是空字串時，那一項是黃的，而且**沒有**寫入權限與磁碟那兩項
    /// ——沒有資料夾就沒有東西可以量，硬編一個「可以寫入」出來是說謊。
    #[test]
    fn empty_dir_warns_and_skips_the_two_items_that_need_one() {
        let items = run_checks("   ", "both");
        let d = items.iter().find(|i| i.key == "recording_dir").unwrap();
        assert_eq!(d.level, "warn");
        assert!(d.label.contains("不會留下錄音檔"));
        assert!(items.iter().all(|i| i.key != "writable"));
        assert!(items.iter().all(|i| i.key != "disk"));
    }

    /// 單路一定是黃的、兩路一定是綠的。
    ///
    /// 這一項是整個「預設兩路」改動唯一會在畫面上露臉的地方——預設值改了
    /// 救不了已經存成 `system` 的設定檔（已經發出去的包就是那種），
    /// 所以這條測試守的是那些機器。
    #[test]
    fn single_stream_warns_and_says_which_half_is_missing() {
        let both = audio_source_item("both");
        assert_eq!(both.level, "ok");

        let sys = audio_source_item("system");
        assert_eq!(sys.level, "warn");
        assert!(sys.label.contains("只會錄到對方"));

        let mic = audio_source_item("microphone");
        assert_eq!(mic.level, "warn");
        assert!(mic.label.contains("只會錄到你自己"));

        // 空字串／沒看過的值也要黃——「不認得」不可以靜靜放行。
        assert_eq!(audio_source_item("").level, "warn");
        assert_eq!(audio_source_item("nonsense").level, "warn");
    }

    /// 預設值就是兩路。**這條測試釘的是「預設兩路」這個決定本身**：
    /// 預設值被誰改回單路都不會有錯誤訊息，只會下一場又少一軌。
    #[test]
    fn default_settings_record_both_streams() {
        let d = crate::settings::Settings::default();
        assert_eq!(d.audio_source, "both");
    }

    /// 可以寫的資料夾＝全綠，而且**探針檔不可以留下來**：
    /// 每按一次開始就多一個 `.write-test`，那是我們自己製造的垃圾。
    #[test]
    fn writable_dir_passes_and_leaves_nothing_behind() {
        let root = std::env::temp_dir().join(format!(
            "mt-precheck-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let dir = root.to_string_lossy().to_string();
        let items = run_checks(&dir, "both");
        assert_eq!(
            items.iter().find(|i| i.key == "writable").unwrap().level,
            "ok"
        );
        assert!(!root.join(".write-test").exists(), "探針檔沒收乾淨");
        std::fs::remove_dir_all(&root).ok();
    }

    /// A-8：告知那一項只在「還沒確認過」時存在。
    ///
    /// 確認過之後它必須**整項消失**，不是變成綠的——留一項永遠綠的在清單上，
    /// 會讓全綠的那一場也彈框（`needsAsking` 看的是有沒有非 ok 的項目），
    /// 於是每一場都彈，於是兩個星期後沒有人在讀這個框。
    #[test]
    fn consent_item_appears_once_and_then_never_again() {
        let first = consent_item(false).expect("第一次一定要有這一項");
        assert_eq!(first.key, "consent");
        // `warn` 不是隨便挑的：`fail` 會把體檢框的標題變成「這場會白錄」。
        assert_eq!(first.level, "warn");
        assert!(first.detail.contains("告訴他們"));

        assert!(consent_item(true).is_none(), "確認過之後這一項要整個不見");
    }
}
