/* ============================================================
   sparkBook · src-tauri/src/pty.rs

   Real terminal sessions. A `portable-pty` child process runs an
   actual login shell; its output is fed through a `vt100` parser
   that keeps the authoritative screen state here in Rust. The
   renderer receives already-resolved cell grids over the
   `pty://frame` event and never has to emulate anything itself.

   This replaces the previous xterm.js + fake-command-table panel.

   Privilege: `PtyPrivilege::Root` re-spawns the shell through
   pkexec (falling back to `sudo -i`) so the OS — not sparkBook —
   collects the password. No credential ever transits this process.
   ============================================================ */

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::pty_sink::{contains_ris, TermSink, PALETTE};
use crate::HostError;

/* ---------- Wire types ---------- */

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PtyPrivilege {
    /// A shell running as the current user. The safe default.
    #[default]
    User,
    Root,
}

/// One horizontal run of cells sharing identical styling. Runs keep
/// frames small: a typical 80x24 screen is a few hundred spans rather
/// than 1920 individual cells.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Span {
    /// Column the run starts at (0-based).
    pub col: u16,
    pub text: String,
    /// `#rrggbb`, or `null` for the theme's default foreground.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bg: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub bold: bool,
    /// SGR 2 (faint). Painted as a fainter colour, not as bold — the
    /// hints and secondary text of most TUIs are dim, and drawing them
    /// bold inverted their emphasis.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub dim: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub italic: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub underline: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub inverse: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Row {
    pub y: u16,
    pub spans: Vec<Span>,
}

/// Mouse reporting the program running in the terminal has turned on.
/// Mirrors `vt100::MouseProtocolMode`; the renderer only needs to know
/// whether *any* reporting is active, but carrying the mode keeps the
/// wire honest if click reporting is added later.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MouseMode {
    None,
    Press,
    PressRelease,
    ButtonMotion,
    AnyMotion,
}

impl From<vt100::MouseProtocolMode> for MouseMode {
    fn from(m: vt100::MouseProtocolMode) -> Self {
        match m {
            vt100::MouseProtocolMode::None => Self::None,
            vt100::MouseProtocolMode::Press => Self::Press,
            vt100::MouseProtocolMode::PressRelease => Self::PressRelease,
            vt100::MouseProtocolMode::ButtonMotion => Self::ButtonMotion,
            vt100::MouseProtocolMode::AnyMotion => Self::AnyMotion,
        }
    }
}

/// How mouse reports must be framed. Mirrors `vt100::MouseProtocolEncoding`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MouseEncoding {
    Default,
    Utf8,
    Sgr,
}

