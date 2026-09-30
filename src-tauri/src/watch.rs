/* ============================================================
   sparkBook · src-tauri/src/watch.rs

   Filesystem watching for the explorer.

   The renderer already had the whole client half of this — a
   `watch_path` / `unwatch_path` bridge and a `file:changed`
   subscription wired up in App.tsx — but no host command existed,
   so `watchPath` would have thrown and the subscription listened
   for an event nothing ever emitted. The tree therefore showed
   whatever was on disk when a directory was last expanded, and
   never noticed a change made outside the app.

   Events are coalesced over a short window: a single `git checkout`
   or `npm install` produces thousands of raw notifications, and
   forwarding each one would make the renderer re-read directories
   faster than it can paint them.

   The subscription is NOT a blanket recursive watch. Opening a
   real project — a Flutter tree with `.plugin_symlinks` pointing
   into the pub cache, a repo with `node_modules`, anything with a
   populated `build/` — made notify walk hundreds of thousands of
   directories, follow symlinks out of the project entirely, and
   register an inotify watch for each one. Instead the host walks
   the tree itself: it skips build and dependency directories, never
   descends through a symlink, stops at a fixed budget, and adds one
   non-recursive watch per surviving directory. New directories are
   picked up from their own create events.
   ============================================================ */

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::HostError;

/// How long to gather events before emitting. Long enough to collapse a
/// bulk operation, short enough that a single save still feels immediate.
const COALESCE: Duration = Duration::from_millis(120);

/// Ceiling on directories watched per subscription. A project big enough
/// to pass this is one where the explorer's own lazy directory reads are
/// the better refresh path anyway; watching every leaf of it costs kernel
/// watch descriptors and buys almost nothing.
const WATCH_BUDGET: usize = 4_096;

/// Depth cap, so a pathological tree cannot reach the budget through
/// nesting alone and leave the top levels of the project unwatched.
const MAX_DEPTH: usize = 12;

/// Most changes the renderer is told about per flush. Past this the
/// explorer is told to refresh rather than handed a list it would only
/// use to refresh anyway — a `git checkout` of a large repo should not
/// become thousands of IPC messages.
const MAX_CHANGES_PER_FLUSH: usize = 64;

/// Directory names never worth watching: build output, dependency
/// caches, VCS internals, and editor/tooling scratch space. They churn
/// constantly, they are usually the largest part of a tree by directory
/// count, and a change inside one is not something the explorer shows.
const SKIP_DIRS: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".jj",
    "node_modules",
    "bower_components",
    "vendor",
    "target",
    "build",
    "dist",
    "out",
    "coverage",
    ".dart_tool",
    ".plugin_symlinks",
    "ephemeral",
    ".pub-cache",
    "Pods",
    "DerivedData",
    ".gradle",
    ".idea",
    ".vscode-test",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".angular",
    ".parcel-cache",
    ".cache",
    "__pycache__",
    ".venv",
    "venv",
    ".mypy_cache",
    ".pytest_cache",
    ".tox",
    ".terraform",
    ".stack-work",
    ".ccls-cache",
    ".cargo",
];

fn is_skipped(name: &std::ffi::OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    SKIP_DIRS.contains(&name)
}

/// Directories to watch under `root`, breadth-first.
///
/// `DirEntry::file_type` does not resolve symlinks, so a symlinked
/// directory reports as a symlink and is never descended into. That is
/// what stops a Flutter project's `.plugin_symlinks` from dragging the
/// whole pub cache into the watch set — and it also makes a symlink
/// cycle impossible to walk into.
fn watchable_dirs(root: &Path) -> (Vec<PathBuf>, bool) {
    let mut out = vec![root.to_path_buf()];
    let mut frontier = vec![root.to_path_buf()];
    let mut depth = 0usize;
    let mut truncated = false;

    while !frontier.is_empty() && depth < MAX_DEPTH {
        let mut next = Vec::new();
        for dir in frontier.drain(..) {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                // An unreadable directory is not an error worth failing the
                // whole subscription over; it just cannot be watched.
                continue;
            };
            for entry in entries.flatten() {
                if out.len() >= WATCH_BUDGET {
                    return (out, true);
                }
                let Ok(ft) = entry.file_type() else { continue };
                if !ft.is_dir() {
                    continue;
                }
                let name = entry.file_name();
                if is_skipped(&name) {
                    continue;
                }
                let path = entry.path();
                out.push(path.clone());
                next.push(path);
            }
        }
        frontier = next;
        depth += 1;
        if depth == MAX_DEPTH && !frontier.is_empty() {
            truncated = true;
        }
    }

    (out, truncated)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// "created" | "removed" | "modified" | "renamed", or "bulk" (empty
    /// path) when a flush held more changes than are sent one by one.
    pub kind: String,
    pub path: String,
    /// Previous path, for a rename the OS reported as a pair.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

