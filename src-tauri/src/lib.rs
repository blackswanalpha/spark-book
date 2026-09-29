mod checkpoint;
mod pty;
mod pty_sink;
mod update_env;
mod watch;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::Manager;
use tauri_plugin_store::StoreExt;
use thiserror::Error;

#[derive(Error, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data")]
pub enum HostError {
    #[error("not found: {path}")]
    NotFound { path: String },
    #[error("permission denied: {path}")]
    PermissionDenied { path: String },
    #[error("not utf-8: {path}")]
    NotUtf8 { path: String },
    #[error("is a directory: {path}")]
    IsADirectory { path: String },
    #[error("already exists: {path}")]
    AlreadyExists { path: String },
    #[error("invalid path: {path}: {reason}")]
    InvalidPath { path: String, reason: String },
    #[error("internal: {message}")]
    Internal { message: String },
}

impl From<std::io::Error> for HostError {
    fn from(e: std::io::Error) -> Self {
        HostError::Internal {
            message: e.to_string(),
        }
    }
}

#[derive(Serialize, Deserialize)]
pub struct WriteReceipt {
    pub path: String,
    pub bytes: usize,
    pub mtime: String,
    pub device: u64,
    pub inode: u64,
}

#[tauri::command]
fn read_file(path: String) -> Result<String, HostError> {
    std::fs::read_to_string(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => HostError::NotFound { path: path.clone() },
        std::io::ErrorKind::PermissionDenied => HostError::PermissionDenied { path: path.clone() },
        std::io::ErrorKind::InvalidData => HostError::NotUtf8 { path: path.clone() },
        _ => HostError::Internal {
            message: e.to_string(),
        },
    })
}

#[tauri::command]
fn write_file(path: String, contents: String) -> Result<WriteReceipt, HostError> {
    std::fs::write(&path, &contents)?;
    let meta = std::fs::metadata(&path)?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| {
            let secs = d.as_secs() as i64;
            // basic ISO 8601 UTC
            chrono::DateTime::<chrono::Utc>::from_timestamp(secs, 0)
                .map(|dt| dt.to_rfc3339())
                .unwrap_or_default()
        })
        .unwrap_or_default();
    Ok(WriteReceipt {
        path,
        bytes: contents.len(),
        mtime,
        device: 0,
        inode: 0,
    })
}

#[tauri::command]
fn read_dir(path: String) -> Result<Vec<DirEntry>, HostError> {
    let mut out = vec![];
    for entry in std::fs::read_dir(&path)? {
        let entry = entry?;
        let meta = entry.metadata().ok();
        out.push(DirEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            is_file: meta.as_ref().map(|m| m.is_file()).unwrap_or(false),
            is_dir: meta.as_ref().map(|m| m.is_dir()).unwrap_or(false),
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    Ok(out)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub is_file: bool,
    pub is_dir: bool,
}

#[tauri::command]
fn stat(path: String) -> Result<FileStat, HostError> {
    let meta = std::fs::metadata(&path)?;
    Ok(FileStat {
        path: path.clone(),
        is_file: meta.is_file(),
        is_dir: meta.is_dir(),
        size: meta.len(),
        mtime: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|d| {
                chrono::DateTime::<chrono::Utc>::from_timestamp(d.as_secs() as i64, 0)
                    .map(|dt| dt.to_rfc3339())
            })
            .unwrap_or_default(),
    })
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub path: String,
    pub is_file: bool,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: String,
}

#[tauri::command]
fn create_file(path: String, contents: Option<String>) -> Result<FileStat, HostError> {
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => HostError::AlreadyExists { path: path.clone() },
            std::io::ErrorKind::NotFound => HostError::NotFound { path: path.clone() },
            std::io::ErrorKind::PermissionDenied => {
                HostError::PermissionDenied { path: path.clone() }
            }
            std::io::ErrorKind::IsADirectory => HostError::IsADirectory { path: path.clone() },
            _ => HostError::Internal {
                message: e.to_string(),
            },
        })?;
    if let Some(contents) = contents.as_deref() {
        std::io::Write::write_all(&mut &file, contents.as_bytes()).map_err(|e| {
            HostError::Internal {
                message: e.to_string(),
            }
        })?;
    }
    drop(file);
    let meta = std::fs::metadata(&path)?;
    Ok(FileStat {
        path,
        is_file: meta.is_file(),
        is_dir: meta.is_dir(),
        size: meta.len(),
        mtime: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|d| {
                chrono::DateTime::<chrono::Utc>::from_timestamp(d.as_secs() as i64, 0)
                    .map(|dt| dt.to_rfc3339())
            })
            .unwrap_or_default(),
    })
}