impl From<vt100::MouseProtocolEncoding> for MouseEncoding {
    fn from(e: vt100::MouseProtocolEncoding) -> Self {
        match e {
            vt100::MouseProtocolEncoding::Default => Self::Default,
            vt100::MouseProtocolEncoding::Utf8 => Self::Utf8,
            vt100::MouseProtocolEncoding::Sgr => Self::Sgr,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub id: String,
    pub rows: u16,
    pub cols: u16,
    /// Only rows that changed since the last frame, unless `full`.
    pub lines: Vec<Row>,
    pub full: bool,
    pub cursor_row: u16,
    pub cursor_col: u16,
    pub cursor_visible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// DECCKM. Arrow keys must be sent as SS3 (`ESC O A`) rather than
    /// CSI (`ESC [ A`) while set — readline and vim both rely on this.
    pub application_cursor: bool,
    /// Bracketed paste (DEC 2004): wrap pasted text in ESC[200~ / ESC[201~.
    pub bracketed_paste: bool,
    /// How many rows the view is currently scrolled back.
    pub scrollback: usize,
    /// Rows available above the viewport — the largest `scrollback` the
    /// buffer can currently take. The renderer needs it to size a
    /// scrollbar and to clamp a drag without a round trip per pixel.
    pub scrollback_max: usize,
    /// True while a full-screen program (an editor, a pager, a TUI) owns
    /// the screen. The alternate grid has no scrollback by construction,
    /// so a wheel must be handed to the program instead of moving a
    /// viewport that cannot move.
    pub alternate_screen: bool,
    /// Mouse reporting the program asked for, and how to frame it.
    pub mouse_mode: MouseMode,
    pub mouse_encoding: MouseEncoding,
    /// DEC 1004: send `CSI I` / `CSI O` when the surface gains or loses focus.
    pub focus_reporting: bool,
    /// Kitty keyboard flags in force (see `pty_sink::KITTY_SUPPORTED`).
    /// Non-zero changes how the renderer encodes keys.
    pub kitty_flags: u8,
    /// Frame counter — lets the renderer drop out-of-order deliveries.
    pub seq: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyExit {
    pub id: String,
    pub code: i32,
    /// Set when the session ended because spawning failed outright.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySession {
    pub id: String,
    pub shell: String,
    pub cwd: String,
    pub privilege: PtyPrivilege,
    pub rows: u16,
    pub cols: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootSupport {
    /// A privilege helper exists, so the Root toggle can work.
    pub available: bool,
    /// "pkexec" | "sudo" | "none"
    pub method: String,
    /// True when the process is *already* running as uid 0.
    pub already_root: bool,
}

type SessionParser = vt100::Parser<TermSink>;

/* ---------- Session state ---------- */

struct Session {
    id: String,
    shell: String,
    cwd: String,
    privilege: PtyPrivilege,
    /// Label of the window whose view holds this shell. A window that
    /// goes away takes its shells with it — see `shutdown_window` — and
    /// `pty_adopt` moves one when the terminal is popped out.
    owner: Mutex<String>,
    parser: Arc<Mutex<SessionParser>>,
    /// When the last bell was forwarded; bells are rate limited so a
    /// program that rings in a loop cannot flood the event channel.
    last_bell: Mutex<Option<std::time::Instant>>,
    /// Input queue for the writer thread; `None` once the session is over.
    /// See `spawn_writer` for why writes do not happen on the caller.
    writer: Mutex<Option<std::sync::mpsc::Sender<Vec<u8>>>>,
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    /// Set once the reader thread has seen EOF or `kill` was called;
    /// the reader loop and the frame pump both use it to stop.
    closed: Arc<AtomicBool>,
    /// "The parser moved, someone should paint." The reader sets it and
    /// notifies; the frame pump blocks on it. See `spawn_reader`.
    dirty: Arc<Signal>,
    /// Last grid we serialised, used to emit only changed rows.
    last_rows: Mutex<Vec<String>>,
    seq: AtomicU64,
    size: Mutex<(u16, u16)>,
    /// Held across build *and* emit of a frame — see `emit_frame`.
    emit_lock: Mutex<()>,
}

/// A flag with a condition variable, so the frame pump can sleep until
/// there is something to do instead of polling.
#[derive(Default)]
struct Signal {
    flag: Mutex<bool>,
    cv: Condvar,
}

impl Signal {
    fn raise(&self) {
        if let Ok(mut f) = self.flag.lock() {
            *f = true;
        }
        // Notified even if the lock was poisoned: a pump waiting on a
        // timeout still wakes, and a missed wake is a stalled terminal.
        self.cv.notify_all();
    }

    /// Clear the flag and report whether it had been raised.
    fn take(&self) -> bool {
        match self.flag.lock() {
            Ok(mut f) => std::mem::replace(&mut *f, false),
            Err(_) => true,
        }
    }
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    next_id: AtomicU64,
}

impl PtyManager {
    fn get(&self, id: &str) -> Result<Arc<Session>, HostError> {
        self.sessions
            .lock()
            .map_err(poisoned)?
            .get(id)
            .cloned()
            .ok_or_else(|| HostError::NotFound {
                path: format!("pty session {id}"),
            })
    }
}

fn poisoned<T>(_: T) -> HostError {
    HostError::Internal {
        message: "pty manager lock poisoned".into(),
    }
}

/* ---------- Colour resolution ----------

   vt100 hands back either a palette index or true colour. The
   renderer wants concrete hex so a frame paints without needing a
   palette of its own; indices 0..15 use the standard xterm ANSI
   palette, 16..255 the 6x6x6 cube + greyscale ramp.
*/

pub(crate) fn ansi_rgb(idx: u8) -> (u8, u8, u8) {
    const BASE: [(u8, u8, u8); 16] = [
        (0x00, 0x00, 0x00),
        (0xcd, 0x31, 0x31),
        (0x0d, 0xbc, 0x79),
        (0xe5, 0xe5, 0x10),
        (0x24, 0x72, 0xc8),
        (0xbc, 0x3f, 0xbc),
        (0x11, 0xa8, 0xcd),
        (0xe5, 0xe5, 0xe5),
        (0x66, 0x66, 0x66),
        (0xf1, 0x4c, 0x4c),
        (0x23, 0xd1, 0x8b),
        (0xf5, 0xf5, 0x43),
        (0x3b, 0x8e, 0xea),
        (0xd6, 0x70, 0xd6),
        (0x29, 0xb8, 0xdb),
        (0xff, 0xff, 0xff),
    ];
    if idx < 16 {
        BASE[idx as usize]
    } else if idx < 232 {
        let i = idx - 16;
        let level = |v: u8| -> u8 {
            if v == 0 {
                0
            } else {
                55 + v * 40
            }
        };
        (level(i / 36), level((i % 36) / 6), level(i % 6))
    } else {
        let v = 8 + (idx - 232) * 10;
        (v, v, v)
    }
}

fn ansi_hex(idx: u8) -> String {
    let (r, g, b) = ansi_rgb(idx);
    format!("#{r:02x}{g:02x}{b:02x}")
}

fn color_hex(c: vt100::Color) -> Option<String> {
    match c {
        vt100::Color::Default => None,
        vt100::Color::Idx(i) => Some(ansi_hex(i)),
        vt100::Color::Rgb(r, g, b) => Some(format!("#{r:02x}{g:02x}{b:02x}")),
    }
}

/* ---------- Grid serialisation ---------- */

/// Build the run-length span list for one screen row, plus a cheap
/// fingerprint used to skip unchanged rows on the next frame.
fn row_spans(screen: &vt100::Screen, y: u16, cols: u16) -> (Vec<Span>, String) {
    let mut spans: Vec<Span> = Vec::new();
    let mut key = String::with_capacity(cols as usize * 2);

    let mut run: Option<Span> = None;
    // Class and width of `run`, for the merge rule below.
    let mut run_class = GlyphClass::Text;
    let mut run_cells = 0usize;
    for x in 0..cols {
        let cell = screen.cell(y, x);
        // A wide glyph occupies two columns; the second is a continuation
        // cell whose contents repeat the same character. Emitting it would
        // render the glyph twice and push the rest of the row right.
        if cell.is_some_and(vt100::Cell::is_wide_continuation) {
            key.push('\u{2}');
            continue;
        }
        let wide = cell.is_some_and(vt100::Cell::is_wide);
        let (contents, fg, bg, bold, dim, italic, underline, inverse) = match cell {
            Some(c) => {
                let text = c.contents();
                (
                    if text.is_empty() {
                        " ".to_string()
                    } else {
                        text.to_string()
                    },
                    color_hex(c.fgcolor()),
                    color_hex(c.bgcolor()),
                    c.bold(),
                    c.dim(),
                    c.italic(),
                    c.underline(),
                    c.inverse(),
                )
            }
            None => (" ".to_string(), None, None, false, false, false, false, false),
        };

        key.push_str(&contents);
        key.push('\u{1}');
        key.push_str(fg.as_deref().unwrap_or("-"));
        key.push_str(bg.as_deref().unwrap_or("-"));
        // One character per attribute combination: a row that went from
        // bold to italic with the same text must still count as changed.
        key.push(char::from(
            b'0' + ((bold as u8)
                | ((dim as u8) << 1)
                | ((italic as u8) << 2)
                | ((underline as u8) << 3)
                | ((inverse as u8) << 4)),
        ));

        /* Spans are placed by column, but the text inside one is laid out
           by the font. A glyph the bundled face does not carry comes from
           a fallback font with its own advance, and every character after
           it in the same run drifts off its column — which is how a status
           line full of emoji or symbols ends up misaligned. Such a glyph
           gets a span of its own, so the next one starts on its column
           again. Box drawing and Braille also come from a fallback, but
           TUIs draw long runs of them and one span per cell would be
           thousands of spans a screen; short runs keep their drift under
           a pixel. */
        let class = if wide {
            GlyphClass::Own
        } else {
            glyph_class(&contents)
        };
        let isolate = class == GlyphClass::Own;

        let same = !isolate
            && class == run_class
            && (class != GlyphClass::Grid || run_cells < GRID_RUN_MAX)
            && run.as_ref().is_some_and(|r| {
                r.fg == fg
                    && r.bg == bg
                    && r.bold == bold
                    && r.dim == dim
                    && r.italic == italic
                    && r.underline == underline
                    && r.inverse == inverse
            });

        if same {
            // `run` is Some whenever `same` is true.
            if let Some(r) = run.as_mut() {
                r.text.push_str(&contents);
            }
            run_cells += 1;
        } else {
            if let Some(r) = run.take() {
                spans.push(r);
            }
            let span = Span {
                col: x,
                text: contents,
                fg,
                bg,
                bold,
                dim,
                italic,
                underline,
                inverse,
            };
            if isolate {
                spans.push(span);
            } else {
                run = Some(span);
                run_class = class;
                run_cells = 1;
            }
        }
    }
    if let Some(r) = run.take() {
        spans.push(r);
    }

    // Trim trailing blanks off the last run when it carries no styling —
    // they repaint as background anyway and are most of a typical row.
    // A styled run (e.g. a selection bar) keeps its blanks: there the
    // background colour is the content.
    if let Some(last) = spans.last_mut() {
        if last.fg.is_none()
            && last.bg.is_none()
            && !last.bold
            && !last.dim
            && !last.italic
            && !last.underline
            && !last.inverse
        {
            let trimmed = last.text.trim_end_matches(' ');
            if trimmed.is_empty() {
                spans.pop();
            } else if trimmed.len() != last.text.len() {
                last.text.truncate(trimmed.len());
            }
        }
    }

    (spans, key)
}

/// How a cell's text may share a span with its neighbours (see `row_spans`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GlyphClass {
    /// Latin, which the bundled JetBrains Mono subset carries at the cell's
    /// exact advance: runs of any length.
    Text,
    /// Box drawing, block elements and Braille: from a fallback monospace
    /// face, near but not exactly the cell advance. Short runs.
    Grid,
    /// Anything else — symbols, emoji, CJK: one span per glyph.
    Own,
}

/// Longest run of `Grid` glyphs in one span. A fallback monospace advance
/// is within ~0.5% of the cell, so 16 of them drift well under a pixel.
const GRID_RUN_MAX: usize = 16;

fn glyph_class(text: &str) -> GlyphClass {
    let mut class = GlyphClass::Text;
    for c in text.chars() {
        let u = c as u32;
        if u < 0x0250 {
            continue;
        }
        if (0x2500..=0x259f).contains(&u) || (0x2800..=0x28ff).contains(&u) {
            class = GlyphClass::Grid;
        } else {
            return GlyphClass::Own;
        }
    }
    class
}

fn build_frame(session: &Session, force_full: bool) -> Result<Frame, HostError> {
    let mut parser = session.parser.lock().map_err(poisoned)?;
    // vt100 exposes the scrollback *offset* but not the buffer's length.
    // `set_scrollback` clamps to that length and has no other effect, so
    // asking for more than could ever exist and reading the value back is
    // the length; restoring the previous offset leaves the screen as it was.
    let scrollback_max = {
        let screen = parser.screen_mut();
        let current = screen.scrollback();
        screen.set_scrollback(usize::MAX);
        let max = screen.scrollback();
        screen.set_scrollback(current);
        max
    };
    let screen = parser.screen();
    let (rows, cols) = screen.size();

    let mut last = session.last_rows.lock().map_err(poisoned)?;
    let resized = last.len() != rows as usize;
    let full = force_full || resized;
    if resized {
        last.clear();
        last.resize(rows as usize, String::new());
    }

    let mut lines = Vec::new();
    for y in 0..rows {
        let (spans, key) = row_spans(screen, y, cols);
        if full || last[y as usize] != key {
            last[y as usize] = key;
            lines.push(Row { y, spans });
        }
    }

    let (cursor_row, cursor_col) = screen.cursor_position();
    Ok(Frame {
        id: session.id.clone(),
        rows,
        cols,
        lines,
        full,
        cursor_row,
        cursor_col,
        cursor_visible: !screen.hide_cursor(),
        title: parser.callbacks().title.clone(),
        application_cursor: screen.application_cursor(),
        bracketed_paste: screen.bracketed_paste(),
        scrollback: screen.scrollback(),
        scrollback_max,
        alternate_screen: screen.alternate_screen(),
        mouse_mode: screen.mouse_protocol_mode().into(),
        mouse_encoding: screen.mouse_protocol_encoding().into(),
        focus_reporting: parser.callbacks().focus_reporting,
        kitty_flags: parser.callbacks().kitty_flags(screen.alternate_screen()),
        seq: session.seq.fetch_add(1, Ordering::SeqCst),
    })
}

fn emit_frame(app: &AppHandle, session: &Session, force_full: bool) {
    /* Frames are built from three threads: the pump, the reader's final
       flush, and the resize/scroll/refresh commands. `build_frame` takes
       its sequence number under the parser lock, but the emit happened
       after that lock was released — so two frames could leave in the
       opposite order to their numbers. The renderer drops the lower one,
       and when that was the full repaint a resize or scroll had just
       produced, the delta it kept was applied against a grid of the wrong
       shape: a mostly blank screen until the next full frame. Ordering
       the emit with the build closes that. */
    let _ordered = session
        .emit_lock
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    match build_frame(session, force_full) {
        Ok(frame) => {
            // A frame with no changed rows still matters when the cursor
            // moved, so only skip when nothing at all is pending.
            if frame.lines.is_empty() && !frame.full {
                let _ = app.emit("pty://cursor", &frame);
            } else {
                let _ = app.emit("pty://frame", &frame);
            }
        }
        Err(e) => {
            log_err("build_frame", &e);
        }
    }
}

fn log_err(what: &str, e: &HostError) {
    eprintln!("[pty] {what} failed: {e}");
}

/* ---------- Privilege helpers ---------- */

fn which(bin: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths).any(|dir| {
                let p = dir.join(bin);
                p.is_file()
            })
        })
        .unwrap_or(false)
}

