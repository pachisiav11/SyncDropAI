mod files;
mod inbox;
mod naming;
mod vault;

use files::Downloads;
use inbox::Inbox;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // "Send to > SyncDrop" on a file starts a second process. It forwards
        // its arguments to the window that is already open and exits, so
        // sharing never leaves two copies of the app running.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            inbox::remember(app, inbox::paths_from_args(argv));
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(Downloads::default())
        .manage(Inbox::default())
        .setup(|app| {
            let paths = inbox::paths_from_args(std::env::args());
            inbox::remember(app.handle(), paths);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault::vault_load,
            vault::vault_save,
            vault::vault_clear,
            vault::device_name,
            files::file_begin,
            files::file_append,
            files::file_finish,
            files::file_abort,
            files::reveal,
            inbox::inbox_take,
            inbox::inbox_read,
            naming::suggest_name,
            naming::namer_ready,
        ])
        .run(tauri::generate_context!())
        .expect("SyncDrop failed to start");
}
