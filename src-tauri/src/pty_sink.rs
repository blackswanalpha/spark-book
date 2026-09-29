/* ============================================================
   sparkBook · src-tauri/src/pty_sink.rs

   The half of terminal emulation `vt100` leaves to its host.

   vt100 keeps the screen, but a terminal is also expected to ANSWER.
   Programs ask what they are talking to (DA1, DA2, XTVERSION), where
   the cursor is (DSR 6), what colours the background is (OSC 11) and
   which keyboard protocol is available (kitty `CSI ? u`), and many of
   them wait for the reply: fish 4 stalls for seconds on an unanswered
   DA1, crossterm's cursor query times out, prompt_toolkit warns about
   CPR, and Claude Code only turns on Shift+Enter after a kitty reply.

   Everything here is driven from `vt100::Callbacks`, which runs inside
   `Parser::process` with the screen in the state it had at that byte,
   so a cursor report is exact even when output follows the query in
   the same read. Replies are queued and the reader thread writes them
   back to the pty once `process` returns.
   ============================================================ */

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Kitty keyboard enhancement flags this terminal implements. Only
/// "disambiguate escape codes" (0b1): it is what separates Shift+Enter
/// from Enter and Esc from the start of a sequence. Flags we do not
/// implement are masked off, so a `CSI ? u` query never claims them.
pub const KITTY_SUPPORTED: u8 = 0b1;

/// The kitty spec bounds each stack; a program that pushes forever must
/// not grow memory forever.
const KITTY_STACK_MAX: usize = 16;

/// How long a synchronized update (DEC 2026) may hold painting back.
/// A program that begins one and dies must not freeze the screen.
pub const SYNC_TIMEOUT: Duration = Duration::from_millis(200);

/// Largest OSC 52 payload accepted, in base64 bytes.
const CLIPBOARD_MAX: usize = 1 << 20;

/// Colours reported to OSC 10/11/12 queries. The renderer owns the theme,
/// so it pushes the current one here (`pty_set_palette`); the defaults are
/// the dark theme's terminal tokens.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Palette {
    pub fg: (u8, u8, u8),
    pub bg: (u8, u8, u8),
    pub cursor: (u8, u8, u8),
}

pub static PALETTE: Mutex<Palette> = Mutex::new(Palette {
    fg: (0xe6, 0xe9, 0xee),
    bg: (0x17, 0x1b, 0x21),
    cursor: (0xe6, 0xe9, 0xee),
});

