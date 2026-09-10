mod files;
mod inbox;
mod llama;
mod naming;
mod vault;

use files::Downloads;
use inbox::Inbox;
use tauri::Manager;

// The app no longer registers a service worker, but a version that did left one
// behind, and it outlives the code that created it. WebView2 serves the window
// from a custom protocol that a worker's own fetch cannot reach, so the worker
// answered every request from a cache holding the previous version's shell. That
// shell names a bundle this build does not ship, so the module load failed and
// no script ran at all: the window painted its markup and nothing in it worked.
// The page cannot undo this, because nothing on the page runs. Clearing the store
// is the only way out, and it has to happen before the webview opens the files.
#[cfg(target_os = "windows")]
fn discard_service_workers(identifier: &str) {
    let Some(local) = dirs::data_local_dir() else {
        return;
    };
    let store = local
        .join(identifier)
        .join("EBWebView")
        .join("Default")
        .join("Service Worker");
    if store.exists() {
        let _ = std::fs::remove_dir_all(&store);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();

    #[cfg(target_os = "windows")]
    discard_service_workers(&context.config().identifier);

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
            llama::namer_fetch,
            llama::namer_progress,
        ])
        .run(context)
        .expect("SyncDrop failed to start");
}
