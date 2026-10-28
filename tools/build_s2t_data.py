# -*- coding: utf-8 -*-
r"""把 OpenCC 的簡→繁（台灣用詞）字典轉成前端可直接 import 的模組。

為什麼要轉一手，不直接放 .txt：
  前端沒有打包器（tauri.conf.json 的 frontendDist 直接指 ../src），
  要讀 .txt 就得走 fetch，而那條路在 Tauri 的 asset 協定下多一層可能安靜失敗的環節。
  轉成 ES module 之後，載入方式跟其他 v2 檔一模一樣，
  而且會被 check_v2_js.py 一起看顧——壞了會在建置前擋下來，不會等到會議中才發現。

## 三階段，照官方 s2twp.json 的 conversion_chain 逐字抄

    階段 1（S2T）：group[ STPhrases, STCharacters ]   简 → 繁
    階段 2（TWP）：TWPhrases                          繁 → 台灣用詞（軟件→軟體）
    階段 3（TWV）：TWVariants                         繁 → 台灣字形（裏→裡、麪→麵）

⚠ **更正過**：前一版是**兩階段**，而且第 2 階段把 TWPhrases、TWVariants
  再加一份 `TWVariantsPhrases` 合併成一張表。三個問題：
    1. 官方 s2twp.json 的鏈裡**根本沒有 TWVariantsPhrases**（那份是反方向的
       `TWVariantsRevPhrases`，台灣字形 → 通用字形）。合進來等於把反向條目
       摻進正向表，實際留下兩條（`純喫茶`、`喫茶小舖`）。
    2. 合併之後 TWPhrases 的條目會被同表的其他條目蓋掉——實際少掉 `文本 → 文字`
       這類真的會用到的在地化。1,403 行真實會議逐字稿的比對裡，
       **唯一一種跟 Python 版不一致的地方就是它**。
    3. 階段合併本身會改變結果：官方是「先整段跑完 TWPhrases，再整段跑 TWVariants」，
       合成一張表就變成逐位置二選一。
  → 現在照官方鏈拆回三階段、來源只用官方那四個檔。

⚠ **一定要分階段、不能壓成一張表**：後面階段的 key 是**繁體**詞。
  像「打印」這種簡繁同形的詞，在階段 1 完全不會被碰到（它本來就長那樣），
  只有到了階段 2 才會被 `打印 → 列印` 抓到。
  若把表壓成一張、只掃一次，這類詞永遠不會被在地化，**而且不會有任何徵兆**。

⚠⚠ **詞級表的 key == value 條目絕對不能丟**（實撞過）：
    第一版為了省空間把它們全丟了，結果 `公里` 被轉成 `公裏`。
    那些條目不是廢話，是**保護條目**——STPhrases 第 5778 行就寫著 `公里→公里`，
    存在的唯一目的就是攔住字級規則（STCharacters 第 2125 行 `里 → 裏 里 哩`）。
    丟掉保護條目 ＝ 把字級規則放進所有它本來管不到的詞裡，而且**不會有任何錯誤訊息**，
    只是譯文裡多幾個怪字。字級表的 key == value 丟掉無害（沒命中就原字照抄）。

⚠ **跟 Python 版仍有一處結構差異（已知、不是漏看）**：官方 s2twp.json 還帶一個
  `segmentation`（mmseg，用 STPhrases 當詞庫）——先斷詞再逐詞轉。我們是逐位置最長匹配。
  兩者在真實語句上量不出差別（實測 1,403 行、83,886 字，零差異），
  差別只出現在拿字典 key 當輸入的極端語料上，而且**那些個案 Python 不見得比較對**
  （例：`不断发现` Python 斷成 `不断/发现` 之前先命中 `断发`，吐出「不斷髮現」）。

來源：OpenCC 官方字典。本機現成的一份在 Python opencc 套件裡：
  <site-packages>\opencc\dictionary\{STCharacters,STPhrases,TWPhrases,TWVariants}.txt
授權：Apache-2.0（原始檔頭聲明；本檔為其衍生資料，授權不變）

用法（給字典**資料夾**，四個檔名固定）：
    python.exe app\tools\build_s2t_data.py <opencc 的 dictionary 資料夾>
不給參數時自動找本機 Python 的 opencc 套件。
"""

import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

OUT = Path(__file__).resolve().parent.parent / "src" / "v2" / "vendor" / "opencc-s2t-data.js"

TAB = chr(9)
LF = chr(10)
BACKTICK = chr(96)
BACKSLASH = chr(92)


def load(path: Path, drop_identity: bool):
    """讀一份 OpenCC 字典。drop_identity=False 時保留 key==value 的保護條目。"""
    pairs = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        if TAB not in line:
            continue
        key, values = line.split(TAB, 1)
        value = values.split(" ")[0].strip()
        key = key.strip()
        if not key or not value:
            continue
        if drop_identity and key == value:
            continue
        pairs.append((key, value))
    return pairs