#[cfg(unix)]
fn is_root() -> bool {
    // SAFETY: getuid is always safe; it takes no arguments and cannot fail.
    unsafe { libc_getuid() == 0 }
}

#[cfg(unix)]
extern "C" {
    #[link_name = "getuid"]
    fn libc_getuid() -> u32;
}

#[cfg(not(unix))]
fn is_root() -> bool {
    false
}

fn root_method() -> &'static str {
    if is_root() {
        return "none";
    }
    if cfg!(target_os = "windows") {
        return "none";
    }
    if which("pkexec") {
        "pkexec"
    } else if which("sudo") {
        "sudo"
    } else {
        "none"
    }
}

fn default_shell() -> String {
    if cfg!(target_os = "windows") {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    }
}

/// Build the command for a session. For `Root` this wraps the shell in
/// pkexec/sudo so the OS runs its own authentication; sparkBook never
/// sees or forwards a password.
fn build_command(
    shell: &str,
    cwd: &str,
    privilege: PtyPrivilege,
) -> Result<CommandBuilder, HostError> {
    let mut cmd = match privilege {
        PtyPrivilege::User => {
            let mut c = CommandBuilder::new(shell);
            if !cfg!(target_os = "windows") {
                c.arg("-i");
            }
            c
        }
        PtyPrivilege::Root => {
            if is_root() {
                let mut c = CommandBuilder::new(shell);
                if !cfg!(target_os = "windows") {
                    c.arg("-i");
                }
                c
            } else {
                match root_method() {
                    "pkexec" => {
                        let mut c = CommandBuilder::new("pkexec");
                        // Keep the caller's environment out of the elevated
                        // shell; polkit refuses most of it anyway.
                        c.arg("--user");
                        c.arg("root");
                        c.arg(shell);
                        c.arg("-i");
                        c
                    }
                    "sudo" => {
                        // `-i` gives a root login shell; sudo prompts on the
                        // PTY we just allocated, so the user types into the
                        // terminal itself.
                        let mut c = CommandBuilder::new("sudo");
                        c.arg("-i");
                        c
                    }
                    _ => {
                        return Err(HostError::PermissionDenied {
                            path: "root: neither pkexec nor sudo is available".into(),
                        })
                    }
                }
            }
        }
    };

    cmd.cwd(cwd);
    // TERM drives what programs think they can render. xterm-256color is
    // what vt100 models most faithfully.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // Identify as ourselves, and drop the identity of whatever terminal
    // launched the app: a sparkBook started from kitty or GNOME Terminal
    // inherited KITTY_WINDOW_ID / VTE_VERSION, and programs then used
    // protocols (kitty graphics, VTE's OSC 7 hook) this terminal lacks.
    cmd.env("TERM_PROGRAM", "sparkBook");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    for inherited in [
        "VTE_VERSION",
        "KITTY_WINDOW_ID",
        "KITTY_PID",
        "KITTY_INSTALLATION_DIR",
        "WEZTERM_EXECUTABLE",
        "WEZTERM_PANE",
        "WEZTERM_UNIX_SOCKET",
        "ITERM_SESSION_ID",
        "TERM_SESSION_ID",
        "WT_SESSION",
        "WT_PROFILE_ID",
        "ALACRITTY_WINDOW_ID",
        "ALACRITTY_SOCKET",
        "GHOSTTY_RESOURCES_DIR",
        "GHOSTTY_BIN_DIR",
        "KONSOLE_VERSION",
        "KONSOLE_DBUS_SESSION",
        "TMUX",
        "TMUX_PANE",
        // Markers of the Claude Code session sparkBook may have been
        // started from (`npm run tauri dev` run by an agent). Inherited,
        // they make a `claude` started in this terminal think it is a
        // child session and switch its transcripts off. User settings
        // such as CLAUDE_CODE_USE_BEDROCK are left alone.
        "CLAUDECODE",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_CHILD_SESSION",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_CODE_SESSION_ATTENDED",
        "CLAUDE_CODE_MESSAGING_SOCKET",
        "CLAUDE_CODE_MESSAGING_TOKEN",
        "CLAUDE_CODE_EXECPATH",
        "CLAUDE_PID",
        "CLAUDE_EFFORT",
        "AI_AGENT",
    ] {
        cmd.env_remove(inherited);
    }
    Ok(cmd)
}

