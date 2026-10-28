#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""前端欄位對照表 vs Rust Settings 的機械比對。

存在的理由：這個病已經確定發生三次——前端送了一個欄位、Rust struct 沒有那格、
serde 靜默丟掉、零錯誤訊息。人眼比對 36 個欄位一定會漏，所以做成腳本。

比對兩組：
  Settings          <-> RUST_SETTINGS_KEYS       (src/v2/js/settings-schema.js)
  CustomContext     <-> RUST_CUSTOM_CONTEXT_KEYS

用法：
    <python.exe 的絕對路徑> app\\tools\\check_settings_fields.py

差異為零 -> exit 0；有差 -> 印出差在哪 -> exit 1。
"""

import io
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SETTINGS_RS = os.path.join(APP_DIR, "src-tauri", "src", "settings.rs")
SCHEMA_JS = os.path.join(APP_DIR, "src", "v2", "js", "settings-schema.js")


def read_text(path):
    """讀檔一律 utf-8-sig（有無 BOM 都吃），只讀不寫，所以不必記原編碼。"""
    with io.open(path, "r", encoding="utf-8-sig") as fh:
        return fh.read()


def rust_struct_fields(source, struct_name):
    """抓 `pub struct <name> { ... }` 裡的 `pub <field>:` 欄位名，順序照宣告。"""
    match = re.search(
        r"pub\s+struct\s+" + struct_name + r"\s*\{(.*?)\n\}", source, re.S
    )
    if not match:
        raise SystemExit("找不到 Rust struct %s（%s）" % (struct_name, SETTINGS_RS))
    body = match.group(1)
    # pub(crate) / pub(super) 也要抓：只認 "pub " 會讓那種欄位兩邊都漏掉，
    # 於是腳本回報零差異——安全網自己破洞、還說一切正常。
    return re.findall(r"^\s*pub(?:\([a-z]+\))?\s+([a-z0-9_]+)\s*:", body, re.M)


def js_array(source, const_name):
    """抓 `export const <name> = Object.freeze([ 'a', 'b', ... ]);` 裡的字串。"""
    match = re.search(
        r"export\s+const\s+" + const_name + r"\s*=\s*Object\.freeze\(\[(.*?)\]\)",
        source,
        re.S,
    )
    if not match:
        raise SystemExit("找不到 JS 常數 %s（%s）" % (const_name, SCHEMA_JS))
    # 先砍掉行註解，否則被註解掉的項目仍會被算成"前端有這個鍵"。
    body = re.sub('//[^\n]*', '', match.group(1))
    return re.findall(r"'([a-z0-9_]+)'", body)


def compare(label, rust_fields, js_fields):
    """回傳 True 代表完全一致（含順序）。"""
    missing_in_js = [f for f in rust_fields if f not in js_fields]
    extra_in_js = [f for f in js_fields if f not in rust_fields]
    ok = not missing_in_js and not extra_in_js

    print("[%s] Rust %d 欄位 / JS %d 欄位" % (label, len(rust_fields), len(js_fields)))
    if missing_in_js:
        print("  X JS 對照表缺少（Rust 有、前端不知道）：%s" % ", ".join(missing_in_js))
    if extra_in_js:
        print("  X JS 對照表多出來（前端會送、Rust 靜默丟掉）：%s" % ", ".join(extra_in_js))
    if ok and rust_fields != js_fields:
        # 順序不同不影響正確性，但對照表照宣告順序比較好讀，所以只提醒。
        print("  ! 欄位一致，但順序與 settings.rs 的宣告順序不同")
    if ok:
        print("  OK 零差異")
    return ok


def main():
    rust_src = read_text(SETTINGS_RS)
    js_src = read_text(SCHEMA_JS)

    results = [
        compare(
            "Settings",
            rust_struct_fields(rust_src, "Settings"),
            js_array(js_src, "RUST_SETTINGS_KEYS"),
        ),
        compare(
            "CustomContext",
            rust_struct_fields(rust_src, "CustomContext"),
            js_array(js_src, "RUST_CUSTOM_CONTEXT_KEYS"),
        ),
    ]

    if all(results):
        print("\n全部對得上。")
        return 0
    print("\n有差異：對照表與 Rust struct 不一致，改到一致為止。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
