#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""字幕延遲漂移分析。

問題（白話）：不是「慢兩秒」讓人難受，是「你講到第三句了，字幕還停在第一句」。
落後如果會愈積愈多，開一小時的會到後面就沒法用了。160 秒的素材看不出這件事。

做法：紀錄庫的每一段同時帶兩個時鐘（`session-store.js:41-45`）——
  * `t_ms`   ：**牆上時鐘**，距離本場開始的毫秒（我們把這句定稿收進記錄庫的時刻）
  * `start_ms` / `end_ms`：**Soniox 那條串流自己的時鐘**，這句話是第幾毫秒被講出來的／講完的

所以延遲有兩種算法，本腳本兩個都算：
  * `lag_end   = t_ms - end_ms`   ← 體感延遲（我講完 → 字幕出現）。**這才是該看的那個**
  * `lag_start = t_ms - start_ms` ← 原本想的算法，會把「句子本身有多長」也算進延遲

三個但書（全部反映在程式裡）：
  1. 兩個時鐘的原點不完全同一個（串流是按下開始之後才連上的）。
     → 所以結論看 **斜率**，不看絕對值。絕對值只拿來跟先前的實測（0.74-0.82 秒）對照。
  2. 斷線重連會讓 `start_ms` 歸零，那之後的數字失真。
     → 本腳本偵測「Soniox 時鐘倒退」並在該處切段，各段分開算、也各自報告。
  3. 量到的是「這句**定稿**」的延遲，不是字幕第一次浮現的延遲。
     → 報告裡必須寫明，不可以拿它去講「字幕多久才出現」。

⚠ 兩路（them／me）的 Soniox 時鐘**各自從 0 起算**，混在一起算是錯的 → 一律分 `who` 各算一條線。

用法：
    python.exe app\\tools\\analyze_subtitle_lag.py <紀錄檔.json> [更多.json ...]
    python.exe app\\tools\\analyze_subtitle_lag.py --selftest

⚠ selftest 不是裝飾：線性回歸算錯了**不會有任何症狀**，它照樣吐出一個看起來合理的斜率。
  所以先餵「固定延遲」與「線性惡化」兩組假資料，確認這支程式分得出來，再信它對真實資料的話。