struct Watch {
    /// Dropping the watcher stops the OS-level subscription. It is shared
    /// with the event thread, which adds watches for directories created
    /// after the initial walk.
    _watcher: Arc<Mutex<RecommendedWatcher>>,
    stop: Arc<AtomicBool>,
    /// The window that asked for it. A watcher outlives its window only
    /// if nobody claims it, and with several editor windows open that is
    /// a thread and an inotify budget leaked per window closed.
    owner: String,
}

#[derive(Default)]
pub struct WatchManager {
    watches: Mutex<HashMap<String, Watch>>,
    next_id: AtomicU64,
}

fn poisoned<T>(_: T) -> HostError {
    HostError::Internal {
        message: "watch manager lock poisoned".into(),
    }
}

fn kind_name(kind: &EventKind) -> Option<&'static str> {
    match kind {
        EventKind::Create(_) => Some("created"),
        EventKind::Remove(_) => Some("removed"),
        EventKind::Modify(notify::event::ModifyKind::Name(_)) => Some("renamed"),
        EventKind::Modify(_) => Some("modified"),
        // Access events fire on every read; forwarding them would make the
        // explorer refresh whenever anything merely opened a file.
        EventKind::Access(_) | EventKind::Any | EventKind::Other => None,
    }
}

/// Turn a batch of raw notify events into the smallest set of changes the
/// renderer needs. The explorer refreshes a whole directory per event, so
/// one change per (kind, path) is all that can matter.
fn coalesce(events: Vec<Event>) -> Vec<FileChange> {
    let mut seen: Vec<FileChange> = Vec::new();
    for event in events {
        let Some(kind) = kind_name(&event.kind) else {
            continue;
        };
        // notify reports a rename as one event carrying both paths.
        let (path, from) = match (event.paths.first(), event.paths.get(1)) {
            (Some(a), Some(b)) => (b.clone(), Some(a.to_string_lossy().to_string())),
            (Some(a), None) => (a.clone(), None),
            _ => continue,
        };
        let path = path.to_string_lossy().to_string();
        if seen
            .iter()
            .any(|c| c.kind == kind && c.path == path && c.from == from)
        {
            continue;
        }
        seen.push(FileChange {
            kind: kind.to_string(),
            path,
            from,
        });
    }
    seen
}

