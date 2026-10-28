/**
 * 畫面上的文字怎麼塞進 DOM。
 *
 * 這支存在的理由是實際使用時當場看到的一個畫面：
 * 常駐通知那行紅字，字面印著
 *
 *     ⏸ 現在是休息中：**錄音沒有停**，但字幕停了。
 *
 * 那兩組星號不該被看到。根因是新前端一律走 `textContent`（零 `innerHTML`，
 * 這樣才能杜絕注入），而寫文案的人（我）照
 * Markdown 的習慣加了強調標記——**兩邊各自都對，湊在一起就露餡**。
 *
 * 解法刻意做成「出口自己解析」，而不是「文案不准用標記」：
 * 常駐通知區的存在意義就是讓人看懂還沒解決的事，而「休息中錄音沒有停」
 * 這種句子，重點字沒有重量就會被整句一起略過。
 *
 * ⚠ 這個規則**只在有呼叫本檔的出口生效**（目前：常駐通知）。
 *   `showAlert` 與狀態列仍是純文字，在那裡寫 `**` 一樣會照字面印出來。
 *   加新文案時要先看它走哪個出口。
 */

/**
 * 把 `**這樣**` 的片段變成真的粗體，其餘原樣輸出。
 *
 * ⚠ 全程 `createElement` / `createTextNode`，**沒有任何 `innerHTML`**。
 *   這一點不可以為了省事改掉——改掉就等於把注入漏洞放回來，
 *   而通知的內容有一部分來自後端的判決文字。
 *
 * @param {Node} parent 要塞進去的容器
 * @param {string} message 可能含 `**強調**` 的一句話
 */
export function appendWithEmphasis(parent, message) {
  if (!parent) return;
  const parts = String(message == null ? '' : message).split('**');
  parts.forEach((part, i) => {
    if (!part) return;
    // 偶數段是一般文字；奇數段是被一對 `**` 夾住的。
    // ⚠ 星號數量是單數時（例：`a**b**c**d`），最後一段會落在奇數位、
    //   沒有收尾標記。這裡讓它照樣變粗體，而不是把星號吐回畫面上——
    //   多一點粗體是小事，吐出星號正是本檔要治的病。
    if (i % 2 === 1) {
      const strong = parent.ownerDocument.createElement('strong');
      strong.textContent = part;
      parent.appendChild(strong);
    } else {
      parent.appendChild(parent.ownerDocument.createTextNode(part));
    }
  });
}

/**
 * 同一句話在畫面上**看起來**會是什麼樣子（標記已經吃掉）。
 *
 * 給測試與去重用：`addPersistentNotice` 比對的是原文，而人看到的是這個。
 * 兩者不再相等，正是這次改動帶進來的新陷阱，所以把它寫成一個有名字的東西。
 */
export function plainText(message) {
  return String(message == null ? '' : message).split('**').join('');
}

/**
 * 錄了多久，寫成畫面上那個讀秒。
 *
 * 一小時以內是 `12:34`，超過一小時才長出小時位 `1:02:03`——
 * 整場都印 `00:12:34` 的話，前面那兩個零每一秒都在畫面上晃，
 * 而真正在變的是後面。
 *
 * ⚠ 負數與 NaN 一律當 0：它的來源是「現在減開始時間」，
 *   而使用者把系統時鐘往回調的時候那個減法會變負的。
 *   讓它印成 `-5:03` 只會讓人以為程式壞了。
 */
export function formatElapsed(ms) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
