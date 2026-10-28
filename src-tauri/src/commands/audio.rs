use crate::audio::microphone::MicCapture;
use crate::audio::recorder::RecordingSummary;
use crate::audio::SystemAudioCapture;
use crate::settings::SettingsState;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Instant;
use tauri::{ipc::Channel, Emitter, State};

/// Where a meeting's raw audio is archived, and under what
/// name. One file per source — never a mixdown, because measurement showed that pressing
/// two simultaneous speakers into one mono track is what manufactures sentences
/// nobody said.
///
/// One meeting = one folder, named `<date>_<HHMM>` (e.g. `YYYY-MM-DD_1430`;
/// no `meeting-` prefix, no seconds). Naming it afterwards adds
/// the name in front or behind — see `session_store::rename_session_dir`,
/// which finds this stamp again by its shape, so keep the two in step. Holding `them.wav` (speakers) and `me.wav` (microphone)
/// while recording; after a normal stop each is replaced by its verified `.mp3`. Two reasons for the
/// folder rather than a flat pile: the post-meeting tools look for
/// exactly those two names, and a folder keeps a meeting's tracks together when
/// a later stage adds `both.wav` next to them.
fn recording_paths(dir: &str, source: &str) -> (Option<PathBuf>, Option<PathBuf>) {
    if dir.trim().is_empty() {
        return (None, None);
    }
    // Decide *before* creating anything, so an unknown source leaves no empty
    // folder behind.
    let (want_sys, want_mic) = match source {
        "system" => (true, false),
        "microphone" => (false, true),
        "both" => (true, true),
        _ => return (None, None),
    };
    let root = PathBuf::from(dir);
    let stamp = chrono::Local::now().format("%Y-%m-%d_%H%M").to_string();
    // A second meeting inside the same minute would otherwise write into the
    // first one's folder and overwrite its tracks.
    let mut session = root.join(&stamp);
    let mut n = 2;
    while session.exists() && n <= 99 {
        session = root.join(format!("{}-{}", stamp, n));
        n += 1;
    }
    if let Err(e) = std::fs::create_dir_all(&session) {
        // No silent degrade. Say it in the log; the caller still
        // starts the capture so the meeting is not lost, just unarchived.
        eprintln!(
            "[audio] RECORDING DISABLED: cannot create session folder {:?}: {}",
            session, e
        );
        return (None, None);
    }
    eprintln!("[audio] session folder: {}", session.display());
    (
        want_sys.then(|| session.join("them.wav")),
        want_mic.then(|| session.join("me.wav")),
    )
}

/// `recorder::repair_dir` deliberately does not recurse —
/// it is shared with the standalone recorder and must stay as it is. Now that each
/// meeting gets its own folder, last session's killed recording is one level
/// down, so the *caller* walks the folders. The root itself is still repaired:
/// recordings made before this change are lying flat in there.
fn repair_tree(root: &std::path::Path) -> usize {
    let mut fixed = crate::audio::recorder::repair_dir(root).len();
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                fixed += crate::audio::recorder::repair_dir(&path).len();
            }
        }
    }
    fixed
}

/// Where this meeting's files were told to go.
///
/// The backend has to remember this, and it is the only place that may: the
/// stop report needs a path to fall back on when a capture never reported in
/// (`RecordingSummary` is `None`), and the "open folder" button needs
/// the folder itself. Deriving the folder in the frontend as well would be a
/// second source of truth for the same fact, and the two drift silently.
#[derive(Debug, Clone)]
pub struct SessionPaths {
    pub dir: Option<PathBuf>,
    pub sys: Option<PathBuf>,
    pub mic: Option<PathBuf>,
    /// This meeting asked for the microphone and did
    /// not get it.
    ///
    /// Carried all the way to the stop report because "I only wanted the
    /// speakers" and "I wanted both and the microphone never opened" produce
    /// exactly the same report otherwise — one track, no complaints — and the
    /// second one is a lost half of the meeting.
    pub mic_failed: Option<String>,
}

/// State for tracking active audio captures
pub struct AudioState {
    pub system_audio: Mutex<SystemAudioCapture>,
    pub microphone: Mutex<MicCapture>,
    /// This meeting's paths, cleared on every start and
    /// taken on every stop — see the state rule in `start_capture`.
    pub current_session: Mutex<Option<SessionPaths>>,
    /// One forwarder per capture. A meeting runs the
    /// speakers and the microphone as two independent streams, so this is a
    /// list, not a single slot.
    pub active_receiver: Mutex<Vec<AudioForwarder>>,
}

/// What one track's forwarder saw during a meeting.
///
/// This is the whole point of counting here: the forwarder's receiver is the
/// same one the standalone recorder's meter reads,
/// so `packets == 0` here means exactly what `chunks == 0` means there — the
/// track never carried a single sample. A meeting that recorded nothing looks
/// identical on disk to one that recorded well (file present, length right,
/// header valid, silence inside), so the count is the only thing that can tell
/// them apart.
///
/// The two tracks do *not* mean the same thing when they read zero:
/// * `them` — the speakers only send non-silent packets, so zero means no sound
///   ever came out of this machine (or the loopback never started).
/// * `me` — the microphone has no silence concept and sends real low-level
///   samples from a quiet room, so zero means the device sent nothing at all.
#[derive(Debug, Clone, Serialize)]
pub struct TrackCount {
    /// "them" (speakers) or "me" (microphone).
    pub track: String,
    pub packets: u64,
    pub bytes: u64,
    /// How long ago the last packet arrived, measured when the count is taken.
    ///
    /// This is the answer to a failure `packets` cannot see: a microphone
    /// unplugged mid-meeting. cpal stops calling back for good, but the recorder
    /// pads the file out to the wall clock on stop, so the length is right, the
    /// header is right, and `packets` sits at whatever it reached before the
    /// device died. Nothing is red. This number is, though: it equals the rest
    /// of the meeting.
    ///
    /// With no packet at all the whole session counts as the tail.
    pub silent_tail_seconds: f64,
}