#[tauri::command]
pub fn watch_path(
    app: AppHandle,
    window: tauri::Window,
    manager: tauri::State<'_, WatchManager>,
    path: String,
) -> Result<String, HostError> {
    let target = std::path::PathBuf::from(&path);
    if !target.exists() {
        return Err(HostError::NotFound { path });
    }

    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let mut watcher = RecommendedWatcher::new(tx, Config::default()).map_err(|e| {
        HostError::Internal {
            message: format!("watcher: {e}"),
        }
    })?;

    let (dirs, truncated) = watchable_dirs(&target);

    // The root must be watchable; the rest is best effort, because a
    // directory can disappear between the walk and the registration and
    // that is not a reason to leave the project unwatched.
    for (i, dir) in dirs.iter().enumerate() {
        match watcher.watch(dir, RecursiveMode::NonRecursive) {
            Ok(()) => {}
            Err(e) if i == 0 => {
                return Err(match e.kind {
                    notify::ErrorKind::PathNotFound => HostError::NotFound { path: path.clone() },
                    notify::ErrorKind::MaxFilesWatch => HostError::Internal {
                        message:
                            "the system watch limit was reached (raise fs.inotify.max_user_watches)"
                                .into(),
                    },
                    _ => HostError::Internal {
                        message: format!("watch {path}: {e}"),
                    },
                });
            }
            Err(_) => {}
        }
    }

    if truncated {
        log::info!(
            "watch {path}: tree exceeded the watch budget; watching {} directories",
            dirs.len()
        );
    }

    let watcher = Arc::new(Mutex::new(watcher));
    let id = format!("watch-{}", manager.next_id.fetch_add(1, Ordering::SeqCst) + 1);
    let stop = Arc::new(AtomicBool::new(false));
    let owner = window.label().to_string();

    {
        let stop = stop.clone();
        let watcher = watcher.clone();
        let owner = owner.clone();
        let mut watched = dirs.len();
        std::thread::spawn(move || {
            let mut batch: Vec<Event> = Vec::new();
            let mut window_opened: Option<Instant> = None;

            loop {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                // Wake regularly so a batch still flushes once the source
                // goes quiet, and so `stop` is noticed promptly.
                match rx.recv_timeout(Duration::from_millis(60)) {
                    Ok(Ok(event)) => {
                        batch.push(event);
                        window_opened.get_or_insert_with(Instant::now);
                    }
                    Ok(Err(_)) => {} // a dropped event is not worth tearing down for
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }

                let due = window_opened.is_some_and(|t| t.elapsed() >= COALESCE);
                if due && !batch.is_empty() {
                    let changes = coalesce(std::mem::take(&mut batch));

                    // A directory created after the initial walk gets its
                    // own watch, or changes inside it would be invisible.
                    for change in &changes {
                        if change.kind != "created" && change.kind != "renamed" {
                            continue;
                        }
                        if watched >= WATCH_BUDGET {
                            break;
                        }
                        let p = std::path::Path::new(&change.path);
                        if !p.is_dir() || p.file_name().is_some_and(is_skipped) {
                            continue;
                        }
                        // A symlinked directory is skipped for the same
                        // reason the walk skips one.
                        if std::fs::symlink_metadata(p)
                            .map(|m| m.file_type().is_symlink())
                            .unwrap_or(true)
                        {
                            continue;
                        }
                        if let Ok(mut w) = watcher.lock() {
                            if w.watch(p, RecursiveMode::NonRecursive).is_ok() {
                                watched += 1;
                            }
                        }
                    }

                    // Past the cap the explorer would re-read the same
                    // directories anyway, so send a bounded prefix and one
                    // marker instead of thousands of messages.
                    // Addressed to the window that asked. Broadcasting
                    // would make every other window re-read directories
                    // for a project it does not have open.
                    if changes.len() > MAX_CHANGES_PER_FLUSH {
                        for change in changes.into_iter().take(MAX_CHANGES_PER_FLUSH) {
                            let _ = app.emit_to(owner.as_str(), "file:changed", change);
                        }
                        let _ = app.emit_to(
                            owner.as_str(),
                            "file:changed",
                            FileChange {
                                kind: "bulk".to_string(),
                                path: String::new(),
                                from: None,
                            },
                        );
                    } else {
                        for change in changes {
                            let _ = app.emit_to(owner.as_str(), "file:changed", change);
                        }
                    }
                    window_opened = None;
                } else if due {
                    window_opened = None;
                }
            }
        });
    }

    manager.watches.lock().map_err(poisoned)?.insert(
        id.clone(),
        Watch {
            _watcher: watcher,
            stop,
            owner,
        },
    );
    Ok(id)
}

#[tauri::command]
pub fn unwatch_path(
    manager: tauri::State<'_, WatchManager>,
    id: String,
) -> Result<(), HostError> {
    // Unwatching an unknown id is documented as a no-op: callers unwatch
    // during teardown, where racing with an earlier cleanup is normal.
    if let Some(watch) = manager.watches.lock().map_err(poisoned)?.remove(&id) {
        watch.stop.store(true, Ordering::SeqCst);
    }
    Ok(())
}

/// Stop the watchers one window asked for. Called when that window is
/// destroyed, so its threads go with it and the others carry on.
pub fn shutdown_window(manager: &WatchManager, label: &str) {
    if let Ok(mut watches) = manager.watches.lock() {
        watches.retain(|_, watch| {
            if watch.owner != label {
                return true;
            }
            watch.stop.store(true, Ordering::SeqCst);
            false
        });
    }
}

