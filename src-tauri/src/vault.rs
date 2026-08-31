//! Where the device identity lives on disk.
//!
//! The identity private keys are the whole security model - there is no account
//! to fall back on - so on Windows the file is sealed with DPAPI, tied to the
//! logged-in user. Another account on the same machine, or the raw file copied
//! elsewhere, cannot be unsealed.

use std::fs;
use std::io;
use std::path::PathBuf;

const APP_DIR: &str = "SyncDrop";

fn safe_key(key: &str) -> Option<String> {
    if key.is_empty() || key.len() > 96 {
        return None;
    }
    if !key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
    {
        return None;
    }
    Some(key.to_string())
}

fn vault_dir() -> io::Result<PathBuf> {
    let base = dirs::data_dir()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no data directory on this system"))?;
    let dir = base.join(APP_DIR);
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn entry_path(key: &str) -> Result<PathBuf, String> {
    let key = safe_key(key).ok_or_else(|| "Invalid vault key".to_string())?;
    let dir = vault_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{key}.bin")))
}

#[cfg(windows)]
mod seal {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
    };

    fn take(blob: &CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let out = unsafe { std::slice::from_raw_parts(blob.pbData, blob.cbData as usize) }.to_vec();
        unsafe {
            let _ = LocalFree(Some(HLOCAL(blob.pbData as *mut _)));
        }
        out
    }

    pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: plain.len() as u32,
            pbData: plain.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptProtectData(
                &input,
                PCWSTR::null(),
                None,
                None,
                None,
                0,
                &mut output,
            )
            .map_err(|e| format!("DPAPI could not seal the vault: {e}"))?;
        }
        Ok(take(&output))
    }

    pub fn unprotect(sealed: &[u8]) -> Result<Vec<u8>, String> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: sealed.len() as u32,
            pbData: sealed.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptUnprotectData(&input, None, None, None, None, 0, &mut output)
                .map_err(|e| format!("DPAPI could not open the vault: {e}"))?;
        }
        Ok(take(&output))
    }
}

#[cfg(not(windows))]
mod seal {
    pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
        Ok(plain.to_vec())
    }
    pub fn unprotect(sealed: &[u8]) -> Result<Vec<u8>, String> {
        Ok(sealed.to_vec())
    }
}

#[tauri::command]
pub fn vault_load(key: String) -> Result<Option<String>, String> {
    let path = entry_path(&key)?;
    let sealed = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let plain = seal::unprotect(&sealed)?;
    String::from_utf8(plain)
        .map(Some)
        .map_err(|_| "Vault entry is not valid UTF-8".to_string())
}

#[tauri::command]
pub fn vault_save(key: String, value: String) -> Result<(), String> {
    let path = entry_path(&key)?;
    let sealed = seal::protect(value.as_bytes())?;
    // Write-then-rename: a crash mid-write must not destroy an identity that
    // cannot be recovered from anywhere else.
    let temp = path.with_extension("tmp");
    fs::write(&temp, &sealed).map_err(|e| e.to_string())?;
    fs::rename(&temp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vault_clear(key: String) -> Result<(), String> {
    let path = entry_path(&key)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "Windows PC".to_string())
}
