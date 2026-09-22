//! Files that arrive from the Windows Share dialog.
//!
//! Windows starts the exe with no arguments and hands the files over through
//! the activation instead. Turning them back into arguments and starting again
//! sends them down the same road as "Send to": a window that is already open
//! gets them through the single-instance plugin, and otherwise the new process
//! opens with them queued.

use std::path::PathBuf;
use std::process::Command;

use windows::core::Interface;
use windows::ApplicationModel::Activation::{ActivationKind, ShareTargetActivatedEventArgs};
use windows::ApplicationModel::AppInstance;
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

/// True when this process was started by a share and has passed the files to
/// a new one, in which case it has nothing left to do.
pub fn relaunch_shared_files() -> bool {
    // On a thread of its own: the calls below want a multithreaded apartment,
    // and the main thread must stay free for the single-threaded one the window
    // sets up later.
    let paths = std::thread::spawn(shared_files).join().ok().flatten().unwrap_or_default();
    if paths.is_empty() {
        return false;
    }
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    Command::new(exe).args(&paths).spawn().is_ok()
}

fn shared_files() -> Option<Vec<PathBuf>> {
    unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.ok()?;
    // Fails outright for a process without a package identity, such as a dev
    // build, which is the same answer as "not a share".
    let args = AppInstance::GetActivatedEventArgs().ok()?;
    if args.Kind().ok()? != ActivationKind::ShareTarget {
        return None;
    }
    let share = args.cast::<ShareTargetActivatedEventArgs>().ok()?.ShareOperation().ok()?;

    let mut paths = Vec::new();
    if let Ok(items) = share.Data().and_then(|data| data.GetStorageItemsAsync()).and_then(|op| op.join()) {
        for index in 0..items.Size().unwrap_or(0) {
            // A folder or a virtual item has nothing to read as a file.
            let Ok(path) = items.GetAt(index).and_then(|item| item.Path()) else {
                continue;
            };
            let path = PathBuf::from(path.to_os_string());
            if path.is_file() {
                paths.push(path);
            }
        }
    }
    // Closes the share pane. The files are ours once their paths are known.
    let _ = share.ReportCompleted();
    Some(paths)
}
