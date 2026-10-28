// Session-aware transcript persistence (.md + .json sidecar pairs).
//
// File pair: session-{YYMMDD-HHMM}.md (human-readable) + .json (structured).
// Writes are atomic: write to {path}.tmp then rename, so a crash mid-write
// never corrupts an existing file.
//
// Legacy `.md`-only files from the old `save_transcript` command are still
// listed (with `has_legacy_only: true`) but not editable.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

// ─── Types ───────────────────────────────────────────────────────────────

/// One utterance as it is archived.
///
/// Every field added past `ts`/`src`/`tgt` is an `Option` AND carries
/// `#[serde(default)]`, so that sessions written before this struct grew still
/// parse. ⚠ Those are two independent mechanisms and **either one alone is
/// enough** (measured: dropping the attribute from `t_ms` changed
/// nothing, because serde already treats an `Option` field as not required).
/// So the legacy-parse test below only goes red when both are gone -- passing
/// it is not evidence that a given field is still safe.
/// The stake: a `SessionData` that fails to parse is a silent `continue` inside
/// `list_sessions`, i.e. the old session just stops appearing in the library
/// with no error anywhere.
///
/// `tgt` is `Option` because "no translation" is a legal state, not a failure:
/// when the speaker is already talking the target language Soniox sends zero
/// translation tokens (measured on real Soniox packets).
/// The old frontend treated missing translation as "nothing to save" and lost
/// 8 out of 8 Chinese sentences without a word.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Segment {
    pub ts: String, // "HH:MM:SS" wall clock
    pub src: String,
    #[serde(default)]
    pub tgt: Option<String>,
    /// Milliseconds since the session started, taken from the frontend's wall
    /// clock. This -- not `start_ms` -- is what SRT timing is built from; see
    /// `export_session_srt`.
    #[serde(default)]
    pub t_ms: Option<u64>,
    /// Which stream: "system" (what the speakers played) or "mic".
    #[serde(default)]
    pub who: Option<String>,
    /// Soniox speaker label. Stored, never used for grouping.
    #[serde(default)]
    pub spk: Option<String>,
    /// Detected source language of `src`.
    #[serde(default)]
    pub from: Option<String>,
    /// The translation exactly as Soniox sent it (Simplified). `tgt` is the
    /// Traditional-Chinese conversion; keeping the raw form is the way back
    /// when a one-to-many conversion picks the wrong character.
    #[serde(default)]
    pub raw: Option<String>,
    /// Soniox stream-relative timestamps. ⚠ Each stream starts its own clock at
    /// 0 and a reconnect resets it, so these are for tracing back to the
    /// packet capture only -- never for ordering a session.
    #[serde(default)]
    pub start_ms: Option<u64>,
    #[serde(default)]
    pub end_ms: Option<u64>,
}

impl Segment {
    /// The readable line when only one is wanted: the library list, and the
    /// single-line fallback in `cue_text` / `txt_line`.
    ///
    /// Falls back to the original text when there is no translation: those
    /// segments are the ones already spoken in the target language, so the
    /// original *is* the readable line. Emitting "" instead would drop exactly
    /// the sentences the old frontend already dropped once.
    fn display_text(&self) -> &str {
        match self.tgt.as_deref() {
            Some(t) if !t.trim().is_empty() => t,
            _ => &self.src,
        }
    }

    /// The translation, or `None` when there isn't one worth printing --
    /// including the case where Soniox echoed the original back.
    fn translation(&self) -> Option<&str> {
        match self.tgt.as_deref() {
            Some(t) if !t.trim().is_empty() && t.trim() != self.src.trim() => Some(t),
            _ => None,
        }
    }

    /// Who said it, for a human reading the export. `who` is absent in sessions
    /// written before the two-stream rewrite, and an empty label there is
    /// honest: those files really do not know which side spoke.
    fn who_label(&self) -> &str {
        match self.who.as_deref() {
            Some("system") => "電腦聲音",
            Some("mic") => "麥克風",
            _ => "",
        }
    }

    /// One line of the TXT export: `[時間] 誰 ｜ 原文 ｜ 中文`.
    ///
    /// ⚠ The third column says `＝原文` rather than repeating the sentence:
    /// this is the "already spoken in the target language" case, and printing
    /// the same words twice reads like the translator broke.
    fn txt_line(&self) -> String {
        let who = self.who_label();
        let head = if who.is_empty() {
            format!("[{}]", self.ts)
        } else {
            format!("[{}] {}", self.ts, who)
        };
        let tgt = match self.translation() {
            Some(t) => t.trim().to_string(),
            None => "＝原文".to_string(),
        };
        format!("{} ｜ {} ｜ {}", head, self.src.trim(), tgt)
    }