def merge(*pair_lists):
    """後面的覆蓋前面的（同一階段內：字級先放、詞級後放，讓詞級蓋過字級）。"""
    table = {}
    for pairs in pair_lists:
        for k, v in pairs:
            table[k] = v
    return table


def check_safe(table, label):
    """模板字串裝得下嗎。中文字典理論上不會有這些字元，但「理論上不會」
    正是本專案一路在踩的那種話——真的檢查一次。"""
    bad = [
        s
        for s in list(table.keys()) + list(table.values())
        if BACKTICK in s or "${" in s or BACKSLASH in s
    ]
    if bad:
        print(f"X {label} 裡有會撐破模板字串的字元，前 5 個：", bad[:5])
        return False
    return True


def emit(name, table):
    longest = max(len(k) for k in table)
    body = LF.join(k + TAB + v for k, v in sorted(table.items()))
    return (
        "export const " + name + "_MAX_KEY_LEN = " + str(longest) + ";" + LF
        + LF
        + "export const " + name + "_TABLE_RAW = " + BACKTICK + LF + body + LF + BACKTICK + ";" + LF
    ), longest


def find_default_dir():
    try:
        import opencc
    except ImportError:
        return None
    d = Path(opencc.__file__).resolve().parent / "dictionary"
    return d if d.is_dir() else None


def main():
    if len(sys.argv) == 2:
        d = Path(sys.argv[1])
    elif len(sys.argv) == 1:
        d = find_default_dir()
        if d is None:
            print(__doc__)
            return 1
        print(f"沒給路徑，用本機 opencc 套件的字典：{d}")
    else:
        print(__doc__)
        return 1

    need = ["STCharacters", "STPhrases", "TWPhrases", "TWVariants"]
    missing = [n for n in need if not (d / (n + ".txt")).is_file()]
    if missing:
        print("X 這個資料夾缺檔：", missing)
        return 1

    st_chars = load(d / "STCharacters.txt", drop_identity=True)   # 字級：identity 可丟
    st_phrases = load(d / "STPhrases.txt", drop_identity=False)   # 詞級：identity 是保護條目
    tw_phrases = load(d / "TWPhrases.txt", drop_identity=False)
    tw_variants = load(d / "TWVariants.txt", drop_identity=True)

    s2t = merge(st_chars, st_phrases)
    twp = merge(tw_phrases)
    twv = merge(tw_variants)

    protective_s2t = sum(1 for k, v in st_phrases if k == v)
    print(f"階段 1（S2T）：字級 {len(st_chars)} ＋ 詞級 {len(st_phrases)}"
          f"（保護條目 {protective_s2t}）→ 合併 {len(s2t)} 條")
    print(f"階段 2（TWP）：台灣用詞 {len(twp)} 條")
    print(f"階段 3（TWV）：台灣字形 {len(twv)} 條")

    for table, label in ((s2t, "S2T"), (twp, "TWP"), (twv, "TWV")):
        if not check_safe(table, label):
            return 1

    header = (
        "/**" + LF
        + " * OpenCC 簡→繁（台灣用詞）對照表（自動產生，請勿手改）。" + LF
        + " *" + LF
        + " * 產生器：app/tools/build_s2t_data.py" + LF
        + " * 來源：https://github.com/BYVoid/OpenCC  data/dictionary/" + LF
        + " * 授權：Apache-2.0（原始檔頭聲明；本檔為其衍生資料，授權不變）" + LF
        + " *" + LF
        + " * 三張表 == 官方 s2twp.json 的 conversion_chain 三個階段，順序不可對調：" + LF
        + " *   S2T：STPhrases ＋ STCharacters（简→繁）" + LF
        + " *   TWP：TWPhrases（繁→台灣用詞，軟件→軟體、文本→文字）" + LF
        + " *   TWV：TWVariants（繁→台灣字形，裏→裡、麪→麵）" + LF
        + " * ⚠ 必須依序跑三階段。壓成一張表只掃一次的話，" + LF
        + " *   「打印」這種簡繁同形的詞永遠不會被在地化，而且不會有任何徵兆。" + LF
        + " *" + LF
        + " * 格式：一行一條，key<TAB>value。" + LF
        + " */" + LF
    )

    parts = [header]
    lens = {}
    for name, table in (("S2T", s2t), ("TWP", twp), ("TWV", twv)):
        js, longest = emit(name, table)
        lens[name] = longest
        parts.append(LF)
        parts.append(js)
    js = "".join(parts)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    # vendored 資料檔保留 LF（app/ 底下我們自己寫的程式碼是 CRLF，
    # 這一份是第三方資料的衍生物，而且 CRLF 會讓它多長 50 KB 以上）
    OUT.write_bytes(js.encode("utf-8"))
    print(f"寫出 {OUT}  {OUT.stat().st_size} bytes"
          f"（最長 key：S2T {lens['S2T']} 字、TWP {lens['TWP']} 字、TWV {lens['TWV']} 字）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