/// One track's line on the stop report.
///
/// Field names reach the frontend as camelCase.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackReport {
    pub track: String,
    pub label: String,
    pub path: Option<String>,
    pub parts: Vec<String>,
    pub seconds: f64,
    pub bytes: u64,
    pub padded_seconds: f64,
    pub pad_events: u64,
    pub packets: u64,
    pub silent_tail_seconds: f64,
    /// Not one packet all meeting.
    pub no_audio: bool,
    /// `me` only: packets came, then stopped long before the meeting did.
    pub died_midway: bool,
    /// Set when the capture never reported in and the file had to answer for
    /// itself. Never a silent zero — see `track_report`.
    pub note: Option<String>,
    /// The plain-language judgement, **one sentence**. `None` when there is
    /// nothing wrong. This is the half that goes on screen unconditionally and
    /// gets repeated in the always-on notice area, so it has to be readable in
    /// one glance — the reasons live in `verdict_detail`.
    pub verdict: Option<String>,
    /// Why it happened / what to do, folded away behind a "為什麼？" toggle.
    /// Always `Some` whenever `verdict` is `Some`; splitting them is a
    /// presentation decision, not a licence to drop the reasons.
    pub verdict_detail: Option<String>,
}

/// What the frontend gets when a meeting stops.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopReport {
    pub session_dir: Option<String>,
    /// True when this meeting was never going to leave a file behind.
    pub recording_off: bool,
    pub tracks: Vec<TrackReport>,
    /// Set when "both" was asked for and the
    /// microphone refused to open. The string is the reason, in the words the
    /// device gave us.
    pub mic_failed: Option<String>,
    /// What this report cannot see. Shown as small print, always.
    pub blind_spot: String,
}

/// Forwards audio from a receiver to a Tauri IPC channel
pub struct AudioForwarder {
    /// Handle to signal stop
    stop_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// 中場休息：true 時 forwarder 照收音訊但**整包丟掉**，
    /// 不計數、不送前端。錄音完全不經過這裡（它在 `audio/recorder.rs`，靠牆上時鐘
    /// 自己補靜音），所以暫停期間檔案裡是真實長度的靜音 —— 這正是要的行為。
    pause_flag: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// 到目前為止累計暫停了多久（毫秒）。
    paused_total_ms: std::sync::Arc<AtomicU64>,
    /// 這次暫停是從第幾毫秒開始的；`0` ＝ 現在沒有在暫停。
    paused_at_ms: std::sync::Arc<AtomicU64>,
    /// "them" or "me" — which track this forwarder is pumping.
    track: String,
    packets: std::sync::Arc<AtomicU64>,
    bytes: std::sync::Arc<AtomicU64>,
    /// Milliseconds from `started_at` to the last packet. Only meaningful when
    /// `packets > 0`, which is why there is no sentinel value here.
    last_packet_ms: std::sync::Arc<AtomicU64>,
    started_at: Instant,
}

impl AudioForwarder {
    fn stop(&self) {
        self.stop_flag
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// 進入中場休息。重複呼叫無效果（第二次不會把計時原點洗掉）。
    fn pause(&self) {
        if self.pause_flag.load(Ordering::SeqCst) {
            return;
        }
        self.paused_at_ms.store(
            self.started_at.elapsed().as_millis() as u64,
            Ordering::SeqCst,
        );
        self.pause_flag.store(true, Ordering::SeqCst);
    }

    /// 休息結束。把這一段休息的長度累加進 `paused_total_ms`。
    fn resume(&self) {
        if !self.pause_flag.load(Ordering::SeqCst) {
            return;
        }
        let now = self.started_at.elapsed().as_millis() as u64;
        let since = self.paused_at_ms.load(Ordering::SeqCst);
        self.paused_total_ms
            .fetch_add(now.saturating_sub(since), Ordering::SeqCst);
        self.paused_at_ms.store(0, Ordering::SeqCst);
        self.pause_flag.store(false, Ordering::SeqCst);
    }

    /// 扣掉休息之後，這一軌真正「在收音」的秒數。
    ///
    /// ⚠ 沒有這個扣除，`silent_tail_seconds` 會把休息時間算成「很久沒聲音」，
    ///   於是休息一小時再停止，收工判決會說這軌可能沒錄到 —— 而它其實好好的。
    fn active_elapsed_secs(&self) -> f64 {
        let elapsed_ms = self.started_at.elapsed().as_millis() as u64;
        let mut paused = self.paused_total_ms.load(Ordering::SeqCst);
        if self.pause_flag.load(Ordering::SeqCst) {
            // 還在休息中就停止：把這一段還沒結算的也扣掉。
            paused = paused.saturating_add(
                elapsed_ms.saturating_sub(self.paused_at_ms.load(Ordering::SeqCst)),
            );
        }
        elapsed_ms.saturating_sub(paused) as f64 / 1000.0
    }

    /// Copy out what this forwarder saw. Must be called before the forwarder is
    /// dropped — see `stop_capture_inner`.
    fn count(&self) -> TrackCount {
        let packets = self.packets.load(Ordering::SeqCst);
        let elapsed = self.active_elapsed_secs();
        let silent_tail_seconds = if packets == 0 {
            elapsed
        } else {
            let last = self.last_packet_ms.load(Ordering::SeqCst) as f64 / 1000.0;
            (elapsed - last).max(0.0)
        };
        TrackCount {
            track: self.track.clone(),
            packets,
            bytes: self.bytes.load(Ordering::SeqCst),
            silent_tail_seconds,
        }
    }

    /// A forwarder with numbers already on it and no thread behind it, so a test
    /// can prove the numbers are carried out of the state rather than left in it.
    #[cfg(test)]
    fn seeded(track: &str, packets: u64, bytes: u64) -> Self {
        Self {
            stop_flag: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            pause_flag: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            paused_total_ms: std::sync::Arc::new(AtomicU64::new(0)),
            paused_at_ms: std::sync::Arc::new(AtomicU64::new(0)),
            track: track.to_string(),
            packets: std::sync::Arc::new(AtomicU64::new(packets)),
            bytes: std::sync::Arc::new(AtomicU64::new(bytes)),
            last_packet_ms: std::sync::Arc::new(AtomicU64::new(0)),
            started_at: Instant::now(),
        }
    }
}

/// What `start_capture` actually managed to open.
///
/// The frontend cannot assume this from the setting any more. With "both" it
/// connects two Soniox streams *before* invoking the command
/// (`capture.js`), and a stream nobody feeds still bills for its whole
/// lifetime — about US$0.18 an hour for silence — while the status line goes on
/// claiming "電腦聲音 ＋ 麥克風" in a meeting that has no microphone.
///
/// Returned rather than emitted: `audio-degraded` reaches `showAlert`, and
/// that single slot is overwritten by the next message. A
/// return value cannot be washed away by whatever is said next.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartReport {
    /// "them" / "me" — the tracks that are really running.
    pub tracks: Vec<String>,
    /// Why the microphone is missing, when it was asked for and did not open.
    pub mic_failed: Option<String>,
    /// False when this meeting will not leave a file behind — either the
    /// explicit "not this time" flag or an empty recording folder.
    pub recording: bool,
}