#[tauri::command]
fn mkdir(path: String) -> Result<(), HostError> {
    match std::fs::create_dir_all(&path) {
        Ok(()) => Ok(()),
        Err(e) => match e.kind() {
            std::io::ErrorKind::PermissionDenied => {
                Err(HostError::PermissionDenied { path: path.clone() })
            }
            _ => Err(HostError::Internal {
                message: e.to_string(),
            }),
        },
    }
}

#[tauri::command]
fn rename(from: String, to: String) -> Result<(), HostError> {
    if std::fs::metadata(&to).is_ok() {
        return Err(HostError::AlreadyExists { path: to });
    }
    if let Some(parent) = std::path::Path::new(&to).parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(&from, &to)?;
    Ok(())
}

/// Remove `path`. By default it goes to the OS trash so the user can
/// restore it; `permanent` skips the trash (Shift+Delete in the explorer).
/// A trash failure is reported rather than silently falling back to a
/// permanent delete: the user asked for something recoverable.
#[tauri::command]
fn delete(path: String, permanent: Option<bool>) -> Result<(), HostError> {
    let meta = std::fs::metadata(&path)?;
    if !permanent.unwrap_or(false) {
        return trash::delete(&path).map_err(|e| HostError::Internal {
            message: format!("could not move to trash: {e}"),
        });
    }
    if meta.is_dir() {
        std::fs::remove_dir_all(&path)?;
    } else {
        std::fs::remove_file(&path)?;
    }
    Ok(())
}

#[tauri::command]
fn copy(from: String, to: String) -> Result<(), HostError> {
    if std::fs::metadata(&to).is_ok() {
        return Err(HostError::AlreadyExists { path: to });
    }
    if let Some(parent) = std::path::Path::new(&to).parent() {
        std::fs::create_dir_all(parent)?;
    }
    let meta = std::fs::metadata(&from)?;
    if meta.is_dir() {
        copy_dir_recursive(std::path::Path::new(&from), std::path::Path::new(&to))?;
    } else {
        std::fs::copy(&from, &to)?;
    }
    Ok(())
}

fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

#[tauri::command]
fn open_in_terminal(cwd: String) -> Result<(), HostError> {
    use std::process::Command;
    let (shell, args) = if cfg!(target_os = "macos") {
        // `open -a Terminal <cwd>` opens Terminal.app at `cwd`.
        ("open".to_string(), vec!["-a".to_string(), "Terminal".to_string(), cwd.clone()])
    } else if cfg!(target_os = "windows") {
        // `cmd /K cd /d <cwd>` opens a new console window rooted at `cwd`.
        ("cmd".to_string(), vec!["/C".to_string(), "start".to_string(), "cmd".to_string(), "/K".to_string(), format!("cd /d {}", cwd)])
    } else {
        // Linux / *BSD: try common terminal emulators; fall back to x-terminal-emulator.
        for term in ["x-terminal-emulator", "gnome-terminal", "konsole", "alacritty", "xterm"] {
            if Command::new("which").arg(term).output().map(|o| o.status.success()).unwrap_or(false) {
                let arg = match term {
                    "gnome-terminal" => format!("--working-directory={}", cwd),
                    "konsole" => format!("--workdir {}", cwd),
                    "alacritty" => format!("--working-directory {}", cwd),
                    _ => cwd.clone(),
                };
                return Command::new(term)
                    .args([arg.as_str()])
                    .spawn()
                    .map(|_| ())
                    .map_err(|e| HostError::Internal { message: e.to_string() });
            }
        }
        return Err(HostError::Internal { message: "No terminal emulator found".to_string() });
    };
    Command::new(&shell)
        .args(&args)
        .spawn()
        .map(|_| ())
        .map_err(|e| HostError::Internal { message: e.to_string() })
}