fn palette() -> Palette {
    *PALETTE.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[derive(Default)]
pub struct TermSink {
    /// Latest OSC 0/2 window title.
    pub title: Option<String>,
    /// Bytes to write back to the pty once `process` returns.
    pub replies: Vec<u8>,
    /// Kitty keyboard flag stacks. The spec keeps one per screen, which
    /// is also what makes a TUI that crashes on the alternate screen
    /// harmless: its flags go when the alternate screen does.
    kitty_main: Vec<u8>,
    kitty_alt: Vec<u8>,
    /// Set while a synchronized update (DEC 2026) is open.
    pub sync_since: Option<Instant>,
    /// DEC 1004: the program wants `CSI I` / `CSI O` on focus changes.
    pub focus_reporting: bool,
    /// OSC 52 writes waiting to reach the system clipboard, as base64.
    pub clipboard: Vec<String>,
    /// A BEL (or a notification OSC) arrived since the last drain.
    pub bell: bool,
    /// Whether the alternate screen was up after the last `process`.
    was_alternate: bool,
}

impl TermSink {
    /// Kitty flags in force on the current screen.
    pub fn kitty_flags(&self, alternate: bool) -> u8 {
        let stack = if alternate { &self.kitty_alt } else { &self.kitty_main };
        stack.last().copied().unwrap_or(0)
    }

    /// Called after every `process`, and before every kitty operation:
    /// switching screens discards the alternate stack, so flags a
    /// full-screen program left behind never leak into the next one.
    /// Observing before an operation is what keeps a push made in the
    /// same read as the switch from being wiped by it.
    pub fn after_process(&mut self, alternate: bool) {
        if alternate != self.was_alternate {
            self.kitty_alt.clear();
            self.was_alternate = alternate;
        }
    }

    /// Forget every mode this sink tracks. vt100 handles RIS (`ESC c`)
    /// itself without a callback, so the reader calls this when it sees
    /// one: `reset` is how a user recovers from a program that crashed
    /// with the kitty keyboard flags pushed, where Ctrl+C no longer
    /// reaches the shell as SIGINT.
    pub fn hard_reset(&mut self) {
        self.kitty_main.clear();
        self.kitty_alt.clear();
        self.sync_since = None;
        self.focus_reporting = false;
    }

    /// Whether painting should wait for an open synchronized update, and
    /// for how long at most. An update past its deadline is closed here.
    pub fn sync_remaining(&mut self) -> Option<Duration> {
        let since = self.sync_since?;
        let elapsed = since.elapsed();
        if elapsed >= SYNC_TIMEOUT {
            self.sync_since = None;
            return None;
        }
        Some(SYNC_TIMEOUT - elapsed)
    }

    fn reply(&mut self, s: &str) {
        self.replies.extend_from_slice(s.as_bytes());
    }

    fn kitty_stack(&mut self, alternate: bool) -> &mut Vec<u8> {
        self.after_process(alternate);
        if alternate {
            &mut self.kitty_alt
        } else {
            &mut self.kitty_main
        }
    }

    fn mode_state(&self, screen: &vt100::Screen, mode: u16) -> u8 {
        // DECRPM: 1 = set, 2 = reset, 0 = not recognised.
        let on = |b: bool| if b { 1 } else { 2 };
        match mode {
            1 => on(screen.application_cursor()),
            25 => on(!screen.hide_cursor()),
            47 | 1047 | 1049 => on(screen.alternate_screen()),
            9 | 1000 | 1002 | 1003 => {
                let want = match mode {
                    9 => vt100::MouseProtocolMode::Press,
                    1000 => vt100::MouseProtocolMode::PressRelease,
                    1002 => vt100::MouseProtocolMode::ButtonMotion,
                    _ => vt100::MouseProtocolMode::AnyMotion,
                };
                on(screen.mouse_protocol_mode() == want)
            }
            1006 => on(screen.mouse_protocol_encoding() == vt100::MouseProtocolEncoding::Sgr),
            1004 => on(self.focus_reporting),
            2004 => on(screen.bracketed_paste()),
            2026 => on(self.sync_since.is_some()),
            _ => 0,
        }
    }
}

/// Whether a chunk of output holds RIS (`ESC c`). A sequence split across
/// two reads is missed, which only means that `reset` is not noticed —
/// the screen itself is still reset by vt100.
pub fn contains_ris(bytes: &[u8]) -> bool {
    bytes.windows(2).any(|w| w == b"\x1bc")
}

fn first(params: &[&[u16]], default: u16) -> u16 {
    params
        .first()
        .and_then(|p| p.first().copied())
        .filter(|&v| v != 0)
        .unwrap_or(default)
}

fn rgb_reply(code: &str, (r, g, b): (u8, u8, u8)) -> String {
    // X11 colour spec with 16-bit channels, the form xterm answers in.
    format!("\x1b]{code};rgb:{r:02x}{r:02x}/{g:02x}{g:02x}/{b:02x}{b:02x}\x1b\\")
}

fn is_dark((r, g, b): (u8, u8, u8)) -> bool {
    // Rec. 709 luma; below half is a dark background.
    0.2126 * f32::from(r) + 0.7152 * f32::from(g) + 0.0722 * f32::from(b) < 128.0
}

impl vt100::Callbacks for TermSink {
    fn set_window_title(&mut self, _: &mut vt100::Screen, title: &[u8]) {
        let text = String::from_utf8_lossy(title).to_string();
        self.title = if text.is_empty() { None } else { Some(text) };
    }

    fn audible_bell(&mut self, _: &mut vt100::Screen) {
        self.bell = true;
    }

    fn copy_to_clipboard(&mut self, _: &mut vt100::Screen, _ty: &[u8], data: &[u8]) {
        // Write-only by design: OSC 52 *reads* would let any program
        // that reaches the tty (a `cat` of a hostile file) take whatever
        // is on the clipboard, so `paste_from_clipboard` stays unanswered.
        if data.is_empty() || data.len() > CLIPBOARD_MAX {
            return;
        }
        self.clipboard.push(String::from_utf8_lossy(data).to_string());
    }

    fn unhandled_csi(
        &mut self,
        screen: &mut vt100::Screen,
        i1: Option<u8>,
        i2: Option<u8>,
        params: &[&[u16]],
        c: char,
    ) {
        match (i1, i2, c) {
            // DA1 — "what are you". VT220 with ANSI colour.
            (None, None, 'c') if first(params, 0) == 0 => self.reply("\x1b[?62;22c"),
            // DA2 — terminal type and version.
            (Some(b'>'), None, 'c') if first(params, 0) == 0 => self.reply("\x1b[>0;10;1c"),
            // DSR — status, and the cursor position report.
            (None, None, 'n') => match first(params, 0) {
                5 => self.reply("\x1b[0n"),
                6 => {
                    let (row, col) = screen.cursor_position();
                    self.reply(&format!("\x1b[{};{}R", row + 1, col + 1));
                }
                _ => {}
            },
            (Some(b'?'), None, 'n') => match first(params, 0) {
                6 => {
                    let (row, col) = screen.cursor_position();
                    self.reply(&format!("\x1b[?{};{}R", row + 1, col + 1));
                }
                // Colour-scheme query (contour/ghostty/kitty): 1 dark, 2 light.
                996 => {
                    let mode = if is_dark(palette().bg) { 1 } else { 2 };
                    self.reply(&format!("\x1b[?997;{mode}n"));
                }
                _ => {}
            },
            // XTVERSION.
            (Some(b'>'), None, 'q') => self.reply(&format!(
                "\x1bP>|sparkBook({})\x1b\\",
                env!("CARGO_PKG_VERSION")
            )),
            // XTWINOPS 18 — text area size in characters.
            (None, None, 't') if first(params, 0) == 18 => {
                let (rows, cols) = screen.size();
                self.reply(&format!("\x1b[8;{rows};{cols}t"));
            }
            // DECRQM for private modes, and for ANSI modes (none known).
            (Some(b'?'), Some(b'$'), 'p') => {
                let mode = first(params, 0);
                let state = self.mode_state(screen, mode);
                self.reply(&format!("\x1b[?{mode};{state}$y"));
            }
            (Some(b'$'), None, 'p') => {
                let mode = first(params, 0);
                self.reply(&format!("\x1b[{mode};0$y"));
            }
            // Private modes vt100 does not implement. One sequence may set
            // several, and vt100 calls here once per unknown one with the
            // whole list, so applying every known mode is idempotent.
            (Some(b'?'), None, 'h' | 'l') => {
                let set = c == 'h';
                for p in params {
                    match p.first().copied() {
                        Some(2026) => {
                            self.sync_since = if set { Some(Instant::now()) } else { None };
                        }
                        Some(1004) => self.focus_reporting = set,
                        _ => {}
                    }
                }
            }
            // Kitty keyboard protocol.
            (Some(b'?'), None, 'u') => {
                let flags = self.kitty_flags(screen.alternate_screen());
                self.reply(&format!("\x1b[?{flags}u"));
            }
            (Some(b'>'), None, 'u') => {
                let flags = params
                    .first()
                    .and_then(|p| p.first().copied())
                    .unwrap_or(0) as u8
                    & KITTY_SUPPORTED;
                let stack = self.kitty_stack(screen.alternate_screen());
                if stack.len() >= KITTY_STACK_MAX {
                    stack.remove(0);
                }
                stack.push(flags);
            }
            (Some(b'<'), None, 'u') => {
                let n = first(params, 1) as usize;
                let stack = self.kitty_stack(screen.alternate_screen());
                let keep = stack.len().saturating_sub(n);
                stack.truncate(keep);
            }
            (Some(b'='), None, 'u') => {
                let flags = params
                    .first()
                    .and_then(|p| p.first().copied())
                    .unwrap_or(0) as u8
                    & KITTY_SUPPORTED;
                let mode = params.get(1).and_then(|p| p.first().copied()).unwrap_or(1);
                let stack = self.kitty_stack(screen.alternate_screen());
                if stack.is_empty() {
                    stack.push(0);
                }
                if let Some(top) = stack.last_mut() {
                    *top = match mode {
                        2 => *top | flags,
                        3 => *top & !flags,
                        _ => flags,
                    };
                }
            }
            _ => {}
        }
    }

    fn unhandled_osc(&mut self, _: &mut vt100::Screen, params: &[&[u8]]) {
        match params {
            // Default foreground / background / cursor colour queries.
            [b"10", b"?"] => self.reply(&rgb_reply("10", palette().fg)),
            [b"11", b"?"] => self.reply(&rgb_reply("11", palette().bg)),
            [b"12", b"?"] => self.reply(&rgb_reply("12", palette().cursor)),
            // Palette entry query: OSC 4 ; n ; ?
            [b"4", idx, b"?"] => {
                if let Some(i) = std::str::from_utf8(idx).ok().and_then(|s| s.parse::<u8>().ok()) {
                    let (r, g, b) = crate::pty::ansi_rgb(i);
                    self.reply(&format!(
                        "\x1b]4;{i};rgb:{r:02x}{r:02x}/{g:02x}{g:02x}/{b:02x}{b:02x}\x1b\\"
                    ));
                }
            }
            // Desktop notifications: iTerm2's OSC 9 (but not ConEmu's
            // `9;4` progress reports) and rxvt's OSC 777 notify. Surfaced
            // the same way as a bell — the tab asks for attention.
            [b"9", rest @ ..] if rest.first().is_some_and(|r| *r != b"4".as_slice()) => {
                self.bell = true;
            }
            [b"777", b"notify", ..] => self.bell = true,
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parser() -> vt100::Parser<TermSink> {
        vt100::Parser::new_with_callbacks(24, 80, 100, TermSink::default())
    }

    fn replies(p: &mut vt100::Parser<TermSink>) -> String {
        String::from_utf8(std::mem::take(&mut p.callbacks_mut().replies)).unwrap()
    }

    #[test]
    fn answers_device_attributes() {
        let mut p = parser();
        p.process(b"\x1b[c");
        assert_eq!(replies(&mut p), "\x1b[?62;22c");
        p.process(b"\x1b[>c");
        assert_eq!(replies(&mut p), "\x1b[>0;10;1c");
        p.process(b"\x1b[>0q");
        assert!(replies(&mut p).starts_with("\x1bP>|sparkBook("));
    }

    #[test]
    fn cursor_report_reflects_the_screen_at_the_query() {
        let mut p = parser();
        // Output after the query must not move the reported position.
        p.process(b"\x1b[5;10H\x1b[6nmore text");
        assert_eq!(replies(&mut p), "\x1b[5;10R");
        p.process(b"\x1b[5n");
        assert_eq!(replies(&mut p), "\x1b[0n");
    }

    #[test]
    fn kitty_keyboard_push_query_pop() {
        let mut p = parser();
        p.process(b"\x1b[?u");
        assert_eq!(replies(&mut p), "\x1b[?0u");
        // Claude Code pushes 5 (disambiguate + alternate keys); only the
        // implemented bit is kept.
        p.process(b"\x1b[>5u\x1b[?u");
        assert_eq!(replies(&mut p), "\x1b[?1u");
        assert_eq!(p.callbacks().kitty_flags(false), 1);
        p.process(b"\x1b[<u");
        assert_eq!(p.callbacks().kitty_flags(false), 0);
        p.process(b"\x1b[=1;1u");
        assert_eq!(p.callbacks().kitty_flags(false), 1);
        p.process(b"\x1b[=1;3u");
        assert_eq!(p.callbacks().kitty_flags(false), 0);
    }

    #[test]
    fn kitty_flags_left_on_the_alternate_screen_do_not_leak() {
        let mut p = parser();
        p.process(b"\x1b[?1049h\x1b[>1u");
        let alt = p.screen().alternate_screen();
        p.callbacks_mut().after_process(alt);
        assert_eq!(p.callbacks().kitty_flags(true), 1);
        assert_eq!(p.callbacks().kitty_flags(false), 0, "main stack untouched");
        // The program exits without popping.
        p.process(b"\x1b[?1049l");
        let alt = p.screen().alternate_screen();
        p.callbacks_mut().after_process(alt);
        assert_eq!(p.callbacks().kitty_flags(false), 0);
        assert_eq!(p.callbacks().kitty_flags(true), 0);
    }

    #[test]
    fn contains_ris_finds_reset_only() {
        assert!(contains_ris(b"abc\x1bcdef"));
        assert!(!contains_ris(b"\x1b[c"));
        assert!(!contains_ris(b"plain"));
    }

    #[test]
    fn synchronized_output_and_focus_modes() {
        let mut p = parser();
        p.process(b"\x1b[?2026h");
        assert!(p.callbacks().sync_since.is_some());
        p.process(b"\x1b[?2026$p");
        assert_eq!(replies(&mut p), "\x1b[?2026;1$y");
        p.process(b"\x1b[?2026l\x1b[?2026$p");
        assert!(p.callbacks().sync_since.is_none());
        assert_eq!(replies(&mut p), "\x1b[?2026;2$y");
        // Mixed with a mode vt100 handles itself.
        p.process(b"\x1b[?2004;1004h");
        assert!(p.callbacks().focus_reporting);
        assert!(p.screen().bracketed_paste());
        p.process(b"\x1b[?9999$p");
        assert_eq!(replies(&mut p), "\x1b[?9999;0$y");
    }

    #[test]
    fn colour_queries_and_clipboard() {
        let mut p = parser();
        p.process(b"\x1b]11;?\x07");
        let r = replies(&mut p);
        assert!(r.starts_with("\x1b]11;rgb:"), "{r:?}");
        p.process(b"\x1b]52;c;aGVsbG8=\x07");
        assert_eq!(p.callbacks().clipboard, vec!["aGVsbG8=".to_string()]);
        // Reads are refused: nothing is answered.
        p.process(b"\x1b]52;c;?\x07");
        assert_eq!(replies(&mut p), "");
    }

    #[test]
    fn bell_and_notifications_raise_attention() {
        let mut p = parser();
        p.process(b"\x07");
        assert!(std::mem::take(&mut p.callbacks_mut().bell));
        p.process(b"\x1b]9;Claude needs your input\x07");
        assert!(std::mem::take(&mut p.callbacks_mut().bell));
        p.process(b"\x1b]9;4;1;50\x07");
        assert!(!p.callbacks().bell, "progress reports are not a bell");
    }

    #[test]
    fn title_is_tracked() {
        let mut p = parser();
        p.process(b"\x1b]2;vim notes.md\x07");
        assert_eq!(p.callbacks().title.as_deref(), Some("vim notes.md"));
    }
}