#[derive(Serialize, Clone)]
pub struct PermissionStatus {
    pub screen_recording: String,
    pub microphone: String,
}

/// Start audio capture and forward data to the frontend via IPC channels.
///
/// One channel per source, never merged:
/// * `channel` carries the system (speaker) audio, or the only stream when
///   `source` is a single source;
/// * `mic_channel` carries the microphone when `source` is "both".
///
/// Both are required because a Tauri `Channel` cannot be optional. For a
/// single source the unused one simply never receives anything.
///
/// `no_recording`: "do not record this one", as an
/// explicit flag. It has to be a flag and it has to be `Option`. An empty
/// `record_dir` does *not* mean "do not record": the fallback below reads the
/// saved setting when the argument is blank, so asking for no recording by
/// sending `""` records the meeting anyway and nothing on screen says a word.
/// `Option` so that a caller which does not send the argument at all still
/// works instead of failing to deserialise.
#[tauri::command]
pub fn start_capture(
    app: tauri::AppHandle,
    source: String,
    channel: Channel<Vec<u8>>,
    mic_channel: Channel<Vec<u8>>,
    record_dir: Option<String>,
    no_recording: Option<bool>,
    state: State<'_, AudioState>,
    settings: State<'_, SettingsState>,
) -> Result<StartReport, String> {
    // Stop any existing capture first.
    //
    // Every piece of state that outlives a start/stop pair
    // is cleared unconditionally here — not "when the start succeeds". Miss that
    // and last meeting's numbers turn up in this meeting's report, looking
    // entirely normal. The counts this hands back belong to the previous
    // meeting, which `stop_capture` has already reported; dropping them here is
    // the clearing.
    let _previous_meeting = stop_capture_inner(&state);
    if let Ok(mut session) = state.current_session.lock() {
        *session = None;
    }

    // A Bluetooth headset dropping to call
    // mode makes everything muffled and says nothing. Give the guard in
    // `audio::degraded` a way to reach the user's screen, not just stderr.
    let warn: Option<crate::audio::degraded::Warner> = {
        let app = app.clone();
        Some(std::sync::Arc::new(move |msg: &str| {
            // The compressed copy's own trouble
            // goes to its own event: `audio-degraded` lands in one shared
            // alert line and must not wipe a Bluetooth or microphone warning.
            let event = if msg.starts_with(crate::audio::compressed::WARNING_PREFIX) {
                "compressed-copy-warning"
            } else {
                "audio-degraded"
            };
            let _ = app.emit(event, msg.to_string());
        }))
    };

    // An explicit argument wins; otherwise fall back to the saved setting, so
    // archiving can be turned on without touching the frontend.
    //
    // The flag is checked first and short-circuits the
    // whole fallback. Nothing below may reach `recording_paths`, so not one file
    // — not even the session folder — is created.
    let skip_recording = no_recording.unwrap_or(false);
    let dir = if skip_recording {
        eprintln!("[audio] recording deliberately OFF for this meeting");
        String::new()
    } else {
        match record_dir {
            Some(d) if !d.trim().is_empty() => d,
            _ => settings
                .0
                .lock()
                .map(|s| s.recording_dir.clone())
                .unwrap_or_default(),
        }
    };
    // A recorder that was killed (crash, Task Manager,
    // power loss) leaves a header claiming 0 bytes of audio and players show an
    // empty file, with no error anywhere. Put the real lengths back before this
    // session adds more files to the same folder.
    if !dir.trim().is_empty() {
        let fixed = repair_tree(std::path::Path::new(&dir));
        if fixed > 0 {
            eprintln!("[audio] repaired {} unfinished recording(s) in {}", fixed, dir);
        }
    }

    // 明確說了不錄就**連問都不問**。`recording_paths` 現在遇到空字串也會
    // 回 (None, None)，但那是它的內部細節——「不錄」不可以靠別人的實作細節成立。
    let (sys_path, mic_path) = if skip_recording {
        (None, None)
    } else {
        recording_paths(&dir, source.as_str())
    };
    // Read before the paths are handed to the captures, which consume them.
    let sys_path_recorded = sys_path.is_some();
    let mic_path_recorded = mic_path.is_some();
    // Remember where this meeting is being written, for the stop report and for
    // the "open folder" button. The folder comes from the paths themselves, so
    // there is only ever one answer to "which folder was this meeting in".
    if let Ok(mut session) = state.current_session.lock() {
        *session = Some(SessionPaths {
            dir: sys_path
                .as_ref()
                .or(mic_path.as_ref())
                .and_then(|p| p.parent().map(|d| d.to_path_buf())),
            sys: sys_path.clone(),
            mic: mic_path.clone(),
            mic_failed: None,
        });
    }

    // Measurement showed what merging costs: two speakers pressed
    // into one mono track queue up behind each other, and the ASR then invents
    // sentences nobody said. So "both" means two independent streams all the way
    // to the frontend -- one Channel each, merged nowhere.
    let mut forwarders: Vec<AudioForwarder> = Vec::new();
    let mut mic_failed: Option<String> = None;

    match source.as_str() {
        "system" => {
            let sys = state.system_audio.lock().map_err(|e| e.to_string())?;
            let rx = sys.start(sys_path, warn)?;
            forwarders.push(spawn_forwarder(rx, channel, "them"));
        }
        "microphone" => {
            let mut mic = state.microphone.lock().map_err(|e| e.to_string())?;
            let rx = mic.start(mic_path, warn)?;
            forwarders.push(spawn_forwarder(rx, channel, "me"));
        }
        "both" => {
            // The speakers are the half that carries the other people in the
            // room. Losing them is losing the meeting, so that one still fails
            // the whole start.
            let sys_rx = {
                let sys = state.system_audio.lock().map_err(|e| e.to_string())?;
                sys.start(sys_path, warn.clone())?
            };
            forwarders.push(spawn_forwarder(sys_rx, channel, "them"));

            // The microphone
            // failing must not cancel the meeting. Before this, a `?` here threw
            // the whole start away — unplug the microphone and you get no
            // subtitles, no speaker recording and no meeting, over the half that
            // is merely nice to have.
            //
            // ⚠ It must not fail *quietly* either. The caller gets
            // `mic_failed`, the log gets a line, and the report says it too —
            // because the alternative is a meeting that looks entirely normal
            // and is missing your own voice.
            let mic_rx = {
                let mut mic = state.microphone.lock().map_err(|e| e.to_string())?;
                mic.start(mic_path.clone(), warn)
            };
            match mic_rx {
                Ok(rx) => forwarders.push(spawn_forwarder(rx, mic_channel, "me")),
                Err(e) => {
                    eprintln!(
                        "[audio] MICROPHONE NOT OPENED: {} — the meeting continues with the speakers only",
                        e
                    );
                    mic_failed = Some(e);
                }
            }
        }
        _ => return Err(format!("Unknown source: {}", source)),
    }

    // What the report is allowed to say about the microphone.
    //
    // The path is dropped as well as flagged: `MicCapture::start` deletes the half-built file,
    // so a path left in here would make the report offer a file that is not
    // there — a worse lie than saying nothing.
    if mic_failed.is_some() {
        if let Ok(mut session) = state.current_session.lock() {
            if let Some(s) = session.as_mut() {
                s.mic = None;
                s.mic_failed = mic_failed.clone();
            }
        }
    }

    let tracks: Vec<String> = forwarders.iter().map(|f| f.track.clone()).collect();
    let mut active = state.active_receiver.lock().map_err(|e| e.to_string())?;
    *active = forwarders;

    Ok(StartReport {
        tracks,
        mic_failed,
        recording: sys_path_recorded || mic_path_recorded,
    })
}

