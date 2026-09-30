/* ============================================================
   sparkBook · src-tauri/src/project_new.rs

   Host side of the Projects window: create a project folder, clone
   a repository into one, and read the branch each known project is
   on.

   Clone is the only long-running job. It runs `git` as a child
   process on the blocking pool with no terminal and no stdin, so a
   remote that wants a password fails with git's own message instead
   of hanging on a prompt nobody can see. One clone per window; the
   window can cancel it, and a window that closes takes its clone
   with it. A cancelled or failed clone removes what it wrote.
   ============================================================ */
use crate::HostError;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

/// Branch lookups answered per call. The Projects window lists at most
/// twenty projects; the cap only stops a malformed call from walking
/// the disk for a thousand.
const MAX_BRANCH_ROOTS: usize = 64;
/// Progress lines sent to the window at most this often.
const PROGRESS_EVERY: Duration = Duration::from_millis(120);
/// Lines of git's stderr kept for the error message.
const TAIL_LINES: usize = 6;
pub const CLONE_PROGRESS_EVENT: &str = "project://clone-progress";
pub const CANCELLED: &str = "cancelled";

/* ---------- Names and targets ---------- */

/// A folder name the OS will accept as one path segment.
pub fn valid_name(name: &str) -> Result<&str, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("the name is empty".into());
    }
    if n == "." || n == ".." {
        return Err("the name cannot be . or ..".into());
    }
    if n.len() > 255 {
        return Err("the name is longer than 255 bytes".into());
    }
    if n.chars().any(|c| c == '/' || c == '\\' || c.is_control()) {
        return Err("the name cannot contain slashes or control characters".into());
    }
    if cfg!(windows) && n.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')) {
        return Err("the name cannot contain < > : \" | ? *".into());
    }
    Ok(n)
}

fn is_empty_dir(p: &Path) -> bool {
    std::fs::read_dir(p)
        .map(|mut d| d.next().is_none())
        .unwrap_or(false)
}

fn lossy(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Where `name` lands under `parent`, if it is free: absent, or an
/// empty directory. Anything else would mix a new project into files
/// that are already there.
pub fn target(parent: &str, name: &str) -> Result<PathBuf, HostError> {
    let clean = valid_name(name).map_err(|reason| HostError::InvalidPath {
        path: name.to_string(),
        reason,
    })?;
    let parent_path = Path::new(parent);
    if !parent_path.is_absolute() {
        return Err(HostError::InvalidPath {
            path: parent.to_string(),
            reason: "the location must be an absolute path".into(),
        });
    }
    if !parent_path.is_dir() {
        return Err(HostError::NotFound {
            path: parent.to_string(),
        });
    }
    let dest = parent_path.join(clean);
    match std::fs::symlink_metadata(&dest) {
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(dest),
        Ok(m) if m.is_dir() && is_empty_dir(&dest) => Ok(dest),
        Ok(_) => Err(HostError::AlreadyExists { path: lossy(&dest) }),
        Err(e) => Err(e.into()),
    }
}

fn git_missing(e: &std::io::Error) -> HostError {
    if e.kind() == ErrorKind::NotFound {
        HostError::Internal {
            message: "Git is not installed or not on PATH".into(),
        }
    } else {
        HostError::Internal {
            message: e.to_string(),
        }
    }
}

/* ---------- Create ---------- */

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    pub path: String,
    /// Set when the folder was made but `git init` failed. The project
    /// is still usable, so this is a warning rather than an error.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_error: Option<String>,
}

pub fn create_blocking(parent: &str, name: &str, git_init: bool) -> Result<Created, HostError> {
    let dest = target(parent, name)?;
    match std::fs::create_dir(&dest) {
        Ok(()) => {}
        // `target` already vetted it as an empty directory.
        Err(e) if e.kind() == ErrorKind::AlreadyExists && is_empty_dir(&dest) => {}
        Err(e) if e.kind() == ErrorKind::AlreadyExists => {
            return Err(HostError::AlreadyExists { path: lossy(&dest) })
        }
        Err(e) if e.kind() == ErrorKind::PermissionDenied => {
            return Err(HostError::PermissionDenied { path: lossy(&dest) })
        }
        Err(e) => return Err(e.into()),
    }
    let git_error = if git_init {
        match Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(&dest)
            .stdin(Stdio::null())
            .output()
        {
            Ok(out) if out.status.success() => None,
            Ok(out) => Some(String::from_utf8_lossy(&out.stderr).trim().to_string()),
            Err(e) => Some(match git_missing(&e) {
                HostError::Internal { message } => message,
                other => other.to_string(),
            }),
        }
    } else {
        None
    };
    Ok(Created {
        path: lossy(&dest),
        git_error,
    })
}

