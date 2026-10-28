/**
 * 前端 <-> Rust `Settings` 的欄位對照表。
 *
 * 為什麼要有這張表：這個病已經確定發生過三次——前端送了一個欄位、Rust struct 沒有那格、
 * serde 靜默丟掉、零錯誤訊息：
 *   1. translation_type / language_a / language_b / language_hints_strict / endpoint_delay
 *      （app.js:937-941 送出，Settings 沒有）
 *   2. custom_context.general / terms / text（app.js:978-982 送出，CustomContext 沒有）
 *   3. 反方向也會：save_settings 收的是整個 Settings，前端若只送一部分，
 *      #[serde(default)] 會把沒送的欄位「安靜地重設成預設值」。
 *
 * 所以規矩兩條：
 *   A. 這張表由 `app/tools/check_settings_fields.py` 對 settings.rs 機械比對，差一個就報錯。
 *   B. 存檔一律走 settings-store.js 的 patch()，它會把後端回來的整包當底、只覆蓋改動的鍵。
 */

/** Rust `Settings` 的欄位，順序照 src-tauri/src/settings.rs 的宣告順序。 */
export const RUST_SETTINGS_KEYS = Object.freeze([
  'soniox_api_key',
  'source_language',
  'target_language',
  'audio_source',
  'overlay_opacity',
  'font_size',
  'max_lines',
  'show_original',
  'translation_mode',
  'custom_context',
  'recording_dir',
  'always_on_top',
  'theme',
  'window_mode',
  'window_size_overlay',
  'window_size_expanded',
  'recording_consent_ack',
  'folder_name_order',
]);

/** Rust `CustomContext` 的欄位（settings.rs 的 struct CustomContext）。 */
export const RUST_CUSTOM_CONTEXT_KEYS = Object.freeze([
  'domain',
  'terms',
  'text',
  'translation_terms',
]);

/**
 * v2 介面實際會編輯的欄位。其餘 Rust 欄位（TTS 那一大批）v2 不碰，
 * 但 patch() 會原樣帶回去，不可以讓它們被重設。
 */
export const V2_EDITED_KEYS = Object.freeze([
  'soniox_api_key',
  'source_language',
  'target_language',
  'audio_source',
  'recording_dir',
  'overlay_opacity',
  'font_size',
  'max_lines',
  'show_original',
  'custom_context',
  'always_on_top',
  'theme',
  // 視窗外殼（window-shell.js）。⚠ 這三格不在設定表單上，是使用者拉視窗／按切換時
  // 順手存的；列在這裡是為了讓 patch() 的鍵檢查放行，並被 check_settings_fields.py 看顧。
  'window_mode',
  'window_size_overlay',
  'window_size_expanded',
  // 第一次按開始時勾的那一格，勾完由前端存回去。
  'recording_consent_ack',
  // 散會取名後資料夾名字放前或放後。設定頁編輯得到。
  'folder_name_order',
]);

/**
 * 執行期對照：拿後端真的回傳的物件跟這張表比。
 * 回傳 { missing, extra }；兩邊都空才算對得上。
 */
export function auditSettingsShape(fromBackend) {
  const got = new Set(Object.keys(fromBackend || {}));
  const want = new Set(RUST_SETTINGS_KEYS);
  const missing = RUST_SETTINGS_KEYS.filter((k) => !got.has(k));
  const extra = [...got].filter((k) => !want.has(k));
  return { missing, extra };
}