/// Pump one capture's PCM into one frontend channel.
/// One of these per source -- see the note in `start_capture` for why they are
/// never merged.
fn spawn_forwarder(
    receiver: mpsc::Receiver<Vec<u8>>,
    channel: Channel<Vec<u8>>,
    track: &str,
) -> AudioForwarder {
    let stop_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let stop_flag_clone = stop_flag.clone();
    let pause_flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let pause_flag_clone = pause_flag.clone();

    // Counted here rather than at either capture, because
    // this is the one point both tracks pass through on their way to the
    // frontend — and it is the same receiver the standalone recorder meters.
    let started_at = Instant::now();
    let packets = std::sync::Arc::new(AtomicU64::new(0));
    let bytes = std::sync::Arc::new(AtomicU64::new(0));
    let last_packet_ms = std::sync::Arc::new(AtomicU64::new(0));
    let packets_clone = packets.clone();
    let bytes_clone = bytes.clone();
    let last_packet_ms_clone = last_packet_ms.clone();

    std::thread::spawn(move || {
        let mut buffer: Vec<u8> = Vec::with_capacity(32000); // ~1 sec at 16kHz s16le
        let batch_interval = std::time::Duration::from_millis(200);
        let mut last_flush = std::time::Instant::now();

        loop {
            if stop_flag_clone.load(std::sync::atomic::Ordering::SeqCst) {
                // Flush remaining buffer before exit
                if !buffer.is_empty() {
                    let _ = channel.send(buffer.clone());
                }
                break;
            }

            // 休息中：手上不准留東西。
            //
            // 🔴 **這一行是獨立審查抓出來的，少了它下面的 200ms flush 會漏音訊出去。**
            //   下面那段 flush 是「每 200 毫秒把手上的送出去」，它**不看** `pause_flag`；
            //   而 `Ok(data)` 那個分支只有在「這一輪剛好收到新封包」時才清 buffer。
            //   於是：按下休息的瞬間，buffer 裡若還留著上一輪的殘音，而之後又沒有新封包
            //   進來（休息時沒人講話很正常，`them` 那軌靜音本來就不送），
            //   那截殘音就會被 flush 送到前端 —— 而前端此刻已經把串流設成 null 了。
            //   結果是 `onmessage` 裡對 null 呼叫方法，丟一個沒人接的 TypeError。
            //
            // ⚠ 失敗的形狀：時機取決於 10ms 輪詢剛好落在哪，所以**它不會每次都發生**。
            //   偶爾壞一次、而且只留一行 console 錯誤的東西，是最不會被修的那種。
            if pause_flag_clone.load(Ordering::SeqCst) {
                buffer.clear();
            }

            match receiver.recv_timeout(std::time::Duration::from_millis(10)) {
                Ok(data) => {
                    // 中場休息：照收、整包丟掉。
                    //
                    // ⚠ 三件事都是刻意的，少一件就會壞：
                    //   1. **照樣 recv**：不收的話 mpsc 那頭會一直堆，而送進來的是
                    //      錄音那條路同一批封包 —— 字幕的休息不可以拖累錄音。
                    //   2. **清掉 buffer**：不清的話休息前那截殘音會在繼續時被送出去，
                    //      變成「休息結束後第一句字幕是休息前的話」。
                    //   3. **不計數**：這些封包沒有到過 Soniox，算進去會讓收工報告
                    //      多報封包數，而封包數正是「這軌到底有沒有錄到」的唯一判準。
                    //
                    // 這裡不 send，所以休息期間不會踩到下面那個「send 失敗就 break」——
                    // 前端在休息時是把 Soniox 收掉的（省錢），但 Tauri 的 Channel 還在。
                    if pause_flag_clone.load(Ordering::SeqCst) {
                        buffer.clear();
                        continue;
                    }
                    packets_clone.fetch_add(1, Ordering::SeqCst);
                    bytes_clone.fetch_add(data.len() as u64, Ordering::SeqCst);
                    last_packet_ms_clone.store(
                        started_at.elapsed().as_millis() as u64,
                        Ordering::SeqCst,
                    );
                    buffer.extend_from_slice(&data);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    if !buffer.is_empty() {
                        let _ = channel.send(buffer.clone());
                    }
                    break;
                }
            }

            // Flush buffer every 200ms
            if last_flush.elapsed() >= batch_interval && !buffer.is_empty() {
                if let Err(_e) = channel.send(buffer.clone()) {
                    break; // Channel closed
                }
                buffer.clear();
                last_flush = std::time::Instant::now();
            }
        }
    });

    AudioForwarder {
        stop_flag,
        pause_flag,
        paused_total_ms: std::sync::Arc::new(AtomicU64::new(0)),
        paused_at_ms: std::sync::Arc::new(AtomicU64::new(0)),
        track: track.to_string(),
        packets,
        bytes,
        last_packet_ms,
        started_at,
    }
}

/// How long a gap at the end of `me` counts as "the device stopped sending".
///
/// Only a red-flag threshold, never the measurement: the
/// report always states the real number of seconds, so there is no argument to
/// have about where the line sits.
const DIED_MIDWAY_SECONDS: f64 = 60.0;

