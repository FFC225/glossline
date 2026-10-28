#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""從既有逐字稿撈「硬詞表」候選。

方向是：「會議越開越多，把常出現的詞總結出來加進詞表」。
這支做的就是那件事的前半 —— 撈候選，**不自動填**。填不填、填哪些是人決定的。

⚠ 這支解決的是「聽錯專有名詞」，不是「翻譯品質」。詞表讓 Soniox 認得人名／公司／
  料號／縮寫；一般句子的翻譯、語氣、長句結構不會因為詞表而改變。

判準（四類：人名／公司／產品／料號）：
  A. 全大寫縮寫        API、SKU、ERP、QC
  B. 大寫開頭的專名    Alice、Purchasing、Acme（含連續兩字的 "Purchasing Budget"）
  C. 英數混合的料號    Z-1001、XY300、X30

⚠ 三件這支**刻意不做**的事：
  1. **不自動寫進設定**。詞表被誰改過要看得見，自動寫會讓「誰加的」這件事消失。
  2. **不判斷「這個詞重不重要」**。次數是唯一的排序依據，判斷留給人。
  3. **不去重既有詞表**。真正的詞表只有 App 讀得到
     （從別的程式或殼層讀 `%APPDATA%`
     看到的是影子副本），所以輸出時只能提醒人自己對一眼。

⚠ **輸出檔含公司會議的專有名詞**，預設不寫進專案目錄；要留的話自己挑地方，別提交。

用法：
    python.exe app\\tools\\suggest_terms.py 錄音檔 --out C:\\path\\candidates.txt
    python.exe app\\tools\\suggest_terms.py --selftest