    /// The body of one SRT cue: who said it, then the original, then the
    /// translation underneath -- the standard bilingual-subtitle shape.
    ///
    /// ⚠ The speaker tag is not decoration. Two cues WILL be on screen at the
    /// same time whenever the two sides talk over each other: that is real
    /// meeting behaviour, not an artefact, and it survives any timing rule we
    /// pick. Without the tag those overlapping lines
    /// are unattributable. Same labels as the TXT export, from one place, so
    /// the two exports can never drift apart.
    ///
    /// Sessions written before the two-stream rewrite have no `who`; they get
    /// no tag rather than a guessed one.
    fn cue_text(&self) -> String {
        let tag = match self.who_label() {
            "" => String::new(),
            label => format!("【{}】", label),
        };
        match self.translation() {
            Some(t) => format!("{}{}\n{}", tag, self.src.trim(), t.trim()),
            None => format!("{}{}", tag, self.display_text().trim()),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Chunk {
    pub started_at: String,       // ISO8601
    pub ended_at: Option<String>, // None until chunk closes
    pub segments: Vec<Segment>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SessionData {
    pub id: String,
    pub created_at: String,
    pub ended_at: Option<String>,
    pub title: String,
    pub engine: String,
    pub source_lang: String,
    pub target_lang: String,
    pub duration_sec: u64,
    pub chunks: Vec<Chunk>,
}

#[derive(Serialize, Debug)]
pub struct SessionListItem {
    pub id: String,
    pub title: String,
    pub engine: String,
    pub source_lang: String,
    pub target_lang: String,
    pub created_at: String,
    pub ended_at: Option<String>,
    pub duration_sec: u64,
    pub chunk_count: usize,
    pub segment_count: usize,
    pub has_legacy_only: bool,
}

#[derive(Serialize, Debug)]
pub struct SessionReadResult {
    pub md: String,
    pub json: SessionData,
}

// ─── Path helpers ────────────────────────────────────────────────────────

fn sessions_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?
        .join("transcripts");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create dir: {}", e))?;
    Ok(dir)
}

/// 改名 glossline 之前，記錄庫放在這裡（舊 identifier 底下）。
fn legacy_sessions_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("com.personal.translator").join("transcripts"))
}

/// 搬過哪些檔的帳本，放在新記錄庫裡。
const MIGRATED_LEDGER: &str = ".migrated-from-legacy.txt";

/// 改 identifier 之後，把舊記錄庫的檔**逐檔複製**過來。每次啟動都跑。
///
/// 三條刻意的規矩：
///   1. **複製，不是移動**：舊的永遠在原地，搬壞了還有退路。
///   2. **逐檔、每次啟動都補**，不是「新位置空的才搬一次」：搬到一半中斷的話，
///      一次性的做法會把半滿當成搬完、剩下的永遠看不到；舊版 exe 還在用的那段期間
///      新開的場次也一樣。
///   3. **帳本記搬過的檔名**：在新版刪掉的那一場，下次啟動不可以從舊的那份復活。
///      帳本每搬一檔就寫一行，中斷時已搬的不會重來、沒搬的下次補。
///
/// 回傳（這次搬了幾檔, 失敗的訊息）。失敗不擋啟動，但要出聲。
pub fn copy_missing_sessions(legacy: &Path, target: &Path) -> (usize, Vec<String>) {
    let mut errors = Vec::new();
    let entries = match fs::read_dir(legacy) {
        Ok(e) => e,
        Err(_) => return (0, errors), // 沒有舊記錄庫＝第一次用這支程式
    };
    if let Err(e) = fs::create_dir_all(target) {
        errors.push(format!("建不出 {}：{}", target.display(), e));
        return (0, errors);
    }
    let ledger_path = target.join(MIGRATED_LEDGER);
    let done: std::collections::HashSet<String> = fs::read_to_string(&ledger_path)
        .unwrap_or_default()
        .lines()
        .map(|l| l.to_string())
        .collect();
    let mut copied = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".tmp") || done.contains(&name) {
            continue;
        }
        let dest = target.join(&name);
        if !dest.exists() {
            if let Err(e) = fs::copy(&path, &dest) {
                errors.push(format!("{} -> {}：{}", path.display(), dest.display(), e));
                continue;
            }
            copied += 1;
        }
        let ledger = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&ledger_path)
            .and_then(|mut f| writeln!(f, "{}", name));
        if let Err(e) = ledger {
            errors.push(format!("帳本寫不進去 {}：{}", ledger_path.display(), e));
        }
    }
    (copied, errors)
}

/// 啟動時叫一次（`lib.rs` 的 setup）。
pub fn migrate_legacy_sessions(app: &AppHandle) {
    let (Some(legacy), Ok(target)) = (legacy_sessions_dir(), sessions_dir(app)) else {
        return;
    };
    if legacy == target {
        return;
    }
    let (copied, errors) = copy_missing_sessions(&legacy, &target);
    if copied > 0 {
        eprintln!(
            "[session_store] 舊記錄庫補搬 {} 檔：{} -> {}（舊的沒有刪）",
            copied,
            legacy.display(),
            target.display()
        );
    }
    for e in errors {
        eprintln!("[session_store] ⚠ 舊記錄庫有檔搬不過來：{}", e);
    }
}

fn session_paths(dir: &Path, id: &str) -> (PathBuf, PathBuf) {
    let base = format!("session-{}", id);
    (
        dir.join(format!("{}.md", base)),
        dir.join(format!("{}.json", base)),
    )
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 {
        return Err("Invalid session id length".into());
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid session id characters".into());
    }
    Ok(())
}

fn sanitize_title(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .take(200)
        .collect()
}

/// 人打的會議名字 → 可以接在資料夾名後面的一段。
///
/// ⚠ 不能用在檔名的字是**換成空格、不是刪掉**：`Q3/Q4 檢討` 刪掉斜線會變成
/// `Q3Q4 檢討`，一個看起來像使用者自己打錯的名字——而他不會知道是程式改的。
///
/// ⚠ 結尾的句點與空白要砍：Windows 建不出以句點結尾的資料夾，而那個失敗
/// 回報的是「找不到指定的路徑」，看起來像磁碟出問題、不像名字有問題。
fn sanitize_folder_name(s: &str) -> String {
    let replaced: String = s
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                ' '
            } else {
                c
            }
        })
        .collect();

    // 連續空白收成一個。多打的空白本身無害，但它會讓「名字沒變」這件事
    // 判不出來（`會議  A` 與 `會議 A` 是兩個不同的資料夾名）。
    let mut out = String::new();
    let mut last_space = false;
    for c in replaced.trim().chars() {
        if c == ' ' {
            if !last_space {
                out.push(' ');
            }
            last_space = true;
        } else {
            out.push(c);
            last_space = false;
        }
    }

    // 40 個字元寫得下「Alice 週會 第三次」這種名字，又留得住路徑長度的餘裕：
    // 整條路徑超過上限時，**改名會成功、之後往裡面寫檔才失敗**。
    let clipped: String = out.chars().take(40).collect();
    clipped
        .trim_end_matches(|c: char| c == '.' || c == ' ')
        .to_string()
}

// ─── Atomic write ────────────────────────────────────────────────────────

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|s| s.to_str()).unwrap_or("")
    ));
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("Failed to create tmp: {}", e))?;
        f.write_all(bytes)
            .map_err(|e| format!("Write failed: {}", e))?;
        f.sync_all().map_err(|e| format!("fsync failed: {}", e))?;
    }
    fs::rename(&tmp, path).map_err(|e| format!("Rename failed: {}", e))?;
    Ok(())
}