/// Turn one track's count, summary and path into its line
/// on the report.
///
/// The judgement is computed from `count`, never from `summary`. That is the
/// whole point: the standalone recorder reaches its verdict outside `report()`,
/// and copying only the summary half
/// would drop the verdict exactly when the capture failed to report in — the
/// case where it matters most.
fn track_report(count: &TrackCount, summary: Option<RecordingSummary>, path: Option<&PathBuf>) -> TrackReport {
    let is_me = count.track == "me";
    let no_audio = count.packets == 0;
    let died_midway = is_me && !no_audio && count.silent_tail_seconds > DIED_MIDWAY_SECONDS;

    let mut note = None;
    let (parts, seconds, bytes, padded_seconds, pad_events) = match summary {
        Some(s) => (s.parts, s.seconds, s.bytes, s.padded_seconds, s.pad_events),
        None => {
            // Never show 0 seconds here. "Not finished reporting" and "recorded
            // nothing" look the same on screen, and only one of them is true.
            // The WAV may already be gone, replaced by its
            // verified mp3, by the time this fallback looks.
            let wav = path.and_then(|p| std::fs::metadata(p).ok());
            let mp3 = path.and_then(|p| std::fs::metadata(crate::audio::compressed::compressed_path(p)).ok());
            note = Some(match (wav, mp3) {
                (Some(m), _) => format!(
                    "沒收到收尾回報，但檔案在（{:.1} MB）。下次啟動 App 會自動把檔頭修好。",
                    m.len() as f64 / 1_048_576.0
                ),
                (None, Some(m)) => format!(
                    "沒收到收尾回報，但 mp3 在（{:.1} MB），而且已驗過完整（wav 是驗過才刪的）。",
                    m.len() as f64 / 1_048_576.0
                ),
                (None, None) => "沒有錄到東西（這場沒有留下檔案）。".to_string(),
            });
            (Vec::new(), 0.0, 0, 0.0, 0)
        }
    };

    // 判決分兩段：**一句話的結論**
    // ＋ 收在摺疊裡的原因。原本是一整段五、六行的長文，實測後覺得「太長沒人看得完」
    // ——而一段沒有人看完的警告，跟沒有警告是同一件事。
    //
    // ⚠ 縮的是「呈現」，不是「內容」：原因一個字都沒有刪，只是收進摺疊裡，
    //   而且紀錄檔印的仍然是結論＋原因兩段（見下面 `VERDICT` 那行）。
    //   那些原因不是廢話——「兩種可能」那條分的是「聲音沒放出來」與「抓音沒開起來」，
    //   後者只寫進紀錄檔、畫面上看不出來，刪掉就再也沒有地方講它。
    let (verdict, verdict_detail) = if no_audio && is_me {
        // Blind spot A: a driver that sends digital zeros is indistinguishable
        // from a working microphone here, so the wording stops at "sent no
        // data" and never promises the voice was lost.
        (
            Some("⚠ 這場沒錄到你自己的聲音（麥克風整場沒送出資料）。".to_string()),
            Some(
                "錄音檔的長度正常，但麥克風整場一筆資料都沒送出來，\
                 通常是麥克風被拔掉、被別的程式獨佔，或被系統靜音了。對方那一軌不受影響。"
                    .to_string(),
            ),
        )
    } else if no_audio {
        // Blind spot: loopback initialisation failure only writes to the log
        // (`wasapi.rs`), and it reads as zero packets too — so the wording has
        // to offer both causes, not just the AirPlay one.
        (
            Some("⚠ 這場沒錄到對方的聲音（them 那一軌整場是靜音，別拿去做逐字稿）。".to_string()),
            Some(
                "檔案長度和大小都正常，但裡面從頭到尾是安靜的：一個聲音都沒收到，\
                 整段都是程式為了對齊時間補上去的靜音。兩種可能——\
                 ① 聲音沒有從這台電腦放出來（走了 AirPlay／投到電視、會議其實是用手機開的、\
                 Windows 的播放裝置選到另一個沒在用的裝置）；\
                 ② 也可能是抓音根本沒開起來（那只會寫進紀錄檔、畫面上看不出來）。"
                    .to_string(),
            ),
        )
    } else if died_midway {
        (
            Some(format!(
                "⚠ 麥克風在你按停止前約 {:.0} 分鐘就斷了，那段沒有你的聲音。",
                count.silent_tail_seconds / 60.0
            )),
            Some(
                "錄音檔的長度仍然是對的（那一段是程式補上去的靜音，時間軸沒有被改壞），\
                 只是那段時間你的聲音不在裡面。通常是麥克風中途被拔掉，或驅動掛了。"
                    .to_string(),
            ),
        )
    } else {
        (None, None)
    };

    TrackReport {
        track: count.track.clone(),
        label: if is_me {
            // No extension: after a normal stop the folder holds me.mp3,
            // and me.wav only when it had to be kept.
            "你的麥克風（me）".to_string()
        } else {
            "對方·電腦聲音（them）".to_string()
        },
        path: path.map(|p| p.display().to_string()),
        parts,
        seconds,
        bytes,
        padded_seconds,
        pad_events,
        packets: count.packets,
        silent_tail_seconds: count.silent_tail_seconds,
        no_audio,
        died_midway,
        note,
        verdict,
        verdict_detail,
    }
}

/// Assemble the whole report. Pure on purpose: every branch
/// that matters can be tested without a sound card.
fn build_report(
    counts: &[TrackCount],
    session: Option<SessionPaths>,
    sys_summary: Option<RecordingSummary>,
    mic_summary: Option<RecordingSummary>,
) -> StopReport {
    let (dir, sys_path, mic_path, mic_failed) = match &session {
        Some(s) => (
            s.dir.clone(),
            s.sys.clone(),
            s.mic.clone(),
            s.mic_failed.clone(),
        ),
        None => (None, None, None, None),
    };
    // A meeting whose microphone never opened still
    // wrote `them.wav`, so "no files at all" must not be inferred from the
    // microphone path being gone.
    let recording_off = sys_path.is_none() && mic_path.is_none() && mic_failed.is_none();

    let mut sys_summary = sys_summary;
    let mut mic_summary = mic_summary;
    let tracks = counts
        .iter()
        .map(|c| {
            if c.track == "me" {
                track_report(c, mic_summary.take(), mic_path.as_ref())
            } else {
                track_report(c, sys_summary.take(), sys_path.as_ref())
            }
        })
        .collect();

    StopReport {
        session_dir: dir.map(|d| d.display().to_string()),
        recording_off,
        tracks,
        // This is what stops "I chose speakers only" and
        // "I asked for both and lost my own voice" from producing the same
        // report. Without it the two are indistinguishable — one track, no
        // complaint — and only one of them is a problem.
        mic_failed: mic_failed.map(|e| {
            format!(
                "⚠⚠ 這場沒有開麥克風（你選的是「兩路都抓」）。你自己的聲音整場沒有被錄下來，也沒有進字幕；對方那一軌不受影響。原因：{}",
                e
            )
        }),
        // Blind spot C. A clean report is not a promise that everything was
        // captured, and saying so here is cheaper than someone finding out from
        // an empty transcript.
        blind_spot: "說明：「對方」那一軌綁的是你按下開始當時的播放裝置。\
                     會議中途播放裝置被換走（例如接上藍牙耳機），之後的聲音就抓不到，\
                     而這張報告仍然會是正常的。"
            .to_string(),
    }
}