#[tauri::command]
pub async fn project_create(parent: String, name: String, git_init: bool) -> Result<Created, HostError> {
    tauri::async_runtime::spawn_blocking(move || create_blocking(&parent, &name, git_init))
        .await
        .map_err(|e| HostError::Internal {
            message: e.to_string(),
        })?
}

/* ---------- Branch ---------- */

/// The branch checked out at `root`, or the short commit when HEAD is
/// detached. Read from `.git/HEAD` directly: spawning `git` twenty
/// times to fill a list is slow and fails when git is not installed.
pub fn git_branch(root: &Path) -> Option<String> {
    let dot = root.join(".git");
    let git_dir = if dot.is_dir() {
        dot
    } else {
        // Worktrees and submodules: `.git` is a file naming the real dir.
        let text = read_small(&dot)?;
        let rel = text.trim().strip_prefix("gitdir:")?.trim();
        let p = Path::new(rel);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            root.join(p)
        }
    };
    let head = read_small(&git_dir.join("HEAD"))?;
    let head = head.trim();
    if let Some(r) = head.strip_prefix("ref:") {
        let r = r.trim();
        let name = r.strip_prefix("refs/heads/").unwrap_or(r);
        return (!name.is_empty()).then(|| name.to_string());
    }
    (head.len() >= 7 && head.chars().all(|c| c.is_ascii_hexdigit())).then(|| head[..7].to_string())
}

/// A HEAD file is a line. Anything bigger is not one.
fn read_small(p: &Path) -> Option<String> {
    let f = std::fs::File::open(p).ok()?;
    let mut s = String::new();
    f.take(4096).read_to_string(&mut s).ok()?;
    Some(s)
}

#[tauri::command]
pub async fn project_git_branches(roots: Vec<String>) -> Result<Vec<Option<String>>, HostError> {
    tauri::async_runtime::spawn_blocking(move || {
        roots
            .iter()
            .take(MAX_BRANCH_ROOTS)
            .map(|r| git_branch(Path::new(r)))
            .collect()
    })
    .await
    .map_err(|e| HostError::Internal {
        message: e.to_string(),
    })
}

/* ---------- Clone ---------- */

struct Job {
    child: Mutex<Child>,
    /// git runs in a process group of its own (Unix), so a cancel can
    /// reach the helpers it forks: `git remote-http` outlived a kill of
    /// git alone, kept the stderr pipe open and kept dialling out.
    pid: u32,
    cancelled: AtomicBool,
}

/// Running clones, one per window label.
#[derive(Default)]
pub struct CloneManager {
    jobs: Mutex<HashMap<String, Arc<Job>>>,
}

impl CloneManager {
    fn guard(&self) -> MutexGuard<'_, HashMap<String, Arc<Job>>> {
        self.jobs.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn kill(job: &Job) {
    job.cancelled.store(true, Ordering::SeqCst);
    kill_group(job.pid);
    let mut child = job.child.lock().unwrap_or_else(|e| e.into_inner());
    let _ = child.kill();
}

#[cfg(unix)]
fn kill_group(pid: u32) {
    const SIGKILL: i32 = 9;
    if let Ok(pid) = i32::try_from(pid) {
        // SAFETY: kill takes plain integers; a negative pid names the
        // process group git leads, which holds nothing but git's own.
        unsafe {
            libc_kill(-pid, SIGKILL);
        }
    }
}

#[cfg(unix)]
extern "C" {
    #[link_name = "kill"]
    fn libc_kill(pid: i32, sig: i32) -> i32;
}

#[cfg(not(unix))]
fn kill_group(_pid: u32) {}

/// A remote git can be handed as one argument. `--` already stops it
/// being read as an option; this refuses what is plainly not a URL or
/// a path before a process is spent on it.
pub fn safe_remote(url: &str) -> bool {
    !url.is_empty()
        && url.len() <= 2048
        && !url.starts_with('-')
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// Remove what a failed clone left. `existed` means the target was an
/// empty directory before the clone, so only its contents go.
fn clean_up(dest: &Path, existed: bool) {
    if existed {
        if let Ok(entries) = std::fs::read_dir(dest) {
            for entry in entries.flatten() {
                let p = entry.path();
                let _ = if p.is_dir() && !p.is_symlink() {
                    std::fs::remove_dir_all(&p)
                } else {
                    std::fs::remove_file(&p)
                };
            }
        }
    } else if dest.exists() {
        let _ = std::fs::remove_dir_all(dest);
    }
}

/// Split git's progress stream on both `\r` and `\n`: git redraws its
/// counters with carriage returns.
fn drain(
    mut stderr: impl Read,
    mut on_line: impl FnMut(&str),
) -> Vec<String> {
    let mut tail: Vec<String> = Vec::new();
    let mut buf = [0u8; 4096];
    let mut pending: Vec<u8> = Vec::new();
    let mut push = |bytes: &[u8], tail: &mut Vec<String>| {
        let line = String::from_utf8_lossy(bytes).trim().to_string();
        if line.is_empty() {
            return;
        }
        on_line(&line);
        // Counter redraws of the same phase replace each other.
        let phase = line.split(':').next().unwrap_or("").to_string();
        if let Some(last) = tail.last_mut() {
            if last.split(':').next().unwrap_or("") == phase && line.contains('%') {
                *last = line;
                return;
            }
        }
        tail.push(line);
        if tail.len() > TAIL_LINES {
            tail.remove(0);
        }
    };
    loop {
        match stderr.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                for &b in &buf[..n] {
                    if b == b'\r' || b == b'\n' {
                        push(&pending, &mut tail);
                        pending.clear();
                    } else if pending.len() < 8192 {
                        pending.push(b);
                    }
                }
            }
        }
    }
    push(&pending, &mut tail);
    tail
}