"""

import argparse
import re
import sys
from collections import Counter
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

# `context` 整包的上限（官方 docs/stt/concepts/context）。不能只進不出。
CONTEXT_CHAR_LIMIT = 10000

# 大寫開頭但幾乎一定不是專有名詞的字。
# ⚠ 這張表是**降雜訊**用的，寧可漏掉幾個也別讓清單長到沒人看——
#   漏掉的詞下次開會還會再出現，而一份 400 筆的候選清單是不會有人讀的。
STOPWORDS = {
    # 句首最常見的
    "the", "this", "that", "these", "those", "there", "then", "they", "them",
    "and", "but", "so", "or", "if", "because", "when", "while", "what", "which",
    "who", "how", "why", "where", "we", "i", "you", "he", "she", "it", "his",
    "her", "our", "your", "their", "my", "me", "us", "him",
    "is", "are", "was", "were", "be", "been", "being", "am",
    "do", "does", "did", "done", "have", "has", "had",
    "will", "would", "can", "could", "shall", "should", "may", "might", "must",
    "let", "lets", "get", "got", "go", "going", "come", "came",
    "a", "an", "of", "in", "on", "at", "to", "for", "with", "from", "by",
    "as", "about", "into", "over", "after", "before", "up", "down", "out",
    # 會議口語
    "ok", "okay", "yes", "no", "yeah", "right", "sure", "well", "just", "now",
    "here", "also", "very", "really", "actually", "maybe", "please", "thanks",
    "thank", "sorry", "hello", "hi", "bye", "good", "great", "fine",
    "one", "two", "three", "four", "five", "first", "second", "next", "last",
    "all", "some", "any", "more", "most", "much", "many", "not", "don", "doesn",
    "let's", "i'm", "it's", "that's", "we're", "you're", "there's",
    # 逐字稿檔案本身的欄位字（不是會議內容）
    "speaker", "them", "me", "original", "translation", "time", "source",
    # ⭐ 逐字稿**工具**插進去的標記，不是任何人講過的話。
    #   這一批是對真實素材跑第一次才露出來的——它們佔滿了候選清單的
    #   前五名（AUDIO 348 次、HEARD 282 次…），把真正的術語擠到看不見的地方。
    #   📌 教訓：這種工具的停用詞表**只能靠跑真實資料長出來**，
    #      憑空想是想不到「逐字稿裡會有 [NO AUDIO] 這種東西」的。
    #   ⚠ 只擋全大寫那一路（`RE_ACRONYM`）；小寫的 "the answer is" 不受影響。
    "audio", "heard", "answer", "unclear", "none", "readme", "todo", "fixme",
    "note", "warn", "info", "error", "debug", "null", "true", "false",
    "inaudible", "crosstalk", "silence", "music", "laughter",
}

# 逐字稿工具切出來的分片檔。整場的稿已經有一份完整的，分片會把同一句話重複計數。
SKIP_NAME_PARTS = ("slice", "剔除清單")

RE_ACRONYM = re.compile(r"\b[A-Z]{2,8}\b")
RE_PARTNO = re.compile(r"\b[A-Za-z]{1,6}[-–]?\d{2,6}[A-Za-z0-9\-]*\b")
# 連續的大寫開頭字（最多三個），這樣 "Purchasing Budget" 會被當成一個候選。
RE_PROPER = re.compile(r"\b[A-Z][a-z]{1,}(?:\s+[A-Z][a-z]{1,}){0,2}\b")


def classify_and_extract(text):
    """從一段文字撈候選，回傳 {類別: Counter}。

    刻意分三類回傳而不是混成一張表：三類的誤判率差很多
    （料號幾乎不會誤判、大寫開頭的專名最容易撈到句首的普通字），
    混在一起會讓人用同一個標準看它們，而那個標準只能遷就最差的那類。
    """
    out = {"縮寫": Counter(), "專名": Counter(), "料號": Counter()}

    for m in RE_PARTNO.finditer(text):
        # ⚠ 這裡**刻意沒有**「太短就丟掉」的過濾。
        #   原本寫了一條砍 4 字以內的，結果把 `X30` 這種真料號一起砍了，
        #   而它要防的年份／金額根本進不來（樣式要求開頭至少一個字母）。
        #   selftest 的「X30 算料號」就是釘這件事的。太短的雜訊靠 `--min-count` 淘汰。
        out["料號"][m.group(0)] += 1

    for m in RE_ACRONYM.finditer(text):
        tok = m.group(0)
        if tok.lower() in STOPWORDS:
            continue
        out["縮寫"][tok] += 1

    for m in RE_PROPER.finditer(text):
        tok = m.group(0).strip()
        words = tok.split()
        # 整串都是停用詞就丟掉；只要有一個字不是，就留（"The Alice" 這種靠次數淘汰）
        if all(w.lower() in STOPWORDS for w in words):
            continue
        # ⭐ 整串與拆開的每個字**都要算**。
        #   只算整串的話，`Claude Sonnet` 會把那一次的 `Sonnet` 吃掉——
        #   於是一個講了三次的名字在清單上只剩兩次，剛好掉到門檻底下就消失了。
        #   而「哪個名字常出現」正是這支工具唯一要回答的問題。
        #   selftest 的「撈得到專名 Sonnet」就是釘這件事的。
        if len(words) > 1:
            out["專名"][tok] += 1
        for w in words:
            if w.lower() not in STOPWORDS:
                out["專名"][w] += 1

    return out


def merge(a, b):
    for k, c in b.items():
        a[k].update(c)
    return a


def scan(root, exts=(".md", ".txt")):
    """掃一個資料夾底下的逐字稿。回傳 (結果, 讀過的檔案清單)。"""
    totals = {"縮寫": Counter(), "專名": Counter(), "料號": Counter()}
    files = []
    root = Path(root)
    targets = [root] if root.is_file() else sorted(
        p for p in root.rglob("*")
        if p.is_file() and p.suffix.lower() in exts
        # ⚠ 跳過分片：同一場的話在分片裡會再出現一次，次數就變成兩倍，
        #   而排序完全靠次數 —— 有分片的那幾場會平白擠掉其他場的詞。
        and not any(part in p.name.lower() for part in SKIP_NAME_PARTS)
    )
    for p in targets:
        try:
            # 有無 BOM 都吃得下
            text = p.read_text(encoding="utf-8-sig", errors="replace")
        except OSError as e:
            print("  ⚠ 讀不到 %s：%s" % (p, e))
            continue
        files.append(p)
        merge(totals, classify_and_extract(text))
    return totals, files


def render(totals, min_count, limit):
    """排版成人看的清單。回傳 (文字, 入選總數, 估計字元數)。"""
    lines = []
    picked = 0
    chars = 0
    for kind in ("縮寫", "料號", "專名"):
        rows = [(w, n) for w, n in totals[kind].most_common() if n >= min_count]
        rows = rows[:limit]
        lines.append("")
        lines.append("## %s（出現 %d 次以上，最多 %d 筆）  共 %d 筆"
                     % (kind, min_count, limit, len(rows)))
        if not rows:
            lines.append("  （沒有符合的）")
            continue
        for w, n in rows:
            lines.append("  %5d 次   %s" % (n, w))
            picked += 1
            chars += len(w) + 1
    return "\n".join(lines), picked, chars


# ---------------------------------------------------------------------------
# selftest
# ---------------------------------------------------------------------------

def selftest():
    ok = True

    def check(name, cond, detail=""):
        nonlocal ok
        print("  [%s] %s%s" % ("PASS" if cond else "FAIL", name,
                               "" if cond else "  ← " + detail))
        if not cond:
            ok = False

    # ⭐ 這一題就是這支工具存在的理由：某場逐字稿把 Sonnet 聽成 Sonet、
    #    agy 聽成 AGY。詞表要能撈到這種字，不然它擋不住下一次。
    sample = (
        "We asked Claude Sonnet about it. Sonnet is the model. "
        "Sonnet again. The AGY tool runs on AGY credits, AGY is cheap. "
        "Part number Z-1001 and Z-1001 again, plus XY300. "
        "Alice said the Purchasing Budget looks fine. Alice agreed. "
        "The budget is fine. This is a test. That is all."
    )
    got = classify_and_extract(sample)

    check("撈得到專名 Sonnet", got["專名"].get("Sonnet", 0) >= 3,
          str(got["專名"].most_common(5)))
    check("撈得到縮寫 AGY", got["縮寫"].get("AGY", 0) >= 3, str(got["縮寫"].most_common(5)))
    check("撈得到料號 Z-1001", got["料號"].get("Z-1001", 0) >= 2, str(got["料號"].most_common(5)))
    check("撈得到料號 XY300", got["料號"].get("XY300", 0) >= 1, str(got["料號"].most_common(5)))
    check("撈得到人名 Alice", got["專名"].get("Alice", 0) >= 2, str(got["專名"].most_common(5)))
    check("連續兩字併成一個候選 Purchasing Budget",
          got["專名"].get("Purchasing Budget", 0) >= 1, str(got["專名"].most_common(8)))

    # 停用詞：句首的 The/This/That 不可以擠進清單，否則沒人會讀它
    for w in ("The", "This", "That", "We"):
        check("句首普通字被擋掉：%s" % w, got["專名"].get(w, 0) == 0,
              str(got["專名"].most_common(10)))

    # 純年份／金額不是料號
    got2 = classify_and_extract("In 2027 we spent 15000 euros, see X30 and AB-12.")
    check("純年份不算料號", "2027" not in got2["料號"], str(got2["料號"]))
    check("X30 算料號", got2["料號"].get("X30", 0) == 1, str(got2["料號"]))

    # 門檻真的有作用
    totals = {"縮寫": Counter({"AAA": 5, "BBB": 1}), "專名": Counter(), "料號": Counter()}
    text, picked, _ = render(totals, min_count=3, limit=50)
    check("低於門檻的被濾掉", "BBB" not in text and "AAA" in text, text)
    check("入選數對得上", picked == 1, str(picked))

    print("\n  selftest: %s" % ("全部通過" if ok else "有項目失敗"))
    return ok


def main():
    ap = argparse.ArgumentParser(description="從逐字稿撈硬詞表候選")
    ap.add_argument("root", nargs="?", help="逐字稿資料夾（或單一檔案）")
    ap.add_argument("--out", help="候選清單寫到這裡（⚠ 含公司專有名詞，別提交）")
    ap.add_argument("--min-count", type=int, default=3, help="出現幾次以上才算候選（預設 3）")
    ap.add_argument("--limit", type=int, default=40, help="每類最多列幾筆（預設 40）")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()

    if args.selftest or not args.root:
        print("── selftest")
        return 0 if selftest() else 1

    totals, files = scan(args.root)
    print("讀了 %d 個檔。" % len(files))
    body, picked, chars = render(totals, args.min_count, args.limit)

    header = [
        "# 硬詞表候選（機器撈的，**還沒有人看過**）",
        "",
        "來源：%s（%d 個檔）" % (args.root, len(files)),
        "門檻：出現 %d 次以上，每類最多 %d 筆" % (args.min_count, args.limit),
        "",
        "⚠ 這是候選、不是詞表。四類該留的是人名／公司／產品／料號，其餘刪掉。",
        "⚠ `context` 整包上限 %d 字元，**不能只進不出**；全收約需 %d 字元。"
        % (CONTEXT_CHAR_LIMIT, chars),
        "⚠ 真正的詞表只有 App 讀得到，這裡沒辦法幫你去重 —— 填之前自己對一眼設定頁。",
    ]
    text = "\n".join(header) + "\n" + body + "\n"

    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print("候選 %d 筆，全收約 %d 字元（上限 %d）。" % (picked, chars, CONTEXT_CHAR_LIMIT))
        print("寫到：%s" % args.out)
        print("⚠ 那個檔含公司會議的專有名詞，別提交進 git。")
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