// ─── Commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn save_session(
    app: AppHandle,
    id: String,
    md_content: String,
    json_data: SessionData,
) -> Result<(), String> {
    validate_id(&id)?;
    if json_data.id != id {
        return Err("id mismatch between argument and json_data".into());
    }
    let dir = sessions_dir(&app)?;
    let (md_path, json_path) = session_paths(&dir, &id);

    // Write JSON first (source of truth) then MD. If MD fails, JSON is still good.
    let json_bytes = serde_json::to_vec_pretty(&json_data)
        .map_err(|e| format!("JSON serialize failed: {}", e))?;
    write_atomic(&json_path, &json_bytes)?;
    write_atomic(&md_path, md_content.as_bytes())?;
    Ok(())
}

/// Write a SECOND copy of this meeting's transcript next to its
/// recordings, so one folder holds the whole meeting (them.wav + me.wav + 逐字稿.md).
///
/// Deliberately redundant: the library's own copy under app data stays the source of
/// truth and keeps working exactly as before. This copy is for the human who opens the
/// recording folder months later -- matching a transcript to a recording by timestamp
/// across two unrelated directories is the kind of chore nobody does.
///
/// Failing here must NOT be silent: the caller alerts. It is not fatal,
/// though -- the library copy is already saved by the time this runs.
#[tauri::command]
pub fn save_transcript_beside_recording(dir: String, md_content: String) -> Result<String, String> {
    write_beside_recording(dir, "逐字稿.md", md_content)
}

/// 這場按過的「⭐ 標記重點」存成錄音資料夾裡的 `重點標記.md`。
///
/// ⚠ 只寫錄音資料夾、**不寫記錄庫**：`list_sessions` 會把記錄庫裡任何 .md
///   當成一場「舊格式會議」列出來（見 Pass 2）。
/// ⚠ 內容不可有 `[時:分:秒] 【麥克風/電腦聲音】` 那種行——會後的
///   外部的會後處理腳本看格式認即時稿，找到兩份就報錯。
///   格式由前端 `marks.js` 負責。
#[tauri::command]
pub fn save_marks_beside_recording(dir: String, md_content: String) -> Result<String, String> {
    write_beside_recording(dir, "重點標記.md", md_content)
}

fn write_beside_recording(dir: String, name: &str, md_content: String) -> Result<String, String> {
    let dir = PathBuf::from(dir);
    if !dir.is_dir() {
        return Err(format!("錄音資料夾不存在：{}", dir.display()));
    }
    let path = dir.join(name);
    write_atomic(&path, md_content.as_bytes())?;
    Ok(path.to_string_lossy().into_owned())
}

/// 把「這場叫什麼」接到錄音資料夾名的後面。
///
/// 為什麼光改記錄庫的標題不夠：三個月後要找某一場的錄音，人是在檔案總管裡找的，
/// 而那裡只有 `YYYY-MM-DD_1430` 這種名字。記錄庫的標題住在 App 裡面，
/// 沒有人會為了找一個 wav 先去開 App。
///
/// 命名樣式：時間戳 `YYYY-MM-DD_1430` 由 `audio.rs` 建，
/// 名字放前或放後看設定 `folder_name_order`——預設 `名字-YYYY-MM-DD_1430`，
/// 切成 `date_first` 就是 `YYYY-MM-DD_1430-名字`。
///   - 事後整理工具找的是夾子裡的 `them.wav`／`me.wav`，夾子叫什麼它不管。
///
/// ⚠ 同一場改第二次名字要**取代**舊名字、不是一直往上疊。舊名字靠
///   `find_stamp` 認出時間戳那一段再丟掉其餘的。舊版 `meeting-…` 資料夾
///   認不出來、直接回 `Err`（舊的不用管）。
///
/// ⚠ 失敗一律回 `Err`，而且最常見的那種不是程式的錯：資料夾正開在
///   檔案總管裡，Windows 就會擋下改名。錯誤訊息要直接把解法講出來。
#[tauri::command]
pub fn rename_session_dir(
    dir: String,
    name: String,
    settings: tauri::State<'_, crate::settings::SettingsState>,
) -> Result<String, String> {
    let date_first = settings
        .0
        .lock()
        .map(|s| s.folder_name_order == "date_first")
        .unwrap_or(false);
    rename_session_dir_as(&dir, &name, date_first)
}