"""

import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


# ---------------------------------------------------------------------------
# 純算數的部分（沒有 I/O，selftest 直接打這裡）
# ---------------------------------------------------------------------------

def linreg(xs, ys):
    """最小平方法。回傳 (斜率, 截距)；點數不足或 x 全同回 (None, None)。"""
    n = len(xs)
    if n < 2:
        return None, None
    mx = sum(xs) / n
    my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return None, None
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    slope = sxy / sxx
    return slope, my - slope * mx


def pct(sorted_vals, p):
    """第 p 百分位（0-100），線性內插。輸入必須已排序。"""
    if not sorted_vals:
        return None
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    k = (len(sorted_vals) - 1) * (p / 100.0)
    lo = int(k)
    hi = min(lo + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo)


def split_on_clock_reset(segs):
    """在「Soniox 時鐘倒退」的地方切段（＝斷線重連，`start_ms` 歸零）。

    回傳 list of list。倒退的判準刻意寬鬆一點：只有**明顯**往回跳才算重連，
    小幅度的亂序是同一條串流裡正常的（段落定稿順序不保證等於開講順序）。
    """
    RESET_TOLERANCE_MS = 5000
    runs = []
    cur = []
    peak = None
    for s in segs:
        v = s["clock_ms"]
        if peak is not None and v < peak - RESET_TOLERANCE_MS:
            runs.append(cur)
            cur = []
            peak = None
        cur.append(s)
        peak = v if peak is None else max(peak, v)
    if cur:
        runs.append(cur)
    return runs


def analyse_run(segs):
    """對一段連續的（沒有重連的）segment 算延遲統計。

    `segs` 每筆要有 `t_ms`／`start_ms`／`end_ms`。
    """
    lag_end = [(s["t_ms"] - s["end_ms"]) / 1000.0 for s in segs]
    lag_start = [(s["t_ms"] - s["start_ms"]) / 1000.0 for s in segs]
    mins = [s["t_ms"] / 60000.0 for s in segs]

    slope_end, _ = linreg(mins, lag_end)
    slope_start, _ = linreg(mins, lag_start)

    # 桶狀對照：把整場切成四等分看中位數。回歸怕離群值，這個不怕，
    # 兩者講的話不一樣時要停下來看，別只信回歸。
    quarters = []
    if segs:
        span = mins[-1] - mins[0]
        for q in range(4):
            lo = mins[0] + span * q / 4.0
            hi = mins[0] + span * (q + 1) / 4.0
            vals = sorted(
                v for m, v in zip(mins, lag_end)
                if (lo <= m < hi) or (q == 3 and m == hi)
            )
            quarters.append({
                "n": len(vals),
                "median": pct(vals, 50),
                "from_min": lo,
                "to_min": hi,
            })

    # ───────────────────────────────────────────────────────────────────
    # 時鐘分岔診斷 —— 本腳本最重要的一段，它決定上面那些數字能不能信。
    #
    # `t_ms` 走的是**牆上時間**（每分鐘 60 秒，不管有沒有人講話）。
    # `end_ms` 走的是**音訊時間**：Soniox 那條串流至今「收到多少音訊」的位置。
    # 端點閒置時 WASAPI 回 0 個封包，我們就沒東西送，
    # 於是 Soniox 的時鐘停著不動，而牆上時鐘照走。
    #
    # ⚠ 後果：兩個時鐘的**速率**不同，不只是原點不同。相減得到的不是延遲，
    #   是「延遲 ＋ 到目前為止累積的靜音」。而靜音是單調累積的，所以那條線一定往上，
    #   看起來就像「字幕愈拉愈開」——**但那根本不是延遲**。
    #
    # 判準：`drift_ratio` ＝ Soniox 時鐘跨距 ÷ 牆上時鐘跨距 ＝ 這段期間的「有聲比例」。
    #   ≈ 1.0 → 幾乎全程在講話，相減的結果才勉強能當延遲看
    #   明顯 < 1.0 → 中間有靜音，**這場的斜率不是延遲，別引用**
    # 覆核：`slope_explained_by_silence` ＝ 60 × (1 − 有聲比例)，
    #   它若跟實際斜率對得上，就證明那條斜率完全是靜音造成的。
    wall_span_ms = segs[-1]["t_ms"] - segs[0]["t_ms"]
    sonio_span_ms = segs[-1]["end_ms"] - segs[0]["end_ms"]
    drift_ratio = (sonio_span_ms / wall_span_ms) if wall_span_ms > 0 else None
    clock = {
        "wall_span_s": wall_span_ms / 1000.0,
        "soniox_span_s": sonio_span_ms / 1000.0,
        "divergence_s": (wall_span_ms - sonio_span_ms) / 1000.0,
        "voiced_ratio": drift_ratio,
        "slope_explained_by_silence":
            (60.0 * (1.0 - drift_ratio)) if drift_ratio is not None else None,
    }

    se = sorted(lag_end)
    ss = sorted(lag_start)
    return {
        "n": len(segs),
        "clock": clock,
        "span_min": (mins[-1] - mins[0]) if segs else 0.0,
        "lag_end": {
            "median": pct(se, 50), "p90": pct(se, 90),
            "min": se[0] if se else None, "max": se[-1] if se else None,
            "slope_s_per_min": slope_end,
        },
        "lag_start": {
            "median": pct(ss, 50), "p90": pct(ss, 90),
            "slope_s_per_min": slope_start,
        },
        "quarters": quarters,
    }


# ---------------------------------------------------------------------------
# 讀檔
# ---------------------------------------------------------------------------

def load_segments(path):
    """讀一份紀錄檔，攤平成 segment list。

    跳過缺時鐘的段（`start_ms`／`end_ms` 可能是 null —— `session-store.js:60`
    寫著 Soniox 沒給就是 null），並回報跳了幾筆：**跳掉的數量本身是個訊號**，
    全部都是 null 的話這場根本沒得算，不能悄悄回報一個空結果。
    """
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    out, skipped, total = [], 0, 0
    for chunk in (data.get("chunks") or []):
        for s in (chunk.get("segments") or []):
            total += 1
            if s.get("t_ms") is None or s.get("start_ms") is None or s.get("end_ms") is None:
                skipped += 1
                continue
            out.append({
                "t_ms": s["t_ms"],
                "start_ms": s["start_ms"],
                "end_ms": s["end_ms"],
                "clock_ms": s["start_ms"],
                "who": s.get("who") or "?",
                "ts": s.get("ts"),
                "src": (s.get("src") or "")[:40],
            })
    meta = {
        "id": data.get("id"),
        "duration_sec": data.get("duration_sec"),
        "chunks": len(data.get("chunks") or []),
        "total": total,
        "skipped": skipped,
    }
    return out, meta


# ---------------------------------------------------------------------------
# 輸出
# ---------------------------------------------------------------------------

def fmt(v, unit="", nd=2):
    return "—" if v is None else ("%.*f%s" % (nd, v, unit))


def report_file(path):
    segs, meta = load_segments(path)
    print("=" * 72)
    print("檔案：%s" % Path(path).name)
    print("  id=%s  duration_sec=%s  chunks=%s  總段數=%d  可用=%d  跳過(缺時鐘)=%d"
          % (meta["id"], meta["duration_sec"], meta["chunks"],
             meta["total"], len(segs), meta["skipped"]))
    if not segs:
        print("  ⚠ 沒有任何一段帶得到時鐘，這場算不了。")
        return meta

    by_who = {}
    for s in segs:
        by_who.setdefault(s["who"], []).append(s)

    for who in sorted(by_who):
        rows = sorted(by_who[who], key=lambda s: s["t_ms"])
        runs = split_on_clock_reset(rows)
        print("\n  ── 路：%s（%d 段%s）" % (
            who, len(rows),
            "" if len(runs) == 1 else "，偵測到 %d 次 Soniox 時鐘歸零＝斷線重連" % (len(runs) - 1)))
        for i, run in enumerate(runs):
            if len(run) < 2:
                print("     區間 %d：只有 %d 段，算不出趨勢，略過。" % (i + 1, len(run)))
                continue
            r = analyse_run(run)
            tag = "" if len(runs) == 1 else "（區間 %d/%d）" % (i + 1, len(runs))
            print("     %s%d 段、跨 %s 分鐘" % (tag, r["n"], fmt(r["span_min"], "", 1)))

            c = r["clock"]
            print("     ⚠ 時鐘分岔診斷（決定下面那些數字能不能信）：")
            print("        牆上時鐘走了 %s   Soniox 時鐘走了 %s   分岔 %s"
                  % (fmt(c["wall_span_s"], " 秒", 1), fmt(c["soniox_span_s"], " 秒", 1),
                     fmt(c["divergence_s"], " 秒", 1)))
            print("        有聲比例 %s   →  光靠靜音就能解釋的斜率 = %s 秒/分鐘"
                  % (fmt(c["voiced_ratio"], "", 3),
                     fmt(c["slope_explained_by_silence"], "", 4)))
            vr = c["voiced_ratio"]
            if vr is not None and vr < 0.95:
                print("        🔴 有聲比例低於 0.95：這場的「延遲」數字裡混著累積靜音，")
                print("           斜率**不是**字幕漂移，不要引用。")

            le = r["lag_end"]
            print("     體感延遲 lag_end = t_ms − end_ms：")
            print("        中位數 %s   p90 %s   範圍 %s ~ %s"
                  % (fmt(le["median"], " 秒"), fmt(le["p90"], " 秒"),
                     fmt(le["min"], " 秒"), fmt(le["max"], " 秒")))
            print("        ⭐ 斜率 %s 秒/分鐘  →  整場 %s 分鐘累積 %s"
                  % (fmt(le["slope_s_per_min"], "", 4), fmt(r["span_min"], "", 1),
                     fmt((le["slope_s_per_min"] or 0) * r["span_min"], " 秒")))
            ls = r["lag_start"]
            print("     對照 lag_start = t_ms − start_ms（含句長，非體感）：")
            print("        中位數 %s   斜率 %s 秒/分鐘"
                  % (fmt(ls["median"], " 秒"), fmt(ls["slope_s_per_min"], "", 4)))
            print("     四等分中位數（不怕離群值，用來覆核上面那條斜率）：")
            for q in r["quarters"]:
                print("        %5.1f–%5.1f 分： n=%-4d 中位 %s"
                      % (q["from_min"], q["to_min"], q["n"], fmt(q["median"], " 秒")))
    return meta


# ---------------------------------------------------------------------------
# selftest
# ---------------------------------------------------------------------------

def _mk(t_ms, start_ms, end_ms):
    return {"t_ms": t_ms, "start_ms": start_ms, "end_ms": end_ms, "clock_ms": start_ms}


def selftest():
    """餵已知答案的假資料，確認這支程式分得出「穩定」與「愈拉愈開」。"""
    ok = True

    def check(name, cond, detail=""):
        nonlocal ok
        print("  [%s] %s%s" % ("PASS" if cond else "FAIL", name,
                               "" if cond else "  ← " + detail))
        if not cond:
            ok = False

    # ① 固定延遲 0.8 秒，一小時、每 20 秒一句 → 斜率必須 ≈ 0
    fixed = []
    for i in range(180):
        spoken_end = i * 20000 + 3000
        fixed.append(_mk(spoken_end + 800, i * 20000, spoken_end))
    r = analyse_run(fixed)
    check("固定延遲：中位數 ≈ 0.80 秒",
          abs(r["lag_end"]["median"] - 0.8) < 0.01, str(r["lag_end"]["median"]))
    check("固定延遲：斜率 ≈ 0（不會愈拉愈開）",
          abs(r["lag_end"]["slope_s_per_min"]) < 1e-6, str(r["lag_end"]["slope_s_per_min"]))

    # ② 每分鐘惡化 0.5 秒 → 斜率必須 ≈ 0.5
    drift = []
    for i in range(180):
        spoken_end = i * 20000 + 3000
        minute = (spoken_end + 800) / 60000.0
        drift.append(_mk(int(spoken_end + 800 + minute * 500), i * 20000, spoken_end))
    r = analyse_run(drift)
    check("線性惡化：斜率 ≈ 0.50 秒/分鐘",
          abs(r["lag_end"]["slope_s_per_min"] - 0.5) < 0.02,
          str(r["lag_end"]["slope_s_per_min"]))
    q = r["quarters"]
    check("線性惡化：四等分中位數逐段變大（覆核回歸）",
          all(q[i]["median"] < q[i + 1]["median"] for i in range(3)),
          str([x["median"] for x in q]))

    # ③ lag_start 會把句長算進去 → 比 lag_end 大，差額 ＝ 句長 3 秒
    r = analyse_run(fixed)
    check("lag_start 比 lag_end 大 3 秒（＝句長，證明兩種算法確實不同）",
          abs((r["lag_start"]["median"] - r["lag_end"]["median"]) - 3.0) < 0.01,
          str(r["lag_start"]["median"]))

    # ③b 時鐘分岔：全程有聲時，有聲比例要 ≈ 1.0
    r = analyse_run(fixed)
    check("全程有聲：voiced_ratio ≈ 1.0",
          abs(r["clock"]["voiced_ratio"] - 1.0) < 0.01,
          str(r["clock"]["voiced_ratio"]))

    # ③c ⭐ 本腳本存在的理由：**靜音會偽裝成「字幕愈拉愈開」**。
    #     造一場「固定延遲 0.8 秒、完全沒有漂移」，但只有一半時間在送音訊。
    #     正確的程式必須：① 算出一條很陡的假斜率 ② 同時算出「靜音就足以解釋它」。
    #     如果沒有 ② 這道診斷，這組資料會讓人寫出「每分鐘惡化 30 秒」的災難結論。
    half = []
    for i in range(200):
        audio_end = i * 6000 + 3000   # 音訊時鐘：每句佔 6 秒
        wall_end = i * 12000 + 3000   # 牆上時鐘：每句佔 12 秒（另 6 秒沒送音訊）
        half.append(_mk(wall_end + 800, i * 6000, audio_end))
    r = analyse_run(half)
    check("靜音場：有聲比例 ≈ 0.5",
          abs(r["clock"]["voiced_ratio"] - 0.5) < 0.01,
          str(r["clock"]["voiced_ratio"]))
    check("靜音場：算出一條很陡的假斜率（≈ 30 秒/分鐘）",
          abs(r["lag_end"]["slope_s_per_min"] - 30.0) < 0.5,
          str(r["lag_end"]["slope_s_per_min"]))
    check("⭐ 靜音場：診斷能解釋掉那條假斜率（兩數相差 < 2%）",
          abs(r["lag_end"]["slope_s_per_min"]
              - r["clock"]["slope_explained_by_silence"]) < 0.6,
          "實際 %s vs 靜音可解釋 %s" % (r["lag_end"]["slope_s_per_min"],
                                       r["clock"]["slope_explained_by_silence"]))

    # ④ 斷線重連：時鐘歸零要被切成兩段，不可以混在一起算
    reset = [_mk(i * 1000, i * 1000, i * 1000) for i in range(30)]
    reset += [_mk(30000 + i * 1000, i * 1000, i * 1000) for i in range(30)]
    runs = split_on_clock_reset(reset)
    check("斷線重連：切成 2 段", len(runs) == 2, "切成 %d 段" % len(runs))
    check("斷線重連：兩段各 30 筆",
          len(runs[0]) == 30 and len(runs[1]) == 30,
          str([len(x) for x in runs]))

    # ⑤ 同一條串流裡的小幅亂序不可以被誤判成重連
    jitter = [_mk(i * 1000, i * 1000 + (2000 if i % 5 == 0 else 0), i * 1000)
              for i in range(60)]
    check("小幅亂序不誤判成重連", len(split_on_clock_reset(jitter)) == 1,
          "切成 %d 段" % len(split_on_clock_reset(jitter)))

    print("\n  selftest: %s" % ("全部通過" if ok else "有項目失敗"))
    return ok


def main(argv):
    if not argv or argv[0] == "--selftest":
        print("── selftest（先確認這支程式本身算得對，再信它對真實資料的話）")
        return 0 if selftest() else 1
    for p in argv:
        report_file(p)
    print("\n" + "=" * 72)
    print("⚠ 三個但書（引用本結果時必須一起講）：")
    print("  1. 兩個時鐘原點不同 → 看斜率，不看絕對值。")
    print("  2. 偵測到重連的區間各自獨立，跨區間的絕對值不可比較。")
    print("  3. 這是「定稿」延遲，不是字幕第一次浮現的延遲。")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
