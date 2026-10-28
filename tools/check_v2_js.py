#!/usr/bin/env python
# -*- coding: utf-8 -*-
r"""v2 前端的 JS 語法檢查。

存在的理由（實撞過）：<script type="module"> 只要**任何一支**被 import
的檔有語法錯，整張模組圖一次都不執行——畫面照樣把 HTML 與 CSS 畫出來、
看起來一切正常，只是所有互動都是死的。**零錯誤訊息**，除非有人開 devtools。
更糟的是 frontend-log.js 本身就在那張圖裡，所以連「把錯誤寫進 log」都失效。

而且 release 版會把前端**打包進 exe**，壞掉的那份會被燒進去、
下一次啟動才發現。這支腳本就是在燒進去之前攝住它。

用法（跟 cargo build 之前跑）：
    python.exe app\tools\check_v2_js.py

全過 -> exit 0；有錯 -> 印出檔名與錯誤 -> exit 1。
需要 node（僅用它的 --check，不執行任何程式碼）。
"""

import os
import shutil
import subprocess
import sys
import tempfile

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
V2_DIR = os.path.join(APP_DIR, "src", "v2")

# ⚠ 要掃整個 v2 底下，不能只掃 js/：
# vendor/ 的字典模組也在同一張模組圖裡，它壞掉一樣會讓整個前端不執行。
# 第一版只掃 js/，等於在網子上留了一個剛好夠那支 1 MB 檔案穿過去的洞。
SCAN_DIRS = [
    os.path.join(V2_DIR, "js"),
    os.path.join(V2_DIR, "vendor"),
]


def main():
    node = shutil.which("node")
    if not node:
        print("找不到 node，跳過檢查。")
        print("⚠ 這不是通過——只是沒有檢查。裝了 node 再跑一次。")
        return 0

    targets = []
    for d in SCAN_DIRS:
        if not os.path.isdir(d):
            continue
        rel = os.path.basename(d)
        for n in sorted(os.listdir(d)):
            if n.endswith(".js"):
                targets.append((rel + "/" + n, os.path.join(d, n)))
    names = [t[0] for t in targets]
    if not targets:
        print("X %s 底下一支 .js 都沒有，這本身就不對。" % V2_DIR)
        return 1

    bad = []
    tmp = tempfile.mkdtemp(prefix="v2jscheck-")
    try:
        for name, src in targets:
            # node --check 只把 .mjs 當 ES module；.js 會被當 CommonJS、
            # 於是 import/export 一律報錯——那是假警報，不是真的語法錯。
            dst = os.path.join(tmp, name.replace("/", "_") + ".mjs")
            shutil.copyfile(src, dst)
            proc = subprocess.run(
                [node, "--check", dst],
                capture_output=True,
                encoding="utf-8",
                errors="replace",
            )
            if proc.returncode == 0:
                print("  OK %s" % name)
            else:
                bad.append((name, (proc.stderr or proc.stdout or "").strip()))
                print("  X  %s" % name)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    if not bad:
        print("")
        print("%d 支全部通過。" % len(names))
        return 0

    print("")
    print("有語法錯，前端整張模組圖都不會執行：")
    for name, err in bad:
        print("--- %s ---" % name)
        print(err)
    return 1


if __name__ == "__main__":
    sys.exit(main())