/// 找出資料夾名裡 `audio.rs` 建的那段時間戳（`YYYY-MM-DD_HHMM`，撞名時帶 `-N`）。
///
/// 名字可能放前也可能放後，而且設定可以中途切換，所以兩種都要認：
/// 開頭就是時間戳 → 用開頭那個；否則用**最後**一個（名字在前時它在尾巴，
/// 名字裡剛好也打了一串日期也不會被誤認）。
fn find_stamp(s: &str) -> Option<&str> {
    let b = s.as_bytes();
    let shape = b"0000-00-00_0000";
    // 前後都要是邊界（開頭／結尾／`-`）：舊版 `meeting-…_143000` 裡剛好藏著一段
    // `…_1430`，不擋的話會被當成新版、改名成功，零錯誤訊息。
    let at = |i: usize| {
        let end = i + shape.len();
        end <= b.len()
            && (i == 0 || b[i - 1] == b'-')
            && (end == b.len() || b[end] == b'-')
            && shape.iter().zip(&b[i..]).all(|(p, c)| {
                if *p == b'0' { c.is_ascii_digit() } else { c == p }
            })
    };
    let start = if at(0) {
        0
    } else {
        (0..b.len()).rev().find(|&i| at(i))?
    };
    let mut end = start + shape.len();
    // 撞名後綴 `-2`…`-99`：後面要緊接結尾或 `-`，否則那是名字的一部分
    // （`YYYY-MM-DD_1430-2027預算` 的 2027 不是後綴）。
    if b.get(end) == Some(&b'-') {
        let digits = b[end + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
        let after = end + 1 + digits;
        if (1..=2).contains(&digits) && (after == b.len() || b[after] == b'-') {
            end = after;
        }
    }
    Some(&s[start..end])
}

fn rename_session_dir_as(dir: &str, name: &str, date_first: bool) -> Result<String, String> {
    let from = PathBuf::from(dir.trim());
    if !from.is_dir() {
        return Err(format!("這場的錄音資料夾不在了：{}", from.display()));
    }
    let clean = sanitize_folder_name(name);
    if clean.is_empty() {
        return Err("這個名字拿掉不能用在檔名的字之後就空了，換一個。".into());
    }
    let parent = from
        .parent()
        .ok_or_else(|| "找不到錄音資料夾的上一層".to_string())?
        .to_path_buf();
    let current = from
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "資料夾名稱讀不出來".to_string())?;
    let stem = find_stamp(current).ok_or_else(|| {
        format!(
            "認不出這個資料夾的時間（{}），它可能是舊版建的，請直接在檔案總管改名。",
            current
        )
    })?;
    let join = |extra: &str| {
        if date_first {
            format!("{}-{}{}", stem, clean, extra)
        } else {
            format!("{}-{}{}", clean, stem, extra)
        }
    };

    let want = parent.join(join(""));
    // 同一個名字按第二次：什麼都不用做，但也不算失敗——回現在的路徑就好。
    if want == from {
        return Ok(from.to_string_lossy().into_owned());
    }
    let mut target = want;
    let mut n = 2;
    while target.exists() && n <= 99 {
        target = parent.join(join(&format!("-{}", n)));
        n += 1;
    }
    if target.exists() {
        return Err("同名的資料夾已經有 99 個了，換個名字。".into());
    }

    fs::rename(&from, &target).map_err(|e| {
        format!(
            "資料夾改名失敗（{}）。如果它正開在檔案總管裡，關掉那個視窗再按一次。",
            e
        )
    })?;
    eprintln!(
        "[session] recording folder renamed: {:?} -> {:?}",
        from, target
    );
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn list_sessions(app: AppHandle) -> Result<Vec<SessionListItem>, String> {
    let dir = sessions_dir(&app)?;
    let mut items: Vec<SessionListItem> = Vec::new();
    let mut seen_new_ids: std::collections::HashSet<String> = Default::default();

    let entries = fs::read_dir(&dir).map_err(|e| format!("Read dir failed: {}", e))?;
    let entries: Vec<_> = entries.filter_map(|e| e.ok()).collect();

    // Pass 1: parse all .json sidecars
    for entry in &entries {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(stem) = name.strip_suffix(".json") else {
            continue;
        };
        let Some(id) = stem.strip_prefix("session-") else {
            continue;
        };
        let path = entry.path();
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(data) = serde_json::from_str::<SessionData>(&content) else {
            continue;
        };
        let segment_count: usize = data.chunks.iter().map(|c| c.segments.len()).sum();
        seen_new_ids.insert(id.to_string());
        items.push(SessionListItem {
            id: data.id,
            title: data.title,
            engine: data.engine,
            source_lang: data.source_lang,
            target_lang: data.target_lang,
            created_at: data.created_at,
            ended_at: data.ended_at,
            duration_sec: data.duration_sec,
            chunk_count: data.chunks.len(),
            segment_count,
            has_legacy_only: false,
        });
    }

    // Pass 2: legacy .md-only files (old save_transcript output, no sidecar)
    for entry in &entries {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(stem) = name.strip_suffix(".md") else {
            continue;
        };
        // Skip new format files we already counted in pass 1
        if let Some(id) = stem.strip_prefix("session-") {
            if seen_new_ids.contains(id) {
                continue;
            }
        }
        // Legacy filename pattern: YYYY-MM-DD_10-21-05.md
        let created_at = stem.replace('_', " ");
        items.push(SessionListItem {
            id: stem.to_string(),
            title: stem.to_string(),
            engine: "legacy".into(),
            source_lang: String::new(),
            target_lang: String::new(),
            created_at,
            ended_at: None,
            duration_sec: 0,
            chunk_count: 0,
            segment_count: 0,
            has_legacy_only: true,
        });
    }

    // Newest first
    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(items)
}

#[tauri::command]
pub fn read_session(app: AppHandle, id: String) -> Result<SessionReadResult, String> {
    validate_id(&id)?;
    let dir = sessions_dir(&app)?;
    let (md_path, json_path) = session_paths(&dir, &id);
    let md = fs::read_to_string(&md_path).map_err(|e| format!("Read md failed: {}", e))?;
    let json_str =
        fs::read_to_string(&json_path).map_err(|e| format!("Read json failed: {}", e))?;
    let json: SessionData =
        serde_json::from_str(&json_str).map_err(|e| format!("Parse json failed: {}", e))?;
    Ok(SessionReadResult { md, json })
}

#[tauri::command]
pub fn read_legacy_session(app: AppHandle, id: String) -> Result<String, String> {
    // Legacy files: id is the filename stem (e.g. "YYYY-MM-DD_10-21-05").
    // Allow ':' and '.' since old filenames may include them (none should, but be safe).
    if id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err("Invalid id".into());
    }
    let dir = sessions_dir(&app)?;
    let path = dir.join(format!("{}.md", id));
    fs::read_to_string(&path).map_err(|e| format!("Read failed: {}", e))
}

#[tauri::command]
pub fn delete_session(app: AppHandle, id: String) -> Result<(), String> {
    validate_id(&id)?;
    let dir = sessions_dir(&app)?;
    // New format: session-{id}.{md,json}
    let (md_path, json_path) = session_paths(&dir, &id);
    let _ = fs::remove_file(&json_path);
    let _ = fs::remove_file(&md_path);
    // Legacy format: {id}.md (no session- prefix, no sidecar)
    let _ = fs::remove_file(dir.join(format!("{}.md", id)));
    Ok(())
}

#[tauri::command]
pub fn update_session_title(app: AppHandle, id: String, title: String) -> Result<(), String> {
    validate_id(&id)?;
    let title = sanitize_title(&title);
    let dir = sessions_dir(&app)?;
    let (md_path, json_path) = session_paths(&dir, &id);
    let json_str = fs::read_to_string(&json_path).map_err(|e| format!("Read failed: {}", e))?;
    let mut data: SessionData =
        serde_json::from_str(&json_str).map_err(|e| format!("Parse failed: {}", e))?;
    data.title = title.clone();
    let json_bytes =
        serde_json::to_vec_pretty(&data).map_err(|e| format!("Serialize failed: {}", e))?;
    write_atomic(&json_path, &json_bytes)?;

    // Re-render markdown header: replace first "# ..." line, leave body alone
    let md = fs::read_to_string(&md_path).unwrap_or_default();
    let new_md = if let Some(eol) = md.find('\n') {
        format!("# {}\n{}", title, &md[eol + 1..])
    } else {
        format!("# {}\n", title)
    };
    write_atomic(&md_path, new_md.as_bytes())?;
    Ok(())
}