/// Stop every watcher. Called on exit so no thread outlives the app.
pub fn shutdown_all(manager: &WatchManager) {
    if let Ok(mut watches) = manager.watches.lock() {
        for (_, watch) in watches.drain() {
            watch.stop.store(true, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, ModifyKind, RenameMode};
    use std::path::PathBuf;

    fn ev(kind: EventKind, paths: &[&str]) -> Event {
        Event {
            kind,
            paths: paths.iter().map(PathBuf::from).collect(),
            attrs: Default::default(),
        }
    }

    #[test]
    fn access_events_are_dropped() {
        // Otherwise merely reading a file would refresh the explorer.
        assert!(kind_name(&EventKind::Access(notify::event::AccessKind::Read)).is_none());
        assert_eq!(kind_name(&EventKind::Create(CreateKind::File)), Some("created"));
        assert_eq!(
            kind_name(&EventKind::Modify(ModifyKind::Name(RenameMode::Both))),
            Some("renamed")
        );
    }

    #[test]
    fn duplicate_events_collapse_to_one() {
        // A single save can emit several identical modify events.
        let batch = vec![
            ev(EventKind::Modify(ModifyKind::Any), &["/w/a.md"]),
            ev(EventKind::Modify(ModifyKind::Any), &["/w/a.md"]),
            ev(EventKind::Modify(ModifyKind::Any), &["/w/a.md"]),
        ];
        let out = coalesce(batch);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].path, "/w/a.md");
        assert_eq!(out[0].kind, "modified");
    }

    #[test]
    fn distinct_paths_are_all_reported() {
        let batch = vec![
            ev(EventKind::Create(CreateKind::File), &["/w/a.md"]),
            ev(EventKind::Create(CreateKind::File), &["/w/b.md"]),
        ];
        assert_eq!(coalesce(batch).len(), 2);
    }

    #[test]
    fn a_rename_carries_both_paths() {
        let batch = vec![ev(
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            &["/w/old.md", "/w/new.md"],
        )];
        let out = coalesce(batch);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, "renamed");
        assert_eq!(out[0].path, "/w/new.md");
        assert_eq!(out[0].from.as_deref(), Some("/w/old.md"));
    }

    #[test]
    fn access_noise_is_filtered_out_of_a_batch() {
        let batch = vec![
            ev(
                EventKind::Access(notify::event::AccessKind::Read),
                &["/w/a.md"],
            ),
            ev(EventKind::Remove(notify::event::RemoveKind::File), &["/w/a.md"]),
        ];
        let out = coalesce(batch);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].kind, "removed");
    }

    /// The walk is what stops a project like a Flutter app — whose
    /// `.plugin_symlinks` point into the pub cache — from turning one
    /// "open folder" into tens of thousands of inotify watches.
    #[test]
    fn the_walk_skips_build_dirs_and_never_follows_a_symlink() {
        let root = std::env::temp_dir().join(format!("spark-walk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("lib/src")).expect("mkdir");
        std::fs::create_dir_all(root.join("node_modules/left-pad")).expect("mkdir");
        std::fs::create_dir_all(root.join("build/intermediates")).expect("mkdir");
        std::fs::create_dir_all(root.join(".git/objects")).expect("mkdir");

        // Somewhere outside the project, reached only through a symlink.
        let outside = std::env::temp_dir().join(format!("spark-walk-out-{}", std::process::id()));
        std::fs::create_dir_all(outside.join("deep/deeper")).expect("mkdir");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, root.join("linked")).expect("symlink");

        let (dirs, truncated) = watchable_dirs(&root);
        assert!(!truncated);

        let has = |suffix: &str| dirs.iter().any(|d| d.ends_with(suffix));
        assert!(has("lib"), "the project's own directories are watched");
        assert!(has("lib/src"), "and so are their children");
        assert!(!has("node_modules"), "dependency trees are skipped");
        assert!(!has("build"), "build output is skipped");
        assert!(!has(".git"), "VCS internals are skipped");
        #[cfg(unix)]
        assert!(
            !dirs.iter().any(|d| d.starts_with(&outside)) && !has("linked"),
            "a symlinked directory is never descended into: {dirs:?}"
        );

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    /// Exercises the real OS watcher: create a file in a temp dir and
    /// confirm notify reports it through the same filter the command uses.
    #[test]
    fn a_real_file_creation_is_reported() {
        let dir = std::env::temp_dir().join(format!("spark-watch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir");

        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
        let mut watcher = RecommendedWatcher::new(tx, Config::default()).expect("watcher");
        watcher
            .watch(&dir, RecursiveMode::Recursive)
            .expect("watch");

        // inotify registration is asynchronous; write after a beat or the
        // event can land before the watch is armed.
        std::thread::sleep(Duration::from_millis(150));
        std::fs::write(dir.join("created.txt"), b"hi").expect("write");

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut batch = Vec::new();
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(Ok(e)) => batch.push(e),
                Ok(Err(_)) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if !batch.is_empty() {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        drop(watcher);
        let changes = coalesce(batch);
        let _ = std::fs::remove_dir_all(&dir);

        assert!(
            changes.iter().any(|c| c.path.ends_with("created.txt")),
            "watcher never reported the new file; got {changes:?}"
        );
    }

    #[test]
    fn an_event_with_no_path_is_skipped() {
        assert!(coalesce(vec![ev(EventKind::Create(CreateKind::File), &[])]).is_empty());
    }
}