/// Stop audio capture
#[tauri::command]
pub fn stop_capture(state: State<'_, AudioState>) -> Result<StopReport, String> {
    let counts = stop_capture_inner(&state);

    // `eprintln!` only — the stdout path silently drops
    // lines (`applog.rs`).
    for c in &counts {
        eprintln!(
            "[audio] track {}: {} packets, {} bytes, last packet {:.1}s before stop",
            c.track, c.packets, c.bytes, c.silent_tail_seconds
        );
    }

    // The WASAPI thread finishes its file asynchronously,
    // so give it a moment to close before asking what it wrote.
    std::thread::sleep(std::time::Duration::from_millis(300));
    let sys_summary = state
        .system_audio
        .lock()
        .ok()
        .and_then(|sys| sys.last_recording());
    let mic_summary = state
        .microphone
        .lock()
        .ok()
        .and_then(|mic| mic.last_recording());

    // Taken, not read: this meeting's paths must not be able to turn up in the
    // next meeting's report (see the state rule in `start_capture`).
    let session = state.current_session.lock().ok().and_then(|mut s| s.take());

    let report = build_report(&counts, session, sys_summary, mic_summary);
    for t in &report.tracks {
        eprintln!(
            "[audio] report {}: {:.1}s, {} bytes, padded {:.1}s in {} gaps{}",
            t.track,
            t.seconds,
            t.bytes,
            t.padded_seconds,
            t.pad_events,
            t.note
                .as_ref()
                .map(|n| format!(" | {}", n))
                .unwrap_or_default()
        );
        if let Some(v) = &t.verdict {
            // ⚠ 紀錄檔印的是**結論＋原因兩段**。畫面上原因被摺起來了，而事後看紀錄檔的人
            //   沒有那顆可以展開的鍵——只印短句等於把原因從追查路徑上刪掉。
            eprintln!(
                "[audio] VERDICT {}: {}{}",
                t.track,
                v,
                t.verdict_detail
                    .as_ref()
                    .map(|d| format!(" | {}", d))
                    .unwrap_or_default()
            );
        }
    }
    Ok(report)
}

/// 中場休息開始。
///
/// **暫停期間照樣寫靜音，檔案裡的時間永遠等於真實時間。**
/// 所以這裡**只動字幕那條路**——forwarder 開始把封包丟掉，錄音那半一行都不碰
/// （`audio/recorder.rs` 的 `pad_to_wall_clock()` 每次輪詢都對牆上時鐘補靜音，
/// 我們什麼都不做它就是對的）。
///
/// ⚠ 前端在呼叫這個之後**必須把兩條 Soniox 串流收掉**：串流是按整條時長計費的，
///   休息一小時不收就白付一小時。繼續時再重連。
///
/// 回傳暫停了幾軌。沒有在收音時回 `Err` 而不是默默成功 —— 「按了暫停但其實沒暫停」
/// 是會被靜默吞掉的那種失敗。
#[tauri::command]
pub fn pause_capture(state: State<'_, AudioState>) -> Result<usize, String> {
    let active = state
        .active_receiver
        .lock()
        .map_err(|e| format!("讀取收音狀態失敗：{}", e))?;
    if active.is_empty() {
        return Err("現在沒有正在進行的收音，沒有東西可以暫停。".into());
    }
    for forwarder in active.iter() {
        forwarder.pause();
    }
    eprintln!(
        "[audio] 中場休息開始（{} 軌）：字幕停、錄音照寫（靜音補到真實長度）",
        active.len()
    );
    Ok(active.len())
}

/// 休息結束，接回同一場。
///
/// ⚠ 前端要**先**重連 Soniox 再呼叫這個，順序反了的話重連那幾百毫秒的音訊會被
///   forwarder 送進一條還沒接通的串流而丟掉——症狀是「繼續之後第一句話沒有字幕」，
///   而且不會有任何錯誤訊息。
#[tauri::command]
pub fn resume_capture(state: State<'_, AudioState>) -> Result<usize, String> {
    let active = state
        .active_receiver
        .lock()
        .map_err(|e| format!("讀取收音狀態失敗：{}", e))?;
    if active.is_empty() {
        return Err("現在沒有正在進行的收音，沒有東西可以繼續。".into());
    }
    for forwarder in active.iter() {
        forwarder.resume();
    }
    eprintln!("[audio] 休息結束（{} 軌）：字幕接回同一場", active.len());
    Ok(active.len())
}

/// Stop everything and hand back what each track saw.
///
/// The counts have to leave with the forwarders: `drain`
/// drops them, so reading the numbers afterwards is impossible. Returning them
/// is also what keeps the "cleared on every start" rule honest — there is no
/// field left behind that could still hold last meeting's numbers.
fn stop_capture_inner(state: &AudioState) -> Vec<TrackCount> {
    // Stop the forwarder
    let mut counts = Vec::new();
    if let Ok(mut active) = state.active_receiver.lock() {
        for forwarder in active.drain(..) {
            forwarder.stop();
            counts.push(forwarder.count());
        }
    }

    // Stop system audio
    if let Ok(sys) = state.system_audio.lock() {
        sys.stop();
    }

    // Stop microphone
    if let Ok(mut mic) = state.microphone.lock() {
        mic.stop();
    }

    counts
}

