/**
 * 散會時給這場會議取名字。
 *
 * 為什麼要有這一步：散會後留下來的東西有兩份，而兩份都沒有名字——
 * 記錄庫那筆的標題是「本場第一句話」（`session-store.js` 的 `_autoTitle`），
 * 錄音資料夾叫 `YYYY-MM-DD_HHMM`。三個月後要找「上次跟 Alice 那場」，
 * 兩邊都幫不上忙。人唯一願意打名字的時機是**剛按下停止、報告框跳出來的那一刻**。
 *
 * 這支只有邏輯、不碰 DOM，所以 node 測得動（`tools/test_session_naming.mjs`）。
 * UI 那半邊在 `main.js`。
 *
 * ⚠ 一次要改的東西有三個，而它們**可以各自失敗**：
 *   ① 記錄庫那筆的標題　② 錄音資料夾的名字　③ 資料夾裡那份逐字稿副本的第一行
 *   每一件都得分開講。壞掉的樣子是「按了存名字、看起來成功了、其實只改了一半」，
 *   而半改的結果在畫面上跟全改一模一樣。
 *
 * ⚠ ③ 一定要排在 ② 之後，而且用 ② 回來的**新路徑**：拿舊路徑去寫，檔案會落在
 *   一個已經不存在的地方（或更糟：Windows 幫你重建一個空的舊夾子）。
 */

/**
 * 把一個名字套到這場會議上。
 *
 * @param {object} opts
 * @param {(cmd: string, args: object) => Promise<any>} opts.invoke Tauri 的 invoke（測試時注入假的）。
 * @param {string} opts.name 人打的名字（還沒清乾淨，清理在 Rust 那邊做）。
 * @param {string|null} opts.sessionId 記錄庫那筆的 id；沒有就跳過 ①。
 * @param {string|null} opts.folder 這場的錄音資料夾；沒有（這場沒錄）就跳過 ②③。
 * @param {boolean} opts.hasSegments 本場有沒有句子。零句時記錄庫根本沒存檔，
 *   對它改標題只會得到一句看不懂的「Read failed」。
 * @param {() => string} opts.markdown 產生逐字稿。
 * @param {(title: string) => void} [opts.setTitle] 把新名字寫回記錄庫物件。
 *   ⚠ **一定要在 `markdown()` 之前呼叫**，而且是這支自己負責、不能留給呼叫端事後補：
 *   `markdown()` 的第一行就是 `store.title`（`session-store.js:312`），呼叫端若在
 *   「跑完整套之後」才設標題，寫進副本的就是**舊的自動標題**——而畫面上三件事
 *   全部回報成功，檔案也確實被重寫過（時間戳是新的），只有內容是舊的。
 *   實撞過，第一版就是這樣寫的。
 * @returns {Promise<{ok: boolean, folder: string|null, done: string[], errors: string[]}>}
 *   `folder` 是**改名之後**的路徑，呼叫端一定要拿它覆蓋自己手上那份——
 *   「開啟資料夾」那顆鍵用的就是它，指到舊路徑會安靜地開錯地方。
 */
export async function applyMeetingName({
  invoke,
  name,
  sessionId,
  folder,
  hasSegments,
  markdown,
  setTitle,
}) {
  const trimmed = String(name == null ? '' : name).trim();
  if (!trimmed) {
    return { ok: false, folder, done: [], errors: ['先打一個名字。'] };
  }

  // ⚠ 這一行要排在所有事情之前（理由見上面 `setTitle` 那段）。
  if (typeof setTitle === 'function') setTitle(trimmed);

  const done = [];
  const errors = [];
  let nextFolder = folder || null;

  // ① 記錄庫那筆的標題。
  if (sessionId && hasSegments) {
    try {
      await invoke('update_session_title', { id: sessionId, title: trimmed });
      done.push('記錄庫');
    } catch (err) {
      errors.push('記錄庫那筆的標題沒改成：' + err);
    }
  }

  // ② 錄音資料夾。
  if (folder) {
    try {
      const renamed = await invoke('rename_session_dir', { dir: folder, name: trimmed });
      if (renamed) nextFolder = String(renamed);
      done.push('錄音資料夾');
    } catch (err) {
      errors.push('錄音資料夾沒改名：' + err);
    }
  }

  // ③ 資料夾裡那份逐字稿副本（第一行就是標題）。
  // ⚠ 只有 ② 真的成功、而且這場有句子（＝副本本來就寫過）才做。零句的時候
  //   那個資料夾裡沒有逐字稿，這裡硬寫會憑空生出一份空的稿。
  if (nextFolder && hasSegments && typeof markdown === 'function') {
    try {
      await invoke('save_transcript_beside_recording', {
        dir: nextFolder,
        mdContent: markdown(),
      });
      done.push('資料夾裡那份逐字稿');
    } catch (err) {
      errors.push('資料夾裡那份逐字稿的標題沒更新：' + err);
    }
  }

  return { ok: errors.length === 0, folder: nextFolder, done, errors };
}

/**
 * 存完之後該講的那句話。**純字串、沒有 DOM**，所以規則測得動。
 *
 * ⚠ 「全成功」與「一半成功」要講得不一樣。半成功講成成功，等於把
 *   「你的錄音資料夾其實沒改到」這件事藏起來。
 */
export function nameResultMessage(result) {
  if (!result) return { text: '', bad: true };
  if (result.errors.length && !result.done.length) {
    return { text: '⚠ ' + result.errors.join('　'), bad: true };
  }
  if (result.errors.length) {
    return {
      text: '⚠ 只改了一半（' + result.done.join('、') + '）。' + result.errors.join('　'),
      bad: true,
    };
  }
  if (!result.done.length) {
    // 這場既沒錄音也沒句子——沒有東西可以改名，但那不是錯。
    return { text: '這場沒有留下檔案，名字沒有地方可以存。', bad: false };
  }
  const where = result.folder ? '　資料夾：' + folderLeaf(result.folder) : '';
  return { text: '✓ 名字存好了（' + result.done.join('、') + '）。' + where, bad: false };
}

/** 路徑 → 最後那一段。整條路徑太長，塞進報告框會擠掉別的字。 */
export function folderLeaf(path) {
  const s = String(path || '');
  const cut = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return cut === -1 ? s : s.slice(cut + 1);
}