#[tauri::command]
fn reveal_in_folder(path: String) -> Result<(), HostError> {
    use std::process::Command;
    if cfg!(target_os = "macos") {
        Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map(|_| ())
            .map_err(|e| HostError::Internal { message: e.to_string() })
    } else if cfg!(target_os = "windows") {
        Command::new("explorer")
            .arg(format!("/select,{}", path))
            .spawn()
            .map(|_| ())
            .map_err(|e| HostError::Internal { message: e.to_string() })
    } else {
        let parent = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "/".to_string());
        Command::new("xdg-open")
            .arg(&parent)
            .spawn()
            .map(|_| ())
            .map_err(|e| HostError::Internal { message: e.to_string() })
    }
}

#[tauri::command]
fn open_with_os(path: String) -> Result<(), HostError> {
    use std::process::Command;
    if cfg!(target_os = "macos") {
        Command::new("open").arg(&path).spawn().map(|_| ()).map_err(|e| HostError::Internal { message: e.to_string() })
    } else if cfg!(target_os = "windows") {
        Command::new("cmd").args(["/C", "start", "", &path]).spawn().map(|_| ()).map_err(|e| HostError::Internal { message: e.to_string() })
    } else {
        Command::new("xdg-open").arg(&path).spawn().map(|_| ()).map_err(|e| HostError::Internal { message: e.to_string() })
    }
}

/// Whether a link from terminal output may be handed to the OS.
///
/// Terminal output is untrusted text. Only web links pass, and nothing
/// that a shell would split or that `cmd /C start` would treat as a
/// second command.
fn safe_url(url: &str) -> bool {
    (url.starts_with("https://") || url.starts_with("http://"))
        && url.len() <= 4096
        && !url
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '"' | '`' | '<' | '>'))
}

/// Open a web link clicked in the terminal in the default browser.
#[tauri::command]
fn open_url(url: String) -> Result<(), HostError> {
    use std::process::Command;
    if !safe_url(&url) {
        return Err(HostError::InvalidPath {
            path: url,
            reason: "only http(s) links can be opened".into(),
        });
    }
    let spawned = if cfg!(target_os = "macos") {
        Command::new("open").arg(&url).spawn()
    } else if cfg!(target_os = "windows") {
        // No shell in between: `cmd /C start` would run whatever follows
        // an `&` in the query string.
        Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &url])
            .spawn()
    } else {
        Command::new("xdg-open").arg(&url).spawn()
    };
    spawned.map(|_| ()).map_err(|e| HostError::Internal {
        message: e.to_string(),
    })
}

/// Let the webview stream one file through the asset protocol. The
/// configured scope is empty, so the media player can reach exactly the
/// files the user opened and nothing else on disk.
#[tauri::command]
fn media_allow(app: tauri::AppHandle, path: String) -> Result<(), HostError> {
    let p = std::path::Path::new(&path);
    if !p.is_file() {
        return Err(HostError::NotFound { path });
    }
    app.asset_protocol_scope()
        .allow_file(p)
        .map_err(|e| HostError::Internal {
            message: e.to_string(),
        })
}

#[tauri::command]
fn read_file_base64(path: String) -> Result<String, HostError> {
    let bytes = std::fs::read(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => HostError::NotFound { path: path.clone() },
        std::io::ErrorKind::PermissionDenied => HostError::PermissionDenied { path: path.clone() },
        _ => HostError::Internal {
            message: e.to_string(),
        },
    })?;
    // base64 encode without extra deps: use base64 crate if available, else manual
    // Use `base64` via `tauri`'s dependency if present; fallback to manual.
    // We add base64 crate as optional; implement simple encode.
    Ok(encode_base64(&bytes))
}

