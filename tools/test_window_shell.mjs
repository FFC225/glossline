/**
 * 視窗外殼的純函式測試。
 *
 * 跑法：
 *   "C:\Program Files\nodejs\node.exe" app/tools/test_window_shell.mjs
 *
 * ⚠ 這張網管得到的只有「算尺寸／判模式／該不該收起來」這幾條規則。
 *   視窗真的縮沒縮、標題列真的收沒收，node 看不到，只能開 App 用眼睛看——
 *   跟字幕面板的 DOM 那半邊同一種缺口，不要把這裡全綠當成那件事也對了。
 */

import {
  MIN_SIZE,
  MODE_DEFAULT_SIZE,
  SIZE_KEY,
  normalizeMode,
  otherMode,
  sanitizeSize,
  pickSizeForMode,
  shouldAutoHide,
  computeFitGeometry,
} from '../src/v2/js/window-shell.js';

let pass = 0;
const failures = [];

function check(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass += 1;
  } else {
    failures.push(name + '\n    got  ' + g + '\n    want ' + w);
  }
}

/* ── 模式：Rust 那格是自由字串，什麼鬼東西都可能進來 ── */
check('模式 expanded', normalizeMode('expanded'), 'expanded');
check('模式 overlay', normalizeMode('overlay'), 'overlay');
check('模式 空字串當 overlay', normalizeMode(''), 'overlay');
check('模式 null 當 overlay', normalizeMode(null), 'overlay');
check('模式 亂字串當 overlay', normalizeMode('EXPANDED'), 'overlay');
check('切換 overlay→expanded', otherMode('overlay'), 'expanded');
check('切換 expanded→overlay', otherMode('expanded'), 'overlay');
check('切換 亂值→expanded', otherMode('???'), 'expanded');

/* ── 尺寸清洗 ── */
check('尺寸 正常值原樣', sanitizeSize({ w: 1000, h: 600 }), { w: 1000, h: 600 });
check('尺寸 小數四捨五入', sanitizeSize({ w: 1000.4, h: 600.6 }), { w: 1000, h: 601 });
check('尺寸 null', sanitizeSize(null), null);
check('尺寸 不是物件', sanitizeSize('900x500'), null);
check('尺寸 缺一格', sanitizeSize({ w: 900 }), null);
check('尺寸 NaN', sanitizeSize({ w: 'abc', h: 600 }), null);
check('尺寸 零', sanitizeSize({ w: 0, h: 0 }), null);
check('尺寸 負數', sanitizeSize({ w: -900, h: 600 }), null);
check('尺寸 大到不可能是螢幕', sanitizeSize({ w: 99999, h: 600 }), null);
// 比視窗下限小 → 夾到下限，不是丟掉。丟掉會讓視窗跳回預設、看起來像自己變大。
check('尺寸 比下限小就夾住', sanitizeSize({ w: 300, h: 100 }), { w: MIN_SIZE.w, h: MIN_SIZE.h });
check('尺寸 只有一邊太小', sanitizeSize({ w: 1000, h: 100 }), { w: 1000, h: MIN_SIZE.h });

/* ── 該用多大 ── */
check(
  '取尺寸 有記錄就用記錄',
  pickSizeForMode({ [SIZE_KEY.overlay]: { w: 1000, h: 620 } }, 'overlay'),
  { w: 1000, h: 620 }
);
check(
  '取尺寸 沒記錄用預設',
  pickSizeForMode({}, 'overlay'),
  { ...MODE_DEFAULT_SIZE.overlay }
);
check(
  '取尺寸 記錄壞掉用預設',
  pickSizeForMode({ [SIZE_KEY.expanded]: { w: 'x', h: null } }, 'expanded'),
  { ...MODE_DEFAULT_SIZE.expanded }
);
check(
  '取尺寸 不看另一個模式那格',
  pickSizeForMode({ [SIZE_KEY.overlay]: { w: 1000, h: 620 } }, 'expanded'),
  { ...MODE_DEFAULT_SIZE.expanded }
);
check('取尺寸 settings 是 null', pickSizeForMode(null, 'overlay'), { ...MODE_DEFAULT_SIZE.overlay });
check('取尺寸 模式亂值當 overlay', pickSizeForMode({}, 'zzz'), { ...MODE_DEFAULT_SIZE.overlay });

/* ── 該不該收起外殼 ── */
check('收起 收音中且沒彈窗', shouldAutoHide({ capturing: true, modalOpen: false }), true);
check('收起 沒在收音就不收', shouldAutoHide({ capturing: false, modalOpen: false }), false);
check('收起 有彈窗就不收', shouldAutoHide({ capturing: true, modalOpen: true }), false);
check('收起 兩個都不成立', shouldAutoHide({ capturing: false, modalOpen: true }), false);

/* ── 「符合螢幕」的幾何計算 ──
   ⚠ 這幾條是為了「兩台螢幕縮放不同」而存在的：算錯不會噴錯，
   只會讓視窗跑到隔壁螢幕、或又被裁掉一半。 */
check(
  '符合螢幕 1920x1080@100%',
  computeFitGeometry({ width: 1920, height: 1080, x: 0, y: 0, scale: 1 }),
  { w: 1804, h: 972, x: 58, y: 54 }
);
check(
  '符合螢幕 同一張桌面@150%（實體像素大一半，結果應該一樣）',
  computeFitGeometry({ width: 2880, height: 1620, x: 0, y: 0, scale: 1.5 }),
  { w: 1804, h: 972, x: 58, y: 54 }
);
check(
  '符合螢幕 第二台螢幕的座標也要除以縮放',
  computeFitGeometry({ width: 2880, height: 1620, x: 2880, y: 0, scale: 1.5 }),
  { w: 1804, h: 972, x: 1978, y: 54 }
);
check(
  '符合螢幕 直立螢幕 1080x1920',
  computeFitGeometry({ width: 1080, height: 1920, x: 1920, y: 0, scale: 1 }),
  { w: 1015, h: 1728, x: 1952, y: 96 }
);
// 下限從 820 降到 360（並排要能等寬），800px 的螢幕因此不再觸發夾住，
// 這條測的行為會靜靜消失。螢幕改成比新下限還窄的 300px，測的東西才還在。
check(
  '符合螢幕 螢幕比視窗下限還窄就夾住（會微微超出左緣，這是刻意的）',
  computeFitGeometry({ width: 300, height: 600, x: 0, y: 0, scale: 1 }),
  { w: MIN_SIZE.w, h: 540, x: -30, y: 30 }
);
check(
  '符合螢幕 左邊那台（負座標）',
  computeFitGeometry({ width: 1920, height: 1080, x: -1920, y: 0, scale: 1 }),
  { w: 1804, h: 972, x: -1862, y: 54 }
);
check(
  '符合螢幕 縮放比例問不到時當 1',
  computeFitGeometry({ width: 1920, height: 1080, x: 0, y: 0, scale: 0 }),
  { w: 1804, h: 972, x: 58, y: 54 }
);

if (failures.length) {
  console.log('FAIL ' + failures.length + ' 項（PASS ' + pass + '）');
  failures.forEach((f) => console.log('  X ' + f));
  process.exit(1);
}
console.log('全部 PASS：' + pass + ' 項');
