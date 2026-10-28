// The MLX pipeline, the six TTS providers and
// the OpenAI/Qwen realtime engines are no longer part of this app (20 commands).
// Their files are still on disk but are not declared here, so they are not
// compiled. Delete them once the new frontend is signed off.
pub mod audio;
pub mod audio_devices;
pub mod frontend_log;
pub mod logs;
pub mod precheck;
pub mod session_store;
pub mod settings;
pub mod transcript;
