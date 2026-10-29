# Glossline

Live captions and translation for online meetings on Windows, with a recording of both sides.

Glossline listens to two sources at the same time: what your speakers play (the other people in the call) and your own microphone. It sends both to [Soniox](https://soniox.com) for speech recognition and translation, and shows the result as captions on screen. While it does that, it saves each side as its own audio file, so you can check the meeting later.

It is a fork of [phuc-nt/my-translator](https://github.com/phuc-nt/my-translator) v0.9.1 (MIT). See [What changed from my-translator](#what-changed-from-my-translator).

## Status

This is a personal tool, shared as is. It runs on Windows 10 and 11. There is no macOS build: the macOS part of the upstream code does not compile in this fork.

There are no prebuilt downloads. Build it yourself from this source (see below). This way you run exactly the code you can read here.

## What it does

- **Two sides, two streams.** The other side of the call and your microphone each get their own connection to Soniox, so one side never waits for the other.
- **Captions with translation.** Original text and translation, side by side. Chinese output is always converted to Traditional Chinese (Taiwan) with OpenCC `s2twp` rules, because Soniox may return Simplified Chinese.
- **Recording that keeps real time.** Each side is saved as a WAV file. Silence is kept, so a minute in the file is a minute of the meeting. An MP3 copy is written next to it if `libmp3lame.dll` is present.
- **Visible problems.** If the connection drops, a Bluetooth headset switches to its low-quality call mode, or the microphone disconnects, the app tells you on screen. The recording keeps going.
- **Transcript files.** Each meeting is saved as a Markdown file and a JSON file with time, speaker side, original text and translation.

## Where your data goes

- **Audio** is sent live to Soniox (`wss://stt-rt.soniox.com`) for recognition and translation. This is the only network address the app connects to (the WebView is limited to it in `src-tauri/tauri.conf.json`). Read the Soniox privacy terms before you use it for meetings.
- **Everything else stays on your computer:**
  - Recordings: a `recordings` folder next to the app, or `Documents\會議錄音` if that folder is not writable.
  - Transcripts (Markdown + JSON): `%APPDATA%\io.github.ffc225.glossline\transcripts`. A Markdown copy is also written into the recording folder.
  - Logs: a `logs` folder next to the app, or `%LOCALAPPDATA%\glossline\logs`.
- **Your Soniox API key** is stored in `settings.json` next to the app (or in `%APPDATA%\com.personal.translator\` if the app folder is not writable). It is stored **in plain text**, not encrypted. Anyone who can read that file can use your key.
- Nothing else is sent anywhere. There is no telemetry and no update check. (The Microsoft WebView2 runtime that shows the window is part of Windows and is not controlled by this app.)

**Ask before you record.** Tell the other people in the meeting that you are recording and transcribing, and get their consent. The rules differ by country and by company. You are responsible for following them.

## Build from source

You need:

- Windows 10 or 11
- [Rust](https://rustup.rs) (stable, MSVC toolchain) and the Visual Studio C++ build tools
- [Node.js](https://nodejs.org) only if you want to run the front-end tests in `tools/`

Then:

```bat
cd src-tauri
cargo build --release
```

The app is `src-tauri\target\release\glossline.exe`.

Optional, for the MP3 copies: **after** the release build, build LAME from the source included in `third_party\lame\`. Run this from the repository root:

```bat
cd ..
tools\build_lame_dll.bat
```

This puts `libmp3lame.dll` next to the exe. Without it, recordings are saved as WAV only.

On first start, open Settings and paste your Soniox API key.

## Known limits

- Windows only.
- **Bluetooth headsets:** when any program starts using the headset's microphone, Windows switches the headset to call mode, and the sound quality drops (often to 8 or 16 kHz mono). No app can prevent this. Use a separate microphone if you can.
- The app records the whole speaker output, not only the meeting app. Other sounds on your computer (music, notifications) are recorded and sent too.
- Open security notes (not fixed yet):
  - The API key is stored in plain text (see above).
  - The npm lock files still list two Tauri plugins the Rust side no longer uses.
  - Many Rust dependencies run code at build time. This is normal for the Rust ecosystem; `Cargo.lock` pins the versions.
  - The recording folder from settings is not normalized, and network (UNC) paths are not blocked.

## After the meeting: summaries

*This is the short version. The full method is in [docs/summary-workflow.md](docs/summary-workflow.md).*

Glossline does not write summaries. We make them with a method you can copy (the method is shared, not our scripts):

- **One AI writes, a second AI reviews.** The writer then checks every review point against the transcript. A rejected point must quote the caption line that proves it wrong.
- **A script decides, not the AI.** Every time cited in the summary must exist in the transcript, decisions must be split into "settled" and "only suggested", and every review point must be answered. If a check fails, there is no output.
- **Confidence is shown, not hidden.** Every number is marked "not listened back". Optionally, an AI that can hear audio listens to doubtful parts three times and a script sets a light (🔴 🟡 ⚪). Only a person who listened can make it 🟢.
- **The limit:** a script can check that every point was answered, not that the answer is right.

In our small test (5 company meetings), another AI writing alone missed 43% of decisions, action items and numbers. Details: [docs/summary-workflow.md](docs/summary-workflow.md). Step-by-step guide for an AI assistant: [skills/meeting-summary/SKILL.md](skills/meeting-summary/SKILL.md).

## What changed from my-translator

Kept: the Rust and Tauri base, Windows audio capture, and the Soniox connection.

Changed or added:

- New front end (`src/v2/`), designed for two streams from the start.
- Separate recording of both sides, with silence kept and crash-safe WAV files.
- Warnings for dropped connections, Bluetooth call mode and microphone loss.
- Traditional Chinese conversion for all Chinese output.
- Optional MP3 copies through a separately built LAME DLL.

Removed from the app: text-to-speech, the OpenAI, Qwen and local engines, the license key check, and the auto updater.

These are from upstream and refer to upstream's app or to features this fork no longer has: `upstream-docs/`, `benchmarks/`, `scripts/` and `.env.example`.

## License

MIT. See [LICENSE](LICENSE). The original copyright notice of my-translator is kept.

Third-party code and its licenses are listed in [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md). LAME is LGPL and is not linked into the exe; it is loaded at run time as a separate DLL.

---

## 中文簡介

Glossline 是 Windows 上的線上會議即時字幕＋翻譯工具。它同時聽兩邊：喇叭播出來的對方聲音，以及你自己的麥克風。兩邊各自送到 Soniox 做辨識與翻譯，字幕顯示在畫面上，同時把兩邊分別錄成音檔。

- 沒有提供編好的安裝檔，請照上面的步驟自己編譯。
- 聲音會即時送到 Soniox；錄音與字幕紀錄只存在你的電腦。
- Soniox 金鑰以**明文**存在設定檔裡。
- 錄音前請先取得與會者同意。

### 會後摘要

*這是簡單版，完整說明在 [docs/summary-workflow.zh-TW.md](docs/summary-workflow.zh-TW.md)。*

Glossline 本身不寫摘要。我們的做法公開，程式不公開：

- **一個 AI 寫，另一個 AI 挑錯。** 寫的那個逐條回字幕原文核對；否決一條要指出字幕哪一句。
- **程式把關，不是 AI 說了算。** 摘要引用的每個時間都要在字幕裡查得到、決議要分「有定調」和「只是提議」、每條挑錯都要回應，沒過就不出檔。
- **信心度攤開來。** 數字一律標「未回聽」。選配：讓能聽音檔的 AI 重聽可疑處三次，程式打燈號（🔴 🟡 ⚪）；只有人親耳聽過才給 🟢。
- **邊界：** 程式驗得到每條都回應了，驗不到回應對不對。

小樣本實測（5 場公司會議）：另一家 AI 單獨寫，決議＋待辦＋數字漏了 43%。詳見 [docs/summary-workflow.zh-TW.md](docs/summary-workflow.zh-TW.md)；給 AI 助手照做的手冊：[skills/meeting-summary/SKILL.zh-TW.md](skills/meeting-summary/SKILL.zh-TW.md)。