#[tauri::command]
pub fn export_session_srt(app: AppHandle, id: String) -> Result<String, String> {
    validate_id(&id)?;
    let dir = sessions_dir(&app)?;
    let (_, json_path) = session_paths(&dir, &id);
    let json_str = fs::read_to_string(&json_path).map_err(|e| format!("Read failed: {}", e))?;
    let data: SessionData =
        serde_json::from_str(&json_str).map_err(|e| format!("Parse failed: {}", e))?;

    let mut out = String::new();
    let mut idx: u32 = 1;
    let mut flat: Vec<&Segment> = data.chunks.iter().flat_map(|c| c.segments.iter()).collect();

    // Sub-second timing is only possible when every segment carries `t_ms`
    // (sessions recorded by the v2 frontend). One legacy segment in the file and
    // the whole export drops back to the second-resolution wall clock -- mixing
    // the two would silently place the legacy lines at second 0.
    let precise = !flat.is_empty() && flat.iter().all(|s| s.t_ms.is_some());

    if precise {
        flat.sort_by_key(|s| s.t_ms.unwrap_or(0));
        for (i, seg) in flat.iter().enumerate() {
            let start = seg.t_ms.unwrap_or(0);
            let end = cue_end_ms(start, flat.get(i + 1).and_then(|s| s.t_ms));
            out.push_str(&format!(
                "{}\n{} --> {}\n{}\n\n",
                idx,
                srt_time(start),
                srt_time(end),
                seg.cue_text()
            ));
            idx += 1;
        }
        return Ok(out);
    }

    flat.sort_by(|a, b| a.ts.cmp(&b.ts));
    for (i, seg) in flat.iter().enumerate() {
        let start = seg.ts.clone();
        // Same floor and ceiling as the precise branch, at the only resolution
        // these files have: whole seconds. Two segments inside the same second
        // would otherwise produce a zero-length cue.
        let floor = add_seconds_hms(&seg.ts, 2);
        let ceiling = add_seconds_hms(&seg.ts, 8);
        let end = match flat.get(i + 1) {
            Some(next) if next.ts > ceiling => ceiling,
            Some(next) if next.ts > floor => next.ts.clone(),
            _ => floor,
        };
        out.push_str(&format!(
            "{}\n{},000 --> {},000\n{}\n\n",
            idx,
            start,
            end,
            seg.cue_text()
        ));
        idx += 1;
    }
    Ok(out)
}

#[tauri::command]
pub fn export_session_txt(app: AppHandle, id: String) -> Result<String, String> {
    validate_id(&id)?;
    let dir = sessions_dir(&app)?;
    let (_, json_path) = session_paths(&dir, &id);
    let json_str = fs::read_to_string(&json_path).map_err(|e| format!("Read failed: {}", e))?;
    let data: SessionData =
        serde_json::from_str(&json_str).map_err(|e| format!("Parse failed: {}", e))?;
    let lines: Vec<String> = data
        .chunks
        .iter()
        .flat_map(|c| c.segments.iter())
        .map(|s| s.txt_line())
        .collect();
    Ok(lines.join("\n"))
}

/// Write an export straight to a path the user picked.
///
/// The two commands above hand the text back to the frontend, which then has
/// nowhere to put it: this fork has no fs plugin, and the upstream trick
/// (`Blob` + `<a download>`) has never been shown to actually save a file in
/// WebView2. So the bytes are written here instead, to the path the OS save
/// dialog returned.
///
/// `path` always comes from that dialog, never from session content. Written as
/// plain UTF-8 with **no BOM**: a BOM is what Excel wants for CSV, but subtitle
/// players and the downstream transcript tool read these as plain text, and a
/// leading invisible character there shows up inside the first cue.
#[tauri::command]
pub fn export_session_file(
    app: AppHandle,
    id: String,
    format: String,
    path: String,
) -> Result<String, String> {
    let body = match format.as_str() {
        "srt" => export_session_srt(app, id)?,
        "txt" => export_session_txt(app, id)?,
        other => return Err(format!("Unknown export format: {}", other)),
    };
    fs::write(&path, body.as_bytes()).map_err(|e| format!("Write failed: {}", e))?;
    Ok(path)
}

#[tauri::command]
pub fn search_sessions(app: AppHandle, query: String) -> Result<Vec<SessionListItem>, String> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return list_sessions(app);
    }
    let all = list_sessions(app.clone())?;
    let dir = sessions_dir(&app)?;
    let mut hits: Vec<SessionListItem> = Vec::new();
    for item in all {
        if item.has_legacy_only {
            // Match against title + raw md content
            let path = dir.join(format!("{}.md", item.id));
            if let Ok(body) = fs::read_to_string(&path) {
                if body.to_lowercase().contains(&q) || item.title.to_lowercase().contains(&q) {
                    hits.push(item);
                }
            }
            continue;
        }
        if item.title.to_lowercase().contains(&q) {
            hits.push(item);
            continue;
        }
        let (_, json_path) = session_paths(&dir, &item.id);
        let Ok(json_str) = fs::read_to_string(&json_path) else {
            continue;
        };
        if json_str.to_lowercase().contains(&q) {
            hits.push(item);
        }
    }
    Ok(hits)
}

// Milliseconds → "HH:MM:SS,mmm" (SRT wants a comma, not a dot).
/// A cue this short flashes past unread; 1.2 s is the low end of what
/// subtitle guides call readable. Enforcing it can make a cue overlap the next
/// one -- that is the lesser evil, and every player handles it.
const MIN_CUE_MS: u64 = 1_200;

/// Without a ceiling, one quiet stretch leaves the previous sentence parked on
/// screen for the whole silence: the end of a cue is the START of the next one,
/// so a two-minute pause is a two-minute subtitle. Nothing errors, it just sits
/// there looking like the app froze.
const MAX_CUE_MS: u64 = 8_000;