/* ---------- Commands ---------- */

#[tauri::command]
pub fn pty_root_support() -> RootSupport {
    let already = is_root();
    let method = root_method();
    RootSupport {
        available: already || method != "none",
        method: method.to_string(),
        already_root: already,
    }
}

#[tauri::command]
pub fn pty_default_shell() -> String {
    default_shell()
}

fn parse_hex(s: &str) -> Option<(u8, u8, u8)> {
    let h = s.trim().strip_prefix('#')?;
    if h.len() != 6 || !h.is_ascii() {
        return None;
    }
    let ch = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok();
    Some((ch(0)?, ch(2)?, ch(4)?))
}

/// The theme's terminal colours, for programs that ask (OSC 10/11/12 —
/// neovim and many TUIs pick a light or dark scheme from the answer).
/// Unparseable values leave the previous colour in place.
#[tauri::command]
pub fn pty_set_palette(fg: String, bg: String, cursor: Option<String>) {
    let mut p = PALETTE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(c) = parse_hex(&fg) {
        p.fg = c;
        p.cursor = c;
    }
    if let Some(c) = parse_hex(&bg) {
        p.bg = c;
    }
    if let Some(c) = cursor.as_deref().and_then(parse_hex) {
        p.cursor = c;
    }
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    window: tauri::Window,
    manager: tauri::State<'_, PtyManager>,
    cwd: String,
    rows: Option<u16>,
    cols: Option<u16>,
    shell: Option<String>,
    privilege: Option<PtyPrivilege>,
) -> Result<PtySession, HostError> {
    let rows = rows.unwrap_or(24).max(1);
    let cols = cols.unwrap_or(80).max(1);
    let privilege = privilege.unwrap_or_default();
    let shell = shell.unwrap_or_else(default_shell);

    // A cwd that no longer exists makes the spawn fail with an opaque
    // errno; fall back to home so the terminal always opens. `~` is what
    // the renderer asks for when no folder is open.
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| "/".into());
    let cwd = if cwd == "~" {
        home.clone()
    } else if let Some(rest) = cwd.strip_prefix("~/") {
        format!("{}/{rest}", home.trim_end_matches('/'))
    } else {
        cwd
    };
    let cwd = if std::path::Path::new(&cwd).is_dir() {
        cwd
    } else {
        home
    };

    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| HostError::Internal {
            message: format!("openpty: {e}"),
        })?;

    let cmd = build_command(&shell, &cwd, privilege)?;
    let child = pair.slave.spawn_command(cmd).map_err(|e| {
        // Distinguish "no such shell" from a genuine internal failure so
        // the UI can say something actionable.
        let msg = e.to_string();
        if msg.contains("No such file") {
            HostError::NotFound {
                path: shell.clone(),
            }
        } else {
            HostError::Internal {
                message: format!("spawn {shell}: {msg}"),
            }
        }
    })?;
    // The slave handle must be dropped or the master never sees EOF when
    // the child exits, and the reader thread would hang forever.
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| HostError::Internal {
            message: format!("pty reader: {e}"),
        })?;
    let writer = pair.master.take_writer().map_err(|e| HostError::Internal {
        message: format!("pty writer: {e}"),
    })?;

    let id = format!(
        "pty-{}",
        manager.next_id.fetch_add(1, Ordering::SeqCst) + 1
    );

    let session = Arc::new(Session {
        id: id.clone(),
        shell: shell.clone(),
        cwd: cwd.clone(),
        privilege,
        owner: Mutex::new(window.label().to_string()),
        parser: Arc::new(Mutex::new(vt100::Parser::new_with_callbacks(
            rows,
            cols,
            5000,
            TermSink::default(),
        ))),
        last_bell: Mutex::new(None),
        writer: Mutex::new(Some(spawn_writer(writer))),
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
        closed: Arc::new(AtomicBool::new(false)),
        dirty: Arc::new(Signal::default()),
        last_rows: Mutex::new(vec![String::new(); rows as usize]),
        seq: AtomicU64::new(0),
        size: Mutex::new((rows, cols)),
        emit_lock: Mutex::new(()),
    });

    manager
        .sessions
        .lock()
        .map_err(poisoned)?
        .insert(id.clone(), session.clone());

    spawn_reader(app, session.clone(), reader);

    Ok(PtySession {
        id,
        shell,
        cwd,
        privilege,
        rows,
        cols,
    })
}

/// Feed the pty from its own thread, in arrival order.
///
/// Commands run on the UI thread, and a write to a pty blocks once the
/// line discipline's input queue is full — about 4 KB while the
/// foreground program is not reading. Pasting a screenful into a shell
/// that was busy running something froze the whole window until that
/// program got round to its stdin. A queue keeps the order keystrokes
/// arrived in, which a thread-per-write would not.
///
/// The thread ends when the sender is dropped (the session was killed or
/// its child exited) or the pty refuses a write, and dropping the writer
/// with it releases that side of the master.
fn spawn_writer(mut writer: Box<dyn Write + Send>) -> std::sync::mpsc::Sender<Vec<u8>> {
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        for chunk in rx {
            if writer.write_all(&chunk).and_then(|_| writer.flush()).is_err() {
                break;
            }
        }
    });
    tx
}

/// Stop accepting input for a session that is over, so the writer
/// thread retires instead of waiting on a queue nobody feeds.
fn close_writer(session: &Session) {
    if let Ok(mut slot) = session.writer.lock() {
        slot.take();
    }
}

/// How long a burst of output is allowed to accumulate before it is
/// painted. Long enough to coalesce a `cat` of a large file into a few
/// frames, short enough that a keystroke echoes immediately.
const FRAME_INTERVAL: std::time::Duration = std::time::Duration::from_millis(8);

/// Backstop for the pump's condvar wait. Nothing depends on it — the
/// reader notifies — but a wait that can never time out would hang the
/// thread forever if a notify were ever missed.
const PUMP_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(250);

/// How often a held-back frame re-checks whether its synchronized update ended.
const SYNC_POLL: std::time::Duration = std::time::Duration::from_millis(4);

/// Bells closer together than this are forwarded once.
const BELL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(500);

