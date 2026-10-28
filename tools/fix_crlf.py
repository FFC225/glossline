#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把指定的檔案正規化成 CRLF，並保留原本有沒有 BOM。

存在的理由：app/ 底下全部是 CRLF，但編輯工具寫回去可能變成 LF——
混行尾不會噴任何錯，只會讓下一次 git diff 整檔重寫、看不出真正改了什麼。

用法：
    python.exe app\\tools\\fix_crlf.py <檔案...>
不給參數就只檢查、不動任何檔（列出目前每個檔的行尾統計）。
"""

import codecs
import io
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


def stats(data):
    crlf = data.count(b"\r\n")
    lf = data.count(b"\n") - crlf
    cr = data.count(b"\r") - crlf
    return crlf, lf, cr


def to_crlf(path):
    with io.open(path, "rb") as fh:
        data = fh.read()
    before = stats(data)
    # 先全部拉成 LF 再一次換成 CRLF，避免既有的 CRLF 變成 CR CR LF
    normalized = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n").replace(b"\n", b"\r\n")
    changed = normalized != data
    if changed:
        with io.open(path, "wb") as fh:
            fh.write(normalized)
    after = stats(normalized)
    has_bom = data[:3] == codecs.BOM_UTF8
    print(
        "%s  CRLF %d / LF %d / CR %d  ->  CRLF %d%s%s"
        % (
            os.path.relpath(path),
            before[0],
            before[1],
            before[2],
            after[0],
            "  [BOM]" if has_bom else "",
            "  (已改寫)" if changed else "  (本來就對)",
        )
    )
    return changed


def main(argv):
    if not argv:
        print("沒有給檔案，什麼都沒做。")
        return 0
    for path in argv:
        to_crlf(path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