#[tauri::command]
fn write_file_base64(path: String, contents: String) -> Result<WriteReceipt, HostError> {
    let bytes = decode_base64(&contents).ok_or_else(|| HostError::Internal {
        message: "contents is not valid base64".to_string(),
    })?;
    std::fs::write(&path, &bytes)?;
    let meta = std::fs::metadata(&path)?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|d| chrono::DateTime::<chrono::Utc>::from_timestamp(d.as_secs() as i64, 0))
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_default();
    Ok(WriteReceipt {
        path,
        bytes: bytes.len(),
        mtime,
        device: 0,
        inode: 0,
    })
}

/// Decode standard base64 (with or without `=` padding). Whitespace and
/// newlines are skipped so a wrapped data-URI payload decodes as-is.
/// Returns `None` on any character outside the alphabet.
fn decode_base64(input: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a') as u32 + 26),
            b'0'..=b'9' => Some((c - b'0') as u32 + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for &c in input.as_bytes() {
        if c == b'=' || c.is_ascii_whitespace() {
            continue;
        }
        let v = val(c)?;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xFF) as u8);
        }
    }
    Some(out)
}

fn encode_base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    let mut i = 0;
    while i < input.len() {
        let b0 = input[i] as u32;
        let b1 = if i + 1 < input.len() {
            input[i + 1] as u32
        } else {
            0
        };
        let b2 = if i + 2 < input.len() {
            input[i + 2] as u32
        } else {
            0
        };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((triple >> 18) & 0x3F) as usize] as char);
        out.push(TABLE[((triple >> 12) & 0x3F) as usize] as char);
        out.push(if i + 1 < input.len() {
            TABLE[((triple >> 6) & 0x3F) as usize] as char
        } else {
            '='
        });
        out.push(if i + 2 < input.len() {
            TABLE[(triple & 0x3F) as usize] as char
        } else {
            '='
        });
        i += 3;
    }
    out
}

const RECENTS_STORE: &str = "recents.json";
const RECENTS_KEY: &str = "paths";
const RECENTS_MAX: usize = 25;

fn recents_load(app: &tauri::AppHandle) -> Result<Vec<String>, HostError> {
    let store = app.store(RECENTS_STORE).map_err(|e| HostError::Internal {
        message: e.to_string(),
    })?;
    let list = store
        .get(RECENTS_KEY)
        .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
        .unwrap_or_default();
    Ok(list)
}

fn recents_save(app: &tauri::AppHandle, list: &[String]) -> Result<(), HostError> {
    let store = app.store(RECENTS_STORE).map_err(|e| HostError::Internal {
        message: e.to_string(),
    })?;
    store.set(RECENTS_KEY, json!(list));
    store.save().map_err(|e| HostError::Internal {
        message: e.to_string(),
    })?;
    Ok(())
}

#[tauri::command]
fn recents_get(app: tauri::AppHandle) -> Result<Vec<String>, HostError> {
    recents_load(&app)
}

#[tauri::command]
fn recents_add(app: tauri::AppHandle, path: String) -> Result<Vec<String>, HostError> {
    let mut list = recents_load(&app)?;
    if path.is_empty() {
        return Ok(list);
    }
    list.retain(|p| p != &path);
    list.insert(0, path);
    if list.len() > RECENTS_MAX {
        list.truncate(RECENTS_MAX);
    }
    recents_save(&app, &list)?;
    Ok(list)
}

#[tauri::command]
fn recents_clear(app: tauri::AppHandle) -> Result<(), HostError> {
    recents_save(&app, &[])?;
    Ok(())
}