/// What a chunk of output asked of the terminal besides painting.
struct Effects {
    replies: Vec<u8>,
    clipboard: Vec<String>,
    bell: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyClipboard {
    id: String,
    /// Base64, exactly as the program sent it.
    data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyBell {
    id: String,
}

/// Answer the program's queries and forward clipboard writes and bells.
///
/// Replies go through the writer queue like keystrokes do, so they reach
/// the program in order with whatever the user is typing and never block
/// the reader.
fn deliver_effects(app: &AppHandle, session: &Session, fx: Effects) {
    if !fx.replies.is_empty() {
        if let Ok(slot) = session.writer.lock() {
            if let Some(tx) = slot.as_ref() {
                let _ = tx.send(fx.replies);
            }
        }
    }
    for data in fx.clipboard {
        let _ = app.emit(
            "pty://clipboard",
            PtyClipboard {
                id: session.id.clone(),
                data,
            },
        );
    }
    if fx.bell {
        let now = std::time::Instant::now();
        let due = session.last_bell.lock().is_ok_and(|mut last| {
            let due = last.is_none_or(|t| now.duration_since(t) >= BELL_INTERVAL);
            if due {
                *last = Some(now);
            }
            due
        });
        if due {
            let _ = app.emit(
                "pty://bell",
                PtyBell {
                    id: session.id.clone(),
                },
            );
        }
    }
}

/// Read PTY output on a dedicated thread and feed the parser.
///
/// Painting is left to a companion thread. Rate limiting from inside the
/// read loop cannot work: the loop blocks in `read`, so the last chunk of
/// a burst — the one that arrives less than 8ms after the previous emit —
/// would sit unpainted until the program happened to write again. That is
/// a shell whose output stops halfway through and only completes when you
/// press a key.
///
/// The pump BLOCKS on a condvar rather than polling. It used to wake
/// every 8ms for the life of the session, which is 125 wakeups a second
/// per open tab whether or not anything had happened — four idle
/// terminals kept the CPU out of its sleep states all day for nothing.
fn spawn_reader(app: AppHandle, session: Arc<Session>, mut reader: Box<dyn Read + Send>) {
    let closed = session.closed.clone();
    let dirty = session.dirty.clone();

    {
        let app = app.clone();
        let session = session.clone();
        let closed = closed.clone();
        let dirty = dirty.clone();
        std::thread::spawn(move || {
            loop {
                // Sleep until the reader says the parser moved, or the
                // session ends. The timeout is only a safety net.
                let woke = {
                    let Ok(mut flag) = dirty.flag.lock() else { break };
                    while !*flag && !closed.load(Ordering::SeqCst) {
                        let Ok((next, _)) = dirty.cv.wait_timeout(flag, PUMP_IDLE_TIMEOUT) else {
                            return;
                        };
                        flag = next;
                    }
                    std::mem::replace(&mut *flag, false)
                };

                if !woke {
                    // Woken by the close, with nothing pending: the
                    // reader's final flush has already happened.
                    break;
                }

                // Let the rest of the burst land in the parser, then take
                // everything that arrived during the wait in one frame.
                std::thread::sleep(FRAME_INTERVAL);

                /* A program inside a synchronized update (DEC 2026) is
                   redrawing and has asked not to be painted half-way —
                   painting now is the flicker it is trying to avoid.
                   Hold back until it ends the update, or until the sink
                   gives up on it. */
                while !closed.load(Ordering::SeqCst) {
                    let wait = session
                        .parser
                        .lock()
                        .ok()
                        .and_then(|mut p| p.callbacks_mut().sync_remaining());
                    match wait {
                        Some(d) => std::thread::sleep(d.min(SYNC_POLL)),
                        None => break,
                    }
                }

                dirty.take();
                emit_frame(&app, &session, false);
            }
        });
    }

    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];

        loop {
            if closed.load(Ordering::SeqCst) {
                break;
            }
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF — child exited and closed the pty
                Ok(n) => {
                    let effects = session.parser.lock().ok().map(|mut parser| {
                        parser.process(&buf[..n]);
                        let alternate = parser.screen().alternate_screen();
                        let sink = parser.callbacks_mut();
                        if contains_ris(&buf[..n]) {
                            sink.hard_reset();
                        }
                        sink.after_process(alternate);
                        Effects {
                            replies: std::mem::take(&mut sink.replies),
                            clipboard: std::mem::take(&mut sink.clipboard),
                            bell: std::mem::take(&mut sink.bell),
                        }
                    });
                    if let Some(fx) = effects {
                        deliver_effects(&app, &session, fx);
                    }
                    dirty.raise();
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }

        // Flush whatever the last burst produced before announcing exit.
        if dirty.take() {
            emit_frame(&app, &session, false);
        }
        closed.store(true, Ordering::SeqCst);
        // Wake the pump so it sees `closed` and stops, rather than
        // sitting out its timeout.
        dirty.raise();
        close_writer(&session);

        let code = session
            .child
            .lock()
            .ok()
            .and_then(|mut c| c.wait().ok())
            .map(|s| s.exit_code() as i32)
            .unwrap_or(-1);

        /* Drop the session from the manager now that it is over.
           Without this a shell you exited stayed in the table for the
           life of the window, holding its master pty fd, its writer and
           a vt100 parser with 5000 lines of scrollback — a leak that
           grew every time someone typed `exit` and left the tab open,
           and that made `pty_list` report shells that no longer ran. */
        if let Some(manager) = app.try_state::<PtyManager>() {
            if let Ok(mut sessions) = manager.sessions.lock() {
                // Only if it is still the same session: an id is never
                // reused, so this can only remove what just ended.
                if sessions
                    .get(&session.id)
                    .is_some_and(|s| Arc::ptr_eq(s, &session))
                {
                    sessions.remove(&session.id);
                }
            }
        }

        let _ = app.emit(
            "pty://exit",
            PtyExit {
                id: session.id.clone(),
                code,
                message: None,
            },
        );
    });
}

#[tauri::command]
pub fn pty_write(
    manager: tauri::State<'_, PtyManager>,
    id: String,
    data: String,
) -> Result<(), HostError> {
    let session = manager.get(&id)?;
    if session.closed.load(Ordering::SeqCst) {
        return Err(HostError::Internal {
            message: "session has exited".into(),
        });
    }
    if let Ok(mut parser) = session.parser.lock() {
        if parser.screen().scrollback() != 0 {
            parser.screen_mut().set_scrollback(0);
        }
    }
    let slot = session.writer.lock().map_err(poisoned)?;
    let sent = slot
        .as_ref()
        .map(|tx| tx.send(data.into_bytes()).is_ok())
        .unwrap_or(false);
    if !sent {
        return Err(HostError::Internal {
            message: "session has exited".into(),
        });
    }
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    app: AppHandle,
    manager: tauri::State<'_, PtyManager>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), HostError> {
    let session = manager.get(&id)?;
    let rows = rows.max(1);
    let cols = cols.max(1);

    {
        let mut size = session.size.lock().map_err(poisoned)?;
        if *size == (rows, cols) {
            return Ok(());
        }
        *size = (rows, cols);
    }

    session
        .master
        .lock()
        .map_err(poisoned)?
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| HostError::Internal {
            message: format!("resize: {e}"),
        })?;

    session
        .parser
        .lock()
        .map_err(poisoned)?
        .screen_mut()
        .set_size(rows, cols);

    // The grid changed shape — the renderer needs a complete repaint.
    emit_frame(&app, &session, true);
    Ok(())
}

/// Ask for a complete repaint. Used when a terminal view mounts against
/// an already-running session (reopening the panel, popping in/out).
#[tauri::command]
pub fn pty_refresh(
    app: AppHandle,
    manager: tauri::State<'_, PtyManager>,
    id: String,
) -> Result<(), HostError> {
    let session = manager.get(&id)?;
    emit_frame(&app, &session, true);
    Ok(())
}

