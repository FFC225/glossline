#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""反向測試：故意弄壞 window-shell.js，確認新的那張網真的會紅。

規矩來自本專案第十四輪的教訓——第一張測試網說「全部 PASS」，故意弄壞三處卻三次都
沒抓到，破的不是程式碼、是測試涵蓋。所以每張新網都要用這種方式驗過才算數。

用法（跑完會自動還原原檔，用位元組比對確認還原成功）：
    python.exe app\\tools\\_break_window_shell.py
"""

import io
import os
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGET = os.path.join(APP, "src", "v2", "js", "window-shell.js")
TEST = os.path.join(APP, "tools", "test_window_shell.mjs")
NODE = r"C:\Program Files\nodejs\node.exe"

CASES = [
    (
        "尺寸太小時直接丟掉（而不是夾到下限）",
        "  return { w: Math.max(MIN_SIZE.w, Math.round(w)), h: Math.max(MIN_SIZE.h, Math.round(h)) };",
        "  return { w: Math.round(w), h: Math.round(h) };",
    ),
    (
        "模式亂字串原樣放行",
        "  return value === 'expanded' ? 'expanded' : 'overlay';",
        "  return value || 'overlay';",
    ),
    (
        "兩個模式共用同一格尺寸",
        "  const saved = sanitizeSize(settings ? settings[SIZE_KEY[m]] : null);",
        "  const saved = sanitizeSize(settings ? settings[SIZE_KEY.overlay] : null);",
    ),
    (
        "有彈窗開著照樣收起外殼",
        "  return Boolean(capturing) && !modalOpen;",
        "  return Boolean(capturing);",
    ),
    (
        "拿掉「大到不可能是螢幕」的上限",
        "  if (w <= 0 || h <= 0 || w > 20000 || h > 20000) return null;",
        "  if (w <= 0 || h <= 0) return null;",
    ),
    (
        "符合螢幕：螢幕座標忘了除以縮放比例",
        "    x: Math.floor(monitor.x / scale + (logicalW - w) / 2),",
        "    x: Math.floor(monitor.x + (logicalW - w) / 2),",
    ),
    (
        "符合螢幕：不夾視窗下限（小螢幕上會縮成一條）",
        "  const w = Math.max(MIN_SIZE.w, Math.floor(logicalW * 0.94));",
        "  const w = Math.floor(logicalW * 0.94);",
    ),
]

# ⚠ 試過但**故意不放進來**的一個案例：把 `typeof raw !== 'object'` 那道守衛拿掉。
#   拿掉之後測試照樣全綠——不是網子有洞，是那道守衛本來就多餘：後面的
#   `Number.isFinite` 對字串、陣列、數字都會回 null，兩種寫法對真實輸入完全同義。
#   留著它是防禦性寫法，**不是一個被驗證過的保險**。這跟 Rust 端遇過的那件事同一種：
#   測試綠只證明「這條路沒斷」，證不了「我以為的那個保險正在發揮作用」。


def run_test():
    proc = subprocess.run(
        [NODE, TEST], capture_output=True, encoding="utf-8", errors="replace"
    )
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def main():
    with io.open(TARGET, "rb") as fh:
        original = fh.read()

    code, out = run_test()
    print("[基準] 未動手前：exit=%d" % code)
    if code != 0:
        print(out)
        return 1

    caught = 0
    try:
        for name, needle, replacement in CASES:
            text = original.decode("utf-8")
            if text.count(needle) != 1:
                print("X 破壞案例對不到唯一一處：%s" % name)
                return 1
            broken = text.replace(needle, replacement)
            with io.open(TARGET, "wb") as fh:
                fh.write(broken.encode("utf-8"))
            code, out = run_test()
            if code == 0:
                print("X 沒抓到：%s  <- 這張網對這種壞法是瞎的" % name)
            else:
                first = [l for l in out.splitlines() if l.startswith("  X ")]
                print("OK 抓到：%s（%s）" % (name, first[0].strip() if first else "exit!=0"))
                caught += 1
    finally:
        with io.open(TARGET, "wb") as fh:
            fh.write(original)

    with io.open(TARGET, "rb") as fh:
        assert fh.read() == original, "還原失敗！原檔已被改壞"
    code, _ = run_test()
    print("[還原] 位元組一致，重跑測試 exit=%d" % code)
    print("\n%d / %d 個破壞案例被抓到。" % (caught, len(CASES)))
    return 0 if caught == len(CASES) and code == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