fn failure_message(tail: &[String]) -> String {
    let fatal: Vec<&str> = tail
        .iter()
        .map(String::as_str)
        .filter(|l| l.starts_with("fatal:") || l.starts_with("error:"))
        .collect();
    let lines = if fatal.is_empty() {
        tail.iter().map(String::as_str).collect::<Vec<_>>()
    } else {
        fatal
    };
    let msg = lines.join("\n");
    if msg.is_empty() {
        "git clone failed".into()
    } else {
        msg
    }
}

fn clone_blocking(
    app: &tauri::AppHandle,
    label: &str,
    url: &str,
    parent: &str,
    name: &str,
) -> Result<String, HostError> {
    let url = url.trim();
    if !safe_remote(url) {
        return Err(HostError::InvalidPath {
            path: url.to_string(),
            reason: "not a repository URL or path".into(),
        });
    }
    let dest = target(parent, name)?;
    let existed = dest.exists();
    let manager = app.state::<CloneManager>();

    let (job, stderr) = {
        let mut jobs = manager.guard();
        if jobs.contains_key(label) {
            return Err(HostError::Internal {
                message: "a clone is already running in this window".into(),
            });
        }
        let mut cmd = Command::new("git");
        cmd.args(["clone", "--progress", "--", url])
            .arg(&dest)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            // No terminal to prompt on: fail with git's message instead.
            .env("GIT_TERMINAL_PROMPT", "0");
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd.spawn().map_err(|e| git_missing(&e))?;
        let stderr = child.stderr.take();
        let job = Arc::new(Job {
            pid: child.id(),
            child: Mutex::new(child),
            cancelled: AtomicBool::new(false),
        });
        jobs.insert(label.to_string(), job.clone());
        (job, stderr)
    };

    // The tail comes back over a channel rather than a join: should
    // anything still hold the pipe open, the command must return anyway.
    let (tail_tx, tail_rx) = std::sync::mpsc::channel::<Vec<String>>();
    if let Some(err) = stderr {
        let app = app.clone();
        let label = label.to_string();
        std::thread::spawn(move || {
            let mut last = Instant::now() - PROGRESS_EVERY;
            let tail = drain(err, |line| {
                if last.elapsed() >= PROGRESS_EVERY {
                    last = Instant::now();
                    let _ = app.emit_to(label.as_str(), CLONE_PROGRESS_EVENT, line);
                }
            });
            let _ = tail_tx.send(tail);
        });
    }

    // Polled rather than waited on, so a cancel can take the lock and
    // kill the child while this thread is still watching it.
    let status = loop {
        let polled = job
            .child
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .try_wait();
        match polled {
            Ok(Some(s)) => break Ok(s),
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => {
                kill(&job);
                break Err(e);
            }
        }
    };
    manager.guard().remove(label);
    let tail = tail_rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default();

    let cancelled = job.cancelled.load(Ordering::SeqCst);
    match status {
        Ok(s) if s.success() && !cancelled => Ok(lossy(&dest)),
        Ok(_) => {
            clean_up(&dest, existed);
            Err(HostError::Internal {
                message: if cancelled {
                    CANCELLED.into()
                } else {
                    failure_message(&tail)
                },
            })
        }
        Err(e) => {
            clean_up(&dest, existed);
            Err(e.into())
        }
    }
}

