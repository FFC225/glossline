#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""三處版本號必須完全相同。

package.json / Cargo.toml / tauri.conf.json 各自記一份版本號，而三份對不上
**不會有任何錯誤訊息**：build 照樣過，只是「關於」頁說的版本跟 exe 屬性說的
不是同一個，事後問「你在跑哪一版」就問不出答案。

⚠ Cargo 走 semver，數字不准有前導零：`2026.09.15` 會讓 build 直接失敗
（這是好事，會當場炸）；`2026.9.15` 才對。本腳本一併擋前導零。

用法：python.exe app\\tools\\check_version_sync.py
回傳碼 0 = 三處相同且格式合法。
"""
import json
import re
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

APP = Path(__file__).resolve().parent.parent


def from_json(path, key):
    # 探測 BOM：讀一律 utf-8-sig，有無 BOM 都吃。
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    return data[key]


def from_cargo(path):
    # 只認 [package] 區段裡的 version，別撞到依賴的版本號。
    text = path.read_text(encoding="utf-8-sig")
    section = text.split("[package]", 1)[1].split("\n[", 1)[0]
    m = re.search(r'^version\s*=\s*"([^"]+)"', section, re.M)
    if not m:
        raise SystemExit("Cargo.toml 的 [package] 區段裡找不到 version")
    return m.group(1)


def main():
    found = {
        "package.json": from_json(APP / "package.json", "version"),
        "Cargo.toml": from_cargo(APP / "src-tauri" / "Cargo.toml"),
        "tauri.conf.json": from_json(APP / "src-tauri" / "tauri.conf.json", "version"),
    }
    for name, value in found.items():
        print(f"  {name:20s} {value}")

    values = set(found.values())
    ok = True
    if len(values) != 1:
        print("FAIL: 三處版本號不一致")
        ok = False
    version = found["Cargo.toml"]
    if version == "0.9.1":
        print("FAIL: 還停在上游的 0.9.1")
        ok = False
    for part in version.split("."):
        if len(part) > 1 and part.startswith("0"):
            print(f"FAIL: semver 不准前導零 —— '{part}'（Cargo build 會直接失敗）")
            ok = False
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        print(f"FAIL: 不是三段數字的 semver —— '{version}'")
        ok = False

    print("OK: 三處版本號完全相同" if ok else "")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