/// Scroll the visible window back into vt100's scrollback buffer.
/// `delta` is in rows: positive scrolls towards older output.
#[tauri::command]
pub fn pty_scroll(
    app: AppHandle,
    manager: tauri::State<'_, PtyManager>,
    id: String,
    delta: i32,
    absolute: Option<usize>,
) -> Result<usize, HostError> {
    let session = manager.get(&id)?;
    let next = {
        let mut parser = session.parser.lock().map_err(poisoned)?;
        let screen = parser.screen_mut();
        let current = screen.scrollback() as i64;
        let target = match absolute {
            Some(n) => n as i64,
            None => current + delta as i64,
        };
        let clamped = target.max(0) as usize;
        screen.set_scrollback(clamped);
        // set_scrollback clamps internally against the buffer length, so
        // read it back rather than trusting our own arithmetic.
        screen.scrollback()
    };
    // The whole viewport moved — nothing about the previous diff applies.
    if let Ok(mut last) = session.last_rows.lock() {
        for row in last.iter_mut() {
            row.clear();
        }
    }
    emit_frame(&app, &session, true);
    Ok(next)
}

/// One search hit. `line` counts from the oldest line of history, so the
/// viewport offset that shows it is `scrollback_max - line + row`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyMatch {
    pub line: usize,
    pub col: u16,
    /// Width in cells.
    pub len: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySearch {
    pub matches: Vec<PtyMatch>,
    /// History length (the frame's `scrollback_max`) the lines count against.
    pub scrollback_max: usize,
    /// True when more matches existed than were returned.
    pub truncated: bool,
}

/// Most matches one search returns; enough to page through, bounded so a
/// one-letter query over 5000 lines cannot produce a megabyte of IPC.
const SEARCH_MAX: usize = 2000;

/// Each line of history as (cells, column of each cell), oldest first.
///
/// vt100 only exposes the rows under its viewport, so the viewport is
/// walked back through the whole buffer a screen at a time and put back
/// where it was. A wide glyph's continuation cell is skipped, so a match
/// maps back to the column the glyph starts on.
fn history_lines(parser: &mut SessionParser) -> (Vec<Vec<(char, u16)>>, usize) {
    let screen = parser.screen_mut();
    let saved = screen.scrollback();
    screen.set_scrollback(usize::MAX);
    let max = screen.scrollback();
    let (rows, cols) = screen.size();
    let rows_us = rows as usize;
    let mut lines: Vec<Vec<(char, u16)>> = vec![Vec::new(); max + rows_us];

    let mut offset = max;
    loop {
        screen.set_scrollback(offset);
        for y in 0..rows {
            let line = max - offset + y as usize;
            if !lines[line].is_empty() {
                continue;
            }
            let mut cells = Vec::with_capacity(cols as usize);
            for x in 0..cols {
                let Some(cell) = screen.cell(y, x) else { continue };
                if cell.is_wide_continuation() {
                    continue;
                }
                let ch = cell.contents().chars().next().unwrap_or(' ');
                cells.push((ch, x));
            }
            lines[line] = cells;
        }
        if offset == 0 {
            break;
        }
        offset = offset.saturating_sub(rows_us);
    }
    screen.set_scrollback(saved);
    (lines, max)
}

fn fold(c: char, case_sensitive: bool) -> char {
    if case_sensitive {
        c
    } else {
        c.to_lowercase().next().unwrap_or(c)
    }
}

/// Plain-text search over one line's cells.
fn search_line(
    cells: &[(char, u16)],
    needle: &[char],
    case_sensitive: bool,
    line: usize,
    out: &mut Vec<PtyMatch>,
) -> bool {
    if needle.is_empty() || cells.len() < needle.len() {
        return true;
    }
    let mut i = 0;
    while i + needle.len() <= cells.len() {
        let hit = needle
            .iter()
            .enumerate()
            .all(|(k, n)| fold(cells[i + k].0, case_sensitive) == *n);
        if hit {
            if out.len() >= SEARCH_MAX {
                return false;
            }
            let start = cells[i].1;
            let last = cells[i + needle.len() - 1].1;
            // A wide last glyph covers one more column than it starts on.
            let next = cells.get(i + needle.len()).map_or(last + 1, |c| c.1);
            out.push(PtyMatch {
                line,
                col: start,
                len: next.max(last + 1) - start,
            });
            i += needle.len();
        } else {
            i += 1;
        }
    }
    true
}

/// Find `query` in the whole buffer: scrollback and the live screen.
/// Lines are searched one at a time, so a match does not span a wrap.
#[tauri::command]
pub fn pty_search(
    manager: tauri::State<'_, PtyManager>,
    id: String,
    query: String,
    case_sensitive: Option<bool>,
) -> Result<PtySearch, HostError> {
    let session = manager.get(&id)?;
    let case_sensitive = case_sensitive.unwrap_or(false);
    let needle: Vec<char> = query.chars().map(|c| fold(c, case_sensitive)).collect();
    let (lines, max) = {
        let mut parser = session.parser.lock().map_err(poisoned)?;
        history_lines(&mut parser)
    };
    let mut matches = Vec::new();
    let mut truncated = false;
    for (n, cells) in lines.iter().enumerate() {
        if !search_line(cells, &needle, case_sensitive, n, &mut matches) {
            truncated = true;
            break;
        }
    }
    Ok(PtySearch {
        matches,
        scrollback_max: max,
        truncated,
    })
}

#[tauri::command]
pub fn pty_kill(manager: tauri::State<'_, PtyManager>, id: String) -> Result<(), HostError> {
    let session = {
        let mut sessions = manager.sessions.lock().map_err(poisoned)?;
        sessions.remove(&id)
    };
    let Some(session) = session else {
        return Ok(()); // already gone — killing twice is not an error
    };
    session.closed.store(true, Ordering::SeqCst);
    // Wake the frame pump so it retires now instead of waiting out its
    // timeout on a session nobody is looking at any more.
    session.dirty.raise();
    close_writer(&session);
    /* `kill` is SIGHUP, a grace period of up to 200ms, then SIGKILL, and
       `wait` reaps whatever that took. This command runs on the UI
       thread, and every tab close, restart and root toggle came through
       here — each one a visible stall while a shell shut down. The reap
       is not something the caller can act on, so it moves off the UI. */
    std::thread::spawn(move || {
        if let Ok(mut child) = session.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    });
    Ok(())
}

/// Hand a live session to the calling window. The pop-out adopts the
/// panel's shells instead of respawning them, so whatever was running
/// keeps running; from here on it is that window's close that ends them.
#[tauri::command]
pub fn pty_adopt(
    window: tauri::Window,
    manager: tauri::State<'_, PtyManager>,
    id: String,
) -> Result<PtySession, HostError> {
    let session = manager.get(&id)?;
    if session.closed.load(Ordering::SeqCst) {
        return Err(HostError::NotFound {
            path: format!("pty session {id}"),
        });
    }
    *session.owner.lock().map_err(poisoned)? = window.label().to_string();
    let (rows, cols) = *session.size.lock().map_err(poisoned)?;
    Ok(PtySession {
        id: session.id.clone(),
        shell: session.shell.clone(),
        cwd: session.cwd.clone(),
        privilege: session.privilege,
        rows,
        cols,
    })
}

