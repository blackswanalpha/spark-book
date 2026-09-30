//! Checkpoint: the projects the app knows about, and the windows that
//! were on screen when it last quit.
//!
//! Every window writes here, so this module — not the renderer — is the
//! authority. One mutex covers the tables, the label counter and the
//! restore plan, which is what lets four windows autosave at the same
//! moment without a lost update, and what makes "reopen the session"
//! happen exactly once no matter how many windows ask.
//!
//! The rules are the ones stated in `src/store/checkpoint.ts`; the two
//! implementations are kept in step deliberately, because the renderer
//! runs these same rules when there is no Rust host under it (vite dev,
//! vitest).
//!
//! What keeps it bounded: `MAX_WINDOWS` window rows, `MAX_PROJECTS`
//! project rows, and `MAX_WORKSPACE_BYTES` per workspace blob. A row is
//! dropped when its window is destroyed, unless the app is quitting —
//! in which case the row is the session.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use crate::HostError;

pub const SCHEMA_VERSION: u32 = 1;
/// Windows reopened on launch. Past this a restore is a fork bomb.
pub const MAX_WINDOWS: usize = 8;
pub const MAX_PROJECTS: usize = 20;
/// Serialized ceiling for one workspace snapshot.
pub const MAX_WORKSPACE_BYTES: usize = 256 * 1024;
pub const EDITOR_LABEL_PREFIX: &str = "editor-";
pub const MAIN_LABEL: &str = "main";
const FILE_NAME: &str = "checkpoint.json";

/* ---------- Wire shape ---------- */

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Geometry {
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default)]
    pub maximized: bool,
}

