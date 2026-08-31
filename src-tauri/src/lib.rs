mod files;
mod naming;
mod vault;

use files::Downloads;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Downloads::default())
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
            naming::suggest_name,
        ])
        .run(tauri::generate_context!())
        .expect("SyncDrop failed to start");
}