#[tauri::command]
pub fn pty_list(manager: tauri::State<'_, PtyManager>) -> Result<Vec<PtySession>, HostError> {
    let sessions = manager.sessions.lock().map_err(poisoned)?;
    let mut out = Vec::with_capacity(sessions.len());
    for s in sessions.values() {
        let (rows, cols) = *s.size.lock().map_err(poisoned)?;
        out.push(PtySession {
            id: s.id.clone(),
            shell: s.shell.clone(),
            cwd: s.cwd.clone(),
            privilege: s.privilege,
            rows,
            cols,
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// Terminate every live session. Called on app exit so no orphan shells
/// survive the window closing.
pub fn shutdown_all(manager: &PtyManager) {
    let sessions = {
        match manager.sessions.lock() {
            Ok(mut s) => s.drain().map(|(_, v)| v).collect::<Vec<_>>(),
            Err(_) => return,
        }
    };
    end_sessions(sessions);
}

/// Terminate the sessions a window held. A pop-out closed from its title
/// bar destroys the webview without unmounting anything, so nothing on
/// the renderer side gets to call `pty_kill`; its shells used to stay in
/// the table, running, until the app exited.
pub fn shutdown_window(manager: &PtyManager, label: &str) {
    let sessions = {
        let Ok(mut all) = manager.sessions.lock() else { return };
        let owned: Vec<String> = all
            .iter()
            .filter(|(_, s)| s.owner.lock().is_ok_and(|o| *o == label))
            .map(|(id, _)| id.clone())
            .collect();
        owned
            .iter()
            .filter_map(|id| all.remove(id))
            .collect::<Vec<_>>()
    };
    end_sessions(sessions);
}

fn end_sessions(sessions: Vec<Arc<Session>>) {
    for session in sessions {
        session.closed.store(true, Ordering::SeqCst);
        session.dirty.raise();
        close_writer(&session);
        if let Ok(mut child) = session.child.lock() {
            let _ = child.kill();
            // Reap it. A killed child that is never waited on stays a
            // zombie for as long as this process lives, and on a slow
            // shutdown that is long enough to notice in `ps`.
            let _ = child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ansi_palette_covers_all_indices() {
        for i in 0u16..=255 {
            let hex = ansi_hex(i as u8);
            assert_eq!(hex.len(), 7, "index {i} produced {hex}");
            assert!(hex.starts_with('#'));
        }
    }

    #[test]
    fn cube_and_greyscale_endpoints() {
        assert_eq!(ansi_hex(16), "#000000");
        assert_eq!(ansi_hex(231), "#ffffff");
        assert_eq!(ansi_hex(232), "#080808");
    }

    #[test]
    fn default_color_is_none() {
        assert!(color_hex(vt100::Color::Default).is_none());
        assert_eq!(
            color_hex(vt100::Color::Rgb(1, 2, 3)).as_deref(),
            Some("#010203")
        );
    }

    #[test]
    fn search_walks_scrollback_and_screen() {
        let mut parser: SessionParser =
            vt100::Parser::new_with_callbacks(5, 20, 5000, TermSink::default());
        for i in 0..40 {
            parser.process(format!("line{i} Needle\r\n").as_bytes());
        }
        parser.screen_mut().set_scrollback(3);
        let (lines, max) = history_lines(&mut parser);
        assert_eq!(parser.screen().scrollback(), 3, "viewport restored");
        assert_eq!(lines.len(), max + 5);
        let first: String = lines[0].iter().map(|c| c.0).collect();
        assert_eq!(first.trim_end(), "line0 Needle");

        let mut out = Vec::new();
        let needle: Vec<char> = "needle".chars().collect();
        for (n, cells) in lines.iter().enumerate() {
            search_line(cells, &needle, false, n, &mut out);
        }
        assert_eq!(out.len(), 40);
        assert_eq!(out[0], PtyMatch { line: 0, col: 6, len: 6 });

        let mut exact = Vec::new();
        for (n, cells) in lines.iter().enumerate() {
            search_line(cells, &needle, true, n, &mut exact);
        }
        assert!(exact.is_empty(), "case-sensitive miss");
    }

    #[test]
    fn search_maps_wide_glyphs_to_their_columns() {
        let mut parser: SessionParser =
            vt100::Parser::new_with_callbacks(3, 20, 0, TermSink::default());
        parser.process("中文 abc".as_bytes());
        let (lines, _) = history_lines(&mut parser);
        let mut out = Vec::new();
        search_line(&lines[0], &['a', 'b', 'c'], false, 0, &mut out);
        assert_eq!(out, vec![PtyMatch { line: 0, col: 5, len: 3 }]);
        out.clear();
        search_line(&lines[0], &['文'], false, 0, &mut out);
        assert_eq!(out, vec![PtyMatch { line: 0, col: 2, len: 2 }]);
    }

    #[test]
    fn box_drawing_runs_are_capped_and_kept_apart_from_text() {
        let mut parser = vt100::Parser::new(3, 60, 0);
        let line = format!("ab{}cd", "─".repeat(40));
        parser.process(line.as_bytes());
        let (spans, _) = row_spans(parser.screen(), 0, 60);
        let texts: Vec<(u16, usize)> = spans.iter().map(|s| (s.col, s.text.chars().count())).collect();
        assert_eq!(
            texts,
            vec![(0, 2), (2, 16), (18, 16), (34, 8), (42, 2)],
            "{spans:?}"
        );
    }

    #[test]
    fn symbols_get_their_own_span_and_dim_is_not_bold() {
        let mut parser = vt100::Parser::new(3, 30, 0);
        parser.process("\x1b[2mhint\x1b[0m ⏺ done".as_bytes());
        let (spans, _) = row_spans(parser.screen(), 0, 30);
        assert!(spans[0].dim && !spans[0].bold, "{spans:?}");
        let glyph = spans.iter().find(|s| s.text == "⏺").expect("isolated glyph");
        assert_eq!(glyph.col, 5);
        let after = spans.iter().find(|s| s.text.contains("done")).expect("tail");
        assert_eq!(after.col, 6, "text after the glyph starts on its own column");
    }

    #[test]
    fn spans_merge_runs_and_drop_trailing_blanks() {
        let mut parser = vt100::Parser::new(3, 20, 0);
        parser.process(b"hello");
        let screen = parser.screen();
        let (spans, key) = row_spans(screen, 0, 20);
        assert_eq!(spans.len(), 1, "one unstyled run expected: {spans:?}");
        assert_eq!(spans[0].text, "hello");
        assert_eq!(spans[0].col, 0);
        assert!(!key.is_empty());
    }

    /// The whole scrollback path, against the same parser the host runs:
    /// enough output to overflow the screen, then a scroll back, then a
    /// read of what the renderer would paint.
    #[test]
    fn scrollback_moves_the_visible_window() {
        let mut parser = vt100::Parser::new(5, 20, 5000);
        for i in 0..40 {
            parser.process(format!("line{i}\r\n").as_bytes());
        }

        let screen = parser.screen();
        assert_eq!(screen.scrollback(), 0, "starts live");
        let (spans, _) = row_spans(screen, 0, 20);
        assert_eq!(spans[0].text, "line36", "bottom of the buffer: {spans:?}");

        // What build_frame's probe reports as the buffer length.
        let max = {
            let s = parser.screen_mut();
            let cur = s.scrollback();
            s.set_scrollback(usize::MAX);
            let m = s.scrollback();
            s.set_scrollback(cur);
            m
        };
        assert!(max >= 30, "scrollback should have filled up, got {max}");

        // What pty_scroll does with a wheel notch.
        parser.screen_mut().set_scrollback(3);
        assert_eq!(parser.screen().scrollback(), 3);
        let (spans, _) = row_spans(parser.screen(), 0, 20);
        assert_eq!(spans[0].text, "line33", "viewport moved up by 3: {spans:?}");

        // And the jump back to the bottom.
        parser.screen_mut().set_scrollback(0);
        let (spans, _) = row_spans(parser.screen(), 0, 20);
        assert_eq!(spans[0].text, "line36");
    }

    /// The alternate screen keeps no scrollback, which is why a wheel has
    /// to reach the program instead of moving a viewport. Asserting it
    /// here pins the behaviour the renderer's wheel routing depends on.
    #[test]
    fn the_alternate_screen_has_no_scrollback_to_move() {
        let mut parser = vt100::Parser::new(5, 20, 5000);
        for i in 0..40 {
            parser.process(format!("line{i}\r\n").as_bytes());
        }
        assert!(!parser.screen().alternate_screen());

        // DEC 1049: what a full-screen program sends on startup.
        parser.process(b"\x1b[?1049h");
        assert!(parser.screen().alternate_screen());
        for i in 0..40 {
            parser.process(format!("tui{i}\r\n").as_bytes());
        }

        let screen = parser.screen_mut();
        screen.set_scrollback(10);
        assert_eq!(screen.scrollback(), 0, "no history exists to scroll into");

        // Leaving it restores the shell's history untouched.
        parser.process(b"\x1b[?1049l");
        assert!(!parser.screen().alternate_screen());
        parser.screen_mut().set_scrollback(3);
        assert_eq!(parser.screen().scrollback(), 3);
    }

    #[test]
    fn mouse_reporting_reaches_the_frame() {
        let mut parser = vt100::Parser::new(5, 20, 100);
        assert_eq!(MouseMode::from(parser.screen().mouse_protocol_mode()), MouseMode::None);

        // DEC 1002 + 1006: button tracking with SGR encoding.
        parser.process(b"\x1b[?1002h\x1b[?1006h");
        assert_eq!(
            MouseMode::from(parser.screen().mouse_protocol_mode()),
            MouseMode::ButtonMotion
        );
        assert_eq!(
            MouseEncoding::from(parser.screen().mouse_protocol_encoding()),
            MouseEncoding::Sgr
        );
    }

    /// End-to-end: spawn a real shell through the same `build_command`
    /// path the app uses, run a command, and read the result back off the
    /// rendered grid. This is what proves the terminal runs actual
    /// programs rather than the simulated command table it replaced.
    #[test]
    fn spawned_shell_runs_a_real_command() {
        use portable_pty::{NativePtySystem, PtySize, PtySystem};
        use std::io::Read;

        let cwd = std::env::temp_dir().to_string_lossy().to_string();
        let shell = if std::path::Path::new("/bin/sh").exists() {
            "/bin/sh".to_string()
        } else {
            return; // no POSIX shell (Windows CI) — nothing to assert
        };

        let pty = NativePtySystem::default();
        let pair = pty
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let cmd = build_command(&shell, &cwd, PtyPrivilege::User).expect("build_command");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader().expect("reader");
        let mut writer = pair.master.take_writer().expect("writer");

        // A marker the shell prompt cannot accidentally contain.
        writeln!(writer, "echo SPARKPTYOK; exit").expect("write");
        writer.flush().expect("flush");
        // Keep `writer` alive: dropping it closes the master write side and
        // the reader sees immediate EOF before the shell has produced
        // anything.

        let mut parser = vt100::Parser::new(24, 80, 0);
        let mut buf = [0u8; 4096];
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut saw_marker = false;

        while std::time::Instant::now() < deadline {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    parser.process(&buf[..n]);
                    // Read the marker off the RENDERED grid, not the raw
                    // byte stream, so this also covers span building.
                    let screen = parser.screen();
                    let (rows, cols) = screen.size();
                    for y in 0..rows {
                        let (spans, _) = row_spans(screen, y, cols);
                        let line: String = spans.iter().map(|s| s.text.as_str()).collect();
                        // The echoed command line also contains the marker,
                        // but it continues with "; exit". The output line
                        // ends at the marker (a shell prompt may precede it
                        // on the same rendered row).
                        if line.trim_end().ends_with("SPARKPTYOK") {
                            saw_marker = true;
                        }
                    }
                    if saw_marker {
                        break;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }

        let _ = child.kill();
        let _ = child.wait();
        drop(writer);
        assert!(
            saw_marker,
            "shell output never reached the rendered grid; screen was:\n{}",
            parser.screen().contents()
        );
    }

    #[test]
    fn root_command_is_wrapped_in_a_privilege_helper() {
        // The elevated shell must go through pkexec/sudo — never through
        // sparkBook collecting a password itself.
        if is_root() || root_method() == "none" {
            return;
        }
        let cmd = build_command("/bin/sh", "/tmp", PtyPrivilege::Root).expect("build");
        let program = cmd.get_argv()[0].to_string_lossy().to_string();
        assert!(
            program.ends_with("pkexec") || program.ends_with("sudo"),
            "root sessions must be wrapped by a privilege helper, got {program}"
        );
    }

    #[test]
    fn user_command_runs_the_shell_directly() {
        let cmd = build_command("/bin/sh", "/tmp", PtyPrivilege::User).expect("build");
        let program = cmd.get_argv()[0].to_string_lossy().to_string();
        assert!(program.ends_with("sh"), "got {program}");
    }

    /// The writer thread is what keeps a blocked pty off the UI thread;
    /// what it must not cost is ordering, or keystrokes would arrive
    /// scrambled. It also has to let go of the writer when the session
    /// ends, or the master's write side stays open for the app's life.
    #[test]
    fn writer_thread_keeps_arrival_order_and_retires_when_closed() {
        struct Sink {
            bytes: Arc<Mutex<Vec<u8>>>,
            dropped: Arc<AtomicBool>,
        }
        impl Write for Sink {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.bytes.lock().unwrap().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        impl Drop for Sink {
            fn drop(&mut self) {
                self.dropped.store(true, Ordering::SeqCst);
            }
        }

        let bytes = Arc::new(Mutex::new(Vec::new()));
        let dropped = Arc::new(AtomicBool::new(false));
        let tx = spawn_writer(Box::new(Sink {
            bytes: bytes.clone(),
            dropped: dropped.clone(),
        }));

        let mut expected = String::new();
        for i in 0..2000 {
            let chunk = format!("{i},");
            expected.push_str(&chunk);
            tx.send(chunk.into_bytes()).expect("writer alive");
        }
        drop(tx);

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !dropped.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(dropped.load(Ordering::SeqCst), "writer thread never retired");
        assert_eq!(String::from_utf8(bytes.lock().unwrap().clone()).unwrap(), expected);
    }

    #[test]
    fn blank_row_yields_no_spans() {
        let parser = vt100::Parser::new(3, 20, 0);
        let (spans, _) = row_spans(parser.screen(), 1, 20);
        assert!(spans.is_empty());
    }
}
