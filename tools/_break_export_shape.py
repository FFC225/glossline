"""反向測試：故意弄壞匯出格式，確認 cargo test 那張網真的會紅。

跑法（⚠ 用你確定的那支 python 的絕對路徑，別信 PATH 上的 `python`）：
  <python.exe 的絕對路徑> app\\tools\\_break_export_shape.py

做的事：對 `session_store.rs` 逐一套用下面五個破壞、每次跑一遍 `cargo test --lib`、
再把檔案還原成位元組一致。**跑完不會留下任何改動**（`finally` 保證還原）。

為什麼要有這支：測試全綠只證明「這條路沒斷」，證不了「我以為的那道保險正在發揮作用」。
實測就抓到過一個「拿掉守衛、測試照樣全綠」的案例——那道守衛其實是多餘的。

⚠ 讀 cargo 的輸出一定要 `encoding='utf-8', errors='replace'`：
   預設會用 cp950 解，撞到中文測試名稱就整個執行緒炸掉，而且錯誤看起來像 python 的 bug。
"""

import hashlib
import io
import os
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8")

# cargo 不一定在 PATH 上（例如某些 shell），所以先找 rustup 的預設位置。
CARGO = os.path.join(os.path.expanduser("~"), ".cargo", "bin", "cargo.exe")
if not os.path.exists(CARGO):
    CARGO = "cargo"
HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.dirname(HERE)
TARGET = os.path.join(APP, "src-tauri", "src", "commands", "session_store.rs")
MANIFEST = os.path.join(APP, "src-tauri", "Cargo.toml")

BS_N = chr(92) + "n"  # 「反斜線 n」兩個字元。別寫成跳脫字元，會被吃掉。

BREAKS = [
    (
        "① 拿掉「譯文和原文一樣就不算譯文」那道",
        "Some(t) if !t.trim().is_empty() && t.trim() != self.src.trim() => Some(t),",
        "Some(t) if !t.trim().is_empty() => Some(t),",
    ),
    (
        "② 沒有譯文時仍硬塞兩行",
        'None => format!("{}{}", tag, self.display_text().trim()),',
        'None => format!("{}{}%s{}", tag, self.display_text().trim(), self.display_text().trim()),' % BS_N,
    ),
    (
        "③ who 認不得時給個假標籤",
        '            _ => "",',
        '            _ => "未知",',
    ),
    (
        "④ ＝原文 改成重印一次原文",
        'None => "＝原文".to_string(),',
        "None => self.src.trim().to_string(),",
    ),
    (
        "⑥ 拿掉每格字幕的下限（0.08 秒那種閃一下就沒了）",
        "start + natural.clamp(MIN_CUE_MS, MAX_CUE_MS)",
        "start + natural.min(MAX_CUE_MS)",
    ),
    (
        "⑦ 拿掉每格字幕的上限（沉默兩分鐘＝字幕掛兩分鐘）",
        "start + natural.clamp(MIN_CUE_MS, MAX_CUE_MS)",
        "start + natural.max(MIN_CUE_MS)",
    ),
    (
        "⑧ 同一毫秒的兩句改回不算「有下一句」",
        "Some(n) if n >= start => n - start,",
        "Some(n) if n > start => n - start,",
    ),
    (
        "⑨ 字幕拿掉「誰講的」標籤",
        '            label => format!("【{}】", label),',
        "            _label => String::new(),",
    ),
    (
        "⑤ 四欄的分隔符改掉",
        'format!("{} ｜ {} ｜ {}", head, self.src.trim(), tgt)',
        'format!("{} | {} | {}", head, self.src.trim(), tgt)',
    ),
]


def run_tests():
    return subprocess.run(
        [CARGO, "test", "--lib", "--manifest-path", MANIFEST],
        capture_output=True,
        encoding="utf-8",
        errors="replace",
    ).returncode


def main():
    orig = io.open(TARGET, "rb").read()
    digest = hashlib.sha256(orig).hexdigest()
    src = orig.decode("utf-8")

    if run_tests() != 0:
        print("⚠ 還沒弄壞就是紅的。先把測試修綠，這支才有意義。")
        return 1

    print("弄壞之前：全綠")
    all_caught = True
    try:
        for name, old, new in BREAKS:
            if src.count(old) != 1:
                print("⚠ 對不上原始碼（找到 %d 處）：%s" % (src.count(old), name))
                all_caught = False
                continue
            io.open(TARGET, "w", encoding="utf-8", newline="").write(src.replace(old, new, 1))
            caught = run_tests() != 0
            all_caught = all_caught and caught
            print(("✅ 抓到   " if caught else "⚠ 沒抓到 ") + name)
    finally:
        io.open(TARGET, "wb").write(orig)

    same = hashlib.sha256(io.open(TARGET, "rb").read()).hexdigest() == digest
    print("還原後位元組一致：", same)
    print("還原後重跑：", "PASS" if run_tests() == 0 else "FAIL")
    return 0 if (all_caught and same) else 1


if __name__ == "__main__":
    sys.exit(main())
