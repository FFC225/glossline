#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""後端指令 vs 前端呼叫的機械盤點。

回答一件事：`lib.rs` 註冊的每一條 Tauri 指令，**新前端 `src/v2` 有沒有在用、
舊前端 `src/js` 有沒有在用**。要砍指令時照這張表砍，別憑記憶。

⚠ 這支只看「字串有沒有出現」，看不出動態組出來的指令名。
   實際砍之前仍要逐條看一眼呼叫點——但至少不會漏掉整條。

用法：
    python.exe app\\tools\\audit_commands.py
"""

import io
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

APP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIB_RS = os.path.join(APP, "src-tauri", "src", "lib.rs")
V2_DIR = os.path.join(APP, "src", "v2")
OLD_DIR = os.path.join(APP, "src", "js")
OLD_HTML = os.path.join(APP, "src", "index.html")


def read(path):
    with io.open(path, "r", encoding="utf-8-sig") as fh:
        return fh.read()


def handler_names():
    src = read(LIB_RS)
    m = re.search(r"generate_handler!\[(.*?)\]", src, re.S)
    if not m:
        raise SystemExit("找不到 generate_handler![...]")
    names = []
    for raw in m.group(1).split(","):
        raw = raw.strip()
        if not raw or raw.startswith("//"):
            continue
        names.append(raw.split("::")[-1])
    return names


def collect(paths_root, exts):
    blob = []
    for root, _dirs, files in os.walk(paths_root):
        for f in files:
            if os.path.splitext(f)[1] in exts:
                blob.append(read(os.path.join(root, f)))
    return "\n".join(blob)


def main():
    names = handler_names()
    v2 = collect(V2_DIR, {".js", ".html"})
    old = collect(OLD_DIR, {".js"}) + read(OLD_HTML)

    rows = []
    for n in names:
        pat = re.compile(r"['\"]" + re.escape(n) + r"['\"]")
        rows.append((n, bool(pat.search(v2)), bool(pat.search(old))))

    print("指令總數：%d\n" % len(names))
    print("| 指令 | v2 有用 | 舊前端有用 | 清理批次 |")
    print("|---|---|---|---|")
    keep = dead = removable = 0
    for n, in_v2, in_old in rows:
        if in_v2:
            verdict = "留"
            keep += 1
        elif in_old:
            verdict = "**砍**（只有舊前端在用）"
            removable += 1
        else:
            verdict = "**砍**（兩邊都沒人用）"
            dead += 1
        print("| `%s` | %s | %s | %s |" % (n, "V" if in_v2 else "-", "V" if in_old else "-", verdict))

    print("\n留 %d／只有舊前端用 %d／兩邊都沒人用 %d" % (keep, removable, dead))
    return 0


if __name__ == "__main__":
    sys.exit(main())