/// When one cue ends, given when the next one starts (`None` = last cue).
///
/// ⚠ Pure on purpose: the two failure modes here (invisible flash, subtitle
/// parked through a silence) are only visible in a player, so this is the one
/// piece a test can actually hold on to.
fn cue_end_ms(start: u64, next_start: Option<u64>) -> u64 {
    let natural = match next_start {
        // `>=`, not `>`: two segments can share a millisecond (the two streams
        // emit independently). That is still "the next cue starts here", so the
        // duration collapses to 0 and the floor below takes over.
        Some(n) if n >= start => n - start,
        // Last cue: nothing follows it, so pick a plain readable length.
        _ => 3_000,
    };
    start + natural.clamp(MIN_CUE_MS, MAX_CUE_MS)
}

fn srt_time(ms: u64) -> String {
    let h = ms / 3_600_000;
    let m = (ms % 3_600_000) / 60_000;
    let s = (ms % 60_000) / 1000;
    let milli = ms % 1000;
    format!("{:02}:{:02}:{:02},{:03}", h, m, s, milli)
}

// "HH:MM:SS" + N seconds → new "HH:MM:SS" (saturating at 99:59:59)
fn add_seconds_hms(ts: &str, add: u64) -> String {
    let parts: Vec<u64> = ts.split(':').filter_map(|p| p.parse().ok()).collect();
    if parts.len() != 3 {
        return ts.to_string();
    }
    let total = parts[0] * 3600 + parts[1] * 60 + parts[2] + add;
    let h = (total / 3600).min(99);
    let m = (total % 3600) / 60;
    let s = total % 60;
    format!("{:02}:{:02}:{:02}", h, m, s)
}

// ─── Tests ───────────────────────────────────────────────────────────────
//
// These cover exactly the two places where a change here
// loses data without saying anything: a segment whose `tgt` is null (the
// speaker was already talking the target language) and the millisecond SRT
// timeline. Run with `cargo test -p glossline`.

#[cfg(test)]
mod tests {
    use super::*;