#[tauri::command]
pub async fn project_clone(
    window: tauri::Window,
    url: String,
    parent: String,
    name: String,
) -> Result<String, HostError> {
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || clone_blocking(&app, &label, &url, &parent, &name))
        .await
        .map_err(|e| HostError::Internal {
            message: e.to_string(),
        })?
}

/// Stop this window's clone. A no-op when none is running.
#[tauri::command]
pub fn project_clone_cancel(window: tauri::Window, manager: tauri::State<'_, CloneManager>) {
    let job = manager.guard().get(window.label()).cloned();
    if let Some(job) = job {
        kill(&job);
    }
}

/// A closing window takes its clone with it.
pub fn shutdown_window(manager: &CloneManager, label: &str) {
    let job = manager.guard().get(label).cloned();
    if let Some(job) = job {
        kill(&job);
    }
}

pub fn shutdown_all(manager: &CloneManager) {
    let jobs: Vec<Arc<Job>> = manager.guard().values().cloned().collect();
    for job in jobs {
        kill(&job);
    }
}

/* ---------- Windows ----------
   Window lookups for the Projects window. Answered here rather than
   by the JS window API so that "is it open, open it, focus it" is one
   host call instead of three round trips that can interleave with a
   second click. */

pub const PROJECTS_LABEL: &str = "projects";
pub const OPENER_EVENT: &str = "spark:projects:opener";

/// Tauri labels are `a-zA-Z0-9-/:_`; anything else is not a window.
fn valid_label(label: &str) -> bool {
    !label.is_empty()
        && label.len() <= 64
        && label
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '/' | ':' | '_'))
}

fn raise(w: &tauri::WebviewWindow) {
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
}

/// Open the Projects window, or bring it forward and tell it which
/// editor window is now "this window". Async, as Tauri asks of any
/// command that builds a window.
#[tauri::command]
pub async fn projects_window_open(app: tauri::AppHandle, opener: String) -> Result<(), HostError> {
    if !valid_label(&opener) {
        return Err(HostError::InvalidPath {
            path: opener,
            reason: "not a window label".into(),
        });
    }
    if let Some(w) = app.get_webview_window(PROJECTS_LABEL) {
        let _ = app.emit_to(PROJECTS_LABEL, OPENER_EVENT, serde_json::json!({ "label": opener }));
        raise(&w);
        return Ok(());
    }
    let url = format!("index.html?projects=1&opener={opener}");
    tauri::WebviewWindowBuilder::new(&app, PROJECTS_LABEL, tauri::WebviewUrl::App(url.into()))
        .title("Projects — sparkBook")
        .inner_size(960.0, 640.0)
        .min_inner_size(640.0, 440.0)
        .center()
        .resizable(true)
        // Native chrome, like the terminal pop-out: this window has no
        // rendered titlebar to drag it by.
        .decorations(true)
        .focused(true)
        .build()
        .map(|_| ())
        .map_err(|e| HostError::Internal {
            message: e.to_string(),
        })
}

/// Labels of the windows that exist right now.
#[tauri::command]
pub fn window_labels(app: tauri::AppHandle) -> Vec<String> {
    app.webview_windows().keys().cloned().collect()
}

/// Bring window `label` forward. False when it no longer exists.
#[tauri::command]
pub fn window_focus(app: tauri::AppHandle, label: String) -> bool {
    match app.get_webview_window(&label) {
        Some(w) => {
            raise(&w);
            true
        }
        None => false,
    }
}

