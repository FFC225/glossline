/**
 * 簡體 → 繁體（台灣用詞）轉換。
 *
 * 為什麼需要這一支：Soniox 官方語言表**只有 `zh`、不分繁簡**，
 * 所以譯文吐出來一定是簡體（實測：`感谢您加入`／`预算是15,000欧元`）。
 * 作法是「事後轉繁」，並連用詞一起在地化。
 *
 * ⚠ 轉換點在 segment 出生的地方（soniox-segmenter.js），**不在渲染層**。
 *   放渲染層就會出現「畫面是繁體、匯出檔是簡體」的分裂。
 * ⚠ 每個 segment 同時留一格 `translationRaw`＝Soniox 原樣吐出的簡體。
 *   轉繁是一對多的（发 → 發／髮，干 → 乾／幹／干），詞級轉換也會有少數判錯，
 *   留著原文就是為了**出事時回得去**。
 *
 * ## 三階段，照官方 s2twp.json 的 conversion_chain
 *
 *   階段 1（S2T）：简 → 繁      　　`软件` → `軟件`
 *   階段 2（TWP）：繁 → 台灣用詞　　`軟件` → `軟體`、`文本` → `文字`
 *   階段 3（TWV）：繁 → 台灣字形　　`裏` → `裡`、`麪` → `麵`
 *
 * ⚠ **不能壓成一張表只掃一次**：階段 2、3 的 key 是繁體。像「打印」這種簡繁同形的詞，
 *   階段 1 完全不會碰到它（它本來就長那樣），只有階段 2 才會把它變成「列印」。
 *   壓成一張表的話這類詞永遠不會被在地化，**而且不會有任何徵兆**。
 *
 * ⚠ 更正過：本檔原本是**兩階段**（階段 2、3 合併，還多摻了一份反方向的字典），
 *   實測與 Python 版 `opencc.OpenCC('s2twp')` 在真實逐字稿上唯一的差異就是它造成的
 *   （`文本` 沒被在地化成 `文字`）。詳見 `tools/build_s2t_data.py` 的檔頭。
 *
 * 每一階段內部都是最長詞優先：從每個位置往後試最長的詞，命中就換、沒命中就縮短，
 * 縮到一個字還沒有就原字照抄。這是 OpenCC 自己的作法——詞級條目（`头发` → `頭髮`）
 * 才蓋得過字級條目（`发` → `發`），一對多的歧義有機會判對。
 */

import {
  S2T_TABLE_RAW,
  S2T_MAX_KEY_LEN,
  TWP_TABLE_RAW,
  TWP_MAX_KEY_LEN,
  TWV_TABLE_RAW,
  TWV_MAX_KEY_LEN,
} from '../vendor/opencc-s2t-data.js';

const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);

/**
 * 延遲建表。
 *
 * 字典有五萬多條，建 Map 要一點時間。放在模組頂層就會拖慢啟動，
 * 而啟動慢在這個 App 上特別糟——開會前才開起來，慢的那幾百毫秒是真的在等。
 * 第一次真的要轉的時候再建。
 */
let stages = null;
let buildFailed = false;

function parse(raw) {
  const map = new Map();
  for (const line of raw.split(LF)) {
    if (!line) continue;
    const i = line.indexOf(TAB);
    if (i <= 0) continue;
    map.set(line.slice(0, i), line.slice(i + 1));
  }
  return map;
}

function ensureStages() {
  if (stages || buildFailed) return stages;
  try {
    const s2t = parse(S2T_TABLE_RAW);
    const twp = parse(TWP_TABLE_RAW);
    const twv = parse(TWV_TABLE_RAW);
    if (s2t.size === 0 || twp.size === 0 || twv.size === 0) throw new Error('字典是空的');
    stages = [
      { map: s2t, maxLen: S2T_MAX_KEY_LEN },
      { map: twp, maxLen: TWP_MAX_KEY_LEN },
      { map: twv, maxLen: TWV_MAX_KEY_LEN },
    ];
    console.log(
      '[s2t] 簡繁字典已載入：s2t ' + s2t.size + ' 條、twp ' + twp.size + ' 條、twv ' + twv.size + ' 條'
    );
  } catch (err) {
    // ⚠ 轉不成繁體是遺憾，把譯文弄不見是災難。所以失敗就退回原樣，
    //   但一定要吼一聲——不可以靜默降級。
    buildFailed = true;
    console.error('[s2t] 簡繁字典載入失敗，譯文將維持簡體：', err);
  }
  return stages;
}

/** 用一張表跑一次最長匹配。 */
function convertOnce(input, map, maxKeyLen) {
  let out = '';
  let i = 0;
  const n = input.length;
  while (i < n) {
    let matched = false;
    const maxLen = Math.min(maxKeyLen, n - i);
    for (let len = maxLen; len >= 1; len -= 1) {
      const hit = map.get(input.slice(i, i + len));
      if (hit !== undefined) {
        out += hit;
        i += len;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += input[i];
      i += 1;
    }
  }
  return out;
}

/**
 * 簡體轉繁體（台灣用詞）。
 * @param {string} input
 * @returns {string} 轉換後的字串；字典載入失敗時原樣回傳。
 */
export function toTraditional(input) {
  if (typeof input !== 'string' || input.length === 0) return input;
  const chain = ensureStages();
  if (!chain) return input;
  let text = input;
  for (const stage of chain) {
    text = convertOnce(text, stage.map, stage.maxLen);
  }
  return text;
}

/** 給測試與診斷用：三張表各載進來幾條（0 = 沒載成功）。 */
export function tableSizes() {
  const chain = ensureStages();
  if (!chain) return { s2t: 0, twp: 0, twv: 0 };
  return { s2t: chain[0].map.size, twp: chain[1].map.size, twv: chain[2].map.size };
}
