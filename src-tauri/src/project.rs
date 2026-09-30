/* ============================================================
   sparkBook · src-tauri/src/project.rs

   Project-wide file listing (Quick Open) and text search (Find in
   Files). Both walk the project root natively: the renderer's
   explorer index costs one IPC round trip per directory, which is
   fine for filtering a tree and far too slow for a search box.

   Both commands are async and do their walking on the blocking
   pool. A plain `#[tauri::command] fn` runs on the main thread, and
   a walk over a large checkout would freeze the window for its
   whole duration.

   The walk is bounded three ways — entries visited, results kept and
   wall time — so a search rooted at `/` or `$HOME` still returns
   promptly with a `truncated` flag instead of running away.
   ============================================================ */
use crate::HostError;
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Folders never descended into. Mirrors `INDEX_SKIP` in
/// `src/store/explorer.ts`; hidden folders are skipped as well.
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".cache",
    "__pycache__",
    ".venv",
    "venv",
    ".idea",
    ".gradle",
];

const MAX_VISITED: usize = 200_000;
const WALK_BUDGET: Duration = Duration::from_secs(4);
/// Files larger than this are not searched: they are almost never
/// source, and reading them would dominate the search time.
const SEARCH_MAX_FILE: u64 = 1 << 20;
/// A match line longer than this is cut, so a minified bundle cannot
/// send megabytes back for one hit.
const PREVIEW_MAX: usize = 240;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileList {
    /// Paths relative to the root, `/`-separated.
    pub files: Vec<String>,
    pub truncated: bool,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// Absolute path.
    pub path: String,
    /// 1-based line and column (column counted in characters).
    pub line: usize,
    pub col: usize,
    /// The line, trimmed and cut to `PREVIEW_MAX` characters.
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    pub files_searched: usize,
    pub truncated: bool,
}

fn skip_dir(name: &str) -> bool {
    name.starts_with('.') || SKIP_DIRS.contains(&name)
}

/// Depth-first walk calling `visit` for every regular file. Returns
/// true when a bound stopped the walk early. `visit` returns false to
/// stop as well.
fn walk(root: &Path, mut visit: impl FnMut(&Path) -> bool) -> bool {
    let started = Instant::now();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    let mut visited = 0usize;
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        let mut subdirs = Vec::new();
        for entry in entries.flatten() {
            visited += 1;
            if visited > MAX_VISITED || started.elapsed() > WALK_BUDGET {
                return true;
            }
            // file_type() does not follow symlinks, so a link loop cannot
            // trap the walk; linked files are still listed.
            let Ok(ft) = entry.file_type() else { continue };
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if ft.is_dir() {
                if !skip_dir(&name) {
                    subdirs.push(entry.path());
                }
            } else if ft.is_file() || ft.is_symlink() {
                let path = entry.path();
                if ft.is_symlink() && !path.is_file() {
                    continue;
                }
                if !visit(&path) {
                    return true;
                }
            }
        }
        // Reverse so the stack pops them in name order.
        subdirs.sort();
        subdirs.reverse();
        stack.extend(subdirs);
    }
    false
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn check_root(root: &str) -> Result<PathBuf, HostError> {
    let path = PathBuf::from(root);
    if !path.is_dir() {
        return Err(HostError::NotFound { path: root.into() });
    }
    Ok(path)
}

pub fn list_files_blocking(root: &str, limit: usize) -> Result<FileList, HostError> {
    let root = check_root(root)?;
    let mut files = Vec::new();
    let mut truncated = walk(&root, |p| {
        files.push(relative(&root, p));
        files.len() < limit
    });
    if files.len() >= limit {
        truncated = true;
    }
    files.sort();
    Ok(FileList { files, truncated })
}

/// Lower-case `c` for a case-insensitive comparison. Only a character
/// whose lower-case form is a single character is folded, so column
/// offsets computed on the folded line stay valid on the original.
fn fold(c: char) -> char {
    let mut lower = c.to_lowercase();
    match (lower.next(), lower.next()) {
        (Some(l), None) => l,
        _ => c,
    }
}

/// The first match of `needle` in `line`, as a 0-based character column.
fn find_in_line(line: &str, needle: &[char], case_sensitive: bool) -> Option<usize> {
    let hay: Vec<char> = if case_sensitive {
        line.chars().collect()
    } else {
        line.chars().map(fold).collect()
    };
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (0..=hay.len() - needle.len()).find(|&i| hay[i..i + needle.len()] == *needle)
}

