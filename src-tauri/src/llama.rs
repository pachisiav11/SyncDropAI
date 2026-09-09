//! The local vision model, run by a llama.cpp server the app ships itself.
//!
//! This replaces a dependency on a separately installed Ollama, which was the
//! last thing SyncDrop asked somebody to go and set up. Three things follow
//! from owning the process instead of borrowing one: the weights are fetched
//! once from Hugging Face, the server starts only when a name is actually
//! wanted, and it stops again when it goes idle - so a feature nobody is using
//! does not hold about 1.7 GB of a laptop for the whole session.
//!
//! The upstream prebuilt `llama-server` is used rather than linking llama.cpp,
//! because that build dispatches across the `ggml-cpu-*.dll` variants at run
//! time and therefore works on machines without AVX-512, instead of needing a
//! build per CPU.

use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const REPO: &str = "https://huggingface.co/openbmb/MiniCPM-V-4.6-gguf/resolve/main";

/// The language weights. Q6_K rather than Q8_0 because the projector below is a
/// fixed 1.11 GB that cannot be quantised without hurting what the model can
/// see, so paying for the largest language quant buys the least per megabyte.
const MODEL_FILE: &str = "MiniCPM-V-4_6-Q6_K.gguf";

/// The vision projector. Kept at f16 deliberately: quantising a vision encoder
/// costs far more accuracy than quantising the language model it feeds.
const MMPROJ_FILE: &str = "mmproj-model-f16.gguf";

/// Loading 1.7 GB from a cold disk is not quick, and this is a first-run cost.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(180);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(180);

/// How long the server may sit unused before it is shut down. Naming happens in
/// bursts - somebody shares six files at once - so keeping it warm across a
/// burst matters, and keeping it warm all afternoon does not.
const IDLE_TIMEOUT: Duration = Duration::from_secs(180);

fn env_path(key: &str) -> Option<PathBuf> {
    std::env::var_os(key).map(PathBuf::from).filter(|p| p.exists())
}

/// Where the weights live. One directory, outside the install tree, so an app
/// update never re-downloads them and uninstalling does not silently bin them.
pub fn model_dir() -> PathBuf {
    if let Some(dir) = env_path("SYNCDROP_MODEL_DIR") {
        return dir;
    }
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("SyncDrop")
        .join("models")
}

pub fn model_path() -> PathBuf {
    model_dir().join(MODEL_FILE)
}

pub fn mmproj_path() -> PathBuf {
    model_dir().join(MMPROJ_FILE)
}

pub fn models_present() -> bool {
    model_path().exists() && mmproj_path().exists()
}

/// `llama-server` ships beside the app. In a build tree it is still in the
/// repository, which is what makes `cargo test` able to reach the real model.
fn server_binary() -> Option<PathBuf> {
    if let Some(path) = env_path("SYNCDROP_LLAMA_SERVER") {
        return Some(path);
    }

    let name = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };

    let beside_exe = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("vendor").join("llama.cpp").join(name)));
    if let Some(path) = beside_exe.filter(|p| p.exists()) {
        return Some(path);
    }

    let in_repo = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("vendor")
        .join("llama.cpp")
        .join(name);
    in_repo.exists().then_some(in_repo)
}

pub fn server_available() -> bool {
    server_binary().is_some()
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .build()
        .into()
}

// --- fetching the weights ---------------------------------------------------

/// Download both files, reporting bytes as they land. The caller turns that
/// into something on screen: 1.7 GB with no feedback reads as a hang.
pub fn fetch(mut progress: impl FnMut(u64, u64)) -> Result<(), String> {
    let dir = model_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create {}: {e}", dir.display()))?;

    let wanted: Vec<(&str, PathBuf)> = vec![
        (MODEL_FILE, model_path()),
        (MMPROJ_FILE, mmproj_path()),
    ];

    // Both totals are needed before the first byte, or the progress bar jumps
    // when the second file starts.
    let mut total = 0u64;
    let mut sizes = Vec::new();
    for (name, target) in &wanted {
        if target.exists() {
            sizes.push(0);
            continue;
        }
        let size = content_length(name)?;
        sizes.push(size);
        total += size;
    }

    let mut done = 0u64;
    progress(done, total);

    for ((name, target), size) in wanted.iter().zip(sizes) {
        if target.exists() {
            continue;
        }
        download_one(name, target, size, &mut done, total, &mut progress)?;
    }
    Ok(())
}