/// Check audio capture permissions
#[tauri::command]
pub fn check_permissions() -> PermissionStatus {
    // Note: Actual permission checking on macOS requires Objective-C interop
    // For now, we return "unknown" and permissions will be prompted on first use
    PermissionStatus {
        screen_recording: "unknown".to_string(),
        microphone: "unknown".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── 中場休息 ─────────────────────────────────────
    //
    // 這三題全部圍著同一個靜默失敗打轉：休息時間被算成「很久沒聲音」。
    // 收工判決正是用 `silent_tail_seconds` 判「這軌可能沒錄到」的，
    // 所以休息一小時再停止，會得到一句「這軌可能沒錄到」而它其實好好的——
    // 而且錄音檔是對的，沒有任何一個地方會報錯。

    #[test]
    fn 休息時間不算進沒聲音的尾巴() {
        let f = AudioForwarder::seeded("them", 10, 1000);
        std::thread::sleep(std::time::Duration::from_millis(30));
        let before = f.active_elapsed_secs();

        f.pause();
        std::thread::sleep(std::time::Duration::from_millis(80));
        // 還在休息中就問：這 80ms 必須已經被扣掉，不能等到 resume 才算。
        let during = f.active_elapsed_secs();
        assert!(
            during - before < 0.05,
            "休息中的時間不該計入（before={before}, during={during}）"
        );

        f.resume();
        let after = f.active_elapsed_secs();
        assert!(
            after - before < 0.05,
            "休息結束後也不該把那 80ms 補回來（before={before}, after={after}）"
        );
    }

    #[test]
    fn 連按兩次暫停不會洗掉計時原點() {
        let f = AudioForwarder::seeded("me", 5, 500);
        f.pause();
        std::thread::sleep(std::time::Duration::from_millis(50));
        f.pause(); // 第二次：若這裡把 paused_at 重設，前面 50ms 就會憑空變成「有在收音」
        std::thread::sleep(std::time::Duration::from_millis(50));
        f.resume();

        let paused = f.paused_total_ms.load(Ordering::SeqCst);
        assert!(
            paused >= 90,
            "兩段休息都要算進去，實際只算了 {paused}ms"
        );
    }

    #[test]
    fn 沒在休息時按繼續不會把時間往回加() {
        let f = AudioForwarder::seeded("them", 1, 100);
        f.resume(); // 沒暫停過就按繼續
        assert_eq!(
            f.paused_total_ms.load(Ordering::SeqCst),
            0,
            "沒有休息過，累計休息必須是 0"
        );
        // 兩段休息分開累加，中間那段「有在收音」的時間不可以被吃掉。
        f.pause();
        std::thread::sleep(std::time::Duration::from_millis(40));
        f.resume();
        let first = f.paused_total_ms.load(Ordering::SeqCst);
        std::thread::sleep(std::time::Duration::from_millis(40));
        f.pause();
        std::thread::sleep(std::time::Duration::from_millis(40));
        f.resume();
        let total = f.paused_total_ms.load(Ordering::SeqCst);
        assert!(
            total >= first + 30 && total < first + 120,
            "第二段休息要單獨累加，不該把中間在收音的 40ms 也算進去（first={first}, total={total}）"
        );
    }

    /// A meeting must never write into another meeting's folder. Two starts in
    /// the same second are rare but not impossible (double-click, restart), and
    /// the failure would be silent: the second meeting simply overwrites the
    /// first one's tracks.
    #[test]
    fn second_meeting_in_the_same_second_gets_its_own_folder() {
        let root = std::env::temp_dir().join(format!(
            "mt-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let dir = root.to_string_lossy().to_string();

        let (a_sys, a_mic) = recording_paths(&dir, "both");
        let (b_sys, _) = recording_paths(&dir, "both");
        let a_sys = a_sys.unwrap();
        let b_sys = b_sys.unwrap();

        assert_eq!(a_sys.file_name().unwrap(), "them.wav");
        assert_eq!(a_mic.unwrap().file_name().unwrap(), "me.wav");
        assert_ne!(a_sys.parent(), b_sys.parent(), "two meetings shared a folder");
        assert!(a_sys.parent().unwrap().is_dir());
        assert!(b_sys.parent().unwrap().is_dir());

        // Single-source meetings get a folder too, with only the track they own.
        let (s_sys, s_mic) = recording_paths(&dir, "system");
        assert!(s_sys.is_some() && s_mic.is_none());

        // An unrecognised source must not leave an empty folder behind.
        let before = std::fs::read_dir(&root).unwrap().count();
        assert_eq!(recording_paths(&dir, "nonsense"), (None, None));
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), before);

        std::fs::remove_dir_all(&root).ok();
    }

    /// `repair_dir` is shared with the standalone recorder and deliberately does not
    /// recurse. The walk has to happen here, and it has to keep covering the
    /// root — recordings made before the folder change are lying flat in it.
    #[test]
    fn repair_tree_walks_root_and_one_level_down() {
        let root = std::env::temp_dir().join(format!(
            "mt-repair-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("meeting-x")).unwrap();
        // Not wav files, so nothing is repairable; the point is that walking a
        // tree with a subfolder in it neither panics nor skips the root.
        std::fs::write(root.join("flat.txt"), b"x").unwrap();
        std::fs::write(root.join("meeting-x").join("nested.txt"), b"x").unwrap();
        assert_eq!(repair_tree(&root), 0);
        assert_eq!(repair_tree(std::path::Path::new(r"Z:\nope-does-not-exist")), 0);
        std::fs::remove_dir_all(&root).ok();
    }

    fn idle_state() -> AudioState {
        AudioState {
            system_audio: Mutex::new(SystemAudioCapture::new()),
            microphone: Mutex::new(MicCapture::new()),
            active_receiver: Mutex::new(Vec::new()),
            current_session: Mutex::new(None),
        }
    }

    fn count_of(track: &str, packets: u64, tail: f64) -> TrackCount {
        TrackCount {
            track: track.to_string(),
            packets,
            bytes: packets * 320,
            silent_tail_seconds: tail,
        }
    }

    fn summary_of(path: &str, seconds: f64) -> RecordingSummary {
        RecordingSummary {
            path: path.to_string(),
            parts: vec![path.to_string()],
            seconds,
            bytes: (seconds * 96_000.0) as u64,
            padded_seconds: 0.0,
            pad_events: 0,
        }
    }

    /// The verdict must survive a capture that never reported in.
    ///
    /// The standalone recorder reaches its verdict outside `report()`, so a port that
    /// only copies the summary half loses the red text in exactly the case that
    /// matters: nothing recorded *and* no summary. On screen that looks like a
    /// quiet, successful meeting.
    #[test]
    fn a_dead_track_is_still_judged_when_no_summary_came_back() {
        let counts = vec![count_of("them", 0, 30.0)];
        let report = build_report(&counts, None, None, None);

        let them = &report.tracks[0];
        assert!(them.no_audio, "zero packets must read as no audio");
        assert!(
            them.verdict.is_some(),
            "the verdict vanished when the summary was missing"
        );
        assert!(
            them.note.is_some(),
            "a missing summary must say so instead of showing a silent 0 seconds"
        );
    }

    /// Blind spot B: the microphone was unplugged mid-meeting. Padding keeps the
    /// file the right length, so `no_audio` stays false and nothing is red —
    /// the tail is the only thing that knows.
    #[test]
    fn a_microphone_that_died_midway_is_caught_by_the_tail_not_by_the_count() {
        let counts = vec![count_of("me", 4000, 120.0)];
        let report = build_report(
            &counts,
            None,
            None,
            Some(summary_of(r"D:\raw\meeting-x\me.wav", 180.0)),
        );

        let me = &report.tracks[0];
        assert!(!me.no_audio, "packets did arrive, so this must not be no_audio");
        assert!(me.died_midway, "a two-minute dead tail must be caught");
        assert!(me.verdict.as_ref().unwrap().contains("2 分鐘"));
    }

    /// The speakers are silent for long stretches of every real meeting — an
    /// hour-long test measured 82% of the time line as padding. Borrowing the
    /// microphone's rule for them would fire on every meeting, and a warning
    /// that always fires is not a warning.
    #[test]
    fn a_long_silence_on_the_speakers_is_never_called_a_failure() {
        let counts = vec![count_of("them", 12, 1800.0)];
        let report = build_report(
            &counts,
            None,
            Some(summary_of(r"D:\raw\meeting-x\them.wav", 3600.0)),
            None,
        );

        let them = &report.tracks[0];
        assert!(!them.died_midway, "them must never be judged on its tail");
        assert!(them.verdict.is_none());
    }

    /// 「我只想抓喇叭」與「我要兩路、但麥克風沒開起來」不可以產出同一張報告。
    ///
    /// 兩者都是一軌、都沒有 me 那條 verdict——差別只在後者少了半場會議。
    /// 這一則就是在釘住那個差別：驗收的人要分得出來，而唯一分得出來的地方是這裡。
    #[test]
    fn a_microphone_that_never_opened_is_not_the_same_report_as_speakers_only() {
        let counts = vec![count_of("them", 100, 0.2)];

        let speakers_only = build_report(
            &counts,
            Some(SessionPaths {
                dir: Some(PathBuf::from("d")),
                sys: Some(PathBuf::from("d/them.wav")),
                mic: None,
                mic_failed: None,
            }),
            Some(summary_of("d/them.wav", 60.0)),
            None,
        );
        assert!(speakers_only.mic_failed.is_none());
        assert!(!speakers_only.recording_off);

        let mic_died = build_report(
            &counts,
            Some(SessionPaths {
                dir: Some(PathBuf::from("d")),
                sys: Some(PathBuf::from("d/them.wav")),
                // 麥克風啟動失敗時已經把那個空檔刪了，所以路徑也必須是空的——
                // 報告不可以指向一個不存在的檔案。
                mic: None,
                mic_failed: Some("裝置被別的程式獨佔".to_string()),
            }),
            Some(summary_of("d/them.wav", 60.0)),
            None,
        );
        let said = mic_died.mic_failed.expect("沒有講出麥克風沒開這件事");
        assert!(said.contains("沒有開麥克風"));
        assert!(said.contains("裝置被別的程式獨佔"), "原因要照實說");
        assert_eq!(mic_died.tracks.len(), 1, "沒開的那一軌不可以憑空長出一條");
        assert!(!mic_died.recording_off, "them.wav 是有錄到的");
    }

    /// Each track must be handed its own summary. Swapping them would show the
    /// microphone's length next to the speakers' name — a report that is wrong
    /// in a way that still looks entirely plausible.
    #[test]
    fn each_track_gets_its_own_summary_and_path() {
        let counts = vec![count_of("them", 100, 0.2), count_of("me", 200, 0.1)];
        let session = SessionPaths {
            dir: Some(PathBuf::from(r"D:\raw\meeting-x")),
            sys: Some(PathBuf::from(r"D:\raw\meeting-x\them.wav")),
            mic: Some(PathBuf::from(r"D:\raw\meeting-x\me.wav")),
            mic_failed: None,
        };
        let report = build_report(
            &counts,
            Some(session),
            Some(summary_of(r"D:\raw\meeting-x\them.wav", 60.0)),
            Some(summary_of(r"D:\raw\meeting-x\me.wav", 61.0)),
        );

        assert!(!report.recording_off);
        assert_eq!(report.session_dir.as_deref(), Some(r"D:\raw\meeting-x"));
        let them = &report.tracks[0];
        let me = &report.tracks[1];
        assert_eq!(them.seconds, 60.0);
        assert_eq!(me.seconds, 61.0);
        assert!(them.path.as_ref().unwrap().ends_with("them.wav"));
        assert!(me.path.as_ref().unwrap().ends_with("me.wav"));
        assert!(them.verdict.is_none() && me.verdict.is_none());
    }

    /// Last meeting's packet count must not turn up in this meeting's report.
    ///
    /// Starting from an empty state and asserting "zero" would prove nothing —
    /// it is zero either way. So seed a finished meeting first, then check that
    /// the clearing call carries those numbers *out* and the next stop finds
    /// nothing at all.
    #[test]
    fn packet_counts_do_not_survive_into_the_next_meeting() {
        let state = idle_state();
        state
            .active_receiver
            .lock()
            .unwrap()
            .push(AudioForwarder::seeded("them", 5, 1600));

        // This is the call `start_capture` makes before it opens anything.
        let carried_out = stop_capture_inner(&state);
        assert_eq!(carried_out.len(), 1, "the finished meeting vanished");
        assert_eq!(carried_out[0].track, "them");
        assert_eq!(carried_out[0].packets, 5);
        assert_eq!(carried_out[0].bytes, 1600);

        // And this is the stop at the end of the *next* meeting.
        let next_meeting = stop_capture_inner(&state);
        assert!(
            next_meeting.is_empty(),
            "last meeting's counts survived into this one: {:?}",
            next_meeting
        );
    }

    /// A track that never received a packet reports the whole session as its
    /// silent tail, not zero — zero would read as "it was fine until the end".
    #[test]
    fn a_track_that_saw_nothing_reports_the_whole_session_as_silent() {
        let f = AudioForwarder::seeded("me", 0, 0);
        std::thread::sleep(std::time::Duration::from_millis(30));
        let c = f.count();
        assert_eq!(c.packets, 0);
        assert!(
            c.silent_tail_seconds >= 0.03,
            "silent tail was {}",
            c.silent_tail_seconds
        );
    }
}