fn preview(line: &str) -> String {
    let trimmed = line.trim();
    if trimmed.chars().count() <= PREVIEW_MAX {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(PREVIEW_MAX).collect();
    out.push('…');
    out
}

/// Read `path` as text, or None when it is too big, unreadable or binary
/// (a NUL byte in the first 8 KiB, the heuristic git and grep use).
fn read_text(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > SEARCH_MAX_FILE {
        return None;
    }
    // At most SEARCH_MAX_FILE by the check above, so it always fits.
    let mut bytes = Vec::with_capacity(usize::try_from(meta.len()).unwrap_or(0));
    std::fs::File::open(path).ok()?.read_to_end(&mut bytes).ok()?;
    if bytes[..bytes.len().min(8192)].contains(&0) {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

pub fn search_blocking(
    root: &str,
    query: &str,
    case_sensitive: bool,
    limit: usize,
) -> Result<SearchResult, HostError> {
    let root = check_root(root)?;
    let needle: Vec<char> = if case_sensitive {
        query.chars().collect()
    } else {
        query.chars().map(fold).collect()
    };
    let mut hits = Vec::new();
    let mut files_searched = 0usize;
    if needle.is_empty() {
        return Ok(SearchResult { hits, files_searched, truncated: false });
    }
    let mut truncated = walk(&root, |p| {
        let Some(text) = read_text(p) else { return true };
        files_searched += 1;
        for (i, line) in text.lines().enumerate() {
            if let Some(col) = find_in_line(line, &needle, case_sensitive) {
                hits.push(SearchHit {
                    path: p.to_string_lossy().into_owned(),
                    line: i + 1,
                    col: col + 1,
                    text: preview(line),
                });
                if hits.len() >= limit {
                    return false;
                }
            }
        }
        true
    });
    if hits.len() >= limit {
        truncated = true;
    }
    Ok(SearchResult { hits, files_searched, truncated })
}

fn join_err(e: impl std::fmt::Display) -> HostError {
    HostError::Internal { message: e.to_string() }
}

/// Every file under `root`, relative to it, for Quick Open.
#[tauri::command]
pub async fn list_project_files(root: String, limit: Option<usize>) -> Result<FileList, HostError> {
    let limit = limit.unwrap_or(20_000).clamp(1, 100_000);
    tauri::async_runtime::spawn_blocking(move || list_files_blocking(&root, limit))
        .await
        .map_err(join_err)?
}

/// Lines under `root` containing `query` (a literal, not a pattern).
#[tauri::command]
pub async fn search_project(
    root: String,
    query: String,
    case_sensitive: Option<bool>,
    limit: Option<usize>,
) -> Result<SearchResult, HostError> {
    let limit = limit.unwrap_or(500).clamp(1, 5_000);
    let case_sensitive = case_sensitive.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        search_blocking(&root, &query, case_sensitive, limit)
    })
    .await
    .map_err(join_err)?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> PathBuf {
        // Tests run in parallel: each needs its own directory.
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("spark-project-test-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src/deep")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join("README.md"), "Hello World\nsecond line\n").unwrap();
        std::fs::write(dir.join("src/a.ts"), "const hello = 1;\n").unwrap();
        std::fs::write(dir.join("src/deep/b.rs"), "fn main() {}\n// HELLO again\n").unwrap();
        std::fs::write(dir.join("node_modules/pkg/index.js"), "hello").unwrap();
        std::fs::write(dir.join(".git/config"), "hello").unwrap();
        std::fs::write(dir.join("bin.dat"), b"hello\0world").unwrap();
        dir
    }

    #[test]
    fn lists_files_skipping_heavy_and_hidden_dirs() {
        let dir = fixture();
        let list = list_files_blocking(dir.to_str().unwrap(), 100).unwrap();
        assert_eq!(list.files, vec!["README.md", "bin.dat", "src/a.ts", "src/deep/b.rs"]);
        assert!(!list.truncated);
        let capped = list_files_blocking(dir.to_str().unwrap(), 2).unwrap();
        assert_eq!(capped.files.len(), 2);
        assert!(capped.truncated);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn searches_case_insensitively_and_skips_binaries() {
        let dir = fixture();
        let res = search_blocking(dir.to_str().unwrap(), "hello", false, 100).unwrap();
        let mut found: Vec<(String, usize, usize)> = res
            .hits
            .iter()
            .map(|h| (relative(&dir, Path::new(&h.path)), h.line, h.col))
            .collect();
        found.sort();
        assert_eq!(
            found,
            vec![
                ("README.md".into(), 1, 1),
                ("src/a.ts".into(), 1, 7),
                ("src/deep/b.rs".into(), 2, 4),
            ]
        );
        let exact = search_blocking(dir.to_str().unwrap(), "HELLO", true, 100).unwrap();
        assert_eq!(exact.hits.len(), 1);
        assert_eq!(exact.hits[0].text, "// HELLO again");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_root_is_not_found() {
        assert!(matches!(
            list_files_blocking("/definitely/not/here", 10),
            Err(HostError::NotFound { .. })
        ));
    }

    #[test]
    fn long_lines_are_cut() {
        let line = "x".repeat(1000);
        assert_eq!(preview(&line).chars().count(), PREVIEW_MAX + 1);
    }
}
