# -*- coding: utf-8 -*-
r"""前端 s2t.js 與 Python 版 `opencc.OpenCC('s2twp')` 逐條對照。

存在的理由：專案規定所有中文輸出要無條件過一次 `s2twp`，
但**前端是 JS、當初只驗過 Python 版**。「JS 這支跟 Python 那支等價」不是可以用眼睛
看出來的事——兩邊的字典來源、階段數、匹配方式只要差一點，結果就會在某些詞上分岔，
而分岔的樣子是**畫面上多幾個怪字，零錯誤訊息**。所以要跑一次真的比對。

跑四批語料，每一條都拿去給兩邊各轉一次，字串必須一模一樣：
  A  CJK 基本區全部單字（U+4E00–U+9FFF，20,992 條）
  B  前端 S2T 表的全部 key（≈53,000 條，含詞級與字級）
  C  前端 TWP／TWV 表的全部 key（548 條）
  D  自己的真實逐字稿（選用：`--corpus <資料夾>` 底下的 .md／.txt 先轉成簡體，再兩邊各自轉回繁體）

⚠ **D 這批才是決策依據**，A/B/C 是拿字典 key 當輸入的極端語料。
  （前一版程式在 A/B/C 上有 1,076 條分岔、D 上有一種分岔；
   改成照官方三階段鏈之後四批全部歸零。）

用法：
    python.exe app\tools\verify_s2t_vs_opencc.py [--corpus <放逐字稿的資料夾>]
沒給 --corpus 就只跑 A/B/C，D 那批會明白印出「跳過」。
需要：本機的 Python `opencc` 套件（字典也從它那裡拿）、node。
全部一致 → exit 0；有任何一條不一致 → 印出前 30 條 → exit 1。
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

APP_DIR = Path(__file__).resolve().parent.parent
VENDOR = APP_DIR / "src" / "v2" / "vendor" / "opencc-s2t-data.js"
S2T_JS = APP_DIR / "src" / "v2" / "js" / "s2t.js"

TAB = chr(9)


def table_keys(raw, name):
    m = re.search("export const " + name + r"_TABLE_RAW = `\n(.*?)\n`;", raw, re.S)
    if not m:
        return None
    return [line[: line.index(TAB)] for line in m.group(1).split("\n") if TAB in line]


def build_corpus():
    raw = VENDOR.read_text(encoding="utf-8")
    batches = []

    batches.append(("A 單字", [chr(cp) for cp in range(0x4E00, 0xA000)]))

    s2t = table_keys(raw, "S2T")
    if s2t is None:
        print("X vendor 檔裡找不到 S2T 表——字典模組的形狀變了，這支要跟著改。")
        return None
    batches.append(("B S2T 表的 key", s2t))

    tw = []
    for name in ("TWP", "TWV"):
        keys = table_keys(raw, name)
        if keys is None:
            print("X vendor 檔裡找不到 %s 表——三階段鏈被改動了，先確認是不是故意的。" % name)
            return None
        tw += keys
    batches.append(("C TWP/TWV 表的 key", tw))

    real = []
    corpus = Path(sys.argv[sys.argv.index("--corpus") + 1]) if "--corpus" in sys.argv else None
    if corpus is None:
        print("－ D 真實逐字稿：沒給 --corpus，跳過（只驗 A/B/C）")
    elif not corpus.is_dir():
        print("X --corpus 指的資料夾不存在：%s" % corpus)
        return None
    for pat in ("*.md", "*.txt") if corpus else ():
        for p in sorted(corpus.rglob(pat)):
            for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
                line = line.strip().replace(TAB, " ")
                if line and any("\u4e00" <= c <= "\u9fff" for c in line):
                    real.append(line)
    if corpus:
        batches.append(("D 真實逐字稿", real))
    return batches


def main():
    node = shutil.which("node")
    if not node:
        print("找不到 node。⚠ 這不是通過——只是沒有檢查。")
        return 1
    try:
        import opencc
    except ImportError:
        print("找不到 Python 的 opencc 套件。⚠ 這不是通過——只是沒有檢查。")
        return 1

    batches = build_corpus()
    if batches is None:
        return 1

    to_simp = opencc.OpenCC("tw2sp")
    s2twp = opencc.OpenCC("s2twp")

    # D 那批是繁體的真稿，要先轉成簡體才像 Soniox 吐出來的東西
    items = []
    marks = []
    for label, lines in batches:
        for line in lines:
            text = to_simp.convert(line) if label.startswith("D") else line
            if not text or "\n" in text or "\r" in text or TAB in text:
                continue
            items.append(text)
            marks.append(label)

    py_out = [s2twp.convert(x) for x in items]

    tmp = Path(tempfile.mkdtemp(prefix="s2tverify-"))
    try:
        (tmp / "corpus.txt").write_text("\n".join(items), encoding="utf-8")
        runner = tmp / "run.mjs"
        runner.write_text(
            "import { readFileSync, writeFileSync } from 'node:fs';\n"
            "import { toTraditional } from %s;\n"
            "const lines = readFileSync(%s, 'utf8').split('\\n');\n"
            "writeFileSync(%s, lines.map(toTraditional).join('\\n'), 'utf8');\n"
            % (
                json.dumps(S2T_JS.as_uri()),
                json.dumps(str(tmp / "corpus.txt")),
                json.dumps(str(tmp / "js_out.txt")),
            ),
            encoding="utf-8",
        )
        proc = subprocess.run(
            [node, str(runner)], capture_output=True, encoding="utf-8", errors="replace"
        )
        if proc.returncode != 0:
            print("X node 跑不起來：\n" + (proc.stderr or proc.stdout))
            return 1
        js_out = (tmp / "js_out.txt").read_text(encoding="utf-8").split("\n")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    if len(js_out) != len(py_out):
        print("X 兩邊條目數對不上：py %d、js %d" % (len(py_out), len(js_out)))
        return 1

    stats = {}
    bad = []
    for label, src, p, j in zip(marks, items, py_out, js_out):
        tot, err = stats.get(label, (0, 0))
        if p != j:
            err += 1
            bad.append((label, src, p, j))
        stats[label] = (tot + 1, err)

    for label in sorted(stats):
        tot, err = stats[label]
        flag = "OK " if err == 0 else "X  "
        print("  %s%-22s %6d 條，不一致 %d" % (flag, label, tot, err))

    if bad:
        print("\n不一致（前 30 條）：")
        for label, src, p, j in bad[:30]:
            print("  [%s] 原「%s」\n      py「%s」\n      js「%s」" % (label, src, p, j))
        print("\nX 共 %d 條不一致。繁體轉換這一關沒過。" % len(bad))
        return 1

    print("\nOK %d 批共 %d 條全部一致。" % (len(batches), len(items)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