fn content_length(name: &str) -> Result<u64, String> {
    let response = agent(Duration::from_secs(30))
        .head(&format!("{REPO}/{name}"))
        .call()
        .map_err(|e| format!("Cannot reach Hugging Face for {name}: {e}"))?;

    response
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .ok_or_else(|| format!("Hugging Face did not say how large {name} is"))
}

fn download_one(
    name: &str,
    target: &PathBuf,
    size: u64,
    done: &mut u64,
    total: u64,
    progress: &mut impl FnMut(u64, u64),
) -> Result<(), String> {
    // Written beside the target and renamed at the end, so an interrupted
    // download can never be mistaken for a usable model.
    let part = target.with_extension("part");

    let response = agent(Duration::from_secs(60 * 60))
        .get(&format!("{REPO}/{name}"))
        .call()
        .map_err(|e| format!("Cannot download {name}: {e}"))?;

    let mut reader = response.into_body().into_reader();
    let mut file = std::fs::File::create(&part)
        .map_err(|e| format!("Cannot write {}: {e}", part.display()))?;

    let mut buffer = vec![0u8; 1024 * 1024];
    let mut written = 0u64;
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|e| format!("{name} stopped early: {e}"))?;
        if read == 0 {
            break;
        }
        std::io::Write::write_all(&mut file, &buffer[..read])
            .map_err(|e| format!("Cannot write {}: {e}", part.display()))?;
        written += read as u64;
        progress(*done + written, total);
    }
    drop(file);

    if size > 0 && written != size {
        let _ = std::fs::remove_file(&part);
        return Err(format!("{name} arrived incomplete ({written} of {size} bytes)"));
    }

    std::fs::rename(&part, target)
        .map_err(|e| format!("Cannot finish {}: {e}", target.display()))?;
    *done += written;
    Ok(())
}

// --- the server -------------------------------------------------------------

struct Running {
    child: Child,
    port: u16,
    used: Instant,
    #[cfg(windows)]
    _job: Option<job::Job>,
}

/// Tie the server's lifetime to ours.
///
/// `Drop` covers a clean exit, but nothing runs on a hard kill - Task Manager,
/// an installer replacing the exe, a panic. Each of those would strand a server
/// holding well over a gigabyte. A job object with `KILL_ON_JOB_CLOSE` is the
/// answer the OS gives: the kernel closes the handle however the process dies,
/// and the child goes with it.
#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Job(HANDLE);

    // The handle is touched only here and in Drop.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    pub fn adopt(child: &Child) -> Option<Job> {
        unsafe {
            let handle = CreateJobObjectW(None, None).ok()?;
            let job = Job(handle);

            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .ok()?;

            AssignProcessToJobObject(handle, HANDLE(child.as_raw_handle())).ok()?;
            Some(job)
        }
    }
}

fn engine() -> &'static Mutex<Option<Running>> {
    static ENGINE: OnceLock<Mutex<Option<Running>>> = OnceLock::new();
    ENGINE.get_or_init(|| Mutex::new(None))
}

fn free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("No free port for the model server: {e}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|e| format!("No free port for the model server: {e}"))
}

fn start() -> Result<Running, String> {
    let binary = server_binary().ok_or("llama-server is missing from this install")?;
    if !models_present() {
        return Err("The naming model has not been downloaded yet".to_string());
    }

    let port = free_port()?;
    let mut cmd = Command::new(&binary);
    cmd.arg("--model")
        .arg(model_path())
        .arg("--mmproj")
        .arg(mmproj_path())
        .arg("--port")
        .arg(port.to_string())
        .arg("--host")
        .arg("127.0.0.1")
        // Naming reads at most the first slice of one file and answers in a
        // handful of words, so a small window keeps the KV cache cheap.
        .arg("--ctx-size")
        .arg("4096")
        // Render the model's own chat template rather than llama.cpp's
        // approximation, or the thinking switch below is quietly ignored.
        .arg("--jinja")
        .arg("--no-webui")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: never flash a console at somebody sharing a file.
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Cannot start {}: {e}", binary.display()))?;

    #[cfg(windows)]
    let owned = job::adopt(&child);

    // Drain both pipes, or a full buffer stops the server mid-answer.
    for stream in [
        child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>),
        child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        std::thread::spawn(move || {
            for _ in BufReader::new(stream).lines().map_while(Result::ok) {}
        });
    }

    let running = Running {
        child,
        port,
        used: Instant::now(),
        #[cfg(windows)]
        _job: owned,
    };
    await_ready(port)?;
    Ok(running)
}