    /// 改名搬家：補搬、不重複、刪掉的不復活、舊版後來新開的場次照樣補得到。
    #[test]
    fn legacy_sessions_copy_missing_without_resurrecting_deleted_ones() {
        let root = std::env::temp_dir().join(format!(
            "mt-migrate-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let legacy = root.join("old");
        let target = root.join("new");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("session-a.json"), "a").unwrap();
        fs::write(legacy.join("session-a.md"), "a").unwrap();
        fs::write(legacy.join("x.md.tmp"), "half").unwrap();

        let (n, err) = copy_missing_sessions(&legacy, &target);
        assert_eq!((n, err.len()), (2, 0));
        assert!(!target.join("x.md.tmp").exists(), "暫存檔不該搬");

        // 再跑一次：什麼都不搬
        assert_eq!(copy_missing_sessions(&legacy, &target).0, 0);

        // 在新版刪掉一場：不可以復活
        fs::remove_file(target.join("session-a.md")).unwrap();
        assert_eq!(copy_missing_sessions(&legacy, &target).0, 0);
        assert!(!target.join("session-a.md").exists(), "刪掉的那一場復活了");

        // 舊版後來又開了一場：要補得到
        fs::write(legacy.join("session-b.json"), "b").unwrap();
        assert_eq!(copy_missing_sessions(&legacy, &target).0, 1);
        assert_eq!(fs::read_to_string(target.join("session-b.json")).unwrap(), "b");

        // 舊的一個都沒少
        assert!(legacy.join("session-a.md").exists());
        fs::remove_dir_all(&root).ok();

        // 沒有舊記錄庫＝第一次用：安靜地什麼都不做
        assert_eq!(copy_missing_sessions(&root.join("nope"), &root.join("t")), (0, vec![]));
    }

    fn seg(ts: &str, src: &str, tgt: Option<&str>, t_ms: Option<u64>) -> Segment {
        Segment {
            ts: ts.into(),
            src: src.into(),
            tgt: tgt.map(|s| s.to_string()),
            t_ms,
            who: Some("system".into()),
            spk: None,
            from: None,
            raw: None,
            start_ms: None,
            end_ms: None,
        }
    }

    #[test]
    fn display_text_falls_back_to_source() {
        assert_eq!(seg("00:00:01", "hello", Some("哈囉"), None).display_text(), "哈囉");
        // No translation: the original IS the readable line, not an empty one.
        assert_eq!(seg("00:00:01", "我先講一下", None, None).display_text(), "我先講一下");
        // Whitespace-only translation counts as none.
        assert_eq!(seg("00:00:01", "我先講一下", Some("   "), None).display_text(), "我先講一下");
    }

    /// A segment from the microphone, so `who_label` has something to say.
    fn mic_seg(ts: &str, src: &str, tgt: Option<&str>) -> Segment {
        let mut s = seg(ts, src, tgt, None);
        s.who = Some("mic".into());
        s
    }

    #[test]
    fn cue_end_never_flashes_and_never_parks() {
        // Normal spacing: the cue simply runs until the next one starts.
        assert_eq!(cue_end_ms(1_000, Some(4_000)), 4_000);
        // 84 ms apart -- what the first real export produced. Held to 1.2 s,
        // which does overlap the next cue, and that is the intended trade.
        assert_eq!(cue_end_ms(27_485, Some(27_569)), 27_485 + MIN_CUE_MS);
        // Exactly at the floor stays put.
        assert_eq!(cue_end_ms(0, Some(MIN_CUE_MS)), MIN_CUE_MS);
        // A two-minute silence must not become a two-minute subtitle.
        assert_eq!(cue_end_ms(5_000, Some(125_000)), 5_000 + MAX_CUE_MS);
        // Last cue: readable default, inside the two bounds.
        assert_eq!(cue_end_ms(9_000, None), 12_000);
        // Out-of-order or duplicate timestamps must not underflow.
        assert_eq!(cue_end_ms(5_000, Some(5_000)), 5_000 + MIN_CUE_MS);
        // A next-start that runs backwards is treated as "no next cue" and gets
        // the plain default -- not a negative length. The list is sorted before
        // this is called, so reaching here means the data was already odd.
        assert_eq!(cue_end_ms(5_000, Some(1_000)), 5_000 + 3_000);
    }

    #[test]
    fn txt_line_has_four_columns() {
        assert_eq!(
            mic_seg("00:00:05", "hello there", Some("哈囉")).txt_line(),
            "[00:00:05] 麥克風 ｜ hello there ｜ 哈囉"
        );
        // Spoken in the target language already: say so, do not print the same
        // sentence twice -- repeating it reads like the translator broke.
        assert_eq!(
            mic_seg("00:00:06", "我先講一下", None).txt_line(),
            "[00:00:06] 麥克風 ｜ 我先講一下 ｜ ＝原文"
        );
        assert_eq!(
            seg("00:00:07", "hello", Some("哈囉"), None).txt_line(),
            "[00:00:07] 電腦聲音 ｜ hello ｜ 哈囉"
        );
    }

    #[test]
    fn txt_line_survives_a_session_that_predates_the_two_stream_rewrite() {
        // No `who`: an empty label is honest, and the line must not grow a
        // stray separator or a blank column that looks like data went missing.
        let old: Segment = serde_json::from_str(r#"{"ts":"00:00:05","src":"hi","tgt":"嗨"}"#).unwrap();
        assert_eq!(old.txt_line(), "[00:00:05] ｜ hi ｜ 嗨");
    }

    #[test]
    fn cue_text_is_bilingual_but_never_doubled() {
        assert_eq!(
            mic_seg("00:00:05", "hello", Some("哈囉")).cue_text(),
            "【麥克風】hello\n哈囉"
        );
        assert_eq!(
            seg("00:00:05", "hello", Some("哈囉"), None).cue_text(),
            "【電腦聲音】hello\n哈囉"
        );
        // No translation -> one line only, tag still there.
        assert_eq!(mic_seg("00:00:06", "我先講一下", None).cue_text(), "【麥克風】我先講一下");
        // Soniox sometimes echoes the original back as the "translation".
        // Two identical lines on screen is the visible symptom.
        assert_eq!(mic_seg("00:00:07", "OK", Some("OK")).cue_text(), "【麥克風】OK");
        assert_eq!(mic_seg("00:00:08", "OK", Some("  OK  ")).cue_text(), "【麥克風】OK");
        // A session from before the two-stream rewrite: no tag, not a guess.
        let old: Segment = serde_json::from_str(r#"{"ts":"00:00:05","src":"hi","tgt":"嗨"}"#).unwrap();
        assert_eq!(old.cue_text(), "hi\n嗨");
    }

    #[test]
    fn srt_time_formats_milliseconds() {
        assert_eq!(srt_time(0), "00:00:00,000");
        assert_eq!(srt_time(1_234), "00:00:01,234");
        assert_eq!(srt_time(3_661_007), "01:01:01,007");
    }

    #[test]
    fn old_sessions_still_parse_without_the_new_fields() {
        // A file written before this struct grew. ⚠ This only goes red when a
        // new field is BOTH non-Option AND without #[serde(default)] -- see the
        // note on `Segment`. It is a floor, not a guarantee.
        let old = r#"{"ts":"00:00:05","src":"hello","tgt":"哈囉"}"#;
        let parsed: Segment = serde_json::from_str(old).expect("legacy segment must still parse");
        assert_eq!(parsed.tgt.as_deref(), Some("哈囉"));
        assert!(parsed.t_ms.is_none() && parsed.who.is_none());
    }

    /// 逐字稿副本要真的落在那場的錄音資料夾裡，而且**寫不成要說**——
    /// 回 Ok 卻沒有檔案，是這種「額外的一份」最容易有的壞法。
    #[test]
    fn transcript_copy_lands_next_to_the_recordings() {
        let dir = std::env::temp_dir().join(format!(
            "mt-copy-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();

        let out = save_transcript_beside_recording(
            dir.to_string_lossy().to_string(),
            "# 這場\n\n[00:00:01] 【對方】hello\n→ 哈囉\n".into(),
        )
        .expect("寫得進去的資料夾不該失敗");
        let path = dir.join("逐字稿.md");
        assert_eq!(out, path.to_string_lossy());
        assert!(fs::read_to_string(&path).unwrap().contains("哈囉"));

        // 覆寫（同一場按兩次停止、或事後補存）要蓋掉舊的，不是追加
        save_transcript_beside_recording(dir.to_string_lossy().to_string(), "# 第二次".into())
            .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "# 第二次");
        // 暫存檔不可以留下來
        assert!(!dir.join("逐字稿.md.tmp").exists(), "暫存檔沒收乾淨");

        fs::remove_dir_all(&dir).ok();
    }

    /// 資料夾不存在時**不可以默默建一個**：那代表呼叫端給錯了路徑，
    /// 而默默建出來的空資料夾會讓人以為那場的錄音在裡面。
    #[test]
    fn transcript_copy_refuses_a_missing_folder() {
        let dir = std::env::temp_dir().join("mt-copy-does-not-exist-9c3f1a");
        let err = save_transcript_beside_recording(
            dir.to_string_lossy().to_string(),
            "# 這場".into(),
        )
        .unwrap_err();
        assert!(err.contains("不存在"), "錯誤訊息要講清楚，得到：{}", err);
        assert!(!dir.exists(), "不該順手建資料夾");
    }

    /// 重點標記是另一個檔，**不可以蓋到逐字稿副本**。
    #[test]
    fn marks_land_in_their_own_file() {
        let dir = std::env::temp_dir().join(format!(
            "mt-marks-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let d = dir.to_string_lossy().to_string();
        save_transcript_beside_recording(d.clone(), "# 逐字稿".into()).unwrap();
        let out = save_marks_beside_recording(d, "# 重點標記".into()).unwrap();
        assert_eq!(out, dir.join("重點標記.md").to_string_lossy());
        assert_eq!(fs::read_to_string(dir.join("逐字稿.md")).unwrap(), "# 逐字稿");
        assert_eq!(fs::read_to_string(dir.join("重點標記.md")).unwrap(), "# 重點標記");
        fs::remove_dir_all(&dir).ok();
    }

    // ── 會議命名（`rename_session_dir`）───────────────────────────────
    //
    // 這一組守的是三件「不會噴錯誤訊息」的事：名字被清成空的、改第二次名字時
    // 後綴一直往後疊、以及改完之後回報的路徑跟實際的資料夾不一致（那會讓
    // 「開啟資料夾」那顆鍵安靜地開錯地方——`logs.rs` 的檔頭寫過那個坑）。

    #[test]
    fn folder_name_replaces_illegal_chars_instead_of_deleting_them() {
        // 刪掉斜線會得到 `Q3Q4 檢討`，看起來像人自己打錯字。
        assert_eq!(sanitize_folder_name("Q3/Q4 檢討"), "Q3 Q4 檢討");
        assert_eq!(sanitize_folder_name(r#"a\b:c*d?e"f<g>h|i"#), "a b c d e f g h i");
        // 連續空白收成一個，頭尾砍掉。
        assert_eq!(sanitize_folder_name("  Alice   週會  "), "Alice 週會");
        // 結尾的句點 Windows 建不出來。
        assert_eq!(sanitize_folder_name("週會..."), "週會");
        // 清完是空的要看得出來，呼叫端才有話可說。
        assert_eq!(sanitize_folder_name("///"), "");
        assert_eq!(sanitize_folder_name("   "), "");
        // 過長要截斷，而且是按字元、不是按位元組（中文一個字三個位元組）。
        assert_eq!(sanitize_folder_name(&"會".repeat(60)).chars().count(), 40);
    }

    #[test]
    fn find_stamp_picks_the_folder_timestamp_in_either_position() {
        assert_eq!(find_stamp("2026-09-12_1430"), Some("2026-09-12_1430"));
        assert_eq!(find_stamp("2026-09-12_1430-2"), Some("2026-09-12_1430-2"));
        assert_eq!(find_stamp("2026-09-12_1430-Alice 週會"), Some("2026-09-12_1430"));
        assert_eq!(find_stamp("2026-09-12_1430-2-Alice"), Some("2026-09-12_1430-2"));
        assert_eq!(find_stamp("Alice 週會-2026-09-12_1430"), Some("2026-09-12_1430"));
        assert_eq!(find_stamp("Alice 週會-2026-09-12_1430-2"), Some("2026-09-12_1430-2"));
        // 名字開頭的數字不是撞名後綴。
        assert_eq!(find_stamp("2026-09-12_1430-2027預算"), Some("2026-09-12_1430"));
        // 名字在前、名字裡也打了日期：用尾巴那個。
        assert_eq!(
            find_stamp("回顧 2025-01-01_0900-2026-09-12_1430"),
            Some("2026-09-12_1430")
        );
        // 舊版資料夾認不出來。
        assert_eq!(find_stamp("meeting-2026-09-12_143000 Alice"), None);
        assert_eq!(find_stamp("隨便一個資料夾"), None);
    }

    fn leaf(p: &str) -> String {
        PathBuf::from(p).file_name().unwrap().to_string_lossy().into_owned()
    }

    #[test]
    fn rename_puts_the_name_first_by_default_and_does_not_stack() {
        let root = std::env::temp_dir().join("mt-rename-7b2e9d");
        fs::remove_dir_all(&root).ok();
        let session = root.join("2026-09-12_1430");
        fs::create_dir_all(&session).unwrap();
        fs::write(session.join("them.wav"), b"x").unwrap();

        let first = rename_session_dir_as(&session.to_string_lossy(), "Alice 週會", false).unwrap();
        assert_eq!(leaf(&first), "Alice 週會-2026-09-12_1430");
        // 回報的路徑必須是真的存在的那一個，否則「開啟資料夾」會開錯。
        let first_p = PathBuf::from(&first);
        assert!(first_p.is_dir(), "回報的路徑不存在");
        assert!(first_p.join("them.wav").exists(), "錄音檔要跟著搬過去");
        assert!(!session.exists(), "舊資料夾應該已經不在了");

        // 第二次改名：取代舊名字，不是疊成「改成這個-Alice 週會-…」。
        let second = rename_session_dir_as(&first, "改成這個", false).unwrap();
        assert_eq!(leaf(&second), "改成這個-2026-09-12_1430");

        // 同一個名字按第二次不算失敗，也不該生出一個 `-2`。
        let again = rename_session_dir_as(&second, " 改成這個 ", false).unwrap();
        assert_eq!(again, second);

        // 設定中途切成日期在前：照樣認得出時間戳。
        let flipped = rename_session_dir_as(&again, "改成這個", true).unwrap();
        assert_eq!(leaf(&flipped), "2026-09-12_1430-改成這個");
        let back = rename_session_dir_as(&flipped, "Bob", false).unwrap();
        assert_eq!(leaf(&back), "Bob-2026-09-12_1430");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rename_keeps_the_collision_suffix_of_the_stamp() {
        let root = std::env::temp_dir().join("mt-rename-c0l1d3");
        fs::remove_dir_all(&root).ok();
        let session = root.join("2026-09-12_1430-2");
        fs::create_dir_all(&session).unwrap();

        let a = rename_session_dir_as(&session.to_string_lossy(), "週會", true).unwrap();
        assert_eq!(leaf(&a), "2026-09-12_1430-2-週會");
        let b = rename_session_dir_as(&a, "週會", false).unwrap();
        assert_eq!(leaf(&b), "週會-2026-09-12_1430-2");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rename_refuses_an_empty_name_and_a_missing_folder() {
        let root = std::env::temp_dir().join("mt-rename-empty-3f81ac");
        fs::remove_dir_all(&root).ok();
        let session = root.join("2026-09-12_1500");
        fs::create_dir_all(&session).unwrap();

        let err = rename_session_dir_as(&session.to_string_lossy(), "  ///  ", false).unwrap_err();
        assert!(err.contains("換一個"), "要告訴人怎麼辦，得到：{}", err);
        assert!(session.is_dir(), "失敗時不可以動到資料夾");

        let gone = root.join("2026-01-01_0000");
        let err = rename_session_dir_as(&gone.to_string_lossy(), "名字", false).unwrap_err();
        assert!(err.contains("不在了"), "錯誤訊息要講清楚，得到：{}", err);
        assert!(!gone.exists(), "不該順手建資料夾");

        // 舊版 `meeting-…` 資料夾：講清楚、不動它。
        let old = root.join("meeting-2026-09-12_150000 Alice");
        fs::create_dir_all(&old).unwrap();
        let err = rename_session_dir_as(&old.to_string_lossy(), "名字", false).unwrap_err();
        assert!(err.contains("舊版"), "錯誤訊息要講清楚，得到：{}", err);
        assert!(old.is_dir(), "失敗時不可以動到資料夾");

        fs::remove_dir_all(&root).ok();
    }
}