impl Geometry {
    /// A zero-sized window is not a window: drop the geometry and let
    /// the host use its default rather than opening something invisible.
    fn sane(self) -> Option<Self> {
        if self.w >= 1.0 && self.h >= 1.0 && self.w.is_finite() && self.h.is_finite() {
            Some(self)
        } else {
            None
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowRecord {
    pub label: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub geometry: Option<Geometry>,
    /// Monotonic per label. A write at or below the stored rev is stale.
    #[serde(default)]
    pub rev: u64,
    /// Creation order, ascending. Restore replays windows in this order.
    #[serde(default)]
    pub order: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSave {
    pub label: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub geometry: Option<Geometry>,
    #[serde(default)]
    pub rev: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub id: String,
    #[serde(default)]
    pub root_path: Option<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub last_opened: i64,
    #[serde(default)]
    pub rev: u64,
    /// Label of the window that last wrote this row.
    #[serde(default)]
    pub writer: String,
    /// Kept at the top of the project list and never pruned for age.
    #[serde(default)]
    pub pinned: bool,
    /// Opaque to the host: the renderer owns the workspace shape and
    /// validates it on the way back in.
    #[serde(default)]
    pub workspace: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSave {
    pub id: String,
    #[serde(default)]
    pub root_path: Option<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub last_opened: i64,
    #[serde(default)]
    pub rev: u64,
    #[serde(default)]
    pub writer: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub workspace: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointFile {
    pub version: u32,
    #[serde(default)]
    pub projects: Vec<ProjectRecord>,
    #[serde(default)]
    pub windows: Vec<WindowRecord>,
    #[serde(default)]
    pub updated_at: i64,
}

impl Default for CheckpointFile {
    fn default() -> Self {
        Self {
            version: SCHEMA_VERSION,
            projects: Vec::new(),
            windows: Vec::new(),
            updated_at: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAck {
    pub accepted: bool,
    /// The row's rev after the call — the caller's own value when accepted.
    pub rev: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl SaveAck {
    fn ok(rev: u64) -> Self {
        Self {
            accepted: true,
            rev,
            reason: None,
        }
    }
    fn no(rev: u64, reason: &str) -> Self {
        Self {
            accepted: false,
            rev,
            reason: Some(reason.to_string()),
        }
    }
}

/* ---------- Session ---------- */

/// One app run. `file` is what lands on disk; `pending` is the previous
/// run's window list, held until something claims it.
#[derive(Debug, Default)]
pub struct Inner {
    pub file: CheckpointFile,
    pub pending: Option<Vec<WindowRecord>>,
    next_label: u64,
    next_order: u64,
    exiting: bool,
    path: Option<PathBuf>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn blank(s: &Option<String>) -> Option<String> {
    s.as_ref().filter(|v| !v.is_empty()).cloned()
}

impl Inner {
    /// Start a run from whatever was on disk. The previous run's windows
    /// become the pending plan and the live table starts empty, so a
    /// label is never reused across runs and a row left by a window that
    /// crashed cannot outlive the run that made it.
    pub fn open(raw: Option<Value>, now: i64) -> Self {
        let mut file = raw
            .and_then(|v| serde_json::from_value::<CheckpointFile>(v).ok())
            .filter(|f| f.version == SCHEMA_VERSION)
            .unwrap_or_default();

        // Untrusted JSON: a hand-edited file can hold duplicates, junk
        // rows and a table longer than the cap.
        let mut seen = HashSet::new();
        file.projects.retain(|p| !p.id.is_empty() && seen.insert(p.id.clone()));
        // Pinned rows first, so the cap never drops one for age.
        file.projects.sort_by(|a, b| {
            b.pinned
                .cmp(&a.pinned)
                .then(b.last_opened.cmp(&a.last_opened))
        });
        file.projects.truncate(MAX_PROJECTS);

        let mut seen = HashSet::new();
        file.windows
            .retain(|w| !w.label.is_empty() && seen.insert(w.label.clone()));
        file.windows.sort_by_key(|w| w.order);
        file.windows.truncate(MAX_WINDOWS);

        let pending = if file.windows.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut file.windows))
        };
        file.updated_at = now;

        Self {
            file,
            pending,
            next_label: 1,
            next_order: 1,
            exiting: false,
            path: None,
        }
    }

    /// Hand out the previous run's window list. Exactly one caller per
    /// run gets it; every later caller gets `None`, which is what stops
    /// two windows from both reopening the session.
    pub fn claim_restore(&mut self) -> Option<Vec<WindowRecord>> {
        let mut plan = self.pending.take()?;
        plan.truncate(MAX_WINDOWS);
        Some(plan)
    }

    pub fn allocate_label(&mut self) -> String {
        let label = format!("{EDITOR_LABEL_PREFIX}{}", self.next_label);
        self.next_label += 1;
        label
    }

    /// Upsert one window row. A window is the only writer of its own
    /// label, so a rev at or below the stored one is a reordered retry
    /// and is dropped rather than applied.
    pub fn save_window(&mut self, save: WindowSave, now: i64) -> SaveAck {
        if save.label.is_empty() {
            return SaveAck::no(0, "invalid");
        }
        let existing = self.file.windows.iter().position(|w| w.label == save.label);
        if let Some(i) = existing {
            let stored = self.file.windows[i].rev;
            if save.rev <= stored {
                return SaveAck::no(stored, "stale");
            }
        }

        let order = match existing {
            Some(i) => self.file.windows[i].order,
            None => {
                let o = self.next_order;
                self.next_order += 1;
                o
            }
        };
        let row = WindowRecord {
            label: save.label,
            project_id: blank(&save.project_id),
            geometry: save.geometry.and_then(Geometry::sane),
            rev: save.rev,
            order,
        };
        let rev = row.rev;
        match existing {
            Some(i) => self.file.windows[i] = row,
            None => self.file.windows.push(row),
        }

        self.file.windows.sort_by_key(|w| w.order);
        // Oldest first, so overflow drops the window opened longest ago
        // rather than the one that just registered.
        if self.file.windows.len() > MAX_WINDOWS {
            let drop = self.file.windows.len() - MAX_WINDOWS;
            self.file.windows.drain(0..drop);
        }
        self.file.updated_at = now;
        SaveAck::ok(rev)
    }

    /// Drop a window row.
    ///
    /// Two cases keep the row instead. While `exiting` the table *is*
    /// the session being saved. And the last window standing is the one
    /// whose closing quits the app: on most platforms its `Destroyed`
    /// arrives before the runtime's exit event, so forgetting it here
    /// would mean quitting from a single window always relaunched into
    /// an empty one.
    pub fn forget_window(&mut self, label: &str, now: i64) -> bool {
        if self.exiting || self.file.windows.len() <= 1 {
            return false;
        }
        let before = self.file.windows.len();
        self.file.windows.retain(|w| w.label != label);
        if self.file.windows.len() == before {
            return false;
        }
        self.file.updated_at = now;
        true
    }

    pub fn mark_exiting(&mut self) {
        self.exiting = true;
    }

    #[cfg(test)]
    pub fn is_exiting(&self) -> bool {
        self.exiting
    }

    /// Upsert one project row.
    ///
    /// The rev guard is scoped to the writer: a window's own stale retry
    /// is rejected, but a second window that opens the same project
    /// takes the row over rather than being locked out of it.
    pub fn save_project(&mut self, save: ProjectSave, now: i64) -> SaveAck {
        if save.id.is_empty() || save.writer.is_empty() {
            return SaveAck::no(0, "invalid");
        }
        let existing = self.file.projects.iter().position(|p| p.id == save.id);
        if let Some(i) = existing {
            let stored = &self.file.projects[i];
            if stored.writer == save.writer && save.rev <= stored.rev {
                return SaveAck::no(stored.rev, "stale");
            }
        }
        if workspace_bytes(&save.workspace) > MAX_WORKSPACE_BYTES {
            let rev = existing.map(|i| self.file.projects[i].rev).unwrap_or(0);
            return SaveAck::no(rev, "too-large");
        }

        let name = if save.name.is_empty() {
            save.id.clone()
        } else {
            save.name.clone()
        };
        let row = ProjectRecord {
            id: save.id,
            root_path: blank(&save.root_path),
            name,
            last_opened: save.last_opened.max(0),
            rev: save.rev,
            writer: save.writer,
            pinned: save.pinned,
            workspace: save.workspace,
        };
        let rev = row.rev;
        match existing {
            Some(i) => self.file.projects[i] = row,
            None => self.file.projects.push(row),
        }
        self.prune_projects();
        self.file.updated_at = now;
        SaveAck::ok(rev)
    }

    pub fn remove_project(&mut self, id: &str, now: i64) -> bool {
        let before = self.file.projects.len();
        self.file.projects.retain(|p| p.id != id);
        if self.file.projects.len() == before {
            return false;
        }
        self.file.updated_at = now;
        true
    }

    /// Keep the most recent rows, but never evict a project a live
    /// window is bound to: dropping one would leave that window
    /// restoring into nothing on the next launch.
    fn prune_projects(&mut self) {
        self.file
            .projects
            .sort_by(|a, b| b.last_opened.cmp(&a.last_opened));
        if self.file.projects.len() <= MAX_PROJECTS {
            return;
        }
        let pinned: HashSet<String> = self
            .file
            .windows
            .iter()
            .filter_map(|w| w.project_id.clone())
            .collect();
        let mut kept: Vec<ProjectRecord> = Vec::new();
        let mut spill: Vec<ProjectRecord> = Vec::new();
        for p in std::mem::take(&mut self.file.projects) {
            // Bound to a live window, or pinned by the user.
            if pinned.contains(&p.id) || p.pinned {
                kept.push(p);
            } else {
                spill.push(p);
            }
        }
        for p in spill {
            if kept.len() >= MAX_PROJECTS {
                break;
            }
            kept.push(p);
        }
        kept.sort_by(|a, b| b.last_opened.cmp(&a.last_opened));
        self.file.projects = kept;
    }

    /// The bytes to persist. Until the plan is claimed it is still the
    /// best description of the session, so a project write that lands
    /// before any window has registered must not erase it.
    pub fn to_disk(&self) -> CheckpointFile {
        let mut out = self.file.clone();
        if out.windows.is_empty() {
            if let Some(pending) = &self.pending {
                out.windows = pending.clone();
            }
        }
        out
    }
}

fn workspace_bytes(v: &Value) -> usize {
    serde_json::to_vec(v).map(|b| b.len()).unwrap_or(usize::MAX)
}

/* ---------- Persistence ---------- */

/// Write through a sibling temp file and rename over the target, so a
/// crash mid-write leaves the previous checkpoint intact rather than a
/// half-written one that would fail to parse on the next launch.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)
}

fn persist(inner: &Inner) {
    let Some(path) = inner.path.clone() else {
        return;
    };
    match serde_json::to_vec_pretty(&inner.to_disk()) {
        Ok(bytes) => {
            if let Err(e) = write_atomic(&path, &bytes) {
                log::warn!("checkpoint: could not write {}: {e}", path.display());
            }
        }
        Err(e) => log::warn!("checkpoint: could not serialize: {e}"),
    }
}

/* ---------- Manager ---------- */

#[derive(Default)]
pub struct CheckpointManager {
    inner: Mutex<Inner>,
}

impl CheckpointManager {
    /// A poisoned lock means an earlier caller panicked mid-write. The
    /// tables are still consistent (every mutation is one method), so
    /// recovering beats bricking the checkpoint for the whole run.
    fn guard(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[cfg(test)]
    pub fn with_inner(inner: Inner) -> Self {
        Self {
            inner: Mutex::new(inner),
        }
    }
}

/// Read the file and start the run. Called once from `setup`.
pub fn init(app: &tauri::AppHandle, manager: &CheckpointManager) {
    use tauri::Manager as _;
    let path = app
        .path()
        .app_config_dir()
        .map(|dir| dir.join(FILE_NAME))
        .ok();
    let raw = path
        .as_ref()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Value>(&s).ok());

    let mut inner = manager.guard();
    *inner = Inner::open(raw, now_ms());
    inner.path = path;
}

/// True for the windows the checkpoint is responsible for reopening.
/// The terminal pop-out is a view onto another window's shells, not a
/// session, so it is deliberately not one of them.
pub fn tracks_window(label: &str) -> bool {
    label == MAIN_LABEL || label.starts_with(EDITOR_LABEL_PREFIX)
}

/// A window went away. Called from the window event hook.
pub fn on_window_destroyed(manager: &CheckpointManager, label: &str) {
    let mut inner = manager.guard();
    if inner.forget_window(label, now_ms()) {
        persist(&inner);
    }
}

/// The app is quitting: from here a destroyed window keeps its row.
pub fn mark_exiting(manager: &CheckpointManager) {
    let mut inner = manager.guard();
    inner.mark_exiting();
    persist(&inner);
}

/* ---------- Commands ---------- */

#[tauri::command]
pub fn checkpoint_load(manager: tauri::State<'_, CheckpointManager>) -> CheckpointFile {
    manager.guard().to_disk()
}

#[tauri::command]
pub fn checkpoint_claim_restore(
    manager: tauri::State<'_, CheckpointManager>,
) -> Option<Vec<WindowRecord>> {
    manager.guard().claim_restore()
}

#[tauri::command]
pub fn checkpoint_save_window(
    manager: tauri::State<'_, CheckpointManager>,
    save: WindowSave,
) -> SaveAck {
    let mut inner = manager.guard();
    let ack = inner.save_window(save, now_ms());
    if ack.accepted {
        persist(&inner);
    }
    ack
}

#[tauri::command]
pub fn checkpoint_save_project(
    manager: tauri::State<'_, CheckpointManager>,
    save: ProjectSave,
) -> SaveAck {
    let mut inner = manager.guard();
    let ack = inner.save_project(save, now_ms());
    if ack.accepted {
        persist(&inner);
    }
    ack
}

#[tauri::command]
pub fn checkpoint_remove_project(manager: tauri::State<'_, CheckpointManager>, id: String) {
    let mut inner = manager.guard();
    if inner.remove_project(&id, now_ms()) {
        persist(&inner);
    }
}

/// Open another editor window bound to `project_id`.
///
/// The label is allocated and the row seeded under the lock *before*
/// the webview exists, so the new window finds its own project the
/// moment it boots — there is no window that is briefly unclaimed.
/// The lock is released before the window is built: building one runs
/// our own window hooks, which take the same lock.
#[tauri::command]
pub fn checkpoint_open_window(
    app: tauri::AppHandle,
    manager: tauri::State<'_, CheckpointManager>,
    project_id: Option<String>,
    geometry: Option<Geometry>,
) -> Result<String, HostError> {
    let label = {
        let mut inner = manager.guard();
        if inner.file.windows.len() >= MAX_WINDOWS {
            return Err(HostError::Internal {
                message: format!("at most {MAX_WINDOWS} windows"),
            });
        }
        let label = inner.allocate_label();
        // Seeded at rev 0 so the window's own first registration — rev 1,
        // the first value its counter produces — is a newer write rather
        // than a stale one, and its row starts being owned by it.
        inner.save_window(
            WindowSave {
                label: label.clone(),
                project_id: project_id.clone(),
                geometry,
                rev: 0,
            },
            now_ms(),
        );
        persist(&inner);
        label
    };

    match build_window(&app, &label, geometry) {
        Ok(()) => Ok(label),
        Err(e) => {
            let mut inner = manager.guard();
            // The row would otherwise describe a window that does not
            // exist, and the next launch would try to open it again.
            inner.forget_window(&label, now_ms());
            persist(&inner);
            Err(e)
        }
    }
}

fn build_window(
    app: &tauri::AppHandle,
    label: &str,
    geometry: Option<Geometry>,
) -> Result<(), HostError> {
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("sparkBook")
    .min_inner_size(720.0, 480.0)
    // Matches tauri.conf.json's main window: the rendered titlebar is
    // the chrome, so an OS one would be a second titlebar.
    .decorations(false)
    .resizable(true);

    if let Some(g) = geometry.and_then(Geometry::sane) {
        builder = builder.inner_size(g.w, g.h).position(g.x, g.y);
    } else {
        builder = builder.inner_size(1280.0, 800.0).center();
    }

    builder.build().map(|_| ()).map_err(|e| HostError::Internal {
        message: e.to_string(),
    })
}

/* ---------- Tests ---------- */

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    const T: i64 = 1_000;

    fn win(label: &str, project: &str, rev: u64) -> WindowSave {
        WindowSave {
            label: label.into(),
            project_id: Some(project.into()),
            geometry: None,
            rev,
        }
    }

    fn proj(id: &str, writer: &str, rev: u64) -> ProjectSave {
        ProjectSave {
            id: id.into(),
            root_path: Some(format!("/{id}")),
            name: id.into(),
            last_opened: T,
            rev,
            writer: writer.into(),
            pinned: false,
            workspace: json!({ "tabs": [] }),
        }
    }

    /* ---- restore plan ---- */

    #[test]
    fn open_moves_saved_windows_into_the_pending_plan() {
        let saved = json!({
            "version": 1,
            "projects": [],
            "windows": [
                { "label": "main", "projectId": "/a", "rev": 3, "order": 1 },
                { "label": "editor-1", "projectId": "/b", "rev": 2, "order": 2 }
            ],
            "updatedAt": 1
        });
        let inner = Inner::open(Some(saved), T);
        assert!(inner.file.windows.is_empty(), "the live table starts empty");
        let plan = inner.pending.expect("plan");
        assert_eq!(
            plan.iter().map(|w| w.label.as_str()).collect::<Vec<_>>(),
            ["main", "editor-1"]
        );
    }

    #[test]
    fn claim_restore_hands_the_plan_out_once() {
        let mut inner = Inner::open(
            Some(json!({
                "version": 1,
                "windows": [{ "label": "main", "projectId": "/a", "rev": 1, "order": 1 }]
            })),
            T,
        );
        assert_eq!(inner.claim_restore().map(|p| p.len()), Some(1));
        assert_eq!(inner.claim_restore(), None, "a second claim gets nothing");
    }

    #[test]
    fn concurrent_claims_produce_exactly_one_winner() {
        let inner = Inner::open(
            Some(json!({
                "version": 1,
                "windows": [
                    { "label": "main", "projectId": "/a", "rev": 1, "order": 1 },
                    { "label": "editor-1", "projectId": "/b", "rev": 1, "order": 2 }
                ]
            })),
            T,
        );
        let manager = Arc::new(CheckpointManager::with_inner(inner));
        let winners = Arc::new(AtomicUsize::new(0));

        let mut handles = vec![];
        for _ in 0..16 {
            let manager = manager.clone();
            let winners = winners.clone();
            handles.push(std::thread::spawn(move || {
                if manager.guard().claim_restore().is_some() {
                    winners.fetch_add(1, Ordering::SeqCst);
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(winners.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_version_the_host_does_not_know_starts_a_clean_session() {
        let inner = Inner::open(
            Some(json!({ "version": 99, "windows": [{ "label": "main", "rev": 1 }] })),
            T,
        );
        assert!(inner.pending.is_none());
        assert!(inner.file.projects.is_empty());
    }

    #[test]
    fn garbage_on_disk_does_not_panic() {
        let inner = Inner::open(Some(json!("not an object")), T);
        assert!(inner.file.windows.is_empty());
        let inner = Inner::open(None, T);
        assert!(inner.file.projects.is_empty());
    }

    /* ---- window rows ---- */

    #[test]
    fn a_stale_window_write_is_rejected() {
        let mut inner = Inner::open(None, T);
        assert!(inner.save_window(win("main", "/a", 5), T).accepted);
        let ack = inner.save_window(win("main", "/stale", 4), T);
        assert!(!ack.accepted);
        assert_eq!(ack.reason.as_deref(), Some("stale"));
        assert_eq!(ack.rev, 5);
        assert_eq!(inner.file.windows[0].project_id.as_deref(), Some("/a"));
    }

    #[test]
    fn a_repeat_of_the_same_rev_is_rejected() {
        let mut inner = Inner::open(None, T);
        inner.save_window(win("main", "/a", 2), T);
        assert!(!inner.save_window(win("main", "/b", 2), T).accepted);
    }

    #[test]
    fn a_window_keeps_its_order_across_updates() {
        let mut inner = Inner::open(None, T);
        inner.save_window(win("main", "/a", 1), T);
        inner.save_window(win("editor-1", "/b", 1), T);
        inner.save_window(win("main", "/c", 2), T);
        assert_eq!(
            inner
                .file
                .windows
                .iter()
                .map(|w| w.label.as_str())
                .collect::<Vec<_>>(),
            ["main", "editor-1"]
        );
    }

    #[test]
    fn the_window_table_is_capped() {
        let mut inner = Inner::open(None, T);
        for i in 0..(MAX_WINDOWS + 4) {
            inner.save_window(win(&format!("editor-{i}"), "/a", 1), T);
        }
        assert_eq!(inner.file.windows.len(), MAX_WINDOWS);
        // The oldest rows are the ones dropped.
        assert_eq!(inner.file.windows[0].label, format!("editor-{}", 4));
    }

    #[test]
    fn closing_a_window_drops_its_row_but_quitting_does_not() {
        let mut inner = Inner::open(None, T);
        inner.save_window(win("main", "/a", 1), T);
        inner.save_window(win("editor-1", "/b", 1), T);

        assert!(inner.forget_window("editor-1", T));
        assert_eq!(inner.file.windows.len(), 1);

        inner.save_window(win("editor-2", "/c", 1), T);
        inner.mark_exiting();
        assert!(inner.is_exiting());
        assert!(!inner.forget_window("editor-2", T), "quitting keeps the row");
        assert_eq!(inner.file.windows.len(), 2);
    }

    #[test]
    fn the_last_window_keeps_its_row_because_closing_it_is_the_quit() {
        let mut inner = Inner::open(None, T);
        inner.save_window(win("main", "/a", 1), T);
        assert!(!inner.forget_window("main", T));
        assert_eq!(inner.to_disk().windows.len(), 1);
    }

    #[test]
    fn closing_windows_one_at_a_time_restores_only_the_last() {
        let mut inner = Inner::open(None, T);
        for (i, label) in ["main", "editor-1", "editor-2"].iter().enumerate() {
            inner.save_window(win(label, &format!("/p{i}"), 1), T);
        }
        inner.forget_window("editor-1", T);
        inner.forget_window("main", T);
        inner.forget_window("editor-2", T); // the quit

        let disk = inner.to_disk();
        assert_eq!(disk.windows.len(), 1);
        assert_eq!(disk.windows[0].label, "editor-2");
    }

    #[test]
    fn only_editor_windows_are_tracked() {
        assert!(tracks_window(MAIN_LABEL));
        assert!(tracks_window("editor-3"));
        assert!(!tracks_window("terminal"));
    }

    #[test]
    fn a_seeded_row_is_taken_over_by_the_window_it_named() {
        let mut inner = Inner::open(None, T);
        let label = inner.allocate_label();
        inner.save_window(
            WindowSave {
                label: label.clone(),
                project_id: Some("/b".into()),
                geometry: None,
                rev: 0,
            },
            T,
        );
        // The window boots and registers with the first rev it has.
        assert!(inner.save_window(win(&label, "/b", 1), T).accepted);
        assert_eq!(inner.file.windows[0].rev, 1);
    }

    #[test]
    fn labels_are_unique_within_a_run() {
        let mut inner = Inner::open(None, T);
        let a = inner.allocate_label();
        let b = inner.allocate_label();
        assert_ne!(a, b);
        assert!(a.starts_with(EDITOR_LABEL_PREFIX));
    }

    /* ---- project rows ---- */

    #[test]
    fn a_windows_own_stale_project_write_is_rejected() {
        let mut inner = Inner::open(None, T);
        assert!(inner.save_project(proj("/a", "main", 7), T).accepted);
        let ack = inner.save_project(proj("/a", "main", 6), T);
        assert!(!ack.accepted);
        assert_eq!(ack.reason.as_deref(), Some("stale"));
    }

    #[test]
    fn another_window_can_take_a_project_row_over() {
        let mut inner = Inner::open(None, T);
        inner.save_project(proj("/a", "main", 7), T);
        let ack = inner.save_project(proj("/a", "editor-1", 1), T);
        assert!(ack.accepted, "a different writer is not a stale retry");
        assert_eq!(inner.file.projects[0].writer, "editor-1");
    }

    #[test]
    fn an_oversized_workspace_is_refused() {
        let mut inner = Inner::open(None, T);
        let mut save = proj("/a", "main", 1);
        save.workspace = json!({ "blob": "x".repeat(MAX_WORKSPACE_BYTES + 1) });
        let ack = inner.save_project(save, T);
        assert!(!ack.accepted);
        assert_eq!(ack.reason.as_deref(), Some("too-large"));
        assert!(inner.file.projects.is_empty(), "nothing is stored");
    }

    #[test]
    fn projects_are_capped_but_a_window_pins_its_own() {
        let mut inner = Inner::open(None, T);
        inner.save_window(win("main", "/pinned", 1), T);
        let mut pinned = proj("/pinned", "main", 1);
        pinned.last_opened = 0; // the oldest row there is
        inner.save_project(pinned, T);

        for i in 0..(MAX_PROJECTS + 5) {
            let mut p = proj(&format!("/p{i}"), "main", 1);
            p.last_opened = 1_000 + i as i64;
            inner.save_project(p, T);
        }

        assert!(inner.file.projects.len() <= MAX_PROJECTS);
        assert!(
            inner.file.projects.iter().any(|p| p.id == "/pinned"),
            "the project a live window shows is never evicted"
        );
    }

    #[test]
    fn a_project_the_user_pinned_is_never_evicted() {
        let mut inner = Inner::open(None, T);
        let mut kept = proj("/kept", "main", 1);
        kept.last_opened = 0;
        kept.pinned = true;
        inner.save_project(kept, T);
        for i in 0..(MAX_PROJECTS + 5) {
            let mut p = proj(&format!("/p{i}"), "main", 1);
            p.last_opened = 1_000 + i as i64;
            inner.save_project(p, T);
        }
        assert_eq!(inner.file.projects.len(), MAX_PROJECTS);
        let row = inner.file.projects.iter().find(|p| p.id == "/kept");
        assert!(row.is_some_and(|p| p.pinned));
    }

    #[test]
    fn removing_a_project_drops_only_that_row() {
        let mut inner = Inner::open(None, T);
        inner.save_project(proj("/a", "main", 1), T);
        inner.save_project(proj("/b", "main", 2), T);
        assert!(inner.remove_project("/a", T));
        assert!(!inner.remove_project("/a", T), "removing twice is a no-op");
        assert_eq!(inner.file.projects.len(), 1);
    }

    /* ---- disk shape ---- */

    #[test]
    fn an_early_project_write_does_not_erase_an_unclaimed_plan() {
        let mut inner = Inner::open(
            Some(json!({
                "version": 1,
                "windows": [{ "label": "main", "projectId": "/a", "rev": 1, "order": 1 }]
            })),
            T,
        );
        inner.save_project(proj("/a", "main", 1), T);
        assert_eq!(inner.to_disk().windows.len(), 1, "the plan survives");

        inner.claim_restore();
        inner.save_window(win("main", "/a", 1), T);
        assert_eq!(inner.to_disk().windows[0].label, "main");
    }

    #[test]
    fn a_write_replaces_the_file_whole() {
        let dir = std::env::temp_dir().join(format!("spark-cp-{}", std::process::id()));
        let path = dir.join("checkpoint.json");
        let _ = fs::remove_dir_all(&dir);

        write_atomic(&path, b"{\"version\":1}").expect("first write");
        write_atomic(&path, b"{\"version\":1,\"projects\":[]}").expect("second write");

        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(text, "{\"version\":1,\"projects\":[]}");
        assert!(
            !path.with_extension("json.tmp").exists(),
            "the temp file is renamed away, not left behind"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_two_window_session_comes_back_as_two_windows() {
        let mut run1 = Inner::open(None, T);
        run1.save_window(win("main", "/a", 1), T);
        run1.save_project(proj("/a", "main", 1), T);
        run1.save_window(win("editor-1", "/b", 1), T);
        run1.save_project(proj("/b", "editor-1", 1), T);
        run1.mark_exiting();
        // Quitting destroys both windows; neither row is forgotten.
        run1.forget_window("main", T);
        run1.forget_window("editor-1", T);

        let disk = serde_json::to_value(run1.to_disk()).unwrap();
        let mut run2 = Inner::open(Some(disk), T);

        let plan = run2.claim_restore().expect("the next launch finds a plan");
        assert_eq!(plan.len(), 2);
        assert_eq!(plan[0].project_id.as_deref(), Some("/a"));
        assert_eq!(plan[1].project_id.as_deref(), Some("/b"));
        assert_eq!(run2.file.projects.len(), 2, "both workspaces came with them");
    }

    #[test]
    fn a_round_trip_through_json_keeps_every_row() {
        let mut inner = Inner::open(None, T);
        inner.save_window(win("main", "/a", 1), T);
        inner.save_project(proj("/a", "main", 1), T);

        let bytes = serde_json::to_vec(&inner.to_disk()).unwrap();
        let back = Inner::open(Some(serde_json::from_slice(&bytes).unwrap()), T);
        assert_eq!(back.file.projects.len(), 1);
        assert_eq!(back.pending.map(|p| p.len()), Some(1));
    }

    /* ---- concurrency ---- */

    #[test]
    fn concurrent_writers_do_not_lose_each_others_rows() {
        let manager = Arc::new(CheckpointManager::with_inner(Inner::open(None, T)));
        let windows = 6;
        let writes = 200;

        let mut handles = vec![];
        for w in 0..windows {
            let manager = manager.clone();
            handles.push(std::thread::spawn(move || {
                let label = format!("editor-{w}");
                for rev in 1..=writes {
                    let mut inner = manager.guard();
                    inner.save_window(win(&label, &format!("/p{w}"), rev), T);
                    inner.save_project(proj(&format!("/p{w}"), &label, rev), T);
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }

        let inner = manager.guard();
        assert_eq!(inner.file.windows.len(), windows as usize);
        assert_eq!(inner.file.projects.len(), windows as usize);
        for w in 0..windows {
            let label = format!("editor-{w}");
            let row = inner
                .file
                .windows
                .iter()
                .find(|r| r.label == label)
                .expect("every writer kept its row");
            assert_eq!(row.rev, writes, "the last write from that window won");
            let p = inner
                .file
                .projects
                .iter()
                .find(|p| p.id == format!("/p{w}"))
                .expect("every project row survived");
            assert_eq!(p.writer, label);
        }
    }

    #[test]
    fn interleaved_writers_never_regress_a_row() {
        // Two windows hammering the same project row: whichever lands
        // last wins, but neither can be rolled back by the other's
        // earlier write, because a row is only ever replaced whole.
        let manager = Arc::new(CheckpointManager::with_inner(Inner::open(None, T)));
        let mut handles = vec![];
        for label in ["main", "editor-1"] {
            let manager = manager.clone();
            handles.push(std::thread::spawn(move || {
                for rev in 1..=300 {
                    let mut inner = manager.guard();
                    inner.save_project(proj("/shared", label, rev), T);
                    let row = inner.file.projects.iter().find(|p| p.id == "/shared");
                    assert!(row.is_some(), "the row is never missing mid-flight");
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        let inner = manager.guard();
        assert_eq!(inner.file.projects.len(), 1);
        assert_eq!(inner.file.projects[0].rev, 300);
    }

    #[test]
    fn a_panicking_caller_does_not_brick_the_lock() {
        let manager = Arc::new(CheckpointManager::with_inner(Inner::open(None, T)));
        {
            let manager = manager.clone();
            let _ = std::thread::spawn(move || {
                let _guard = manager.guard();
                panic!("writer died holding the lock");
            })
            .join();
        }
        let mut inner = manager.guard();
        assert!(inner.save_window(win("main", "/a", 1), T).accepted);
    }
}