fn await_ready(port: u16) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{port}/health");
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    while Instant::now() < deadline {
        if agent(Duration::from_secs(2)).get(&url).call().is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err("The model server did not come up in time".to_string())
}

/// Stop the server once it has been unused for [`IDLE_TIMEOUT`]. Started with
/// the first server and left running; it costs one sleeping thread.
fn start_reaper() {
    static REAPER: OnceLock<()> = OnceLock::new();
    REAPER.get_or_init(|| {
        std::thread::spawn(|| loop {
            std::thread::sleep(Duration::from_secs(30));
            let mut guard = match engine().lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            let idle = guard
                .as_ref()
                .is_some_and(|running| running.used.elapsed() > IDLE_TIMEOUT);
            if idle {
                if let Some(mut running) = guard.take() {
                    let _ = running.child.kill();
                    let _ = running.child.wait();
                }
            }
        });
    });
}

/// Ask the model to describe something. `image` is raw bytes of a format the
/// vision encoder accepts; text-only callers pass `None`.
pub fn describe(prompt: &str, image: Option<String>) -> Result<String, String> {
    let mut guard = match engine().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };

    if guard.is_none() {
        *guard = Some(start()?);
        start_reaper();
    }
    let port = {
        let running = guard.as_mut().expect("just started");
        running.used = Instant::now();
        running.port
    };

    let content = match image {
        Some(base64) => serde_json::json!([
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": format!("data:image/jpeg;base64,{base64}")}}
        ]),
        None => serde_json::json!(prompt),
    };

    let body = serde_json::json!({
        "messages": [{"role": "user", "content": content}],
        "temperature": 0.1,
        "max_tokens": 40,
        "stream": false,
        // Without this a reasoning backbone spends the whole budget thinking
        // and answers with an empty string.
        "chat_template_kwargs": {"enable_thinking": false},
    });

    let answer = agent(REQUEST_TIMEOUT)
        .post(&format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .send_json(&body);

    // A server that has died stays dead, and a handle to it would fail every
    // later call in the same way. Forget it so the next name starts a new one.
    let mut response = match answer {
        Ok(response) => response,
        Err(e) => {
            if let Some(mut dead) = guard.take() {
                let _ = dead.child.kill();
                let _ = dead.child.wait();
            }
            return Err(format!("The model did not answer: {e}"));
        }
    };

    let parsed: serde_json::Value = response
        .body_mut()
        .read_json()
        .map_err(|e| format!("The model returned something unreadable: {e}"))?;

    Ok(parsed
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .to_string())
}

/// Fetch the weights, reporting progress to the window as they arrive.
///
/// Blocking work on a blocking thread: this moves well over a gigabyte and must
/// not sit on the async pool that also answers the app's own commands.
#[tauri::command]
pub async fn namer_fetch(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Emitter;
        fetch(|done, total| {
            let _ = app.emit("namer-progress", serde_json::json!({ "done": done, "total": total }));
        })
    })
    .await
    .map_err(|e| format!("The download could not start: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The download URLs are built by hand, so a typo in either filename would
    /// only surface the first time somebody switched naming on - by which point
    /// they are staring at a failure with 1.7 GB of intent behind it. A HEAD
    /// request costs nothing and proves both names still resolve.
    #[test]
    fn the_weights_are_where_we_think_they_are() {
        let Ok(model) = content_length(MODEL_FILE) else {
            eprintln!("skipped: Hugging Face is not reachable from here");
            return;
        };
        let mmproj = content_length(MMPROJ_FILE).expect("the projector must resolve too");
        eprintln!("model {model} bytes, projector {mmproj} bytes");
        assert!(model > 500_000_000, "the language weights should be around 630 MB");
        assert!(mmproj > 1_000_000_000, "the projector should be around 1.11 GB");
    }
}
