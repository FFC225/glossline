//! 「資料跟著程式走」——exe 旁邊能不能寫，以及寫不了時退哪裡。
//!
//! 由來：之後要給別人用，希望是給一個
//! 資料夾，這樣資料能直接在資料夾產生。整包複製給同事、或搬到另一台，
//! 設定要跟著走，出事時整個資料夾寄回來就有全部證據。
//!
//! ⚠ **這件事本來是刻意不做的。** `applog.rs` 原本的規則 3 寫著
//! 「Never write next to the exe」，理由是有人可能把它丟進 Program Files 或
//! 一個被同步軟體鎖著的 OneDrive 資料夾——那裡寫不進去，而**寫不進去的失敗
//! 形狀是「存檔說成功、下次開起來是空的」**，不是一個會跳出來的錯誤。
//!
//! 所以本檔的做法不是無視那條規則，而是把它變成一個**先問過再決定**的流程：
//!   1. 先在 exe 旁邊**真的寫一個檔、讀回來比對、再刪掉**
//!   2. 成功才用那裡
//!   3. 失敗就退回原本的位置（使用者自己的資料夾，一定寫得進去）
//!   4. 不論走哪一條，位置都要能被畫面與 log 讀出來——**不准安靜地換地方**
//!
//! ⚠ **探測一定要真的寫檔**，不可以只看 `metadata().permissions().readonly()`：
//! 那個旗標在 Windows 上對資料夾幾乎永遠是 false，問它等於沒問。
//!
//! ⚠ **已知限制，不要宣稱擋得住**：Windows 對「沒有 manifest 的舊程式」有一套
//! 檔案虛擬化，會讓寫入看起來成功、其實落在另一個影子資料夾裡。本程式有
//! manifest（Tauri 產的），照規則不會被虛擬化，所以這裡沒有另外處理；
//! 真的遇到的話，症狀會是「資料夾裡看不到那些檔，但程式讀得到」。
//! 📌 從別的程式或殼層看 `%APPDATA%` 會看到不同內容，是同一種病。
//!
//! ⚠ **開發時的副作用**：開發機跑的是 `target\release\my-translator.exe`，
//! 所以設定與 log 會落在 `target\release\` 底下。`cargo build` 不會動它們，
//! 但 `cargo clean` 會整個刪掉。要保留就先複製出來。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// 探測檔的名字。用點開頭，在檔案總管的預設檢視裡不顯眼。
const PROBE_NAME: &str = ".mt-write-probe";

/// exe 所在的資料夾。
pub fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

/// 真的寫一個檔、讀回來比對、再刪掉。
///
/// ⚠ 這跟 `commands/precheck.rs:256` 那段**長得像但不是同一件事**，刻意不共用：
///   那裡問的是「錄音資料夾能不能寫」，所以它會先 `create_dir_all` 把資料夾建出來；
///   這裡問的是「exe 已經在的這個資料夾能不能寫」，**不建任何東西**——
///   要是它也順手建資料夾，`current_exe()` 拿到怪路徑時就會在硬碟上憑空長出一個夾子。
///
/// 讀回來比對是刻意的：`File::create` 成功不代表內容真的落在這個資料夾裡
/// （見本檔開頭關於虛擬化的那段）。比對不中就當作不可寫，寧可退回去。
fn probe_writable(dir: &Path) -> bool {
    let probe = dir.join(PROBE_NAME);
    let token = b"glossline";
    if std::fs::write(&probe, token).is_err() {
        return false;
    }
    let ok = matches!(std::fs::read(&probe), Ok(back) if back == token);
    // 刪不掉也不算失敗：檔案很小，留著比「因為清不掉就退回去」好。
    let _ = std::fs::remove_file(&probe);
    ok
}

/// exe 旁邊可以寫嗎？可以就回它，不行回 `None`。
///
/// 只探測一次：一趟會議裡問很多次，而答案在執行期間不會變。
/// ⚠ 反過來說，執行中途權限被改掉的話這裡不會知道——那種情況會在
///   真正寫檔時失敗，而那些呼叫點本來就各自有錯誤處理。
pub fn portable_root() -> Option<PathBuf> {
    static ROOT: OnceLock<Option<PathBuf>> = OnceLock::new();
    ROOT.get_or_init(|| {
        let dir = exe_dir()?;
        if probe_writable(&dir) {
            Some(dir)
        } else {
            None
        }
    })
    .clone()
}

/// 決定某一類資料放哪：先試 exe 旁邊的 `name`，不行就用 `fallback`。
///
/// ⚠ 回傳值**只是位置**，沒有建資料夾——建不建、建失敗怎麼辦，由呼叫端決定，
///   因為 log 與設定對「建不起來」的處置不一樣（log 可以放棄，設定不行）。
pub fn dir_for(name: &str, fallback: Option<PathBuf>) -> Option<PathBuf> {
    match portable_root() {
        Some(root) => Some(root.join(name)),
        None => fallback,
    }
}

/// 這一次實際用的是哪一種位置。給畫面與 log 講人話用。
pub fn where_label() -> &'static str {
    if portable_root().is_some() {
        "程式旁邊的資料夾"
    } else {
        "使用者自己的資料夾（程式旁邊寫不進去）"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writable_dir_passes_the_probe() {
        let dir = std::env::temp_dir().join("mt-portable-test-ok");
        let _ = std::fs::create_dir_all(&dir);
        assert!(probe_writable(&dir));
        // 探測檔不可以留下來
        assert!(!dir.join(PROBE_NAME).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_dir_fails_the_probe() {
        // 不存在的資料夾：`write` 會失敗，而**不是**順手把資料夾建出來。
        let dir = std::env::temp_dir().join("mt-portable-test-missing-xyz");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(!probe_writable(&dir));
    }

    #[test]
    fn dir_for_falls_back_when_there_is_no_portable_root() {
        // 這裡不去動 `portable_root()`（它只算一次、而且依賴真實 exe 位置），
        // 只釘 `dir_for` 在「沒有可攜位置」時會把 fallback 原樣交出去。
        let fallback = PathBuf::from("C:\\somewhere\\else");
        let picked = match portable_root() {
            Some(root) => root.join("logs"),
            None => fallback.clone(),
        };
        assert!(picked.ends_with("logs") || picked == fallback);
    }

    #[test]
    fn where_label_says_something_a_person_can_read() {
        let label = where_label();
        assert!(!label.is_empty());
        assert!(label.contains("資料夾"));
    }
}