/* ---------- Tests ---------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "spark-project-new-{tag}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn names_that_are_not_one_segment_are_refused() {
        assert!(valid_name("app").is_ok());
        assert_eq!(valid_name("  app  ").unwrap(), "app");
        assert!(valid_name("").is_err());
        assert!(valid_name("   ").is_err());
        assert!(valid_name(".").is_err());
        assert!(valid_name("..").is_err());
        assert!(valid_name("a/b").is_err());
        assert!(valid_name("a\\b").is_err());
        assert!(valid_name("a\nb").is_err());
        assert!(valid_name(&"x".repeat(256)).is_err());
    }

    #[test]
    fn create_makes_the_folder_and_refuses_a_non_empty_one() {
        let parent = scratch("create");
        let p = parent.to_string_lossy().to_string();
        let made = create_blocking(&p, "fresh", false).unwrap();
        assert!(Path::new(&made.path).is_dir());
        assert!(made.git_error.is_none());

        // An empty directory is taken as-is.
        assert!(create_blocking(&p, "fresh", false).is_ok());

        std::fs::write(Path::new(&made.path).join("f.txt"), "x").unwrap();
        assert!(matches!(
            create_blocking(&p, "fresh", false),
            Err(HostError::AlreadyExists { .. })
        ));
        std::fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn create_needs_an_existing_absolute_location() {
        assert!(matches!(
            create_blocking("relative/dir", "x", false),
            Err(HostError::InvalidPath { .. })
        ));
        assert!(matches!(
            create_blocking("/definitely/not/here/spark", "x", false),
            Err(HostError::NotFound { .. })
        ));
    }

    #[test]
    fn branch_is_read_from_head_worktree_file_and_detached_head() {
        let root = scratch("branch");
        assert_eq!(git_branch(&root), None);

        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".git/HEAD"), "ref: refs/heads/feature/x\n").unwrap();
        assert_eq!(git_branch(&root).as_deref(), Some("feature/x"));

        std::fs::write(root.join(".git/HEAD"), "0123456789abcdef0123456789abcdef01234567\n").unwrap();
        assert_eq!(git_branch(&root).as_deref(), Some("0123456"));

        let wt = scratch("worktree");
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", root.join(".git").display())).unwrap();
        assert_eq!(git_branch(&wt).as_deref(), Some("0123456"));

        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&wt).unwrap();
    }

    #[test]
    fn remotes_that_look_like_options_or_carry_spaces_are_refused() {
        assert!(safe_remote("https://github.com/a/b.git"));
        assert!(safe_remote("git@github.com:a/b.git"));
        assert!(safe_remote("/home/me/repo"));
        assert!(!safe_remote(""));
        assert!(!safe_remote("--upload-pack=touch /tmp/x"));
        assert!(!safe_remote("https://a.com/b c"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_cancel_kills_the_helpers_git_forks_too() {
        use std::os::unix::process::CommandExt;
        // A parent that forks a child and waits: the shape of git clone
        // and its `git remote-http` helper.
        let mut child = Command::new("sh")
            .args(["-c", "sleep 30 & wait"])
            .process_group(0)
            .spawn()
            .unwrap();
        let pid = child.id();
        std::thread::sleep(Duration::from_millis(200));
        kill_group(pid);
        child.wait().unwrap();
        std::thread::sleep(Duration::from_millis(200));
        let left = Command::new("pgrep").args(["-g", &pid.to_string()]).output().unwrap();
        assert!(
            String::from_utf8_lossy(&left.stdout).trim().is_empty(),
            "processes left in the group: {}",
            String::from_utf8_lossy(&left.stdout)
        );
    }

    #[test]
    fn only_tauri_labels_pass() {
        assert!(valid_label("main"));
        assert!(valid_label("editor-3"));
        assert!(!valid_label(""));
        assert!(!valid_label("main&x=1"));
        assert!(!valid_label("a b"));
    }

    #[test]
    fn progress_redraws_collapse_and_fatal_lines_win() {
        let input = b"Cloning into 'x'...\rReceiving objects:  10% (1/10)\rReceiving objects: 100% (10/10)\nfatal: repository not found\n";
        let mut seen = 0;
        let tail = drain(&input[..], |_| seen += 1);
        assert_eq!(seen, 4);
        assert_eq!(
            tail,
            vec![
                "Cloning into 'x'...".to_string(),
                "Receiving objects: 100% (10/10)".to_string(),
                "fatal: repository not found".to_string(),
            ]
        );
        assert_eq!(failure_message(&tail), "fatal: repository not found");
    }

    #[test]
    fn a_local_clone_lands_and_a_failed_one_leaves_nothing() {
        if Command::new("git").arg("--version").output().is_err() {
            return; // no git on this machine
        }
        let parent = scratch("clone");
        let src = parent.join("src");
        std::fs::create_dir_all(&src).unwrap();
        let ok = Command::new("git").args(["init", "--quiet"]).current_dir(&src).status().unwrap();
        assert!(ok.success());

        // The command itself needs a running app for its events; this
        // runs the same command line and the same clean-up.
        let dest = parent.join("copy");
        let status = Command::new("git")
            .args(["clone", "--quiet", "--"])
            .arg(&src)
            .arg(&dest)
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        assert!(dest.join(".git").is_dir());

        let bad = parent.join("bad");
        let status = Command::new("git")
            .args(["clone", "--quiet", "--"])
            .arg(parent.join("missing-repo"))
            .arg(&bad)
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(!status.success());
        clean_up(&bad, false);
        assert!(!bad.exists());

        std::fs::remove_dir_all(&parent).unwrap();
    }
}