/// Labels the checkpoint may open. Fixed rather than derived so the
/// window-state plugin's denylist can be built before any window exists.
const CHECKPOINT_LABELS: [&str; checkpoint::MAX_WINDOWS] = [
    "editor-1", "editor-2", "editor-3", "editor-4", "editor-5", "editor-6", "editor-7", "editor-8",
];

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_os::init())
        // The checkpoint owns the geometry of the windows it reopens, so
        // the window-state plugin is kept off those labels: two authorities
        // for one window's position is how a window ends up somewhere
        // neither of them chose.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&CHECKPOINT_LABELS)
                .build(),
        )
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        // Trace is far too loud for a shipped app: notify alone logs a
        // line per inotify registration, which on a large project means
        // tens of thousands of lines written to stdout and to a 40 KB
        // rotating file before the window is even usable. Debug builds
        // keep app-level detail; the noisy dependencies are capped in
        // both.
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(if cfg!(debug_assertions) {
                    log::LevelFilter::Debug
                } else {
                    log::LevelFilter::Info
                })
                .level_for("notify", log::LevelFilter::Warn)
                .level_for("notify_types", log::LevelFilter::Warn)
                .level_for("notify::inotify", log::LevelFilter::Warn)
                .level_for("tao", log::LevelFilter::Warn)
                .level_for("wry", log::LevelFilter::Warn)
                .level_for("hyper", log::LevelFilter::Warn)
                .level_for("polling", log::LevelFilter::Warn)
                .build(),
        )
        .manage(checkpoint::CheckpointManager::default())
        .manage(pty::PtyManager::default())
        .manage(watch::WatchManager::default())
        .invoke_handler(tauri::generate_handler![
            read_file,
            read_file_base64,
            media_allow,
            write_file,
            write_file_base64,
            read_dir,
            stat,
            create_file,
            mkdir,
            rename,
            delete,
            copy,
            open_in_terminal,
            reveal_in_folder,
            open_with_os,
            open_url,
            recents_get,
            recents_add,
            recents_clear,
            checkpoint::checkpoint_load,
            checkpoint::checkpoint_claim_restore,
            checkpoint::checkpoint_save_window,
            checkpoint::checkpoint_save_project,
            checkpoint::checkpoint_remove_project,
            checkpoint::checkpoint_open_window,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_refresh,
            pty::pty_scroll,
            pty::pty_kill,
            pty::pty_adopt,
            pty::pty_list,
            pty::pty_root_support,
            pty::pty_default_shell,
            pty::pty_set_palette,
            pty::pty_search,
            update_env::update_environment,
            update_env::restart_app,
            watch::watch_path,
            watch::unwatch_path,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let manager = app.state::<checkpoint::CheckpointManager>();
            checkpoint::init(&handle, &manager);
            Ok(())
        })
        .on_window_event(|window, event| {
            // A closing window takes its own resources and nothing else.
            // It used to be that "main" closing tore down every shell and
            // every watcher in the process, which was right when main was
            // the only editor window and is a way to kill three other
            // windows' terminals now that it is not.
            if let tauri::WindowEvent::Destroyed = event {
                let handle = window.app_handle();
                let label = window.label();
                if let Some(manager) = handle.try_state::<pty::PtyManager>() {
                    pty::shutdown_window(&manager, label);
                }
                if let Some(manager) = handle.try_state::<watch::WatchManager>() {
                    watch::shutdown_window(&manager, label);
                }
                if checkpoint::tracks_window(label) {
                    if let Some(manager) = handle.try_state::<checkpoint::CheckpointManager>() {
                        checkpoint::on_window_destroyed(&manager, label);
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                // Windows are destroyed after this, and a window
                // destroyed on the way out must keep its row: that table
                // is the session the next launch reopens.
                tauri::RunEvent::ExitRequested { .. } => {
                    if let Some(manager) = app.try_state::<checkpoint::CheckpointManager>() {
                        checkpoint::mark_exiting(&manager);
                    }
                }
                tauri::RunEvent::Exit => {
                    if let Some(manager) = app.try_state::<checkpoint::CheckpointManager>() {
                        checkpoint::mark_exiting(&manager);
                    }
                    if let Some(manager) = app.try_state::<pty::PtyManager>() {
                        pty::shutdown_all(&manager);
                    }
                    if let Some(manager) = app.try_state::<watch::WatchManager>() {
                        watch::shutdown_all(&manager);
                    }
                }
                _ => {}
            }
        });
}

#[cfg(test)]
mod url_tests {
    use super::safe_url;

    #[test]
    fn only_plain_web_links_pass() {
        assert!(safe_url("https://example.com/a?b=1&c=2#x"));
        assert!(safe_url("http://localhost:1420/"));
        assert!(!safe_url("file:///etc/passwd"));
        assert!(!safe_url("javascript:alert(1)"));
        assert!(!safe_url("https://a.com/ x"));
        assert!(!safe_url("https://a.com/\"&calc"));
        assert!(!safe_url("https://a.com/\ncalc"));
    }
}
